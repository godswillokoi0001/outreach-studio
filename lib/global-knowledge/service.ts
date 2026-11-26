import { supabaseServer } from "../supabase-server";
import { GLOBAL_KNOWLEDGE_SEED, GLOBAL_KNOWLEDGE_SEED_MAP } from "./seed";
import {
  GLOBAL_KNOWLEDGE_MODULE_KEYS,
  MODULE_TITLES,
  type GlobalKnowledgeModule,
  type GlobalKnowledgeModuleKey,
} from "./types";

const DEFAULT_TTL_MS = 20 * 60 * 1000; // 20 minutes

export interface GlobalKnowledgeStoreAdapter {
  fetchActiveModules: () => Promise<GlobalKnowledgeModule[]>;
  fetchAllVersions: () => Promise<GlobalKnowledgeModule[]>;
  insertSeedModules: (force: boolean) => Promise<{ inserted: number; skipped: number; updated: number }>;
  publishVersion: (input: {
    moduleKey: GlobalKnowledgeModuleKey;
    title?: string;
    content: string;
    updatedBy?: string | null;
  }) => Promise<GlobalKnowledgeModule>;
  rollbackVersion: (input: {
    moduleKey: GlobalKnowledgeModuleKey;
    version: number;
    updatedBy?: string | null;
  }) => Promise<GlobalKnowledgeModule>;
}

export interface GlobalKnowledgeCacheSnapshot {
  modules: Map<GlobalKnowledgeModuleKey, GlobalKnowledgeModule>;
  loadedAt: number;
  source: "database" | "fallback_seed";
}

let cache: GlobalKnowledgeCacheSnapshot | null = null;
let inflightLoad: Promise<GlobalKnowledgeCacheSnapshot> | null = null;
let autoSeedChecked = false;
let fallbackWarned = false;

let stats = {
  hits: 0,
  misses: 0,
  dbReads: 0,
  fallbackReads: 0,
};

let customTtlMs: number | null = null;
let customAdapter: GlobalKnowledgeStoreAdapter | null = null;

function getTtlMs(): number {
  if (customTtlMs !== null && customTtlMs > 0) return customTtlMs;
  const envVal = Number(process.env.GLOBAL_KNOWLEDGE_TTL_MS);
  return Number.isFinite(envVal) && envVal > 0 ? envVal : DEFAULT_TTL_MS;
}

export function isGlobalKnowledgeModuleKey(key: string): key is GlobalKnowledgeModuleKey {
  return (GLOBAL_KNOWLEDGE_MODULE_KEYS as readonly string[]).includes(key);
}

function seedAsModule(key: GlobalKnowledgeModuleKey): GlobalKnowledgeModule {
  const entry = GLOBAL_KNOWLEDGE_SEED_MAP.get(key)!;
  const now = new Date(0).toISOString();
  return {
    id: `seed_${entry.module_key}_v${entry.version}`,
    module_key: entry.module_key,
    title: entry.title,
    version: entry.version,
    content: entry.content,
    is_active: true,
    updated_by: "system-seed",
    created_at: now,
    updated_at: now,
  };
}

function buildFallbackMap(): Map<GlobalKnowledgeModuleKey, GlobalKnowledgeModule> {
  const map = new Map<GlobalKnowledgeModuleKey, GlobalKnowledgeModule>();
  for (const key of GLOBAL_KNOWLEDGE_MODULE_KEYS) {
    map.set(key, seedAsModule(key));
  }
  return map;
}

function normalizeRow(raw: Record<string, unknown>): GlobalKnowledgeModule | null {
  const key = String(raw.module_key ?? "");
  if (!isGlobalKnowledgeModuleKey(key)) return null;
  return {
    id: String(raw.id ?? ""),
    module_key: key,
    title: String(raw.title ?? MODULE_TITLES[key]),
    version: Number(raw.version ?? 1),
    content: String(raw.content ?? ""),
    is_active: Boolean(raw.is_active),
    updated_by: raw.updated_by ? String(raw.updated_by) : null,
    created_at: String(raw.created_at ?? new Date().toISOString()),
    updated_at: String(raw.updated_at ?? new Date().toISOString()),
  };
}

