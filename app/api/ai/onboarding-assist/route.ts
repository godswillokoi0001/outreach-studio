import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { runWithOwnerAiContext } from "@/lib/ai/context";
import { verifyRequest } from "@/lib/server-auth";
import {
  generateKnowledgeBaseServer,
  improveAnswerServer,
  regenerateSectionServer,
  scanWebsiteForOnboardingServer,
} from "@/lib/onboarding-server";
import type { OnboardingAnswers } from "@/lib/onboarding";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const body = (await req.json()) as {
      action?: "scan_website" | "improve_answer" | "generate_kb" | "regenerate_section";
      url?: string;
      questionTitle?: string;
      answer?: string;
      businessContext?: string;
      answers?: OnboardingAnswers;
      sectionTitle?: string;
      currentContent?: string;
      knowledgeDigest?: string;
      userInstruction?: string;
    };

    return runWithOwnerAiContext({ ownerId: user.ownerId, feature: "onboarding_assist" }, async () => {
      if (body.action === "scan_website") {
        if (!body.url?.trim()) {
          return NextResponse.json({ error: "Enter a website URL to scan." }, { status: 400 });
        }
        const scan = await scanWebsiteForOnboardingServer(body.url!);
        return NextResponse.json(scan);
      }

      if (body.action === "improve_answer") {
        if (!body.answer?.trim()) {
          return NextResponse.json({ error: "Write a short draft first so the AI can improve it." }, { status: 400 });
        }
        const res = await improveAnswerServer({
          questionTitle: body.questionTitle ?? "Question",
          answer: body.answer!,
          businessContext: body.businessContext,
        });
        return NextResponse.json(res);
      }

      if (body.action === "generate_kb") {
        if (!body.answers) {
          return NextResponse.json({ error: "Onboarding answers are required." }, { status: 400 });
        }
        const res = await generateKnowledgeBaseServer({
          answers: body.answers!,
        });
        return NextResponse.json(res);
      }

      if (body.action === "regenerate_section") {
        if (!body.sectionTitle) {
          return NextResponse.json({ error: "Section title is required." }, { status: 400 });
        }
        const res = await regenerateSectionServer({
          sectionTitle: body.sectionTitle!,
          currentContent: body.currentContent ?? "",
          answers: body.answers ?? null,
          knowledgeDigest: body.knowledgeDigest,
          userInstruction: body.userInstruction,
        });
        return NextResponse.json(res);
      }

      return NextResponse.json({ error: "Unknown onboarding action." }, { status: 400 });
    });
  } catch (err) {
    return handleApiError(err);
  }
}
