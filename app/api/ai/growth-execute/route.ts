import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { resolveAiConfigForRequest, runWithAiConfig } from "@/lib/ai/context";
import { verifyRequest } from "@/lib/server-auth";
import { executeRecommendationServer } from "@/lib/growth-advisor-server";
import type { GrowthProfile, GrowthRecommendation } from "@/lib/growth-advisor";
import type { Settings } from "@/lib/types";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const aiConfig = await resolveAiConfigForRequest(req);
    const body = (await req.json()) as {
      recommendation?: GrowthRecommendation | null;
      overallStrategy?: string;
      profile: GrowthProfile;
      knowledgeDigest?: string;
      settings: Settings;
      existingEmails?: string[];
      model?: string;
    };

    const blueprint = await runWithAiConfig(aiConfig, () =>
      executeRecommendationServer({
        ownerId: user.ownerId,
        recommendation: body.recommendation ?? null,
        overallStrategy: body.overallStrategy,
        profile: body.profile,
        knowledgeDigest: body.knowledgeDigest ?? "",
        settings: body.settings,
        existingEmails: Array.isArray(body.existingEmails) ? body.existingEmails : [],
        model: body.model ?? body.settings?.model,
      }),
    );

    return NextResponse.json({ blueprint });
  } catch (err) {
    return handleApiError(err);
  }
}
