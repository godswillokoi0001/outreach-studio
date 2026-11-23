// Server-side Supabase client using the service role key.
// This runs purely on the server (Next.js routes, API handlers) and never
// exposes the service role key to the browser. The anon key is used by the
// browser Component in lib/supabase.ts; server-side calls use the service
// role key directly via the supabase-js `createClient` function.

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

// Server client with the service role key. No __enableTyping needed since
// this runs only on the server.
export const supabaseServer = createClient<Database>(supabaseUrl, supabaseServiceRoleKey);

/** Get settings for a user from Supabase (server side). */
export async function getSupabaseSettingsServer(): Promise<Settings | null> {
  const { data, error } = await supabaseServer
    .from("settings")
    .select("id, ai_provider, ai_api_key, ai_base_url, ai_verified_at, ai_key_hint")
    .single();

  if (error) {
    if ((error as { code?: string }).code === "PGRST_NOT_FOUND") return null;
    console.error("[supabase-server] getSettings error:", error);
    return null;
  }

  return data ?? null;
}

/** Save settings to Supabase (server side). */
export async function saveSupabaseSettingsServer(
  partial: Partial<Settings>,
): Promise<boolean> {
  const { data, error } = await supabaseServer
    .from("settings")
    .upsert(partial as any /* eslint-disable-line @typescript-eslint/no-explicit-any */, {
      onConflict: "id",
    })
    .select("id")
    .single();

  if (error) {
    console.error("[supabase-server] saveSettings error:", error);
    return false;
  }

  return true;
}