import { Type, type Schema } from "@google/genai";
import { geminiGroundedJSON, geminiJSON } from "./gemini";
import type { CampaignConfig, Lead, Settings } from "./types";

export interface ReplyAnalysis {
  classification:
    | "interested"
    | "more_info"
    | "pricing"
    | "objection"
    | "not_interested"
    | "referral"
    | "out_of_office"
    | "unsubscribe"
    | "other";
  summary: string;
  recommended_action: string;
  draft_reply: string;
  suppress: boolean;
}

const REPLY_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    classification: {
      type: Type.STRING,
      enum: [
        "interested",
        "more_info",
        "pricing",
        "objection",
        "not_interested",
        "referral",
        "out_of_office",
        "unsubscribe",
        "other",
      ],
    },
    summary: { type: Type.STRING },
    recommended_action: { type: Type.STRING },
    draft_reply: { type: Type.STRING, description: "A short suggested reply in the sender's voice, or empty string" },
    suppress: { type: Type.BOOLEAN, description: "True only for an opt-out or hostile request to stop contact" },
  },
  required: ["classification", "summary", "recommended_action", "draft_reply", "suppress"],
};

export async function analyseReplyServer(
  replyText: string,
  lead: Lead,
  settings: Settings,
  knowledge: string,
  model?: string,
): Promise<ReplyAnalysis> {
  const system = `You classify replies to B2B cold outreach for a web design and digital services business, then draft the operator's next answer.

BUSINESS KNOWLEDGE BASE
${knowledge}

Rules for the suggested reply:
- Write as ${settings.sender_name || "the sender"} in a calm, professional, relationship-first voice. 40-90 words.
- Never state or estimate prices. The knowledge base contains no confirmed pricing. If they ask about cost, explain you will scope it properly after understanding their needs, and suggest a short call.
- If they are not interested, be gracious, leave the door open, and keep it to two sentences.
- If they refer you to someone else, thank them and ask whether you may contact that person.
- If it is an out-of-office, draft_reply must be an empty string.
- Never invent facts about their business. Never promise results.`;

  const user = `PROSPECT: ${lead.business ?? "unknown business"} (contact: ${lead.contact_name ?? "unknown"}; industry: ${lead.industry ?? "unknown"})

REPLY RECEIVED
${replyText.slice(0, 6000)}`;

  return geminiJSON<ReplyAnalysis>({
    system,
    user,
    schema: REPLY_SCHEMA,
    model,
  });
}

export interface CampaignPlan {
  name: string;
  summary: string;
  config: CampaignConfig;
  sheet_url: string;
  warnings: string[];
}

const PLAN_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },
    summary: { type: Type.STRING, description: "2-4 sentences describing exactly what the system will do" },
    sheet_url: { type: Type.STRING, description: "Google Sheets URL mentioned by the operator, or empty" },
    config: {
      type: Type.OBJECT,
      properties: {
        services: { type: Type.ARRAY, items: { type: Type.STRING } },
        target_industry: { type: Type.STRING },
        objective: { type: Type.STRING },
        tone: { type: Type.STRING },
        min_score: { type: Type.INTEGER },
        lead_count: { type: Type.INTEGER },
        send_limit: { type: Type.INTEGER },
        interval_seconds: { type: Type.INTEGER },
        followup_days: { type: Type.ARRAY, items: { type: Type.INTEGER } },
        auto_approve_initial: { type: Type.BOOLEAN },
        auto_approve_followups: { type: Type.BOOLEAN },
        require_approval: { type: Type.BOOLEAN },
        identity: { type: Type.STRING, enum: ["personal", "company"] },
        extra_instructions: { type: Type.STRING },
      },
      required: [
        "services",
        "target_industry",
        "objective",
        "tone",
        "min_score",
        "lead_count",
        "send_limit",
        "interval_seconds",
        "followup_days",
        "auto_approve_initial",
        "auto_approve_followups",
        "require_approval",
        "identity",
        "extra_instructions",
      ],
    },
    warnings: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["name", "summary", "sheet_url", "config", "warnings"],
};

