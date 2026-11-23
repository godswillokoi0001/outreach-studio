"use client";

import { getSettings } from "./firestore-store";
import type { AiConfig, AiProviderId } from "./ai/types";
import type { Settings } from "./types";

/**
 * The browser owns the user's AI key (it lives in their private Firestore
 * settings record), so it also keeps an in-memory copy to attach to AI calls.
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
  pending = getSettings(uid)
    .then((settings) => {
      cached = aiConfigFromSettings(settings);
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
