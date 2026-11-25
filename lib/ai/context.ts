import { AsyncLocalStorage } from "node:async_hooks";
import type { NextRequest } from "next/server";
import { getSupabaseSettingsServer } from "../supabase-server";
import { listProviderModels } from "./chat";
import { getProvider, isProviderId, pickRecommendedModel, providerBaseUrl } from "./registry";
import type { AiConfig } from "./types";

/**
 * Per-request AI configuration. The browser reads the user's key from the
 * private settings row and sends it with each AI call, so the server stays
 * stateless and never needs a service account.
 */
const storage = new AsyncLocalStorage<AiConfig>();

/** Providers such as Numes ship no static default model, so it is resolved once from their live catalogue. */
const modelCache = new Map<string, { model: string; at: number }>();
const MODEL_CACHE_MS = 10 * 60 * 1000;

async function resolveProviderModel(cfg: AiConfig): Promise<AiConfig> {
  if (cfg.model) return cfg;
  const meta = getProvider(cfg.provider);
  if (!meta) return cfg;

  const cacheKey = `${meta.id}:${cfg.baseUrl ?? meta.baseUrl}`;
  const cached = modelCache.get(cacheKey);
  if (cached && Date.now() - cached.at < MODEL_CACHE_MS) return { ...cfg, model: cached.model };
  if (cached) modelCache.delete(cacheKey);

  try {
    const models = await listProviderModels(cfg);
    const model = pickRecommendedModel(meta, models);
    if (!model) return cfg;
    modelCache.set(cacheKey, { model, at: Date.now() });
    return { ...cfg, model };
  } catch {
    return cfg;
  }
}

export function runWithAiConfig<T>(config: AiConfig | null | undefined, fn: () => Promise<T> | T): Promise<T> | T {
  if (!config) return fn();
  return storage.run(config, fn);
}

export function getActiveAiConfig(): AiConfig | null {
  return storage.getStore() ?? null;
}

const MAX_KEY_LENGTH = 512;
const MAX_MODEL_LENGTH = 200;
const MAX_BASE_URL_LENGTH = 400;

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "0.0.0.0" || host === "::1" || host === "::") return true;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  if (host.includes(":")) {
    if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return true;
  }
  return false;
}

/** Only public http(s) endpoints are allowed, which keeps custom keys from turning into SSRF probes. */
export function isSafeProviderUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.username || url.password) return false;
    return !isPrivateHostname(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Reads the AI credentials a signed-in browser attached to an AI request.
 * Invalid or unsafe values are ignored so the route falls back to the server
 * default (the environment Gemini key).
 */
export function readAiConfigFromRequest(req: NextRequest): AiConfig | null {
  const raw = req.headers.get("x-ai-config");
  if (!raw) return null;

  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.length > 4000 || !decoded.trim().startsWith("{")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Partial<AiConfig>;

  const providerId = typeof obj.provider === "string" ? obj.provider.trim().toLowerCase() : "";
  if (!isProviderId(providerId)) return null;

  const apiKey = typeof obj.apiKey === "string" ? obj.apiKey.trim() : "";
  if (!apiKey || apiKey.length > MAX_KEY_LENGTH) return null;

  const model = typeof obj.model === "string" ? obj.model.trim().slice(0, MAX_MODEL_LENGTH) : "";
  const baseUrlInput = typeof obj.baseUrl === "string" ? obj.baseUrl.trim().slice(0, MAX_BASE_URL_LENGTH) : "";

  let baseUrl: string | undefined;
  if (baseUrlInput) {
    if (!isSafeProviderUrl(baseUrlInput)) return null;
    baseUrl = baseUrlInput;
  }

  const meta = getProvider(providerId);
  if (!meta) return null;

  const cfg: AiConfig = {
    provider: meta.id,
    model: model || meta.defaultModel,
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
  };
  if (!providerBaseUrl(cfg)) return null;
  return cfg;
}

/**
 * The AI key lives in the user's settings row, so the server can run a request
 * even when the browser never attached X-AI-Config (expired session, a failed
 * settings read, or a different device).
 */
export async function storedAiConfig(): Promise<AiConfig | null> {
  const settings = await getSupabaseSettingsServer();
  if (!settings) return null;

  const apiKey = (settings.ai_api_key ?? "").trim();
  if (!apiKey || apiKey.length > MAX_KEY_LENGTH) return null;

  const providerId = (settings.ai_provider ?? "").trim().toLowerCase();
  if (!isProviderId(providerId)) return null;

  const meta = getProvider(providerId);
  if (!meta) return null;

  const baseUrl = (settings.ai_base_url ?? "").trim();
  if (baseUrl && !isSafeProviderUrl(baseUrl)) return null;

  const cfg: AiConfig = {
    provider: meta.id,
    model: (settings.model ?? "").trim().slice(0, MAX_MODEL_LENGTH) || meta.defaultModel,
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
  };

  if (!providerBaseUrl(cfg)) return null;
  return resolveProviderModel(cfg);
}

/** The request header wins for provider/base URL; the database fills the gaps. */
export async function resolveAiConfigForRequest(req: NextRequest): Promise<AiConfig | null> {
  const fromRequest = readAiConfigFromRequest(req);
  const stored = await storedAiConfig().catch(() => null);

  if (!fromRequest) return stored;
  if (!stored) return resolveProviderModel(fromRequest);

  return resolveProviderModel({ ...fromRequest, model: fromRequest.model || stored.model });
}
