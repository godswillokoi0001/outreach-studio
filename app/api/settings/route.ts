import { NextRequest, NextResponse } from "next/server";
import { getSupabaseSettingsServer, saveSupabaseSettingsServer } from "@/lib/supabase-server";
import type { Settings } from "@/lib/types";
import { handleApiError } from "@/lib/api-helpers";
import { verifyFirebaseRequest } from "@/lib/firebase-server-auth";

/**
 * Settings REST boundary for the Supabase data layer migration.
 *
 * - The `settings` table has RLS enabled and is not readable or writable with
 *   the public anon key, because it holds the user's AI API key. Every request
 *   here is authenticated with a verified Firebase session and the write is
 *   performed with the service role on the server.
 * - Leads, Campaigns, Messages, Replies, Suppressions, SendLogs, AuditLogs,
 *   Knowledge and push notification devices stay on Firebase.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function parseBody(raw: unknown): Partial<Settings> {
  if (typeof raw !== "object" || raw === null) return {};
  const body = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  const stringFields: Array<keyof Settings> = [
    "ai_provider",
    "ai_api_key",
    "ai_base_url",
    "ai_verified_at",
    "ai_key_hint",
  ];
  for (const key of stringFields) {
    const value = body[key];
    if (typeof value === "string") out[key] = value;
  }

  return out as Partial<Settings>;
}

function supabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}

export async function GET(req: NextRequest) {
  try {
    await verifyFirebaseRequest(req);

    if (!supabaseConfigured()) {
      return NextResponse.json(
        { error: "Supabase is not configured on this deployment." },
        { status: 503 },
      );
    }

    const settings = await getSupabaseSettingsServer();
    return NextResponse.json({ settings }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PUT(req: NextRequest) {
  try {
    await verifyFirebaseRequest(req);

    if (!supabaseConfigured()) {
      return NextResponse.json(
        { error: "Supabase is not configured on this deployment." },
        { status: 503 },
      );
    }

    const body = parseBody(await req.json().catch(() => ({})));
    if (Object.keys(body).length === 0) {
      return NextResponse.json({ error: "Empty settings payload." }, { status: 400 });
    }

    const ok = await saveSupabaseSettingsServer(body);
    if (!ok) {
      return NextResponse.json({ error: "Supabase request failed." }, { status: 500 });
    }

    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleApiError(err);
  }
}
