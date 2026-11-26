import type { NextRequest } from "next/server";
import { getProvider } from "../ai/registry";
import type { AiConfig, AiProviderId } from "../ai/types";
import { AuthError, type AuthUser } from "../server-auth";
import {
  decryptPlatformProviderKey,
  decryptUserProviderKey,
  estimateUsageCostUsd,
  getInternalPlatformPolicy,
  getUserByokVault,
  getUserGovernance,
  getUserUsageStatsSummary,
  listAiUsageEvents,
  recordAiUsageEvent,
  touchUserLastActive,
  type InternalPlatformPolicy,
} from "./store-server";
import type { AiFeatureKey } from "./types";

export class RoutedAiError extends AuthError {
  code: string;
  canUseOwnKey?: boolean;
  canFallbackToPlatform?: boolean;
  constructor(
    message: string,
    code: string,
    status = 429,
    extra?: { canUseOwnKey?: boolean; canFallbackToPlatform?: boolean },
  ) {
    super(message, status);
    this.code = code;
    this.canUseOwnKey = extra?.canUseOwnKey;
    this.canFallbackToPlatform = extra?.canFallbackToPlatform;
  }
}

export interface ResolvedAiPlan {
  primary: AiConfig;
  fallbacks: AiConfig[];
  source: "platform" | "personal";
  feature: AiFeatureKey;
  allowFallbackOnError: boolean;
  user: AuthUser;
  policy: InternalPlatformPolicy;
}

const rateLimitHits = new Map<string, number[]>();

function checkUserRateLimit(ownerId: string, limitPerMinute: number): void {
  const now = Date.now();
  const recent = (rateLimitHits.get(ownerId) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= limitPerMinute) {
    throw new RoutedAiError(
      `Rate limit reached (${limitPerMinute} platform AI requests/minute). Wait a moment or switch to your own API key in Settings.`,
      "PLATFORM_RATE_LIMITED",
      429,
      { canUseOwnKey: true },
    );
  }
  recent.push(now);
  rateLimitHits.set(ownerId, recent);
}

export function inferFeatureFromPath(pathname: string): AiFeatureKey {
  if (pathname.includes("/analytics")) return "analytics";
  if (pathname.includes("/growth-")) return "growth_advisor";
  if (pathname.includes("/research-chat")) return "ask_ai";
  if (pathname.includes("/discover") || pathname.includes("/research") || pathname.includes("/qualify") || pathname.includes("/criteria")) {
    return "research";
  }
  if (pathname.includes("/onboarding")) return "knowledge_base";
  if (pathname.includes("/compose") || pathname.includes("/refine") || pathname.includes("/subject") || pathname.includes("/analyse-reply") || pathname.includes("/plan")) {
    return "email_compose";
  }
  return "operator_chat";
}

function isModelAllowedOnPlatform(
  policy: InternalPlatformPolicy,
  providerId: AiProviderId,
  modelId: string,
): boolean {
  const p = policy.providers.find((x) => x.id === providerId);
  if (!p || !p.enabled) return false;
  const key = decryptPlatformProviderKey(policy, providerId);
  if (!key) return false;
  if (!p.models || p.models.length === 0) return true;
  const m = p.models.find((mod) => mod.id === modelId);
  return Boolean(m && m.enabled);
}

function buildConfigForPlatform(
  policy: InternalPlatformPolicy,
  providerId: AiProviderId,
  modelId: string,
): AiConfig | null {
  const apiKey = decryptPlatformProviderKey(policy, providerId);
  if (!apiKey) return null;
  const meta = getProvider(providerId);
  const prov = policy.providers.find((p) => p.id === providerId);
  const baseUrl = prov?.baseUrl || meta?.baseUrl;
  return {
    provider: providerId,
    model: modelId || meta?.defaultModel || "gemini-2.5-flash",
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
  };
}

