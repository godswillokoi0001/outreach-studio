import type { SearchQuotaRecord } from "@/lib/search/quotaAndCache";
import {
  KEYLESS_PROVIDERS,
  SEARCH_PROVIDER_CATALOG,
  normalizeSearchProviderId,
  type AdminSearchKeyPublic,
  type SearchProviderId,
  type SearchProviderState,
  type SearchProviderStateStatus,
} from "@/lib/llm/types";

/**
 * Status for a keyed provider. The order matters: a provider with no saved key
 * must never borrow the quota record's "healthy" badge, and a paused key must
 * never look active. Exhausted/invalid states only apply to real keys.
 */
export function computeSearchProviderStatus(input: {
  keyless?: boolean;
  hasKey: boolean;
  enabled: boolean;
  healthStatus?: "healthy" | "cooldown" | "invalid" | null;
  quotaStatus?: "healthy" | "near_limit" | "exhausted" | "keyless" | null;
}): SearchProviderStateStatus {
  if (input.keyless) return "keyless";
  if (!input.hasKey) return "not_configured";
  if (input.healthStatus === "invalid") return "invalid";
  if (!input.enabled) return "paused";
  if (input.healthStatus === "cooldown") return "cooldown";
  if (input.quotaStatus === "exhausted") return "exhausted";
  if (input.quotaStatus === "near_limit") return "near_limit";
  return "active";
}

/** True only when a keyed provider may actually be called right now. */
export function isSearchProviderSelectable(status: SearchProviderStateStatus): boolean {
  return status === "active" || status === "near_limit";
}

function nextResetIso(rec: Pick<SearchQuotaRecord, "resetCycle" | "lastResetAt">): string | null {
  if (rec.resetCycle === "keyless" || rec.resetCycle === "one_time") return null;
  const last = Date.parse(rec.lastResetAt);
  const base = Number.isNaN(last) ? new Date() : new Date(last);
  if (rec.resetCycle === "monthly") {
    return new Date(
      Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1, 0, 0, 0, 0),
    ).toISOString();
  }
  return new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + 1, 0, 0, 0, 0),
  ).toISOString();
}

/**
 * Builds one row per catalog provider plus the keyless built-ins. Every card in
 * the admin command center is rendered from this list, so a provider that has
 * no saved key always reports `not_configured` instead of a fake quota status.
 */
export function buildSearchProviderStates(input: {
  keys: AdminSearchKeyPublic[];
  quotas: SearchQuotaRecord[];
}): SearchProviderState[] {
  const quotaByProvider = new Map(input.quotas.map((q) => [q.provider as string, q]));

  const keyed = SEARCH_PROVIDER_CATALOG.map((meta) => {
    // Legacy rows could be stored under an alias ("google_pagespeed"); treat
    // them as the canonical provider so a saved key is never "Not Configured".
    const keysForProvider = input.keys.filter(
      (k) => (normalizeSearchProviderId(k.provider) ?? k.provider) === meta.id,
    );
    const activeKey =
      keysForProvider.find((k) => k.enabled) ??
      keysForProvider.find((k) => k.healthStatus !== "invalid") ??
      keysForProvider[0] ??
      null;
    const quota = quotaByProvider.get(meta.id);
    const status = computeSearchProviderStatus({
      hasKey: keysForProvider.length > 0,
      enabled: Boolean(activeKey?.enabled),
      healthStatus: activeKey?.healthStatus ?? null,
      quotaStatus: quota?.status ?? null,
    });

    return {
      provider: meta.id as SearchProviderId,
      label: meta.label,
      category: meta.category,
      kind: meta.kind,
      status,
      hasKey: keysForProvider.length > 0,
      enabled: Boolean(activeKey?.enabled),
      keyId: activeKey?.id ?? null,
      maskedKey: activeKey?.maskedKey ?? null,
      docsUrl: meta.docsUrl,
      blurb: meta.blurb,
      freeTierNote: meta.freeTierNote,
      requiresCard: meta.requiresCard,
      dualField: meta.dualField ?? null,
      healthStatus: activeKey?.healthStatus ?? null,
      lastError: activeKey?.lastError ?? null,
      quota: {
        used: quota?.usedCount ?? 0,
        limit: quota?.quotaLimit ?? meta.defaultQuotaLimit,
        resetCycle: quota?.resetCycle ?? meta.resetCycle,
        cacheHits: quota?.cacheHitsSaved ?? 0,
        nextResetAt: quota ? nextResetIso(quota) : null,
      },
    } satisfies SearchProviderState;
  });

  const keyless = KEYLESS_PROVIDERS.map((entry) => {
    const quota = quotaByProvider.get(entry.id);
    return {
      provider: entry.id,
      label: entry.label,
      category: entry.category,
      kind: "keyless" as const,
      status: "keyless" as const,
      hasKey: false,
      enabled: true,
      keyId: null,
      maskedKey: null,
      docsUrl: "",
      blurb: entry.blurb,
      freeTierNote: "Always on · no key or card required",
      requiresCard: false,
      dualField: null,
      healthStatus: null,
      lastError: null,
      quota: {
        used: quota?.usedCount ?? 0,
        limit: 0,
        resetCycle: "keyless" as const,
        cacheHits: quota?.cacheHitsSaved ?? 0,
        nextResetAt: null,
      },
    } satisfies SearchProviderState;
  });

  return [...keyed, ...keyless];
}
