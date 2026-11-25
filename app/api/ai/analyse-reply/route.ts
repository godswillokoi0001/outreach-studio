import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { resolveAiConfigForRequest, runWithAiConfig } from "@/lib/ai/context";
import { verifyRequest } from "@/lib/server-auth";
import { analyseReplyServer } from "@/lib/intelligence";
import type { Lead, Settings } from "@/lib/types";

export async function POST(req: NextRequest) {
  try {
    await verifyRequest(req);
    const aiConfig = await resolveAiConfigForRequest(req);
    const body = (await req.json()) as {
      replyText?: string;
      lead?: Lead;
      settings?: Settings;
      knowledge?: string;
      model?: string;
    };
    if (!body.lead || !body.settings) {
      return NextResponse.json({ error: "Lead and settings are required." }, { status: 400 });
    }
    const analysis = await runWithAiConfig(aiConfig, () =>
      analyseReplyServer(
        String(body.replyText ?? ""),
        body.lead!,
        body.settings!,
        body.knowledge ?? "",
        body.model ?? body.settings!.model,
      ),
    );
    return NextResponse.json({ analysis });
  } catch (err) {
    return handleApiError(err);
  }
}
