// Server-side Supabase client using the service role key.
// Runs only on the server (Next.js routes); the service role key never reaches
// the browser. The settings table has RLS enabled, so this is the only way in.

import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
import type { Settings } from "./types";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.warn(
    "[supabase-server] Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY; server queries will be no-ops.",
  );
}

export const supabaseServer =
  supabaseUrl && supabaseServiceRoleKey
    ? createClient<Database>(supabaseUrl, supabaseServiceRoleKey)
    : null;

/**
 * The settings table holds one row. Pinning the primary key means every save
 * updates that row instead of inserting another one.
 */
export const SETTINGS_ROW_ID = "00000000-0000-0000-0000-000000000001";

const STRING_FIELDS = [
  "sender_name",
  "sender_role",
  "sender_company",
  "sender_email",
  "signature",
  "unsubscribe_email",
  "physical_address",
  "send_days",
  "model",
  "ai_provider",
  "ai_api_key",
  "ai_base_url",
  "ai_verified_at",
  "ai_key_hint",
] as const satisfies readonly (keyof Settings)[];

const NUMBER_FIELDS = [
  "daily_limit",
  "campaign_limit",
  "interval_seconds",
  "send_window_start",
  "send_window_end",
  "timezone_offset",
  "followup_days",
  "min_score",
] as const satisfies readonly (keyof Settings)[];

/** Get the settings document from Supabase (server side). */
export async function getSupabaseSettingsServer(): Promise<Settings | null> {
  if (!supabaseServer) return null;

  try {
    const { data, error } = await supabaseServer
      .from("settings")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      if ((error as { code?: string }).code === "PGRST_NOT_FOUND" || (error as { code?: string }).code === "PGRST116") return null;
      console.warn("[supabase-server] getSettings notice:", error.message);
      return null;
    }

    return (data as unknown as Settings) ?? null;
  } catch {
    return null;
  }
}

/** Save the settings document to Supabase (server side). */
export async function saveSupabaseSettingsServer(
  partial: Partial<Settings>,
): Promise<boolean> {
  if (!supabaseServer) return false;

  const payload: Record<string, unknown> = {
    id: SETTINGS_ROW_ID,
    updated_at: new Date().toISOString(),
  };

  for (const key of STRING_FIELDS) {
    const value = partial[key];
    if (typeof value !== "string") continue;

    // ai_verified_at is a timestamptz column: never write an empty string.
    if (key === "ai_verified_at") {
      if (value.trim() && !Number.isNaN(Date.parse(value))) payload[key] = value;
      continue;
    }

    payload[key] = value.slice(0, 2000);
  }

  for (const key of NUMBER_FIELDS) {
    const value = partial[key];
    if (typeof value === "number" && Number.isFinite(value)) payload[key] = Math.round(value);
  }

  // Nothing but the update timestamp changed.
  if (Object.keys(payload).length === 2) return true;

  // New rows need a key value because the column is NOT NULL.
  if (!("ai_api_key" in payload) && !(await rowExists())) {
    payload.ai_api_key = "";
  }

  const { error } = await supabaseServer
    .from("settings")
    .upsert(payload as never, { onConflict: "id" })
    .select("id")
    .single();

  if (error) {
    console.error("[supabase-server] saveSettings error:", error.message);
    return false;
  }

  return true;
}

async function rowExists(): Promise<boolean> {
  if (!supabaseServer) return false;
  const { data, error } = await supabaseServer
    .from("settings")
    .select("id")
    .eq("id", SETTINGS_ROW_ID)
    .maybeSingle();
  if (error) return false;
  return Boolean(data);
}