const supabaseAdapter: GlobalKnowledgeStoreAdapter = {
  async fetchActiveModules() {
    if (!supabaseServer) {
      throw new Error("Supabase server client is not configured.");
    }
    const { data, error } = await supabaseServer
      .from("global_knowledge_modules" as never)
      .select("*")
      .eq("is_active", true);
    if (error) {
      throw new Error(error.message);
    }
    return ((data ?? []) as Record<string, unknown>[])
      .map(normalizeRow)
      .filter((m): m is GlobalKnowledgeModule => Boolean(m && m.content.trim()));
  },

  async fetchAllVersions() {
    if (!supabaseServer) {
      throw new Error("Supabase server client is not configured.");
    }
    const { data, error } = await supabaseServer
      .from("global_knowledge_modules" as never)
      .select("*")
      .order("module_key", { ascending: true })
      .order("version", { ascending: false });
    if (error) {
      throw new Error(error.message);
    }
    return ((data ?? []) as Record<string, unknown>[])
      .map(normalizeRow)
      .filter((m): m is GlobalKnowledgeModule => Boolean(m));
  },

  async insertSeedModules(force: boolean) {
    if (!supabaseServer) {
      throw new Error("Supabase server client is not configured.");
    }

    const { data: existingRows, error: listErr } = await supabaseServer
      .from("global_knowledge_modules" as never)
      .select("id, module_key, version, is_active");
    if (listErr) {
      throw new Error(listErr.message);
    }

    const rows = (existingRows ?? []) as { id: string; module_key: string; version: number; is_active: boolean }[];
    let inserted = 0;
    let skipped = 0;
    let updated = 0;

    for (const seed of GLOBAL_KNOWLEDGE_SEED) {
      const moduleRows = rows.filter((r) => r.module_key === seed.module_key);
      const hasAny = moduleRows.length > 0;
      const hasActive = moduleRows.some((r) => r.is_active);

      if (!hasAny) {
        const { error: insErr } = await supabaseServer
          .from("global_knowledge_modules" as never)
          .insert({
            module_key: seed.module_key,
            title: seed.title,
            version: seed.version,
            content: seed.content,
            is_active: true,
            updated_by: "seed-script",
          } as never);
        if (insErr) throw new Error(`Seed insert failed for ${seed.module_key}: ${insErr.message}`);
        inserted += 1;
        continue;
      }

      if (!hasActive && !force) {
        const latest = moduleRows.sort((a, b) => b.version - a.version)[0];
        const { error: actErr } = await supabaseServer
          .from("global_knowledge_modules" as never)
          .update({ is_active: true, updated_at: new Date().toISOString() } as never)
          .eq("id", latest.id);
        if (actErr) throw new Error(`Seed activate failed for ${seed.module_key}: ${actErr.message}`);
        updated += 1;
        continue;
      }

      if (!force) {
        skipped += 1;
        continue;
      }

      // --force: publish a clean reset version via transactional RPC if available, or safe sequential update.
      await supabaseAdapter.publishVersion({
        moduleKey: seed.module_key,
        title: seed.title,
        content: seed.content,
        updatedBy: "seed-script --force",
      });
      updated += 1;
    }

    return { inserted, skipped, updated };
  },

  async publishVersion({ moduleKey, title, content, updatedBy }) {
    if (!supabaseServer) {
      throw new Error("Supabase server client is not configured.");
    }

    const cleanTitle = (title ?? "").trim() || MODULE_TITLES[moduleKey];
    const cleanContent = content.trim();
    if (!cleanContent) {
      throw new Error("Module content cannot be empty.");
    }

    // Prefer single-transaction PL/pgSQL RPC when deployed.
    const rpcRes = await supabaseServer.rpc("publish_global_knowledge_version" as never, {
      p_module_key: moduleKey,
      p_title: cleanTitle,
      p_content: cleanContent,
      p_updated_by: updatedBy ?? null,
    } as never);

    if (!rpcRes.error && Array.isArray(rpcRes.data) && rpcRes.data[0]) {
      const mod = normalizeRow(rpcRes.data[0] as Record<string, unknown>);
      if (mod) return mod;
    }

    // Direct Supabase fallback when RPC isn't installed yet.
    const { data: versData, error: versErr } = await supabaseServer
      .from("global_knowledge_modules" as never)
      .select("version")
      .eq("module_key", moduleKey)
      .order("version", { ascending: false })
      .limit(1);
    if (versErr) throw new Error(versErr.message);

    const nextVersion = (((versData ?? [])[0] as { version?: number } | undefined)?.version ?? 0) + 1;

    const { error: deactErr } = await supabaseServer
      .from("global_knowledge_modules" as never)
      .update({ is_active: false, updated_at: new Date().toISOString() } as never)
      .eq("module_key", moduleKey)
      .eq("is_active", true);
    if (deactErr) throw new Error(deactErr.message);

    const { data: inserted, error: insErr } = await supabaseServer
      .from("global_knowledge_modules" as never)
      .insert({
        module_key: moduleKey,
        title: cleanTitle,
        version: nextVersion,
        content: cleanContent,
        is_active: true,
        updated_by: updatedBy ?? null,
      } as never)
      .select("*")
      .single();
    if (insErr || !inserted) throw new Error(insErr?.message ?? "Failed to insert new module version.");

    const normalized = normalizeRow(inserted as Record<string, unknown>);
    if (!normalized) throw new Error("Inserted module row was invalid.");
    return normalized;
  },

  async rollbackVersion({ moduleKey, version, updatedBy }) {
    if (!supabaseServer) {
      throw new Error("Supabase server client is not configured.");
    }

    const rpcRes = await supabaseServer.rpc("rollback_global_knowledge_version" as never, {
      p_module_key: moduleKey,
      p_version: version,
      p_updated_by: updatedBy ?? null,
    } as never);

    if (!rpcRes.error && Array.isArray(rpcRes.data) && rpcRes.data[0]) {
      const mod = normalizeRow(rpcRes.data[0] as Record<string, unknown>);
      if (mod) return mod;
    }

    const { data: target, error: findErr } = await supabaseServer
      .from("global_knowledge_modules" as never)
      .select("*")
      .eq("module_key", moduleKey)
      .eq("version", version)
      .maybeSingle();
    if (findErr) throw new Error(findErr.message);
    if (!target) throw new Error(`Version ${version} of ${moduleKey} was not found.`);

    const { error: deactErr } = await supabaseServer
      .from("global_knowledge_modules" as never)
      .update({ is_active: false, updated_at: new Date().toISOString() } as never)
      .eq("module_key", moduleKey)
      .eq("is_active", true);
    if (deactErr) throw new Error(deactErr.message);

    const { data: activated, error: actErr } = await supabaseServer
      .from("global_knowledge_modules" as never)
      .update({
        is_active: true,
        updated_by: updatedBy ?? null,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("module_key", moduleKey)
      .eq("version", version)
      .select("*")
      .single();
    if (actErr || !activated) throw new Error(actErr?.message ?? "Rollback failed.");

    const normalized = normalizeRow(activated as Record<string, unknown>);
    if (!normalized) throw new Error("Rolled-back module row was invalid.");
    return normalized;
  },
};

function getAdapter(): GlobalKnowledgeStoreAdapter {
  return customAdapter ?? supabaseAdapter;
}

export async function ensureGlobalKnowledgeSeeded(options?: {
  force?: boolean;
}): Promise<{ inserted: number; skipped: number; updated: number; fallback?: boolean }> {
  const adapter = getAdapter();
  const force = Boolean(options?.force);
  try {
    const res = await adapter.insertSeedModules(force);
    autoSeedChecked = true;
    if (res.inserted > 0 || res.updated > 0 || force) {
      invalidateGlobalKnowledgeCache();
    }
    return res;
  } catch (err) {
    if (!fallbackWarned) {
      console.warn(
        "[global-knowledge] Auto-seed skipped or DB unavailable; using local fallback constants:",
        err instanceof Error ? err.message : String(err),
      );
      fallbackWarned = true;
    }
    return { inserted: 0, skipped: GLOBAL_KNOWLEDGE_SEED.length, updated: 0, fallback: true };
  }
}

export function invalidateGlobalKnowledgeCache(): void {
  cache = null;
  inflightLoad = null;
}

export function getGlobalKnowledgeCacheStats() {
  return {
    cached: cache !== null,
    loadedAt: cache ? new Date(cache.loadedAt).toISOString() : null,
    source: cache?.source ?? null,
    ttlMs: getTtlMs(),
    ...stats,
  };
}

export function __configureGlobalKnowledgeForTest(opts: {
  adapter?: GlobalKnowledgeStoreAdapter | null;
  ttlMs?: number | null;
  resetStats?: boolean;
}): void {
  if (opts.adapter !== undefined) customAdapter = opts.adapter;
  if (opts.ttlMs !== undefined) customTtlMs = opts.ttlMs;
  if (opts.resetStats) {
    stats = { hits: 0, misses: 0, dbReads: 0, fallbackReads: 0 };
    autoSeedChecked = false;
    fallbackWarned = false;
  }
  invalidateGlobalKnowledgeCache();
}

async function loadFromDbOrFallback(): Promise<GlobalKnowledgeCacheSnapshot> {
  const adapter = getAdapter();
  try {
    stats.dbReads += 1;
    let active = await adapter.fetchActiveModules();

    // Cold start auto-seed if DB is reachable but missing some or all 4 modules.
    if (active.length < GLOBAL_KNOWLEDGE_MODULE_KEYS.length && !autoSeedChecked) {
      autoSeedChecked = true;
      await adapter.insertSeedModules(false);
      active = await adapter.fetchActiveModules();
    }

    const map = new Map<GlobalKnowledgeModuleKey, GlobalKnowledgeModule>();
    for (const mod of active) {
      map.set(mod.module_key, mod);
    }

    // Fill any missing module cleanly from seed fallback so AI generation never breaks.
    let usedFallback = false;
    for (const key of GLOBAL_KNOWLEDGE_MODULE_KEYS) {
      if (!map.has(key)) {
        map.set(key, seedAsModule(key));
        usedFallback = true;
      }
    }

    return {
      modules: map,
      loadedAt: Date.now(),
      source: usedFallback && active.length === 0 ? "fallback_seed" : "database",
    };
  } catch (err) {
    stats.fallbackReads += 1;
    if (!fallbackWarned) {
      console.warn(
        "[global-knowledge] Failed to read global_knowledge_modules from DB; falling back to local seed modules:",
        err instanceof Error ? err.message : String(err),
      );
      fallbackWarned = true;
    }
    return {
      modules: buildFallbackMap(),
      loadedAt: Date.now(),
      source: "fallback_seed",
    };
  }
}

/**
 * Returns the active Global Sales & Outreach Knowledge modules from server RAM.
 * Only hits the database on cache miss or TTL expiry (default 20 minutes).
 */
export async function getGlobalKnowledgeModules(): Promise<Map<GlobalKnowledgeModuleKey, GlobalKnowledgeModule>> {
  const ttl = getTtlMs();
  if (cache && Date.now() - cache.loadedAt < ttl) {
    stats.hits += 1;
    return cache.modules;
  }

  stats.misses += 1;
  if (!inflightLoad) {
    inflightLoad = loadFromDbOrFallback().finally(() => {
      inflightLoad = null;
    });
  }
  cache = await inflightLoad;
  return cache.modules;
}

export async function getGlobalKnowledgeModule(key: GlobalKnowledgeModuleKey): Promise<GlobalKnowledgeModule> {
  const map = await getGlobalKnowledgeModules();
  return map.get(key) ?? seedAsModule(key);
}

export async function listAllGlobalKnowledgeVersions(): Promise<{
  modules: GlobalKnowledgeModule[];
  source: "database" | "fallback_seed";
}> {
  try {
    const modules = await getAdapter().fetchAllVersions();
    if (modules.length === 0) {
      await ensureGlobalKnowledgeSeeded({ force: false });
      const seeded = await getAdapter().fetchAllVersions();
      if (seeded.length > 0) return { modules: seeded, source: "database" };
      return { modules: Array.from(buildFallbackMap().values()), source: "fallback_seed" };
    }
    return { modules, source: "database" };
  } catch (err) {
    console.warn(
      "[global-knowledge] listAllGlobalKnowledgeVersions fallback:",
      err instanceof Error ? err.message : String(err),
    );
    return { modules: Array.from(buildFallbackMap().values()), source: "fallback_seed" };
  }
}

export async function publishGlobalKnowledgeVersion(input: {
  moduleKey: GlobalKnowledgeModuleKey;
  title?: string;
  content: string;
  updatedBy?: string | null;
}): Promise<GlobalKnowledgeModule> {
  const published = await getAdapter().publishVersion(input);
  invalidateGlobalKnowledgeCache();
  return published;
}

export async function rollbackGlobalKnowledgeVersion(input: {
  moduleKey: GlobalKnowledgeModuleKey;
  version: number;
  updatedBy?: string | null;
}): Promise<GlobalKnowledgeModule> {
  const restored = await getAdapter().rollbackVersion(input);
  invalidateGlobalKnowledgeCache();
  return restored;
}
