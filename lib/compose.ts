import { Type, type Schema } from "@google/genai";
import { getActiveOwnerAiContext } from "./ai/context";
import { buildOrchestratedSystemPrompt, findUnresolvedPlaceholders, stripUnresolvedPlaceholders } from "./ai/orchestrator";
import { checkSendingTierDeliverability } from "./guardrails";
import { LLMGateway } from "./llm/gateway";
import { cleanEmailText, normalizeEmailGreeting } from "./outreach-utils";
import type { CampaignConfig, Lead, Message, ResearchResult, Settings } from "./types";

export interface ComposedEmail {
  subject: string;
  body: string;
  angle: string;
  rationale: string;
  service: string;
  evidence: string[];
  template_id?: string;
  /** Result of the deterministic quality gate run before display. */
  check?: DraftCheck;
  deliverability_warnings?: string[];
}

export interface DraftCheck {
  passed: boolean;
  issues: string[];
  kb_items_used: string[];
  regenerated: boolean;
}

const BANNED_SLOP_RE =
  /\b(?:hope this (?:email|message) finds you well|thrilled to reach out|i came across your website|i was browsing your site|conversion optimization|improved mobile responsiveness|digital landscape|take your business to the next level|game[- ]changer|synergy|delve(?: into)?|unlock your potential|revolutionize your|elevate|leverage|seamless|bespoke|utilize)\b/gi;

