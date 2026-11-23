"use client";

import { getFirebaseIdToken } from "./firebase";
import type { Settings } from "./types";

declare type PushDeviceRegistration = {
  uid: string;
  token: string;
  platform: string;
  created_at: string;
};

/**
 * Settings live in Supabase, but the table is locked down with RLS so the
 * browser can never read or write it directly (the AI key is a secret).
 * All access goes through /api/settings, which verifies the Firebase session
 * and uses the service role on the server.
 */
async function callSettingsApi(
  method: "GET" | "PUT",
  body?: unknown,
): Promise<{ settings?: Settings | null } | null> {
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

/** Reads the AI settings row from Supabase (via the authenticated server route). */
export async function getSupabaseSettings(uid: string): Promise<Settings | null> {
  void uid;
  const data = await callSettingsApi("GET");
  if (!data || !data.settings) return null;
  return data.settings;
}

/** Saves the AI settings row to Supabase (via the authenticated server route). */
export async function saveSupabaseSettings(partial: Partial<Settings>, uid: string): Promise<boolean> {
  void uid;
  const payload: Record<string, unknown> = {};
  const fields = [
    "ai_provider",
    "ai_api_key",
    "ai_base_url",
    "ai_verified_at",
    "ai_key_hint",
  ] as const;

  for (const key of fields) {
    const value = partial[key];
    if (typeof value === "string") payload[key] = value;
  }

  // Nothing this table stores changed (for example a model-only edit).
  if (Object.keys(payload).length === 0) return true;

  const data = await callSettingsApi("PUT", payload);
  return Boolean(data);
}

/** Push device registration is Firebase-only by design: the settings table
 * stores AI credentials, not notification tokens.
 */
export async function registerPushDevice(
  uid: string,
  payload: PushDeviceRegistration,
): Promise<boolean> {
  void uid;
  void payload;
  return true;
}
