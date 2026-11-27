import { Type, type Schema } from "@google/genai";
import { getActiveOwnerAiContext } from "./ai/context";
import { buildOrchestratedSystemPrompt, findUnresolvedPlaceholders, stripUnresolvedPlaceholders } from "./ai/orchestrator";
import { checkSendingTierDeliverability } from "./guardrails";
import { LLMGateway } from "./llm/gateway";
import { cleanEmailText } from "./outreach-utils";
import type { CampaignConfig, Lead, Message, ResearchResult, Settings } from "./types";

export interface ComposedEmail {
  subject: string;
  body: string;
  angle: string;
  rationale: string;
  service: string;
  evidence: string[];
  template_id?: string;
  /** Result of Module 2's 8-point & knowledge-base self-check before display. */
  check?: DraftCheck;
  deliverability_warnings?: string[];
}

export interface DraftCheck {
  passed: boolean;
  issues: string[];
  kb_items_used: string[];
  regenerated: boolean;
}

const CHECK_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    passed: { type: Type.BOOLEAN },
    issues: { type: Type.ARRAY, items: { type: Type.STRING } },
    kb_items_used: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "The exact knowledge base & Global Brain rules/items this draft relies on",
    },
  },
  required: ["passed", "issues", "kb_items_used"],
};

/**
 * Combines Module 2's Mandatory 8-Point Quality Gate with the active user's
 * Business Profile, Knowledge Base, and Sending Tier limits.
 */
function checklist(campaign: CampaignConfig, knowledge: string, draft: ComposedEmail, sendingTier: string): string {
  return `USER KNOWLEDGE BASE (source of truth)
${knowledge ? knowledge.slice(0, 2_500) : "(empty)"}

OWNER INSTRUCTION FOR THIS CAMPAIGN
Objective: ${campaign.objective}
Services in focus: ${campaign.services.join(", ") || "(none specified)"}
Tone: ${campaign.tone || "(not specified)"}
Extra instructions: ${campaign.extra_instructions || "(none)"}
Sending tier: ${sendingTier}

DRAFT UNDER REVIEW
Template ID: ${draft.template_id || "auto"}
Subject: ${draft.subject}
${draft.body}

AUDIT AGAINST MODULE 2'S 8-POINT QUALITY GATE & USER KB:
1. [WORD COUNT]: Touch 1 is ~45-95 words (follow-ups 25-65 words), short 1-2 sentence mobile-friendly paragraphs, plain text.
2. [FIRST LINE]: Opens with a verified 1-2 sentence observation passing the Face-to-Face test (no generic flattery).
3. [ZERO FABRICATION & ZERO RAW TAGS]: Every fact/metric is grounded in verified prospect data or user proof, and ZERO unresolved {{...}} tags exist.
4. [YOU-FIRST / WIIFM]: "You/Your" outnumbers "I/We" by ~2:1+, translating features into concrete buyer outcomes.
5. [ZERO AI SLOP]: ZERO banned openings ("hope this email finds you well", "came across your website"), buzzwords ("game-changer", "elevate", "synergy", "bespoke", "delve"), or service laundry lists.
6. [SINGLE CLEAR CTA]: One low-friction, interest-based question (never a pushy 30-min call request on cold Touch 1 or vague "thoughts?").
7. [DELIVERABILITY SAFE]: Subject is 2-5 words, lowercase/sentence case, no Re:/Fwd: clickbait; links/formatting respect Sending Tier (${sendingTier}).
8. [HUMAN VOICE & SCOPE]: Respects USER_EXCLUSIONS and campaign extra instructions cleanly.

Return passed=true only when all eight gates hold. List exact issues to fix if any fail.`;
}

async function reviewDraft(
  campaign: CampaignConfig,
  knowledge: string,
  draft: ComposedEmail,
  sendingTier: string,
  ownerId: string,
): Promise<{ passed: boolean; issues: string[]; kb_items_used: string[] }> {
  try {
    const { data: result } = await LLMGateway.completeJSON<{
      passed: boolean;
      issues: string[];
      kb_items_used: string[];
    }>({
      ownerId,
      taskType: "fast",
      feature: "compose_review",
      systemPrompt:
        "You are a strict Module 2 Direct-Response Quality Gate reviewer. Judge the draft against the 8-point gate, user knowledge base, and campaign instructions. Report failures concisely; never rewrite.",
      messages: [{ role: "user", content: checklist(campaign, knowledge, draft, sendingTier) }],
      schema: CHECK_SCHEMA,
      maxTokens: 1200,
    });
    return {
      passed: result.passed === true,
      issues: Array.isArray(result.issues) ? result.issues.filter((issue) => typeof issue === "string").slice(0, 8) : [],
      kb_items_used: Array.isArray(result.kb_items_used)
        ? result.kb_items_used.filter((item) => typeof item === "string").slice(0, 8)
        : [],
    };
  } catch {
    return { passed: true, issues: [], kb_items_used: [] };
  }
}

