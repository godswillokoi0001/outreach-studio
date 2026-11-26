import { Type, type Schema } from "@google/genai";
import { buildOrchestratedSystemPrompt, stripUnresolvedPlaceholders } from "./ai/orchestrator";
import { addBusinessDaysIso, mapReplyClassMeta, type ReplyClassCode, type ReplySequenceAction } from "./guardrails";
import { geminiGroundedJSON, geminiJSON } from "./gemini";
import { cleanEmailText } from "./outreach-utils";
import type { CampaignConfig, Lead, Message, Settings } from "./types";

export interface ReplyAnalysis {
  reply_class: ReplyClassCode;
  sequence_action: ReplySequenceAction;
  snooze_until: string | null;
  suggested_reply: string;
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
    reply_class: {
      type: Type.STRING,
      enum: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"],
      description: "Module 4 8-Class Reply Routing Matrix category",
    },
    sequence_action: {
      type: Type.STRING,
      enum: ["PAUSE", "SNOOZE", "STOP", "GLOBAL_SUPPRESS"],
    },
    snooze_until: {
      type: Type.STRING,
      description: "ISO date YYYY-MM-DD (Return Date + 2 business days) for R5 OOO, or empty string",
    },
    suggested_reply: {
      type: Type.STRING,
      description: "Short same-thread response following Module 4 (A-C-A or Voss empathy) & Module 2 plain-English rules, or empty string for R5 OOO",
    },
    summary: { type: Type.STRING },
    recommended_action: { type: Type.STRING },
  },
  required: [
    "reply_class",
    "sequence_action",
    "snooze_until",
    "suggested_reply",
    "summary",
    "recommended_action",
  ],
};

const REPLY_TASK = `Execute Workflow C (handle_reply) using Module 4 (8-Class Reply Triage, A-C-A Conversion, Voss Tactical Empathy, Objection Playbooks, Quoting Ethics, and Platform Governance) and Module 2 (Voice, Plain English, Zero AI-Slop, Zero Fabrication).

Strict Output Rules:
1. Classify into ONE strict Module 4 class: R1 (Hot/Positive), R2 (Curiosity/Question), R3 (Soft Objection/Stall), R4 (Referral/Redirect), R5 (Out-of-Office auto-responder), R6 (Peer/Non-buyer/Reverse pitch), R7 (Polite Decline "No"), R8 (Hard Opt-Out/Hostile).
2. Enforce sequence_action: R1-R4 & R6 -> PAUSE; R5 -> SNOOZE; R7 -> STOP; R8 -> GLOBAL_SUPPRESS.
3. For R5 (OOO): set snooze_until to Return Date + 2 business days (YYYY-MM-DD) and set suggested_reply = "" (empty string).
4. For R1: use Hormozi's A-C-A framework (Acknowledge, Compliment, Ask 2-3 micro-questions max) on the same thread.
5. For R3: use Chris Voss Tactical Empathy (Label calmly + calibrated What/How question or Phase-1 scope adjustment; never slash price arbitrarily or argue).
6. Never fabricate pricing or deliverables not in USER_OFFER / Knowledge Base. Strip/omit any {{...}} placeholders — ZERO raw tags allowed.`;

