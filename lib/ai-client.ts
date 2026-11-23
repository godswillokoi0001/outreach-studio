"use client";

import { getSettings } from "./firestore-store";
import { getSupabaseSettings } from "./supabase";
import type { AiConfig, AiProviderId } from "./ai/types";
import type { Settings } from "./types";

/**
 * The browser owns the user's AI key. It is stored in the user's private
 * Firestore settings record and mirrored to Supabase for the migration, so the
 * config loader reads Firestore and falls back to the Supabase row (which is
 * only exposed through the authenticated /api/settings route).
 *
 * Nothing is written to localStorage.
 */
let cached: AiConfig | null = null;
let pending: Promise<AiConfig | null> | null = null;
let loadedUid: string | null = null;

export function aiConfigFromSettings(settings: Settings | null | undefined): AiConfig | null {
  if (!settings) return null;
  const apiKey = (settings.ai_api_key ?? "").trim();
  if (!apiKey) return null;
  const provider = ((settings.ai_provider ?? "").trim() || "gemini") as AiProviderId;
  const model = (settings.model ?? "").trim();
  const baseUrl = (settings.ai_base_url ?? "").trim();
  return {
    provider,
    model,
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
  };
}

export function setActiveAiConfig(config: AiConfig | null): void {
  cached = config;
  pending = Promise.resolve(config);
}

export function currentAiConfig(): AiConfig | null {
  return cached;
}

export function aiConfigHeader(): string | null {
  if (!cached || !cached.apiKey) return null;
  return encodeURIComponent(
    JSON.stringify({
      provider: cached.provider,
      model: cached.model,
      apiKey: cached.apiKey,
      ...(cached.baseUrl ? { baseUrl: cached.baseUrl } : {}),
    }),
  );
}

export function initAiConfig(uid: string): Promise<AiConfig | null> {
  if (loadedUid === uid && pending) return pending;
  loadedUid = uid;
  pending = Promise.all([
    getSettings(uid).catch(() => null),
    getSupabaseSettings(uid).catch(() => null),
  ])
    .then(([firestoreSettings, supabaseSettings]) => {
      const base = firestoreSettings;
      const remoteKey = (supabaseSettings?.ai_api_key ?? "").trim();

      // The Supabase row wins when it holds a key, otherwise the private
      // Firestore record (which also carries the selected model) is used.
      const merged: Settings | null = remoteKey
        ? ({
            ...(base ?? {}),
            ai_provider: supabaseSettings?.ai_provider || base?.ai_provider || "gemini",
            ai_api_key: remoteKey,
            ai_base_url: supabaseSettings?.ai_base_url ?? base?.ai_base_url ?? "",
            ai_verified_at: supabaseSettings?.ai_verified_at ?? base?.ai_verified_at ?? "",
            ai_key_hint: supabaseSettings?.ai_key_hint ?? base?.ai_key_hint ?? "",
            model: (supabaseSettings?.model || base?.model || "").trim(),
          } as Settings)
        : base;

      cached = aiConfigFromSettings(merged);
      return cached;
    })
    .catch(() => {
      cached = null;
      return null;
    });
  return pending;
}

export async function ensureAiConfigLoaded(): Promise<AiConfig | null> {
  if (pending) return pending;
  return cached;
}

export function refreshAiConfig(uid: string): Promise<AiConfig | null> {
  loadedUid = null;
  pending = null;
  return initAiConfig(uid);
}