const BANNED_SLOP_RE =
  /\b(?:hope this (?:email|message) finds you well|i came across your website|i was browsing your site|game[- ]changer|synergy|delve into|unlock your potential|revolutionize your)\b/i;

async function withKnowledgeCheck(
  draft: ComposedEmail,
  campaign: CampaignConfig,
  knowledge: string,
  sendingTier: string,
  regenerate: (issues: string[]) => Promise<ComposedEmail>,
  ownerId: string,
): Promise<ComposedEmail> {
  const localIssues: string[] = [];
  if (BANNED_SLOP_RE.test(draft.body)) {
    localIssues.push("Remove banned AI cliché phrasing and open with a concrete verified observation.");
  }
  const unresolved = [
    ...findUnresolvedPlaceholders(draft.subject),
    ...findUnresolvedPlaceholders(draft.body),
  ];
  if (unresolved.length > 0) {
    localIssues.push(`Remove unresolved template placeholder(s): ${unresolved.join(", ")}`);
  }

  const first = await reviewDraft(campaign, knowledge, draft, sendingTier, ownerId);
  const combinedIssues = Array.from(new Set([...localIssues, ...first.issues]));
  if (first.passed && localIssues.length === 0) {
    return {
      ...draft,
      rationale: withKbLine(draft.rationale, first.kb_items_used),
      check: { ...first, regenerated: false },
    };
  }

  let second: ComposedEmail;
  try {
    second = await regenerate(combinedIssues);
  } catch {
    return {
      ...draft,
      subject: stripUnresolvedPlaceholders(draft.subject),
      body: stripUnresolvedPlaceholders(draft.body),
      rationale: withKbLine(draft.rationale, first.kb_items_used),
      check: { ...first, passed: localIssues.length === 0 && first.passed, issues: combinedIssues, regenerated: false },
    };
  }
  const recheck = await reviewDraft(campaign, knowledge, second, sendingTier, ownerId);
  return {
    ...second,
    subject: stripUnresolvedPlaceholders(second.subject),
    body: stripUnresolvedPlaceholders(second.body),
    rationale: withKbLine(second.rationale, recheck.kb_items_used.length ? recheck.kb_items_used : first.kb_items_used),
    check: { ...recheck, regenerated: true },
  };
}

function withKbLine(rationale: string, items: string[]): string {
  if (items.length === 0) return rationale;
  return `${rationale.trim()}\n\nKnowledge & rules applied: ${items.join("; ")}`;
}

const SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    template_id: {
      type: Type.STRING,
      enum: ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11", "T12"],
      description: "The Module 3 template scenario selected by deterministic routing",
    },
    subject: { type: Type.STRING, description: "2-5 words, lowercase or natural sentence case, zero clickbait" },
    body: {
      type: Type.STRING,
      description: "Plain text email body (45-95 words for Touch 1, 20-65 words for follow-ups), short paragraphs, zero {{...}} placeholders",
    },
    angle: { type: Type.STRING, description: "The outreach angle in one short phrase" },
    rationale: { type: Type.STRING, description: "Why this template & angle fit verified research (2-3 sentences)" },
    service: { type: Type.STRING },
    evidence: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Verified research facts relied upon" },
  },
  required: ["template_id", "subject", "body", "angle", "rationale", "service", "evidence"],
};

const COMPOSE_INITIAL_TASK = `Execute Workflow B (draft_outreach — Touch 1 Initial Cold Email):
- Deterministic Template Routing (Module 3 Step B): evaluate the prospect's verified hook, awareness level, and inbox type to select the SINGLE best template (T1-T12). If researched recommended_template_id is supplied, prioritize it unless inbox type forces T10.
- Apply Anti-Fingerprint Adaptation: use natural Voice-of-Customer phrasing, 45-95 words total, Grade 3-5 reading level, max 1-2 sentences per paragraph, >=2:1 You-to-I ratio.
- Strictly follow USER_SENDING_TIER deliverability rules:
  * If free_gmail_starter: 0 links ideal (max 1 clean signature link only if verified in USER_PROOF/USER_LEAD_MAGNET), never calendar links, plain text only.
- NEVER emit unresolved {{...}} placeholders or banned AI slop. Pass ALL 8 Module 2 Quality Gate points.`;

