import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { resolveAiConfigForRequest, runWithAiConfig } from "@/lib/ai/context";
import { verifyFirebaseRequest } from "@/lib/firebase-server-auth";
import { planCampaignServer } from "@/lib/intelligence";
import type { Settings } from "@/lib/types";

export async function POST(req: NextRequest) {
  try {
    await verifyFirebaseRequest(req);
    const aiConfig = await resolveAiConfigForRequest(req);
    const body = (await req.json()) as {
      instruction?: string;
      settings: Settings;
      knowledge?: string;
      availableLeads: { total: number; byStatus: Record<string, number>; industries: string[] };
      recentCampaigns: { name: string; status: string }[];
      model?: string;
    };
    const instruction = String(body.instruction ?? "").trim();
    if (instruction.length < 8) {
      return NextResponse.json({ error: "Enter a clearer campaign instruction (at least 8 characters)." }, { status: 400 });
    }
    const plan = await runWithAiConfig(aiConfig, () =>
      planCampaignServer(
        instruction,
        {
          settings: body.settings,
          knowledge: body.knowledge ?? "",
          availableLeads: body.availableLeads,
          recentCampaigns: body.recentCampaigns ?? [],
        },
        body.model ?? body.settings?.model,
      ),
    );
    return NextResponse.json({ plan });
  } catch (err) {
    return handleApiError(err);
  }
}
