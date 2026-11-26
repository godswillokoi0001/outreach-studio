import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { resolveAiConfigForRequest, runWithAiConfig } from "@/lib/ai/context";
import { verifyRequest } from "@/lib/server-auth";
import { qualifyLeadServer } from "@/lib/qualify";
import type { CampaignConfig, Lead, ResearchResult } from "@/lib/types";

export async function POST(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const aiConfig = await resolveAiConfigForRequest(req);
    const body = (await req.json()) as {
      lead?: Lead;
      research?: ResearchResult | null;
      campaign?: CampaignConfig;
      minScore?: number;
      knowledge?: string;
      model?: string;
    };
    if (!body.lead || !body.campaign) {
      return NextResponse.json({ error: "Lead and campaign configuration are required." }, { status: 400 });
    }
    const qualification = await runWithAiConfig(aiConfig, () =>
      qualifyLeadServer(
        body.lead!,
        body.research ?? null,
        body.campaign!,
        Number(body.minScore ?? body.campaign!.min_score ?? 65),
        body.knowledge ?? "",
        body.model,
        { ownerId: user.ownerId },
      ),
    );
    return NextResponse.json({ qualification });
  } catch (err) {
    return handleApiError(err);
  }
}
