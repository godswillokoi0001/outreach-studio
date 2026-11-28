import { NextRequest, NextResponse } from "next/server";
import { extractWorkspaceToken, handleApiError } from "@/lib/api-helpers";
import { fromB64url } from "@/lib/crypto";
import {
  checkSendingTierDeliverability,
  evaluateLeadSendEligibility,
  isSelfSendEmail,
  resolveUserSendingTier,
} from "@/lib/guardrails";
import { verifyRequest } from "@/lib/server-auth";
import { buildOpenPixelUrl, buildRawEmail, encodeBase64Url, type RawEmailInput } from "@/lib/outreach-utils";
import { getSupabaseSettingsServer, supabaseServer } from "@/lib/supabase-server";
import { applyEmailFooter } from "@/lib/email-format";
import type { Campaign, Lead } from "@/lib/types";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

interface GmailMessagePayload {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  payload?: {
    mimeType?: string;
    headers?: { name: string; value: string }[];
    body?: { data?: string };
    parts?: GmailPart[];
  };
}

function isInsufficientScopeError(errMsg: string): boolean {
  return /insufficient authentication scopes/i.test(errMsg);
}

async function gmailFetch<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const rawErrMsg =
      json && typeof json === "object" && "error" in json
        ? String((json as { error?: { message?: string } }).error?.message ?? `Gmail API error (${res.status})`)
        : `Gmail request failed (${res.status}).`;

    // The app cannot force Google to re-grant scopes to an existing refresh
    // token, so the only recovery path for a scope-short token is to drop the
    // in-memory workspace token for this session and ask the user to
    // reconnect. The reconnect route (/api/google/connect -> /api/google/
    // callback -> exchangeCode) already requests `gmail.send`, so a fresh
    // consent round will give a correctly-scoped token.
    if (res.status === 403 && isInsufficientScopeError(rawErrMsg)) {
      const { clearWorkspaceToken } = await import("@/lib/workspace-token");
      try {
        clearWorkspaceToken();
      } catch {
        /* best-effort: the token cache is in-process only */
      }
      throw new Error(
        "Gmail cannot send because this Google connection was granted without send permission. Reconnect Gmail and Sheets from Settings → Integrations to re-grant the send scope.",
      );
    }

    throw new Error(rawErrMsg);
  }
  return json as T;
}

