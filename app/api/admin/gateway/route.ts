import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isSafeProviderUrl } from "@/lib/ai/context";
import { handleApiError } from "@/lib/api-helpers";
import { validateApiKeyInput } from "@/lib/key-vault";
import { summarizeKeyAnalytics } from "@/lib/llm/analytics";
import { LLMGateway } from "@/lib/llm/gateway";
import { fetchProviderCatalogModels } from "@/lib/llm/providers";
import { clearAllInMemoryModelCooldowns, evaluateKeyHeadroom } from "@/lib/llm/router";
import {
  decryptStoredGatewayKey,
  deleteAdminAiKey,
  encryptGatewayKey,
  getAdminAiSettings,
  listAdminAiKeys,
  listAdminSearchKeys,
  listAdminSearchKeysPublic,
  listAiExecutionLogs,
  persistAdminKeyHealth,
  saveAdminAiKey,
  saveAdminAiSettings,
  saveAdminSearchKey,
  toggleAdminSearchKey,
  toAdminAiKeyPublic,
  updateAdminSearchKey,
} from "@/lib/llm/store";
import {
  getProviderMeta,
  getSearchProviderMeta,
  isSearchProviderId,
  normalizeGatewayProviderId,
  PROVIDER_CATALOG,
  SEARCH_PROVIDER_CATALOG,
  type AdminAiKeyRecord,
  type GatewayModelConfig,
  type GatewayProviderId,
  type RoutingStrategy,
} from "@/lib/llm/types";
import { requireAdmin } from "@/lib/platform/admin-auth";
import { appendAdminAuditLog } from "@/lib/platform/store-server";
import { buildSearchProviderStates } from "@/lib/search/providerStatus";
import {
  getSearchQuotaMonitorSnapshot,
  resetSearchProviderQuota,
  setSearchProviderQuotaLimit,
  type QuotaTrackedProviderId,
} from "@/lib/search/quotaAndCache";
import { verifySearchKey } from "@/lib/search/webSearch";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function buildAdminGatewayPayload() {
  const [settings, keys, searchKeys, executionLogs, quotaSnap] = await Promise.all([
    getAdminAiSettings(),
    listAdminAiKeys(),
    listAdminSearchKeysPublic(),
    listAiExecutionLogs({ limit: 35 }),
    getSearchQuotaMonitorSnapshot(),
  ]);

  const enrichedKeys = keys.map((k) => {
    const pub = toAdminAiKeyPublic(k);
    const headroom = evaluateKeyHeadroom(k);
    return {
      ...pub,
      rpmUsed: headroom.rpmUsed,
      rpdUsed: headroom.rpdUsed,
    };
  });

  return {
    settings,
    keys: enrichedKeys,
    catalog: PROVIDER_CATALOG,
    searchKeys,
    searchCatalog: SEARCH_PROVIDER_CATALOG,
    searchQuotas: quotaSnap.quotas,
    searchProviderStates: buildSearchProviderStates({
      keys: searchKeys,
      quotas: quotaSnap.quotas,
    }),
    totalCacheHitsSaved: quotaSnap.totalCacheHitsSaved,
    builtInSearchStatus: "Built-in Keyless Fallback: DuckDuckGo + OpenStreetMap + DNS MX Ready",
    executionLogs,
  };
}

