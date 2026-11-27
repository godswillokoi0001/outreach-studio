// Server-side Supabase client using the service role key.
// Runs only on the server (Next.js routes); the service role key never reaches
// the browser. All tables have RLS enabled and revoke anon/authenticated access.

import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
import { DEFAULT_SETTINGS, type Settings } from "./types";

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
  "ai_providers",
  "ui_prefs",
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

const BOOLEAN_FIELDS = [
  "include_opt_out_footer",
] as const satisfies readonly (keyof Settings)[];

function deterministicSettingsUuid(ownerId: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ownerId)) {
    return ownerId.toLowerCase();
  }
  const hex = createHash("sha256").update(`knowrevo:settings:${ownerId}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function mirrorDocId(ownerId: string): string {
  return `system_user_settings_${ownerId}`;
}

async function getMirrorSettings(ownerId: string): Promise<Settings | null> {
  if (!supabaseServer || !ownerId) return null;
  try {
    const { data } = await supabaseServer
      .from("knowledge")
      .select("content")
      .eq("id", mirrorDocId(ownerId))
      .eq("owner_id", ownerId)
      .maybeSingle();
    const raw = (data as { content?: string } | null)?.content;
    return raw ? (JSON.parse(raw) as Settings) : null;
  } catch {
    return null;
  }
}

async function saveMirrorSettings(ownerId: string, partial: Partial<Settings>): Promise<boolean> {
  if (!supabaseServer || !ownerId) return false;
  try {
    const current = (await getMirrorSettings(ownerId)) ?? { ...DEFAULT_SETTINGS };
    const merged: Settings = { ...current, ...partial };
    const { error } = await supabaseServer.from("knowledge").upsert(
      {
        id: mirrorDocId(ownerId),
        owner_id: ownerId,
        category: "system_user_settings",
        title: "Account Settings",
        content: JSON.stringify(merged),
        sort: 997,
        is_master: false,
        updated_at: new Date().toISOString(),
      } as never,
      { onConflict: "id" },
    );
    return !error;
  } catch {
    return false;
  }
}

/**
 * Get the settings document strictly scoped to `ownerId`.
 * Never reads another account's settings or unowned shared rows.
 */
export async function getSupabaseSettingsServer(ownerId: string): Promise<Settings | null> {
  if (!supabaseServer || !ownerId) return null;

  try {
    const { data, error } = await supabaseServer
      .from("settings")
      .select("*")
      .eq("owner_id", ownerId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      if (/owner_id/i.test(error.message)) {
        // Migration not applied yet -> read strictly owner-scoped knowledge mirror.
        return await getMirrorSettings(ownerId);
      }
      if ((error as { code?: string }).code === "PGRST_NOT_FOUND" || (error as { code?: string }).code === "PGRST116") {
        return await getMirrorSettings(ownerId);
      }
      console.warn("[supabase-server] getSettings notice:", error.message);
      return await getMirrorSettings(ownerId);
    }

    if (data) return data as unknown as Settings;
    return await getMirrorSettings(ownerId);
  } catch {
    return await getMirrorSettings(ownerId);
  }
}

/**
 * Save the settings document strictly for `ownerId`.
 * Always keeps an isolated per-user row and never mutates any other account.
 */
export async function saveSupabaseSettingsServer(
  ownerId: string,
  partial: Partial<Settings>,
): Promise<boolean> {
  if (!supabaseServer || !ownerId) return false;

  const nowIso = new Date().toISOString();
  const fields: Record<string, unknown> = {
    owner_id: ownerId,
    updated_at: nowIso,
  };

  for (const key of STRING_FIELDS) {
    const value = partial[key];
    if (typeof value !== "string") continue;

    if (key === "ai_verified_at") {
      if (value.trim() && !Number.isNaN(Date.parse(value))) fields[key] = value;
      continue;
    }

    fields[key] = value.slice(0, key === "ai_providers" ? 20_000 : 2000);
  }

  for (const key of NUMBER_FIELDS) {
    const value = partial[key];
    if (typeof value === "number" && Number.isFinite(value)) fields[key] = Math.round(value);
  }

  for (const key of BOOLEAN_FIELDS) {
    const value = partial[key];
    if (typeof value === "boolean") fields[key] = value;
  }

  if (Object.keys(fields).length <= 2) return true;

  try {
    const { data: existing } = await supabaseServer
      .from("settings")
      .select("id")
      .eq("owner_id", ownerId)
      .limit(1)
      .maybeSingle();

    if (existing && (existing as { id?: string }).id) {
      const targetId = String((existing as { id: string }).id);
      const { error } = await supabaseServer
        .from("settings")
        .update(fields as never)
        .eq("id", targetId)
        .eq("owner_id", ownerId);
      if (!error) return true;
    } else {
      const rowId = deterministicSettingsUuid(ownerId);
      const { error } = await supabaseServer
        .from("settings")
        .upsert({ id: rowId, ai_api_key: "", ...fields } as never, { onConflict: "id" });
      if (!error) return true;
      if (!/owner_id/i.test(error.message)) {
        console.error("[supabase-server] saveSettings error:", error.message);
      }
    }
  } catch {
    // Fall through to owner-scoped mirror below
  }

  return await saveMirrorSettings(ownerId, partial);
}
