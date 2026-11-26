import { NextRequest, NextResponse } from "next/server";
import { Type } from "@google/genai";
import { handleApiError } from "@/lib/api-helpers";
import { resolveAiConfigForRequest } from "@/lib/ai/context";
import { providerJSON } from "@/lib/ai/chat";
import { verifyRequest } from "@/lib/server-auth";

export const dynamic = "force-dynamic";

const MAX_BODY = 14_000;
const MAX_INSTRUCTION = 400;

/**
 * Rewrites a message the user already wrote (or a suggestion they started from).
 * The only job is the change they asked for: every fact, name, number, link and
 * promise must survive untouched, so a refine can never invent a claim.
 */
export async function POST(req: NextRequest) {
  try {
    await verifyRequest(req);
    const payload = (await req.json().catch(() => ({}))) as {
      body?: unknown;
      instruction?: unknown;
      kind?: unknown;
    };

    const text = typeof payload.body === "string" ? payload.body.trim().slice(0, MAX_BODY) : "";
    const instruction =
      typeof payload.instruction === "string" ? payload.instruction.trim().slice(0, MAX_INSTRUCTION) : "";
    const isReply = payload.kind === "reply";

    if (!text) {
      return NextResponse.json(
        { error: "Write or paste the message first, then refine it." },
        { status: 400 },
      );
    }
    if (!instruction) {
      return NextResponse.json(
        { error: "Say how the rewrite should change — a tone, or a concrete edit." },
        { status: 400 },
      );
    }

    const aiConfig = await resolveAiConfigForRequest(req);
    if (!aiConfig) {
      return NextResponse.json(
        { error: "Connect an AI provider in Settings before refining a message." },
        { status: 400 },
      );
    }

    const system = [
      "You are a careful editor for outreach email that a real businessperson sends from their own inbox.",
      "Rewrite the message the user supplies so it follows their instruction exactly.",
      "Rules:",
      "- Return the full rewritten message only, in the same light Markdown the user wrote (**bold**, *italic*, - list items, [text](url)). No subject line, no quotation marks around it, no commentary, no code fences.",
      "- Keep every fact, name, number, price, date, link and promise exactly as written. Never invent specifics or new claims.",
      "- Keep the greeting and signature when present, unless the instruction says otherwise.",
      isReply
        ? "- This is a reply to a prospect's message: sound like a person answering them, not a marketing blast."
        : "- This is a first or follow-up cold email: keep it specific, calm and easy to answer.",
      "- If the instruction conflicts with keeping the facts, keep the facts and apply the tone only.",
    ].join("\n");

    const result = await providerJSON<{ text?: unknown }>(aiConfig, {
      system,
      user: `HOW TO CHANGE IT\n${instruction}\n\nMESSAGE TO REWRITE\n${text}`,
      schema: {
        type: Type.OBJECT,
        properties: { text: { type: Type.STRING } },
        required: ["text"],
      },
    });

    const refined = typeof result.text === "string" ? result.text.trim() : "";
    if (!refined) {
      return NextResponse.json(
        { error: "The model returned an empty rewrite. Try again or pick another model." },
        { status: 502 },
      );
    }
    return NextResponse.json({ text: refined });
  } catch (err) {
    return handleApiError(err);
  }
}
