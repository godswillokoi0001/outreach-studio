import { NextRequest, NextResponse } from "next/server";
import { getProvider, guessProviderId, isProviderId } from "@/lib/ai/registry";
import type { AiProviderId } from "@/lib/ai/types";
import { handleApiError } from "@/lib/api-helpers";
import { encryptSecret, maskSecret, validateApiKeyInput } from "@/lib/key-vault";
import {
  buildPublicPlatformModelList,
  getInternalPlatformPolicy,
  getUserByokPublicState,
  getUserByokVault,
  saveUserByokVault,
  toPublicPlatformPolicy,
  type InternalPersonalProvider,
} from "@/lib/platform/store-server";
import { verifyRequest } from "@/lib/server-auth";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

async function logUserKeyEvent(ownerId: string, action: string, detail: Record<string, unknown>) {
  if (!supabaseServer) return;
  await supabaseServer.from("audit_logs").insert({
    id: `key_evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    owner_id: ownerId,
    action,
    entity: "byok_key",
    entity_id: String(detail.provider ?? "ai"),
    detail,
    created_at: new Date().toISOString(),
  } as never);
}

export async function GET(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const state = await getUserByokPublicState(user.ownerId, user.email);
    return NextResponse.json({ state }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const body = (await req.json().catch(() => ({}))) as {
      action?:
        | "set_mode"
        | "select_platform_model"
        | "save_personal_key"
        | "select_personal_model"
        | "set_fallback_permission";
      mode?: "platform" | "personal";
      provider?: string;
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      models?: { id: string; label: string }[];
      id?: string;
      allowFallbackOnError?: boolean;
    };

    const vault = await getUserByokVault(user.ownerId);

    if (body.action === "set_mode") {
      const nextMode = body.mode === "personal" ? "personal" : "platform";
      if (nextMode === "personal" && vault.providers.length === 0) {
        return NextResponse.json(
          { error: "Add and save a personal API key first before switching to personal mode." },
          { status: 400 },
        );
      }
      vault.mode = nextMode;
      await saveUserByokVault(user.ownerId, vault);
      await logUserKeyEvent(user.ownerId, "ai_mode_switched", { mode: nextMode });
      const state = await getUserByokPublicState(user.ownerId, user.email);
      return NextResponse.json({ state }, { headers: { "Cache-Control": "no-store" } });
    }

    if (body.action === "select_platform_model") {
      const providerId = String(body.provider ?? "").trim().toLowerCase() as AiProviderId;
      const modelId = String(body.model ?? "").trim();
      const policy = toPublicPlatformPolicy(await getInternalPlatformPolicy());
      const allowed = buildPublicPlatformModelList(policy);
      const match = allowed.find((m) => m.provider === providerId && m.model === modelId);
      if (!match) {
        return NextResponse.json(
          { error: "That model is not enabled by the platform administrator." },
          { status: 400 },
        );
      }
      vault.selectedPlatformModel = { provider: providerId, model: modelId };
      vault.mode = "platform";
      await saveUserByokVault(user.ownerId, vault);
      const state = await getUserByokPublicState(user.ownerId, user.email);
      return NextResponse.json({ state }, { headers: { "Cache-Control": "no-store" } });
    }

    if (body.action === "save_personal_key") {
      const validated = validateApiKeyInput(body.apiKey);
      if (!validated.ok) {
        return NextResponse.json({ error: validated.error }, { status: 400 });
      }
      const requestedProvider = String(body.provider ?? "").trim().toLowerCase();
      const guessed = guessProviderId(validated.value);
      const providerId: AiProviderId | null = isProviderId(requestedProvider)
        ? requestedProvider
        : guessed;

      if (!providerId) {
        return NextResponse.json({ error: "Select a supported AI provider." }, { status: 400 });
      }

      const meta = getProvider(providerId);
      if (!meta) {
        return NextResponse.json({ error: "Unsupported AI provider." }, { status: 400 });
      }

      const encryptedKey = encryptSecret(validated.value);
      const maskedKey = maskSecret(validated.value);
      const entryId = body.id?.trim() || `byok_${providerId}_${Date.now()}`;

      const existingIdx = vault.providers.findIndex((p) => p.id === entryId || p.provider === providerId);
      const record: InternalPersonalProvider = {
        id: existingIdx >= 0 ? vault.providers[existingIdx].id : entryId,
        provider: providerId,
        label: meta.label,
        encryptedKey,
        maskedKey,
        baseUrl: body.baseUrl?.trim() || meta.baseUrl,
        model: String(body.model ?? "").trim() || meta.defaultModel,
        models:
          Array.isArray(body.models) && body.models.length > 0
            ? body.models.slice(0, 80)
            : meta.staticModels ?? [{ id: meta.defaultModel, label: meta.defaultModel }],
        verifiedAt: new Date().toISOString(),
        lastError: undefined,
      };

      const isRotation = existingIdx >= 0;
      if (isRotation) {
        vault.providers[existingIdx] = record;
      } else {
        vault.providers.push(record);
      }
      vault.activePersonalProviderId = record.id;
      vault.mode = "personal";

      await saveUserByokVault(user.ownerId, vault);
      await logUserKeyEvent(user.ownerId, isRotation ? "personal_key_rotated" : "personal_key_added", {
        provider: providerId,
        maskedKey,
      });

      const state = await getUserByokPublicState(user.ownerId, user.email);
      return NextResponse.json({ state }, { headers: { "Cache-Control": "no-store" } });
    }

    if (body.action === "select_personal_model") {
      const target = vault.providers.find((p) => p.id === body.id || p.id === vault.activePersonalProviderId);
      if (!target) {
        return NextResponse.json({ error: "Personal provider entry not found." }, { status: 404 });
      }
      if (body.model?.trim()) {
        target.model = body.model.trim().slice(0, 200);
      }
      vault.activePersonalProviderId = target.id;
      await saveUserByokVault(user.ownerId, vault);
      const state = await getUserByokPublicState(user.ownerId, user.email);
      return NextResponse.json({ state }, { headers: { "Cache-Control": "no-store" } });
    }

    if (body.action === "set_fallback_permission") {
      vault.allowFallbackOnError = Boolean(body.allowFallbackOnError);
      await saveUserByokVault(user.ownerId, vault);
      const state = await getUserByokPublicState(user.ownerId, user.email);
      return NextResponse.json({ state }, { headers: { "Cache-Control": "no-store" } });
    }

    return NextResponse.json({ error: "Unsupported AI provider action." }, { status: 400 });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const id = req.nextUrl.searchParams.get("id")?.trim();
    const vault = await getUserByokVault(user.ownerId);

    const removed = id ? vault.providers.filter((p) => p.id === id) : vault.providers;
    vault.providers = id ? vault.providers.filter((p) => p.id !== id) : [];
    if (vault.providers.length === 0) {
      vault.mode = "platform";
      vault.activePersonalProviderId = undefined;
    } else if (!vault.providers.some((p) => p.id === vault.activePersonalProviderId)) {
      vault.activePersonalProviderId = vault.providers[0].id;
    }

    await saveUserByokVault(user.ownerId, vault);
    await logUserKeyEvent(user.ownerId, "personal_key_removed", {
      count: removed.length,
      providers: removed.map((r) => r.provider),
    });

    const state = await getUserByokPublicState(user.ownerId, user.email);
    return NextResponse.json({ state }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleApiError(err);
  }
}
