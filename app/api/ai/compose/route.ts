import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { resolveAiConfigForRequest, runWithAiConfig } from "@/lib/ai/context";
import { verifyRequest } from "@/lib/server-auth";
import { composeFollowUpServer, composeInitialServer } from "@/lib/compose";
import type { CampaignConfig, Lead, Message, ResearchResult, Settings } from "@/lib/types";

export async function POST(req: NextRequest) {
  try {
    await verifyRequest(req);
    const aiConfig = await resolveAiConfigForRequest(req);
    const body = (await req.json()) as {
      kind?: "initial" | "followup";
      lead?: Lead;
      research?: ResearchResult | null;
      campaign?: CampaignConfig;
      settings?: Settings;
      knowledge?: string;
      original?: Message;
      step?: number;
      model?: string;
    };
    if (!body.lead || !body.campaign || !body.settings) {
      return NextResponse.json({ error: "Lead, campaign, and settings are required." }, { status: 400 });
    }
    if (body.kind === "followup") {
      if (!body.original) {
        return NextResponse.json({ error: "Original sent message is required for follow-ups." }, { status: 400 });
      }
      const composed = await runWithAiConfig(aiConfig, () =>
        composeFollowUpServer(
          body.lead!,
          body.research ?? null,
          body.campaign!,
          body.settings!,
          body.knowledge ?? "",
          body.original!,
          Number(body.step ?? 2),
          body.model ?? body.settings!.model,
        ),
      );
      return NextResponse.json({ composed });
    }

    if (!body.research) {
      return NextResponse.json({ error: "Research record is required before composing initial email." }, { status: 400 });
    }
    const composed = await runWithAiConfig(aiConfig, () =>
      composeInitialServer(
        body.lead!,
        body.research!,
        body.campaign!,
        body.settings!,
        body.knowledge ?? "",
        body.model ?? body.settings!.model,
      ),
    );
    return NextResponse.json({ composed });
  } catch (err) {
    return handleApiError(err);
  }
}
