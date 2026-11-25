import { NextRequest, NextResponse } from "next/server";
import { detectProvider } from "@/lib/ai/chat";
import { isSafeProviderUrl } from "@/lib/ai/context";
import { getProvider, guessProviderId, isProviderId, pickRecommendedModel, publicProviderList } from "@/lib/ai/registry";
import type { AiConfig, AiProviderId } from "@/lib/ai/types";
import { handleApiError } from "@/lib/api-helpers";
import { verifyRequest } from "@/lib/server-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    await verifyRequest(req);
    return NextResponse.json({ providers: publicProviderList() }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleApiError(err);
  }
}

/**
 * Verifies a pasted key, works out which provider it belongs to when the user
 * did not pick one, and returns that provider's live model catalogue.
 */
export async function POST(req: NextRequest) {
  try {
    await verifyRequest(req);
    const body = (await req.json().catch(() => ({}))) as {
      provider?: string;
      apiKey?: string;
      baseUrl?: string;
      model?: string;
    };

    const apiKey = String(body.apiKey ?? "").trim();
    if (!apiKey) {
      return NextResponse.json({ error: "Paste an API key first." }, { status: 400 });
    }
    if (apiKey.length > 512) {
      return NextResponse.json({ error: "That API key is too long." }, { status: 400 });
    }

    const requested = String(body.provider ?? "").trim().toLowerCase();
    const providerId: AiProviderId | null = isProviderId(requested) ? requested : guessProviderId(apiKey);
    if (!providerId) {
      return NextResponse.json(
        {
          error:
            "Could not recognize which provider that key belongs to. Pick the provider manually and connect again.",
        },
        { status: 400 },
      );
    }

    const meta = getProvider(providerId);
    if (!meta) {
      return NextResponse.json({ error: "That provider is not supported yet." }, { status: 400 });
    }

    const baseUrl = String(body.baseUrl ?? "").trim();
    if (baseUrl && !isSafeProviderUrl(baseUrl)) {
      return NextResponse.json(
        { error: "Use a public http(s) base URL for a custom provider (localhost and private networks are blocked)." },
        { status: 400 },
      );
    }
    if (meta.requiresBaseUrl && !baseUrl) {
      return NextResponse.json(
        { error: "A custom provider needs its OpenAI-compatible base URL, for example https://your-host/v1." },
        { status: 400 },
      );
    }

    const cfg: AiConfig = {
      provider: providerId,
      model: String(body.model ?? "").trim() || meta.defaultModel,
      apiKey,
      ...(baseUrl ? { baseUrl } : {}),
    };

    const detected = await detectProvider(cfg);
    const recommended = detected.models.some((m) => m.id === cfg.model)
      ? cfg.model
      : detected.recommendedModel || pickRecommendedModel(meta, detected.models);

    return NextResponse.json(
      {
        provider: providerId,
        providerLabel: meta.label,
        models: detected.models,
        recommendedModel: recommended || cfg.model,
        keyValid: true,
        probe: detected.probe,
        warning: detected.warning ?? null,
        baseUrl: cfg.baseUrl ?? meta.baseUrl,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
