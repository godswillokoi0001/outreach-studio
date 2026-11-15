import { geminiJSON, type GeminiSchema } from "./gemini";
import type { CampaignConfig, Lead, Message, ResearchResult, Settings } from "./types";

export interface ComposedEmail {
  subject: string;
  body: string;
  angle: string;
  rationale: string;
  service: string;
  evidence: string[];
}

const SCHEMA: GeminiSchema = {
  type: "OBJECT",
  properties: {
    subject: { type: "STRING", description: "3-7 words, specific to this business" },
    body: { type: "STRING", description: "Plain text email body, 80-150 words, greeting and sign-off included" },
    angle: { type: "STRING", description: "The outreach angle in one short phrase" },
    rationale: { type: "STRING", description: "Why this approach was chosen, 2-3 sentences for the operator" },
    service: { type: "STRING" },
    evidence: { type: "ARRAY", items: { type: "STRING" }, description: "Research facts this email relies on" },
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

export function cleanEmailText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\*\*/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\[(your|insert|company|name)[^\]]*\]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function composeInitial(
  ownerSub: string,
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

  const result = await geminiJSON<ComposedEmail>({
    ownerSub,
    system: STRATEGIST_SYSTEM,
    user,
    schema: SCHEMA,
    temperature: 0.75,
    maxTokens: 1400,
    model,
  });
  return { ...result, body: cleanEmailText(result.body), subject: cleanEmailText(result.subject).split("\n")[0] };
}

export async function composeFollowUp(
  ownerSub: string,
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

  const result = await geminiJSON<ComposedEmail>({
    ownerSub,
    system: FOLLOWUP_SYSTEM,
    user,
    schema: SCHEMA,
    temperature: 0.7,
    maxTokens: 1200,
    model,
  });
  return { ...result, body: cleanEmailText(result.body), subject: cleanEmailText(result.subject).split("\n")[0] };
}

export function validateEmail(subject: string, body: string): string | null {
  if (!subject || subject.length < 3) return "Subject line is missing or too short.";
  if (subject.length > 120) return "Subject line is too long.";
  if (!body || body.split(/\s+/).length < 25) return "Email body is too short.";
  if (body.split(/\s+/).length > 400) return "Email body is too long for cold outreach.";
  if (/\[[^\]]{2,40}\]/.test(body)) return "Email still contains an unfilled placeholder.";
  if (/\[unsubscribe\]/i.test(body)) return "Email contains an unfilled unsubscribe placeholder.";
  return null;
}
