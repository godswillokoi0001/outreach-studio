import { NextRequest, NextResponse } from "next/server";
import { isSafeProviderUrl } from "@/lib/ai/context";
import { handleApiError } from "@/lib/api-helpers";
import { guessGatewayProvider, normalizeGatewayProviderId, PROVIDER_CATALOG, getProviderMeta } from "@/lib/llm/types";
import { LLMGateway } from "@/lib/llm/gateway";
import { checkKeyTestRateLimit } from "@/lib/platform/store-server";
import { verifyRequest } from "@/lib/server-auth";

// Node runtime is required: the gateway and key vault use node:crypto.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    await verifyRequest(req);
    return NextResponse.json(
      { providers: PROVIDER_CATALOG },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const authUser = await verifyRequest(req);
    const rl = checkKeyTestRateLimit(authUser.ownerId);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `Too many key tests. Wait ${rl.retryAfterSec} seconds and try again.` },
        { status: 429 },
      );
    }

    const body = (await req.json().catch(() => ({}))) as {
      provider?: string;
      apiKey?: string;
      accountId?: string;
      baseUrl?: string;
      model?: string;
      freeTierOnly?: boolean;
    };

    const rawProvider = String(body.provider ?? "").trim();
    const apiKey = String(body.apiKey ?? "").trim();
    const guessed = guessGatewayProvider(apiKey);
    const providerId =
      !rawProvider || rawProvider === "auto"
        ? guessed ?? "google"
        : normalizeGatewayProviderId(rawProvider).provider;

    const meta = getProviderMeta(providerId);
    const baseUrl = String(body.baseUrl ?? "").trim();
    if (baseUrl && !isSafeProviderUrl(baseUrl)) {
      return NextResponse.json(
        { error: "Use a public http(s) URL for custom endpoints (private/localhost addresses are blocked)." },
        { status: 400 },
      );
    }
    if (meta.requiresBaseUrl && !baseUrl) {
      return NextResponse.json(
        { error: "Custom endpoints require a base URL (e.g. https://your-gateway/v1)." },
        { status: 400 },
      );
    }
    if (meta.requiresAccountId && !String(body.accountId ?? "").trim() && !apiKey.includes(":")) {
      return NextResponse.json(
        { error: "Cloudflare Workers AI requires your Account ID." },
        { status: 400 },
      );
    }

    const verified = await LLMGateway.verifyAndFetchModels({
      provider: providerId,
      apiKey,
      accountId: body.accountId?.trim() || null,
      baseUrl: baseUrl || null,
      preferredModel: body.model,
      freeTierOnly: body.freeTierOnly,
    });

    return NextResponse.json(
      {
        ...verified,
        keyValid: true,
      },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
