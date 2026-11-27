import type { GatewayProviderError } from "./providers";
import { persistAdminKeyHealth } from "./store";
import {
  getModelContextWindow,
  isSlowMegaModel,
  isTinyModelId,
  type AdminAiKeyRecord,
  type AdminAiSettings,
  type GatewayModelConfig,
  type KeyHealthStatus,
  type RoutingStrategy,
  type TaskSeat,
} from "./types";

const ESCALATION_LADDER_MS = [
  2 * 60_000, // 2 minutes
  10 * 60_000, // 10 minutes
  60 * 60_000, // 1 hour
  24 * 60 * 60_000, // 24 hours
];

const HEADROOM_STEER_THRESHOLD = 0.85; // Proactively steer away once key hits >= 85% of RPM or RPD

// Rolling in-memory RPM (timestamps within last 60s) & RPD (UTC YYYY-MM-DD counts) per key_id
const rpmEvents = new Map<string, number[]>();
const rpdCounters = new Map<string, { day: string; count: number }>();

// Per-(keyId:modelId) transient cooldowns + key-wide status synced from/to DB
const keyModelCooldowns = new Map<string, { untilMs: number; step: number; reason: string }>();
// Track Google keys whose free-tier rejected native googleSearch grounding
const googleGroundingBlockedKeys = new Map<string, number>();

export function markGoogleGroundingBlocked(keyId: string, ttlMs = 60 * 60_000): void {
  googleGroundingBlockedKeys.set(keyId, Date.now() + ttlMs);
}

export function isGoogleGroundingBlocked(keyId: string): boolean {
  const exp = googleGroundingBlockedKeys.get(keyId);
  if (!exp) return false;
  if (Date.now() > exp) {
    googleGroundingBlockedKeys.delete(keyId);
    return false;
  }
  return true;
}

function currentUtcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getKeyUsageStats(keyId: string): { rpmUsed: number; rpdUsed: number } {
  const now = Date.now();
  const minuteAgo = now - 60_000;
  const recent = (rpmEvents.get(keyId) ?? []).filter((ts) => ts > minuteAgo);
  rpmEvents.set(keyId, recent);

  const day = currentUtcDay();
  const rpd = rpdCounters.get(keyId);
  const rpdUsed = rpd && rpd.day === day ? rpd.count : 0;

  return { rpmUsed: recent.length, rpdUsed };
}

export function recordKeyUsageHit(keyId: string): void {
  const now = Date.now();
  const minuteAgo = now - 60_000;
  const recent = (rpmEvents.get(keyId) ?? []).filter((ts) => ts > minuteAgo);
  recent.push(now);
  rpmEvents.set(keyId, recent);

  const day = currentUtcDay();
  const prev = rpdCounters.get(keyId);
  if (prev && prev.day === day) {
    prev.count += 1;
  } else {
    rpdCounters.set(keyId, { day, count: 1 });
  }
}

export function evaluateKeyHeadroom(key: Pick<AdminAiKeyRecord, "id" | "rpmLimit" | "rpdLimit">): {
  allowed: boolean;
  lowHeadroom: boolean;
  utilization: number;
  rpmUsed: number;
  rpdUsed: number;
} {
  const { rpmUsed, rpdUsed } = getKeyUsageStats(key.id);
  const rpmLimit = Math.max(1, key.rpmLimit || 15);
  const rpdLimit = Math.max(1, key.rpdLimit || 1000);

  const rpmRatio = rpmUsed / rpmLimit;
  const rpdRatio = rpdUsed / rpdLimit;
  const utilization = Math.max(rpmRatio, rpdRatio);

  return {
    allowed: rpmRatio < 1 && rpdRatio < 1,
    lowHeadroom: utilization >= HEADROOM_STEER_THRESHOLD,
    utilization,
    rpmUsed,
    rpdUsed,
  };
}

export function clearRouterStateForTests(): void {
  rpmEvents.clear();
  rpdCounters.clear();
  keyModelCooldowns.clear();
  googleGroundingBlockedKeys.clear();
}

export function clearAllInMemoryModelCooldowns(): void {
  keyModelCooldowns.clear();
  googleGroundingBlockedKeys.clear();
}

export function isCandidateCoolingDown(key: AdminAiKeyRecord, modelId: string, now = Date.now()): boolean {
  if (!key.enabled) return true;
  if (key.healthStatus === "invalid") return true;

  if (key.healthStatus === "cooldown" && key.cooldownUntil) {
    const dbUntil = Date.parse(key.cooldownUntil);
    if (!Number.isNaN(dbUntil) && dbUntil > now) return true;
  }

  const pair = keyModelCooldowns.get(`${key.id}:${modelId}`);
  if (pair && pair.untilMs > now) return true;

  return false;
}

export function recordCandidateSuccess(key: AdminAiKeyRecord, modelId: string): void {
  keyModelCooldowns.delete(`${key.id}:${modelId}`);
  if (key.healthStatus !== "healthy" || key.cooldownStep > 0 || key.cooldownUntil) {
    key.healthStatus = "healthy";
    key.cooldownUntil = null;
    key.cooldownStep = 0;
    key.lastError = null;
    void persistAdminKeyHealth(key.id, {
      healthStatus: "healthy",
      cooldownUntil: null,
      cooldownStep: 0,
      lastError: null,
    }).catch(() => {});
  }
}

