import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { verifyFirebaseRequest } from "@/lib/firebase-server-auth";
import { testGeminiConnection } from "@/lib/gemini";

export async function POST(req: NextRequest) {
  try {
    await verifyFirebaseRequest(req);
    const body = (await req.json().catch(() => ({}))) as { model?: string };
    const result = await testGeminiConnection(body.model);
    return NextResponse.json(result);
  } catch (err) {
    return handleApiError(err);
  }
}
