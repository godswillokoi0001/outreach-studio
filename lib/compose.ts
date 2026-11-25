import { Type, type Schema } from "@google/genai";
import { geminiJSON } from "./gemini";
import { cleanEmailText } from "./outreach-utils";
import type { CampaignConfig, Lead, Message, ResearchResult, Settings } from "./types";

export interface ComposedEmail {
  subject: string;
  body: string;
  angle: string;
  rationale: string;
  service: string;
  evidence: string[];
  /** Result of the knowledge-base self-check that runs before the draft is shown. */
  check?: DraftCheck;
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
      description: "The exact knowledge base items (service names, tone rules, CTA rules) this draft relies on",
    },
  },
  required: ["passed", "issues", "kb_items_used"],
};

/**
 * The checklist is built from the knowledge base and the owner's instruction so
 * a draft that invents an offer, uses the wrong tone or ignores the CTA is
 * caught before the operator ever sees it.
 */
function checklist(campaign: CampaignConfig, knowledge: string, draft: ComposedEmail): string {
  return `KNOWLEDGE BASE (source of truth)
${knowledge || "(empty)"}

OWNER INSTRUCTION FOR THIS CAMPAIGN
Objective: ${campaign.objective}
Services in focus: ${campaign.services.join(", ") || "(none specified)"}
Tone: ${campaign.tone || "(not specified)"}
Extra instructions: ${campaign.extra_instructions || "(none)"}

DRAFT UNDER REVIEW
Subject: ${draft.subject}
${draft.body}

CHECK EVERY POINT
1. Every service, offer, price, claim and proof point appears in the knowledge base. Flag anything invented.
2. The tone matches the knowledge base tone rules and the campaign tone.
3. There is exactly one clear call to action, and it matches the knowledge base CTA guidance.
4. Length is 80-150 words for a first email (45-90 for a follow-up), plain text, no markdown, no emoji.
5. Banned phrases are absent: "hope this email finds you well", "came across your website", "wanted to reach out", "just following up", "revolutionise", "cutting-edge", "synergy", "game-changing", "elevate your brand".
6. No invented facts, names, clients, awards or results; nothing presented as fact that the research did not verify.
7. The owner's extra instructions are followed exactly (format, length, structure, what to avoid).
8. No prices, budgets or timelines are mentioned unless the knowledge base states them.

Return passed=true only when all eight points hold. List every failure in issues with the exact phrase to change. In kb_items_used list the knowledge base entries the draft actually used (service names, tone rules, CTA rules); return an empty list if the draft used none.`;
}

async function reviewDraft(
  campaign: CampaignConfig,
  knowledge: string,
  draft: ComposedEmail,
  model?: string,
): Promise<{ passed: boolean; issues: string[]; kb_items_used: string[] }> {
  try {
    const result = await geminiJSON<{ passed: boolean; issues: string[]; kb_items_used: string[] }>({
      system:
        "You are a strict reviewer for cold outreach. You judge a draft only against the supplied knowledge base, the owner's instruction and the listed rules. You never rewrite the email; you only report failures.",
      user: checklist(campaign, knowledge, draft),
      schema: CHECK_SCHEMA,
      model,
    });
    return {
      passed: result.passed === true,
      issues: Array.isArray(result.issues) ? result.issues.filter((issue) => typeof issue === "string").slice(0, 8) : [],
      kb_items_used: Array.isArray(result.kb_items_used)
        ? result.kb_items_used.filter((item) => typeof item === "string").slice(0, 8)
        : [],
    };
  } catch {
    // A reviewer failure must never block sending a draft the owner can check.
    return { passed: true, issues: [], kb_items_used: [] };
  }
}

async function withKnowledgeCheck(
  draft: ComposedEmail,
  campaign: CampaignConfig,
  knowledge: string,
  regenerate: (issues: string[]) => Promise<ComposedEmail>,
  model?: string,
): Promise<ComposedEmail> {
  const first = await reviewDraft(campaign, knowledge, draft, model);
  if (first.passed) {
    return {
      ...draft,
      rationale: withKbLine(draft.rationale, first.kb_items_used),
      check: { ...first, regenerated: false },
    };
  }

  let second: ComposedEmail;
  try {
    second = await regenerate(first.issues);
  } catch {
    return {
      ...draft,
      rationale: withKbLine(draft.rationale, first.kb_items_used),
      check: { ...first, regenerated: false },
    };
  }
  const recheck = await reviewDraft(campaign, knowledge, second, model);
  return {
    ...second,
    rationale: withKbLine(second.rationale, recheck.kb_items_used.length ? recheck.kb_items_used : first.kb_items_used),
    check: { ...recheck, regenerated: true },
  };
}