export function recordCandidateFailure(
  key: AdminAiKeyRecord,
  modelId: string,
  err: GatewayProviderError,
  now = Date.now(),
): { healthStatus: KeyHealthStatus; cooldownMs: number } {
  const errSummary = `${err.status}: ${err.message}`.slice(0, 260);

  // 401/403 -> key itself is invalid/rejected -> bench across the platform
  if (err.authFailed) {
    key.healthStatus = "invalid";
    key.lastError = errSummary;
    key.cooldownUntil = null;
    void persistAdminKeyHealth(key.id, {
      healthStatus: "invalid",
      cooldownUntil: null,
      cooldownStep: key.cooldownStep,
      lastError: errSummary,
    }).catch(() => {});
    return { healthStatus: "invalid", cooldownMs: 0 };
  }

  // HTTP 400 / 413 / 422 / missing / unsupported request shapes (context overflow, tools refused):
  // strictly per-(key, model) temporary skip — NEVER bench the entire API key in DB!
  if (err.modelNotFound || err.modelUnsupported || err.status === 400 || err.status === 413 || err.status === 422) {
    const ms = err.modelNotFound ? 60 * 60_000 : 10 * 60_000;
    keyModelCooldowns.set(`${key.id}:${modelId}`, {
      untilMs: now + ms,
      step: 1,
      reason: errSummary,
    });
    return { healthStatus: "healthy", cooldownMs: 0 };
  }

  // Timeout (504) or upstream 5xx (502/503): cool down ONLY this specific (key, model) pair for 2m.
  // Never bench the provider's other healthy models!
  if (!err.rateLimited && !err.creditsExhausted && !err.dailyQuotaExhausted) {
    const ms = ESCALATION_LADDER_MS[0]; // 2m per-model cooldown
    keyModelCooldowns.set(`${key.id}:${modelId}`, {
      untilMs: now + ms,
      step: 1,
      reason: errSummary,
    });
    return { healthStatus: "healthy", cooldownMs: ms };
  }

  // Compute escalating cooldown step (2m -> 10m -> 1h -> 24h) strictly for real rate/quota 429/402
  const prevStep = keyModelCooldowns.get(`${key.id}:${modelId}`)?.step ?? key.cooldownStep ?? 0;
  const nextStep = Math.min(ESCALATION_LADDER_MS.length - 1, prevStep);
  let cooldownMs = ESCALATION_LADDER_MS[nextStep];

  if (err.creditsExhausted || err.dailyQuotaExhausted) {
    cooldownMs = ESCALATION_LADDER_MS[3]; // 24h bench
  }
  if (err.retryAfterMs && err.retryAfterMs > 0) {
    cooldownMs = Math.max(cooldownMs, err.retryAfterMs);
  }

  const untilIso = new Date(now + cooldownMs).toISOString();
  keyModelCooldowns.set(`${key.id}:${modelId}`, {
    untilMs: now + cooldownMs,
    step: Math.min(ESCALATION_LADDER_MS.length - 1, nextStep + 1),
    reason: errSummary,
  });

  // Escalate key-level DB cooldown strictly on explicit rate-limit / quota / credit exhaustion
  key.healthStatus = "cooldown";
  key.cooldownUntil = untilIso;
  key.cooldownStep = Math.min(ESCALATION_LADDER_MS.length - 1, nextStep + 1);
  key.lastError = errSummary;
  void persistAdminKeyHealth(key.id, {
    healthStatus: "cooldown",
    cooldownUntil: untilIso,
    cooldownStep: key.cooldownStep,
    lastError: errSummary,
  }).catch(() => {});

  return { healthStatus: "cooldown", cooldownMs };
}

// ---------------------------------------------------------------------------
// Candidate Pool Ranking (Headroom + Task Seat + Strategy)
// ---------------------------------------------------------------------------

export interface RankedPoolCandidate {
  key: AdminAiKeyRecord;
  model: GatewayModelConfig;
  lowHeadroom: boolean;
  utilization: number;
  score: number;
}

/**
 * Catalog endpoints list media and specialist models next to chat models. They
 * are saved as "enabled" but reject tools/multi-turn chat, so routing an agent
 * request to them wastes a failover hop (and used to abort the whole pool).
 */
const NON_CHAT_MODEL_PATTERN =
  /(?:^|[-/])(?:image|imagen|nano-banana|tts|transcribe|embedding|robotics|computer-use|deep-research|antigravity)(?:[-/]|$)/i;

export function isChatCapableModelId(modelId: string): boolean {
  return !NON_CHAT_MODEL_PATTERN.test(modelId.trim());
}

/**
 * Providers whose endpoint rejects the OpenAI tool-calling payload we send.
 * They stay in the pool for plain text/JSON work but must never be chosen for
 * tool-using agent turns (Cloudflare Workers AI answers "invalid extraction
 * request" for that shape).
 */
const TOOL_UNSAFE_PROVIDERS = new Set(["cloudflare"]);

