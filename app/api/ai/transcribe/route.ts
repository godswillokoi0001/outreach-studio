import { NextRequest, NextResponse } from "next/server";
import { resolveAiConfigForRequest } from "@/lib/ai/context";
import { providerBaseUrl } from "@/lib/ai/registry";
import type { AiConfig } from "@/lib/ai/types";
import { handleApiError } from "@/lib/api-helpers";
import { verifyRequest } from "@/lib/server-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ALLOWED_AUDIO = /^audio\/(webm|ogg|mpeg|mp4|wav|mp3|x-m4a)$/i;
const MAX_AUDIO_CHARS = 8_000_000;

async function transcribeWithGemini(cfg: AiConfig, mimeType: string, data: string): Promise<string> {
  const base = providerBaseUrl(cfg);
  const model = cfg.model || "gemini-2.5-flash";
  const res = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: "Transcribe this voice note word for word. Return only the transcript, no commentary. If there is no speech, return an empty string." },
            { inlineData: { mimeType, data } },
          ],
        },
      ],
    }),
  });

  const body = (await res.json().catch(() => ({}))) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new Error(body.error?.message || `The speech model refused the request (HTTP ${res.status}).`);
  }
  const text = (body.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  return text;
}

async function transcribeWithOpenAI(cfg: AiConfig, mimeType: string, data: string): Promise<string> {
  const base = providerBaseUrl(cfg);
  const form = new FormData();
  const bytes = Buffer.from(data, "base64");
  const extension = mimeType.includes("mp4") || mimeType.includes("m4a") ? "m4a" : mimeType.includes("ogg") ? "ogg" : "webm";
  form.append("file", new Blob([bytes], { type: mimeType }), `voice-note.${extension}`);
  form.append("model", "whisper-1");

  const res = await fetch(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body: form,
  });
  const body = (await res.json().catch(() => ({}))) as { text?: string; error?: { message?: string } };
  if (!res.ok) {
    throw new Error(body.error?.message || `The speech endpoint refused the request (HTTP ${res.status}).`);
  }
  return (body.text ?? "").trim();
}

/**
 * Turns a recorded voice note into text with the configured provider. The
 * browser falls back to its own SpeechRecognition transcript when this is
 * unavailable, so the operator can always read what was said.
 */
export async function POST(req: NextRequest) {
  try {
    await verifyRequest(req);
    const aiConfig = await resolveAiConfigForRequest(req);
    if (!aiConfig) {
      return NextResponse.json(
        { error: "No AI provider is configured. Add a key in Settings, or use the browser's own speech recognition." },
        { status: 400 },
      );
    }

    const body = (await req.json().catch(() => ({}))) as {
      audio?: { mimeType?: string; data?: string };
      model?: string;
    };
    const mimeType = String(body.audio?.mimeType ?? "");
    const data = String(body.audio?.data ?? "");

    if (!ALLOWED_AUDIO.test(mimeType)) {
      return NextResponse.json({ error: "That audio format is not supported. Record the note again." }, { status: 400 });
    }
    if (!data || data.length > MAX_AUDIO_CHARS) {
      return NextResponse.json({ error: "The recording is empty or too long. Keep voice notes under 2 minutes." }, { status: 400 });
    }

    const cfg: AiConfig = body.model ? { ...aiConfig, model: body.model } : aiConfig;

    let transcript = "";
    try {
      transcript =
        cfg.provider === "gemini"
          ? await transcribeWithGemini(cfg, mimeType, data)
          : await transcribeWithOpenAI(cfg, mimeType, data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Transcription failed.";
      return NextResponse.json(
        {
          error: `${message} Your browser's own speech recognition is used when it is available.`,
        },
        { status: 502 },
      );
    }

    return NextResponse.json({ transcript }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleApiError(err);
  }
}
