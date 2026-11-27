import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { LLMGateway } from "@/lib/llm/gateway";
import { getProviderMeta } from "@/lib/llm/types";
import { verifyRequest } from "@/lib/server-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const res = await LLMGateway.testActiveModel(user.ownerId);
    const meta = getProviderMeta(res.receipt.actualProvider);
    return NextResponse.json(
      {
        model: res.receipt.actualModel,
        provider: res.receipt.actualProvider,
        providerLabel: meta.label,
        ms: res.receipt.latencyMs,
        reply: res.text,
        receipt: res.receipt,
      },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
