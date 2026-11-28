/**
 * One place for every LLM request budget: input-token estimation, tight
 * per-provider input caps (ITPM), interactive time budgets and the feature
 * classes that must never carry a long reasoning tail.
 *
 * These are deliberately pure functions so the routing decisions can be unit
 * tested without touching a provider.
 */

import type { GatewayProviderId } from "./types";

/** ~4 characters per token is close enough for a pre-flight size check. */
export function estimateTokens(text: string): number {
  return Math.ceil((text ?? "").trim().length / 4);
}

export function estimateJsonTokens(value: unknown): number {
  if (value === undefined || value === null) return 0;
  try {
    return estimateTokens(JSON.stringify(value));
  } catch {
    return 0;
  }
}

export interface InputBudgetRequest {
  systemPrompt?: string;
  messages?: { content: unknown }[];
  agentContents?: unknown;
  schema?: unknown;
  tools?: unknown;
}

/**
 * Estimated input tokens for a whole request. Slightly generous: the goal is
 * to skip a model *before* a provider rejects the payload with 413/ITPM.
 */
export function estimateRequestInputTokens(req: InputBudgetRequest): number {
  let total = estimateTokens(req.systemPrompt ?? "");
  for (const message of req.messages ?? []) {
    total += typeof message.content === "string" ? estimateTokens(message.content) : estimateJsonTokens(message.content);
  }
  total += estimateJsonTokens(req.agentContents);
  total += estimateJsonTokens(req.schema);
  total += estimateJsonTokens(req.tools);
  return total;
}

/**
 * Safe input-token ceilings for free tiers with a low input-tokens-per-minute
 * allowance. A `null` cap means "use the context window instead".
 */
const MODEL_INPUT_CAPS: { pattern: RegExp; cap: number }[] = [
  { pattern: /qwen\/qwen3|qwen3-32b|qwen3\.8/i, cap: 5_500 },
  { pattern: /gpt-oss-120b/i, cap: 6_500 },
  { pattern: /gpt-oss-20b/i, cap: 5_000 },
  { pattern: /@cf\//i, cap: 6_000 },
  { pattern: /glm-4(?:\.5)?-flash|glm-4-32b/i, cap: 8_000 },
  { pattern: /llama-3\.1-8b|llama3\.1-8b/i, cap: 7_000 },
];

export function getModelInputTokenCap(provider: GatewayProviderId, modelId: string): number | null {
  const clean = modelId.trim();
  for (const { pattern, cap } of MODEL_INPUT_CAPS) {
    if (pattern.test(clean)) return cap;
  }
  // Cloudflare's free neurons are the tightest non-model-specific bucket.
  if (provider === "cloudflare") return 6_000;
  return null;
}

/** The effective input cap for a model, honouring an explicit saved value. */
export function resolveInputTokenCap(
  provider: GatewayProviderId,
  modelId: string,
  explicit?: number | null,
): number | null {
  if (typeof explicit === "number" && explicit > 0) return explicit;
  return getModelInputTokenCap(provider, modelId);
}

/**
 * Provider wording for "you sent more input than this tier allows". These are
 * request-shape errors: skip the model for this request, never bench the key.
 */
export const ITPM_ERROR_PATTERN =
  /request too large|itpm|input tokens per minute|tokens per minute|context[^\n]*limit|token limit|reduce your message size|maximum context/i;

export function isInputLimitErrorMessage(message: string, status?: number): boolean {
  if (status === 413) return true;
  return ITPM_ERROR_PATTERN.test(message ?? "");
}

// ---------------------------------------------------------------------------
// Time budgets
// ---------------------------------------------------------------------------

export interface BudgetProfile {
  wallMs: number;
  attemptMs: number;
  maxAttempts: number;
}

const INTERACTIVE_BUDGET: BudgetProfile = { wallMs: 20_000, attemptMs: 6_000, maxAttempts: 4 };
const DRAFTING_BUDGET: BudgetProfile = { wallMs: 32_000, attemptMs: 9_000, maxAttempts: 6 };
const DEFAULT_BUDGET: BudgetProfile = { wallMs: 42_000, attemptMs: 10_000, maxAttempts: 8 };

export function isInteractiveFeature(feature?: string): boolean {
  if (!feature) return false;
  return (
    feature === "operator_chat" ||
    feature === "operator_chat_fast" ||
    feature === "chat" ||
    feature === "dashboard_chat" ||
    feature === "refine" ||
    feature === "review_rewrite" ||
    feature.startsWith("review_rewrite")
  );
}

export function isDraftingFeature(feature?: string): boolean {
  if (!feature) return false;
  return (
    feature.startsWith("compose") ||
    feature.startsWith("rewrite") ||
    feature.startsWith("email_rewrite") ||
    feature === "growth_advisor" ||
    feature === "growth_execute_score" ||
    feature === "research" ||
    feature === "research_chat"
  );
}

/** Turns that must answer in a couple of seconds, not forty. */
export function getBudgetProfile(feature?: string): BudgetProfile {
  if (isInteractiveFeature(feature)) return INTERACTIVE_BUDGET;
  if (isDraftingFeature(feature)) return DRAFTING_BUDGET;
  return DEFAULT_BUDGET;
}

/** Fast/chat seats never need a visible reasoning budget. */
export function shouldDisableThinking(feature: string | undefined, taskType: string): boolean {
  if (taskType === "fast") return true;
  if (isInteractiveFeature(feature)) return true;
  if (
    feature?.startsWith("compose") ||
    feature?.startsWith("rewrite") ||
    feature?.startsWith("email_rewrite")
  ) {
    return true;
  }
  return false;
}
