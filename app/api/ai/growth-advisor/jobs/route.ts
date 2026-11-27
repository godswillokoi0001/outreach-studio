import { NextRequest, NextResponse } from "next/server";
import { resolveAiConfigForRequest, runWithAiConfig } from "@/lib/ai/context";
import type { AiConfig } from "@/lib/ai/types";
import { handleApiError } from "@/lib/api-helpers";
import {
  advanceBackgroundJobStep,
  completeBackgroundJob,
  createOrReuseBackgroundJob,
  failBackgroundJob,
  getLatestBackgroundJobForOwner,
  type BackgroundJobStep,
} from "@/lib/background-jobs";
import type { GrowthProfile } from "@/lib/growth-advisor";
import { generateGrowthAdvisorReportServer } from "@/lib/growth-advisor-server";
import type { PerformanceInsight } from "@/lib/intelligence";
import { verifyRequest } from "@/lib/server-auth";
import { supabaseServer } from "@/lib/supabase-server";
import type { Settings } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const GROWTH_RESEARCH_STEPS: BackgroundJobStep[] = [
  { key: "searching_businesses", label: "Searching for businesses like yours", status: "pending", weightSec: 6 },
  { key: "reading_sources", label: "Reading live sources & benchmarks", status: "pending", weightSec: 12 },
  { key: "checking_niche", label: "Checking what's working in your niche", status: "pending", weightSec: 9 },
  { key: "ranking_recommendations", label: "Ranking personalized recommendations", status: "pending", weightSec: 4 },
];

async function runGrowthResearchPipeline(
  ownerId: string,
  jobId: string,
  input: {
    profile: GrowthProfile;
    knowledgeDigest: string;
    settings: Settings;
    metricsSummary: Record<string, unknown>;
    analyticsInsight: PerformanceInsight | null;
    fingerprint: string;
    model?: string;
  },
  aiConfig: AiConfig | null,
): Promise<void> {
  let activeStage = "searching_businesses";
  try {
    await advanceBackgroundJobStep(ownerId, jobId, "searching_businesses", "done");

    activeStage = "reading_sources";
    await advanceBackgroundJobStep(ownerId, jobId, "reading_sources", "in_progress");
    const report = await runWithAiConfig(aiConfig, () =>
      generateGrowthAdvisorReportServer({
        ownerId,
        profile: input.profile,
        knowledgeDigest: input.knowledgeDigest,
        settings: input.settings,
        metricsSummary: input.metricsSummary,
        analyticsInsight: input.analyticsInsight,
        fingerprint: input.fingerprint,
        model: input.model,
      }),
    );
    await advanceBackgroundJobStep(
      ownerId,
      jobId,
      "reading_sources",
      "done",
      `${report.sources.length} web source(s) analyzed`,
    );

    activeStage = "checking_niche";
    await advanceBackgroundJobStep(ownerId, jobId, "checking_niche", "done");

    activeStage = "ranking_recommendations";
    await advanceBackgroundJobStep(ownerId, jobId, "ranking_recommendations", "in_progress");

    if (supabaseServer) {
      await supabaseServer.from("knowledge").upsert(
        {
          id: `system_growth_report_${ownerId}`,
          owner_id: ownerId,
          category: "system_growth_report",
          title: "Growth Advisor Cached Research",
          content: JSON.stringify(report),
          sort: 999,
          is_master: false,
          updated_at: new Date().toISOString(),
        } as never,
        { onConflict: "id" },
      );
    }

    await completeBackgroundJob(ownerId, jobId, { report });
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.message
        : "Market research could not finish. Please check your AI connection and try again.";
    await failBackgroundJob(ownerId, jobId, msg, activeStage);
  }
}

export async function GET(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const job = await getLatestBackgroundJobForOwner(user.ownerId, "growth_advisor_research");
    return NextResponse.json(
      { job },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const aiConfig = await resolveAiConfigForRequest(req);
    const body = (await req.json().catch(() => ({}))) as {
      profile?: GrowthProfile;
      knowledgeDigest?: string;
      settings?: Settings;
      metricsSummary?: Record<string, unknown>;
      analyticsInsight?: PerformanceInsight | null;
      fingerprint?: string;
      model?: string;
    };

    if (!body.profile || !body.settings) {
      return NextResponse.json({ error: "Business profile and settings are required." }, { status: 400 });
    }

    const { job, reused } = await createOrReuseBackgroundJob({
      ownerId: user.ownerId,
      jobType: "growth_advisor_research",
      steps: GROWTH_RESEARCH_STEPS,
      payload: {
        fingerprint: body.fingerprint ?? "manual",
        industry: body.profile.industry || "",
      },
    });

    if (!reused) {
      void runGrowthResearchPipeline(
        user.ownerId,
        job.id,
        {
          profile: body.profile,
          knowledgeDigest: body.knowledgeDigest ?? "",
          settings: body.settings,
          metricsSummary: body.metricsSummary ?? {},
          analyticsInsight: body.analyticsInsight ?? null,
          fingerprint: body.fingerprint ?? "manual",
          model: body.model ?? body.settings.model,
        },
        aiConfig,
      );
    }

    return NextResponse.json(
      { job, reused },
      { status: reused ? 200 : 202, headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
