import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { resolveAiConfigForRequest, runWithAiConfig } from "@/lib/ai/context";
import { verifyRequest } from "@/lib/server-auth";
import { discoverProspectsServer } from "@/lib/intelligence";

export async function POST(req: NextRequest) {
  try {
    await verifyRequest(req);
    const aiConfig = await resolveAiConfigForRequest(req);
    const body = (await req.json()) as {
      industry?: string;
      location?: string;
      count?: number;
      focus?: string;
      knowledge?: string;
      model?: string;
    };
    const count = Math.max(3, Math.min(20, Number(body.count) || 8));
    const result = await runWithAiConfig(aiConfig, () =>
      discoverProspectsServer({
        industry: String(body.industry ?? ""),
        location: String(body.location ?? ""),
        count,
        focus: String(body.focus ?? ""),
        knowledge: String(body.knowledge ?? ""),
        model: body.model,
      }),
    );
    return NextResponse.json(result);
  } catch (err) {
    return handleApiError(err);
  }
}
