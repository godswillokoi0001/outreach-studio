import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import type { GrowthExecuteStage, GrowthProfile, GrowthRecommendation } from "@/lib/growth-advisor";
import {
  executeGrowthStageDiscover,
  executeGrowthStageInspect,
  executeGrowthStageScoreAndBuild,
  executeGrowthStageStrategy,
  executeRecommendationServer,
} from "@/lib/growth-advisor-server";
import { verifyRequest } from "@/lib/server-auth";
import type { Settings } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const body = (await req.json()) as {
      stage?: GrowthExecuteStage;
      runId?: string;
      recommendation?: GrowthRecommendation | null;
      overallStrategy?: string;
      profile: GrowthProfile;
      knowledgeDigest?: string;
      settings: Settings;
      existingEmails?: string[];
      existingWebsites?: string[];
    };

    if (body.stage === "strategy") {
      const res = await executeGrowthStageStrategy({
        runId: body.runId,
        ownerId: user.ownerId,
        recommendation: body.recommendation ?? null,
        overallStrategy: body.overallStrategy,
        profile: body.profile,
        knowledgeDigest: body.knowledgeDigest ?? "",
        settings: body.settings,
      });
      return NextResponse.json(res);
    }

    if (body.stage === "discover") {
      if (!body.runId) {
        return NextResponse.json({ error: "runId is required for Stage 2." }, { status: 400 });
      }
      const res = await executeGrowthStageDiscover({
        runId: body.runId,
        ownerId: user.ownerId,
        existingEmails: Array.isArray(body.existingEmails) ? body.existingEmails : [],
        existingWebsites: Array.isArray(body.existingWebsites) ? body.existingWebsites : [],
      });
      return NextResponse.json(res);
    }

    if (body.stage === "inspect") {
      if (!body.runId) {
        return NextResponse.json({ error: "runId is required for Stage 3." }, { status: 400 });
      }
      const res = await executeGrowthStageInspect({
        runId: body.runId,
        ownerId: user.ownerId,
      });
      return NextResponse.json(res);
    }

    if (body.stage === "score_and_build") {
      if (!body.runId) {
        return NextResponse.json({ error: "runId is required for Stage 4." }, { status: 400 });
      }
      const res = await executeGrowthStageScoreAndBuild({
        runId: body.runId,
        ownerId: user.ownerId,
        profile: body.profile,
        knowledgeDigest: body.knowledgeDigest ?? "",
        settings: body.settings,
        existingEmails: Array.isArray(body.existingEmails) ? body.existingEmails : [],
      });
      return NextResponse.json(res);
    }

    // Legacy single-shot fallback if called without `stage`
    const blueprint = await executeRecommendationServer({
      ownerId: user.ownerId,
      recommendation: body.recommendation ?? null,
      overallStrategy: body.overallStrategy,
      profile: body.profile,
      knowledgeDigest: body.knowledgeDigest ?? "",
      settings: body.settings,
      existingEmails: Array.isArray(body.existingEmails) ? body.existingEmails : [],
    });

    return NextResponse.json({ blueprint });
  } catch (err) {
    return handleApiError(err);
  }
}
