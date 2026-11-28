import type { GatewayProviderError } from "./providers";
import { resolveInputTokenCap } from "./budget";
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

/**
 * Hard ceiling on real upstream attempts per request. A skip (benched model,
 * exhausted key) must never consume budget, and a request must never burn
 * dozens of hops: 6 attempts is enough to cross every healthy provider.
 */
export const MAX_AUTO_ATTEMPTS = 6;

/**
 * Burst rate limits (RPM/TPM) clear on their own within a minute. Benching a
 * key for hours because of one burst 429 is what produced the observed
 * "5h left" spiral while the key still read RPM 0/15.
 */
const TRANSIENT_COOLDOWN_MS = 60_000;
const MIN_TRANSIENT_COOLDOWN_MS = 45_000;
const MAX_TRANSIENT_COOLDOWN_MS = 120_000;
/** A stall/timeout on one model: retry it in two minutes, keep the key healthy. */
const TRANSIENT_PAIR_COOLDOWN_MS = 2 * 60_000;
/** Only explicit daily/monthly exhaustion or an empty balance earns this. */
const DAILY_EXHAUSTION_COOLDOWN_MS = 24 * 60 * 60_000;

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
  latencyEwma.clear();
}

/**
 * Rolling latency per (key, model). A model that is healthy but consistently
 * slow must lose to a fast one, not keep winning on seat name alone.
 */
const latencyEwma = new Map<string, number>();

export function recordCandidateLatency(keyId: string, modelId: string, latencyMs: number): void {
  if (!Number.isFinite(latencyMs) || latencyMs <= 0) return;
  const signature = `${keyId}:${modelId}`;
  const previous = latencyEwma.get(signature);
  const next = previous === undefined ? latencyMs : previous * 0.7 + latencyMs * 0.3;
  latencyEwma.set(signature, Math.round(next));
}

export function getCandidateLatencyMs(keyId: string, modelId: string): number | null {
  return latencyEwma.get(`${keyId}:${modelId}`) ?? null;
}

export function clearAllInMemoryModelCooldowns(): void {
  keyModelCooldowns.clear();
  googleGroundingBlockedKeys.clear();
}

/**
 * Shortest remaining per-(key, model) cooldown, in milliseconds. The gateway
 * answers with one friendly "resets in ~Xs" message instead of firing a burst
 * of zero-millisecond failures while every key is briefly rate limited.
 */
export function getSoonestCooldownRemainingMs(now = Date.now()): number | null {
  let soonest: number | null = null;
  for (const entry of keyModelCooldowns.values()) {
    const left = entry.untilMs - now;
    if (left <= 0) continue;
    if (soonest === null || left < soonest) soonest = left;
  }
  return soonest;
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
    const ms = TRANSIENT_PAIR_COOLDOWN_MS;
    keyModelCooldowns.set(`${key.id}:${modelId}`, {
      untilMs: now + ms,
      step: 1,
      reason: errSummary,
    });
    return { healthStatus: "healthy", cooldownMs: ms };
  }

  // A plain burst 429 (RPM/TPM, with no explicit daily or balance signal)
  // clears within a minute: cool ONLY this (key, model) pair briefly and keep
  // the key healthy. It must never write a multi-hour key-level cooldown.
  if (!err.creditsExhausted && !err.dailyQuotaExhausted) {
    const hint = err.retryAfterMs && err.retryAfterMs > 0 ? err.retryAfterMs : TRANSIENT_COOLDOWN_MS;
    const cooldownMs = Math.min(MAX_TRANSIENT_COOLDOWN_MS, Math.max(MIN_TRANSIENT_COOLDOWN_MS, hint));
    keyModelCooldowns.set(`${key.id}:${modelId}`, {
      untilMs: now + cooldownMs,
      step: 0,
      reason: errSummary,
    });
    return { healthStatus: "healthy", cooldownMs };
  }

  // Only an explicit daily/monthly exhaustion or an empty balance benches the
  // whole key, until its real reset window.
  const cooldownMs = DAILY_EXHAUSTION_COOLDOWN_MS;
  const untilIso = new Date(now + cooldownMs).toISOString();
  keyModelCooldowns.set(`${key.id}:${modelId}`, {
    untilMs: now + cooldownMs,
    step: 1,
    reason: errSummary,
  });

  // Escalate key-level DB cooldown strictly on explicit rate-limit / quota / credit exhaustion
  key.healthStatus = "cooldown";
  key.cooldownUntil = untilIso;
  key.cooldownStep = 1;
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
 * `allam-2-7b` (Arabic-only), Whisper/TTS audio models and Guard safety
 * classifiers are also non-chat and must never take a compose/chat seat.
 */
