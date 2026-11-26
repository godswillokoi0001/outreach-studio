import { NextRequest, NextResponse } from "next/server";
import { detectProvider } from "@/lib/ai/chat";
import { getProvider } from "@/lib/ai/registry";
import type { AiProviderId } from "@/lib/ai/types";
import { handleApiError } from "@/lib/api-helpers";
import { encryptSecret, maskSecret, validateApiKeyInput } from "@/lib/key-vault";
import { requireAdmin } from "@/lib/platform/admin-auth";
import {
  appendAdminAuditLog,
  checkKeyTestRateLimit,
  decryptPlatformProviderKey,
  getInternalPlatformPolicy,
  listAiUsageEvents,
  saveInternalPlatformPolicy,
  toPublicPlatformPolicy,
} from "@/lib/platform/store-server";
import type { AiFeatureKey, PlatformModelOption, PlatformQuotaConfig } from "@/lib/platform/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    // Only admin and super_admin can view platform providers, models & billing usage.
    await requireAdmin(req, "admin");

    const [internalPolicy, usageEvents] = await Promise.all([
      getInternalPlatformPolicy(),
      listAiUsageEvents({ sinceIso: new Date(Date.now() - 30 * 86400_000).toISOString(), limit: 3000 }),
    ]);

    const byProvider: Record<string, { requests: number; tokens: number; costUsd: number; errors: number }> = {};
    const byModel: Record<string, { requests: number; tokens: number; costUsd: number }> = {};
    const byFeature: Record<string, { requests: number; tokens: number; costUsd: number }> = {};
    const byUser: Record<string, { email: string; requests: number; costUsd: number; source: string }> = {};

    for (const ev of usageEvents) {
      const tokens = ev.tokensIn + ev.tokensOut;
      if (!byProvider[ev.provider]) byProvider[ev.provider] = { requests: 0, tokens: 0, costUsd: 0, errors: 0 };
      byProvider[ev.provider].requests += 1;
      byProvider[ev.provider].tokens += tokens;
      byProvider[ev.provider].costUsd += ev.costUsd;
      if (!ev.success) byProvider[ev.provider].errors += 1;

      const mKey = `${ev.provider} / ${ev.model}`;
      if (!byModel[mKey]) byModel[mKey] = { requests: 0, tokens: 0, costUsd: 0 };
      byModel[mKey].requests += 1;
      byModel[mKey].tokens += tokens;
      byModel[mKey].costUsd += ev.costUsd;

      if (!byFeature[ev.feature]) byFeature[ev.feature] = { requests: 0, tokens: 0, costUsd: 0 };
      byFeature[ev.feature].requests += 1;
      byFeature[ev.feature].tokens += tokens;
      byFeature[ev.feature].costUsd += ev.costUsd;

      if (ev.source === "platform") {
        if (!byUser[ev.ownerId]) {
          byUser[ev.ownerId] = { email: ev.userEmail, requests: 0, costUsd: 0, source: "platform" };
        }
        byUser[ev.ownerId].requests += 1;
        byUser[ev.ownerId].costUsd += ev.costUsd;
      }
    }

    return NextResponse.json(
      {
        policy: toPublicPlatformPolicy(internalPolicy),
        breakdown: {
          byProvider,
          byModel,
          byFeature,
          byUser: Object.entries(byUser)
            .map(([ownerId, info]) => ({ ownerId, ...info }))
            .sort((a, b) => b.costUsd - a.costUsd)
            .slice(0, 25),
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?:
        | "upsert_key"
        | "toggle_provider"
        | "delete_key"
        | "test_connection"
        | "update_models"
        | "update_routing";
      provider?: AiProviderId;
      apiKey?: string;
      baseUrl?: string;
      enabled?: boolean;
      models?: PlatformModelOption[];
      featureDefaults?: Record<AiFeatureKey, { provider: AiProviderId; model: string }>;
      fallbackChain?: { provider: AiProviderId; model: string }[];
      quotas?: PlatformQuotaConfig;
      totpCode?: string;
    };

    const { user, meta } = await requireAdmin(req, "super_admin", {
      requireReauth: true,
      inlineTotpCode: body.totpCode,
    });

    const policy = await getInternalPlatformPolicy();

    if (body.action === "upsert_key") {
      const providerId = body.provider;
      const prov = policy.providers.find((p) => p.id === providerId);
      if (!prov) return NextResponse.json({ error: "Unsupported AI provider." }, { status: 400 });

      const validated = validateApiKeyInput(body.apiKey);
      if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 400 });

      const wasPresent = Boolean(prov.encryptedKey);
      prov.encryptedKey = encryptSecret(validated.value);
      prov.maskedKey = maskSecret(validated.value);
      if (body.baseUrl?.trim()) prov.baseUrl = body.baseUrl.trim();
      prov.enabled = true;
      prov.updatedAt = new Date().toISOString();

      const saved = await saveInternalPlatformPolicy(policy);
      await appendAdminAuditLog({
        actorId: user.ownerId,
        actorEmail: user.email,
        actorRole: meta.role,
        action: wasPresent ? "platform_key_rotated" : "platform_key_added",
        targetType: "platform_provider",
        targetId: prov.id,
        details: { maskedKey: prov.maskedKey },
        req,
      });

      return NextResponse.json({ policy: saved }, { headers: { "Cache-Control": "no-store" } });
    }

    if (body.action === "toggle_provider") {
      const prov = policy.providers.find((p) => p.id === body.provider);
      if (!prov) return NextResponse.json({ error: "Provider not found." }, { status: 404 });
      prov.enabled = Boolean(body.enabled);
      prov.updatedAt = new Date().toISOString();
      const saved = await saveInternalPlatformPolicy(policy);
      await appendAdminAuditLog({
        actorId: user.ownerId,
        actorEmail: user.email,
        actorRole: meta.role,
        action: prov.enabled ? "platform_provider_enabled" : "platform_provider_disabled",
        targetType: "platform_provider",
        targetId: prov.id,
        req,
      });
      return NextResponse.json({ policy: saved });
    }

    if (body.action === "delete_key") {
      const prov = policy.providers.find((p) => p.id === body.provider);
      if (!prov) return NextResponse.json({ error: "Provider not found." }, { status: 404 });
      prov.encryptedKey = "";
      prov.maskedKey = "";
      prov.enabled = false;
      prov.updatedAt = new Date().toISOString();
      const saved = await saveInternalPlatformPolicy(policy);
      await appendAdminAuditLog({
        actorId: user.ownerId,
        actorEmail: user.email,
        actorRole: meta.role,
        action: "platform_key_deleted",
        targetType: "platform_provider",
        targetId: prov.id,
        req,
      });
      return NextResponse.json({ policy: saved });
    }

    if (body.action === "test_connection") {
      const rl = checkKeyTestRateLimit(`admin:${user.ownerId}`);
      if (!rl.allowed) {
        return NextResponse.json(
          { error: `Rate limit reached. Wait ${rl.retryAfterSec}s before testing again.` },
          { status: 429 },
        );
      }

      const prov = policy.providers.find((p) => p.id === body.provider);
      if (!prov) return NextResponse.json({ error: "Provider not found." }, { status: 404 });
      const provMeta = getProvider(prov.id);
      const key = body.apiKey?.trim() || decryptPlatformProviderKey(policy, prov.id);
      if (!key) {
        return NextResponse.json({ error: "No key is saved for this provider." }, { status: 400 });
      }

      const defaultModel =
        prov.models.find((m) => m.enabled)?.id || prov.models[0]?.id || provMeta?.defaultModel || "gemini-2.5-flash";

      try {
        const res = await detectProvider({
          provider: prov.id,
          model: defaultModel,
          apiKey: key,
          ...(prov.baseUrl ? { baseUrl: prov.baseUrl } : {}),
        });
        prov.lastTestedAt = new Date().toISOString();
        prov.lastTestOk = true;
        prov.lastTestError = undefined;
        // Merge discovered live models while preserving admin's enabled toggles & custom display names
        if (res.models.length > 0) {
          const existingMap = new Map(prov.models.map((m) => [m.id, m]));
          prov.models = res.models.slice(0, 60).map((live) => {
            const old = existingMap.get(live.id);
            return {
              id: live.id,
              displayName: old?.displayName || live.label || live.id,
              enabled: old ? old.enabled : prov.models.length === 0 || live.id === defaultModel,
              inputCostPer1M: old?.inputCostPer1M ?? 0.25,
              outputCostPer1M: old?.outputCostPer1M ?? 1.0,
            };
          });
        }
        const saved = await saveInternalPlatformPolicy(policy);
        await appendAdminAuditLog({
          actorId: user.ownerId,
          actorEmail: user.email,
          actorRole: meta.role,
          action: "platform_provider_tested",
          targetType: "platform_provider",
          targetId: prov.id,
          details: { ok: true, modelCount: res.models.length, ms: res.probe.ms },
          req,
        });
        return NextResponse.json({ policy: saved, probe: res.probe });
      } catch (err) {
        prov.lastTestedAt = new Date().toISOString();
        prov.lastTestOk = false;
        prov.lastTestError = err instanceof Error ? err.message : "Test connection failed.";
        await saveInternalPlatformPolicy(policy);
        await appendAdminAuditLog({
          actorId: user.ownerId,
          actorEmail: user.email,
          actorRole: meta.role,
          action: "platform_provider_test_failed",
          targetType: "platform_provider",
          targetId: prov.id,
          details: { error: prov.lastTestError },
          req,
        });
        return NextResponse.json({ error: prov.lastTestError }, { status: 400 });
      }
    }

    if (body.action === "update_models") {
      const prov = policy.providers.find((p) => p.id === body.provider);
      if (!prov) return NextResponse.json({ error: "Provider not found." }, { status: 404 });
      if (Array.isArray(body.models)) {
        prov.models = body.models.map((m) => ({
          id: String(m.id).trim(),
          displayName: String(m.displayName || m.id).trim().slice(0, 120),
          enabled: Boolean(m.enabled),
          inputCostPer1M: Number(m.inputCostPer1M ?? 0.25),
          outputCostPer1M: Number(m.outputCostPer1M ?? 1.0),
        }));
      }
      const saved = await saveInternalPlatformPolicy(policy);
      await appendAdminAuditLog({
        actorId: user.ownerId,
        actorEmail: user.email,
        actorRole: meta.role,
        action: "platform_models_updated",
        targetType: "platform_provider",
        targetId: prov.id,
        details: { enabledCount: prov.models.filter((m) => m.enabled).length },
        req,
      });
      return NextResponse.json({ policy: saved });
    }

    if (body.action === "update_routing") {
      if (body.featureDefaults) policy.featureDefaults = body.featureDefaults;
      if (Array.isArray(body.fallbackChain)) policy.fallbackChain = body.fallbackChain;
      if (body.quotas) policy.quotas = { ...policy.quotas, ...body.quotas };

      const saved = await saveInternalPlatformPolicy(policy);
      await appendAdminAuditLog({
        actorId: user.ownerId,
        actorEmail: user.email,
        actorRole: meta.role,
        action: "platform_routing_and_quotas_updated",
        targetType: "platform_policy",
        targetId: "global",
        details: { quotas: saved.quotas },
        req,
      });
      return NextResponse.json({ policy: saved });
    }

    return NextResponse.json({ error: "Unknown provider action." }, { status: 400 });
  } catch (err) {
    return handleApiError(err);
  }
}