function decodeGmailBody(payload?: GmailPart): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return new TextDecoder().decode(fromB64url(payload.body.data));
  }
  for (const part of payload.parts ?? []) {
    const plain = decodeGmailBody(part);
    if (plain) return plain;
  }
  if (payload.body?.data) {
    return new TextDecoder()
      .decode(fromB64url(payload.body.data))
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

function decodeMessage(msg: GmailMessagePayload) {
  const headers: Record<string, string> = {};
  for (const h of msg.payload?.headers ?? []) {
    headers[h.name.toLowerCase()] = h.value;
  }
  return {
    id: msg.id,
    threadId: msg.threadId,
    snippet: msg.snippet ?? "",
    internalDate: msg.internalDate ?? String(Date.now()),
    headers,
    body: decodeGmailBody(msg.payload),
  };
}

export async function POST(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const token = extractWorkspaceToken(req);
    const body = (await req.json()) as {
      action: "profile" | "send" | "list" | "get" | "findSentByRfc";
      email?: RawEmailInput & {
        threadId?: string | null;
        tracking?: { messageId?: string; leadId?: string | null; enabled?: boolean };
      };
      q?: string;
      maxResults?: number;
      id?: string;
      rfcMessageId?: string;
    };

    if (body.action === "profile") {
      const profile = await gmailFetch<{ emailAddress: string; messagesTotal?: number }>(token, "/profile");
      return NextResponse.json(profile);
    }

    if (body.action === "send") {
      if (!body.email) {
        return NextResponse.json({ error: "Email payload is required." }, { status: 400 });
      }
      const tracking = body.email.tracking;

      // 1. Self-Send Guard: prevent sending from X -> X
      let resolvedFrom = String(body.email.from ?? "").trim();
      if (!resolvedFrom) {
        try {
          const profile = await gmailFetch<{ emailAddress: string }>(token, "/profile");
          resolvedFrom = profile.emailAddress;
        } catch {
          /* ignore */
        }
      }
      if (isSelfSendEmail(resolvedFrom, body.email.to)) {
        return NextResponse.json(
          {
            error: `Self-send blocked: sender (${resolvedFrom}) and recipient (${body.email.to}) are identical. Test deliverability using a separate external inbox.`,
          },
          { status: 400 },
        );
      }

      // 2. Hard Qualification, Kill-Switch & Suppression Firewall when linked to a campaign/lead
      let isColdTouch = true;
      if (supabaseServer && (tracking?.leadId || tracking?.messageId)) {
        let leadRow: Partial<Lead> | null = null;
        let campRow: Partial<Campaign> | null = null;
        let msgKind = "initial";

        if (tracking.messageId) {
          const { data: msgData } = await supabaseServer
            .from("messages")
            .select("lead_id, campaign_id, kind")
            .eq("owner_id", user.ownerId)
            .eq("id", tracking.messageId)
            .maybeSingle();
          const msgObj = msgData as { lead_id?: string; campaign_id?: string; kind?: string } | null;
          if (msgObj?.kind) msgKind = msgObj.kind;
          const targetLeadId = tracking.leadId ?? msgObj?.lead_id;
          if (targetLeadId) {
            const { data: lData } = await supabaseServer
              .from("leads")
              .select("*")
              .eq("owner_id", user.ownerId)
              .eq("id", targetLeadId)
              .maybeSingle();
            leadRow = (lData as Partial<Lead> | null) ?? null;
          }
          const campId = msgObj?.campaign_id ?? leadRow?.campaign_id;
          if (campId) {
            const { data: cData } = await supabaseServer
              .from("campaigns")
              .select("id, config, status")
              .eq("owner_id", user.ownerId)
              .eq("id", campId)
              .maybeSingle();
            campRow = (cData as Partial<Campaign> | null) ?? null;
          }
        } else if (tracking.leadId) {
          const { data: lData } = await supabaseServer
            .from("leads")
            .select("*")
            .eq("owner_id", user.ownerId)
            .eq("id", tracking.leadId)
            .maybeSingle();
          leadRow = (lData as Partial<Lead> | null) ?? null;
        }

        isColdTouch = msgKind !== "reply";
        const { data: supRows } = await supabaseServer
          .from("suppressions")
          .select("email")
          .eq("owner_id", user.ownerId);
        const supList = ((supRows ?? []) as { email: string }[]).map((r) => r.email);

        if (leadRow && isColdTouch) {
          const gate = evaluateLeadSendEligibility({
            lead: leadRow,
            campaign: campRow,
            senderEmail: resolvedFrom,
            suppressedEmails: supList,
          });
          if (!gate.eligible) {
            return NextResponse.json(
              { error: gate.reason || "Prospect failed qualification or deliverability gate.", code: gate.code },
              { status: 400 },
            );
          }
        }
      }

      // 3. Sending-Tier Deliverability Enforcement
      const sendingTier = resolveUserSendingTier(resolvedFrom);
      const delivCheck = checkSendingTierDeliverability({
        tier: sendingTier,
        subject: body.email.subject,
        body: body.email.body,
        isColdTouch1: isColdTouch,
      });

      const enforcePlainText =
        Boolean(body.email.plainTextOnly) || (delivCheck.preferPlainText && isColdTouch);

      // The pixel has to point at a public origin. A leftover localhost value
      // in NEXT_PUBLIC_APP_URL (common when copying .env.example) would embed
      // an unreachable URL in every email and no open would ever be recorded.
      const configuredOrigin = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
      const usableOrigin = /^https?:\/\//i.test(configuredOrigin) && !/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(configuredOrigin);
      const publicOrigin = (usableOrigin ? configuredOrigin : req.nextUrl.origin).replace(/\/$/, "");
      const pixelUrl =
        !enforcePlainText && tracking?.enabled !== false && tracking?.messageId
          ? buildOpenPixelUrl(publicOrigin, {
              ownerId: user.ownerId,
              messageId: tracking.messageId,
              leadId: tracking.leadId ?? null,
            })
          : null;
      // 4. Account footer: the one footer saved in Settings is appended here, on
      // the server, so every email that leaves the app carries it — initial,
      // follow-up and reply alike — no matter which page triggered the send.
      let accountFooter = "";
      try {
        accountFooter = (await getSupabaseSettingsServer(user.ownerId))?.email_footer ?? "";
      } catch {
        accountFooter = "";
      }

      const raw = buildRawEmail({
        ...body.email,
        body: applyEmailFooter(body.email.body, accountFooter),
        openPixelUrl: pixelUrl,
        plainTextOnly: enforcePlainText,
      });
      const sent = await gmailFetch<{ id: string; threadId: string }>(token, "/messages/send", {
        method: "POST",
        body: JSON.stringify({
          raw: encodeBase64Url(raw),
          ...(body.email.threadId ? { threadId: body.email.threadId } : {}),
        }),
      });
      return NextResponse.json({
        ...sent,
        sendingTier,
        plainTextOnly: enforcePlainText,
        deliverabilityWarnings: delivCheck.warnings,
      });
    }

    if (body.action === "findSentByRfc") {
      const rfc = body.rfcMessageId?.replace(/[<>]/g, "").trim();
      if (!rfc) return NextResponse.json({ found: null });
      const res = await gmailFetch<{ messages?: { id: string; threadId: string }[] }>(
        token,
        `/messages?q=${encodeURIComponent(`rfc822msgid:${rfc}`)}&maxResults=1`,
      );
      const hit = res.messages?.[0] ?? null;
      return NextResponse.json({ found: hit });
    }

    if (body.action === "list") {
      const q = body.q ?? "in:inbox newer_than:21d";
      const maxResults = Math.max(1, Math.min(40, Number(body.maxResults) || 20));
      const res = await gmailFetch<{ messages?: { id: string; threadId: string }[] }>(
        token,
        `/messages?q=${encodeURIComponent(q)}&maxResults=${maxResults}`,
      );
      return NextResponse.json({ messages: res.messages ?? [] });
    }

    if (body.action === "get") {
      if (!body.id) {
        return NextResponse.json({ error: "Message id is required." }, { status: 400 });
      }
      const msg = await gmailFetch<GmailMessagePayload>(
        token,
        `/messages/${encodeURIComponent(body.id)}?format=full`,
      );
      return NextResponse.json(decodeMessage(msg));
    }

    return NextResponse.json({ error: "Unknown gmail action." }, { status: 400 });
  } catch (err) {
    return handleApiError(err);
  }
}
