"use client";

import { useMemo, useSyncExternalStore } from "react";
import { AI_PROVIDERS, getProvider } from "./registry";
import type { AiConfig, AiModelOption, AiProviderId } from "./types";
import type { Settings } from "../types";

/**
 * A model provider the user configured. Every enabled provider keeps its own
 * key, base URL, model and capability flags so the operator can switch models
 * per conversation without re-entering anything.
 *
 * Keys live in this browser's storage only (never in the bundle, never in a log)
 * and the provider in use is also written to the user's private settings record
 * so server-side fallbacks keep working. `aiConfigHeader()` attaches the key to
 * authenticated AI requests.
 */
export interface SavedProvider {
  id: string;
  name: string;
  provider: AiProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
  models: AiModelOption[];
  enabled: boolean;
  vision: boolean;
  audio: boolean;
  tools: boolean;
  verifiedAt: string;
  lastError: string;
}

const LIST_KEY = "knowrevo:model-providers";
const ACTIVE_KEY = "knowrevo:model-active";

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `prov-${Math.random().toString(36).slice(2, 10)}`;
}

/** Sensible capability defaults for a provider + model pair, editable by the user. */
export function guessCapabilities(provider: AiProviderId, model: string): Pick<SavedProvider, "vision" | "audio" | "tools"> {
  const id = model.toLowerCase();
  if (provider === "anthropic") return { vision: true, audio: false, tools: true };
  if (provider === "gemini") {
    const audio = id.includes("native-audio") || id.includes("live") || id.includes("2.5-flash") || id.includes("3.");
    return { vision: true, audio, tools: true };
  }
  if (provider === "openai" || provider === "openrouter" || provider === "custom" || provider === "numes") {
    const vision = /gpt-4o|gpt-4\.1|gpt-5|o3|o4|vision|claude|gemini|llama-3\.2|llava|pixtral/.test(id);
    return { vision, audio: false, tools: true };
  }
  if (provider === "mistral") return { vision: id.includes("pixtral"), audio: false, tools: true };
  return { vision: false, audio: false, tools: true };
}

export function toAiConfig(saved: SavedProvider): AiConfig {
  const meta = getProvider(saved.provider);
  return {
    provider: saved.provider,
    model: saved.model || meta?.defaultModel || "",
    apiKey: saved.apiKey,
    ...(saved.baseUrl.trim() ? { baseUrl: saved.baseUrl.trim() } : {}),
  };
}

export function readProviders(): SavedProvider[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LIST_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      .map((entry) => normalizeSaved(entry))
      .filter((entry) => entry.provider && entry.apiKey);
  } catch {
    return [];
  }
}

const PROVIDERS_EVENT = "knowrevo:model-providers-changed";

export function writeProviders(list: SavedProvider[]): void {
  if (typeof window === "undefined") return;
  try {
    // Requirement: never store plaintext API keys in localStorage.
    const sanitized = list.map((p) => ({ ...p, apiKey: "" }));
    window.localStorage.setItem(LIST_KEY, JSON.stringify(sanitized));
    window.dispatchEvent(new Event(PROVIDERS_EVENT));
  } catch {
    /* storage unavailable: the caller keeps its in-memory copy */
  }
}