const FAST_PROVIDERS = new Set(["groq", "cerebras", "cloudflare", "google", "zai"]);
const SMART_PROVIDERS = new Set(["google", "nvidia", "anthropic", "openai", "openrouter", "zai"]);
const FAST_RESPONSIVE_MODEL_RE =
  /(flash\b|llama-3\.3-70b|llama-3\.1-8b|llama3\.1-8b|gpt-4o|claude-haiku|claude-sonnet|glm-4(?:\.5)?-flash|deepseek-chat|deepseek-v3|qwen-?2\.5-72b)/i;

export function rankPoolCandidates(input: {
  keys: AdminAiKeyRecord[];
  settings: AdminAiSettings;
  taskType: TaskSeat;
  requiresTools?: boolean;
  requiresVision?: boolean;
  requiresGrounding?: boolean;
  estimatedTokens?: number;
  feature?: string;
  now?: number;
}): RankedPoolCandidate[] {
  const now = input.now ?? Date.now();
  const candidates: RankedPoolCandidate[] = [];
  const isGrowthOrOperator =
    Boolean(input.requiresTools) ||
    input.feature === "operator_chat" ||
    Boolean(input.feature?.startsWith("growth_"));

  for (const key of input.keys) {
    if (!key.enabled || key.healthStatus === "invalid") continue;
    // Hard-exclude Cloudflare from tool-calling, operator_chat, and Growth Advisor
    if ((input.requiresTools || isGrowthOrOperator) && TOOL_UNSAFE_PROVIDERS.has(key.provider)) {
      continue;
    }
    const headroom = evaluateKeyHeadroom(key);
    if (!headroom.allowed) continue;

    for (const model of key.models) {
      if (!model.enabled) continue;
      if (input.requiresTools && !model.capabilities.tools) continue;
      if (input.requiresTools && !isChatCapableModelId(model.id)) continue;
      // Hard-exclude tiny <= 8B models from tool-calling, operator_chat, and Growth Advisor smart/balanced seats
      if (
        (input.requiresTools || (isGrowthOrOperator && input.taskType !== "fast")) &&
        isTinyModelId(model.id)
      ) {
        continue;
      }
      if (input.requiresVision && !model.capabilities.vision) continue;
      if (isCandidateCoolingDown(key, model.id, now)) continue;

      // Pre-flight context window safety check (never send oversized requests to Cloudflare/small-context models)
      if (input.estimatedTokens && input.estimatedTokens > 0) {
        const ctxWindow = model.contextWindow ?? getModelContextWindow(key.provider, model.id);
        if (input.estimatedTokens > ctxWindow * 0.85) {
          continue;
        }
      }

      let score = 0;
      const slowMega = isSlowMegaModel(model.id);

      // 1. Headroom steering: healthy headroom strictly outranks keys >= 85% cap
      score += headroom.lowHeadroom ? -200 : 120 - Math.round(headroom.utilization * 40);

      // 2. Strongly demote slow 400B-550B+ preview models so responsive models ALWAYS run first
      if (slowMega) {
        score -= isGrowthOrOperator ? 600 : input.taskType === "smart" ? 180 : 320;
      } else if (FAST_RESPONSIVE_MODEL_RE.test(model.id)) {
        score += input.taskType === "fast" ? 55 : 45;
      }

      // 3. Native Google Search grounding priority only when key has not rejected free-tier grounding
      if (input.requiresGrounding) {
        if (key.provider === "google" && model.capabilities.grounding && !isGoogleGroundingBlocked(key.id)) {
          score += 500;
        }
      }

      // 4. Task-seat alignment (smart / balanced / fast)
      if (model.seats.includes(input.taskType)) {
        score += 90;
        if (model.seats[0] === input.taskType) score += 25;
      }

      // 5. Strategy weights
      const strat: RoutingStrategy = input.settings.strategy;
      if (strat === "smartest") {
        if (model.seats.includes("smart")) score += 60;
        if (model.capabilities.reasoning && !slowMega) score += 25;
        if (SMART_PROVIDERS.has(key.provider)) score += 15;
      } else if (strat === "fastest") {
        if (model.seats.includes("fast")) score += 60;
        if (FAST_PROVIDERS.has(key.provider)) score += 45;
      } else if (strat === "reliable") {
        score += Math.max(0, 60 - key.cooldownStep * 25);
        if (!model.capabilities.reasoning) score += 10; // non-thinking models have lower empty-stream rate
      } else {
        // balanced
        score += Math.max(0, 35 - key.cooldownStep * 15);
        if (model.seats.includes(input.taskType)) score += 20;
        if (FAST_PROVIDERS.has(key.provider)) score += 20;
      }

      // 5. Explicit Admin fallbackChain boost when defined
      const chainIdx = input.settings.fallbackChain.findIndex(
        (c) => c.provider === key.provider && c.model === model.id,
      );
      if (chainIdx >= 0) {
        score += Math.max(10, 75 - chainIdx * 8);
      }

      candidates.push({
        key,
        model,
        lowHeadroom: headroom.lowHeadroom,
        utilization: headroom.utilization,
        score,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}
