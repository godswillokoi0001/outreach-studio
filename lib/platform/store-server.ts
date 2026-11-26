import type { NextRequest } from "next/server";
import { AI_PROVIDERS, getProvider } from "../ai/registry";
import type { AiProviderId } from "../ai/types";
import {
  decryptSecret,
  encryptSecret,
  generateTotpSecret,
  maskSecret,
} from "../key-vault";
import { supabaseServer } from "../supabase-server";
import {
  DEFAULT_PLATFORM_QUOTAS,
  type AdminAuditEntry,
  type AdminRole,
  type AdminUserSummary,
  type AiFeatureKey,
  type AiUsageEvent,
  type PersonalProviderPublic,
  type PlatformAlert,
  type PlatformAnnouncement,
  type PlatformModelOption,
  type PlatformPolicyPublic,
  type PlatformProviderPublic,
  type PlatformQuotaConfig,
  type UserAccountStatus,
  type UserByokPublicState,
} from "./types";

const PLATFORM_OWNER = "__platform__";
const PLATFORM_AUDIT_OWNER = "__platform_admin__";

const DOC_PLATFORM_POLICY = "system_platform_policy";
const DOC_PLATFORM_KEYS = "system_platform_keys";
const DOC_PLATFORM_ANNOUNCEMENTS = "system_platform_announcements";

export interface InternalPlatformProviderRecord {
  id: AiProviderId;
  label: string;
  enabled: boolean;
  encryptedKey: string;
  maskedKey: string;
  baseUrl?: string;
  models: PlatformModelOption[];
  lastTestedAt?: string;
  lastTestOk?: boolean;
  lastTestError?: string;
  updatedAt?: string;
}

export interface InternalPlatformPolicy {
  providers: InternalPlatformProviderRecord[];
  featureDefaults: Record<AiFeatureKey, { provider: AiProviderId; model: string }>;
  fallbackChain: { provider: AiProviderId; model: string }[];
  quotas: PlatformQuotaConfig;
  updatedAt: string;
}

export interface UserGovernanceMeta {
  ownerId: string;
  email: string;
  name?: string;
  avatarUrl?: string | null;
  role: AdminRole;
  status: UserAccountStatus;
  plan: string;
  lastActiveAt: string;
  usageResetAt?: string;
  quotaOverride?: Partial<PlatformQuotaConfig>;
  totpEnabled: boolean;
  totpSecretEncrypted?: string;
  createdAt: string;
  updatedAt: string;
}

export interface InternalPersonalProvider {
  id: string;
  provider: AiProviderId;
  label: string;
  encryptedKey: string;
  maskedKey: string;
  baseUrl?: string;
  model: string;
  models: { id: string; label: string }[];
  verifiedAt?: string;
  lastError?: string;
}

