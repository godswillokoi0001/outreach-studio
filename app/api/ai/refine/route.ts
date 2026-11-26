import { NextRequest, NextResponse } from "next/server";
import { Type } from "@google/genai";
import { handleApiError } from "@/lib/api-helpers";
import { resolveAiConfigForRequest } from "@/lib/ai/context";
import { buildOrchestratedSystemPrompt, stripUnresolvedPlaceholders } from "@/lib/ai/orchestrator";
import { providerJSON } from "@/lib/ai/chat";
import { verifyRequest } from "@/lib/server-auth";

export const dynamic = "force-dynamic";

const MAX_BODY = 14_000;
const MAX_INSTRUCTION = 400;

/**
 * Rewrites a message using the Global Copywriting/Reply Intelligence + strict
 * anti-fabrication & zero-placeholder guarantees.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
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

    const taskInstructions = [
      "Rewrite the message supplied by the user according to their edit instruction, while enforcing Module 2 plain-English copywriting, zero AI slop, and zero fabrication.",
      "Rules:",
      "- Return the rewritten message body only (light Markdown permitted if present). No subject line, no quotes around it, no commentary, no code fences.",
      "- Preserve every verified fact, name, number, date, link, and scope boundary accurately; never invent new claims or insert unresolved {{...}} tags.",
      "- Keep greeting and signature when present, unless instructed otherwise.",
      isReply
        ? "- Reply context (Module 4): calm, same-thread human response."
        : "- Cold/follow-up context (Modules 2-3): concise, peer-level, deliverable-safe.",
    ].join("\n");

    const orchestrated = await buildOrchestratedSystemPrompt({
      workflow: isReply ? "handle_reply" : "draft_outreach",
      ownerId: user.ownerId,
      taskInstructions,
    });

    const result = await providerJSON<{ text?: unknown }>(aiConfig, {
      system: orchestrated.system,
      user: `HOW TO CHANGE IT\n${instruction}\n\nMESSAGE TO REWRITE\n${text}`,
      schema: {
        type: Type.OBJECT,
        properties: { text: { type: Type.STRING } },
        required: ["text"],
      },
    });

    const refined = typeof result.text === "string" ? stripUnresolvedPlaceholders(result.text.trim()) : "";
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
