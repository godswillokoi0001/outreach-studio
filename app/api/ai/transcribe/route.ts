import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { LLMGateway } from "@/lib/llm/gateway";
import { verifyRequest } from "@/lib/server-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ALLOWED_AUDIO = /^audio\/(webm|ogg|mpeg|mp4|wav|mp3|x-m4a)$/i;
const MAX_AUDIO_CHARS = 8_000_000;

export async function POST(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const body = (await req.json().catch(() => ({}))) as {
      audio?: { mimeType?: string; data?: string };
    };
    const mimeType = String(body.audio?.mimeType ?? "");
    const data = String(body.audio?.data ?? "");

    if (!ALLOWED_AUDIO.test(mimeType)) {
      return NextResponse.json(
        { error: "That audio format is not supported. Record the note again." },
        { status: 400 },
      );
    }
    if (!data || data.length > MAX_AUDIO_CHARS) {
      return NextResponse.json(
        { error: "The recording is empty or too long. Keep voice notes under 2 minutes." },
        { status: 400 },
      );
    }

    const res = await LLMGateway.transcribeAudio({
      ownerId: user.ownerId,
      mimeType,
      base64Data: data,
    });
    return NextResponse.json(
      { transcript: res.transcript, provider: res.provider, model: res.model },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
