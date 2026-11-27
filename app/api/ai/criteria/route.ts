import { Type, type Schema } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import {
  BUDGET_OPTIONS,
  BUSINESS_SIZE_OPTIONS,
  DEFAULT_CRITERIA,
  INDUSTRY_OPTIONS,
  ONLINE_PRESENCE_OPTIONS,
  RATING_OPTIONS,
  SERVICE_OPTIONS,
  sanitizeCriteria,
  type ResearchCriteria,
} from "@/lib/criteria";
import { LLMGateway } from "@/lib/llm/gateway";
import { verifyRequest } from "@/lib/server-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CRITERIA_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    industry: { type: Type.STRING, enum: INDUSTRY_OPTIONS },
    businessSize: { type: Type.STRING, enum: BUSINESS_SIZE_OPTIONS },
    services: { type: Type.ARRAY, items: { type: Type.STRING, enum: SERVICE_OPTIONS } },
    budget: { type: Type.STRING, enum: BUDGET_OPTIONS },
    onlinePresence: { type: Type.STRING, enum: ONLINE_PRESENCE_OPTIONS },
    rating: { type: Type.STRING, enum: RATING_OPTIONS },
    count: { type: Type.INTEGER },
    minScore: { type: Type.INTEGER },
    focus: { type: Type.STRING, description: "One or two sentences of extra targeting nuance, or empty." },
    autoRationale: { type: Type.STRING, description: "Why these filters fit the knowledge base, in one short sentence." },
  },
  required: [
    "industry",
    "businessSize",
    "services",
    "budget",
    "onlinePresence",
    "rating",
    "count",
    "minScore",
    "focus",
    "autoRationale",
  ],
};

/**
 * Turns either a plain-English request ("find me dentists in Lagos") or the
 * knowledge base alone into the criteria form, so Auto mode always shows a
 * concrete, editable set of filters before anything runs.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const body = (await req.json().catch(() => ({}))) as {
      instruction?: string;
      knowledge?: string;
      current?: Partial<ResearchCriteria>;
      mode?: "auto" | "instruction";
    };

    const instruction = String(body.instruction ?? "").trim().slice(0, 2000);
    const knowledge = String(body.knowledge ?? "").trim().slice(0, 3_000);
    const current = { ...DEFAULT_CRITERIA, ...(body.current ?? {}) };

    if (body.mode === "instruction" && !instruction) {
      return NextResponse.json({ error: "Describe the prospects you want first." }, { status: 400 });
    }

    const system = `You fill a prospect-research brief for a web design and digital services business.

Choose ONLY values from the allowed lists. Never invent an option.
- industry: the closest listed segment.
- services: at most 3 services the business actually sells (from the knowledge base when it is provided).
- onlinePresence and rating: only narrow them when the request implies it; otherwise use "Any presence" / "Any rating".
- budget: "Not sure yet" unless the request states one.
- count: 3-20 prospects, default 8.
- minScore: 45-75, default 55.
- focus: one or two sentences of extra targeting nuance a researcher could act on, or empty.
- autoRationale: one short sentence on why these filters fit.

Knowledge base (source of truth for the services and offers):
${knowledge || "(empty — use the allowed service list conservatively)"}`;

    const userPrompt = instruction
      ? `The user asked: "${instruction}"

Fill the brief for exactly this request.`
      : `No instruction was given. Pick the strongest default brief for this business: which segment, which service, and which weakness to target.`;

    const { data: result } = await LLMGateway.completeJSON<Record<string, unknown>>({
      ownerId: user.ownerId,
      taskType: "fast",
      feature: "criteria",
      systemPrompt: system,
      messages: [{ role: "user", content: userPrompt }],
      schema: CRITERIA_SCHEMA,
      maxTokens: 1000,
    });

    const criteria = sanitizeCriteria(
      { ...result, auto: true },
      { ...current, auto: true },
    );

    return NextResponse.json({ criteria }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleApiError(err);
  }
}
