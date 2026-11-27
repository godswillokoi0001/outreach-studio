import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { verifyRequest } from "@/lib/server-auth";
import { planCampaignServer } from "@/lib/intelligence";
import type { Settings } from "@/lib/types";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const body = (await req.json()) as {
      instruction?: string;
      settings: Settings;
      knowledge?: string;
      availableLeads: { total: number; byStatus: Record<string, number>; industries: string[] };
      recentCampaigns: { name: string; status: string }[];
    };
    const instruction = String(body.instruction ?? "").trim();
    if (instruction.length < 8) {
      return NextResponse.json({ error: "Enter a clearer campaign instruction (at least 8 characters)." }, { status: 400 });
    }
    const plan = await planCampaignServer(instruction, {
      ownerId: user.ownerId,
      settings: body.settings,
      knowledge: body.knowledge ?? "",
      availableLeads: body.availableLeads,
      recentCampaigns: body.recentCampaigns ?? [],
    });
    return NextResponse.json({ plan });
  } catch (err) {
    return handleApiError(err);
  }
}
