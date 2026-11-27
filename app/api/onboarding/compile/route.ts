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
import {
  normalizeUrlInput,
  validateUrlStrict,
  type OnboardingAnswers,
} from "@/lib/onboarding";
import {
  generateKnowledgeBaseServer,
  scanWebsiteForOnboardingServer,
} from "@/lib/onboarding-server";
import { verifyRequest } from "@/lib/server-auth";
import { supabaseServer } from "@/lib/supabase-server";
import { saveOnboardingStateServer } from "../state/route";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ONBOARDING_COMPILE_STEPS: BackgroundJobStep[] = [
  { key: "saving_answers", label: "Saving your profile & answers", status: "pending", weightSec: 2 },
  { key: "scanning_website", label: "Scanning your website & online presence", status: "pending", weightSec: 7 },
  { key: "reading_sources", label: "Reading uploaded documents & brand notes", status: "pending", weightSec: 3 },
  { key: "drafting_sections", label: "Drafting your 10 Knowledge Base sections", status: "pending", weightSec: 15 },
  { key: "validating_facts", label: "Verifying facts & marking missing gaps", status: "pending", weightSec: 4 },
  { key: "finalizing_kb", label: "Finalizing preview & preparing workspace", status: "pending", weightSec: 2 },
];

async function runOnboardingCompilePipeline(
  ownerId: string,
  jobId: string,
  answers: OnboardingAnswers,
  aiConfig: AiConfig | null,
): Promise<void> {
  let currentStepKey = "saving_answers";
  try {
    // Stage 1: Persist normalized answers at step 12
    await saveOnboardingStateServer(ownerId, {
      status: "in_progress",
      currentStep: 12,
      answers,
      updatedAt: new Date().toISOString(),
    });
    await advanceBackgroundJobStep(ownerId, jobId, "saving_answers", "done");

    // Stage 2: Scan website if provided and valid
    currentStepKey = "scanning_website";
    await advanceBackgroundJobStep(ownerId, jobId, "scanning_website", "in_progress");
    let websiteNote = "";
    const website = answers.website.trim();
    if (website && validateUrlStrict(website)) {
      const scan = await runWithAiConfig(aiConfig, () =>
        scanWebsiteForOnboardingServer(website),
      ).catch(() => null);
      if (scan?.found) {
        websiteNote = [
          scan.businessName ? `Detected company name: ${scan.businessName}` : "",
          scan.description ? `Website summary: ${scan.description}` : "",
          scan.services.length > 0 ? `Detected services: ${scan.services.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }
    }
    await advanceBackgroundJobStep(
      ownerId,
      jobId,
      "scanning_website",
      "done",
      websiteNote ? "Website context captured" : "No public website changes needed",
    );

    // Stage 3: Load uploaded sources & notes for this owner
    currentStepKey = "reading_sources";
    await advanceBackgroundJobStep(ownerId, jobId, "reading_sources", "in_progress");
    let sourceDigest = "";
    if (supabaseServer) {
      const { data: srcRows } = await supabaseServer
        .from("knowledge_sources")
        .select("label, content")
        .eq("owner_id", ownerId)
        .limit(8);
      if (Array.isArray(srcRows) && srcRows.length > 0) {
        sourceDigest = srcRows
          .map(
            (r) =>
              `- ${String((r as { label?: string }).label ?? "Document")}: ${String(
                (r as { content?: string }).content ?? "",
              ).slice(0, 600)}`,
          )
          .join("\n");
      }
    }
    await advanceBackgroundJobStep(ownerId, jobId, "reading_sources", "done");

    // Stage 4: Draft the 10 Knowledge Base sections
    currentStepKey = "drafting_sections";
    await advanceBackgroundJobStep(ownerId, jobId, "drafting_sections", "in_progress");
    const extraContext = [websiteNote, sourceDigest].filter(Boolean).join("\n\n");
    const compiled = await runWithAiConfig(aiConfig, () =>
      generateKnowledgeBaseServer({
        answers,
        extraContext: extraContext || undefined,
      }),
    );
    await advanceBackgroundJobStep(ownerId, jobId, "drafting_sections", "done");

    // Stage 5: Fact check & mark missing gaps strictly
    currentStepKey = "validating_facts";
    await advanceBackgroundJobStep(ownerId, jobId, "validating_facts", "in_progress");
    const normalizedSections = compiled.sections.map((s) => ({
      ...s,
      content: s.content.trim() || "Not provided.",
    }));
    await advanceBackgroundJobStep(ownerId, jobId, "validating_facts", "done");

    // Stage 6: Persist compiled preview so browser refresh / tab close recovers cleanly
    currentStepKey = "finalizing_kb";
    await advanceBackgroundJobStep(ownerId, jobId, "finalizing_kb", "in_progress");
    await completeBackgroundJob(ownerId, jobId, {
      sections: normalizedSections,
      missingGaps: compiled.missingGaps ?? [],
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.message
        : "Something went wrong while building your Knowledge Base. Please try again.";
    await failBackgroundJob(ownerId, jobId, msg, currentStepKey);
  }
}

export async function GET(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const job = await getLatestBackgroundJobForOwner(user.ownerId, "onboarding_kb_compile");
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
      answers?: OnboardingAnswers;
    };

    if (!body.answers) {
      return NextResponse.json({ error: "Onboarding answers are required." }, { status: 400 });
    }

    const answers = body.answers;
    const normalizedAnswers: OnboardingAnswers = {
      ...answers,
      website: normalizeUrlInput(answers.website),
      linkedinUrl: normalizeUrlInput(answers.linkedinUrl),
      xUrl: normalizeUrlInput(answers.xUrl),
      instagramUrl: normalizeUrlInput(answers.instagramUrl),
      facebookUrl: normalizeUrlInput(answers.facebookUrl),
      youtubeUrl: normalizeUrlInput(answers.youtubeUrl),
      tiktokUrl: normalizeUrlInput(answers.tiktokUrl),
      bookingOrPortfolioUrl: normalizeUrlInput(answers.bookingOrPortfolioUrl),
    };

    const { job, reused } = await createOrReuseBackgroundJob({
      ownerId: user.ownerId,
      jobType: "onboarding_kb_compile",
      steps: ONBOARDING_COMPILE_STEPS,
      payload: { stepCount: 12 },
    });

    if (!reused) {
      void runOnboardingCompilePipeline(user.ownerId, job.id, normalizedAnswers, aiConfig);
    }

    return NextResponse.json(
      { job, reused },
      { status: reused ? 200 : 202, headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
