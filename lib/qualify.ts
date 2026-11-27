import { Type, type Schema } from "@google/genai";
import { buildOrchestratedSystemPrompt } from "./ai/orchestrator";
import { getActiveOwnerAiContext } from "./ai/context";
import { LLMGateway } from "./llm/gateway";
import { verifyEmailDeliverability } from "./search/emailVerify";
import type { CampaignConfig, Lead, QualificationResult, ResearchResult } from "./types";

const SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    score: { type: Type.INTEGER, description: "0-100 quantitative fit score (0 if kill_switch_triggered=true)" },
    tier: { type: Type.STRING, enum: ["A", "B", "C", "DISQUALIFIED"] },
    category: { type: Type.STRING, enum: ["high", "medium", "low", "not_qualified", "needs_research"] },
    kill_switch_triggered: { type: Type.BOOLEAN },
    disqualification_reason: { type: Type.STRING },
    verified_facts: { type: Type.ARRAY, items: { type: Type.STRING } },
    missing_data: { type: Type.ARRAY, items: { type: Type.STRING } },
    awareness_level: {
      type: Type.STRING,
      enum: ["Unaware", "Problem-Aware", "Solution-Aware", "Product-Aware", "Most-Aware"],
    },
    recommended_template_id: {
      type: Type.STRING,
      enum: ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11", "T12"],
    },
    personalized_hook_candidates: { type: Type.ARRAY, items: { type: Type.STRING } },
    reasons: { type: Type.ARRAY, items: { type: Type.STRING }, description: "3-5 short concrete reasons for the score" },
    opportunity: { type: Type.STRING, description: "The single most useful observed opportunity" },
    value_tier: { type: Type.STRING, enum: ["high", "medium", "low", "unknown"] },
    recommended_service: { type: Type.STRING },
    disqualify_reason: { type: Type.STRING },
  },
  required: [
    "score",
    "tier",
    "category",
    "kill_switch_triggered",
    "verified_facts",
    "missing_data",
    "awareness_level",
    "recommended_template_id",
    "personalized_hook_candidates",
    "reasons",
    "opportunity",
    "value_tier",
    "recommended_service",
  ],
};

const QUALIFY_TASK = `Run Workflow A (research_and_qualify) using Module 1's Quantitative 100-Point Lead Qualification & Disqualification Engine and Hard Kill-Switches.

Evaluation Rules:
- Check ALL Hard Kill-Switches (KILL-1 scope/exclusion trap matching USER_EXCLUSIONS or outside USER_OFFER; KILL-2 closed/abandoned/inactive; KILL-3 invalid/unverified high-risk contact or opted-out; KILL-4 zero verifiable facts). If ANY is true -> kill_switch_triggered=true, score=0, tier="DISQUALIFIED", category="not_qualified", and populate disqualification_reason.
- Score 0-100 using exact Module 1 weights:
  * Problem-Offer Fit & Scope Safety (0-25)
  * Willingness & Ability to Pay / WTP Proof (0-30)
  * Trigger Timing & Cost of Inaction (0-25)
  * Reachability & Personalization Depth (0-20)
- Assign tier: A (80-100), B (65-79), C (50-64), DISQUALIFIED (<50).
- Map category: "high" for A, "medium" for B, "low" or "needs_research" for C when evidence is thin, "not_qualified" for DISQUALIFIED.
- Separate verified_facts from missing_data clearly. Never assume a need without evidence.
- Classify buyer awareness_level and assign the best template ID (T1-T12) + 1-3 grounded personalized_hook_candidates.
- Do not fabricate scores, revenue, or facts.`;

export async function qualifyLeadServer(
  lead: Lead,
  research: ResearchResult | null,
  campaign: CampaignConfig,
  minScore: number,
  knowledge?: string,
  model?: string,
  options?: { ownerId?: string },
): Promise<QualificationResult> {
  const orchestrated = await buildOrchestratedSystemPrompt({
    workflow: "research_and_qualify",
    ownerId: options?.ownerId ?? lead.ownerId ?? null,
    campaign,
    knowledgeDigest: knowledge,
    taskInstructions: QUALIFY_TASK,
  });

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

  const emailCheck = lead.email ? await verifyEmailDeliverability(lead.email).catch(() => null) : null;
  const emailBlock = emailCheck
    ? `Email Verification: mxVerified=${emailCheck.mxVerified}, emailType=${emailCheck.emailType}${emailCheck.reason ? ` (${emailCheck.reason})` : ""}`
    : "Email Verification: none";

  const user = `PROSPECT
Business: ${lead.business ?? "(unknown)"}
Contact: ${lead.contact_name ?? "(unknown)"} ${lead.role ?? ""}
Email: ${lead.email ?? "(none)"} (${emailBlock})
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

The campaign minimum score is ${minScore}. Always return an honest score; never inflate scores to pass threshold.`;

  void model;
  const ownerId = options?.ownerId ?? lead.ownerId ?? getActiveOwnerAiContext()?.ownerId ?? "anonymous";
  const { data: raw } = await LLMGateway.completeJSON<QualificationResult>({
    ownerId,
    taskType: "balanced",
    feature: "qualify",
    systemPrompt: orchestrated.system,
    messages: [{ role: "user", content: user }],
    schema: SCHEMA,
  });

  const killSwitch = Boolean(raw.kill_switch_triggered || raw.category === "not_qualified");
  const score = killSwitch ? 0 : Math.max(0, Math.min(100, Math.round(Number(raw.score ?? 0))));
  const tier: QualificationResult["tier"] = killSwitch
    ? "DISQUALIFIED"
    : score >= 80
      ? "A"
      : score >= 65
        ? "B"
        : score >= 50
          ? "C"
          : "DISQUALIFIED";
  const disqReason = killSwitch
    ? raw.disqualification_reason || raw.disqualify_reason || "Disqualified by Module 1 kill-switch."
    : raw.disqualification_reason || raw.disqualify_reason || null;

  return {
    ...raw,
    score,
    tier,
    kill_switch_triggered: killSwitch,
    disqualification_reason: disqReason,
    disqualify_reason: disqReason ?? undefined,
    category: killSwitch ? "not_qualified" : raw.category,
  };
}
