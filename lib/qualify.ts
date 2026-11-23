import { Type, type Schema } from "@google/genai";
import { geminiJSON } from "./gemini";
import type { CampaignConfig, Lead, QualificationResult, ResearchResult } from "./types";

const SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    score: { type: Type.INTEGER, description: "0-100 fit score" },
    category: { type: Type.STRING, enum: ["high", "medium", "low", "not_qualified", "needs_research"] },
    reasons: { type: Type.ARRAY, items: { type: Type.STRING }, description: "3-5 short reasons for the score" },
    opportunity: { type: Type.STRING, description: "The single most useful observed opportunity" },
    value_tier: { type: Type.STRING, enum: ["high", "medium", "low", "unknown"] },
    recommended_service: { type: Type.STRING },
    disqualify_reason: { type: Type.STRING },
  },
  required: ["score", "category", "reasons", "opportunity", "value_tier", "recommended_service"],
};

const SYSTEM = `You qualify B2B prospects for the sender's business, using the services and ideal customer profile from the supplied context.

Score 0-100 using these weights:
- Relevance to the services the sender actually sells (30)
- Business legitimacy and verifiability (20)
- Quality and specificity of available information (20)
- Clarity of an evidenced opportunity (20)
- Ability to personalise a credible message (10)

Rules:
- Category "not_qualified" when there is no verifiable business, no way to contact a decision maker, or the business is clearly a direct competitor.
- Category "needs_research" when evidence is too thin to judge - do not guess.
- "high" requires at least one specific, evidenced opportunity and a real contact email.
- Never assume a business needs a website without evidence. Missing evidence is not an opportunity.
- Reasons must be concrete and refer to the actual evidence supplied.
- Do not output prices, revenue or invented facts.`;

export async function qualifyLeadServer(
  lead: Lead,
  research: ResearchResult | null,
  campaign: CampaignConfig,
  minScore: number,
  knowledge?: string,
  model?: string,
): Promise<QualificationResult> {
  const researchBlock = research
    ? `RESEARCH (confidence ${research.confidence}/100${research.insufficient_data ? ", insufficient" : ""})
Summary: ${research.summary}
Website status: ${research.website_status}
Verified facts: ${research.verified_facts.map((f) => `${f.fact} (${f.source})`).join("; ") || "(none)"}
Findings: ${research.findings.map((f) => `[${f.severity}] ${f.area}: ${f.observation} (evidence: ${f.evidence})`).join("; ") || "(none)"}
Inferences: ${research.inferences.join("; ") || "(none)"}
Opportunities: ${research.opportunities.map((o) => `${o.opportunity} -> ${o.service}`).join("; ") || "(none)"}
Recommended angle: ${research.recommended_angle}`
    : "RESEARCH: none yet.";

  const user = `${knowledge ? `BUSINESS KNOWLEDGE BASE\n${knowledge}\n\n` : ""}PROSPECT
Business: ${lead.business ?? "(unknown)"}
Contact: ${lead.contact_name ?? "(unknown)"} ${lead.role ?? ""}
Email: ${lead.email ?? "(none)"}
Website: ${lead.website ?? "(none known)"}
Location: ${lead.location ?? "(unknown)"}
Industry: ${lead.industry ?? "(unknown)"}
Notes: ${lead.notes ?? "(none)"}

CAMPAIGN
Objective: ${campaign.objective}
Services in focus: ${campaign.services.join(", ")}
Target industry: ${campaign.target_industry}
Extra instructions: ${campaign.extra_instructions || "(none)"}

${researchBlock}

The campaign minimum score is ${minScore}. Always return an honest score; do not inflate it to reach the threshold.`;

  return geminiJSON<QualificationResult>({
    system: SYSTEM,
    user,
    schema: SCHEMA,
    model,
  });
}
