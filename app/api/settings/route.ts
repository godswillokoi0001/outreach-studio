import { NextRequest, NextResponse } from "next/server";
import { getSupabaseSettingsServer, saveSupabaseSettingsServer } from "@/lib/supabase-server";
import type { Settings } from "@/lib/types";
import { handleApiError } from "@/lib/api-helpers";
import { verifyRequest } from "@/lib/server-auth";

/**
 * Settings REST boundary.
 *
 * - The `settings` table has RLS enabled and is not readable or writable with
 *   the public anon key, because it holds the user's AI API key. Every request
 *   here is authenticated with a verified Firebase session and the write is
 *   performed with the service role on the server.
 * - The whole document is persisted (identity, limits, AI engine), not just the
 *   AI fields: anything dropped here silently reverts to defaults on reload.
 * - Leads, Campaigns, Messages, Replies, Suppressions, SendLogs, AuditLogs and
 *   Knowledge live in the document tables behind /api/data.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const STRING_LIMITS: Record<string, number> = {
  sender_name: 160,
  sender_role: 160,
  sender_company: 200,
  sender_email: 320,
  signature: 2000,
  unsubscribe_email: 320,
  physical_address: 400,
  send_days: 32,
  model: 200,
  ai_provider: 40,
  ai_api_key: 512,
  ai_base_url: 400,
  ai_verified_at: 64,
  ai_key_hint: 40,
  ai_providers: 20_000,
  ui_prefs: 500,
};

const NUMBER_RANGES: Record<string, [number, number]> = {
  daily_limit: [1, 200],
  campaign_limit: [1, 500],
  interval_seconds: [30, 900],
  send_window_start: [0, 23],
  send_window_end: [1, 24],
  timezone_offset: [-720, 840],
  followup_days: [1, 30],
  min_score: [0, 100],
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function parseBody(raw: unknown): Partial<Settings> {
  if (typeof raw !== "object" || raw === null) return {};
  const body = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, maxLength] of Object.entries(STRING_LIMITS)) {
    const value = body[key];
    if (typeof value !== "string") continue;

    // ai_verified_at is a timestamptz column, so an empty value simply means
    // "not verified" and is left untouched.
    if (key === "ai_verified_at") {
      const trimmed = value.trim();
      if (trimmed && !Number.isNaN(Date.parse(trimmed))) out[key] = trimmed;
      continue;
    }

    out[key] = value.slice(0, maxLength);
  }

  for (const [key, range] of Object.entries(NUMBER_RANGES)) {
    const value = body[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = clamp(value, range[0], range[1]);
    }
  }

  return out as Partial<Settings>;
}

function supabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}

import { maskSecret } from "@/lib/key-vault";

function sanitizeSettingsForClient(settings: Settings | null): Settings | null {
  if (!settings) return null;
  // Never transmit plaintext AI API keys to the browser.
  const maskedKey = settings.ai_api_key ? maskSecret(settings.ai_api_key) : "";
  return {
    ...settings,
    ai_api_key: "",
    ai_key_hint: settings.ai_key_hint || maskedKey,
    ai_providers: "",
  };
}

export async function GET(req: NextRequest) {
  try {
    await verifyRequest(req);

    if (!supabaseConfigured()) {
      return NextResponse.json(
        { error: "Supabase is not configured on this deployment." },
        { status: 503 },
      );
    }

    const settings = sanitizeSettingsForClient(await getSupabaseSettingsServer());
    return NextResponse.json({ settings }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PUT(req: NextRequest) {
  try {
    await verifyRequest(req);

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

    // Return masked/safe document so keys never travel to the browser.
    const settings = sanitizeSettingsForClient(await getSupabaseSettingsServer());
    return NextResponse.json({ ok: true, settings }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleApiError(err);
  }
}
