import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isSafeProviderUrl } from "@/lib/ai/context";
import { handleApiError } from "@/lib/api-helpers";
import { validateApiKeyInput } from "@/lib/key-vault";
import { LLMGateway } from "@/lib/llm/gateway";
import {
  deleteUserAiKey,
  encryptGatewayKey,
  getUserAiSettings,
  listAiExecutionLogs,
  listUserAiKeys,
  saveUserAiKey,
  saveUserAiSettings,
  toUserAiKeyPublic,
} from "@/lib/llm/store";
import {
  getProviderMeta,
  guessGatewayProvider,
  normalizeGatewayProviderId,
  PROVIDER_CATALOG,
  type GatewayModelConfig,
  type UserAiKeyRecord,
} from "@/lib/llm/types";
import { verifyRequest } from "@/lib/server-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function buildPublicUserState(ownerId: string) {
  const [settings, keys, recentLogs] = await Promise.all([
    getUserAiSettings(ownerId),
    listUserAiKeys(ownerId),
    listAiExecutionLogs({ ownerId, limit: 15 }),
  ]);

  return {
    settings,
    keys: keys.map(toUserAiKeyPublic),
    catalog: PROVIDER_CATALOG,
    recentLogs,
  };
}

export async function GET(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const payload = await buildPublicUserState(user.ownerId);
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
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
        | "save_key"
        | "select_key_and_model"
        | "set_fallback"
        | "test_active";
      mode?: "system_auto" | "byok";
      keyId?: string;
      provider?: string;
      label?: string;
      apiKey?: string;
      accountId?: string;
      baseUrl?: string;
      model?: string;
      models?: GatewayModelConfig[];
      fallbackToSystemAuto?: boolean;
    };

    if (body.action === "test_active") {
      const res = await LLMGateway.testActiveModel(user.ownerId);
      const meta = getProviderMeta(res.receipt.actualProvider);
      return NextResponse.json(
        {
          verified: true,
          providerLabel: meta.label,
          receipt: res.receipt,
          reply: res.text,
        },
        { headers: { "Cache-Control": "private, no-store, max-age=0" } },
      );
    }

    if (body.action === "set_mode") {
      const nextMode = body.mode === "byok" ? "byok" : "system_auto";
      const existingKeys = await listUserAiKeys(user.ownerId);
      if (nextMode === "byok" && existingKeys.length === 0) {
        return NextResponse.json(
          { error: "Add and save an API key first before switching to BYOK mode." },
          { status: 400 },
        );
      }
      const cur = await getUserAiSettings(user.ownerId);
      const fallbackKey =
        (cur.activeKeyId ? existingKeys.find((k) => k.id === cur.activeKeyId) : undefined) ??
        existingKeys[0];
      await saveUserAiSettings(user.ownerId, {
        mode: nextMode,
        ...(nextMode === "byok" && fallbackKey
          ? {
              activeKeyId: fallbackKey.id,
              activeProvider: fallbackKey.provider,
              activeModel: cur.activeModel || fallbackKey.models[0]?.id || null,
            }
          : {}),
      });
      return NextResponse.json(await buildPublicUserState(user.ownerId), {
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      });
    }

    if (body.action === "save_key") {
      const validated = validateApiKeyInput(body.apiKey);
      if (!validated.ok) {
        return NextResponse.json({ error: validated.error }, { status: 400 });
      }
      const requestedProvider = String(body.provider ?? "").trim();
      const guessed = guessGatewayProvider(validated.value);
      const provider =
        !requestedProvider || requestedProvider === "auto"
          ? guessed ?? "google"
          : normalizeGatewayProviderId(requestedProvider).provider;
      const meta = getProviderMeta(provider);

      const baseUrl = (body.baseUrl ?? "").trim() || meta.baseUrl || null;
      if (baseUrl && !isSafeProviderUrl(baseUrl)) {
        return NextResponse.json(
          { error: "Use a public http(s) endpoint URL." },
          { status: 400 },
        );
      }

      const { encryptedKey, maskedKey } = encryptGatewayKey(validated.value);
      const now = new Date().toISOString();
      const keyId =
        body.keyId?.trim() || `ukey_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;

      const models: GatewayModelConfig[] =
        Array.isArray(body.models) && body.models.length > 0
          ? body.models.slice(0, 100)
          : meta.defaultModels;

      const selectedModel =
        (body.model ?? "").trim() || models[0]?.id || meta.defaultModels[0]?.id || "auto";

      const record: UserAiKeyRecord = {
        id: keyId,
        ownerId: user.ownerId,
        provider,
        label: (body.label ?? "").trim() || meta.label,
        encryptedKey,
        maskedKey,
        accountId: body.accountId?.trim() || null,
        baseUrl,
        models,
        lastVerifiedAt: now,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      };

      await saveUserAiKey(user.ownerId, record);
      await saveUserAiSettings(user.ownerId, {
        mode: "byok",
        activeKeyId: record.id,
        activeProvider: provider,
        activeModel: selectedModel,
      });

      return NextResponse.json(await buildPublicUserState(user.ownerId), {
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      });
    }

    if (body.action === "select_key_and_model") {
      const keys = await listUserAiKeys(user.ownerId);
      const chosen =
        (body.keyId ? keys.find((k) => k.id === body.keyId) : undefined) ?? keys[0];
      if (!chosen) {
        return NextResponse.json({ error: "Saved API key not found." }, { status: 404 });
      }
      const chosenModel =
        (body.model ?? "").trim() || chosen.models[0]?.id || getProviderMeta(chosen.provider).defaultModels[0]?.id || "";
      await saveUserAiSettings(user.ownerId, {
        mode: "byok",
        activeKeyId: chosen.id,
        activeProvider: chosen.provider,
        activeModel: chosenModel,
      });
      return NextResponse.json(await buildPublicUserState(user.ownerId), {
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      });
    }

    if (body.action === "set_fallback") {
      await saveUserAiSettings(user.ownerId, {
        fallbackToSystemAuto: Boolean(body.fallbackToSystemAuto),
      });
      return NextResponse.json(await buildPublicUserState(user.ownerId), {
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      });
    }

    return NextResponse.json({ error: "Unsupported AI setting action." }, { status: 400 });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const keyId = req.nextUrl.searchParams.get("id")?.trim();
    if (!keyId) {
      return NextResponse.json({ error: "Key id is required." }, { status: 400 });
    }

    await deleteUserAiKey(user.ownerId, keyId);
    const remaining = await listUserAiKeys(user.ownerId);
    const cur = await getUserAiSettings(user.ownerId);
    if (cur.activeKeyId === keyId || remaining.length === 0) {
      await saveUserAiSettings(user.ownerId, {
        mode: remaining.length > 0 && cur.mode === "byok" ? "byok" : "system_auto",
        activeKeyId: remaining[0]?.id ?? null,
        activeProvider: remaining[0]?.provider ?? null,
        activeModel: remaining[0]?.models[0]?.id ?? null,
      });
    }

    return NextResponse.json(await buildPublicUserState(user.ownerId), {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
