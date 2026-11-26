import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { resolveAiConfigForRequest, runWithAiConfig } from "@/lib/ai/context";
import { verifyRequest } from "@/lib/server-auth";
import { generateGrowthAdvisorReportServer } from "@/lib/growth-advisor-server";
import type { GrowthProfile } from "@/lib/growth-advisor";
import type { PerformanceInsight } from "@/lib/intelligence";
import type { Settings } from "@/lib/types";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    await verifyRequest(req);
    const aiConfig = await resolveAiConfigForRequest(req);
    const body = (await req.json()) as {
      profile: GrowthProfile;
      knowledgeDigest?: string;
      settings: Settings;
      metricsSummary?: Record<string, unknown>;
      analyticsInsight?: PerformanceInsight | null;
      fingerprint?: string;
      model?: string;
    };

    const report = await runWithAiConfig(aiConfig, () =>
      generateGrowthAdvisorReportServer({
        profile: body.profile,
        knowledgeDigest: body.knowledgeDigest ?? "",
        settings: body.settings,
        metricsSummary: body.metricsSummary ?? {},
        analyticsInsight: body.analyticsInsight ?? null,
        fingerprint: body.fingerprint ?? "manual",
        model: body.model ?? body.settings?.model,
      }),
    );

    return NextResponse.json({ report });
  } catch (err) {
    return handleApiError(err);
  }
}
