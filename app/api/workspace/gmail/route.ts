import { NextRequest, NextResponse } from "next/server";
import { extractWorkspaceToken, handleApiError } from "@/lib/api-helpers";
import { fromB64url } from "@/lib/crypto";
import { verifyFirebaseRequest } from "@/lib/firebase-server-auth";
import { buildOpenPixelUrl, buildRawEmail, encodeBase64Url, type RawEmailInput } from "@/lib/outreach-utils";

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
    const errMsg =
      json && typeof json === "object" && "error" in json
        ? String((json as { error?: { message?: string } }).error?.message ?? `Gmail API error (${res.status})`)
        : `Gmail request failed (${res.status}).`;
    throw new Error(errMsg);
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
    const user = await verifyFirebaseRequest(req);
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
      const publicOrigin = (process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin).replace(/\/$/, "");
      const pixelUrl =
        tracking?.enabled !== false && tracking?.messageId
          ? buildOpenPixelUrl(publicOrigin, {
              ownerId: user.uid,
              messageId: tracking.messageId,
              leadId: tracking.leadId ?? null,
            })
          : null;
      const raw = buildRawEmail({ ...body.email, openPixelUrl: pixelUrl });
      const sent = await gmailFetch<{ id: string; threadId: string }>(token, "/messages/send", {
        method: "POST",
        body: JSON.stringify({
          raw: encodeBase64Url(raw),
          ...(body.email.threadId ? { threadId: body.email.threadId } : {}),
        }),
      });
      return NextResponse.json(sent);
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
