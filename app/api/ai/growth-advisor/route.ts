import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { verifyRequest } from "@/lib/server-auth";
import { generateGrowthAdvisorReportServer } from "@/lib/growth-advisor-server";
import type { GrowthProfile } from "@/lib/growth-advisor";
import type { PerformanceInsight } from "@/lib/intelligence";
import type { Settings } from "@/lib/types";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const body = (await req.json()) as {
      profile: GrowthProfile;
      knowledgeDigest?: string;
      settings: Settings;
      metricsSummary?: Record<string, unknown>;
      analyticsInsight?: PerformanceInsight | null;
      fingerprint?: string;
    };

    const report = await generateGrowthAdvisorReportServer({
      ownerId: user.ownerId,
      profile: body.profile,
      knowledgeDigest: body.knowledgeDigest ?? "",
      settings: body.settings,
      metricsSummary: body.metricsSummary ?? {},
      analyticsInsight: body.analyticsInsight ?? null,
      fingerprint: body.fingerprint ?? "manual",
    });

    return NextResponse.json({ report });
  } catch (err) {
    return handleApiError(err);
  }
}
