import { NextRequest, NextResponse } from "next/server";
import firebaseConfig from "../../../../firebase-applet-config.json";

/**
 * 1x1 open-tracking pixel.
 *
 * Sent inside the HTML part of every outreach email. Mail clients that load
 * remote images hit this route, which appends an immutable event document to
 * the owner-scoped `tracking` collection over the Firestore REST API (the pixel
 * itself is public and has no Firebase session, so Security Rules only permit
 * constrained creates and owner-scoped reads).
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
  const project = firebaseConfig.projectId;
  const database = firebaseConfig.firestoreDatabaseId || "(default)";
  const url =
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project)}` +
    `/databases/${encodeURIComponent(database)}/documents/tracking` +
    `?key=${encodeURIComponent(firebaseConfig.apiKey)}&documentId=${eventId()}`;

  const fields: Record<string, unknown> = {
    ownerId: { stringValue: input.ownerId },
    message_id: { stringValue: input.messageId },
    opened_at: { stringValue: new Date().toISOString() },
  };
  if (input.leadId) fields.lead_id = { stringValue: input.leadId };
  if (input.userAgent) fields.user_agent = { stringValue: input.userAgent.slice(0, 400) };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    console.warn("[track/open] Firestore write failed", res.status, text.slice(0, 300));
  }
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
