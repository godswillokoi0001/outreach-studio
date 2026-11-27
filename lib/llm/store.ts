import { decryptSecret, encryptSecret, maskSecret } from "../key-vault";
import { supabaseServer } from "../supabase-server";
import {
  getProviderMeta,
  normalizeGatewayProviderId,
  type AdminAiKeyPublic,
  type AdminAiKeyRecord,
  type AdminAiSettings,
  type AiExecutionLogRecord,
  type GatewayModelConfig,
  type GatewayProviderId,
  type KeyHealthStatus,
  type RoutingStrategy,
  type UserAiKeyPublic,
  type UserAiKeyRecord,
  type UserAiSettings,
} from "./types";

const PLATFORM_LLM_OWNER = "__platform_llm__";
const DOC_ADMIN_SETTINGS = "system_llm_admin_settings";
const DOC_ADMIN_KEYS = "system_llm_admin_keys";
const DOC_EXEC_LOGS = "system_llm_exec_logs";
const DOC_ADMIN_DELETED_KEYS = "system_llm_admin_deleted_keys";
const DOC_ADMIN_KEYS_INITIALIZED = "system_llm_admin_keys_initialized";

const BOOTSTRAP_KEY_ID_PREFIXES = ["admkey_env_", "admkey_legacy_"];
const deletedAdminKeyIdsMemory = new Set<string>();

const CACHE_TTL_MS = 15_000;

let adminSettingsCache: { value: AdminAiSettings; exp: number } | null = null;
let adminKeysCache: { value: AdminAiKeyRecord[]; exp: number } | null = null;
const userSettingsCache = new Map<string, { value: UserAiSettings; exp: number }>();
const userKeysCache = new Map<string, { value: UserAiKeyRecord[]; exp: number }>();

export function invalidateAdminAiCaches(): void {
  adminSettingsCache = null;
  adminKeysCache = null;
}

export function invalidateUserAiCaches(ownerId: string): void {
  userSettingsCache.delete(ownerId);
  userKeysCache.delete(ownerId);
}

/** Deterministic cache seeding for isolated unit/integration tests without remote DB I/O. */
export function seedGatewayCachesForTests(input: {
  adminSettings?: AdminAiSettings;
  adminKeys?: AdminAiKeyRecord[];
  userSettings?: Record<string, UserAiSettings>;
  userKeys?: Record<string, UserAiKeyRecord[]>;
}): void {
  const exp = Date.now() + 60_000;
  if (input.adminSettings) adminSettingsCache = { value: input.adminSettings, exp };
  if (input.adminKeys) adminKeysCache = { value: input.adminKeys, exp };
  if (input.userSettings) {
    for (const [ownerId, val] of Object.entries(input.userSettings)) {
      userSettingsCache.set(ownerId, { value: val, exp });
    }
  }
  if (input.userKeys) {
    for (const [ownerId, val] of Object.entries(input.userKeys)) {
      userKeysCache.set(ownerId, { value: val, exp });
    }
  }
}

export function resetGatewayCachesForTests(): void {
  adminSettingsCache = null;
  adminKeysCache = null;
  userSettingsCache.clear();
  userKeysCache.clear();
}

// ---------------------------------------------------------------------------
// Knowledge Fallback Helpers (used cleanly if SQL migration is pending)
// ---------------------------------------------------------------------------

