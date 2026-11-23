// Runtime guard: SUPABASE_URL|SUPABASE_ANON_KEY are required server-side;
// NEXT_PUBLIC_* are the same values exposed to the browser.
declare type PushDeviceRegistration = {
  uid: string;
  token: string;
  platform: string;
  created_at: string;
};

import { createClient } from "@supabase/supabase-js";
import type { Settings } from "./types";
import type { Database } from "./database.types";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    "[supabase] Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY; Supabase queries will be no-ops.",
  );
}

export const supabase = supabaseUrl && supabaseAnonKey
  ? createClient<Database>(supabaseUrl, supabaseAnonKey)
  : null;

export type SupabaseClient = typeof supabase;

/** Supabase settings read/write is the single data-access boundary the UI
 * touches for AI provider settings. Everything else (Leads, Campaigns,
 * Messages, ...Suppressions, tracking) stays on Firebase.
 */
export async function getSupabaseSettings(uid: string): Promise<Settings | null> {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("settings")
    .select("ai_provider, ai_api_key, ai_base_url, ai_verified_at, ai_key_hint")
    .eq("ownerId", uid)
    .single();

  if (error) {
    if ((error as { code?: string }).code === "PGRST_NOT_FOUND") return null;
    console.error("[supabase] getSettings error:", error);
    return null;
  }

  return data ?? null;
}

export async function saveSupabaseSettings(partial: Partial<Settings>, uid: string): Promise<boolean> {
  if (!supabase) return false;

  const { data, error } = await supabase
    .from("settings")
    .upsert({ ...partial, ownerId: uid } as any /* eslint-disable-line @typescript-eslint/no-explicit-any */, {
      onConflict: "id",
    })
    .select("id")
    .single();

  if (error) {
    console.error("[supabase] saveSettings error:", error);
    return false;
  }

  return true;
}

/** Push device registration is Firebase-only by design. Supabase cannot
 * persist notification tokens, so this function is intentionally a stub
 * that keeps Firestore read/write intact (and is a no-op until Supabase
 * auth is explicitly enabled as the notification backend).
 */
export async function registerPushDevice(
  uid: string,
  payload: PushDeviceRegistration,
): Promise<boolean> {
  // Firebase handlers register the token; Supabase only stores the
  // canonical user document in the notifications table.
  return true;
}