export async function planCampaignServer(
  instruction: string,
  context: {
    settings: Settings;
    knowledge: string;
    availableLeads: { total: number; byStatus: Record<string, number>; industries: string[] };
    recentCampaigns: { name: string; status: string }[];
  },
  model?: string,
): Promise<CampaignPlan> {
  const system = `You turn a business owner's plain-English instruction into a precise outreach campaign configuration for a web design / digital services business.

Decide sensibly, never invent requirements:
- lead_count: how many prospects to process (default 25, cap 200).
- send_limit: never above the owner's campaign limit of ${context.settings.campaign_limit} and never above the daily limit of ${context.settings.daily_limit}.
- interval_seconds: at least 30 for cold outreach; respect Gmail limits.
- min_score: 55 by default; raise it when the operator asks for the strongest opportunities, lower it to 45 when they want volume.
- services: choose from website redesign, business website development, landing page, e-commerce website, brand identity, graphic design, video editing, social media content, digital presence audit, website maintenance.
- identity: "company" when the operator speaks as the business ("we", "our team"); "personal" when they speak as an individual ("I", "my work").
- auto_approve_initial must stay false unless the operator explicitly says emails may be sent without review.
- require_approval true unless explicitly waived.
- followup_days: sensible gaps in days, e.g. [4, 9].
- extra_instructions: any specific guidance worth carrying into copywriting (industry nuance, tone, what to avoid). Never include secrets.
- warnings: mention anything ambiguous, unsupported or risky.

The summary must state the plan concretely: how many prospects, which segment, what research, what service, who signs, and that nothing sends without approval.`;

  const user = `OPERATOR INSTRUCTION
"${instruction}"

CONTEXT
Default sender: ${context.settings.sender_name} (${context.settings.sender_role}) at ${context.settings.sender_company}.
Daily sending limit: ${context.settings.daily_limit}. Campaign limit: ${context.settings.campaign_limit}.
Leads in database: ${context.availableLeads.total}
Leads by status: ${JSON.stringify(context.availableLeads.byStatus)}
Known industries in the database: ${context.availableLeads.industries.slice(0, 25).join(", ") || "(none)"}
Recent campaigns: ${context.recentCampaigns.map((c) => `${c.name} (${c.status})`).join(", ") || "(none)"}

BUSINESS KNOWLEDGE BASE
${context.knowledge}`;

  return geminiJSON<CampaignPlan>({
    system,
    user,
    schema: PLAN_SCHEMA,
    model,
  });
}

export interface PerformanceInsight {
  headline: string;
  observations: string[];
  recommendations: { title: string; detail: string; priority: "high" | "medium" | "low" }[];
  data_limits: string;
}

const INSIGHT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    headline: { type: Type.STRING },
    observations: { type: Type.ARRAY, items: { type: Type.STRING } },
    recommendations: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          detail: { type: Type.STRING },
          priority: { type: Type.STRING, enum: ["high", "medium", "low"] },
        },
        required: ["title", "detail", "priority"],
      },
    },
    data_limits: { type: Type.STRING },
  },
  required: ["headline", "observations", "recommendations", "data_limits"],
};

export async function analysePerformanceServer(metrics: unknown, model?: string): Promise<PerformanceInsight> {
  const system = `You are a sales analyst reviewing real campaign metrics for a small web design business.

Rules:
- Use only the supplied numbers. Never estimate missing values or invent benchmarks.
- If the sample is small (fewer than 20 sends), say so explicitly and keep recommendations modest.
- Comments about industries, subject lines or angles are only allowed when the data actually separates them.
- Be concrete and practical: what to change in the next campaign.`;

  return geminiJSON<PerformanceInsight>({
    system,
    user: `METRICS\n${JSON.stringify(metrics, null, 2).slice(0, 12000)}`,
    schema: INSIGHT_SCHEMA,
    model,
  });
}

export interface DiscoveryContact {
  decision_maker: string;
  role: string;
  email: string;
  phone: string;
  whatsapp: string;
  address: string;
  socials: { platform: string; url: string }[];
  sources: { field: string; url: string; confidence: "high" | "medium" | "low" }[];
}

export interface DiscoveryIssue {
  area: string;
  problem: string;
  evidence: string;
  severity: "high" | "medium" | "low";
}

export interface DiscoveryHelp {
  issue: string;
  service: string;
  angle: string;
}

export interface DiscoveryCandidate {
  business: string;
  website: string;
  location: string;
  industry: string;
  why: string;
  source_url: string;
  contact: DiscoveryContact;
  issues: DiscoveryIssue[];
  how_we_help: DiscoveryHelp[];
}

