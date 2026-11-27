import type { SearchProviderId, SearchResetCycle } from "@/lib/llm/types";
import { SEARCH_PROVIDER_CATALOG, getSearchProviderMeta } from "@/lib/llm/types";
import { supabaseServer } from "@/lib/supabase-server";

export type CacheEntryKind = "search" | "site" | "pagespeed" | "contact";
export type QuotaTrackedProviderId = SearchProviderId | "duckduckgo" | "osm";

export interface SearchQuotaRecord {
  provider: QuotaTrackedProviderId;
  label: string;
  usedCount: number;
  quotaLimit: number;
  resetCycle: SearchResetCycle;
  exhaustedUntil: string | null;
  lastResetAt: string;
  cacheHitsSaved: number;
  status: "healthy" | "near_limit" | "exhausted" | "keyless";
  updatedAt: string;
}

const TTL_MS: Record<CacheEntryKind, number> = {
  search: 7 * 24 * 60 * 60_000, // 7 days
  site: 14 * 24 * 60 * 60_000, // 14 days
  pagespeed: 7 * 24 * 60 * 60_000, // 7 days
  contact: 30 * 24 * 60 * 60_000, // 30 days
};

// Fast in-memory L1 cache & quota mirrors (backed by Supabase tables when configured)
const memCache = new Map<string, { kind: CacheEntryKind; payload: unknown; expiresAtMs: number }>();
const memQuotas = new Map<QuotaTrackedProviderId, SearchQuotaRecord>();
let memTotalCacheHits = 0;

function computeNextResetIso(cycle: SearchResetCycle, now = new Date()): string | null {
  if (cycle === "monthly") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0)).toISOString();
  }
  if (cycle === "daily") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0)).toISOString();
  }
  if (cycle === "one_time") {
    // 10 years forward until admin resets or replaces key
    return new Date(Date.UTC(now.getUTCFullYear() + 10, 0, 1, 0, 0, 0, 0)).toISOString();
  }
  return null;
}

function shouldResetQuota(rec: SearchQuotaRecord, now = new Date()): boolean {
  if (rec.resetCycle === "one_time" || rec.resetCycle === "keyless") return false;
  const last = new Date(rec.lastResetAt);
  if (Number.isNaN(last.getTime())) return true;
  if (rec.resetCycle === "monthly") {
    return (
      last.getUTCFullYear() < now.getUTCFullYear() ||
      (last.getUTCFullYear() === now.getUTCFullYear() && last.getUTCMonth() < now.getUTCMonth())
    );
  }
  if (rec.resetCycle === "daily") {
    return last.toISOString().slice(0, 10) < now.toISOString().slice(0, 10);
  }
  return false;
}

function defaultQuotaRecord(provider: QuotaTrackedProviderId): SearchQuotaRecord {
  const nowIso = new Date().toISOString();
  if (provider === "duckduckgo" || provider === "osm") {
    return {
      provider,
      label: provider === "duckduckgo" ? "DuckDuckGo Keyless" : "OpenStreetMap Overpass",
      usedCount: 0,
      quotaLimit: 0,
      resetCycle: "keyless",
      exhaustedUntil: null,
      lastResetAt: nowIso,
      cacheHitsSaved: 0,
      status: "keyless",
      updatedAt: nowIso,
    };
  }
  const meta = getSearchProviderMeta(provider);
  return {
    provider,
    label: meta.label,
    usedCount: 0,
    quotaLimit: meta.defaultQuotaLimit,
    resetCycle: meta.resetCycle,
    exhaustedUntil: null,
    lastResetAt: nowIso,
    cacheHitsSaved: 0,
    status: "healthy",
    updatedAt: nowIso,
  };
}

function computeStatus(rec: SearchQuotaRecord): SearchQuotaRecord["status"] {
  if (rec.resetCycle === "keyless") return "keyless";
  if (rec.exhaustedUntil && Date.parse(rec.exhaustedUntil) > Date.now()) return "exhausted";
  if (rec.quotaLimit > 0 && rec.usedCount >= Math.ceil(rec.quotaLimit * 0.95)) return "exhausted";
  if (rec.quotaLimit > 0 && rec.usedCount >= Math.ceil(rec.quotaLimit * 0.8)) return "near_limit";
  return "healthy";
}