export async function resolveRoutedAiPlan(input: {
  req: NextRequest;
  user: AuthUser;
  feature?: AiFeatureKey;
  requestedModel?: string;
}): Promise<ResolvedAiPlan> {
  const feature = input.feature ?? inferFeatureFromPath(input.req.nextUrl.pathname);

  const [meta, vault, policy] = await Promise.all([
    getUserGovernance(input.user.ownerId, input.user.email, {
      name: input.user.name,
      avatarUrl: input.user.avatarUrl,
    }),
    getUserByokVault(input.user.ownerId),
    getInternalPlatformPolicy(),
  ]);

  if (meta.status === "suspended") {
    throw new AuthError("Your account has been suspended by an administrator.", 403);
  }

  void touchUserLastActive(input.user.ownerId, input.user.email).catch(() => {});

  // 1. Personal BYOK Routing (does NOT count against platform quotas!)
  if (vault.mode === "personal") {
    const chosen =
      vault.providers.find((p) => p.id === vault.activePersonalProviderId) ?? vault.providers[0];
    const personalKey = decryptUserProviderKey(chosen);

    if (!chosen || !personalKey) {
      throw new RoutedAiError(
        "Your AI Provider setting is set to 'Use my own API key', but no personal key is saved. Add a key or switch to platform models in Settings.",
        "PERSONAL_KEY_MISSING",
        400,
        { canFallbackToPlatform: true },
      );
    }

    const provMeta = getProvider(chosen.provider);
    const primary: AiConfig = {
      provider: chosen.provider,
      model: input.requestedModel?.trim() || chosen.model || provMeta?.defaultModel || "gemini-2.5-flash",
      apiKey: personalKey,
      ...(chosen.baseUrl ? { baseUrl: chosen.baseUrl } : {}),
    };

    const fallbacks: AiConfig[] = [];
    if (vault.allowFallbackOnError) {
      for (const fb of policy.fallbackChain) {
        if (isModelAllowedOnPlatform(policy, fb.provider, fb.model)) {
          const cfg = buildConfigForPlatform(policy, fb.provider, fb.model);
          if (cfg) fallbacks.push(cfg);
        }
      }
    }

    return {
      primary,
      fallbacks,
      source: "personal",
      feature,
      allowFallbackOnError: vault.allowFallbackOnError,
      user: input.user,
      policy,
    };
  }

  // 2. Platform Shared Key & Model Routing
  const quotas = { ...policy.quotas, ...(meta.quotaOverride ?? {}) };
  checkUserRateLimit(input.user.ownerId, quotas.rateLimitPerMinute);

  const usageStats = await getUserUsageStatsSummary(input.user.ownerId, meta, policy);
  if (usageStats.platformRequestsToday >= quotas.dailyRequestsPerUser) {
    throw new RoutedAiError(
      `Daily platform AI limit reached (${usageStats.platformRequestsToday}/${quotas.dailyRequestsPerUser} requests). You can continue immediately by adding your own API key in Settings.`,
      "PLATFORM_QUOTA_EXCEEDED",
      429,
      { canUseOwnKey: true },
    );
  }
  if (usageStats.platformRequestsMonth >= quotas.monthlyRequestsPerUser) {
    throw new RoutedAiError(
      `Monthly platform AI limit reached (${usageStats.platformRequestsMonth}/${quotas.monthlyRequestsPerUser} requests). Add your own API key in Settings for unlimited personal usage.`,
      "PLATFORM_QUOTA_EXCEEDED",
      429,
      { canUseOwnKey: true },
    );
  }

  // Global monthly spend cap check
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
  const allMonthEvents = await listAiUsageEvents({ sinceIso: monthStart, limit: 3000 });
  const totalPlatformSpendUsd = allMonthEvents
    .filter((e) => e.source === "platform")
    .reduce((sum, e) => sum + e.costUsd, 0);

  if (quotas.monthlySpendCapUsd > 0 && totalPlatformSpendUsd >= quotas.monthlySpendCapUsd) {
    throw new RoutedAiError(
      "The platform monthly AI spend cap has been reached. You can still run AI features using your own API key in Settings.",
      "PLATFORM_SPEND_CAP_REACHED",
      429,
      { canUseOwnKey: true },
    );
  }

  // Determine model: respect user's platform model preference ONLY if admin enabled it;
  // otherwise use admin's feature default, or first enabled platform model.
  let chosenProvider: AiProviderId = policy.featureDefaults[feature]?.provider ?? "gemini";
  let chosenModel: string = policy.featureDefaults[feature]?.model ?? "gemini-2.5-flash";

  if (
    vault.selectedPlatformModel &&
    isModelAllowedOnPlatform(policy, vault.selectedPlatformModel.provider, vault.selectedPlatformModel.model)
  ) {
    chosenProvider = vault.selectedPlatformModel.provider;
    chosenModel = vault.selectedPlatformModel.model;
  }

  if (!isModelAllowedOnPlatform(policy, chosenProvider, chosenModel)) {
    // Pick the first enabled model with a valid key
    let found = false;
    for (const p of policy.providers) {
      if (!p.enabled) continue;
      if (!decryptPlatformProviderKey(policy, p.id)) continue;
      const enabledMod = p.models.find((m) => m.enabled);
      if (enabledMod) {
        chosenProvider = p.id;
        chosenModel = enabledMod.id;
        found = true;
        break;
      }
    }
    if (!found) {
      throw new RoutedAiError(
        "No active platform AI provider key is configured by the administrator yet. Ask an admin to add a platform key, or add your own API key in Settings.",
        "PLATFORM_NO_PROVIDER",
        503,
        { canUseOwnKey: true },
      );
    }
  }

  const primary = buildConfigForPlatform(policy, chosenProvider, chosenModel);
  if (!primary) {
    throw new RoutedAiError(
      "The configured platform provider key could not be decrypted. Contact an administrator or switch to your own API key.",
      "PLATFORM_KEY_UNAVAILABLE",
      503,
      { canUseOwnKey: true },
    );
  }

  const fallbacks: AiConfig[] = [];
  for (const fb of policy.fallbackChain) {
    if (fb.provider === primary.provider && fb.model === primary.model) continue;
    if (isModelAllowedOnPlatform(policy, fb.provider, fb.model)) {
      const cfg = buildConfigForPlatform(policy, fb.provider, fb.model);
      if (cfg) fallbacks.push(cfg);
    }
  }

  return {
    primary,
    fallbacks,
    source: "platform",
    feature,
    allowFallbackOnError: vault.allowFallbackOnError,
    user: input.user,
    policy,
  };
}

export async function recordRoutedExecution(input: {
  plan: ResolvedAiPlan;
  usedConfig: AiConfig;
  startMs: number;
  success: boolean;
  errorMsg?: string;
  estimatedTokensIn?: number;
  estimatedTokensOut?: number;
}): Promise<void> {
  const latencyMs = Math.max(1, Date.now() - input.startMs);
  const tokensIn = input.estimatedTokensIn ?? 900;
  const tokensOut = input.estimatedTokensOut ?? 450;
  const costUsd = estimateUsageCostUsd(
    input.plan.policy,
    input.usedConfig.provider,
    input.usedConfig.model,
    tokensIn,
    tokensOut,
  );

  await recordAiUsageEvent({
    ownerId: input.plan.user.ownerId,
    userEmail: input.plan.user.email,
    feature: input.plan.feature,
    provider: input.usedConfig.provider,
    model: input.usedConfig.model,
    source: input.plan.source,
    tokensIn,
    tokensOut,
    costUsd,
    latencyMs,
    success: input.success,
    errorMsg: input.errorMsg,
  }).catch(() => {});
}
