import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { LLMGateway } from "@/lib/llm/gateway";
import { verifyRequest } from "@/lib/server-auth";
import { Type, type Schema } from "@google/genai";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface ResearchChatRequest {
  prospect: Record<string, unknown>;
  question: string;
  history?: { role: "user" | "assistant"; content: string }[];
  model?: string;
}

interface ResearchChatResponse {
  answer: string;
  sources: string[];
  inResearch: boolean;
}

const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    answer: {
      type: Type.STRING,
      description: "Direct, truthful answer citing only verified facts from the research. If not in research, state that plainly.",
    },
    sources: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "List of source URLs or citations mentioned in the research that support this answer",
    },
    inResearch: {
      type: Type.BOOLEAN,
      description: "True if the question could be answered from the research data, false if the requested detail was not found in the research.",
    },
  },
  required: ["answer", "sources", "inResearch"],
};

export async function POST(req: NextRequest) {
  try {
    const authUser = await verifyRequest(req);
    const body = (await req.json()) as ResearchChatRequest;

    if (!body.prospect || !body.question) {
      return NextResponse.json({ error: "Prospect data and question are required." }, { status: 400 });
    }

    const system = `You are a strict, evidence-based research assistant answering questions about a specific prospect.

GROUNDING RULES (STRICT):
1. You can ONLY use the facts, contact details, sources, issues, and qualification review contained in the PROSPECT RESEARCH DATA below.
2. If any piece of information is missing or cannot be verified from the data, you MUST say honestly and plainly: "This information was not found in the collected research." NEVER invent, assume, or guess anything.
3. Every fact you mention must be backed by the source URL or verification note from the data.
4. When explaining qualification verdicts or decisions, quote the specific criteria (met, not met, unknown), weaknesses, and risks recorded in the review.
5. Be candid, neutral, and precise.`;

    const prospectSummary = JSON.stringify(body.prospect, null, 2);

    const historyBlock = body.history && body.history.length > 0
      ? `\nCONVERSATION HISTORY:\n${body.history.map((h) => `${h.role.toUpperCase()}: ${h.content}`).join("\n")}\n`
      : "";

    const user = `PROSPECT RESEARCH DATA:
${prospectSummary}
${historyBlock}
QUESTION: ${body.question}

Answer based ONLY on the research data above.`;

    const { data: result } = await LLMGateway.completeJSON<ResearchChatResponse>({
      ownerId: authUser.ownerId,
      taskType: "balanced",
      feature: "research_chat",
      systemPrompt: system,
      messages: [{ role: "user", content: user }],
      schema: RESPONSE_SCHEMA,
    });

    return NextResponse.json(result);
  } catch (err) {
    return handleApiError(err);
  }
}