export interface InternalUserByokVault {
  mode: "platform" | "personal";
  allowFallbackOnError: boolean;
  activePersonalProviderId?: string;
  selectedPlatformModel?: { provider: AiProviderId; model: string };
  providers: InternalPersonalProvider[];
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Low-level Server Storage Helpers (via supabaseServer, bypassing RLS safely)
// ---------------------------------------------------------------------------

async function readSystemJson<T>(ownerId: string, id: string): Promise<T | null> {
  if (!supabaseServer) return null;
  try {
    const { data, error } = await supabaseServer
      .from("knowledge")
      .select("content")
      .eq("id", id)
      .eq("owner_id", ownerId)
      .maybeSingle();
    if (error || !data) return null;
    const raw = (data as { content?: string }).content;
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeSystemJson(
  ownerId: string,
  id: string,
  category: string,
  title: string,
  payload: unknown,
): Promise<void> {
  if (!supabaseServer) return;
  const nowIso = new Date().toISOString();
  await supabaseServer.from("knowledge").upsert(
    {
      id,
      owner_id: ownerId,
      category,
      title,
      content: JSON.stringify(payload),
      sort: 999,
      is_master: false,
      updated_at: nowIso,
    } as never,
    { onConflict: "id" },
  );
}

// ---------------------------------------------------------------------------
// Rate Limiting for Key Testing & Abuse Protection
// ---------------------------------------------------------------------------

const keyTestHits = new Map<string, number[]>();

export function checkKeyTestRateLimit(userId: string): { allowed: boolean; retryAfterSec?: number } {
  const now = Date.now();
  const windowMs = 5 * 60 * 1000;
  const maxAttempts = 12;
  const history = (keyTestHits.get(userId) ?? []).filter((t) => now - t < windowMs);
  if (history.length >= maxAttempts) {
    const oldest = history[0] ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    return { allowed: false, retryAfterSec };
  }
  history.push(now);
  keyTestHits.set(userId, history);
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Admin Audit Log (Strictly Append-Only / Immutable)
// ---------------------------------------------------------------------------

export function extractRequestMeta(req?: NextRequest | null): { ipAddress: string; userAgent: string } {
  if (!req) return { ipAddress: "server", userAgent: "internal" };
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  const ipAddress = forwarded.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
  const userAgent = (req.headers.get("user-agent") ?? "unknown").slice(0, 220);
  return { ipAddress, userAgent };
}

export async function appendAdminAuditLog(input: {
  actorId: string;
  actorEmail: string;
  actorRole: AdminRole;
  action: string;
  targetType: string;
  targetId: string;
  details?: Record<string, unknown>;
  req?: NextRequest | null;
}): Promise<void> {
  if (!supabaseServer) return;
  const { ipAddress, userAgent } = extractRequestMeta(input.req);
  const nowIso = new Date().toISOString();
  const id = `adm_log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  await supabaseServer.from("audit_logs").insert({
    id,
    owner_id: PLATFORM_AUDIT_OWNER,
    action: input.action.slice(0, 120),
    entity: input.targetType.slice(0, 80),
    entity_id: input.targetId.slice(0, 120),
    detail: {
      actorId: input.actorId,
      actorEmail: input.actorEmail,
      actorRole: input.actorRole,
      ipAddress,
      userAgent,
      ...(input.details ?? {}),
    },
    created_at: nowIso,
  } as never);
}

export async function listAdminAuditLogs(limit = 200): Promise<AdminAuditEntry[]> {
  if (!supabaseServer) return [];
  const { data } = await supabaseServer
    .from("audit_logs")
    .select("*")
    .eq("owner_id", PLATFORM_AUDIT_OWNER)
    .order("created_at", { ascending: false })
    .limit(limit);

  return (data ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    const detail = (r.detail && typeof r.detail === "object" ? r.detail : {}) as Record<string, unknown>;
    return {
      id: String(r.id ?? ""),
      actorId: String(detail.actorId ?? ""),
      actorEmail: String(detail.actorEmail ?? ""),
      actorRole: (String(detail.actorRole ?? "admin") as AdminRole) || "admin",
      action: String(r.action ?? ""),
      targetType: String(r.entity ?? ""),
      targetId: String(r.entity_id ?? ""),
      details: detail,
      ipAddress: String(detail.ipAddress ?? "unknown"),
      userAgent: String(detail.userAgent ?? "unknown"),
      createdAt: String(r.created_at ?? ""),
    };
  });
}

// ---------------------------------------------------------------------------
// Platform Policy & Encrypted Key Vault
// ---------------------------------------------------------------------------

function buildDefaultPlatformPolicy(): InternalPlatformPolicy {
  const hostGeminiKey = process.env.GEMINI_API_KEY?.trim() || "";
  const providers: InternalPlatformProviderRecord[] = AI_PROVIDERS.map((meta) => {
    const isGemini = meta.id === "gemini";
    const hasEnvKey = isGemini && Boolean(hostGeminiKey);
    const models: PlatformModelOption[] = (meta.staticModels ?? [{ id: meta.defaultModel, label: meta.defaultModel }]).map(
      (m) => ({
        id: m.id,
        displayName: m.label,
        enabled: isGemini ? true : false,
        inputCostPer1M: isGemini ? 0.15 : 1.0,
        outputCostPer1M: isGemini ? 0.6 : 3.0,
      }),
    );

    return {
      id: meta.id,
      label: meta.label,
      enabled: isGemini && hasEnvKey,
      encryptedKey: "",
      maskedKey: hasEnvKey ? `env-...${hostGeminiKey.slice(-4)}` : "",
      baseUrl: meta.baseUrl,
      models,
    };
  });

  const defaultModel = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
  return {
    providers,
    featureDefaults: {
      analytics: { provider: "gemini", model: defaultModel },
      growth_advisor: { provider: "gemini", model: defaultModel },
      research: { provider: "gemini", model: defaultModel },
      ask_ai: { provider: "gemini", model: defaultModel },
      knowledge_base: { provider: "gemini", model: defaultModel },
      email_compose: { provider: "gemini", model: defaultModel },
      operator_chat: { provider: "gemini", model: defaultModel },
    },
    fallbackChain: [
      { provider: "gemini", model: "gemini-2.5-flash" },
      { provider: "gemini", model: "gemini-2.5-pro" },
    ],
    quotas: { ...DEFAULT_PLATFORM_QUOTAS },
    updatedAt: new Date().toISOString(),
  };
}

export async function getInternalPlatformPolicy(): Promise<InternalPlatformPolicy> {
  const stored = await readSystemJson<InternalPlatformPolicy>(PLATFORM_OWNER, DOC_PLATFORM_POLICY);
  const keyMap = await readSystemJson<Record<string, { encryptedKey: string; maskedKey: string; baseUrl?: string }>>(
    PLATFORM_OWNER,
    DOC_PLATFORM_KEYS,
  );

  const defaults = buildDefaultPlatformPolicy();
  if (!stored) {
    return defaults;
  }

  const providers = defaults.providers.map((def) => {
    const existing = stored.providers?.find((p) => p.id === def.id);
    const keyInfo = keyMap?.[def.id];
    const hasVaultKey = Boolean(keyInfo?.encryptedKey);
    const envFallback = def.id === "gemini" && Boolean(process.env.GEMINI_API_KEY?.trim());
    return {
      ...def,
      ...(existing ?? {}),
      encryptedKey: keyInfo?.encryptedKey ?? "",
      maskedKey: hasVaultKey ? keyInfo!.maskedKey : envFallback ? def.maskedKey : "",
      baseUrl: keyInfo?.baseUrl ?? existing?.baseUrl ?? def.baseUrl,
      enabled: existing ? existing.enabled : def.enabled,
    };
  });

  return {
    providers,
    featureDefaults: { ...defaults.featureDefaults, ...(stored.featureDefaults ?? {}) },
    fallbackChain: Array.isArray(stored.fallbackChain) && stored.fallbackChain.length > 0
      ? stored.fallbackChain
      : defaults.fallbackChain,
    quotas: { ...DEFAULT_PLATFORM_QUOTAS, ...(stored.quotas ?? {}) },
    updatedAt: stored.updatedAt || defaults.updatedAt,
  };
}

export async function saveInternalPlatformPolicy(policy: InternalPlatformPolicy): Promise<PlatformPolicyPublic> {
  const keyMap: Record<string, { encryptedKey: string; maskedKey: string; baseUrl?: string }> = {};
  const strippedProviders = policy.providers.map((p) => {
    if (p.encryptedKey) {
      keyMap[p.id] = {
        encryptedKey: p.encryptedKey,
        maskedKey: p.maskedKey,
        ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
      };
    }
    return {
      ...p,
      encryptedKey: "",
    };
  });

  const nextPolicy: InternalPlatformPolicy = {
    ...policy,
    providers: strippedProviders,
    updatedAt: new Date().toISOString(),
  };

  await Promise.all([
    writeSystemJson(PLATFORM_OWNER, DOC_PLATFORM_POLICY, "system_platform", "Platform AI Policy", nextPolicy),
    writeSystemJson(PLATFORM_OWNER, DOC_PLATFORM_KEYS, "system_platform_keys", "Encrypted Platform Keys", keyMap),
  ]);

  return toPublicPlatformPolicy({ ...nextPolicy, providers: policy.providers });
}

export function toPublicPlatformPolicy(internal: InternalPlatformPolicy): PlatformPolicyPublic {
  const providers: PlatformProviderPublic[] = internal.providers.map((p) => {
    const hasEnv = p.id === "gemini" && Boolean(process.env.GEMINI_API_KEY?.trim());
    return {
      id: p.id,
      label: p.label,
      enabled: p.enabled,
      hasKey: Boolean(p.encryptedKey || hasEnv),
      maskedKey: p.maskedKey,
      baseUrl: p.baseUrl,
      models: p.models,
      lastTestedAt: p.lastTestedAt,
      lastTestOk: p.lastTestOk,
      lastTestError: p.lastTestError,
      updatedAt: p.updatedAt,
    };
  });

  return {
    providers,
    featureDefaults: internal.featureDefaults,
    fallbackChain: internal.fallbackChain,
    quotas: internal.quotas,
    updatedAt: internal.updatedAt,
  };
}

export function decryptPlatformProviderKey(policy: InternalPlatformPolicy, providerId: AiProviderId): string {
  const provider = policy.providers.find((p) => p.id === providerId);
  if (provider?.encryptedKey) {
    return decryptSecret(provider.encryptedKey);
  }
  if (providerId === "gemini" && process.env.GEMINI_API_KEY?.trim()) {
    return process.env.GEMINI_API_KEY.trim();
  }
  return "";
}

// ---------------------------------------------------------------------------
// User Governance (Roles, Suspension, 2FA Secrets, Activity Ping)
// ---------------------------------------------------------------------------

function configuredAdminEmails(): Set<string> {
  const raw = process.env.ADMIN_EMAILS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

async function listAllUserMetaRecords(): Promise<Map<string, UserGovernanceMeta>> {
  const map = new Map<string, UserGovernanceMeta>();
  if (!supabaseServer) return map;
  const { data } = await supabaseServer
    .from("knowledge")
    .select("owner_id, content")
    .eq("category", "system_user_meta");

  for (const row of data ?? []) {
    try {
      const parsed = JSON.parse(String((row as { content?: string }).content ?? "{}")) as UserGovernanceMeta;
      if (parsed.ownerId) map.set(parsed.ownerId, parsed);
    } catch {
      /* skip corrupt row */
    }
  }
  return map;
}

export async function getUserGovernance(
  ownerId: string,
  email: string,
  profileInfo?: { name?: string; avatarUrl?: string | null },
): Promise<UserGovernanceMeta> {
  const docId = `system_user_meta_${ownerId}`;
  const existing = await readSystemJson<UserGovernanceMeta>(ownerId, docId);
  const nowIso = new Date().toISOString();
  const envAdmins = configuredAdminEmails();
  const normalizedEmail = email.trim().toLowerCase();

  if (existing) {
    // Sync env-forced super_admin if needed
    const needsRolePromote = envAdmins.has(normalizedEmail) && existing.role !== "super_admin";
    const needsProfileUpdate =
      (profileInfo?.name && existing.name !== profileInfo.name) ||
      (profileInfo?.avatarUrl && existing.avatarUrl !== profileInfo.avatarUrl);

    if (needsRolePromote || needsProfileUpdate) {
      const updated: UserGovernanceMeta = {
        ...existing,
        role: needsRolePromote ? "super_admin" : existing.role,
        name: profileInfo?.name ?? existing.name,
        avatarUrl: profileInfo?.avatarUrl ?? existing.avatarUrl,
        updatedAt: nowIso,
      };
      await saveUserGovernance(updated);
      return updated;
    }
    return existing;
  }

  // First time checking governance for this user:
  let initialRole: AdminRole = "user";
  if (envAdmins.has(normalizedEmail)) {
    initialRole = "super_admin";
  } else if (envAdmins.size === 0) {
    // Bootstrap rule: if zero admins exist anywhere in platform metadata, make the first user super_admin.
    const allMeta = await listAllUserMetaRecords();
    const hasAnyAdmin = Array.from(allMeta.values()).some(
      (m) => m.role === "super_admin" || m.role === "admin",
    );
    if (!hasAnyAdmin) {
      initialRole = "super_admin";
      await appendAdminAuditLog({
        actorId: ownerId,
        actorEmail: normalizedEmail,
        actorRole: "super_admin",
        action: "bootstrap_super_admin",
        targetType: "user",
        targetId: ownerId,
        details: { reason: "Initial platform administrator bootstrap" },
      });
    }
  }

  const created: UserGovernanceMeta = {
    ownerId,
    email: normalizedEmail,
    name: profileInfo?.name ?? email,
    avatarUrl: profileInfo?.avatarUrl ?? null,
    role: initialRole,
    status: "active",
    plan: "standard",
    lastActiveAt: nowIso,
    totpEnabled: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  await saveUserGovernance(created);
  return created;
}

export async function saveUserGovernance(meta: UserGovernanceMeta): Promise<void> {
  const docId = `system_user_meta_${meta.ownerId}`;
  await writeSystemJson(meta.ownerId, docId, "system_user_meta", `User Meta (${meta.email})`, {
    ...meta,
    updatedAt: new Date().toISOString(),
  });
}

export async function touchUserLastActive(ownerId: string, email: string): Promise<void> {
  const meta = await getUserGovernance(ownerId, email);
  const last = Date.parse(meta.lastActiveAt || "");
  if (!Number.isNaN(last) && Date.now() - last < 5 * 60 * 1000) return;
  await saveUserGovernance({ ...meta, lastActiveAt: new Date().toISOString() });
}

export async function getOrCreateAdminTotpPendingSecret(ownerId: string, email: string): Promise<string> {
  const meta = await getUserGovernance(ownerId, email);
  if (meta.totpSecretEncrypted) {
    return decryptSecret(meta.totpSecretEncrypted);
  }
  const secret = generateTotpSecret();
  await saveUserGovernance({
    ...meta,
    totpSecretEncrypted: encryptSecret(secret),
  });
  return secret;
}

// ---------------------------------------------------------------------------
// User BYOK Vault (Encrypted at Rest, Never Sent to Client)
// ---------------------------------------------------------------------------

export async function getUserByokVault(ownerId: string): Promise<InternalUserByokVault> {
  const docId = `system_user_byok_${ownerId}`;
  const stored = await readSystemJson<InternalUserByokVault>(ownerId, docId);
  if (stored) {
    return {
      mode: stored.mode === "personal" ? "personal" : "platform",
      allowFallbackOnError: Boolean(stored.allowFallbackOnError),
      activePersonalProviderId: stored.activePersonalProviderId,
      selectedPlatformModel: stored.selectedPlatformModel,
      providers: Array.isArray(stored.providers) ? stored.providers : [],
      updatedAt: stored.updatedAt || new Date().toISOString(),
    };
  }

  return {
    mode: "platform",
    allowFallbackOnError: false,
    providers: [],
    updatedAt: new Date().toISOString(),
  };
}

export async function saveUserByokVault(ownerId: string, vault: InternalUserByokVault): Promise<void> {
  const docId = `system_user_byok_${ownerId}`;
  await writeSystemJson(ownerId, docId, "system_user_byok", "User Encrypted AI Provider Vault", {
    ...vault,
    updatedAt: new Date().toISOString(),
  });
}

export function decryptUserProviderKey(provider: InternalPersonalProvider | undefined): string {
  if (!provider?.encryptedKey) return "";
  return decryptSecret(provider.encryptedKey);
}

export function buildPublicPlatformModelList(policy: PlatformPolicyPublic): UserByokPublicState["platformModels"] {
  const list: UserByokPublicState["platformModels"] = [];
  for (const p of policy.providers) {
    if (!p.enabled || !p.hasKey) continue;
    for (const m of p.models) {
      if (!m.enabled) continue;
      list.push({
        provider: p.id,
        providerLabel: p.label,
        model: m.id,
        displayName: m.displayName || m.id,
      });
    }
  }
  return list;
}

// ---------------------------------------------------------------------------
// AI Usage Telemetry & Cost Calculation
// ---------------------------------------------------------------------------

export function estimateUsageCostUsd(
  policy: InternalPlatformPolicy,
  providerId: AiProviderId,
  modelId: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const prov = policy.providers.find((p) => p.id === providerId);
  const mod = prov?.models.find((m) => m.id === modelId);
  const inRate = mod?.inputCostPer1M ?? 0.25;
  const outRate = mod?.outputCostPer1M ?? 0.9;
  const cost = (tokensIn / 1_000_000) * inRate + (tokensOut / 1_000_000) * outRate;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export async function recordAiUsageEvent(event: Omit<AiUsageEvent, "id" | "createdAt">): Promise<void> {
  if (!supabaseServer) return;
  const id = `usage_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const nowIso = new Date().toISOString();

  await supabaseServer.from("audit_logs").insert({
    id,
    owner_id: event.ownerId,
    action: "ai_usage",
    entity: "ai",
    entity_id: event.feature,
    detail: {
      userEmail: event.userEmail,
      feature: event.feature,
      provider: event.provider,
      model: event.model,
      source: event.source,
      tokensIn: event.tokensIn,
      tokensOut: event.tokensOut,
      costUsd: event.costUsd,
      latencyMs: event.latencyMs,
      success: event.success,
      errorMsg: event.errorMsg ? event.errorMsg.slice(0, 300) : undefined,
    },
    created_at: nowIso,
  } as never);
}

export async function listAiUsageEvents(options?: {
  ownerId?: string;
  sinceIso?: string;
  limit?: number;
}): Promise<AiUsageEvent[]> {
  if (!supabaseServer) return [];
  let q = supabaseServer
    .from("audit_logs")
    .select("*")
    .eq("action", "ai_usage")
    .order("created_at", { ascending: false })
    .limit(options?.limit ?? 1500);

  if (options?.ownerId) q = q.eq("owner_id", options.ownerId);
  if (options?.sinceIso) q = q.gte("created_at", options.sinceIso);

  const { data } = await q;
  return (data ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    const d = (r.detail && typeof r.detail === "object" ? r.detail : {}) as Record<string, unknown>;
    return {
      id: String(r.id ?? ""),
      ownerId: String(r.owner_id ?? ""),
      userEmail: String(d.userEmail ?? ""),
      feature: (String(d.feature ?? "operator_chat") as AiFeatureKey),
      provider: (String(d.provider ?? "gemini") as AiProviderId),
      model: String(d.model ?? ""),
      source: d.source === "personal" ? "personal" : "platform",
      tokensIn: Number(d.tokensIn ?? 0),
      tokensOut: Number(d.tokensOut ?? 0),
      costUsd: Number(d.costUsd ?? 0),
      latencyMs: Number(d.latencyMs ?? 0),
      success: d.success !== false,
      errorMsg: d.errorMsg ? String(d.errorMsg) : undefined,
      createdAt: String(r.created_at ?? ""),
    };
  });
}

export async function getUserUsageStatsSummary(
  ownerId: string,
  meta?: UserGovernanceMeta,
  policy?: InternalPlatformPolicy,
): Promise<UserByokPublicState["usageStats"]> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const resetAfter = meta?.usageResetAt ? new Date(meta.usageResetAt) : null;
  const effectiveMonthStart = resetAfter && resetAfter > monthStart ? resetAfter : monthStart;

  const events = await listAiUsageEvents({
    ownerId,
    sinceIso: effectiveMonthStart.toISOString(),
    limit: 1000,
  });

  const todayKey = now.toISOString().slice(0, 10);
  let platformRequestsToday = 0;
  let platformRequestsMonth = 0;
  let personalRequestsMonth = 0;
  let personalTokensMonth = 0;
  let personalCostMonthUsd = 0;

  for (const ev of events) {
    if (ev.source === "platform") {
      platformRequestsMonth += 1;
      if (ev.createdAt.slice(0, 10) === todayKey) {
        platformRequestsToday += 1;
      }
    } else {
      personalRequestsMonth += 1;
      personalTokensMonth += ev.tokensIn + ev.tokensOut;
      personalCostMonthUsd += ev.costUsd;
    }
  }

  const quotas = {
    ...DEFAULT_PLATFORM_QUOTAS,
    ...(policy?.quotas ?? {}),
    ...(meta?.quotaOverride ?? {}),
  };

  return {
    platformRequestsToday,
    platformRequestsMonth,
    platformDailyLimit: quotas.dailyRequestsPerUser,
    platformMonthlyLimit: quotas.monthlyRequestsPerUser,
    personalRequestsMonth,
    personalTokensMonth,
    personalCostMonthUsd: Math.round(personalCostMonthUsd * 10000) / 10000,
  };
}

export async function getUserByokPublicState(ownerId: string, email = ""): Promise<UserByokPublicState> {
  const [vault, internalPolicy, meta] = await Promise.all([
    getUserByokVault(ownerId),
    getInternalPlatformPolicy(),
    email ? getUserGovernance(ownerId, email) : Promise.resolve(undefined),
  ]);
  const publicPolicy = toPublicPlatformPolicy(internalPolicy);
  const usageStats = await getUserUsageStatsSummary(ownerId, meta, internalPolicy);

  const personalProviders: PersonalProviderPublic[] = vault.providers.map((p) => ({
    id: p.id,
    provider: p.provider,
    label: p.label || getProvider(p.provider)?.label || p.provider,
    maskedKey: p.maskedKey || maskSecret(p.encryptedKey),
    baseUrl: p.baseUrl,
    model: p.model,
    models: p.models,
    verifiedAt: p.verifiedAt,
    lastError: p.lastError,
  }));

  const activePersonalProvider =
    personalProviders.find((p) => p.id === vault.activePersonalProviderId) ?? personalProviders[0] ?? null;

  return {
    mode: vault.mode,
    allowFallbackOnError: vault.allowFallbackOnError,
    activePersonalProviderId: activePersonalProvider?.id,
    activePersonalProvider,
    personalProviders,
    platformModels: buildPublicPlatformModelList(publicPolicy),
    selectedPlatformModel: vault.selectedPlatformModel,
    usageStats,
  };
}

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

export async function listAnnouncements(): Promise<PlatformAnnouncement[]> {
  const rows = await readSystemJson<PlatformAnnouncement[]>(PLATFORM_OWNER, DOC_PLATFORM_ANNOUNCEMENTS);
  return Array.isArray(rows) ? rows : [];
}

export async function saveAnnouncements(rows: PlatformAnnouncement[]): Promise<void> {
  await writeSystemJson(
    PLATFORM_OWNER,
    DOC_PLATFORM_ANNOUNCEMENTS,
    "system_platform_announcements",
    "Platform Announcements",
    rows.slice(0, 50),
  );
}

export async function listActiveAnnouncementsForUser(
  ownerId: string,
  onboardingCompleted: boolean,
): Promise<PlatformAnnouncement[]> {
  const all = await listAnnouncements();
  return all.filter((a) => {
    if (!a.active) return false;
    if (a.targetGroup === "all" || a.targetGroup === "active") return true;
    if (a.targetGroup === "incomplete_onboarding") return !onboardingCompleted;
    if (a.targetGroup === "selected") return Boolean(a.targetUserIds?.includes(ownerId));
    return false;
  });
}

// ---------------------------------------------------------------------------
// Admin Directory, Overview & Health Aggregations
// ---------------------------------------------------------------------------

export async function listAdminUsersDirectory(): Promise<AdminUserSummary[]> {
  if (!supabaseServer) return [];

  const [linksRes, metaMap, campsRes, leadsRes, byokRes, onbRes, usageEvents] = await Promise.all([
    supabaseServer.from("account_links").select("email, legacy_owner_id, created_at").order("created_at", { ascending: false }),
    listAllUserMetaRecords(),
    supabaseServer.from("campaigns").select("owner_id"),
    supabaseServer.from("leads").select("owner_id"),
    supabaseServer.from("knowledge").select("owner_id, content").eq("category", "system_user_byok"),
    supabaseServer.from("knowledge").select("owner_id, content").eq("category", "system_onboarding_state"),
    listAiUsageEvents({ sinceIso: new Date(Date.now() - 30 * 86400_000).toISOString(), limit: 3000 }),
  ]);

  const campCounts = new Map<string, number>();
  for (const c of campsRes.data ?? []) {
    const id = String((c as { owner_id?: string }).owner_id ?? "");
    campCounts.set(id, (campCounts.get(id) ?? 0) + 1);
  }

  const leadCounts = new Map<string, number>();
  for (const l of leadsRes.data ?? []) {
    const id = String((l as { owner_id?: string }).owner_id ?? "");
    leadCounts.set(id, (leadCounts.get(id) ?? 0) + 1);
  }

  const byokMap = new Map<string, InternalUserByokVault>();
  for (const b of byokRes.data ?? []) {
    const id = String((b as { owner_id?: string }).owner_id ?? "");
    try {
      byokMap.set(id, JSON.parse(String((b as { content?: string }).content ?? "{}")) as InternalUserByokVault);
    } catch {
      /* ignore */
    }
  }

  const onbMap = new Map<string, { completed: boolean }>();
  for (const o of onbRes.data ?? []) {
    const id = String((o as { owner_id?: string }).owner_id ?? "");
    try {
      const parsed = JSON.parse(String((o as { content?: string }).content ?? "{}")) as { status?: string };
      onbMap.set(id, { completed: parsed.status === "completed" });
    } catch {
      /* ignore */
    }
  }

  const usageByOwner = new Map<
    string,
    { requests: number; tokens: number; costUsd: number; analyses: number }
  >();
  for (const ev of usageEvents) {
    const cur = usageByOwner.get(ev.ownerId) ?? { requests: 0, tokens: 0, costUsd: 0, analyses: 0 };
    cur.requests += 1;
    cur.tokens += ev.tokensIn + ev.tokensOut;
    cur.costUsd += ev.costUsd;
    if (ev.feature === "analytics") cur.analyses += 1;
    usageByOwner.set(ev.ownerId, cur);
  }

  const seenOwners = new Set<string>();
  const users: AdminUserSummary[] = [];

  for (const link of linksRes.data ?? []) {
    const row = link as { email?: string; legacy_owner_id?: string; created_at?: string };
    const ownerId = String(row.legacy_owner_id ?? "");
    if (!ownerId || ownerId.startsWith("__") || seenOwners.has(ownerId)) continue;
    seenOwners.add(ownerId);

    const email = String(row.email ?? "");
    const meta = metaMap.get(ownerId);
    const byok = byokMap.get(ownerId);
    const onb = onbMap.get(ownerId);
    const usage = usageByOwner.get(ownerId) ?? { requests: 0, tokens: 0, costUsd: 0, analyses: 0 };

    const activePersonal =
      byok?.mode === "personal"
        ? byok.providers.find((p) => p.id === byok.activePersonalProviderId) ?? byok.providers[0]
        : undefined;

    users.push({
      ownerId,
      email: meta?.email || email,
      name: meta?.name || email.split("@")[0] || "User",
      avatarUrl: meta?.avatarUrl ?? null,
      role: meta?.role ?? "user",
      status: meta?.status ?? "active",
      plan: meta?.plan ?? "standard",
      createdAt: String(row.created_at ?? meta?.createdAt ?? new Date().toISOString()),
      lastActiveAt: meta?.lastActiveAt ?? String(row.created_at ?? new Date().toISOString()),
      onboardingCompleted: onb?.completed ?? false,
      onboardingScore: onb?.completed ? 100 : 0,
      campaignsCount: campCounts.get(ownerId) ?? 0,
      leadsCount: leadCounts.get(ownerId) ?? 0,
      analysesCount: usage.analyses,
      aiRequestsMonth: usage.requests,
      aiTokensMonth: usage.tokens,
      aiCostMonthUsd: Math.round(usage.costUsd * 10000) / 10000,
      keySource: activePersonal ? "personal" : "platform",
      personalProviderHint: activePersonal ? `${activePersonal.label} (${activePersonal.maskedKey})` : undefined,
    });
  }

  return users;
}

export async function computePlatformHealthAndAlerts(
  users: AdminUserSummary[],
  usageEvents: AiUsageEvent[],
  policy: InternalPlatformPolicy,
): Promise<{
  errorRatePct: number;
  avgLatencyMs: number;
  failedJobsCount: number;
  providerStatus: {
    provider: AiProviderId;
    label: string;
    enabled: boolean;
    hasKey: boolean;
    requests: number;
    errors: number;
    avgLatencyMs: number;
    status: "healthy" | "degraded" | "unconfigured";
  }[];
  alerts: PlatformAlert[];
}> {
  const totalReq = usageEvents.length;
  const failed = usageEvents.filter((e) => !e.success);
  const errorRatePct = totalReq > 0 ? Math.round((failed.length / totalReq) * 1000) / 10 : 0;
  const avgLatencyMs =
    totalReq > 0 ? Math.round(usageEvents.reduce((s, e) => s + (e.latencyMs || 0), 0) / totalReq) : 0;

  const providerStatus = policy.providers.map((p) => {
    const pEvents = usageEvents.filter((e) => e.provider === p.id);
    const pErrors = pEvents.filter((e) => !e.success).length;
    const pLatency =
      pEvents.length > 0 ? Math.round(pEvents.reduce((s, e) => s + e.latencyMs, 0) / pEvents.length) : 0;
    const hasKey = Boolean(p.encryptedKey || (p.id === "gemini" && process.env.GEMINI_API_KEY?.trim()));
    const status: "healthy" | "degraded" | "unconfigured" = !hasKey
      ? "unconfigured"
      : pEvents.length >= 5 && pErrors / pEvents.length > 0.25
        ? "degraded"
        : "healthy";

    return {
      provider: p.id,
      label: p.label,
      enabled: p.enabled,
      hasKey,
      requests: pEvents.length,
      errors: pErrors,
      avgLatencyMs: pLatency,
      status,
    };
  });

  const alerts: PlatformAlert[] = [];
  const nowIso = new Date().toISOString();

  // 1. Spend cap threshold alert
  const platformSpendUsd = usageEvents
    .filter((e) => e.source === "platform")
    .reduce((sum, e) => sum + e.costUsd, 0);
  const capPct =
    policy.quotas.monthlySpendCapUsd > 0
      ? Math.round((platformSpendUsd / policy.quotas.monthlySpendCapUsd) * 100)
      : 0;
  if (capPct >= policy.quotas.alertThresholdPct) {
    alerts.push({
      id: "alert_spend_cap",
      severity: capPct >= 100 ? "high" : "medium",
      kind: "spend_threshold",
      title: `Monthly platform spend reached ${capPct}% of cap`,
      detail: `$${platformSpendUsd.toFixed(2)} spent out of $${policy.quotas.monthlySpendCapUsd.toFixed(2)} monthly cap.`,
      detectedAt: nowIso,
    });
  }

  // 2. Repeated failure alerts per user or provider
  if (totalReq >= 5 && errorRatePct > 20) {
    alerts.push({
      id: "alert_high_error_rate",
      severity: "high",
      kind: "repeated_failure",
      title: `Elevated AI API error rate (${errorRatePct}%)`,
      detail: `${failed.length} of last ${totalReq} AI calls failed. Check provider status or fallback chain.`,
      detectedAt: nowIso,
    });
  }

  // 3. Sudden usage spike detection per user
  const avgReqPerUser = users.length > 0 ? totalReq / users.length : 0;
  for (const u of users) {
    if (u.aiRequestsMonth >= Math.max(40, avgReqPerUser * 3)) {
      alerts.push({
        id: `alert_spike_${u.ownerId}`,
        severity: "medium",
        kind: "usage_spike",
        title: `Usage spike detected: ${u.name}`,
        detail: `${u.email} recorded ${u.aiRequestsMonth} AI requests in the window (${Math.round(u.aiCostMonthUsd * 100) / 100} USD estimated).`,
        targetUserEmail: u.email,
        detectedAt: nowIso,
      });
    }
  }

  return {
    errorRatePct,
    avgLatencyMs,
    failedJobsCount: failed.length,
    providerStatus,
    alerts,
  };
}