async function readKnowledgeDoc<T>(ownerId: string, id: string): Promise<T | null> {
  if (!supabaseServer) return null;
  const { data } = await supabaseServer
    .from("knowledge")
    .select("content")
    .eq("id", id)
    .eq("owner_id", ownerId)
    .maybeSingle();
  const raw = (data as { content?: string } | null)?.content;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeKnowledgeDoc(
  ownerId: string,
  id: string,
  category: string,
  title: string,
  payload: unknown,
): Promise<void> {
  if (!supabaseServer) return;
  await supabaseServer.from("knowledge").upsert(
    {
      id,
      owner_id: ownerId,
      category,
      title,
      content: JSON.stringify(payload),
      sort: 999,
      is_master: false,
      updated_at: new Date().toISOString(),
    } as never,
    { onConflict: "id" },
  );
}

// ---------------------------------------------------------------------------
// Admin AI Settings
// ---------------------------------------------------------------------------

const DEFAULT_ADMIN_SETTINGS: AdminAiSettings = {
  id: "default",
  masterMode: "auto",
  strategy: "balanced",
  fallbackChain: [],
  updatedAt: new Date().toISOString(),
};

export async function getAdminAiSettings(): Promise<AdminAiSettings> {
  if (adminSettingsCache && Date.now() < adminSettingsCache.exp) {
    return adminSettingsCache.value;
  }
  if (!supabaseServer) return { ...DEFAULT_ADMIN_SETTINGS };

  const { data, error } = await supabaseServer
    .from("admin_ai_settings")
    .select("*")
    .eq("id", "default")
    .maybeSingle();

  let resolved: AdminAiSettings | null = null;
  if (!error && data) {
    const r = data as Record<string, unknown>;
    resolved = {
      id: "default",
      masterMode: r.master_mode === "manual" ? "manual" : "auto",
      strategy: (["balanced", "smartest", "fastest", "reliable"].includes(String(r.strategy))
        ? String(r.strategy)
        : "balanced") as RoutingStrategy,
      fallbackChain: Array.isArray(r.fallback_chain_json)
        ? (r.fallback_chain_json as { provider: GatewayProviderId; model: string }[])
        : [],
      updatedAt: String(r.updated_at ?? new Date().toISOString()),
    };
  } else {
    resolved = await readKnowledgeDoc<AdminAiSettings>(PLATFORM_LLM_OWNER, DOC_ADMIN_SETTINGS);
  }

  const finalVal = resolved ?? { ...DEFAULT_ADMIN_SETTINGS };
  adminSettingsCache = { value: finalVal, exp: Date.now() + CACHE_TTL_MS };
  return finalVal;
}

export async function saveAdminAiSettings(
  next: Partial<Pick<AdminAiSettings, "masterMode" | "strategy" | "fallbackChain">>,
): Promise<AdminAiSettings> {
  const current = await getAdminAiSettings();
  const merged: AdminAiSettings = {
    id: "default",
    masterMode: next.masterMode ?? current.masterMode,
    strategy: next.strategy ?? current.strategy,
    fallbackChain: next.fallbackChain ?? current.fallbackChain,
    updatedAt: new Date().toISOString(),
  };

  if (supabaseServer) {
    const { error } = await supabaseServer.from("admin_ai_settings").upsert(
      {
        id: "default",
        master_mode: merged.masterMode,
        strategy: merged.strategy,
        fallback_chain_json: merged.fallbackChain,
        updated_at: merged.updatedAt,
      } as never,
      { onConflict: "id" },
    );
    if (error) {
      await writeKnowledgeDoc(
        PLATFORM_LLM_OWNER,
        DOC_ADMIN_SETTINGS,
        "system_llm_gateway",
        "Admin AI Gateway Settings",
        merged,
      );
    }
  }
  invalidateAdminAiCaches();
  return merged;
}

// ---------------------------------------------------------------------------
// Admin AI Pooled Keys (with Legacy & Env Auto-Bootstrap)
// ---------------------------------------------------------------------------

function mapSqlAdminKeyRow(r: Record<string, unknown>): AdminAiKeyRecord {
  const { provider, impliedBaseUrl } = normalizeGatewayProviderId(r.provider);
  const meta = getProviderMeta(provider);
  const models = Array.isArray(r.models_json) && r.models_json.length > 0
    ? (r.models_json as GatewayModelConfig[])
    : meta.defaultModels;

  return {
    id: String(r.id ?? ""),
    provider,
    label: String(r.label ?? meta.label),
    encryptedKey: String(r.encrypted_key ?? ""),
    maskedKey: String(r.masked_key ?? ""),
    accountId: r.account_id ? String(r.account_id) : null,
    baseUrl: r.base_url ? String(r.base_url) : impliedBaseUrl ?? null,
    enabled: r.enabled !== false,
    models,
    rpmLimit: Number(r.rpm_limit ?? meta.defaultRpmLimit),
    rpdLimit: Number(r.rpd_limit ?? meta.defaultRpdLimit),
    healthStatus: (["healthy", "cooldown", "invalid"].includes(String(r.health_status))
      ? String(r.health_status)
      : "healthy") as KeyHealthStatus,
    cooldownUntil: r.cooldown_until ? String(r.cooldown_until) : null,
    cooldownStep: Number(r.cooldown_step ?? 0),
    lastError: r.last_error ? String(r.last_error) : null,
    lastCheckedAt: r.last_checked_at ? String(r.last_checked_at) : null,
    createdAt: String(r.created_at ?? new Date().toISOString()),
    updatedAt: String(r.updated_at ?? new Date().toISOString()),
  };
}

async function readDeletedAdminKeyIds(): Promise<Set<string>> {
  const stored = await readKnowledgeDoc<{ ids?: string[] } | string[]>(
    PLATFORM_LLM_OWNER,
    DOC_ADMIN_DELETED_KEYS,
  );
  const ids = Array.isArray(stored) ? stored : Array.isArray(stored?.ids) ? stored.ids : [];
  const result = new Set(deletedAdminKeyIdsMemory);
  for (const x of ids) {
    if (typeof x === "string" && x) result.add(x);
  }
  return result;
}

async function isAdminKeysInitialized(): Promise<boolean> {
  const doc = await readKnowledgeDoc<{ initialized?: boolean }>(
    PLATFORM_LLM_OWNER,
    DOC_ADMIN_KEYS_INITIALIZED,
  );
  return Boolean(doc?.initialized);
}

async function markAdminKeysInitialized(): Promise<void> {
  await writeKnowledgeDoc(
    PLATFORM_LLM_OWNER,
    DOC_ADMIN_KEYS_INITIALIZED,
    "system_llm_gateway",
    "Admin AI Gateway Pool Initialized",
    { initialized: true },
  );
}

async function rememberDeletedAdminKeyId(id: string): Promise<void> {
  const ids = await readDeletedAdminKeyIds();
  ids.add(id);
  await writeKnowledgeDoc(
    PLATFORM_LLM_OWNER,
    DOC_ADMIN_DELETED_KEYS,
    "system_llm_gateway",
    "Deleted Admin Gateway Keys",
    { ids: [...ids] },
  );
}

async function readLegacyPlatformKeys(): Promise<AdminAiKeyRecord[]> {
  if (!supabaseServer) return [];
  const legacy = await readKnowledgeDoc<{
    providers?: {
      id?: string;
      label?: string;
      enabled?: boolean;
      encryptedKey?: string;
      maskedKey?: string;
      baseUrl?: string;
      models?: { id: string; displayName?: string; enabled?: boolean }[];
    }[];
  }>("__platform__", "system_platform_policy");

  const out: AdminAiKeyRecord[] = [];
  const now = new Date().toISOString();
  for (const p of legacy?.providers ?? []) {
    if (!p?.encryptedKey) continue;
    const { provider, impliedBaseUrl } = normalizeGatewayProviderId(p.id);
    const meta = getProviderMeta(provider);
    const mappedModels: GatewayModelConfig[] =
      Array.isArray(p.models) && p.models.length > 0
        ? p.models.map((m) => ({
            id: m.id,
            displayName: m.displayName || m.id,
            enabled: m.enabled !== false,
            seats: ["smart", "balanced", "fast"],
            capabilities: { json: true, tools: true, vision: provider === "google", reasoning: false, grounding: provider === "google" },
          }))
        : meta.defaultModels;

    out.push({
      id: `admkey_legacy_${p.id}`,
      provider,
      label: p.label || `${meta.label} (Migrated)`,
      encryptedKey: p.encryptedKey,
      maskedKey: p.maskedKey || "••••",
      baseUrl: p.baseUrl || impliedBaseUrl || meta.baseUrl || null,
      enabled: p.enabled !== false,
      models: mappedModels,
      rpmLimit: meta.defaultRpmLimit,
      rpdLimit: meta.defaultRpdLimit,
      healthStatus: "healthy",
      cooldownUntil: null,
      cooldownStep: 0,
      lastError: null,
      lastCheckedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  // Env bootstrap if still no keys present
  if (out.length === 0 && process.env.GEMINI_API_KEY?.trim()) {
    const rawKey = process.env.GEMINI_API_KEY.trim();
    const meta = getProviderMeta("google");
    out.push({
      id: "admkey_env_google",
      provider: "google",
      label: "Google AI Studio (Host Env)",
      encryptedKey: encryptSecret(rawKey),
      maskedKey: maskSecret(rawKey),
      baseUrl: meta.baseUrl,
      enabled: true,
      models: meta.defaultModels,
      rpmLimit: meta.defaultRpmLimit,
      rpdLimit: meta.defaultRpdLimit,
      healthStatus: "healthy",
      cooldownUntil: null,
      cooldownStep: 0,
      lastError: null,
      lastCheckedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  return out;
}

export async function listAdminAiKeys(): Promise<AdminAiKeyRecord[]> {
  if (adminKeysCache && Date.now() < adminKeysCache.exp) {
    return adminKeysCache.value;
  }
  if (!supabaseServer) {
    const rawKey = process.env.GEMINI_API_KEY?.trim();
    if (!rawKey) return [];
    const meta = getProviderMeta("google");
    const now = new Date().toISOString();
    return [
      {
        id: "admkey_env_google",
        provider: "google",
        label: "Google AI Studio (Host Env)",
        encryptedKey: encryptSecret(rawKey),
        maskedKey: maskSecret(rawKey),
        baseUrl: meta.baseUrl,
        enabled: true,
        models: meta.defaultModels,
        rpmLimit: meta.defaultRpmLimit,
        rpdLimit: meta.defaultRpdLimit,
        healthStatus: "healthy",
        cooldownUntil: null,
        cooldownStep: 0,
        lastError: null,
        lastCheckedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  const { data, error } = await supabaseServer
    .from("admin_ai_keys")
    .select("*")
    .order("created_at", { ascending: true });

  let list: AdminAiKeyRecord[] = [];
  if (!error && Array.isArray(data)) {
    list = data.map((row) => mapSqlAdminKeyRow(row as Record<string, unknown>));
  } else {
    list = (await readKnowledgeDoc<AdminAiKeyRecord[]>(PLATFORM_LLM_OWNER, DOC_ADMIN_KEYS)) ?? [];
  }

  // Deleting an auto-generated key must stick even if an older deployment or a
  // concurrent request re-inserted it from the legacy/env bootstrap.
  if (list.some((k) => BOOTSTRAP_KEY_ID_PREFIXES.some((p) => k.id.startsWith(p)))) {
    const deletedIds = await readDeletedAdminKeyIds();
    if (deletedIds.size > 0) {
      const resurrected = list.filter((k) => deletedIds.has(k.id));
      list = list.filter((k) => !deletedIds.has(k.id));
      if (resurrected.length > 0 && !error) {
        await supabaseServer
          .from("admin_ai_keys")
          .delete()
          .in("id", resurrected.map((k) => k.id));
      }
    }
  }

  if (list.length === 0) {
    const deletedIds = await readDeletedAdminKeyIds();
    // One-time bootstrap only: once the pool has been initialized, an empty
    // pool means the admin removed every key, so nothing is re-imported.
    if (!(await isAdminKeysInitialized())) {
      list = (await readLegacyPlatformKeys()).filter((k) => !deletedIds.has(k.id));
      for (const k of list) {
        await upsertAdminAiKeyRaw(k, !error);
      }
      await markAdminKeysInitialized();
    }
  }

  adminKeysCache = { value: list, exp: Date.now() + CACHE_TTL_MS };
  return list;
}

async function upsertAdminAiKeyRaw(rec: AdminAiKeyRecord, useSql?: boolean): Promise<void> {
  if (!supabaseServer) return;
  if (useSql !== false) {
    const { error } = await supabaseServer.from("admin_ai_keys").upsert(
      {
        id: rec.id,
        provider: rec.provider,
        label: rec.label,
        encrypted_key: rec.encryptedKey,
        masked_key: rec.maskedKey,
        account_id: rec.accountId ?? null,
        base_url: rec.baseUrl ?? null,
        enabled: rec.enabled,
        models_json: rec.models,
        rpm_limit: rec.rpmLimit,
        rpd_limit: rec.rpdLimit,
        health_status: rec.healthStatus,
        cooldown_until: rec.cooldownUntil ?? null,
        cooldown_step: rec.cooldownStep,
        last_error: rec.lastError ?? null,
        last_checked_at: rec.lastCheckedAt ?? null,
        created_at: rec.createdAt,
        updated_at: rec.updatedAt,
      } as never,
      { onConflict: "id" },
    );
    if (!error) return;
  }

  const existing = (await readKnowledgeDoc<AdminAiKeyRecord[]>(PLATFORM_LLM_OWNER, DOC_ADMIN_KEYS)) ?? [];
  const next = existing.some((x) => x.id === rec.id)
    ? existing.map((x) => (x.id === rec.id ? rec : x))
    : [...existing, rec];
  await writeKnowledgeDoc(
    PLATFORM_LLM_OWNER,
    DOC_ADMIN_KEYS,
    "system_llm_gateway",
    "Admin AI Gateway Pooled Keys",
    next,
  );
}

export async function saveAdminAiKey(rec: AdminAiKeyRecord): Promise<AdminAiKeyRecord> {
  const next = { ...rec, updatedAt: new Date().toISOString() };
  await upsertAdminAiKeyRaw(next);
  invalidateAdminAiCaches();
  return next;
}

export async function deleteAdminAiKey(id: string): Promise<void> {
  deletedAdminKeyIdsMemory.add(id);
  await markAdminKeysInitialized();
  await rememberDeletedAdminKeyId(id);

  const existing = (await readKnowledgeDoc<AdminAiKeyRecord[]>(PLATFORM_LLM_OWNER, DOC_ADMIN_KEYS)) ?? [];
  if (existing.some((x) => x.id === id)) {
    await writeKnowledgeDoc(
      PLATFORM_LLM_OWNER,
      DOC_ADMIN_KEYS,
      "system_llm_gateway",
      "Admin AI Gateway Pooled Keys",
      existing.filter((x) => x.id !== id),
    );
  }

  invalidateAdminAiCaches();
  if (!supabaseServer) return;

  const { error } = await supabaseServer.from("admin_ai_keys").delete().eq("id", id);
  if (error) {
    throw new Error(`Pooled key could not be deleted: ${error.message}`);
  }

  // Never report success when the row survived the delete.
  const { data: still } = await supabaseServer
    .from("admin_ai_keys")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (still) {
    throw new Error("Pooled key could not be deleted. Please try again.");
  }
}

export async function persistAdminKeyHealth(
  id: string,
  patch: {
    healthStatus: KeyHealthStatus;
    cooldownUntil: string | null;
    cooldownStep: number;
    lastError: string | null;
  },
): Promise<void> {
  if (!supabaseServer) return;
  const nowIso = new Date().toISOString();
  const { error } = await supabaseServer
    .from("admin_ai_keys")
    .update({
      health_status: patch.healthStatus,
      cooldown_until: patch.cooldownUntil,
      cooldown_step: patch.cooldownStep,
      last_error: patch.lastError ? patch.lastError.slice(0, 300) : null,
      last_checked_at: nowIso,
      updated_at: nowIso,
    } as never)
    .eq("id", id);

  if (error) {
    const existing = (await readKnowledgeDoc<AdminAiKeyRecord[]>(PLATFORM_LLM_OWNER, DOC_ADMIN_KEYS)) ?? [];
    const next = existing.map((k) =>
      k.id === id
        ? {
            ...k,
            healthStatus: patch.healthStatus,
            cooldownUntil: patch.cooldownUntil,
            cooldownStep: patch.cooldownStep,
            lastError: patch.lastError ? patch.lastError.slice(0, 300) : null,
            lastCheckedAt: nowIso,
            updatedAt: nowIso,
          }
        : k,
    );
    await writeKnowledgeDoc(
      PLATFORM_LLM_OWNER,
      DOC_ADMIN_KEYS,
      "system_llm_gateway",
      "Admin AI Gateway Pooled Keys",
      next,
    );
  }

  // Update in-memory cache immediately instead of discarding healthy entries unnecessarily
  if (adminKeysCache) {
    adminKeysCache = {
      ...adminKeysCache,
      value: adminKeysCache.value.map((k) =>
        k.id === id
          ? {
              ...k,
              healthStatus: patch.healthStatus,
              cooldownUntil: patch.cooldownUntil,
              cooldownStep: patch.cooldownStep,
              lastError: patch.lastError,
              lastCheckedAt: nowIso,
              updatedAt: nowIso,
            }
          : k,
      ),
    };
  }
}

export function toAdminAiKeyPublic(rec: AdminAiKeyRecord): AdminAiKeyPublic {
  const { encryptedKey, ...rest } = rec;
  return { ...rest, hasKey: Boolean(encryptedKey) };
}

// ---------------------------------------------------------------------------
// User AI Settings & BYOK Keys (Strict Tenant Isolation)
// ---------------------------------------------------------------------------

function mapSqlUserKeyRow(r: Record<string, unknown>): UserAiKeyRecord {
  const { provider, impliedBaseUrl } = normalizeGatewayProviderId(r.provider);
  const meta = getProviderMeta(provider);
  const models = Array.isArray(r.models_json) && r.models_json.length > 0
    ? (r.models_json as GatewayModelConfig[])
    : meta.defaultModels;

  return {
    id: String(r.id ?? ""),
    ownerId: String(r.owner_id ?? ""),
    provider,
    label: String(r.label ?? meta.label),
    encryptedKey: String(r.encrypted_key ?? ""),
    maskedKey: String(r.masked_key ?? ""),
    accountId: r.account_id ? String(r.account_id) : null,
    baseUrl: r.base_url ? String(r.base_url) : impliedBaseUrl ?? null,
    models,
    lastVerifiedAt: r.last_verified_at ? String(r.last_verified_at) : null,
    lastError: r.last_error ? String(r.last_error) : null,
    createdAt: String(r.created_at ?? new Date().toISOString()),
    updatedAt: String(r.updated_at ?? new Date().toISOString()),
  };
}

export async function getUserAiSettings(ownerId: string): Promise<UserAiSettings> {
  const cached = userSettingsCache.get(ownerId);
  if (cached && Date.now() < cached.exp) return cached.value;

  const fallbackDefault: UserAiSettings = {
    ownerId,
    mode: "system_auto",
    activeKeyId: null,
    activeProvider: null,
    activeModel: null,
    fallbackToSystemAuto: false,
    updatedAt: new Date().toISOString(),
  };

  if (!supabaseServer) return fallbackDefault;

  const { data, error } = await supabaseServer
    .from("user_ai_settings")
    .select("*")
    .eq("owner_id", ownerId)
    .maybeSingle();

  let resolved: UserAiSettings | null = null;
  if (!error && data) {
    const r = data as Record<string, unknown>;
    resolved = {
      ownerId,
      mode: r.mode === "byok" ? "byok" : "system_auto",
      activeKeyId: r.active_key_id ? String(r.active_key_id) : null,
      activeProvider: r.active_provider
        ? normalizeGatewayProviderId(r.active_provider).provider
        : null,
      activeModel: r.active_model ? String(r.active_model) : null,
      fallbackToSystemAuto: Boolean(r.fallback_to_system_auto),
      updatedAt: String(r.updated_at ?? new Date().toISOString()),
    };
  } else {
    resolved = await readKnowledgeDoc<UserAiSettings>(
      ownerId,
      `system_llm_user_settings_${ownerId}`,
    );
  }

  // Migrate legacy system_user_byok_${ownerId} silently if present and no new setting yet
  if (!resolved) {
    const legacy = await readKnowledgeDoc<{
      mode?: string;
      allowFallbackOnError?: boolean;
      activePersonalProviderId?: string;
      providers?: {
        id: string;
        provider: string;
        label: string;
        encryptedKey: string;
        maskedKey: string;
        baseUrl?: string;
        model: string;
        models?: { id: string; label: string }[];
      }[];
    }>(ownerId, `system_user_byok_${ownerId}`);

    if (legacy && legacy.providers && legacy.providers.length > 0) {
      const now = new Date().toISOString();
      for (const lp of legacy.providers) {
        const { provider, impliedBaseUrl } = normalizeGatewayProviderId(lp.provider);
        const meta = getProviderMeta(provider);
        await saveUserAiKey(ownerId, {
          id: lp.id,
          ownerId,
          provider,
          label: lp.label || meta.label,
          encryptedKey: lp.encryptedKey,
          maskedKey: lp.maskedKey,
          baseUrl: lp.baseUrl || impliedBaseUrl || meta.baseUrl || null,
          models:
            lp.models?.map((m) => ({
              id: m.id,
              displayName: m.label || m.id,
              enabled: true,
              seats: ["smart", "balanced", "fast"],
              capabilities: { json: true, tools: true, vision: false, reasoning: false },
            })) ?? meta.defaultModels,
          lastVerifiedAt: now,
          lastError: null,
          createdAt: now,
          updatedAt: now,
        });
      }
      const chosen =
        legacy.providers.find((x) => x.id === legacy.activePersonalProviderId) ?? legacy.providers[0];
      if (legacy.mode === "personal" && chosen) {
        resolved = await saveUserAiSettings(ownerId, {
          mode: "byok",
          activeKeyId: chosen.id,
          activeProvider: normalizeGatewayProviderId(chosen.provider).provider,
          activeModel: chosen.model,
          fallbackToSystemAuto: Boolean(legacy.allowFallbackOnError),
        });
      }
    }
  }

  const finalVal = resolved ?? fallbackDefault;
  userSettingsCache.set(ownerId, { value: finalVal, exp: Date.now() + CACHE_TTL_MS });
  return finalVal;
}

export async function saveUserAiSettings(
  ownerId: string,
  patch: Partial<Omit<UserAiSettings, "ownerId" | "updatedAt">>,
): Promise<UserAiSettings> {
  const current = await getUserAiSettings(ownerId);
  const merged: UserAiSettings = {
    ownerId,
    mode: patch.mode ?? current.mode,
    activeKeyId: patch.activeKeyId !== undefined ? patch.activeKeyId : current.activeKeyId,
    activeProvider:
      patch.activeProvider !== undefined
        ? patch.activeProvider
          ? normalizeGatewayProviderId(patch.activeProvider).provider
          : null
        : current.activeProvider,
    activeModel: patch.activeModel !== undefined ? patch.activeModel : current.activeModel,
    fallbackToSystemAuto:
      patch.fallbackToSystemAuto !== undefined
        ? Boolean(patch.fallbackToSystemAuto)
        : current.fallbackToSystemAuto,
    updatedAt: new Date().toISOString(),
  };

  if (supabaseServer) {
    const { error } = await supabaseServer.from("user_ai_settings").upsert(
      {
        owner_id: ownerId,
        mode: merged.mode,
        active_key_id: merged.activeKeyId ?? null,
        active_provider: merged.activeProvider ?? null,
        active_model: merged.activeModel ?? null,
        fallback_to_system_auto: merged.fallbackToSystemAuto,
        updated_at: merged.updatedAt,
      } as never,
      { onConflict: "owner_id" },
    );
    if (error) {
      await writeKnowledgeDoc(
        ownerId,
        `system_llm_user_settings_${ownerId}`,
        "system_llm_user",
        "User AI Gateway Settings",
        merged,
      );
    }
  }

  invalidateUserAiCaches(ownerId);
  return merged;
}

export async function listUserAiKeys(ownerId: string): Promise<UserAiKeyRecord[]> {
  const cached = userKeysCache.get(ownerId);
  if (cached && Date.now() < cached.exp) return cached.value;
  if (!supabaseServer) return [];

  const { data, error } = await supabaseServer
    .from("user_ai_keys")
    .select("*")
    .eq("owner_id", ownerId)
    .order("created_at", { ascending: true });

  let list: UserAiKeyRecord[] = [];
  if (!error && Array.isArray(data)) {
    list = data.map((r) => mapSqlUserKeyRow(r as Record<string, unknown>));
  } else {
    list =
      (await readKnowledgeDoc<UserAiKeyRecord[]>(ownerId, `system_llm_user_keys_${ownerId}`)) ?? [];
  }

  userKeysCache.set(ownerId, { value: list, exp: Date.now() + CACHE_TTL_MS });
  return list;
}

export async function saveUserAiKey(ownerId: string, rec: UserAiKeyRecord): Promise<UserAiKeyRecord> {
  const safe: UserAiKeyRecord = { ...rec, ownerId, updatedAt: new Date().toISOString() };
  if (supabaseServer) {
    const { error } = await supabaseServer.from("user_ai_keys").upsert(
      {
        id: safe.id,
        owner_id: ownerId,
        provider: safe.provider,
        label: safe.label,
        encrypted_key: safe.encryptedKey,
        masked_key: safe.maskedKey,
        account_id: safe.accountId ?? null,
        base_url: safe.baseUrl ?? null,
        models_json: safe.models,
        last_verified_at: safe.lastVerifiedAt ?? null,
        last_error: safe.lastError ?? null,
        created_at: safe.createdAt,
        updated_at: safe.updatedAt,
      } as never,
      { onConflict: "id" },
    );
    if (error) {
      const existing =
        (await readKnowledgeDoc<UserAiKeyRecord[]>(ownerId, `system_llm_user_keys_${ownerId}`)) ?? [];
      const next = existing.some((x) => x.id === safe.id)
        ? existing.map((x) => (x.id === safe.id ? safe : x))
        : [...existing, safe];
      await writeKnowledgeDoc(
        ownerId,
        `system_llm_user_keys_${ownerId}`,
        "system_llm_user",
        "User Encrypted AI Keys",
        next,
      );
    }
  }
  invalidateUserAiCaches(ownerId);
  return safe;
}

export async function deleteUserAiKey(ownerId: string, keyId: string): Promise<void> {
  if (!supabaseServer) return;
  const { error } = await supabaseServer
    .from("user_ai_keys")
    .delete()
    .eq("id", keyId)
    .eq("owner_id", ownerId);
  if (error) {
    const existing =
      (await readKnowledgeDoc<UserAiKeyRecord[]>(ownerId, `system_llm_user_keys_${ownerId}`)) ?? [];
    await writeKnowledgeDoc(
      ownerId,
      `system_llm_user_keys_${ownerId}`,
      "system_llm_user",
      "User Encrypted AI Keys",
      existing.filter((x) => x.id !== keyId),
    );
  }
  invalidateUserAiCaches(ownerId);
}

export function toUserAiKeyPublic(rec: UserAiKeyRecord): UserAiKeyPublic {
  const { encryptedKey, ...rest } = rec;
  void encryptedKey;
  return rest;
}

export function decryptStoredGatewayKey(encrypted: string): string {
  return decryptSecret(encrypted);
}

export function encryptGatewayKey(plaintext: string): { encryptedKey: string; maskedKey: string } {
  return {
    encryptedKey: encryptSecret(plaintext),
    maskedKey: maskSecret(plaintext),
  };
}

// ---------------------------------------------------------------------------
// Execution Receipt Logs (200-500 rolling window for DB hygiene)
// ---------------------------------------------------------------------------

export async function appendAiExecutionLog(
  entry: Omit<AiExecutionLogRecord, "id" | "createdAt">,
): Promise<void> {
  if (!supabaseServer) return;
  const id = `exec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const nowIso = new Date().toISOString();

  const row: AiExecutionLogRecord = {
    id,
    ...entry,
    createdAt: nowIso,
  };

  const { error } = await supabaseServer.from("ai_execution_logs").insert({
    id: row.id,
    owner_id: row.ownerId,
    task_type: row.taskType,
    feature: row.feature,
    requested_mode: row.requestedMode,
    requested_model: row.requestedModel ?? null,
    actual_provider: row.actualProvider ?? null,
    actual_key_id: row.actualKeyId ?? null,
    actual_model: row.actualModel ?? null,
    fallback_hops: row.fallbackHops,
    fallback_used: row.fallbackUsed,
    grounded: row.grounded,
    latency_ms: row.latencyMs,
    status: row.status,
    error_summary: row.errorSummary ? row.errorSummary.slice(0, 400) : null,
    created_at: nowIso,
  } as never);

  if (!error) {
    // Periodic lightweight trim to protect storage (keep latest 400 rows)
    if (Math.random() < 0.08) {
      const { data: oldRows } = await supabaseServer
        .from("ai_execution_logs")
        .select("id")
        .order("created_at", { ascending: false })
        .range(400, 600);
      const idsToDrop = (oldRows ?? []).map((x) => String((x as { id?: string }).id ?? "")).filter(Boolean);
      if (idsToDrop.length > 0) {
        await supabaseServer.from("ai_execution_logs").delete().in("id", idsToDrop);
      }
    }
    return;
  }

  const existing = (await readKnowledgeDoc<AiExecutionLogRecord[]>(PLATFORM_LLM_OWNER, DOC_EXEC_LOGS)) ?? [];
  const next = [row, ...existing].slice(0, 250);
  await writeKnowledgeDoc(
    PLATFORM_LLM_OWNER,
    DOC_EXEC_LOGS,
    "system_llm_gateway",
    "AI Execution Receipt Log",
    next,
  );
}

export async function listAiExecutionLogs(options?: {
  ownerId?: string;
  limit?: number;
}): Promise<AiExecutionLogRecord[]> {
  if (!supabaseServer) return [];
  const limit = Math.min(200, Math.max(10, options?.limit ?? 50));

  let q = supabaseServer
    .from("ai_execution_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (options?.ownerId) {
    q = q.eq("owner_id", options.ownerId);
  }

  const { data, error } = await q;
  if (!error && Array.isArray(data)) {
    return data.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: String(r.id ?? ""),
        ownerId: String(r.owner_id ?? ""),
        taskType: (String(r.task_type ?? "balanced") as AiExecutionLogRecord["taskType"]),
        feature: String(r.feature ?? ""),
        requestedMode: r.requested_mode === "byok" ? "byok" : "system_auto",
        requestedModel: r.requested_model ? String(r.requested_model) : null,
        actualProvider: r.actual_provider ? String(r.actual_provider) : null,
        actualKeyId: r.actual_key_id ? String(r.actual_key_id) : null,
        actualModel: r.actual_model ? String(r.actual_model) : null,
        fallbackHops: Number(r.fallback_hops ?? 0),
        fallbackUsed: Boolean(r.fallback_used),
        grounded: Boolean(r.grounded),
        latencyMs: Number(r.latency_ms ?? 0),
        status: r.status === "failed" ? "failed" : "success",
        errorSummary: r.error_summary ? String(r.error_summary) : null,
        createdAt: String(r.created_at ?? ""),
      };
    });
  }

  const existing = (await readKnowledgeDoc<AiExecutionLogRecord[]>(PLATFORM_LLM_OWNER, DOC_EXEC_LOGS)) ?? [];
  const filtered = options?.ownerId ? existing.filter((x) => x.ownerId === options.ownerId) : existing;
  return filtered.slice(0, limit);
}
