import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";

/**
 * 1x1 open-tracking pixel.
 *
 * Sent inside the HTML part of every outreach email. Mail clients that load
 * remote images hit this route, which appends an immutable open event to the
 * `email_opens` table with the service role (the pixel is public and has no
 * session, so only this constrained insert is allowed).
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

  if (ownerId && messageId) {
    try {
      await recordOpen({
        ownerId,
        messageId,
        leadId,
        userAgent: req.headers.get("user-agent"),
      });
    } catch (err) {
      console.warn("[track/open] could not record open", err instanceof Error ? err.message : err);
    }
  }

  return new NextResponse(new Uint8Array(PIXEL), { status: 200, headers: NO_CACHE });
}