function withKbLine(rationale: string, items: string[]): string {
  if (items.length === 0) return rationale;
  return `${rationale.trim()}\n\nKnowledge base used: ${items.join("; ")}`;
}

const SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    subject: { type: Type.STRING, description: "3-7 words, specific to this business" },
    body: { type: Type.STRING, description: "Plain text email body, 80-150 words, greeting and sign-off included" },
    angle: { type: Type.STRING, description: "The outreach angle in one short phrase" },
    rationale: { type: Type.STRING, description: "Why this approach was chosen, 2-3 sentences for the operator" },
    service: { type: Type.STRING },
    evidence: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Research facts this email relies on" },
  },
  required: ["subject", "body", "angle", "rationale", "service", "evidence"],
};

const STRATEGIST_SYSTEM = `You are an experienced B2B sales strategist and cold email copywriter writing on behalf of the business described in the knowledge base. You write like one business professional emailing another - specific, calm, credible, and short.

Before writing you decide: what is the one evidenced observation about this business, why it matters to their customers, which service addresses it, and what single question starts a conversation.

Non-negotiable writing rules:
- 80-150 words in the body. Plain text only: no markdown, no bold, no bullets, no emojis, no images.
- Open with the specific observation, not with an introduction of yourself and not with a compliment.
- Never use: "I hope this email finds you well", "I came across your website", "I wanted to reach out", "Just reaching out", "revolutionise", "cutting-edge", "synergy", "in today's digital landscape", "I am confident", "game-changing", "unlock potential", "elevate your brand".
- Never claim the business has no website, poor rankings or lost customers unless the research states it as verified.
- Never invent facts, metrics, awards, clients or past relationships with the prospect. Never imply an existing conversation.
- Never mention prices, budgets or timelines.
- One reference to relevant work at most, and only if the knowledge base or sources actually list work relevant to this industry. At most one link.
- Address the contact by first name if a contact name is known; otherwise use a neutral greeting ("Hello,").
- End with exactly one easy question. No calendar links, no attachments, no PS lines.
- Sign off with the sender's first name (and company only if the campaign identity is the company).
- The subject line is 3-7 words, specific to this business, no clickbait, no emojis, sentence case.
- Write in the sender's authentic voice, following the tone and writing rules in the knowledge base: practical, honest, relationship-driven. No hype.

If the research is too thin to say anything specific, still write the most honest short email you can, and note the limitation in rationale.`;

const FOLLOWUP_SYSTEM = `${STRATEGIST_SYSTEM}

This email is a follow-up. Additional rules:
- 45-90 words. Shorter than the first email.
- Reference the earlier message naturally without repeating the same pitch or the same observation.
- Add one genuinely new, useful reason to reply (a relevant angle, a concrete observation, or a relevant example of work).
- Never guilt the prospect, never say "just following up", "bumping this", or "did you get my last email".
- Keep the same sender identity and sign-off as the first email.`;

function identity(settings: Settings, campaign: CampaignConfig): string {
  const name = settings.sender_name || "the sender";
  const firstName = name.split(" ")[0];
  if (campaign.identity === "personal" || !settings.sender_company) {
    return `The sender is ${name}${settings.sender_role ? `, ${settings.sender_role}` : ""}, writing as an independent professional. Sign off as "${firstName}". Do not present them as a company.`;
  }
  return `The sender is ${name}${settings.sender_role ? `, ${settings.sender_role}` : ""} at ${settings.sender_company}. Sign off with "${firstName}" and the company name on the next line. They are writing on behalf of the company.`;
}