function subscribeProviders(onChange: () => void): () => void {
  window.addEventListener(PROVIDERS_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(PROVIDERS_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readProvidersRaw(): string {
  try {
    return window.localStorage.getItem(LIST_KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

/** Live provider vault, shared by Settings and the operator's model switcher. */
export function useModelProviders(): SavedProvider[] {
  const raw = useSyncExternalStore(subscribeProviders, readProvidersRaw, () => "[]");
  return useMemo(() => {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
        .map((entry) => normalizeSaved(entry))
        .filter((entry) => entry.provider && entry.apiKey);
    } catch {
      return [];
    }
  }, [raw]);
}

function normalizeSaved(entry: Record<string, unknown>): SavedProvider {
  const provider = String(entry.provider ?? "gemini") as AiProviderId;
  const model = String(entry.model ?? "");
  const caps = guessCapabilities(provider, model);
  return {
    id: String(entry.id ?? newId()),
    name: String(entry.name ?? getProvider(provider)?.label ?? "Provider"),
    provider,
    baseUrl: String(entry.baseUrl ?? ""),
    apiKey: String(entry.apiKey ?? ""),
    model,
    models: Array.isArray(entry.models)
      ? (entry.models as AiModelOption[]).filter((item) => item && typeof item.id === "string")
      : [],
    enabled: entry.enabled !== false,
    vision: typeof entry.vision === "boolean" ? entry.vision : caps.vision,
    audio: typeof entry.audio === "boolean" ? entry.audio : caps.audio,
    tools: typeof entry.tools === "boolean" ? entry.tools : caps.tools,
    verifiedAt: String(entry.verifiedAt ?? ""),
    lastError: String(entry.lastError ?? ""),
  };
}

export function newProviderDraft(): SavedProvider {
  const meta = AI_PROVIDERS[0];
  return {
    id: newId(),
    name: "",
    provider: meta.id,
    baseUrl: "",
    apiKey: "",
    model: meta.defaultModel,
    models: [],
    enabled: true,
    ...guessCapabilities(meta.id, meta.defaultModel),
    verifiedAt: "",
    lastError: "",
  };
}

export function readActiveProviderId(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(ACTIVE_KEY) ?? "";
  } catch {
    return "";
  }
}

const ACTIVE_EVENT = "knowrevo:model-active-changed";

/**
 * The active provider is one shared value, not per-panel state. Settings and the
 * operator subscribe to this event, so switching in one place takes effect in
 * the other immediately instead of leaving a stale model pinned in a panel.
 */
export function setActiveProviderId(id: string): void {
  if (typeof window === "undefined") return;
  try {
    const current = window.localStorage.getItem(ACTIVE_KEY) ?? "";
    if (current === id) return;
    if (id) window.localStorage.setItem(ACTIVE_KEY, id);
    else window.localStorage.removeItem(ACTIVE_KEY);
    window.dispatchEvent(new Event(ACTIVE_EVENT));
  } catch {
    /* ignore */
  }
}

function subscribeActiveProvider(onChange: () => void): () => void {
  window.addEventListener(ACTIVE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(ACTIVE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readActiveProviderRaw(): string {
  try {
    return window.localStorage.getItem(ACTIVE_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Live active provider id, shared by Settings and the operator's model switcher. */
export function useActiveProviderId(): string {
  return useSyncExternalStore(subscribeActiveProvider, readActiveProviderRaw, () => "");
}

export function enabledProviders(list: SavedProvider[]): SavedProvider[] {
  return list.filter((provider) => provider.enabled && provider.apiKey);
}

export function activeProvider(list: SavedProvider[]): SavedProvider | null {
  const available = enabledProviders(list);
  if (available.length === 0) return null;
  const id = readActiveProviderId();
  return available.find((provider) => provider.id === id) ?? available[0];
}

/**
 * Seeds the provider list from the single provider already saved in settings, so
 * an existing setup keeps working after the upgrade.
 */
export function seedFromSettings(list: SavedProvider[], settings: Settings | null | undefined): SavedProvider[] {
  if (!settings || !settings.ai_api_key || list.length > 0) return list;
  const provider = (settings.ai_provider || "gemini") as AiProviderId;
  const meta = getProvider(provider);
  const model = settings.model || meta?.defaultModel || "";
  return [
    {
      id: newId(),
      name: meta?.label ?? provider,
      provider,
      baseUrl: settings.ai_base_url ?? "",
      apiKey: settings.ai_api_key,
      model,
      models: model ? [{ id: model, label: model }] : [],
      enabled: true,
      ...guessCapabilities(provider, model),
      verifiedAt: settings.ai_verified_at ?? "",
      lastError: "",
    },
  ];
}

/**
 * Reads the provider vault persisted in the user's private settings row.
 *
 * localStorage is only a cache: the database copy is what survives a refresh,
 * a new browser or a different device.
 */
export function providersFromSettings(settings: Settings | null | undefined): SavedProvider[] {
  const raw = settings?.ai_providers;
  if (!raw || typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      .map((entry) => normalizeSaved(entry))
      .filter((entry) => entry.provider && entry.apiKey);
  } catch {
    return [];
  }
}

/**
 * The settings patch that stores the whole provider list in the database.
 *
 * The active provider is passed in explicitly: writing the first enabled entry
 * instead silently reset the user's chosen model every time an unrelated
 * provider was tested, toggled or deleted.
 */
export function providersPatchFor(
  list: SavedProvider[],
  activeProviderId?: string,
): Partial<Settings> {
  const active =
    list.find((item) => item.id === activeProviderId && item.enabled) ??
    list.find((item) => item.enabled) ??
    list[0];
  return {
    ai_providers: JSON.stringify(list),
    ...(active ? settingsPatchFor(active) : {}),
  };
}

/**
 * The provider currently in use: the settings fields first (they are what the
 * server runs), then this browser's selection, then the first enabled entry.
 */
export function activeProviderEntry(
  list: SavedProvider[],
  settings: Settings | null | undefined,
): SavedProvider | null {
  return (
    providerFromSettings(list, settings) ??
    list.find((item) => item.id === readActiveProviderId()) ??
    list.find((item) => item.enabled) ??
    list[0] ??
    null
  );
}

/**
 * Changing the active model has to change the provider entry as well. Writing
 * only the top-level settings left `ai_providers` pointing at the previous
 * model, and the next render sent that old model again.
 */
export function patchActiveModel(
  settings: Settings,
  model: string,
  providerHint?: string,
): { patch: Partial<Settings>; provider: SavedProvider | null } {
  const list = providersFromSettings(settings);
  const hint = (providerHint ?? "").trim().toLowerCase();
  const hinted = hint
    ? list.find(
        (item) =>
          item.id.toLowerCase() === hint ||
          item.name.trim().toLowerCase() === hint ||
          item.provider.toLowerCase() === hint,
      ) ?? null
    : null;
  const entry = hinted ?? activeProviderEntry(list, settings);
  if (!entry) return { patch: { model }, provider: null };

  const updated: SavedProvider = { ...entry, model, enabled: true };
  const next = list.some((item) => item.id === entry.id)
    ? list.map((item) => (item.id === entry.id ? updated : item))
    : [...list, updated];
  return {
    patch: { ai_providers: JSON.stringify(next), ...settingsPatchFor(updated) },
    provider: updated,
  };
}

/** The provider whose provider/model/key match the account settings row. */
export function providerFromSettings(
  list: SavedProvider[],
  settings: Settings | null | undefined,
): SavedProvider | null {
  if (!settings) return null;
  return (
    list.find(
      (item) =>
        item.provider === settings.ai_provider &&
        item.apiKey === settings.ai_api_key &&
        item.model === settings.model,
    ) ?? null
  );
}

/** The subset persisted into the private settings row (server fallback). */
export function settingsPatchFor(saved: SavedProvider): Partial<Settings> {
  return {
    ai_provider: saved.provider,
    ai_api_key: saved.apiKey,
    ai_base_url: saved.baseUrl.trim(),
    model: saved.model,
    ai_verified_at: saved.verifiedAt,
    ai_key_hint: saved.apiKey ? `••••${saved.apiKey.slice(-4)}` : "",
  };
}
