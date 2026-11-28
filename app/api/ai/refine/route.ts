import { NextRequest, NextResponse } from "next/server";
import { Type } from "@google/genai";
import { handleApiError } from "@/lib/api-helpers";
import { buildOrchestratedSystemPrompt, stripUnresolvedPlaceholders } from "@/lib/ai/orchestrator";
import { LLMGateway } from "@/lib/llm/gateway";
import { verifyRequest } from "@/lib/server-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

    const orchestrated = await buildOrchestratedSystemPrompt({
      workflow: isReply ? "handle_reply" : "draft_outreach",
      ownerId: user.ownerId,
      taskInstructions:
        "Rewrite the supplied message faithfully according to the user's instruction without inventing claims or leaving placeholders.",
    });

    const { data: result } = await LLMGateway.completeJSON<{ text?: unknown }>(
      {
      ownerId: user.ownerId,
      taskType: "fast",
      feature: "refine",
      systemPrompt: orchestrated.system,
      messages: [{ role: "user", content: `HOW TO CHANGE IT\n${instruction}\n\nMESSAGE TO REWRITE\n${text.slice(0, 6_000)}` }],
      schema: {
        type: Type.OBJECT,
        properties: { text: { type: Type.STRING } },
        required: ["text"],
      },
      maxTokens: 1400,
      },
      {
        // An empty rewrite is retryable, not a user-facing dead end: the
        // gateway fails over to the next healthy model instead of returning
        // the old "The model returned an empty rewrite" error.
        validate: (data) => {
          const value = typeof data?.text === "string" ? data.text.trim() : "";
          if (!value) {
            throw new Error("Refine produced an empty rewrite.");
          }
        },
      },
    );

    const refined = typeof result.text === "string" ? stripUnresolvedPlaceholders(result.text.trim()) : "";
    if (!refined) {
      return NextResponse.json(
        { error: "The rewrite service is briefly unavailable. Retry in a moment." },
        { status: 502 },
      );
    }
    return NextResponse.json({ text: refined });
  } catch (err) {
    return handleApiError(err);
  }
}