async function loadQuotaRecord(provider: QuotaTrackedProviderId): Promise<SearchQuotaRecord> {
  const existingMem = memQuotas.get(provider);
  if (existingMem) {
    if (shouldResetQuota(existingMem)) {
      const reset: SearchQuotaRecord = {
        ...existingMem,
        usedCount: 0,
        exhaustedUntil: null,
        lastResetAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: existingMem.resetCycle === "keyless" ? "keyless" : "healthy",
      };
      memQuotas.set(provider, reset);
      void persistQuotaRecord(reset);
      return reset;
    }
    return existingMem;
  }

  let base = defaultQuotaRecord(provider);
  if (supabaseServer) {
    const { data, error } = await supabaseServer
      .from("search_provider_quotas")
      .select("*")
      .eq("provider", provider)
      .maybeSingle();
    if (!error && data) {
      const r = data as Record<string, unknown>;
      base = {
        ...base,
        usedCount: Number(r.used_count ?? 0),
        quotaLimit: Number(r.quota_limit ?? base.quotaLimit),
        resetCycle: (String(r.reset_cycle ?? base.resetCycle) as SearchResetCycle),
        exhaustedUntil: r.exhausted_until ? String(r.exhausted_until) : null,
        lastResetAt: String(r.last_reset_at ?? base.lastResetAt),
        cacheHitsSaved: Number(r.cache_hits_saved ?? 0),
        updatedAt: String(r.updated_at ?? base.updatedAt),
      };
      if (shouldResetQuota(base)) {
        base.usedCount = 0;
        base.exhaustedUntil = null;
        base.lastResetAt = new Date().toISOString();
        void persistQuotaRecord(base);
      }
      base.status = computeStatus(base);
    }
  }
  memQuotas.set(provider, base);
  return base;
}

async function persistQuotaRecord(rec: SearchQuotaRecord): Promise<void> {
  if (!supabaseServer) return;
  try {
    await supabaseServer.from("search_provider_quotas").upsert(
      {
        provider: rec.provider,
        used_count: rec.usedCount,
        quota_limit: rec.quotaLimit,
        reset_cycle: rec.resetCycle,
        exhausted_until: rec.exhaustedUntil,
        last_reset_at: rec.lastResetAt,
        cache_hits_saved: rec.cacheHitsSaved,
        updated_at: rec.updatedAt,
      } as never,
      { onConflict: "provider" },
    );
  } catch {
    /* non-blocking if migration pending */
  }
}

export async function isSearchProviderAvailable(provider: QuotaTrackedProviderId): Promise<boolean> {
  if (provider === "duckduckgo" || provider === "osm") return true;
  const rec = await loadQuotaRecord(provider);
  const status = computeStatus(rec);
  rec.status = status;
  return status !== "exhausted";
}

export async function recordSearchProviderUsage(provider: QuotaTrackedProviderId, credits = 1): Promise<void> {
  const rec = await loadQuotaRecord(provider);
  rec.usedCount += Math.max(1, credits);
  rec.updatedAt = new Date().toISOString();
  if (rec.resetCycle !== "keyless" && rec.quotaLimit > 0 && rec.usedCount >= Math.ceil(rec.quotaLimit * 0.95)) {
    rec.exhaustedUntil = computeNextResetIso(rec.resetCycle);
  }
  rec.status = computeStatus(rec);
  memQuotas.set(provider, rec);
  await persistQuotaRecord(rec);
}

export async function markSearchProviderExhausted(provider: SearchProviderId): Promise<void> {
  const rec = await loadQuotaRecord(provider);
  rec.exhaustedUntil = computeNextResetIso(rec.resetCycle);
  rec.status = "exhausted";
  rec.updatedAt = new Date().toISOString();
  memQuotas.set(provider, rec);
  await persistQuotaRecord(rec);
}

