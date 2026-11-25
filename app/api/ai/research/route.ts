import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { resolveAiConfigForRequest, runWithAiConfig } from "@/lib/ai/context";
import { verifyRequest } from "@/lib/server-auth";
import { researchLeadServer } from "@/lib/research";
import type { Lead } from "@/lib/types";

export async function POST(req: NextRequest) {
  try {
    await verifyRequest(req);
    const aiConfig = await resolveAiConfigForRequest(req);
    const body = (await req.json()) as {
      lead?: Lead;
      knowledge?: string;
      model?: string;
    };
    if (!body.lead) {
      return NextResponse.json({ error: "Lead payload is required." }, { status: 400 });
    }
    const research = await runWithAiConfig(aiConfig, () =>
      researchLeadServer(body.lead!, body.knowledge ?? "", {
        model: body.model,
      }),
    );
    return NextResponse.json({ research });
  } catch (err) {
    return handleApiError(err);
  }
}
