import { NextRequest, NextResponse } from "next/server";
import { getSupabaseSettingsServer, saveSupabaseSettingsServer } from "@/lib/supabase-server";
import type { Settings } from "@/lib/types";
import { handleApiError } from "@/lib/api-helpers";

/**
 * Settings REST boundary for the Supabase data layer migration.
 *
 * - Supabase is authoritative only for the AI settings workspace (`settings`
 *   table). Leads, Campaigns, Messages, Replies, Suppressions, SendLogs,
 *   AuditLogs, Knowledge and the push notification device registration stay
 *   on Firebase and are NOT rewritten by this route.
 * - The `X-AI-Config` header is attached by the browser when it posts AI
 *   settings, exactly like the Firestore routes expect.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function parseBody(raw: unknown): Partial<Settings> {
  if (typeof raw !== "object" || raw === null) return {};
  const body = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  const stringFields: Array<keyof Settings> = [
    "sender_name",
    "sender_role",
    "sender_company",
    "sender_email",
    "signature",
    "unsubscribe_email",
    "physical_address",
    "ai_provider",
    "ai_api_key",
    "ai_base_url",
    "ai_key_hint",
    "model",
  ];
  for (const key of stringFields) {
    const value = body[key];
    if (typeof value === "string") out[ key] = value;
  }

  const numberFields: Array<keyof Settings> = [
    "daily_limit",
    "campaign_limit",
    "interval_seconds",
    "send_window_start",
    "send_window_end",
    "timezone_offset",
    "followup_days",
    "min_score",
  ];
  for (const key of numberFields) {
    const value = body[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = Math.round(value);
  }

  return out as Partial<Settings>;
}

export async function GET(req: NextRequest) {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return NextResponse.json(
      { error: "Supabase is not configured on this deployment." },
      { status: 503 },
    );
  }

  try {
    const settings = await getSupabaseSettingsServer();
    return NextResponse.json({ settings });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PUT(req: NextRequest) {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return NextResponse.json(
      { error: "Supabase is not configured on this deployment." },
      { status: 503 },
    );
  }

  try {
    const body = parseBody(await req.json().catch(() => ({})));
    if (Object.keys(body).length === 0) {
      return NextResponse.json({ error: "Empty settings payload." }, { status: 400 });
    }

    const ok = await saveSupabaseSettingsServer(body);
    if (!ok) {
      return NextResponse.json({ error: "Supabase request failed." }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
