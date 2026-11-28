"use client";

import { getAccessToken } from "./auth";
import type { Settings } from "./types";

type PushDeviceRegistration = { uid: string; token: string; platform: string; created_at: string };

const STRING_FIELDS = ["sender_name","sender_role","sender_company","sender_email","signature","email_footer","unsubscribe_email","physical_address","send_days","model","ai_provider","ai_api_key","ai_base_url","ai_verified_at","ai_key_hint","ai_providers","ui_prefs"] as const satisfies readonly (keyof Settings)[];
const NUMBER_FIELDS = ["daily_limit","campaign_limit","interval_seconds","send_window_start","send_window_end","timezone_offset","followup_days","min_score"] as const satisfies readonly (keyof Settings)[];

/**
 * Result of a settings read/write.
 *
 * `unconfigured` is only true when the deployment itself has no Supabase
 * credentials (HTTP 503). Any other failure is a real error and must be
 * surfaced: treating it as "no settings" is what made a stored AI key look
 * like it had disappeared.
 */
export type SettingsResult =
  | { ok: true; settings: Settings | null }
  | { ok: false; unconfigured: boolean; message: string };

async function request(method: "GET" | "PUT", body?: unknown): Promise<SettingsResult> {
  if (typeof window === "undefined") {
    return { ok: false, unconfigured: false, message: "Settings are only available in the browser." };
  }

  const token = await getAccessToken();
  if (!token) {
    return {
      ok: false,
      unconfigured: false,
      message: "Your session expired. Sign in with Google again, then reload.",
    };
  }

  let res: Response;
  try {
    res = await fetch("/api/settings", {
      method,
      headers: {
        Accept: "application/json",
        "Authorization": `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    return {
      ok: false,
      unconfigured: false,
      message: "Could not reach the settings service. Check your connection and try again.",
    };
  }

  const text = await res.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  const message =
    parsed && typeof parsed === "object" && "error" in parsed
      ? String((parsed as { error: unknown }).error)
      : `Settings request failed (HTTP ${res.status}).`;

  if (res.status === 503) return { ok: false, unconfigured: true, message };
  if (!res.ok) return { ok: false, unconfigured: false, message };

  const settings =
    parsed && typeof parsed === "object" && "settings" in parsed
      ? ((parsed as { settings: Settings | null }).settings ?? null)
      : null;

  return { ok: true, settings };
}

/** Reads the settings document from the database through the authenticated API. */
export async function fetchSettingsDocument(): Promise<SettingsResult> {
  return request("GET");
}

/** Saves the settings document to the database through the authenticated API. */
export async function saveSettingsDocument(partial: Partial<Settings>): Promise<SettingsResult> {
  const payload: Record<string, unknown> = {};

  for (const key of STRING_FIELDS) {
    const value = partial[key];
    if (typeof value === "string") payload[key] = value;
  }
  for (const key of NUMBER_FIELDS) {
    const value = partial[key];
    if (typeof value === "number" && Number.isFinite(value)) payload[key] = value;
  }

  if (Object.keys(payload).length === 0) return { ok: true, settings: null };
  return request("PUT", payload);
}

/** Push device registration is Firebase-only by design. */
export async function registerPushDevice(uid: string, push: PushDeviceRegistration): Promise<boolean> {
  void uid;
  void push;
  return true;
}
