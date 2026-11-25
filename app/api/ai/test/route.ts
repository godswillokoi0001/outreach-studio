import { NextRequest, NextResponse } from "next/server";
import { resolveAiConfigForRequest, runWithAiConfig } from "@/lib/ai/context";
import { handleApiError } from "@/lib/api-helpers";
import { verifyRequest } from "@/lib/server-auth";
import { testGeminiConnection } from "@/lib/gemini";

export async function POST(req: NextRequest) {
  try {
    await verifyRequest(req);
    const aiConfig = await resolveAiConfigForRequest(req);
    const body = (await req.json().catch(() => ({}))) as { model?: string };
    const result = await runWithAiConfig(aiConfig, () => testGeminiConnection(body.model || aiConfig?.model));
    return NextResponse.json({ ...result, provider: result.provider ?? aiConfig?.provider ?? "gemini" });
  } catch (err) {
    return handleApiError(err);
  }
}