const COMPOSE_FOLLOWUP_TASK = `Execute Workflow B (draft_outreach — Same-Thread Follow-Up):
- Follow Module 3's 5-Touch Execution Matrix and Follow-Up Laws strictly.
- Keep it shorter than Touch 1 (20-65 words) and stay on the same thread without copy-pasting the same pitch.
- Use Touch 2 frictionless bump, Touch 3 fresh proof/insight nudge, Touch 4 short binary check, or Touch 5 clean zero-pressure breakup as step dictates.
- Zero guilt-tripping, zero "just following up", zero unresolved {{...}} tags, and respect USER_SENDING_TIER.`;

function identity(settings: Settings, campaign: CampaignConfig): string {
  const name = settings.sender_name || "the sender";
  const firstName = name.split(" ")[0];
  if (campaign.identity === "personal" || !settings.sender_company) {
    return `The sender is ${name}${settings.sender_role ? `, ${settings.sender_role}` : ""}, writing as an independent professional. Sign off as "${firstName}". Do not present them as a company.`;
  }
  return `The sender is ${name}${settings.sender_role ? `, ${settings.sender_role}` : ""} at ${settings.sender_company}. Sign off with "${firstName}" and the company name cleanly.`;
}

function researchBlock(research: ResearchResult): string {
  return `VERIFIED RESEARCH JSON
Summary: ${research.summary}
Website status: ${research.website_status}
Awareness level: ${research.awareness_level || "(infer from facts)"}
Recommended template ID: ${research.recommended_template_id || "(route via Module 3 Step B)"}
Hook candidates: ${(research.personalized_hook_candidates ?? []).join(" | ") || "(none)"}
Verified facts: ${research.verified_facts.map((f) => `${f.fact} [${f.source}]`).join(" | ") || "(none)"}
Website observations: ${research.website_facts.join(" | ") || "(none)"}
Findings: ${research.findings.map((f) => `[${f.severity}] ${f.area}: ${f.observation} (evidence: ${f.evidence})`).join(" | ") || "(none)"}
Missing data (DO NOT GUESS): ${(research.missing_data ?? []).join(" | ") || "(none)"}
Best opportunity: ${research.opportunities.map((o) => `${o.opportunity} (${o.service})`).join(" | ") || "(none)"}
Recommended angle: ${research.recommended_angle}
Research confidence: ${research.confidence}/100${research.insufficient_data ? " - INSUFFICIENT DATA, stay honest and ultra-brief (no invented claims)" : ""}`;
}

function sanitizeComposedDraft(raw: ComposedEmail, isColdTouch1: boolean, sendingTier: "free_gmail_starter" | "authenticated_custom_domain"): ComposedEmail {
  const cleanBody = cleanEmailText(stripUnresolvedPlaceholders(raw.body));
  const cleanSubject = cleanEmailText(stripUnresolvedPlaceholders(raw.subject)).split("\n")[0];
  const deliv = checkSendingTierDeliverability({
    tier: sendingTier,
    subject: cleanSubject,
    body: cleanBody,
    isColdTouch1,
  });

  return {
    ...raw,
    subject: cleanSubject,
    body: cleanBody,
    deliverability_warnings: deliv.warnings.length > 0 ? deliv.warnings : undefined,
  };
}

