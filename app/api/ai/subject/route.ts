import { NextRequest, NextResponse } from "next/server";
import { Type } from "@google/genai";
import { handleApiError } from "@/lib/api-helpers";
import { buildOrchestratedSystemPrompt, stripUnresolvedPlaceholders } from "@/lib/ai/orchestrator";
import { LLMGateway } from "@/lib/llm/gateway";
import { verifyRequest } from "@/lib/server-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BODY = 8_000;

function cleanSubject(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return stripUnresolvedPlaceholders(
    raw
      .replace(/^\s*(subject|re)\s*:\s*/i, "")
      .replace(/^["'“”]+|["'“”]+$/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  ).slice(0, 120);
}

/**
 * Suggests subject lines grounded in the Global Knowledge Subject Line Architecture
 * (Module 3 Section 2) and the supplied body text.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const payload = (await req.json().catch(() => ({}))) as {
      body?: unknown;
      kind?: unknown;
      originalSubject?: unknown;
      business?: unknown;
    };

    const text = typeof payload.body === "string" ? payload.body.trim().slice(0, MAX_BODY) : "";
    const isReply = payload.kind === "reply";
    const original = typeof payload.originalSubject === "string" ? payload.originalSubject.trim().slice(0, 200) : "";
    const business = typeof payload.business === "string" ? payload.business.trim().slice(0, 200) : "";

    if (!text) {
      return NextResponse.json(
        { error: "Write the message first — subjects come from what you actually say." },
        { status: 400 },
      );
    }

    const taskInstructions = [
      "Suggest exactly three subject lines following Module 3 Subject Line Architecture (2-5 words, under 40 chars preferred, all-lowercase or natural sentence case, zero emojis, zero clickbait, zero ALL CAPS, zero exclamation marks).",
      "Every subject must stay strictly grounded in the message: never invent offers, numbers, or urgency, and never include raw {{...}} tags.",
      isReply
        ? "This is a reply to a prospect, so keep the subject conversational and thread-native."
        : "This is a cold or follow-up email: never fake Re:/Fwd: prefixes on a new cold touch.",
      original ? `Their original subject was: ${original}` : "",
      business ? `The prospect is: ${business}.` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const orchestrated = await buildOrchestratedSystemPrompt({
      workflow: isReply ? "handle_reply" : "draft_outreach",
      ownerId: user.ownerId,
      taskInstructions,
    });

    const { data: result } = await LLMGateway.completeJSON<{ subjects?: unknown }>({
      ownerId: user.ownerId,
      taskType: "fast",
      feature: "subject",
      systemPrompt: orchestrated.system,
      messages: [{ role: "user", content: `MESSAGE\n${text}` }],
      schema: {
        type: Type.OBJECT,
        properties: {
          subjects: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ["subjects"],
      },
    });

    const seen = new Set<string>();
    const subjects: string[] = [];
    for (const raw of Array.isArray(result.subjects) ? result.subjects : []) {
      const value = cleanSubject(raw);
      const key = value.toLowerCase();
      if (!value || seen.has(key)) continue;
      seen.add(key);
      subjects.push(value);
      if (subjects.length === 3) break;
    }

    if (subjects.length === 0) {
      return NextResponse.json(
        { error: "The model did not return a usable subject. Try again or pick another model." },
        { status: 502 },
      );
    }
    return NextResponse.json({ subjects });
  } catch (err) {
    return handleApiError(err);
  }
}
