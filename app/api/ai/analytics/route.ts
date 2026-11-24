import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { resolveAiConfigForRequest, runWithAiConfig } from "@/lib/ai/context";
import { verifyFirebaseRequest } from "@/lib/firebase-server-auth";
import { analysePerformanceServer } from "@/lib/intelligence";

export async function POST(req: NextRequest) {
  try {
    await verifyFirebaseRequest(req);
    const aiConfig = await resolveAiConfigForRequest(req);
    const body = (await req.json()) as { metrics?: unknown; model?: string };
    if (!body.metrics) {
      return NextResponse.json({ error: "Analytics metrics payload is required." }, { status: 400 });
    }
    const insight = await runWithAiConfig(aiConfig, () => analysePerformanceServer(body.metrics, body.model));
    return NextResponse.json({ insight });
  } catch (err) {
    return handleApiError(err);
  }
}