export async function discoverProspectsServer(input: {
  industry: string;
  location: string;
  count: number;
  focus: string;
  knowledge?: string;
  model?: string;
}): Promise<{ candidates: DiscoveryCandidate[]; notes: string; groundingUrls: { uri: string; title: string }[] }> {
  const system = `You find real businesses that could plausibly need web design, redesign, branding, SEO or video services, using Google Search.

Rules:
- Only list real, currently operating businesses you found in search results.
- Every candidate needs a source_url from the search results. If you cannot verify a website, leave website empty rather than guessing.
- NEVER invent an email, phone number, address, person, social profile or website problem. If a detail is not visible in the search results, return an empty string for it (or an empty array). The interface prints "Not found" for empty fields.
- Every contact detail you do return must appear in "contact.sources" with the URL it came from and a confidence level: high (the business's own site or official profile), medium (a directory or news mention), low (aggregator or unverified).
- "issues" is a concrete audit: only things you can see or strongly infer from the search results (no website, social-page-only presence, no SSL, no mobile viewport, broken/placeholder content, outdated copyright year, no booking/contact form, few or poor reviews, inactive social profiles, thin content, missing SEO basics). Every issue needs the evidence you saw.
- "how_we_help" maps each issue to one service the sender actually sells (from the knowledge base when given) with a short tailored angle. Never invent an offer or a price.
- "why" is one sentence on the plausible digital gap, phrased as something to verify.
- Return at most ${input.count} candidates, each a different business.
- Output strictly valid JSON:
{"candidates":[{"business":string,"website":string,"location":string,"industry":string,"why":string,"source_url":string,"contact":{"decision_maker":string,"role":string,"email":string,"phone":string,"whatsapp":string,"address":string,"socials":[{"platform":string,"url":string}],"sources":[{"field":string,"url":string,"confidence":"high"|"medium"|"low"}]},"issues":[{"area":string,"problem":string,"evidence":string,"severity":"high"|"medium"|"low"}],"how_we_help":[{"issue":string,"service":string,"angle":string}]}],"notes":string}`;

  const user = `Find ${input.count} realistic prospects.
Industry/segment: ${input.industry || "any business with a weak or missing website"}
Location: ${input.location || "Nigeria"}
Additional focus: ${input.focus || "(none)"}
${input.knowledge ? `\nBUSINESS KNOWLEDGE BASE (source of truth for services, offers and how we help)\n${input.knowledge.slice(0, 6000)}` : ""}

Return ONLY valid JSON with a "candidates" array and short "notes" about how reliable the results are and which fields could not be verified.`;

  const cacheKey = JSON.stringify([input.industry, input.location, input.count, input.focus]);
  const cached = discoveryCache.get(cacheKey);
  if (cached && Date.now() - cached.at < DISCOVERY_CACHE_MS) {
    return cached.value;
  }

  const { data, groundingUrls } = await geminiGroundedJSON<{
    candidates: unknown[];
    notes: string;
  }>({
    system,
    user,
    model: input.model,
  });

  const seen = new Set<string>();
  const candidates = (Array.isArray(data.candidates) ? data.candidates : [])
    .map((raw) => normalizeCandidate(raw))
    .filter((candidate) => {
      const key = (candidate.website || candidate.business).toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return Boolean(candidate.business);
    })
    .slice(0, input.count);

  const value = {
    candidates,
    notes: typeof data.notes === "string" ? data.notes : "",
    groundingUrls,
  };
  discoveryCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

/** Cached for a few minutes so re-running the same search costs nothing. */
const discoveryCache = new Map<string, {
  at: number;
  value: { candidates: DiscoveryCandidate[]; notes: string; groundingUrls: { uri: string; title: string }[] };
}>();
const DISCOVERY_CACHE_MS = 10 * 60 * 1000;

function text(value: unknown, max = 400): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function confidence(value: unknown): "high" | "medium" | "low" {
  return value === "high" || value === "medium" || value === "low" ? value : "low";
}

/** Shapes whatever the model returned into the interface's contract. */
function normalizeCandidate(raw: unknown): DiscoveryCandidate {
  const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const contact = (item.contact && typeof item.contact === "object" ? item.contact : {}) as Record<string, unknown>;

  const socials = Array.isArray(contact.socials)
    ? contact.socials
        .map((social) => {
          const entry = (social && typeof social === "object" ? social : {}) as Record<string, unknown>;
          return { platform: text(entry.platform, 40), url: text(entry.url, 300) };
        })
        .filter((social) => social.url)
        .slice(0, 8)
    : [];

  const sources = Array.isArray(contact.sources)
    ? contact.sources
        .map((source) => {
          const entry = (source && typeof source === "object" ? source : {}) as Record<string, unknown>;
          return { field: text(entry.field, 40), url: text(entry.url, 300), confidence: confidence(entry.confidence) };
        })
        .filter((source) => source.url)
        .slice(0, 12)
    : [];

  const issues = Array.isArray(item.issues)
    ? item.issues
        .map((issue) => {
          const entry = (issue && typeof issue === "object" ? issue : {}) as Record<string, unknown>;
          return {
            area: text(entry.area, 60),
            problem: text(entry.problem, 300),
            evidence: text(entry.evidence, 300),
            severity: confidence(entry.severity),
          };
        })
        .filter((issue) => issue.problem)
        .slice(0, 8)
    : [];

  const howWeHelp = Array.isArray(item.how_we_help)
    ? item.how_we_help
        .map((help) => {
          const entry = (help && typeof help === "object" ? help : {}) as Record<string, unknown>;
          return { issue: text(entry.issue, 200), service: text(entry.service, 120), angle: text(entry.angle, 300) };
        })
        .filter((help) => help.service)
        .slice(0, 8)
    : [];

  return {
    business: text(item.business, 200),
    website: text(item.website, 300),
    location: text(item.location, 200),
    industry: text(item.industry, 120),
    why: text(item.why, 400),
    source_url: text(item.source_url, 400),
    contact: {
      decision_maker: text(contact.decision_maker, 120),
      role: text(contact.role, 120),
      email: text(contact.email, 200),
      phone: text(contact.phone, 60),
      whatsapp: text(contact.whatsapp, 60),
      address: text(contact.address, 300),
      socials,
      sources,
    },
    issues,
    how_we_help: howWeHelp,
  };
}