function researchBlock(research: ResearchResult): string {
  return `VERIFIED RESEARCH
Summary: ${research.summary}
Website status: ${research.website_status}
Verified facts: ${research.verified_facts.map((f) => f.fact).join(" | ") || "(none)"}
Website observations: ${research.website_facts.join(" | ") || "(none)"}
Findings: ${research.findings.map((f) => `[${f.severity}] ${f.area}: ${f.observation} (evidence: ${f.evidence})`).join(" | ") || "(none)"}
Inferences (do not present as fact): ${research.inferences.join(" | ") || "(none)"}
Best opportunity: ${research.opportunities.map((o) => `${o.opportunity} (${o.service})`).join(" | ") || "(none)"}
Previous recommended angle: ${research.recommended_angle}
Research confidence: ${research.confidence}/100${research.insufficient_data ? " - INSUFFICIENT DATA, stay cautious and avoid specific claims" : ""}`;
}

export async function composeInitialServer(
  lead: Lead,
  research: ResearchResult,
  campaign: CampaignConfig,
  settings: Settings,
  knowledge: string,
  model?: string,
): Promise<ComposedEmail> {
  const user = `SENDER IDENTITY
${identity(settings, campaign)}
Sender name: ${settings.sender_name}
Sender role: ${settings.sender_role}
Company: ${settings.sender_company}

BUSINESS KNOWLEDGE BASE
${knowledge}

PROSPECT
Business: ${lead.business ?? "(unknown)"}
Contact: ${lead.contact_name ?? "(unknown)"}
Role: ${lead.role ?? "(unknown)"}
Location: ${lead.location ?? "(unknown)"}
Industry: ${lead.industry ?? "(unknown)"}

${researchBlock(research)}

CAMPAIGN
Objective: ${campaign.objective}
Services in focus: ${campaign.services.join(", ")}
Tone: ${campaign.tone}
Extra instructions from the owner: ${campaign.extra_instructions || "(none)"}

Write the first cold email for this prospect. It must be built on the specific research above.`;

  const draft = await geminiJSON<ComposedEmail>({
    system: STRATEGIST_SYSTEM,
    user,
    schema: SCHEMA,
    model,
  });
  const cleaned: ComposedEmail = {
    ...draft,
    body: cleanEmailText(draft.body),
    subject: cleanEmailText(draft.subject).split("\n")[0],
  };

  // Self-check against the knowledge base before the draft is ever shown.
  return withKnowledgeCheck(
    cleaned,
    campaign,
    knowledge,
    async (issues) => {
      const revised = await geminiJSON<ComposedEmail>({
        system: STRATEGIST_SYSTEM,
        user: `${user}\n\nYOUR PREVIOUS DRAFT FAILED THE KNOWLEDGE-BASE CHECK\n${issues
          .map((issue) => `- ${issue}`)
          .join("\n")}\n\nRewrite the email so every point is fixed. Keep what was already compliant.`,
        schema: SCHEMA,
        model,
      });
      return {
        ...revised,
        body: cleanEmailText(revised.body),
        subject: cleanEmailText(revised.subject).split("\n")[0],
      };
    },
    model,
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
): Promise<ComposedEmail> {
  const user = `SENDER IDENTITY
${identity(settings, campaign)}
Sender name: ${settings.sender_name}
Sender role: ${settings.sender_role}
Company: ${settings.sender_company}

BUSINESS KNOWLEDGE BASE
${knowledge}

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

This is follow-up number ${step}. The prospect has not replied. Write a shorter follow-up that adds a new reason to respond.`;

  const draft = await geminiJSON<ComposedEmail>({
    system: FOLLOWUP_SYSTEM,
    user,
    schema: SCHEMA,
    model,
  });
  const cleaned: ComposedEmail = {
    ...draft,
    body: cleanEmailText(draft.body),
    subject: cleanEmailText(draft.subject).split("\n")[0],
  };

  return withKnowledgeCheck(
    cleaned,
    campaign,
    knowledge,
    async (issues) => {
      const revised = await geminiJSON<ComposedEmail>({
        system: FOLLOWUP_SYSTEM,
        user: `${user}\n\nYOUR PREVIOUS DRAFT FAILED THE KNOWLEDGE-BASE CHECK\n${issues
          .map((issue) => `- ${issue}`)
          .join("\n")}\n\nRewrite the follow-up so every point is fixed.`,
        schema: SCHEMA,
        model,
      });
      return {
        ...revised,
        body: cleanEmailText(revised.body),
        subject: cleanEmailText(revised.subject).split("\n")[0],
      };
    },
    model,
  );
}
