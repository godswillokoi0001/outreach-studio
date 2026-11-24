"use client";

import { getFirebaseIdToken } from "./firebase";
import type { Settings } from "./types";

type PushDeviceRegistration = { uid: string; token: string; platform: string; created_at: string };

const STRING_FIELDS = ["sender_name","sender_role","sender_company","sender_email","signature","unsubscribe_email","physical_address","send_days","model","ai_provider","ai_api_key","ai_base_url","ai_verified_at","ai_key_hint"] as const satisfies readonly (keyof Settings)[];
const NUMBER_FIELDS = ["daily_limit","campaign_limit","interval_seconds","send_window_start","send_window_end","timezone_offset","followup_days","min_score"] as const satisfies readonly (keyof Settings)[];

/**
 * Settings live in Supabase, but the table has RLS enabled so the browser can
 * never read or write it directly (it holds the AI key). All access goes
 * through /api/settings, which verifies the Firebase session and uses the
 * service role on the server.
 */
async function callSettingsApi(method: "GET" | "PUT", body?: unknown): Promise<{ settings?: Settings | null } | null> {
  if (typeof window === "undefined") return null;

  const token = await getFirebaseIdToken();
  if (!token) return null;

  try {
    const res = await fetch("/api/settings", {
      method,
      headers: {
        Accept: "application/json",
        "X-Firebase-Token": token,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
      credentials: "same-origin",
    });

    if (!res.ok) return null;
    const text = await res.text();
    if (!text.trim()) return null;
    return JSON.parse(text) as { settings?: Settings | null };
  } catch {
    return null;
  }
}

/** Reads the settings document from Supabase (via the authenticated API). */
export async function getSupabaseSettings(uid: string): Promise<Settings | null> {
  void uid;
  const data = await callSettingsApi("GET");
  return data?.settings ?? null;
}

/** Saves the settings document to Supabase (via the authenticated API). */
export async function saveSupabaseSettings(partial: Partial<Settings>, uid: string): Promise<boolean> {
  void uid;
  const payload: Record<string, unknown> = {};

  for (const key of STRING_FIELDS) {
    const value = partial[key];
    if (typeof value === "string") payload[key] = value;
  }
  for (const key of NUMBER_FIELDS) {
    const value = partial[key];
    if (typeof value === "number" && Number.isFinite(value)) payload[key] = value;
  }

  if (Object.keys(payload).length === 0) return true;
  return Boolean(await callSettingsApi("PUT", payload));
}

/** Push device registration is Firebase-only by design. */
export async function registerPushDevice(uid: string, push: PushDeviceRegistration): Promise<boolean> {
  void uid;
  void push;
  return true;
}