const NON_CHAT_MODEL_PATTERN =
  /(?:^|[-/])(?:image|imagen|nano-banana|tts|playai-tts|transcribe|whisper|embedding|robotics|computer-use|deep-research|antigravity|allam|guard|safeguard)(?:[-/]|$)/i;

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
  const isStructuredWorkflow =
    Boolean(input.requiresTools) ||
    input.feature === "operator_chat" ||
    Boolean(input.feature?.startsWith("growth_")) ||
    input.feature === "research" ||
    input.feature === "research_chat" ||
    input.feature === "qualify" ||
    Boolean(input.feature?.startsWith("compose"));
  const isGrowthOrOperator =
    Boolean(input.requiresTools) ||
    input.feature === "operator_chat" ||
    Boolean(input.feature?.startsWith("growth_")) ||
    Boolean(input.feature?.startsWith("compose")) ||
    input.feature === "research" ||
    input.feature === "research_chat" ||
    input.feature === "qualify";

  for (const key of input.keys) {
    if (!key.enabled || key.healthStatus === "invalid") continue;
    // Hard-exclude Cloudflare from tool-calling, operator_chat, Growth Advisor, research, and qualify
    if ((input.requiresTools || isGrowthOrOperator) && TOOL_UNSAFE_PROVIDERS.has(key.provider)) {
      continue;
    }
    const headroom = evaluateKeyHeadroom(key);
    if (!headroom.allowed) continue;

    for (const model of key.models) {
      if (!model.enabled) continue;
      if (/nemotron-3-ultra-550b|550b/i.test(model.id)) continue;
      // Specialised/audio/safety models are never valid chat candidates in any seat.
      if (!isChatCapableModelId(model.id)) continue;
      const slowMega = isSlowMegaModel(model.id);
      if (
        slowMega &&
        (input.taskType === "fast" ||
          input.taskType === "balanced" ||
          Boolean(input.requiresTools) ||
          Boolean(input.feature?.startsWith("compose")) ||
          input.feature === "research" ||
          input.feature === "operator_chat")
      ) {
        continue;
      }
      if (input.requiresTools && !model.capabilities.tools) continue;
      if (input.requiresTools && !isChatCapableModelId(model.id)) continue;
      // Hard-exclude tiny <= 8B models from tool-calling, operator_chat, research, and Growth Advisor smart/balanced seats
      if (
        (input.requiresTools || (isStructuredWorkflow && input.taskType !== "fast")) &&
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
        // Free-tier Input-Tokens-Per-Minute caps (Groq Qwen/GPT-OSS, CF): skip
        // the model before the call instead of eating a 413 and a cooldown.
        const inputCap = resolveInputTokenCap(key.provider, model.id, model.maxInputTokens);
        if (inputCap && input.estimatedTokens > inputCap) {
          continue;
        }
      }

      let score = 0;

      // 1. Headroom steering: healthy headroom strictly outranks keys >= 85% cap
      score += headroom.lowHeadroom ? -200 : 120 - Math.round(headroom.utilization * 40);

      // 2. Strongly demote slow 400B-550B+ preview models & thinking queues on interactive/compose paths
      if (slowMega) {
        score -= isGrowthOrOperator ? 600 : input.taskType === "smart" ? 180 : 320;
      } else if (FAST_RESPONSIVE_MODEL_RE.test(model.id)) {
        score += input.taskType === "fast" ? 85 : 75;
      }
      if (key.provider === "groq" || key.provider === "google") {
        if (!model.capabilities.reasoning && /(flash\b|llama-3\.3-70b|llama-3\.1-8b)/i.test(model.id)) {
          score += 50;
        }
      }
      if (model.capabilities.reasoning && (input.taskType === "fast" || Boolean(input.feature?.startsWith("compose")))) {
        score -= 80;
      }

      // 3. Native Google Search grounding priority only when key has not rejected free-tier grounding
      if (input.requiresGrounding) {
        if (key.provider === "google" && model.capabilities.grounding && !isGoogleGroundingBlocked(key.id)) {
          score += 500;
        }
      }

      // 3b. Observed latency: a genuinely fast healthy model outranks a slow one.
      const observedLatency = latencyEwma.get(`${key.id}:${model.id}`);
      if (observedLatency) {
        const divisor = input.taskType === "fast" ? 60 : 150;
        score -= Math.min(90, Math.round(observedLatency / divisor));
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