const FORCED_OPTOUT_FOOTER_RE =
  /(?:if you['’]?d rather not hear from me again|reply ["']?stop["']? to opt out|to opt out,? reply|unsubscribe from future emails|click here to unsubscribe)/i;

const EMPTY_GREETING_RE = /^(?:hi|hello|hey|dear)\s*[,:]?\s*$/im;

export interface EmailQualityInput {
  subject: string;
  body: string;
  kind: "initial" | "followup";
  leadBusiness?: string | null;
  leadContactName?: string | null;
  wordsToAvoid?: string[];
  includeOptOutFooter?: boolean;
  identity?: "personal" | "company";
}

export interface EmailQualityReport {
  passed: boolean;
  wordCount: number;
  issues: string[];
}

export function extractWordsToAvoid(knowledge: string, exclusionsText?: string): string[] {
  const combined = `${knowledge}\n${exclusionsText ?? ""}`;
  const out = new Set<string>();
  const matches = combined.matchAll(/(?:words?(?:\s*\/\s*claims)?\s*to\s*avoid|avoid using|never use|banned words?)\s*[:-]\s*([^\n]+)/gi);
  for (const m of matches) {
    const line = (m[1] ?? "").trim();
    for (const part of line.split(/[,;|]/)) {
      const clean = part.replace(/^["'`]+|["'`]+$/g, "").trim();
      if (clean.length >= 3 && clean.length <= 40) out.add(clean);
    }
  }
  return Array.from(out).slice(0, 20);
}

/**
 * Deterministic email quality firewall run before saving any drafted email.
 * Enforces zero banned AI slop, zero forced opt-out footers when disabled,
 * zero user `Words to AVOID`, crisp 50-115 word range on Touch 1, and personal "I" voice.
 * Costs zero LLM calls by design.
 */
export function validateEmailQuality(input: EmailQualityInput): EmailQualityReport {
  const issues: string[] = [];
  const subj = input.subject.trim();
  const body = input.body.trim();
  const words = body.split(/\s+/).filter(Boolean).length;

  if (!subj) issues.push("Missing email subject.");

  if (input.kind === "initial") {
    if (words < 50 || words > 115) {
      issues.push(`Touch 1 length (${words} words) must be 50-115 words for crisp mobile reading.`);
    }
  } else if (words < 20 || words > 85) {
    issues.push(`Follow-up length (${words} words) should be 20-85 words.`);
  }

  if (EMPTY_GREETING_RE.test(body) || /^(?:hi|hello|hey)\s+(?:n\/?a|unknown|no contact name)\s*,/im.test(body)) {
    issues.push("Greeting is empty or addresses an unverified name (never output \"Hi ,\").");
  }

  const slopMatches = body.match(BANNED_SLOP_RE);
  if (slopMatches && slopMatches.length > 0) {
    issues.push(`Remove generic AI slop/cliché phrasing: "${Array.from(new Set(slopMatches.map((m) => m.toLowerCase()))).slice(0, 3).join('", "')}".`);
  }

  for (const bad of input.wordsToAvoid ?? []) {
    const escaped = bad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(`${subj}\n${body}`)) {
      issues.push(`Contains phrase from user's Words to AVOID: "${bad}".`);
    }
  }

  if (input.includeOptOutFooter !== true && FORCED_OPTOUT_FOOTER_RE.test(body)) {
    issues.push("Remove forced opt-out/unsubscribe footer sentence (disabled in user settings).");
  }

  const unresolved = [...findUnresolvedPlaceholders(subj), ...findUnresolvedPlaceholders(body)];
  if (unresolved.length > 0) {
    issues.push(`Remove unresolved template placeholder(s): ${unresolved.join(", ")}.`);
  }

  if (input.identity === "personal" && /\b(?:we help|we specialize|our team|our agency|we build)\b/i.test(body)) {
    issues.push('Sender identity is solo/personal: write with "I" instead of "We/Our team".');
  }

  const contactFirst = (input.leadContactName ?? "").trim().split(/\s+/)[0] ?? "";
  if (contactFirst.length >= 2 && /^[A-Za-z]+$/.test(contactFirst)) {
    const firstGreet = body.slice(0, 90).toLowerCase();
    if (!firstGreet.includes(contactFirst.toLowerCase()) && /^(?:hi|hello|hey)\s+(?:there|team)/i.test(body.trim())) {
      issues.push(`Use verified first name "${contactFirst}" in greeting instead of "Hi team/there".`);
    }
  }

  if (!body.includes("?") && !/\b(?:free look|worth|open to|make sense|send over|take a look)\b/i.test(body)) {
    issues.push("End with one clear, low-friction question.");
  }

  return {
    passed: issues.length === 0,
    wordCount: words,
    issues,
  };
}

/**
 * One draft, one deterministic gate, at most one corrective call.
 * The previous flow added a `compose_review` LLM call (plus a rewrite call) to
 * every single email, burning 3x-4x of the free quota and 20-40s per draft.
 */
async function finalizeDraft(
  draft: ComposedEmail,
  qualityInput: Omit<EmailQualityInput, "subject" | "body" | "kind">,
  kind: "initial" | "followup",
  regenerate: (issues: string[]) => Promise<ComposedEmail>,
): Promise<ComposedEmail> {
  const det = validateEmailQuality({
    ...qualityInput,
    subject: draft.subject,
    body: draft.body,
    kind,
  });

  if (det.passed) {
    return {
      ...draft,
      check: { passed: true, issues: [], kb_items_used: [], regenerated: false },
    };
  }

  const combinedIssues = Array.from(new Set(det.issues));
  try {
    const revised = await regenerate(combinedIssues);
    const secondDet = validateEmailQuality({
      ...qualityInput,
      subject: revised.subject,
      body: revised.body,
      kind,
    });
    return {
      ...revised,
      check: {
        passed: secondDet.passed,
        issues: secondDet.issues,
        kb_items_used: [],
        regenerated: true,
      },
    };
  } catch {
    return {
      ...draft,
      check: { passed: false, issues: combinedIssues, kb_items_used: [], regenerated: false },
    };
  }
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
- NEVER emit unresolved {{...}} placeholders, an empty greeting ("Hi ,"), or banned AI slop. Pass ALL 8 Module 2 Quality Gate points in this single draft.
- FIRST PASS MUST BE SEND-READY: open with the contact's real first name (or "Hi there," when unknown), lead with ONE concrete verified hook from the research JSON, say what the sender does in one plain sentence, and close with a single low-friction question. No meta commentary, no bracketed notes, no draft disclaimers.`;

const COMPOSE_FOLLOWUP_TASK = `Execute Workflow B (draft_outreach — Same-Thread Follow-Up):
- Follow Module 3's 5-Touch Execution Matrix and Follow-Up Laws strictly.
- Keep it shorter than Touch 1 (20-65 words) and stay on the same thread without copy-pasting the same pitch.
- Use Touch 2 frictionless bump, Touch 3 fresh proof/insight nudge, Touch 4 short binary check, or Touch 5 clean zero-pressure breakup as step dictates.
- Zero guilt-tripping, zero "just following up", zero unresolved {{...}} tags, zero empty greetings, and respect USER_SENDING_TIER.`;

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
  Verified forensic audit proof (PRIORITY — use these concrete measured facts for first line instead of generic guesses): ${
    research.audit_evidence?.length
      ? research.audit_evidence.map((e) => `[${e.evidence_type}] ${e.issue} (Proof: ${e.proof})`).join(" | ")
      : research.verified_site_issues?.join(" | ") || "(none)"
  }
  Findings: ${research.findings.map((f) => `[${f.severity}] ${f.area}: ${f.observation} (evidence: ${f.evidence})`).join(" | ") || "(none)"}
Missing data (DO NOT GUESS): ${(research.missing_data ?? []).join(" | ") || "(none)"}
Best opportunity: ${research.opportunities.map((o) => `${o.opportunity} (${o.service})`).join(" | ") || "(none)"}
Recommended angle: ${research.recommended_angle}
Research confidence: ${research.confidence}/100${research.insufficient_data ? " - INSUFFICIENT DATA, stay honest and ultra-brief (no invented claims)" : ""}`;
}

function sanitizeComposedDraft(
  raw: ComposedEmail,
  isColdTouch1: boolean,
  sendingTier: "free_gmail_starter" | "authenticated_custom_domain",
  greeting?: { contactName?: string | null; role?: string | null },
): ComposedEmail {
  const cleanBody = normalizeEmailGreeting(
    cleanEmailText(stripUnresolvedPlaceholders(raw.body)),
    greeting?.contactName,
    greeting?.role,
  );
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

Select the optimal Module 3 template (T1-T12) and write the Touch 1 email passing all 8 Module 2 gates with ZERO raw {{...}} tags. If no verified contact name is listed above, open with "Hi there," — never "Hi ," and never an invented first name.`;

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
  }, {
    validate: (data) => {
      if (!String(data?.body ?? "").trim() || !String(data?.subject ?? "").trim()) {
        throw new Error("Compose returned an empty subject or body.");
      }
    },
  });
  const greeting = { contactName: lead.contact_name, role: lead.role };
  const cleaned = sanitizeComposedDraft(draft, true, sendingTier, greeting);

  return finalizeDraft(
    cleaned,
    {
      leadBusiness: lead.business,
      leadContactName: lead.contact_name,
      wordsToAvoid: extractWordsToAvoid(`${knowledge}\n${orchestrated.variables.USER_EXCLUSIONS}`),
      includeOptOutFooter: settings.include_opt_out_footer === true,
      identity: campaign.identity,
    },
    "initial",
    async (issues) => {
      const { data: revised } = await LLMGateway.completeJSON<ComposedEmail>({
        ownerId,
        taskType: "fast",
        feature: "compose_initial_rewrite",
        systemPrompt: orchestrated.system,
        messages: [
          {
            role: "user",
            content: `${user}\n\nYOUR PREVIOUS DRAFT FAILED THE QUALITY GATE:\n${issues
              .map((issue) => `- ${issue}`)
              .join("\n")}\n\nRewrite the email cleanly (50-115 words, zero AI slop, ${
              settings.include_opt_out_footer === true
                ? "with brief opt-out line"
                : "zero generic opt-out/unsubscribe footers"
            }, zero {{...}} tags, and a real greeting).`,
          },
        ],
        schema: SCHEMA,
        maxTokens: 1600,
      });
      return sanitizeComposedDraft(revised, true, sendingTier, greeting);
    },
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
Extra instructions from the owner: ${campaign.extra_instructions || "(none)"}

ORIGINAL EMAIL SENT
Subject: ${original.subject}
${original.body}

This is Touch #${step} in the Module 3 Follow-Up Matrix. Write a shorter same-thread follow-up adding a fresh angle or binary check with zero guilt-tripping, zero {{...}} placeholders, and a clean greeting (never "Hi ,").`;

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
  }, {
    validate: (data) => {
      if (!String(data?.body ?? "").trim() || !String(data?.subject ?? "").trim()) {
        throw new Error("Compose returned an empty subject or body.");
      }
    },
  });
  const greeting = { contactName: lead.contact_name, role: lead.role };
  const cleaned = sanitizeComposedDraft(draft, false, sendingTier, greeting);

  return finalizeDraft(
    cleaned,
    {
      leadBusiness: lead.business,
      leadContactName: lead.contact_name,
      wordsToAvoid: extractWordsToAvoid(`${knowledge}\n${orchestrated.variables.USER_EXCLUSIONS}`),
      includeOptOutFooter: settings.include_opt_out_footer === true,
      identity: campaign.identity,
    },
    "followup",
    async (issues) => {
      const { data: revised } = await LLMGateway.completeJSON<ComposedEmail>({
        ownerId,
        taskType: "fast",
        feature: "compose_followup_rewrite",
        systemPrompt: orchestrated.system,
        messages: [
          {
            role: "user",
            content: `${user}\n\nYOUR PREVIOUS DRAFT FAILED THE QUALITY GATE:\n${issues
              .map((issue) => `- ${issue}`)
              .join("\n")}\n\nRewrite the follow-up cleanly so every point is fixed (${
              settings.include_opt_out_footer === true
                ? "include brief opt-out line"
                : "omit generic opt-out/unsubscribe footers"
            }).`,
          },
        ],
        schema: SCHEMA,
        maxTokens: 1600,
      });
      return sanitizeComposedDraft(revised, false, sendingTier, greeting);
    },
  );
}
