import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";
import { clientIpFromHeaders, decideOpen, hashSenderIp } from "@/lib/tracking-guard";

/**
 * 1x1 open-tracking pixel.
 *
 * Sent inside the HTML part of every outreach email. Mail clients that load
 * remote images hit this route, which appends an immutable open event to the
 * `email_opens` table with the service role (the pixel is public and has no
 * session, so only this constrained insert is allowed).
 *
 * The pixel always returns cleanly. It records nothing when the hit is the
 * sender's own authenticated browser, a prefetch/scanner, a same-IP render or
 * an immediate post-send mailbox render.
 */

const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==",
  "base64",
);

const NO_CACHE = {
  "Content-Type": "image/gif",
  "Content-Length": String(PIXEL.length),
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0, private",
  Pragma: "no-cache",
  Expires: "0",
};

function safeId(value: string | null): string | null {
  if (!value) return null;
  return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

function eventId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `opn_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function messageTiming(
  ownerId: string,
  messageId: string,
): Promise<{ sentAt: string | null; senderIpHash: string | null }> {
  if (!supabaseServer) return { sentAt: null, senderIpHash: null };
  try {
    const { data } = await supabaseServer
      .from("messages")
      .select("*")
      .eq("owner_id", ownerId)
      .eq("id", messageId)
      .maybeSingle();
    const row = data as { sent_at?: string | null; sender_ip_hash?: string | null } | null;
    return { sentAt: row?.sent_at ?? null, senderIpHash: row?.sender_ip_hash ?? null };
  } catch {
    return { sentAt: null, senderIpHash: null };
  }
}

async function recordOpen(input: {
  ownerId: string;
  messageId: string;
  leadId: string | null;
  userAgent: string | null;
}): Promise<void> {
  if (!supabaseServer) {
    console.warn("[track/open] Supabase is not configured; open not recorded");
    return;
  }

  const { error } = await supabaseServer.from("email_opens").insert({
    id: eventId(),
    owner_id: input.ownerId,
    message_id: input.messageId,
    lead_id: input.leadId,
    opened_at: new Date().toISOString(),
    user_agent: input.userAgent ? input.userAgent.slice(0, 400) : null,
  } as never);

  if (error) console.warn("[track/open] insert failed:", error.message);
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const ownerId = safeId(params.get("u"));
  const messageId = safeId(params.get("m"));
  const leadId = safeId(params.get("l"));
  const userAgent = req.headers.get("user-agent");

  if (ownerId && messageId) {
    try {
      const timing = await messageTiming(ownerId, messageId);
      const decision = decideOpen({
        cookieNames: req.cookies.getAll().map((cookie) => cookie.name),
        headers: req.headers,
        userAgent,
        sentAt: timing.sentAt,
        senderIpHash: timing.senderIpHash,
        requestIpHash: hashSenderIp(clientIpFromHeaders(req.headers)),
      });

      if (decision.record) {
        await recordOpen({ ownerId, messageId, leadId, userAgent });
      }
    } catch (err) {
      console.warn("[track/open] could not record open", err instanceof Error ? err.message : err);
    }
  }

  return new NextResponse(new Uint8Array(PIXEL), { status: 200, headers: NO_CACHE });
}