async function buildKeyAnalytics(keyId: string | null, provider: string | null) {
  const logs = await listAiExecutionLogs({
    limit: 300,
    ...(keyId ? { actualKeyId: keyId } : provider ? { actualProvider: provider } : {}),
  });
  return summarizeKeyAnalytics({ logs, keyId, provider: keyId ? null : provider });
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req, "admin");
    const action = req.nextUrl.searchParams.get("action");
    const headers = { "Cache-Control": "private, no-store, max-age=0" };

    if (action === "key_analytics") {
      const keyId = req.nextUrl.searchParams.get("keyId")?.trim() || null;
      const provider = req.nextUrl.searchParams.get("provider")?.trim().toLowerCase() || null;
      return NextResponse.json(
        { ok: true, analytics: await buildKeyAnalytics(keyId, provider) },
        { headers },
      );
    }

    if (action === "search_key_analytics") {
      const provider = req.nextUrl.searchParams.get("provider")?.trim().toLowerCase() || "";
      if (!provider) {
        return NextResponse.json({ error: "provider required." }, { status: 400 });
      }
      const [searchKeys, quotaSnap] = await Promise.all([
        listAdminSearchKeysPublic(),
        getSearchQuotaMonitorSnapshot(),
      ]);
      const states = buildSearchProviderStates({ keys: searchKeys, quotas: quotaSnap.quotas });
      const state = states.find((s) => s.provider === provider);
      if (!state) return NextResponse.json({ error: "Unknown provider." }, { status: 404 });
      const calls = state.quota.used + state.quota.cacheHits;
      return NextResponse.json(
        {
          ok: true,
          analytics: {
            provider: state.provider,
            status: state.status,
            used: state.quota.used,
            limit: state.quota.limit,
            resetCycle: state.quota.resetCycle,
            nextResetAt: state.quota.nextResetAt,
            cacheHitsSaved: state.quota.cacheHits,
            hitRate: calls > 0 ? Math.round((state.quota.cacheHits / calls) * 1000) / 10 : null,
            recentLogs: [],
          },
          state,
        },
        { headers },
      );
    }

    return NextResponse.json(await buildAdminGatewayPayload(), { headers });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?:
        | "update_settings"
        | "add_key"
        | "update_key"
        | "toggle_key"
        | "clear_cooldown"
        | "clear_all_cooldowns"
        | "delete_key"
        | "fetch_models"
        | "test_key"
        | "add_search_key"
        | "update_search_key"
        | "toggle_search_key"
        | "test_search_key"
        | "delete_search_key"
        | "reset_search_quota"
        | "update_search_quota";
      masterMode?: "auto" | "manual";
      strategy?: RoutingStrategy;
      fallbackChain?: { provider: GatewayProviderId; model: string }[];
      keyId?: string;
      provider?: string;
      label?: string;
      apiKey?: string;
      accountId?: string;
      baseUrl?: string;
      enabled?: boolean;
      rpmLimit?: number;
      rpdLimit?: number;
      models?: GatewayModelConfig[];
      freeTierOnly?: boolean;
      quotaLimit?: number;
      totpCode?: string;
    };

    const readOnlyAction =
      body.action === "fetch_models" ||
      body.action === "test_key" ||
      body.action === "test_search_key";
    const ctx = await requireAdmin(req, readOnlyAction ? "admin" : "super_admin", {
      requireReauth: !readOnlyAction,
      inlineTotpCode: body.totpCode,
    });

    if (body.action === "test_search_key") {
      let provider = isSearchProviderId(body.provider) ? body.provider : "tavily";
      let apiKey = (body.apiKey ?? "").trim();
      if (body.keyId && !apiKey) {
        const found = (await listAdminSearchKeys()).find((k) => k.id === body.keyId);
        if (!found) return NextResponse.json({ error: "Search key not found." }, { status: 404 });
        provider = found.provider;
        apiKey = found.apiKey;
      }
      const res = await verifySearchKey({ provider, apiKey });
      return NextResponse.json({
        ok: true,
        probe: { model: `${getSearchProviderMeta(provider).label} (${res.count} results)`, ms: res.ms },
        payload: await buildAdminGatewayPayload(),
      });
    }

    if (body.action === "reset_search_quota") {
      const target = String(body.provider ?? "").trim().toLowerCase();
      if (!isSearchProviderId(target) && target !== "duckduckgo" && target !== "osm") {
        return NextResponse.json({ error: "Invalid search provider." }, { status: 400 });
      }
      await resetSearchProviderQuota(target as QuotaTrackedProviderId);
      await appendAdminAuditLog({
        actorId: ctx.admin.id,
        actorEmail: ctx.admin.email,
        actorRole: ctx.admin.role,
        action: "search_quota_reset",
        targetType: "search_provider_quotas",
        targetId: target,
        req,
      });
      return NextResponse.json(await buildAdminGatewayPayload());
    }

    if (body.action === "update_search_quota") {
      if (!isSearchProviderId(body.provider)) {
        return NextResponse.json({ error: "Invalid search provider." }, { status: 400 });
      }
      const limit = Number(body.quotaLimit);
      if (!Number.isFinite(limit) || limit < 0) {
        return NextResponse.json({ error: "A non-negative quota limit is required." }, { status: 400 });
      }
      const rec = await setSearchProviderQuotaLimit(body.provider, limit);
      await appendAdminAuditLog({
        actorId: ctx.admin.id,
        actorEmail: ctx.admin.email,
        actorRole: ctx.admin.role,
        action: "search_quota_limit_updated",
        targetType: "search_provider_quotas",
        targetId: body.provider,
        details: { quotaLimit: rec.quotaLimit },
        req,
      });
      return NextResponse.json(await buildAdminGatewayPayload());
    }

    if (body.action === "add_search_key") {
      if (!isSearchProviderId(body.provider)) {
        return NextResponse.json({ error: "Select Exa, Tavily, Firecrawl, Serper, Brave, Jina, PageSpeed, Hunter, or CUFinder." }, { status: 400 });
      }
      const check = validateApiKeyInput(body.apiKey);
      if (!check.ok) {
        return NextResponse.json({ error: check.error }, { status: 400 });
      }
      const meta = getSearchProviderMeta(body.provider);
      const { encryptedKey, maskedKey } = encryptGatewayKey(check.value);
      const id = `srch_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
      const label = (body.label ?? "").trim() || `${meta.label} (${maskedKey})`;
      await saveAdminSearchKey({
        id,
        provider: body.provider,
        label,
        encryptedKey,
        maskedKey,
        enabled: true,
      });
      await appendAdminAuditLog({
        actorId: ctx.admin.id,
        actorEmail: ctx.admin.email,
        actorRole: ctx.admin.role,
        action: "search_key_added",
        targetType: "admin_ai_keys",
        targetId: id,
        details: { provider: body.provider, maskedKey, label },
        req,
      });
      return NextResponse.json(await buildAdminGatewayPayload(), { status: 201 });
    }

    if (body.action === "update_search_key") {
      const keyId = String(body.keyId ?? "").trim();
      if (!keyId) return NextResponse.json({ error: "keyId required." }, { status: 400 });
      const existing = (await listAdminSearchKeys()).find((k) => k.id === keyId);
      if (!existing) return NextResponse.json({ error: "Search key not found." }, { status: 404 });

      let encryptedKey: string | undefined;
      let maskedKey: string | undefined;
      if (String(body.apiKey ?? "").trim()) {
        const check = validateApiKeyInput(body.apiKey);
        if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
        const enc = encryptGatewayKey(check.value);
        encryptedKey = enc.encryptedKey;
        maskedKey = enc.maskedKey;
      }
      await updateAdminSearchKey({
        id: keyId,
        label: body.label,
        encryptedKey,
        maskedKey,
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      });
      await appendAdminAuditLog({
        actorId: ctx.admin.id,
        actorEmail: ctx.admin.email,
        actorRole: ctx.admin.role,
        action: encryptedKey ? "search_key_rotated" : "search_key_updated",
        targetType: "admin_ai_keys",
        targetId: keyId,
        details: { provider: existing.provider, maskedKey: maskedKey ?? null, label: body.label ?? null },
        req,
      });
      return NextResponse.json(await buildAdminGatewayPayload());
    }

    if (body.action === "toggle_search_key") {
      const keyId = String(body.keyId ?? "").trim();
      if (!keyId) return NextResponse.json({ error: "keyId required." }, { status: 400 });
      await toggleAdminSearchKey(keyId, Boolean(body.enabled));
      await appendAdminAuditLog({
        actorId: ctx.admin.id,
        actorEmail: ctx.admin.email,
        actorRole: ctx.admin.role,
        action: "search_key_toggled",
        targetType: "admin_ai_keys",
        targetId: keyId,
        req,
      });
      return NextResponse.json(await buildAdminGatewayPayload());
    }

    if (body.action === "delete_search_key") {
      const keyId = String(body.keyId ?? "").trim();
      if (!keyId) return NextResponse.json({ error: "keyId required." }, { status: 400 });
      await deleteAdminAiKey(keyId);
      await appendAdminAuditLog({
        actorId: ctx.admin.id,
        actorEmail: ctx.admin.email,
        actorRole: ctx.admin.role,
        action: "search_key_deleted",
        targetType: "admin_ai_keys",
        targetId: keyId,
        req,
      });
      return NextResponse.json(await buildAdminGatewayPayload());
    }

    if (body.action === "update_settings") {
      await saveAdminAiSettings({
        masterMode: body.masterMode === "manual" ? "manual" : "auto",
        strategy: (["balanced", "smartest", "fastest", "reliable"].includes(String(body.strategy))
          ? body.strategy
          : "balanced") as RoutingStrategy,
        ...(Array.isArray(body.fallbackChain) ? { fallbackChain: body.fallbackChain } : {}),
      });
      await appendAdminAuditLog({
        actorId: ctx.admin.id,
        actorEmail: ctx.admin.email,
        actorRole: ctx.admin.role,
        action: "gateway_settings_updated",
        targetType: "admin_ai_settings",
        targetId: "default",
        details: { masterMode: body.masterMode, strategy: body.strategy },
        req,
      });
      return NextResponse.json(await buildAdminGatewayPayload());
    }

    if (body.action === "fetch_models") {
      let provider: GatewayProviderId = "google";
      let apiKey = (body.apiKey ?? "").trim();
      let accountId = body.accountId?.trim() || null;
      let baseUrl = body.baseUrl?.trim() || null;

      if (body.keyId && !apiKey) {
        const existing = (await listAdminAiKeys()).find((k) => k.id === body.keyId);
        if (!existing) {
          return NextResponse.json({ error: "Key not found." }, { status: 404 });
        }
        provider = existing.provider;
        apiKey = decryptStoredGatewayKey(existing.encryptedKey);
        accountId = existing.accountId ?? null;
        baseUrl = existing.baseUrl ?? null;
      } else {
        provider = normalizeGatewayProviderId(body.provider).provider;
      }

      if (!apiKey) {
        return NextResponse.json({ error: "Paste or select an API key first." }, { status: 400 });
      }
      if (baseUrl && !isSafeProviderUrl(baseUrl)) {
        return NextResponse.json({ error: "Public http(s) URL required." }, { status: 400 });
      }

      const models = await fetchProviderCatalogModels({
        provider,
        apiKey,
        accountId,
        baseUrl,
        freeTierOnly: body.freeTierOnly ?? getProviderMeta(provider).freeTierDefault,
      });

      if (body.keyId) {
        const existing = (await listAdminAiKeys()).find((k) => k.id === body.keyId);
        if (existing) {
          const prevEnabled = new Map(existing.models.map((m) => [m.id, m.enabled]));
          const mergedModels = models.map((m) => ({
            ...m,
            enabled: prevEnabled.has(m.id) ? Boolean(prevEnabled.get(m.id)) : m.enabled,
          }));
          await saveAdminAiKey({ ...existing, models: mergedModels });
        }
      }

      return NextResponse.json({ models, payload: await buildAdminGatewayPayload() });
    }

    if (body.action === "test_key") {
      if (body.keyId && !body.apiKey) {
        const existing = (await listAdminAiKeys()).find((k) => k.id === body.keyId);
        if (!existing) {
          return NextResponse.json({ error: "Pooled key not found." }, { status: 404 });
        }
        const plaintext = decryptStoredGatewayKey(existing.encryptedKey);
        try {
          const verified = await LLMGateway.verifyAndFetchModels({
            provider: existing.provider,
            apiKey: plaintext,
            accountId: existing.accountId,
            baseUrl: existing.baseUrl,
            preferredModel: existing.models.find((m) => m.enabled)?.id,
          });
          await persistAdminKeyHealth(existing.id, {
            healthStatus: "healthy",
            cooldownUntil: null,
            cooldownStep: 0,
            lastError: null,
          });
          return NextResponse.json({
            ok: true,
            probe: verified.probe,
            warning: verified.warning,
            payload: await buildAdminGatewayPayload(),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Probe failed";
          await persistAdminKeyHealth(existing.id, {
            healthStatus: /401|403|invalid|rejected/i.test(msg) ? "invalid" : "cooldown",
            cooldownUntil: new Date(Date.now() + 2 * 60_000).toISOString(),
            cooldownStep: 1,
            lastError: msg,
          });
          return NextResponse.json(
            { ok: false, error: msg, payload: await buildAdminGatewayPayload() },
            { status: 400 },
          );
        }
      }

      const verified = await LLMGateway.verifyAndFetchModels({
        provider: String(body.provider || "google"),
        apiKey: String(body.apiKey || ""),
        accountId: body.accountId?.trim() || null,
        baseUrl: body.baseUrl?.trim() || null,
      });
      return NextResponse.json({ ok: true, ...verified });
    }

    if (body.action === "add_key") {
      const check = validateApiKeyInput(body.apiKey);
      if (!check.ok) {
        return NextResponse.json({ error: check.error }, { status: 400 });
      }
      const provider = normalizeGatewayProviderId(body.provider).provider;
      const meta = getProviderMeta(provider);
      const baseUrl = (body.baseUrl ?? "").trim() || meta.baseUrl || null;
      if (baseUrl && !isSafeProviderUrl(baseUrl)) {
        return NextResponse.json({ error: "Public http(s) base URL required." }, { status: 400 });
      }
      if (meta.requiresAccountId && !String(body.accountId ?? "").trim() && !check.value.includes(":")) {
        return NextResponse.json({ error: "Cloudflare Workers AI requires your Account ID." }, { status: 400 });
      }

      const { encryptedKey, maskedKey } = encryptGatewayKey(check.value);
      const now = new Date().toISOString();
      const rec: AdminAiKeyRecord = {
        id: `admkey_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`,
        provider,
        label: (body.label ?? "").trim() || `${meta.label} (${maskedKey})`,
        encryptedKey,
        maskedKey,
        accountId: body.accountId?.trim() || null,
        baseUrl,
        enabled: true,
        models:
          Array.isArray(body.models) && body.models.length > 0
            ? body.models.slice(0, 100)
            : meta.defaultModels,
        rpmLimit: Math.max(1, Math.min(10000, Number(body.rpmLimit ?? meta.defaultRpmLimit))),
        rpdLimit: Math.max(1, Math.min(1000000, Number(body.rpdLimit ?? meta.defaultRpdLimit))),
        healthStatus: "healthy",
        cooldownUntil: null,
        cooldownStep: 0,
        lastError: null,
        lastCheckedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      await saveAdminAiKey(rec);
      await appendAdminAuditLog({
        actorId: ctx.admin.id,
        actorEmail: ctx.admin.email,
        actorRole: ctx.admin.role,
        action: "gateway_key_added",
        targetType: "admin_ai_keys",
        targetId: rec.id,
        details: { provider, maskedKey, label: rec.label },
        req,
      });
      return NextResponse.json(await buildAdminGatewayPayload(), { status: 201 });
    }

    if (body.action === "clear_all_cooldowns") {
      clearAllInMemoryModelCooldowns();
      const allKeys = await listAdminAiKeys();
      const clearedIds: string[] = [];
      for (const k of allKeys) {
        if (k.healthStatus !== "healthy" || k.cooldownUntil) {
          clearedIds.push(k.id);
          await persistAdminKeyHealth(k.id, {
            healthStatus: "healthy",
            cooldownUntil: null,
            cooldownStep: 0,
            lastError: null,
          });
        }
      }
      await appendAdminAuditLog({
        actorId: ctx.admin.id,
        actorEmail: ctx.admin.email,
        actorRole: ctx.admin.role,
        action: "gateway_all_cooldowns_cleared",
        targetType: "admin_ai_keys",
        targetId: "all",
        details: { clearedCount: clearedIds.length, clearedIds },
        req,
      });
      return NextResponse.json(await buildAdminGatewayPayload());
    }

    if (body.action === "update_key" || body.action === "toggle_key" || body.action === "clear_cooldown") {
      const existing = (await listAdminAiKeys()).find((k) => k.id === body.keyId);
      if (!existing) {
        return NextResponse.json({ error: "Key not found." }, { status: 404 });
      }
      if (body.action === "clear_cooldown") {
        await persistAdminKeyHealth(existing.id, {
          healthStatus: "healthy",
          cooldownUntil: null,
          cooldownStep: 0,
          lastError: null,
        });
      } else {
        let rotated: { encryptedKey: string; maskedKey: string } | null = null;
        if (String(body.apiKey ?? "").trim()) {
          const check = validateApiKeyInput(body.apiKey);
          if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
          rotated = encryptGatewayKey(check.value);
        }
        const updated: AdminAiKeyRecord = {
          ...existing,
          ...(body.label?.trim() ? { label: body.label.trim() } : {}),
          ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
          ...(typeof body.rpmLimit === "number" ? { rpmLimit: Math.max(1, body.rpmLimit) } : {}),
          ...(typeof body.rpdLimit === "number" ? { rpdLimit: Math.max(1, body.rpdLimit) } : {}),
          ...(Array.isArray(body.models) ? { models: body.models.slice(0, 120) } : {}),
          ...(rotated
            ? {
                encryptedKey: rotated.encryptedKey,
                maskedKey: rotated.maskedKey,
                healthStatus: "healthy" as const,
                cooldownUntil: null,
                cooldownStep: 0,
                lastError: null,
                lastCheckedAt: new Date().toISOString(),
              }
            : {}),
          updatedAt: new Date().toISOString(),
        };
        await saveAdminAiKey(updated);
      }
      await appendAdminAuditLog({
        actorId: ctx.admin.id,
        actorEmail: ctx.admin.email,
        actorRole: ctx.admin.role,
        action: `gateway_key_${body.action}`,
        targetType: "admin_ai_keys",
        targetId: existing.id,
        req,
      });
      return NextResponse.json(await buildAdminGatewayPayload());
    }

    if (body.action === "delete_key") {
      const keyId = String(body.keyId ?? "").trim();
      if (!keyId) return NextResponse.json({ error: "keyId required." }, { status: 400 });
      await deleteAdminAiKey(keyId);
      await appendAdminAuditLog({
        actorId: ctx.admin.id,
        actorEmail: ctx.admin.email,
        actorRole: ctx.admin.role,
        action: "gateway_key_deleted",
        targetType: "admin_ai_keys",
        targetId: keyId,
        req,
      });
      return NextResponse.json(await buildAdminGatewayPayload());
    }

    return NextResponse.json({ error: "Unsupported gateway action." }, { status: 400 });
  } catch (err) {
    return handleApiError(err);
  }
}