export async function composeInitialServer(
  lead: Lead,
  research: ResearchResult,
  campaign: CampaignConfig,
  settings: Settings,
  knowledge: string,
  model?: string,
  options?: { ownerId?: string },
): Promise<ComposedEmail> {
  const orchestrated = await buildOrchestratedSystemPrompt({
    workflow: "draft_outreach",
    ownerId: options?.ownerId ?? lead.ownerId ?? null,
    settings,
    campaign,
    knowledgeDigest: knowledge,
    taskInstructions: COMPOSE_INITIAL_TASK,
  });

  const sendingTier = orchestrated.variables.USER_SENDING_TIER;
  const user = `SENDER IDENTITY OVERRIDE
${identity(settings, campaign)}

PROSPECT
Business: ${lead.business ?? "(unknown)"}
Contact: ${lead.contact_name ?? "(unknown)"}
Role: ${lead.role ?? "(unknown)"}
Email: ${lead.email ?? "(unknown)"}
Location: ${lead.location ?? "(unknown)"}
Industry: ${lead.industry ?? "(unknown)"}

${researchBlock(research)}

CAMPAIGN
Objective: ${campaign.objective}
Services in focus: ${campaign.services.join(", ")}
Tone: ${campaign.tone}
Extra instructions from the owner: ${campaign.extra_instructions || "(none)"}

Select the optimal Module 3 template (T1-T12) and write the Touch 1 email passing all 8 Module 2 gates with ZERO raw {{...}} tags.`;

  void model;
  const ownerId = options?.ownerId ?? lead.ownerId ?? getActiveOwnerAiContext()?.ownerId ?? "anonymous";
  const { data: draft } = await LLMGateway.completeJSON<ComposedEmail>({
    ownerId,
    taskType: "balanced",
    feature: "compose_initial",
    systemPrompt: orchestrated.system,
    messages: [{ role: "user", content: user }],
    schema: SCHEMA,
    maxTokens: 1600,
  });
  const cleaned = sanitizeComposedDraft(draft, true, sendingTier);

  return withKnowledgeCheck(
    cleaned,
    campaign,
    knowledge,
    sendingTier,
    async (issues) => {
      const { data: revised } = await LLMGateway.completeJSON<ComposedEmail>({
        ownerId,
        taskType: "balanced",
        feature: "compose_initial",
        systemPrompt: orchestrated.system,
        messages: [
          {
            role: "user",
            content: `${user}\n\nYOUR PREVIOUS DRAFT FAILED THE 8-POINT QUALITY / KB CHECK:\n${issues
              .map((issue) => `- ${issue}`)
              .join("\n")}\n\nRewrite the email cleanly so every issue is fixed and ZERO {{...}} tags exist.`,
          },
        ],
        schema: SCHEMA,
        maxTokens: 1600,
      });
      return sanitizeComposedDraft(revised, true, sendingTier);
    },
    ownerId,
  );
}

export async function composeFollowUpServer(
  lead: Lead,
  research: ResearchResult | null,
  campaign: CampaignConfig,
  settings: Settings,
  knowledge: string,
  original: Message,
  step: number,
  model?: string,
  options?: { ownerId?: string },
): Promise<ComposedEmail> {
  const orchestrated = await buildOrchestratedSystemPrompt({
    workflow: "draft_outreach",
    ownerId: options?.ownerId ?? lead.ownerId ?? null,
    settings,
    campaign,
    knowledgeDigest: knowledge,
    taskInstructions: COMPOSE_FOLLOWUP_TASK,
  });

  const sendingTier = orchestrated.variables.USER_SENDING_TIER;
  const user = `SENDER IDENTITY OVERRIDE
${identity(settings, campaign)}

PROSPECT
Business: ${lead.business ?? "(unknown)"}
Contact: ${lead.contact_name ?? "(unknown)"}
Industry: ${lead.industry ?? "(unknown)"}
Location: ${lead.location ?? "(unknown)"}

${research ? researchBlock(research) : "VERIFIED RESEARCH: none stored."}

CAMPAIGN
Objective: ${campaign.objective}
Services in focus: ${campaign.services.join(", ")}
Tone: ${campaign.tone}
Extra instructions: ${campaign.extra_instructions || "(none)"}

ORIGINAL EMAIL SENT
Subject: ${original.subject}
${original.body}

This is Touch #${step} in the Module 3 Follow-Up Matrix. Write a shorter same-thread follow-up adding a fresh angle or binary check with zero guilt-tripping and zero {{...}} placeholders.`;

  void model;
  const ownerId = options?.ownerId ?? lead.ownerId ?? getActiveOwnerAiContext()?.ownerId ?? "anonymous";
  const { data: draft } = await LLMGateway.completeJSON<ComposedEmail>({
    ownerId,
    taskType: "balanced",
    feature: "compose_followup",
    systemPrompt: orchestrated.system,
    messages: [{ role: "user", content: user }],
    schema: SCHEMA,
    maxTokens: 1600,
  });
  const cleaned = sanitizeComposedDraft(draft, false, sendingTier);

  return withKnowledgeCheck(
    cleaned,
    campaign,
    knowledge,
    sendingTier,
    async (issues) => {
      const { data: revised } = await LLMGateway.completeJSON<ComposedEmail>({
        ownerId,
        taskType: "balanced",
        feature: "compose_followup",
        systemPrompt: orchestrated.system,
        messages: [
          {
            role: "user",
            content: `${user}\n\nYOUR PREVIOUS DRAFT FAILED THE 8-POINT QUALITY / KB CHECK:\n${issues
              .map((issue) => `- ${issue}`)
              .join("\n")}\n\nRewrite the follow-up cleanly so every point is fixed.`,
          },
        ],
        schema: SCHEMA,
        maxTokens: 1600,
      });
      return sanitizeComposedDraft(revised, false, sendingTier);
    },
    ownerId,
  );
}
