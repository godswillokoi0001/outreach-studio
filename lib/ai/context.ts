import { AsyncLocalStorage } from "node:async_hooks";
import type { NextRequest } from "next/server";
import { verifyRequest } from "../server-auth";
import {
  recordRoutedExecution,
  resolveRoutedAiPlan,
  RoutedAiError,
  type ResolvedAiPlan,
} from "../platform/router";
import { listProviderModels } from "./chat";
import { getProvider, pickRecommendedModel } from "./registry";
import type { AiConfig } from "./types";

const storage = new AsyncLocalStorage<AiConfig>();
const planMap = new WeakMap<AiConfig, ResolvedAiPlan>();

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

function isRetryableProviderFailure(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /rate limit|429|temporarily unavailable|overloaded|503|502|timeout|ECONNRESET/i.test(msg);
}

function isPersonalKeyFailure(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 401 || status === 402 || status === 403) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /invalid api key|incorrect api key|authentication|unauthorized|insufficient_quota|credit|billing|quota exceeded/i.test(
    msg,
  );
}

export async function runWithAiConfig<T>(
  config: AiConfig | null | undefined,
  fn: () => Promise<T> | T,
): Promise<T> {
  if (!config) return fn();

  const plan = planMap.get(config);
  if (!plan) {
    return storage.run(config, fn);
  }

  const startMs = Date.now();
  const candidates = [plan.primary, ...plan.fallbacks];
  let lastError: unknown = null;

  for (let i = 0; i < candidates.length; i++) {
    const activeCfg = candidates[i];
    const isPersonalAttempt = plan.source === "personal" && i === 0;

    try {
      const result = await storage.run(activeCfg, fn);
      void recordRoutedExecution({
        plan,
        usedConfig: activeCfg,
        startMs,
        success: true,
      });
      return result;
    } catch (err) {
      lastError = err;
      const errMsg = err instanceof Error ? err.message : String(err);

      // Personal key failed: only fall back to platform key if user explicitly permitted it!
      if (isPersonalAttempt && isPersonalKeyFailure(err)) {
        void recordRoutedExecution({
          plan,
          usedConfig: activeCfg,
          startMs,
          success: false,
          errorMsg: errMsg,
        });
        if (plan.allowFallbackOnError && plan.fallbacks.length > 0) {
          continue;
        }
        throw new RoutedAiError(
          `Your personal ${activeCfg.provider} API key failed (${errMsg}). Would you like to switch to the platform shared key in Settings?`,
          "PERSONAL_KEY_FAILED",
          400,
          { canFallbackToPlatform: true },
        );
      }

      if (i < candidates.length - 1 && isRetryableProviderFailure(err)) {
        continue;
      }

      void recordRoutedExecution({
        plan,
        usedConfig: activeCfg,
        startMs,
        success: false,
        errorMsg: errMsg,
      });
      throw err;
    }
  }

  throw lastError ?? new Error("All configured AI providers failed.");
}

export function getActiveAiConfig(): AiConfig | null {
  return storage.getStore() ?? null;
}

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
 * Server-side routed AI resolution:
 * Keys NEVER come from client headers or localStorage. Instead, the server
 * checks the user's encrypted BYOK vault or the admin-managed platform vault,
 * enforces quotas & enabled-model policies, and binds fallbacks + telemetry.
 */
export async function resolveAiConfigForRequest(req: NextRequest): Promise<AiConfig | null> {
  const user = await verifyRequest(req);
  const plan = await resolveRoutedAiPlan({ req, user });
  const resolvedPrimary = await resolveProviderModel(plan.primary);
  plan.primary = resolvedPrimary;
  planMap.set(resolvedPrimary, plan);
  return resolvedPrimary;
}
