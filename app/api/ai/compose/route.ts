import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { verifyRequest } from "@/lib/server-auth";
import { composeFollowUpServer, composeInitialServer } from "@/lib/compose";
import { ensureLeadMicroResearch } from "@/lib/micro-research";
import { evaluateLeadSendEligibility } from "@/lib/guardrails";
import type { CampaignConfig, Lead, Message, ResearchResult, Settings } from "@/lib/types";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const body = (await req.json()) as {
      kind?: "initial" | "followup";
      lead?: Lead;
      research?: ResearchResult | null;
      campaign?: CampaignConfig;
      settings?: Settings;
      knowledge?: string;
      original?: Message;
      step?: number;
    };
    if (!body.lead || !body.campaign || !body.settings) {
      return NextResponse.json({ error: "Lead, campaign, and settings are required." }, { status: 400 });
    }

    if (body.kind !== "followup") {
      const gate = evaluateLeadSendEligibility({
        lead: body.lead,
        minScore: body.campaign.min_score ?? body.settings.min_score,
        senderEmail: body.settings.sender_email,
      });
      if (
        !gate.eligible &&
        (gate.code === "KILL_SWITCH" ||
          gate.code === "BELOW_MIN_SCORE" ||
          gate.code === "SUPPRESSED" ||
          gate.code === "SELF_SEND")
      ) {
        return NextResponse.json({ error: gate.reason || "Prospect is not eligible for outreach." }, { status: 400 });
      }
    }

    if (body.kind === "followup") {
      if (!body.original) {
        return NextResponse.json({ error: "Original sent message is required for follow-ups." }, { status: 400 });
      }
      const composed = await composeFollowUpServer(
        body.lead!,
        body.research ?? null,
        body.campaign!,
        body.settings!,
        body.knowledge ?? "",
        body.original!,
        Number(body.step ?? 2),
        undefined,
        { ownerId: user.ownerId },
      );
      return NextResponse.json({ composed });
    }

    // A missing research record is no longer a dead end: run the mandatory
    // micro-research pass first, then draft from what the live site proved.
    const draftedLead = await ensureLeadMicroResearch(user.ownerId, body.lead!);
    const research = body.research ?? draftedLead.research;
    if (!research) {
      return NextResponse.json(
        { error: "No verified research or public website was available for this prospect." },
        { status: 400 },
      );
    }
    const composed = await composeInitialServer(
      draftedLead,
      research,
      body.campaign!,
      body.settings!,
      body.knowledge ?? "",
      undefined,
      { ownerId: user.ownerId },
    );
    return NextResponse.json({ composed });
  } catch (err) {
    return handleApiError(err);
  }
}
