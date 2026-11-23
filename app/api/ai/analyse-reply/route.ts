import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { verifyFirebaseRequest } from "@/lib/firebase-server-auth";
import { analyseReplyServer } from "@/lib/intelligence";
import type { Lead, Settings } from "@/lib/types";

export async function POST(req: NextRequest) {
  try {
    await verifyFirebaseRequest(req);
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
    const analysis = await analyseReplyServer(
      String(body.replyText ?? ""),
      body.lead,
      body.settings,
      body.knowledge ?? "",
      body.model ?? body.settings.model,
    );
    return NextResponse.json({ analysis });
  } catch (err) {
    return handleApiError(err);
  }
}
