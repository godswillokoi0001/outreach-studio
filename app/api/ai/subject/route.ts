import { NextRequest, NextResponse } from "next/server";
import { Type } from "@google/genai";
import { handleApiError } from "@/lib/api-helpers";
import { resolveAiConfigForRequest } from "@/lib/ai/context";
import { providerJSON } from "@/lib/ai/chat";
import { verifyRequest } from "@/lib/server-auth";

export const dynamic = "force-dynamic";

const MAX_BODY = 8_000;

function cleanSubject(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/^\s*(subject|re)\s*:\s*/i, "")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * Suggests subject lines for a message the user is about to send, either a cold
 * email or a reply. The body is the source of truth: the model may only draw on
 * what is already written, never invent an offer or a number.
 */
export async function POST(req: NextRequest) {
  try {
    await verifyRequest(req);
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

    const aiConfig = await resolveAiConfigForRequest(req);
    if (!aiConfig) {
      return NextResponse.json(
        { error: "Connect an AI provider in Settings before asking for a subject." },
        { status: 400 },
      );
    }

    const system = [
      "You write subject lines for outreach email sent by a real businessperson from their own inbox.",
      "Suggest exactly three subject lines, each under 60 characters, no emojis, no clickbait, no ALL CAPS, no exclamation marks.",
      "Every subject must be grounded in the message: name the specific thing it is about. Never invent an offer, discount, number or urgency.",
      isReply
        ? "This is a reply to a prospect, so the subjects should read like a natural answer in an ongoing conversation."
        : "This is a cold or follow-up email, so the subjects should be specific and easy to open.",
      original ? `Their original subject was: ${original}` : "",
      business ? `The prospect is: ${business}.` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const result = await providerJSON<{ subjects?: unknown }>(aiConfig, {
      system,
      user: `MESSAGE\n${text}`,
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