export async function resetSearchProviderQuota(provider: QuotaTrackedProviderId): Promise<SearchQuotaRecord> {
  const rec = await loadQuotaRecord(provider);
  rec.usedCount = 0;
  rec.exhaustedUntil = null;
  rec.lastResetAt = new Date().toISOString();
  rec.updatedAt = new Date().toISOString();
  rec.status = rec.resetCycle === "keyless" ? "keyless" : "healthy";
  memQuotas.set(provider, rec);
  await persistQuotaRecord(rec);
  return rec;
}

export async function recordCacheHitSaved(provider?: QuotaTrackedProviderId): Promise<void> {
  memTotalCacheHits += 1;
  const target: QuotaTrackedProviderId = provider ?? "duckduckgo";
  const rec = await loadQuotaRecord(target);
  rec.cacheHitsSaved += 1;
  rec.updatedAt = new Date().toISOString();
  memQuotas.set(target, rec);
  void persistQuotaRecord(rec);
}

export async function getSearchQuotaMonitorSnapshot(): Promise<{
  quotas: SearchQuotaRecord[];
  totalCacheHitsSaved: number;
}> {
  const providers: QuotaTrackedProviderId[] = [
    ...SEARCH_PROVIDER_CATALOG.map((m) => m.id),
    "osm",
    "duckduckgo",
  ];
  const quotas = await Promise.all(providers.map((p) => loadQuotaRecord(p)));
  const dbSaved = quotas.reduce((sum, q) => sum + (q.cacheHitsSaved || 0), 0);
  return {
    quotas,
    totalCacheHitsSaved: Math.max(memTotalCacheHits, dbSaved),
  };
}

// ---------------------------------------------------------------------------
// Search & Enrichment Cache (7d search / 14d domain / 24h pagespeed)
// ---------------------------------------------------------------------------

export async function getCachedSearchEnrichment<T>(cacheKey: string): Promise<T | null> {
  const now = Date.now();
  const mem = memCache.get(cacheKey);
  if (mem) {
    if (mem.expiresAtMs > now) {
      void recordCacheHitSaved();
      return mem.payload as T;
    }
    memCache.delete(cacheKey);
  }

  if (supabaseServer) {
    try {
      const { data, error } = await supabaseServer
        .from("search_enrichment_cache")
        .select("kind, payload, expires_at")
        .eq("cache_key", cacheKey)
        .maybeSingle();
      if (!error && data) {
        const r = data as { kind?: CacheEntryKind; payload?: unknown; expires_at?: string };
        const expMs = r.expires_at ? Date.parse(r.expires_at) : 0;
        if (expMs > now && r.payload !== undefined) {
          memCache.set(cacheKey, {
            kind: r.kind ?? "search",
            payload: r.payload,
            expiresAtMs: expMs,
          });
          void recordCacheHitSaved();
          return r.payload as T;
        }
      }
    } catch {
      /* ignore DB read error; operate on fresh fetch */
    }
  }
  return null;
}

export async function setCachedSearchEnrichment<T>(
  cacheKey: string,
  kind: CacheEntryKind,
  payload: T,
): Promise<void> {
  const ttl = TTL_MS[kind];
  const expMs = Date.now() + ttl;
  const expiresAtIso = new Date(expMs).toISOString();

  memCache.set(cacheKey, { kind, payload, expiresAtMs: expMs });
  if (memCache.size > 400) {
    const firstKey = memCache.keys().next().value;
    if (firstKey) memCache.delete(firstKey);
  }

  if (supabaseServer) {
    try {
      await supabaseServer.from("search_enrichment_cache").upsert(
        {
          cache_key: cacheKey,
          kind,
          payload,
          expires_at: expiresAtIso,
          created_at: new Date().toISOString(),
        } as never,
        { onConflict: "cache_key" },
      );
    } catch {
      /* non-blocking */
    }
  }
}

export function clearSearchCacheAndQuotasForTests(): void {
  memCache.clear();
  memQuotas.clear();
  memTotalCacheHits = 0;
}