export async function analyseReplyServer(
  replyText: string,
  lead: Lead,
  settings: Settings,
  knowledge: string,
  model?: string,
  options?: { ownerId?: string; threadMessages?: Message[] },
): Promise<ReplyAnalysis> {
  const orchestrated = await buildOrchestratedSystemPrompt({
    workflow: "handle_reply",
    ownerId: options?.ownerId ?? lead.ownerId ?? null,
    settings,
    knowledgeDigest: knowledge,
    taskInstructions: REPLY_TASK,
  });

  const threadHistory = (options?.threadMessages ?? [])
    .filter((m) => m.status === "sent" || m.kind === "reply")
    .sort((a, b) => (a.sent_at ?? a.created_at).localeCompare(b.sent_at ?? b.created_at))
    .slice(-10)
    .map(
      (m) =>
        `[${m.sent_at?.slice(0, 10) || m.created_at.slice(0, 10)} | ${m.kind.toUpperCase()}]\nSubject: ${m.subject ?? "(no subject)"}\n${m.body ?? ""}`,
    )
    .join("\n\n---\n\n");

  const user = `PROSPECT: ${lead.business ?? "unknown business"} (contact: ${lead.contact_name ?? "unknown"}; role: ${lead.role ?? "unknown"}; industry: ${lead.industry ?? "unknown"}; email: ${lead.email ?? "unknown"})
SENDER IDENTITY: ${settings.sender_name || "the sender"}${settings.sender_role ? `, ${settings.sender_role}` : ""}${settings.sender_company ? ` at ${settings.sender_company}` : ""}

${threadHistory ? `PRIOR CONVERSATION THREAD\n${threadHistory}\n\n` : ""}LATEST INCOMING REPLY RECEIVED
${replyText.slice(0, 6000)}

Run Workflow C (handle_reply) and return JSON with reply_class, sequence_action, snooze_until, suggested_reply, summary, and recommended_action.`;

  const raw = await geminiJSON<{
    reply_class?: ReplyClassCode;
    sequence_action?: ReplySequenceAction;
    snooze_until?: string | null;
    suggested_reply?: string;
    summary?: string;
    recommended_action?: string;
  }>({
    system: orchestrated.system,
    user,
    schema: REPLY_SCHEMA,
    model,
  });

  const validClass: ReplyClassCode =
    raw.reply_class && /^R[1-8]$/.test(raw.reply_class) ? raw.reply_class : "R2";
  const mapped = mapReplyClassMeta(validClass);
  const rawSnooze = typeof raw.snooze_until === "string" ? raw.snooze_until.trim() : "";
  const snoozeUntil =
    validClass === "R5"
      ? /^\d{4}-\d{2}-\d{2}/.test(rawSnooze)
        ? rawSnooze.slice(0, 10)
        : addBusinessDaysIso(new Date().toISOString().slice(0, 10), 4)
      : null;

  const cleanedReply =
    validClass === "R5"
      ? ""
      : cleanEmailText(stripUnresolvedPlaceholders(String(raw.suggested_reply ?? "")));

  return {
    reply_class: validClass,
    sequence_action: mapped.sequence_action,
    snooze_until: snoozeUntil,
    suggested_reply: cleanedReply,
    classification: mapped.legacy_classification,
    summary: String(raw.summary ?? "").trim() || `Classified as ${validClass}`,
    recommended_action: String(raw.recommended_action ?? "").trim() || mapped.sequence_action,
    draft_reply: cleanedReply,
    suppress: mapped.suppress,
  };
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
    ownerId?: string;
    settings: Settings;
    knowledge: string;
    availableLeads: { total: number; byStatus: Record<string, number>; industries: string[] };
    recentCampaigns: { name: string; status: string }[];
  },
  model?: string,
): Promise<CampaignPlan> {
  const taskInstructions = `Turn the operator's plain-English instruction into a structured outreach campaign configuration grounded in the Global Brain and Active User Business Profile.

Decide sensibly, never invent requirements:
- lead_count: how many prospects to process (default 25, cap 200).
- send_limit: never above the owner's campaign limit of ${context.settings.campaign_limit} and never above the daily limit of ${context.settings.daily_limit}.
- interval_seconds: at least 30 for cold outreach; respect Gmail limits and USER_SENDING_TIER.
- min_score: 65 by default (Module 1 Tier B+ threshold); raise to 75-80 when asking for top targets, lower only if explicitly requested.
- services: align strictly with USER_OFFER and USER_EXCLUSIONS (never recommend excluded work).
- identity: "company" when speaking as the business ("we", "our team"); "personal" when speaking as an individual ("I", "my work").
- auto_approve_initial must stay false unless explicitly waived.
- require_approval true unless explicitly waived.
- followup_days: sensible gaps in days matching Module 3 cadence, e.g. [4, 9].
- extra_instructions: concrete copy/targeting nuance without secrets.
- warnings: flag anything ambiguous, excluded, or risky.

The summary must state the plan concretely: how many prospects, which segment, what research, what service, who signs, and that nothing sends without approval.`;

  const orchestrated = await buildOrchestratedSystemPrompt({
    workflow: "plan_campaign",
    ownerId: context.ownerId ?? null,
    settings: context.settings,
    knowledgeDigest: context.knowledge,
    taskInstructions,
  });

  const user = `OPERATOR INSTRUCTION
"${instruction}"

CONTEXT
Default sender: ${context.settings.sender_name} (${context.settings.sender_role}) at ${context.settings.sender_company}.
Daily sending limit: ${context.settings.daily_limit}. Campaign limit: ${context.settings.campaign_limit}.
Leads in database: ${context.availableLeads.total}
Leads by status: ${JSON.stringify(context.availableLeads.byStatus)}
Known industries in the database: ${context.availableLeads.industries.slice(0, 25).join(", ") || "(none)"}
Recent campaigns: ${context.recentCampaigns.map((c) => `${c.name} (${c.status})`).join(", ") || "(none)"}`;

  return geminiJSON<CampaignPlan>({
    system: orchestrated.system,
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

export type VerificationStatus = "Verified" | "Unverified" | "Not found";

export interface CriterionReview {
  name: string;
  status: "met" | "not_met" | "unknown";
  evidence: string;
}

export interface QualificationReview {
  verdict: "qualified" | "not_qualified" | "uncertain";
  criteria: CriterionReview[];
  weaknesses_and_risks: string[];
  missing_information: string[];
}

export interface DiscoveryContact {
  decision_maker: string;
  role: string;
  email: string;
  phone: string;
  whatsapp: string;
  address: string;
  email_status?: VerificationStatus;
  phone_status?: VerificationStatus;
  socials: { platform: string; url: string; verification_status?: VerificationStatus }[];
  sources: {
    field: string;
    url: string;
    confidence: "high" | "medium" | "low";
    verification_status?: VerificationStatus;
    date_found?: string;
  }[];
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
  research_notes?: string;
  contact: DiscoveryContact;
  issues: DiscoveryIssue[];
  how_we_help: DiscoveryHelp[];
  qualification_review?: QualificationReview;
}

export async function discoverProspectsServer(input: {
  ownerId?: string;
  industry: string;
  location: string;
  count: number;
  focus: string;
  knowledge?: string;
  model?: string;
}): Promise<{ candidates: DiscoveryCandidate[]; notes: string; groundingUrls: { uri: string; title: string }[] }> {
  const today = new Date().toISOString().slice(0, 10);
  const taskInstructions = `Find real businesses matching USER_OFFER, USER_ICP, and USER_EXCLUSIONS using Google Search grounding and Module 1 (Signal-Based Prospecting, Research Waterfall & Anti-Hallucination Firewall).

STRICT RESEARCH & QUALIFICATION RULES:
1. THOROUGH RESEARCH:
   - Search for the company's official website and verified social media handles (LinkedIn, Instagram, X/Twitter, Facebook, TikTok, YouTube, and niche-specific profiles).
   - Search for the names and job titles of real decision-makers (Owner, Founder, CEO, Managing Director, Head of Marketing, etc.) per Module 1 Decision-Maker Protocol.
   - Search for verifiable business email addresses (prefer direct individual email over role inbox), phone numbers, and location.
   - For every contact detail, record exact source URL and date found (${today}).

2. TRUTHFUL, EVIDENCE-BASED DISCOVERY:
   - NEVER invent, guess, pad, or hallucinate any data (no fake emails, phone numbers, handles, or claims).
   - If a detail cannot be verified in search results, leave it empty. The interface displays "Not found".
   - Assign verification_status: "Verified" (confirmed on official website or primary profile), "Unverified" (secondary directory), or "Not found".
   - Every issue listed in "issues" must be concrete and directly visible from search evidence.

3. STRICT QUALIFICATION & KILL-SWITCH REVIEW:
   - Evaluate against Module 1 pillars: Offer Fit & Scope Safety (respect USER_EXCLUSIONS), Willingness/Ability to Pay (WTP proof), Trigger Timing, Decision-Maker Access, and Activity.
   - Each prospect must include qualification_review:
     - verdict: "qualified" (Tier A/B >=65 with zero kill-switches), "not_qualified" (failed criteria, low WTP, or competitor/exclusion), or "uncertain" (Tier C borderline / needs review).
     - criteria: array of { name: string, status: "met" | "not_met" | "unknown", evidence: string }.
     - weaknesses_and_risks: list of weaknesses, red flags, or risks stated candidly.
     - missing_information: list of unverified details or missing data.
   - Do NOT lower standards to reach the requested count.

Output strictly valid JSON:
{"candidates":[{"business":string,"website":string,"location":string,"industry":string,"why":string,"source_url":string,"research_notes":string,"contact":{"decision_maker":string,"role":string,"email":string,"phone":string,"whatsapp":string,"address":string,"socials":[{"platform":string,"url":string,"verification_status":"Verified"|"Unverified"|"Not found"}],"sources":[{"field":string,"url":string,"confidence":"high"|"medium"|"low","verification_status":"Verified"|"Unverified"|"Not found","date_found":string}]},"issues":[{"area":string,"problem":string,"evidence":string,"severity":"high"|"medium"|"low"}],"how_we_help":[{"issue":string,"service":string,"angle":string}],"qualification_review":{"verdict":"qualified"|"not_qualified"|"uncertain","criteria":[{"name":string,"status":"met"|"not_met"|"unknown","evidence":string}],"weaknesses_and_risks":[string],"missing_information":[string]}}],"notes":string}`;

  const orchestrated = await buildOrchestratedSystemPrompt({
    workflow: "research_and_qualify",
    ownerId: input.ownerId ?? null,
    knowledgeDigest: input.knowledge,
    taskInstructions,
  });

  const user = `Find ${input.count} realistic prospects.
Industry/segment: ${input.industry || "matching the active user's ICP and offer"}
Location: ${input.location || "target market"}
Additional focus: ${input.focus || "(none)"}

Return ONLY valid JSON with a "candidates" array and short "notes" about verification and gaps.`;

  const cacheKey = JSON.stringify([input.ownerId ?? "anon", input.industry, input.location, input.count, input.focus]);
  const cached = discoveryCache.get(cacheKey);
  if (cached && Date.now() - cached.at < DISCOVERY_CACHE_MS) {
    return cached.value;
  }

  const { data, groundingUrls } = await geminiGroundedJSON<{
    candidates: unknown[];
    notes: string;
  }>({
    system: orchestrated.system,
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
export function normalizeCandidate(raw: unknown): DiscoveryCandidate {
  const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const contact = (item.contact && typeof item.contact === "object" ? item.contact : {}) as Record<string, unknown>;

  const socials = Array.isArray(contact.socials)
    ? contact.socials
        .map((social) => {
          const entry = (social && typeof social === "object" ? social : {}) as Record<string, unknown>;
          const rawStatus = text(entry.verification_status, 30);
          const verification_status: VerificationStatus =
            rawStatus === "Verified" || rawStatus === "Unverified" || rawStatus === "Not found"
              ? rawStatus
              : "Verified";
          return {
            platform: text(entry.platform, 40),
            url: text(entry.url, 300),
            verification_status,
          };
        })
        .filter((social) => social.url)
        .slice(0, 8)
    : [];

  const sources = Array.isArray(contact.sources)
    ? contact.sources
        .map((source) => {
          const entry = (source && typeof source === "object" ? source : {}) as Record<string, unknown>;
          const rawStatus = text(entry.verification_status, 30);
          const verification_status: VerificationStatus =
            rawStatus === "Verified" || rawStatus === "Unverified" || rawStatus === "Not found"
              ? rawStatus
              : confidence(entry.confidence) === "high"
                ? "Verified"
                : "Unverified";
          return {
            field: text(entry.field, 40),
            url: text(entry.url, 300),
            confidence: confidence(entry.confidence),
            verification_status,
            date_found: text(entry.date_found, 40) || new Date().toISOString().slice(0, 10),
          };
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

  const rawReview = (item.qualification_review && typeof item.qualification_review === "object" ? item.qualification_review : null) as Record<string, unknown> | null;
  const rawVerdict = text(rawReview?.verdict, 30);
  const verdict: "qualified" | "not_qualified" | "uncertain" =
    rawVerdict === "qualified" || rawVerdict === "not_qualified" || rawVerdict === "uncertain"
      ? rawVerdict
      : "uncertain";

  const criteria: CriterionReview[] = Array.isArray(rawReview?.criteria)
    ? (rawReview!.criteria as unknown[]).map((c) => {
        const entry = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
        const rawStatus = text(entry.status, 20);
        const status = rawStatus === "met" || rawStatus === "not_met" || rawStatus === "unknown" ? rawStatus : "unknown";
        return {
          name: text(entry.name, 120),
          status,
          evidence: text(entry.evidence, 300),
        };
      })
    : [];

  const weaknesses = Array.isArray(rawReview?.weaknesses_and_risks)
    ? (rawReview!.weaknesses_and_risks as unknown[]).map((w) => text(w, 300)).filter(Boolean)
    : [];

  const missing = Array.isArray(rawReview?.missing_information)
    ? (rawReview!.missing_information as unknown[]).map((m) => text(m, 300)).filter(Boolean)
    : [];

  const qualification_review: QualificationReview = {
    verdict,
    criteria,
    weaknesses_and_risks: weaknesses,
    missing_information: missing,
  };

  return {
    business: text(item.business, 200),
    website: text(item.website, 300),
    location: text(item.location, 200),
    industry: text(item.industry, 120),
    why: text(item.why, 400),
    source_url: text(item.source_url, 400),
    research_notes: text(item.research_notes, 600),
    contact: {
      decision_maker: text(contact.decision_maker || contact.decision_maker_name, 120),
      role: text(contact.role || contact.role_name || contact.decision_maker_role, 120),
      email: text(contact.email, 200),
      phone: text(contact.phone, 60),
      whatsapp: text(contact.whatsapp, 60),
      address: text(contact.address, 300),
      email_status: (() => {
        const rawStatus = text(contact.email_status, 30);
        return rawStatus === "Verified" || rawStatus === "Unverified" || rawStatus === "Not found"
          ? rawStatus
          : contact.email
            ? "Verified"
            : "Not found";
      })(),
      phone_status: (() => {
        const rawStatus = text(contact.phone_status, 30);
        return rawStatus === "Verified" || rawStatus === "Unverified" || rawStatus === "Not found"
          ? rawStatus
          : contact.phone
            ? "Verified"
            : "Not found";
      })(),
      socials,
      sources,
    },
    issues,
    how_we_help: howWeHelp,
    qualification_review,
  };
}
