import { NextRequest, NextResponse, after } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import {
  advanceBackgroundJobStep,
  completeBackgroundJob,
  createOrReuseBackgroundJob,
  failBackgroundJob,
  failStalledBackgroundJob,
  getLatestBackgroundJobForOwner,
  JOB_HEARTBEAT_MS,
  touchBackgroundJob,
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

// The function is killed at maxDuration. Stop before that so we can mark the job
// failed with a readable reason instead of leaving a frozen progress bar.
const RESEARCH_DEADLINE_MS = 48_000;
// A fresh run replaces a stalled one after this long without a heartbeat.
const STALE_RUN_MS = 90_000;

const GROWTH_RESEARCH_STEPS: BackgroundJobStep[] = [
  { key: "searching_businesses", label: "Searching for businesses like yours", status: "pending", weightSec: 6 },
  { key: "reading_sources", label: "Reading live sources & benchmarks", status: "pending", weightSec: 12 },
  { key: "checking_niche", label: "Checking what's working in your niche", status: "pending", weightSec: 9 },
  { key: "ranking_recommendations", label: "Ranking personalized recommendations", status: "pending", weightSec: 4 },
];

function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

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
  },
): Promise<void> {
  let activeStage = "searching_businesses";
  // Keeps updatedAt fresh while a long model call runs, so the stall check only
  // fires when the process really died.
  const heartbeat = setInterval(() => {
    void touchBackgroundJob(ownerId, jobId).catch(() => {});
  }, JOB_HEARTBEAT_MS);

  try {
    await advanceBackgroundJobStep(ownerId, jobId, "searching_businesses", "done");

    activeStage = "reading_sources";
    await advanceBackgroundJobStep(ownerId, jobId, "reading_sources", "in_progress");
    const report = await withDeadline(
      generateGrowthAdvisorReportServer({
        ownerId,
        profile: input.profile,
        knowledgeDigest: input.knowledgeDigest,
        settings: input.settings,
        metricsSummary: input.metricsSummary,
        analyticsInsight: input.analyticsInsight,
        fingerprint: input.fingerprint,
      }),
      RESEARCH_DEADLINE_MS,
      "Live market research took too long to answer. Tap Retry research to run it again.",
    );

    if (!Array.isArray(report.recommendations) || report.recommendations.length === 0) {
      throw new Error(
        "Market research came back without usable recommendations. Tap Retry research to run it again.",
      );
    }

    await advanceBackgroundJobStep(
      ownerId,
      jobId,
      "reading_sources",
      "done",
      `${report.sources.length} web source(s) analyzed`,
    );

    activeStage = "checking_niche";
    await advanceBackgroundJobStep(
      ownerId,
      jobId,
      "checking_niche",
      "done",
      `${report.recommendations.length} recommendation(s) matched to your market`,
    );

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
  } finally {
    clearInterval(heartbeat);
  }
}

export async function GET(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const job = await getLatestBackgroundJobForOwner(user.ownerId, "growth_advisor_research");
    // Reconcile a run whose server process disappeared (e.g. function frozen or
    // killed at maxDuration) so the UI never shows the same percentage forever.
    const reconciled = job ? await failStalledBackgroundJob(user.ownerId, job, STALE_RUN_MS) : null;
    return NextResponse.json(
      { job: reconciled },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const body = (await req.json().catch(() => ({}))) as {
      profile?: GrowthProfile;
      knowledgeDigest?: string;
      settings?: Settings;
      metricsSummary?: Record<string, unknown>;
      analyticsInsight?: PerformanceInsight | null;
      fingerprint?: string;
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
      staleAfterMs: STALE_RUN_MS,
    });

    if (!reused) {
      // `after` keeps the function alive after the response is sent (waitUntil).
      // A bare `void promise` is frozen by the platform, which is what left
      // research stuck at its first step.
      after(
        runGrowthResearchPipeline(user.ownerId, job.id, {
          profile: body.profile,
          knowledgeDigest: body.knowledgeDigest ?? "",
          settings: body.settings,
          metricsSummary: body.metricsSummary ?? {},
          analyticsInsight: body.analyticsInsight ?? null,
          fingerprint: body.fingerprint ?? "manual",
        }),
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
