import { geminiJSON, geminiLooseJSON, type GeminiSchema } from "./gemini";
import type { CampaignConfig, Lead, Settings } from "./types";

// ---------------------------------------------------------------------------
// Reply classification
// ---------------------------------------------------------------------------

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

const REPLY_SCHEMA: GeminiSchema = {
  type: "OBJECT",
  properties: {
    classification: {
      type: "STRING",
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
    summary: { type: "STRING" },
    recommended_action: { type: "STRING" },
    draft_reply: { type: "STRING", description: "A short suggested reply in the sender's voice, or empty string" },
    suppress: { type: "BOOLEAN", description: "True only for an opt-out or hostile request to stop contact" },
  },
  required: ["classification", "summary", "recommended_action", "draft_reply", "suppress"],
};

export async function analyseReply(
  ownerSub: string,
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
- Write as ${settings.sender_name} in a calm, professional, relationship-first voice. 40-90 words.
- Never state or estimate prices. The knowledge base contains no confirmed pricing. If they ask about cost, explain you will scope it properly after understanding their needs, and suggest a short call.
- If they are not interested, be gracious, leave the door open, and keep it to two sentences.
- If they refer you to someone else, thank them and ask whether you may contact that person.
- If it is an out-of-office, draft_reply must be an empty string.
- Never invent facts about their business. Never promise results.`;

  const user = `PROSPECT: ${lead.business ?? "unknown business"} (contact: ${lead.contact_name ?? "unknown"}; industry: ${lead.industry ?? "unknown"})

REPLY RECEIVED
${replyText.slice(0, 6000)}`;

  return geminiJSON<ReplyAnalysis>({
    ownerSub,
    system,
    user,
    schema: REPLY_SCHEMA,
    temperature: 0.4,
    maxTokens: 1200,
    model,
  });
}

// ---------------------------------------------------------------------------
// Natural language campaign planning
// ---------------------------------------------------------------------------

export interface CampaignPlan {
  name: string;
  summary: string;
  config: CampaignConfig;
  sheet_url: string;
  warnings: string[];
}

const PLAN_SCHEMA: GeminiSchema = {
  type: "OBJECT",
  properties: {
    name: { type: "STRING" },
    summary: { type: "STRING", description: "2-4 sentences describing exactly what the system will do" },
    sheet_url: { type: "STRING", description: "Google Sheets URL mentioned by the operator, or empty" },
    config: {
      type: "OBJECT",
      properties: {
        services: { type: "ARRAY", items: { type: "STRING" } },
        target_industry: { type: "STRING" },
        objective: { type: "STRING" },
        tone: { type: "STRING" },
        min_score: { type: "INTEGER" },
        lead_count: { type: "INTEGER" },
        send_limit: { type: "INTEGER" },
        interval_seconds: { type: "INTEGER" },
        followup_days: { type: "ARRAY", items: { type: "INTEGER" } },
        auto_approve_initial: { type: "BOOLEAN" },
        auto_approve_followups: { type: "BOOLEAN" },
        require_approval: { type: "BOOLEAN" },
        identity: { type: "STRING", enum: ["personal", "company"] },
        extra_instructions: { type: "STRING" },
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
    warnings: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["name", "summary", "sheet_url", "config", "warnings"],
};

export async function planCampaign(
  ownerSub: string,
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
    ownerSub,
    system,
    user,
    schema: PLAN_SCHEMA,
    temperature: 0.3,
    maxTokens: 1600,
    model,
  });
}

// ---------------------------------------------------------------------------
// Campaign performance analysis
// ---------------------------------------------------------------------------

export interface PerformanceInsight {
  headline: string;
  observations: string[];
  recommendations: { title: string; detail: string; priority: "high" | "medium" | "low" }[];
  data_limits: string;
}

const INSIGHT_SCHEMA: GeminiSchema = {
  type: "OBJECT",
  properties: {
    headline: { type: "STRING" },
    observations: { type: "ARRAY", items: { type: "STRING" } },
    recommendations: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" },
          detail: { type: "STRING" },
          priority: { type: "STRING", enum: ["high", "medium", "low"] },
        },
        required: ["title", "detail", "priority"],
      },
    },
    data_limits: { type: "STRING" },
  },
  required: ["headline", "observations", "recommendations", "data_limits"],
};

export async function analysePerformance(ownerSub: string, metrics: unknown, model?: string): Promise<PerformanceInsight> {
  const system = `You are a sales analyst reviewing real campaign metrics for a small web design business.

Rules:
- Use only the supplied numbers. Never estimate missing values or invent benchmarks.
- If the sample is small (fewer than 20 sends), say so explicitly and keep recommendations modest.
- Comments about industries, subject lines or angles are only allowed when the data actually separates them.
- Be concrete and practical: what to change in the next campaign.`;
  return geminiJSON<PerformanceInsight>({
    ownerSub,
    system,
    user: `METRICS\n${JSON.stringify(metrics, null, 2).slice(0, 12000)}`,
    schema: INSIGHT_SCHEMA,
    temperature: 0.4,
    maxTokens: 1600,
    model,
  });
}

// ---------------------------------------------------------------------------
// Prospect discovery with Google Search grounding
// ---------------------------------------------------------------------------

export interface DiscoveryCandidate {
  business: string;
  website: string;
  location: string;
  industry: string;
  why: string;
  source_url: string;
}

const DISCOVERY_SCHEMA: GeminiSchema = {
  type: "OBJECT",
  properties: {
    candidates: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          business: { type: "STRING" },
          website: { type: "STRING" },
          location: { type: "STRING" },
          industry: { type: "STRING" },
          why: { type: "STRING" },
          source_url: { type: "STRING" },
        },
        required: ["business", "website", "location", "industry", "why", "source_url"],
      },
    },
    notes: { type: "STRING" },
  },
  required: ["candidates", "notes"],
};

export async function discoverProspects(ownerSub: string, input: {
  industry: string;
  location: string;
  count: number;
  focus: string;
  model?: string;
}): Promise<{ candidates: DiscoveryCandidate[]; notes: string }> {
  const system = `You find real businesses that could plausibly need web design, redesign, branding or video services, using Google Search.

Rules:
- Only list real, currently operating businesses you found in search results.
- Every candidate needs a source_url from the search results. If you cannot verify a website, leave website empty rather than guessing.
- Do not invent contact emails, revenue, staff counts or website problems.
- "why" is one sentence on the plausible digital gap, phrased as something to verify.
- Return at most ${input.count} candidates.`;
  const user = `Find ${input.count} realistic prospects.
Industry/segment: ${input.industry || "any business with a weak or missing website"}
Location: ${input.location || "Nigeria"}
Additional focus: ${input.focus || "(none)"}

Return JSON with a "candidates" array and short "notes" about how reliable the results are.`;

  return geminiLooseJSON<{ candidates: DiscoveryCandidate[]; notes: string }>({
    ownerSub,
    system,
    user,
    schema: DISCOVERY_SCHEMA,
    search: true,
    temperature: 0.3,
    maxTokens: 2400,
    model: input.model,
  });
}
