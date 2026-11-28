import { createHmac, timingSafeEqual } from "node:crypto";
import { Type, type Schema } from "@google/genai";
import { buildOrchestratedSystemPrompt, stripUnresolvedPlaceholders } from "./ai/orchestrator";
import { normalizeEmailGreeting } from "./outreach-utils";
import {
  advanceBackgroundJobStep,
  completeBackgroundJob,
  createOrReuseBackgroundJob,
  failBackgroundJob,
  failStalledBackgroundJob,
  getBackgroundJobForOwner,
  getLatestBackgroundJobForOwner,
  JOB_HEARTBEAT_MS,
  touchBackgroundJob,
  type BackgroundJobRecord,
  type BackgroundJobStep,
} from "./background-jobs";
import { getRegionalComplianceGuidance } from "./compliance/regionalRules";
import {
  filterReviewableMessageIds,
  runDeterministicRewriteAudit,
  type CrossLeadPatternInsight,
  type CrossLeadPatternSummary,
  type EmailRewriteItem,
  type EmailRewriteWorkspaceState,
  type KnowledgeGapItem,
  type KnowledgeSectionStatus,
  type LeadRewriteAnalysis,
  type RewritePreflightSummary,
  type RewriteScope,
  type RewriteVersionEntry,
} from "./email-rewrite";
import { loadUserContextServer, type LoadedUserContext } from "./global-knowledge/user-context";
import { LLMGateway, LLMGatewayError } from "./llm/gateway";
import { ensureLeadMicroResearch } from "./micro-research";
import type { OnboardingState, StructuredKnowledgeBase } from "./onboarding";
import { supabaseServer } from "./supabase-server";
import type { Campaign, EmailOpen, Lead, Message, Reply, Settings } from "./types";

/**
 * One draft plus at most one corrective pass. Every attempt is a single fast
 * LLM call now that quality checks are deterministic.
 */
const MAX_SELF_CHECK_ATTEMPTS = 2;
export const REWRITE_JOB_STALL_MS = 90_000;

export interface RewriteOwnerSnapshot {
  messages: Message[];
  leads: Lead[];
  campaigns: Campaign[];
  replies: Reply[];
  opens: EmailOpen[];
  userContext: LoadedUserContext;
  onboarding: OnboardingState | null;
  structuredKb: StructuredKnowledgeBase | null;
  settings: Settings;
}

export interface EmailRewriteStoreAdapter {
  loadOwnerSnapshot: (ownerId: string) => Promise<RewriteOwnerSnapshot>;
  loadWorkspace: (ownerId: string) => Promise<EmailRewriteWorkspaceState | null>;
  saveWorkspace: (ownerId: string, state: EmailRewriteWorkspaceState) => Promise<void>;
  updateMessageFields: (
    ownerId: string,
    messageId: string,
    patch: { subject: string; body: string; angle?: string | null; rationale?: string | null },
  ) => Promise<void>;
}

let testStoreOverride: EmailRewriteStoreAdapter | null = null;
const memoryWorkspaceMirror = new Map<string, EmailRewriteWorkspaceState>();

export function __configureEmailRewriteStoreForTests(adapter: EmailRewriteStoreAdapter | null): void {
  testStoreOverride = adapter;
  memoryWorkspaceMirror.clear();
}

function defaultEmptyWorkspace(ownerId: string): EmailRewriteWorkspaceState {
  return {
    ownerId,
    activeJobId: null,
    lastScope: "all",
    pausedForQuota: false,
    pausedMessage: null,
    kbSectionsUsed: [],
    kbGaps: [],
    crossLeadSummary: null,
    itemsByMessageId: {},
    updatedAt: new Date().toISOString(),
  };
}

function mapSqlMessage(row: Record<string, unknown>): Message {
  return {
    id: String(row.id ?? ""),
    ownerId: String(row.owner_id ?? ""),
    lead_id: String(row.lead_id ?? ""),
    campaign_id: row.campaign_id ? String(row.campaign_id) : null,
    step: Number(row.step ?? 1),
    kind: (row.kind as Message["kind"]) ?? "initial",
    subject: row.subject ? String(row.subject) : null,
    body: row.body ? String(row.body) : null,
    angle: row.angle ? String(row.angle) : null,
    rationale: row.rationale ? String(row.rationale) : null,
    service: row.service ? String(row.service) : null,
    status: (row.status as Message["status"]) ?? "draft",
    gmail_id: row.gmail_id ? String(row.gmail_id) : null,
    thread_id: row.thread_id ? String(row.thread_id) : null,
    rfc_message_id: row.rfc_message_id ? String(row.rfc_message_id) : null,
    sent_at: row.sent_at ? String(row.sent_at) : null,
    error: row.error ? String(row.error) : null,
    approved_at: row.approved_at ? String(row.approved_at) : null,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

function mapSqlLead(row: Record<string, unknown>): Lead {
  return {
    id: String(row.id ?? ""),
    ownerId: String(row.owner_id ?? ""),
    campaign_id: row.campaign_id ? String(row.campaign_id) : null,
    business: row.business ? String(row.business) : null,
    contact_name: row.contact_name ? String(row.contact_name) : null,
    role: row.role ? String(row.role) : null,
    email: row.email ? String(row.email) : null,
    email_norm: row.email_norm ? String(row.email_norm) : null,
    website: row.website ? String(row.website) : null,
    phone: row.phone ? String(row.phone) : null,
    location: row.location ? String(row.location) : null,
    industry: row.industry ? String(row.industry) : null,
    notes: row.notes ? String(row.notes) : null,
    extra: row.extra ? String(row.extra) : null,
    source: row.source ? String(row.source) : null,
    source_ref: row.source_ref ? String(row.source_ref) : null,
    sheet_row: typeof row.sheet_row === "number" ? row.sheet_row : null,
    status: (row.status as Lead["status"]) ?? "new",
    score: typeof row.score === "number" ? row.score : null,
    priority: (row.priority as Lead["priority"]) ?? null,
    score_reason: (row.score_reason as Lead["score_reason"]) ?? null,
    research: (row.research as Lead["research"]) ?? null,
    research_at: row.research_at ? String(row.research_at) : null,
    research_ok: Boolean(row.research_ok),
    manual_research: row.manual_research ? String(row.manual_research) : null,
    last_contacted_at: row.last_contacted_at ? String(row.last_contacted_at) : null,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

async function loadOwnerSnapshotFromSupabase(ownerId: string): Promise<RewriteOwnerSnapshot> {
  if (!supabaseServer) {
    throw new Error("Supabase server client is not configured.");
  }

  const [msgRes, leadRes, campRes, repRes, openRes, kbMetaRes, userContext] = await Promise.all([
    supabaseServer.from("messages").select("*").eq("owner_id", ownerId).order("created_at", { ascending: false }),
    supabaseServer.from("leads").select("*").eq("owner_id", ownerId),
    supabaseServer.from("campaigns").select("*").eq("owner_id", ownerId),
    supabaseServer.from("replies").select("*").eq("owner_id", ownerId),
    supabaseServer.from("email_opens").select("*").eq("owner_id", ownerId),
    supabaseServer
      .from("knowledge")
      .select("id, category, content")
      .eq("owner_id", ownerId)
      .in("category", ["system_onboarding_state", "system_kb_structured"]),
    loadUserContextServer(ownerId),
  ]);

  let onboarding: OnboardingState | null = null;
  let structuredKb: StructuredKnowledgeBase | null = null;
  for (const row of (kbMetaRes.data ?? []) as Record<string, unknown>[]) {
    try {
      if (row.category === "system_onboarding_state" || row.id === `system_onboarding_${ownerId}`) {
        onboarding = JSON.parse(String(row.content ?? "null")) as OnboardingState | null;
      } else if (row.category === "system_kb_structured" || row.id === `system_kb_structured_${ownerId}`) {
        structuredKb = JSON.parse(String(row.content ?? "null")) as StructuredKnowledgeBase | null;
      }
    } catch {
      /* ignore corrupt metadata */
    }
  }

  const settings = (userContext.settings ?? {}) as Settings;
  return {
    messages: ((msgRes.data ?? []) as Record<string, unknown>[]).map(mapSqlMessage),
    leads: ((leadRes.data ?? []) as Record<string, unknown>[]).map(mapSqlLead),
    campaigns: (campRes.data ?? []) as Campaign[],
    replies: (repRes.data ?? []) as Reply[],
    opens: (openRes.data ?? []) as EmailOpen[],
    userContext,
    onboarding,
    structuredKb,
    settings,
  };
}

async function loadWorkspaceFromSupabase(ownerId: string): Promise<EmailRewriteWorkspaceState | null> {
  const mem = memoryWorkspaceMirror.get(ownerId);
  if (!supabaseServer) return mem ?? null;

  try {
    const { data, error } = await supabaseServer
      .from("email_rewrite_workspaces")
      .select("state_json")
      .eq("owner_id", ownerId)
      .maybeSingle();
    if (!error && data) {
      const parsed = (data as { state_json?: EmailRewriteWorkspaceState }).state_json;
      if (parsed && parsed.ownerId === ownerId) {
        memoryWorkspaceMirror.set(ownerId, parsed);
        return parsed;
      }
    }
  } catch {
    /* fallback below */
  }

  const { data: kbRow } = await supabaseServer
    .from("knowledge")
    .select("content")
    .eq("id", `system_email_rewrites_${ownerId}`)
    .eq("owner_id", ownerId)
    .maybeSingle();
  const raw = (kbRow as { content?: string } | null)?.content;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as EmailRewriteWorkspaceState;
      if (parsed.ownerId === ownerId) {
        memoryWorkspaceMirror.set(ownerId, parsed);
        return parsed;
      }
    } catch {
      /* ignore */
    }
  }
  return mem ?? null;
}

async function saveWorkspaceToSupabase(ownerId: string, state: EmailRewriteWorkspaceState): Promise<void> {
  const next: EmailRewriteWorkspaceState = { ...state, ownerId, updatedAt: new Date().toISOString() };
  memoryWorkspaceMirror.set(ownerId, next);
  if (!supabaseServer) return;

  try {
    const { error } = await supabaseServer.from("email_rewrite_workspaces").upsert(
      {
        owner_id: ownerId,
        state_json: next,
        updated_at: next.updatedAt,
      } as never,
      { onConflict: "owner_id" },
    );
    if (!error) return;
  } catch {
    /* fallback below */
  }

  await supabaseServer.from("knowledge").upsert(
    {
      id: `system_email_rewrites_${ownerId}`,
      owner_id: ownerId,
      category: "system_email_rewrites",
      title: "Email Review AI Rewrite Workspace",
      content: JSON.stringify(next),
      sort: 999,
      is_master: false,
      updated_at: next.updatedAt,
    } as never,
    { onConflict: "id" },
  );
}

async function updateMessageInSupabase(
  ownerId: string,
  messageId: string,
  patch: { subject: string; body: string; angle?: string | null; rationale?: string | null },
): Promise<void> {
  if (!supabaseServer) return;
  const { error } = await supabaseServer
    .from("messages")
    .update({
      subject: patch.subject.slice(0, 200),
      body: patch.body.slice(0, 12_000),
      ...(patch.angle !== undefined ? { angle: patch.angle } : {}),
      ...(patch.rationale !== undefined ? { rationale: patch.rationale } : {}),
      updated_at: new Date().toISOString(),
    } as never)
    .eq("id", messageId)
    .eq("owner_id", ownerId);
  if (error) {
    throw new Error(`Could not update message ${messageId}: ${error.message}`);
  }
}

function getStore(): EmailRewriteStoreAdapter {
  if (testStoreOverride) return testStoreOverride;
  return {
    loadOwnerSnapshot: loadOwnerSnapshotFromSupabase,
    loadWorkspace: loadWorkspaceFromSupabase,
    saveWorkspace: saveWorkspaceToSupabase,
    updateMessageFields: updateMessageInSupabase,
  };
}

// ---------------------------------------------------------------------------
// Knowledge Base Extractor & Preflight Analyzer (Strict User KB Truth)
// ---------------------------------------------------------------------------

export interface ExtractedKnowledgeForRewrite {
  sectionsUsed: KnowledgeSectionStatus[];
  gaps: KnowledgeGapItem[];
  sampleEmails: string[];
  groundedKbDossier: string;
  kbEmpty: boolean;
}

function firstNonEmpty(...vals: Array<string | undefined | null>): string {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function extractSampleSectionFromMarkdown(markdown: string): string {
  if (!markdown.trim()) return "";
  const m = markdown.match(
    /(?:^|\n)#{1,4}\s*[^\n]*(?:sample\s*email|example\s*(?:email|message|outreach)|email\s*template)[^\n]*\n([\s\S]{10,2000}?)(?=\n#{1,4}\s|$)/i,
  );
  return m?.[1]?.trim() ?? "";
}

export function extractKnowledgeForRewrite(snap: RewriteOwnerSnapshot): ExtractedKnowledgeForRewrite {
  const { userContext, onboarding, structuredKb } = snap;
  const secList = structuredKb?.sections ?? [];
  const findSec = (key: string) => secList.find((s) => s.key === key)?.content?.trim() ?? "";
  const a = onboarding?.answers;
  const p = userContext.profile;

  const businessOverview = [
    findSec("business_overview"),
    a?.businessDescription,
    p.user_company && p.user_offer ? `${p.user_company}: ${p.user_offer}` : "",
    userContext.masterKnowledge ? userContext.masterKnowledge.slice(0, 700) : "",
  ]
    .map((x) => (x ?? "").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 800);

  const offerPricing = [
    findSec("offer_pricing"),
    findSec("products_services"),
    p.user_offer,
    a?.mainServices?.length ? `Services: ${a.mainServices.join(", ")}` : "",
    a?.mainProblemSolved ? `Solves: ${a.mainProblemSolved}` : "",
    a?.priceRange ? `Price range: ${a.priceRange}` : "",
    a?.differentiators ? `Differentiators: ${a.differentiators}` : "",
    a?.hasGuarantee && a?.guaranteeDetails ? `Guarantee: ${a.guaranteeDetails}` : "",
  ]
    .map((x) => (x ?? "").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 900);

  const proofCredibility = [
    findSec("proof_credibility"),
    p.user_proof,
    a?.proof,
  ]
    .map((x) => (x ?? "").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 800);

  const idealCustomer = [
    findSec("ideal_customer"),
    p.user_icp,
    a?.idealCustomerSummary,
    a?.icpIndustries?.length ? `Industries: ${a.icpIndustries.join(", ")}` : "",
    a?.icpRoles?.length ? `Decision makers: ${a.icpRoles.join(", ")}` : "",
    a?.icpCompanySize ? `Company size: ${a.icpCompanySize}` : "",
    a?.icpPainPoints ? `Pain points: ${a.icpPainPoints}` : "",
    a?.icpExclusions || p.user_exclusions ? `Exclusions: ${firstNonEmpty(a?.icpExclusions, p.user_exclusions)}` : "",
  ]
    .map((x) => (x ?? "").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 900);

  const brandVoice = [
    findSec("brand_voice"),
    p.user_tone,
    a?.brandTones?.length ? `Tone: ${a.brandTones.join(", ")}` : "",
    a?.wordsToUse ? `Words to use: ${a.wordsToUse}` : "",
    a?.wordsToAvoid ? `Words to avoid: ${a.wordsToAvoid}` : "",
  ]
    .map((x) => (x ?? "").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 700);

  const messagingNotesAndSources = [
    p.user_custom_rules,
    ...userContext.notes
      .filter((n) => !/sample|template/i.test(`${n.title} ${n.category}`))
      .slice(0, 5)
      .map((n) => `${n.title}: ${n.content.slice(0, 300)}`),
    ...userContext.sources.slice(0, 3).map((s) => `${s.label}: ${(s.content ?? "").slice(0, 300)}`),
  ]
    .map((x) => (x ?? "").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 900);

  // Sample emails collected from onboarding, notes, sections, or master knowledge
  const rawSamples: string[] = [];
  if (a?.sampleMessages?.trim()) rawSamples.push(a.sampleMessages.trim());
  for (const s of secList) {
    if (/sample|template|email/i.test(`${s.key} ${s.title}`) && s.content.trim()) {
      rawSamples.push(`${s.title}:\n${s.content.trim()}`);
    }
  }
  for (const n of userContext.notes) {
    if (/sample|template|email/i.test(`${n.title} ${n.category}`) && n.content.trim()) {
      rawSamples.push(`${n.title}:\n${n.content.trim()}`);
    }
  }
  const mdSample = extractSampleSectionFromMarkdown(userContext.masterKnowledge);
  if (mdSample) rawSamples.push(mdSample);
  const sampleEmails = Array.from(new Set(rawSamples)).map((s) => s.slice(0, 900)).slice(0, 4);

  const sectionsUsed: KnowledgeSectionStatus[] = [
    { key: "business_overview", label: "Business overview", present: businessOverview.length > 0, charCount: businessOverview.length },
    { key: "offer_pricing", label: "Offer & pricing", present: offerPricing.length > 0, charCount: offerPricing.length },
    { key: "proof_credibility", label: "Proof & credibility", present: proofCredibility.length > 0, charCount: proofCredibility.length },
    { key: "ideal_customer", label: "Ideal customer profile", present: idealCustomer.length > 0, charCount: idealCustomer.length },
    { key: "brand_voice", label: "Brand voice", present: brandVoice.length > 0, charCount: brandVoice.length },
    { key: "messaging_guidelines", label: "Messaging guidelines", present: messagingNotesAndSources.length > 0, charCount: messagingNotesAndSources.length },
    { key: "sample_emails", label: "Sample emails", present: sampleEmails.length > 0, charCount: sampleEmails.join("\n").length },
  ];

  const gaps: KnowledgeGapItem[] = [];
  if (sampleEmails.length === 0) {
    gaps.push({
      key: "sample_emails",
      label: "No sample emails in your Knowledge Base",
      promptToFill:
        "Add 1-2 example emails you like under Knowledge Base (note titled 'Sample Emails') so AI mirrors your real cadence, greeting, and structure.",
    });
  }
  if (!proofCredibility) {
    gaps.push({
      key: "proof_credibility",
      label: "No proof points or client results in Knowledge Base",
      promptToFill:
        "Add verified case studies, outcomes, or client results in Knowledge Base -> Proof & Credibility so AI can write stronger proof-led emails without guessing.",
    });
  }
  if (!offerPricing) {
    gaps.push({
      key: "offer_pricing",
      label: "Missing offer, deliverables, or pricing range",
      promptToFill:
        "Fill out Offer, pricing and differentiators in Knowledge Base so emails pitch exact deliverables instead of generic help.",
    });
  }
  if (!idealCustomer) {
    gaps.push({
      key: "ideal_customer",
      label: "Missing Ideal Customer Profile & pain points",
      promptToFill:
        "Define target roles, industries, and core buyer pain points in Knowledge Base -> Ideal customer profile.",
    });
  }
  if (!brandVoice) {
    gaps.push({
      key: "brand_voice",
      label: "Missing Brand Voice preferences",
      promptToFill:
        "Add preferred tone, words to use, and words to avoid in Knowledge Base -> Brand voice.",
    });
  }
  if (!snap.settings.sender_name?.trim() && !p.user_name?.trim()) {
    gaps.push({
      key: "sender_identity",
      label: "Missing sender name in Settings",
      promptToFill: "Set your Sender Name and Company in Settings so sign-offs stay consistent and accurate.",
    });
  }

  const kbEmpty = sectionsUsed.every((s) => !s.present);
  const groundedBlocks: string[] = [];
  if (businessOverview) groundedBlocks.push(`## Business Overview\n${businessOverview}`);
  if (offerPricing) groundedBlocks.push(`## Offer & Pricing\n${offerPricing}`);
  if (proofCredibility) groundedBlocks.push(`## Proof & Credibility\n${proofCredibility}`);
  if (idealCustomer) groundedBlocks.push(`## Ideal Customer Profile\n${idealCustomer}`);
  if (brandVoice) groundedBlocks.push(`## Brand Voice & Words Rules\n${brandVoice}`);
  if (messagingNotesAndSources) groundedBlocks.push(`## Additional Messaging Guidelines\n${messagingNotesAndSources}`);
  if (sampleEmails.length > 0) {
    groundedBlocks.push(
      `## Reference Sample Emails (STYLE/STRUCTURE ONLY — learn tone, sentence cadence & layout; NEVER copy word for word)\n${sampleEmails
        .map((s, i) => `### Sample ${i + 1}\n${s}`)
        .join("\n\n")}`,
    );
  }

  const groundedKbDossier =
    groundedBlocks.length > 0
      ? groundedBlocks.join("\n\n").slice(0, 4_200)
      : "(Knowledge Base is currently empty — do NOT invent any offer, price, claim, result, or testimonial. State only verifiable facts from the lead record or keep messaging strictly non-fabricating.)";

  return {
    sectionsUsed,
    gaps,
    sampleEmails,
    groundedKbDossier,
    kbEmpty,
  };
}

export async function getRewritePreflightAndWorkspace(input: {
  ownerId: string;
  scope?: RewriteScope;
  selectedIds?: string[];
}): Promise<{
  preflight: RewritePreflightSummary;
  workspace: EmailRewriteWorkspaceState;
  latestJob: BackgroundJobRecord | null;
}> {
  const store = getStore();
  const scope: RewriteScope = input.scope ?? "all";
  const selectedIds = input.selectedIds ?? [];

  const [snap, savedWs, latestRawJob] = await Promise.all([
    store.loadOwnerSnapshot(input.ownerId),
    store.loadWorkspace(input.ownerId),
    getLatestBackgroundJobForOwner(input.ownerId, "email_review_rewrite"),
  ]);

  const latestJob = latestRawJob
    ? await failStalledBackgroundJob(input.ownerId, latestRawJob, REWRITE_JOB_STALL_MS)
    : null;

  const kb = extractKnowledgeForRewrite(snap);
  const reviewable = snap.messages.filter(
    (m) => !(m.kind === "reply" && m.status === "draft") && m.status !== "sent" && m.status !== "sending",
  );
  const messageIdsInScope = filterReviewableMessageIds(snap.messages, scope, selectedIds);
  const inScopeSet = new Set(messageIdsInScope);
  const uniqueLeadsCount = new Set(
    reviewable.filter((m) => inScopeSet.has(m.id)).map((m) => m.lead_id),
  ).size;

  const workspace: EmailRewriteWorkspaceState = savedWs
    ? {
        ...savedWs,
        kbSectionsUsed: kb.sectionsUsed,
        kbGaps: kb.gaps,
      }
    : {
        ...defaultEmptyWorkspace(input.ownerId),
        kbSectionsUsed: kb.sectionsUsed,
        kbGaps: kb.gaps,
      };

  return {
    preflight: {
      scope,
      totalReviewableEmails: reviewable.length,
      inScopeEmails: messageIdsInScope.length,
      uniqueLeadsCount,
      messageIdsInScope,
      sectionsUsed: kb.sectionsUsed,
      gaps: kb.gaps,
      sampleEmailsFound: kb.sampleEmails.length,
      kbEmpty: kb.kbEmpty,
    },
    workspace,
    latestJob,
  };
}

// ---------------------------------------------------------------------------
// Single Lead Analysis + Writer + 3-Attempt Self-Check Pipeline
// ---------------------------------------------------------------------------

const ANALYSIS_AND_WRITE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    analysis: {
      type: Type.OBJECT,
      properties: {
        decisionMaker: { type: Type.STRING },
        role: { type: Type.STRING },
        seniority: { type: Type.STRING },
        company: { type: Type.STRING },
        industry: { type: Type.STRING },
        size: { type: Type.STRING },
        location: { type: Type.STRING },
        needsAndPainPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
        buyingIntentSignals: { type: Type.ARRAY, items: { type: Type.STRING } },
        timingOrTriggers: { type: Type.ARRAY, items: { type: Type.STRING } },
        verifiedHooks: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              hook: { type: Type.STRING },
              source: { type: Type.STRING },
            },
            required: ["hook", "source"],
          },
        },
        chosenPattern: {
          type: Type.OBJECT,
          properties: {
            framework: { type: Type.STRING },
            frameworkReason: { type: Type.STRING },
            toneAndFormality: { type: Type.STRING },
            toneReason: { type: Type.STRING },
            lengthAndStructure: { type: Type.STRING },
            lengthReason: { type: Type.STRING },
            subjectLineApproach: { type: Type.STRING },
            subjectReason: { type: Type.STRING },
            ctaStyle: { type: Type.STRING },
            ctaReason: { type: Type.STRING },
            followUpTiming: { type: Type.STRING },
            followUpReason: { type: Type.STRING },
            overallReason: { type: Type.STRING },
          },
          required: [
            "framework",
            "frameworkReason",
            "toneAndFormality",
            "toneReason",
            "lengthAndStructure",
            "lengthReason",
            "subjectLineApproach",
            "subjectReason",
            "ctaStyle",
            "ctaReason",
            "followUpTiming",
            "followUpReason",
            "overallReason",
          ],
        },
      },
      required: [
        "decisionMaker",
        "role",
        "seniority",
        "company",
        "industry",
        "location",
        "needsAndPainPoints",
        "verifiedHooks",
        "chosenPattern",
      ],
    },
    subject: { type: Type.STRING },
    subjectOptions: { type: Type.ARRAY, items: { type: Type.STRING } },
    body: { type: Type.STRING },
  },
  required: ["analysis", "subject", "subjectOptions", "body"],
};

function buildLeadDossier(input: {
  lead: Lead;
  messages: Message[];
  replies: Reply[];
  opens: EmailOpen[];
}): {
  dossier: string;
  hasVerifiedEvidence: boolean;
  pastEngagement: LeadRewriteAnalysis["pastEngagement"];
} {
  const { lead, messages, replies, opens } = input;
  const r = lead.research;
  const sr = lead.score_reason;

  const leadSentCount = messages.filter((m) => m.lead_id === lead.id && m.status === "sent").length;
  const leadReplies = replies.filter((rp) => rp.lead_id === lead.id);
  const leadOpens = opens.filter((op) => op.lead_id === lead.id).length;

  const pastEngagement: LeadRewriteAnalysis["pastEngagement"] = {
    emailsSent: leadSentCount,
    repliesCount: leadReplies.length,
    opensCount: leadOpens,
    clicksCount: 0,
    summary:
      leadSentCount + leadReplies.length + leadOpens > 0
        ? `${leadSentCount} sent, ${leadOpens} open(s), ${leadReplies.length} reply/replies`
        : "No prior sends, opens, clicks, or replies recorded for this lead",
  };

  const verifiedFactsList = [
    ...(r?.verified_facts?.map((f) => `${f.fact} [source: ${f.source}]`) ?? []),
    ...(r?.website_facts?.map((w) => `${w} [source: ${lead.website || "website inspection"}]`) ?? []),
    ...(r?.verified_site_issues?.map((i) => `${i} [source: ${lead.website || "site check"}]`) ?? []),
    ...(r?.findings?.map((f) => `${f.area}: ${f.observation} (${f.evidence}) [source: ${lead.website || "research"}]`) ?? []),
    ...(r?.personalized_hook_candidates?.map((h) => `${h} [source: ${lead.website || lead.source_ref || "research"}]`) ?? []),
  ].slice(0, 10);

  const hasVerifiedEvidence =
    verifiedFactsList.length > 0 || Boolean(r?.summary?.trim()) || Boolean(lead.manual_research?.trim());

  const dossier = `LEAD VERIFIED RECORD
- Company: ${lead.business ?? "Unknown"}
- Decision Maker: ${lead.contact_name || "(unknown — DO NOT invent a first name in the greeting)"}
- Role: ${lead.role || "Unknown"}
- Industry: ${lead.industry || r?.industry || "Unknown"}
- Location: ${lead.location || "Unknown"}
- Website: ${lead.website || "(none)"}
- Score / Tier: ${lead.score ?? "Unscored"}${sr?.tier ? ` (Tier ${sr.tier})` : ""}${sr?.category ? ` · priority=${sr.category}` : ""}
- Qualification Reasons / Intent: ${sr?.reasons?.join(" | ") || "(none)"}
- Qualification Opportunity: ${sr?.opportunity || "(none)"}
- Research Summary: ${r?.summary?.slice(0, 600) || "(sparse / no website summary)"}
- Verified Hooks & Facts (USE ONLY THESE — NEVER INVENT HOOKS):
${verifiedFactsList.length > 0 ? verifiedFactsList.map((v) => `  * ${v}`).join("\n") : "  * NONE FOUND — do not invent any hook, recent event, or website observation."}
- User Manual Notes: ${lead.manual_research?.slice(0, 400) || lead.notes?.slice(0, 350) || "(none)"}
- Past Engagement: ${pastEngagement.summary}`;

  return { dossier, hasVerifiedEvidence, pastEngagement };
}

async function rewriteAndSelfCheckOneMessage(input: {
  ownerId: string;
  message: Message;
  lead: Lead;
  snap: RewriteOwnerSnapshot;
  kb: ExtractedKnowledgeForRewrite;
  existingItem?: EmailRewriteItem;
  instruction?: string;
  onProgressStep?: (phaseLabel: string) => Promise<void>;
}): Promise<EmailRewriteItem> {
  const { ownerId, message, lead, snap, kb, existingItem } = input;
  const nowIso = new Date().toISOString();

  const originalSubject = existingItem?.originalSubject ?? (message.subject ?? "");
  const originalBody = existingItem?.originalBody ?? (message.body ?? "");
  const baseVersions: RewriteVersionEntry[] = existingItem?.versions?.length
    ? existingItem.versions
    : [
        {
          versionId: "v_orig",
          createdAt: message.created_at || nowIso,
          source: "original",
          subject: originalSubject,
          body: originalBody,
          status: "pending",
        },
      ];

  const { dossier, hasVerifiedEvidence, pastEngagement } = buildLeadDossier({
    lead,
    messages: snap.messages,
    replies: snap.replies,
    opens: snap.opens,
  });

  const compliance = getRegionalComplianceGuidance({
    targetLocation: lead.location ?? "",
    senderLocation: snap.settings.physical_address ?? "",
    physicalAddress: snap.settings.physical_address ?? "",
  });

  const otherLeadBusinesses = snap.leads
    .filter((l) => l.id !== lead.id && l.business)
    .map((l) => l.business!.trim())
    .slice(0, 20);

  await input.onProgressStep?.(`Analysing ${lead.business ?? lead.email ?? "lead"}`);

  const taskInstructions = `Rewrite this outreach email strictly grounded in the ACTIVE USER KNOWLEDGE BASE and LEAD VERIFIED RECORD.

HARD GROUNDING & ANTI-HALLUCINATION RULES:
1. NEVER invent offers, prices, results, testimonials, case studies, company events, hooks, or first names missing from the KB or lead's verified record.
2. If verified hooks/facts say NONE FOUND, return verifiedHooks: [] and write naturally from verified role/industry/business reality without fabricating hooks.
3. Learn from Sample Emails in KB (tone, cadence, sentence structure) WITHOUT copying them word for word.
4. No placeholders ([Name], [Company], {{...}}), no banned clichés ("hope this email finds you well", "came across your website", "game-changer", "synergy", "delve").
5. End cold outreach emails naturally with sender identity (${snap.settings.sender_name || snap.userContext.variables.USER_NAME}${snap.settings.sender_company ? ` · ${snap.settings.sender_company}` : ""})${snap.settings.include_opt_out_footer === true ? ` and one brief plain opt-out line (${compliance.frameworkName})` : " — do NOT add generic unsubscribe or opt-out footers unless the account enables them"}.
6. Produce 2-3 subjectOptions AND plain-language reasoning for every chosen pattern field.`;

  const orchestrated = await buildOrchestratedSystemPrompt({
    workflow: "draft_outreach",
    ownerId,
    userContext: snap.userContext,
    settings: snap.settings,
    knowledgeDigest: kb.groundedKbDossier,
    taskInstructions,
  });

  const userPrompt = `${kb.groundedKbDossier}

${dossier}

CURRENT EMAIL BEING REWRITTEN (Type: ${message.kind}, Step: ${message.step})
Original Subject: ${originalSubject || "(empty)"}
Original Body:
${originalBody || "(empty)"}

Compliance Framework for ${compliance.region}: ${compliance.frameworkName} (${compliance.requirements.slice(0, 2).join("; ")})
${input.instruction?.trim() ? `\nSPECIAL USER REWRITE INSTRUCTION (must follow cleanly): ${input.instruction.trim()}` : ""}

Step 1: Populate the lead-by-lead analysis & chosen pattern with clear reasons tied to KB & lead research.
Step 2: Write a tailored subject (plus 2-3 subjectOptions) and complete human email body.`;

  let finalAnalysis: LeadRewriteAnalysis | null = null;
  let candidateSubject = "";
  let candidateBody = "";
  let subjectOptions: string[] = [];
  let lastCheckIssues: string[] = [];
  let criteriaPassed = {
    kbGroundedOnly: false,
    noPlaceholdersOrWrongNames: false,
    matchesBrandVoice: false,
    clearCtaAndLengthFit: false,
    compliancePresent: false,
  };
  let passed = false;
  let attempts = 0;

  for (let attempt = 1; attempt <= MAX_SELF_CHECK_ATTEMPTS; attempt++) {
    attempts = attempt;
    await input.onProgressStep?.(
      attempt === 1
        ? `Writing rewrite for ${lead.business ?? lead.email ?? "lead"}`
        : `Regenerating for ${lead.business ?? lead.email ?? "lead"} (attempt ${attempt}/${MAX_SELF_CHECK_ATTEMPTS})`,
    );

    const feedbackAddendum =
      attempt > 1 && lastCheckIssues.length > 0
        ? `\n\nPREVIOUS ATTEMPT FAILED SELF-CHECK FOR THESE EXACT REASONS:\n${lastCheckIssues
            .map((iss) => `- ${iss}`)
            .join("\n")}\nFix EVERY single issue cleanly without adding ungrounded claims or placeholders.`
        : "";

    const { data: generated } = await LLMGateway.completeJSON<{
      analysis?: {
        decisionMaker?: string;
        role?: string;
        seniority?: string;
        company?: string;
        industry?: string;
        size?: string;
        location?: string;
        needsAndPainPoints?: unknown[];
        buyingIntentSignals?: unknown[];
        timingOrTriggers?: unknown[];
        verifiedHooks?: { hook?: string; source?: string }[];
        chosenPattern?: Partial<LeadRewriteAnalysis["chosenPattern"]>;
      };
      subject?: string;
      subjectOptions?: unknown[];
      body?: string;
    }>({
      ownerId,
      taskType: "balanced",
      feature: "email_rewrite",
      systemPrompt: orchestrated.system,
      messages: [{ role: "user", content: `${userPrompt}${feedbackAddendum}` }],
      schema: ANALYSIS_AND_WRITE_SCHEMA,
      maxTokens: 2000,
      },
      {
        // Empty subject/body is a provider failure, not a rewrite: the gateway
        // retries the next healthy model instead of surfacing "empty rewrite".
        validate: (data) => {
          const body = String(data?.body ?? "").trim();
          const subject = String(data?.subject ?? "").trim();
          if (!body || !subject) {
            throw new Error("Rewrite produced an empty subject or body.");
          }
        },
      },
    );

    candidateSubject = stripUnresolvedPlaceholders(String(generated.subject ?? "")).split("\n")[0].trim();
    candidateBody = normalizeEmailGreeting(
      stripUnresolvedPlaceholders(String(generated.body ?? "")),
      lead.contact_name,
      lead.role,
    );
    subjectOptions = Array.from(
      new Set(
        [
          candidateSubject,
          ...(Array.isArray(generated.subjectOptions)
            ? generated.subjectOptions.map((s) => stripUnresolvedPlaceholders(String(s ?? "")).trim())
            : []),
        ].filter(Boolean),
      ),
    ).slice(0, 3);

    const rawA = generated.analysis ?? {};
    const rawCp = rawA.chosenPattern ?? {};
    const cleanHooks = Array.isArray(rawA.verifiedHooks)
      ? rawA.verifiedHooks
          .filter((h) => h && typeof h.hook === "string" && typeof h.source === "string" && h.hook.trim() && h.source.trim())
          .map((h) => ({ hook: h.hook!.trim(), source: h.source!.trim() }))
          .slice(0, 4)
      : [];

    finalAnalysis = {
      whoTheyAre: {
        decisionMaker: String(rawA.decisionMaker ?? lead.contact_name ?? "Not verified").trim() || "Not verified",
        role: String(rawA.role ?? lead.role ?? "Unknown").trim() || "Unknown",
        seniority: String(rawA.seniority ?? "Unknown").trim() || "Unknown",
        company: String(lead.business ?? rawA.company ?? "Unknown").trim(),
        industry: String(lead.industry ?? rawA.industry ?? "Unknown").trim(),
        size: String(rawA.size ?? "Unknown").trim() || "Unknown",
        location: String(lead.location ?? rawA.location ?? "Unknown").trim() || "Unknown",
      },
      needsAndPainPoints: Array.isArray(rawA.needsAndPainPoints)
        ? rawA.needsAndPainPoints.map((x) => String(x).trim()).filter(Boolean).slice(0, 5)
        : [],
      qualificationSummary: {
        score: lead.score ?? null,
        tier: lead.score_reason?.tier ?? (lead.score && lead.score >= 80 ? "A" : lead.score && lead.score >= 65 ? "B" : "Unscored"),
        buyingIntentSignals: Array.isArray(rawA.buyingIntentSignals)
          ? rawA.buyingIntentSignals.map((x) => String(x).trim()).filter(Boolean).slice(0, 4)
          : [],
        timingOrTriggers: Array.isArray(rawA.timingOrTriggers)
          ? rawA.timingOrTriggers.map((x) => String(x).trim()).filter(Boolean).slice(0, 4)
          : [],
      },
      pastEngagement,
      verifiedHooks: hasVerifiedEvidence ? cleanHooks : [],
      chosenPattern: {
        framework: String(rawCp.framework ?? "Consultative").trim(),
        frameworkReason: String(rawCp.frameworkReason ?? "Matched to verified lead context and Knowledge Base.").trim(),
        toneAndFormality: String(rawCp.toneAndFormality ?? "Conversational professional").trim(),
        toneReason: String(rawCp.toneReason ?? "Aligned to brand voice and lead role.").trim(),
        lengthAndStructure: String(rawCp.lengthAndStructure ?? "Short 3-paragraph scan").trim(),
        lengthReason: String(rawCp.lengthReason ?? "Easy mobile skim for busy decision makers.").trim(),
        subjectLineApproach: String(rawCp.subjectLineApproach ?? "2-4 word lowercase observation").trim(),
        subjectReason: String(rawCp.subjectReason ?? "Natural inbox delivery without clickbait.").trim(),
        ctaStyle: String(rawCp.ctaStyle ?? "Soft interest check").trim(),
        ctaReason: String(rawCp.ctaReason ?? "Low-friction question invites reply.").trim(),
        followUpTiming: String(rawCp.followUpTiming ?? "3-4 business days").trim(),
        followUpReason: String(rawCp.followUpReason ?? "Balances visibility without rushing.").trim(),
        overallReason: String(rawCp.overallReason ?? "Tailored strictly to verified facts and KB rules.").trim(),
      },
    };

    await input.onProgressStep?.(`Checking ${lead.business ?? lead.email ?? "lead"} (${attempt}/${MAX_SELF_CHECK_ATTEMPTS})`);

    const detAudit = runDeterministicRewriteAudit({
      subject: candidateSubject,
      body: candidateBody,
      kind: message.kind,
      leadBusiness: lead.business,
      leadContactName: lead.contact_name,
      senderName: snap.settings.sender_name || snap.userContext.variables.USER_NAME || "",
      senderCompany: snap.settings.sender_company || snap.userContext.variables.USER_COMPANY || "",
      otherLeadBusinesses,
      sampleEmails: kb.sampleEmails,
      includeOptOutFooter: snap.settings.include_opt_out_footer === true,
      groundingText: `${kb.groundedKbDossier}\n${dossier}`,
    });

    // Quality is judged deterministically (zero extra LLM calls). Each rewrite
    // used to cost 2 calls per attempt and up to 6 calls per email, which is
    // what burned the free quota and slowed every email to 20-40s.
    const kbGroundedOnly = detAudit.noPlaceholdersOrWrongNames;
    const matchesBrandVoice = detAudit.clearCtaAndLengthFit;

    lastCheckIssues = Array.from(new Set(detAudit.issues));

    criteriaPassed = {
      kbGroundedOnly,
      noPlaceholdersOrWrongNames: detAudit.noPlaceholdersOrWrongNames,
      matchesBrandVoice,
      clearCtaAndLengthFit: detAudit.clearCtaAndLengthFit,
      compliancePresent: detAudit.compliancePresent,
    };

    passed =
      detAudit.passed &&
      kbGroundedOnly &&
      matchesBrandVoice &&
      lastCheckIssues.length === 0;

    if (passed) break;
    // Update userPrompt only if needed; loop feeds exact issues back cleanly
  }

  const itemStatus = passed ? "rewritten" : "needs_attention";
  const newVersion: RewriteVersionEntry = {
    versionId: `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    createdAt: new Date().toISOString(),
    source: input.instruction ? "ai_regenerate" : "ai_rewrite",
    subject: candidateSubject,
    body: candidateBody,
    instruction: input.instruction?.trim() || undefined,
    status: itemStatus,
    checkIssues: passed ? undefined : lastCheckIssues,
  };

  return {
    messageId: message.id,
    leadId: lead.id,
    campaignId: message.campaign_id,
    business: lead.business ?? lead.email ?? "Prospect",
    leadEmail: lead.email ?? null,
    kind: message.kind,
    step: message.step,
    originalSubject,
    originalBody,
    rewrittenSubject: candidateSubject,
    rewrittenBody: candidateBody,
    subjectOptions,
    status: itemStatus,
    statusReason: passed ? undefined : lastCheckIssues.join(" "),
    analysis: finalAnalysis,
    check: {
      passed,
      attempts,
      issues: lastCheckIssues,
      criteria: criteriaPassed,
    },
    versions: [...baseVersions, newVersion].slice(-25),
    kbGapsNoted: kb.gaps.map((g) => g.label),
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Cross-Lead Pattern Analyzer
// ---------------------------------------------------------------------------

export async function synthesizeCrossLeadPatterns(input: {
  ownerId: string;
  items: EmailRewriteItem[];
}): Promise<CrossLeadPatternSummary> {
  const validItems = input.items.filter((it) => it.analysis);
  const totalEngagements = validItems.reduce(
    (sum, it) => sum + (it.analysis?.pastEngagement.opensCount ?? 0) + (it.analysis?.pastEngagement.repliesCount ?? 0),
    0,
  );
  const basedOnEngagementData = totalEngagements > 0;
  const label = basedOnEngagementData
    ? `Patterns informed by ${totalEngagements} recorded engagement event(s) and lead profiles (recommendations only — never a guarantee of replies).`
    : "Informed recommendations based on lead profiles & Knowledge Base (no open/reply engagement data recorded yet — not proven results).";

  if (validItems.length === 0) {
    return { basedOnEngagementData: false, label, patterns: [] };
  }

  const compactDigest = validItems
    .slice(0, 20)
    .map(
      (it) =>
        `- ${it.analysis!.whoTheyAre.role} | ${it.analysis!.whoTheyAre.industry} -> Framework: ${it.analysis!.chosenPattern.framework}, CTA: ${it.analysis!.chosenPattern.ctaStyle}, Engagement: ${it.analysis!.pastEngagement.summary}`,
    )
    .join("\n");

  try {
    const { data } = await LLMGateway.completeJSON<{
      patterns?: { pattern?: string; segment?: string; explanation?: string }[];
    }>({
      ownerId: input.ownerId,
      taskType: "fast",
      feature: "email_rewrite_patterns",
      systemPrompt:
        "Summarize cross-lead messaging patterns conservatively from the supplied list. Never claim guaranteed reply lifts or invent metrics. If engagement count is zero, explicitly frame every insight as a recommendation based on profiles and KB.",
      messages: [
        {
          role: "user",
          content: `ENGAGEMENT DATA AVAILABLE: ${basedOnEngagementData ? "YES" : "NO (inform only as recommendations)"}\n\nLEADS:\n${compactDigest}\n\nReturn JSON { patterns: [{ pattern, segment, explanation }] } (max 4 concise items).`,
        },
      ],
      maxTokens: 700,
    });

    const patterns: CrossLeadPatternInsight[] = (Array.isArray(data.patterns) ? data.patterns : [])
      .map((p) => ({
        pattern: String(p.pattern ?? "").trim(),
        segment: String(p.segment ?? "All leads").trim(),
        explanation: String(p.explanation ?? "").trim(),
        isRecommendation: !basedOnEngagementData,
      }))
      .filter((p) => p.pattern && p.explanation)
      .slice(0, 4);

    if (patterns.length > 0) {
      return { basedOnEngagementData, label, patterns };
    }
  } catch {
    /* fallback deterministically below */
  }

  // Deterministic fallback summarizing dominant framework across leads
  const fwCounts = new Map<string, number>();
  for (const it of validItems) {
    const fw = it.analysis!.chosenPattern.framework || "Consultative";
    fwCounts.set(fw, (fwCounts.get(fw) ?? 0) + 1);
  }
  const top = Array.from(fwCounts.entries()).sort((a, b) => b[1] - a[1]);
  return {
    basedOnEngagementData,
    label,
    patterns: top.slice(0, 3).map(([fw, count]) => ({
      pattern: `${fw} selected for ${count} of ${validItems.length} lead(s)`,
      segment: "Current review queue",
      explanation: basedOnEngagementData
        ? "Chosen based on role/industry context and recorded engagement history."
        : "Informed recommendation based on decision-maker role and available Knowledge Base data.",
      isRecommendation: !basedOnEngagementData,
    })),
  };
}

// ---------------------------------------------------------------------------
// Background Job Orchestration & Reliable Partial/Quota-Safe Execution
// ---------------------------------------------------------------------------

function isQuotaOrRateLimitFailure(err: unknown): boolean {
  if (err instanceof LLMGatewayError) {
    return err.status === 429 || err.status === 503 || /cooldown|quota|limit/i.test(err.message);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /quota|rate limit|cooling down|exhausted|429/i.test(msg);
}

export function signRewriteContinuationToken(ownerId: string, jobId: string, expMs: number): string {
  const secret = process.env.ENCRYPTION_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "local-rewrite-secret";
  return createHmac("sha256", secret).update(`${ownerId}:${jobId}:${expMs}`).digest("hex");
}

export function verifyRewriteContinuationToken(ownerId: string, jobId: string, expMs: number, sig: string): boolean {
  if (!Number.isFinite(expMs) || Date.now() > expMs || !sig) return false;
  const expected = signRewriteContinuationToken(ownerId, jobId, expMs);
  if (expected.length !== sig.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

export async function startEmailRewriteJob(input: {
  ownerId: string;
  scope: RewriteScope;
  selectedIds?: string[];
  retryFailedOnly?: boolean;
  instruction?: string;
}): Promise<{
  job: BackgroundJobRecord;
  workspace: EmailRewriteWorkspaceState;
  targetIds: string[];
  reused: boolean;
}> {
  const store = getStore();
  const snap = await store.loadOwnerSnapshot(input.ownerId);
  const kb = extractKnowledgeForRewrite(snap);
  const currentWs = (await store.loadWorkspace(input.ownerId)) ?? defaultEmptyWorkspace(input.ownerId);

  let targetIds: string[];
  if (input.retryFailedOnly) {
    targetIds = Object.values(currentWs.itemsByMessageId)
      .filter((it) => it.status === "failed" || it.status === "needs_attention" || it.status === "pending")
      .map((it) => it.messageId);
  } else {
    targetIds = filterReviewableMessageIds(snap.messages, input.scope, input.selectedIds ?? []);
  }

  if (targetIds.length === 0) {
    throw new Error(
      input.retryFailedOnly
        ? "There are no failed, pending, or flagged emails left to retry."
        : "No eligible emails match the selected scope.",
    );
  }

  const steps: BackgroundJobStep[] = [
    { key: "loading_kb", label: "Checking Knowledge Base and target emails", status: "done", weightSec: 1 },
    ...targetIds.map((msgId, idx) => {
      const msg = snap.messages.find((m) => m.id === msgId);
      const lead = msg ? snap.leads.find((l) => l.id === msg.lead_id) : undefined;
      return {
        key: `msg_${idx}`,
        label: `Lead ${idx + 1} of ${targetIds.length}: ${lead?.business ?? lead?.email ?? msgId}`,
        status: "pending" as const,
        weightSec: 6,
      };
    }),
    { key: "cross_patterns", label: "Summarizing cross-lead messaging patterns", status: "pending", weightSec: 2 },
  ];

  const { job, reused } = await createOrReuseBackgroundJob({
    ownerId: input.ownerId,
    jobType: "email_review_rewrite",
    steps,
    payload: {
      scope: input.scope,
      retryFailedOnly: Boolean(input.retryFailedOnly),
      targetCount: targetIds.length,
      targetIds,
      instruction: input.instruction ?? "",
    },
    staleAfterMs: REWRITE_JOB_STALL_MS,
  });

  if (!reused) {
    const nextItems = { ...currentWs.itemsByMessageId };
    const nowIso = new Date().toISOString();
    for (const msgId of targetIds) {
      const msg = snap.messages.find((m) => m.id === msgId);
      const lead = msg ? snap.leads.find((l) => l.id === msg.lead_id) : undefined;
      if (!msg) continue;
      const prev = nextItems[msgId];
      nextItems[msgId] = prev
        ? { ...prev, status: "pending", statusReason: undefined, updatedAt: nowIso }
        : {
            messageId: msg.id,
            leadId: msg.lead_id,
            campaignId: msg.campaign_id,
            business: lead?.business ?? lead?.email ?? "Prospect",
            leadEmail: lead?.email ?? null,
            kind: msg.kind,
            step: msg.step,
            originalSubject: msg.subject ?? "",
            originalBody: msg.body ?? "",
            rewrittenSubject: msg.subject ?? "",
            rewrittenBody: msg.body ?? "",
            subjectOptions: [],
            status: "pending",
            analysis: null,
            check: null,
            versions: [
              {
                versionId: "v_orig",
                createdAt: msg.created_at || nowIso,
                source: "original",
                subject: msg.subject ?? "",
                body: msg.body ?? "",
                status: "pending",
              },
            ],
            kbGapsNoted: kb.gaps.map((g) => g.label),
            updatedAt: nowIso,
          };
    }

    const updatedWs: EmailRewriteWorkspaceState = {
      ...currentWs,
      activeJobId: job.id,
      lastScope: input.scope,
      pausedForQuota: false,
      pausedMessage: null,
      kbSectionsUsed: kb.sectionsUsed,
      kbGaps: kb.gaps,
      itemsByMessageId: nextItems,
      updatedAt: nowIso,
    };
    await store.saveWorkspace(input.ownerId, updatedWs);
    return { job, workspace: updatedWs, targetIds, reused: false };
  }

  const reusedIds = Array.isArray(job.payload.targetIds)
    ? (job.payload.targetIds as string[])
    : targetIds;
  return { job, workspace: currentWs, targetIds: reusedIds, reused: true };
}

export async function runEmailRewriteJobPipeline(input: {
  ownerId: string;
  jobId: string;
  targetIds: string[];
  instruction?: string;
  continueOrigin?: string;
}): Promise<EmailRewriteWorkspaceState> {
  const startedMs = Date.now();
  const store = getStore();
  const heartbeat = setInterval(() => {
    void touchBackgroundJob(input.ownerId, input.jobId).catch(() => {});
  }, JOB_HEARTBEAT_MS);

  let workspace = (await store.loadWorkspace(input.ownerId)) ?? defaultEmptyWorkspace(input.ownerId);

  try {
    const snap = await store.loadOwnerSnapshot(input.ownerId);
    const kb = extractKnowledgeForRewrite(snap);
    const leadMap = new Map(snap.leads.map((l) => [l.id, l]));
    const msgMap = new Map(snap.messages.map((m) => [m.id, m]));

    for (let idx = 0; idx < input.targetIds.length; idx++) {
      const msgId = input.targetIds[idx];
      const existingStatus = workspace.itemsByMessageId[msgId]?.status;
      // Skip emails already completed in an earlier slice
      if (existingStatus === "rewritten" || existingStatus === "accepted" || existingStatus === "needs_attention") {
        continue;
      }

      // Serverless 60s safety handoff: if running via HTTP and >42s elapsed with more leads left, chain cleanly
      if (input.continueOrigin && Date.now() - startedMs > 42_000) {
        const remainingIds = input.targetIds.slice(idx);
        const expMs = Date.now() + 120_000;
        const sig = signRewriteContinuationToken(input.ownerId, input.jobId, expMs);
        await touchBackgroundJob(input.ownerId, input.jobId);
        void fetch(`${input.continueOrigin.replace(/\/$/, "")}/api/ai/review-rewrite/continue`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ownerId: input.ownerId,
            jobId: input.jobId,
            targetIds: remainingIds,
            instruction: input.instruction ?? "",
            expMs,
            sig,
          }),
        }).catch(() => {});
        return workspace;
      }

      const stepKey = `msg_${idx}`;
      const msg = msgMap.get(msgId);
      const lead = msg ? leadMap.get(msg.lead_id) : undefined;

      if (!msg || !lead) {
        const prev = workspace.itemsByMessageId[msgId];
        if (prev) {
          workspace.itemsByMessageId[msgId] = {
            ...prev,
            status: "failed",
            statusReason: !msg ? "Original email missing." : "Lead record missing.",
            updatedAt: new Date().toISOString(),
          };
          await store.saveWorkspace(input.ownerId, workspace);
        }
        await advanceBackgroundJobStep(input.ownerId, input.jobId, stepKey, "done", "Missing record flagged");
        continue;
      }

      await advanceBackgroundJobStep(
        input.ownerId,
        input.jobId,
        stepKey,
        "in_progress",
        `Analysing lead ${idx + 1} of ${input.targetIds.length}: ${lead.business ?? lead.email ?? "Prospect"}`,
      );

      try {
        // Mandatory micro-research before rewriting: never rewrite from a thin
        // record. Unreachable sites are marked limited_public_info instead of
        // letting the model invent website flaws.
        const enrichedLead = await ensureLeadMicroResearch(input.ownerId, lead);
        leadMap.set(lead.id, enrichedLead);
        const rewrittenItem = await rewriteAndSelfCheckOneMessage({
          ownerId: input.ownerId,
          message: msg,
          lead: enrichedLead,
          snap,
          kb,
          existingItem: workspace.itemsByMessageId[msgId],
          instruction: input.instruction,
          onProgressStep: async (detail) => {
            await advanceBackgroundJobStep(input.ownerId, input.jobId, stepKey, "in_progress", detail);
          },
        });

        workspace = {
          ...workspace,
          kbSectionsUsed: kb.sectionsUsed,
          kbGaps: kb.gaps,
          itemsByMessageId: {
            ...workspace.itemsByMessageId,
            [msgId]: rewrittenItem,
          },
          updatedAt: new Date().toISOString(),
        };
        await store.saveWorkspace(input.ownerId, workspace);
        await advanceBackgroundJobStep(
          input.ownerId,
          input.jobId,
          stepKey,
          "done",
          rewrittenItem.status === "rewritten"
            ? "Passed self-check"
            : `Flagged: ${rewrittenItem.statusReason ?? "Needs attention"}`,
        );
      } catch (err) {
        if (isQuotaOrRateLimitFailure(err)) {
          const completedCount = Object.values(workspace.itemsByMessageId).filter(
            (x) => x.status === "rewritten" || x.status === "accepted" || x.status === "needs_attention",
          ).length;
          const pauseMsg = `Paused safely after processing ${completedCount} email(s) because an AI provider quota/rate limit was hit. Your progress is saved — wait a moment or add your own API key in Settings -> Integrations, then click Retry failed / remaining.`;
          workspace = {
            ...workspace,
            pausedForQuota: true,
            pausedMessage: pauseMsg,
            updatedAt: new Date().toISOString(),
          };
          await store.saveWorkspace(input.ownerId, workspace);
          await failBackgroundJob(input.ownerId, input.jobId, pauseMsg, stepKey);
          return workspace;
        }

        const reason = err instanceof Error ? err.message : "Rewrite error";
        const prev = workspace.itemsByMessageId[msgId];
        if (prev) {
          workspace.itemsByMessageId[msgId] = {
            ...prev,
            status: "failed",
            statusReason: reason,
            updatedAt: new Date().toISOString(),
          };
          await store.saveWorkspace(input.ownerId, workspace);
        }
        await advanceBackgroundJobStep(input.ownerId, input.jobId, stepKey, "done", `Failed: ${reason}`);
      }
    }

    await advanceBackgroundJobStep(input.ownerId, input.jobId, "cross_patterns", "in_progress");
    const crossLeadSummary = await synthesizeCrossLeadPatterns({
      ownerId: input.ownerId,
      items: Object.values(workspace.itemsByMessageId),
    });

    workspace = {
      ...workspace,
      activeJobId: null,
      pausedForQuota: false,
      pausedMessage: null,
      crossLeadSummary,
      updatedAt: new Date().toISOString(),
    };
    await store.saveWorkspace(input.ownerId, workspace);

    const allItems = Object.values(workspace.itemsByMessageId);
    await completeBackgroundJob(input.ownerId, input.jobId, {
      rewritten: allItems.filter((x) => x.status === "rewritten").length,
      accepted: allItems.filter((x) => x.status === "accepted").length,
      needsAttention: allItems.filter((x) => x.status === "needs_attention").length,
      failed: allItems.filter((x) => x.status === "failed").length,
    });
    return workspace;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Email rewrite job failed.";
    await failBackgroundJob(input.ownerId, input.jobId, msg);
    return workspace;
  } finally {
    clearInterval(heartbeat);
  }
}

export async function applyRewriteItemAction(input: {
  ownerId: string;
  action:
    | "accept"
    | "accept_all_passed"
    | "edit"
    | "reject"
    | "regenerate"
    | "restore_version";
  messageId?: string;
  subject?: string;
  body?: string;
  instruction?: string;
  versionId?: string;
}): Promise<{ workspace: EmailRewriteWorkspaceState; updatedCount: number }> {
  const store = getStore();
  const [snap, wsRaw] = await Promise.all([
    store.loadOwnerSnapshot(input.ownerId),
    store.loadWorkspace(input.ownerId),
  ]);
  const workspace = wsRaw ?? defaultEmptyWorkspace(input.ownerId);
  const nowIso = new Date().toISOString();
  let updatedCount = 0;

  if (input.action === "accept_all_passed") {
    const nextItems = { ...workspace.itemsByMessageId };
    for (const [id, item] of Object.entries(nextItems)) {
      if (item.status !== "rewritten" || item.check?.passed === false) continue;
      // Strict owner check: verify message belongs to active ownerId snapshot
      const ownedMsg = snap.messages.find((m) => m.id === id);
      if (!ownedMsg) continue;
      const rationale = item.analysis?.chosenPattern.overallReason ?? ownedMsg.rationale;
      await store.updateMessageFields(input.ownerId, id, {
        subject: item.rewrittenSubject,
        body: item.rewrittenBody,
        angle: item.analysis?.chosenPattern.framework ?? ownedMsg.angle,
        rationale,
      });
      nextItems[id] = { ...item, status: "accepted", acceptedAt: nowIso, updatedAt: nowIso };
      updatedCount += 1;
    }
    const nextWs: EmailRewriteWorkspaceState = { ...workspace, itemsByMessageId: nextItems, updatedAt: nowIso };
    await store.saveWorkspace(input.ownerId, nextWs);
    return { workspace: nextWs, updatedCount };
  }

  const msgId = (input.messageId ?? "").trim();
  if (!msgId) throw new Error("messageId is required.");
  const ownedMsg = snap.messages.find((m) => m.id === msgId);
  if (!ownedMsg) throw new Error("Email not found for your account.");
  const item = workspace.itemsByMessageId[msgId];
  if (!item && input.action !== "regenerate") {
    throw new Error("No AI rewrite entry found for this email yet.");
  }

  if (input.action === "accept" && item) {
    if (item.check && !item.check.passed && item.status === "needs_attention") {
      throw new Error("This email failed self-checks. Edit or regenerate it so checks pass before accepting.");
    }
    const subj = stripUnresolvedPlaceholders((input.subject ?? item.rewrittenSubject).trim());
    const body = stripUnresolvedPlaceholders((input.body ?? item.rewrittenBody).trim());
    await store.updateMessageFields(input.ownerId, msgId, {
      subject: subj,
      body,
      angle: item.analysis?.chosenPattern.framework ?? ownedMsg.angle,
      rationale: item.analysis?.chosenPattern.overallReason ?? ownedMsg.rationale,
    });
    workspace.itemsByMessageId[msgId] = {
      ...item,
      rewrittenSubject: subj,
      rewrittenBody: body,
      status: "accepted",
      acceptedAt: nowIso,
      updatedAt: nowIso,
    };
    updatedCount = 1;
  } else if (input.action === "edit" && item) {
    const lead = snap.leads.find((l) => l.id === ownedMsg.lead_id);
    const nextSubj = stripUnresolvedPlaceholders((input.subject ?? item.rewrittenSubject).trim());
    const nextBody = stripUnresolvedPlaceholders((input.body ?? item.rewrittenBody).trim());
    const det = runDeterministicRewriteAudit({
      subject: nextSubj,
      body: nextBody,
      kind: ownedMsg.kind,
      leadBusiness: lead?.business ?? item.business,
      leadContactName: lead?.contact_name ?? null,
      senderName: snap.settings.sender_name || snap.userContext.variables.USER_NAME || "",
      senderCompany: snap.settings.sender_company || snap.userContext.variables.USER_COMPANY || "",
    });
    const nextStatus = det.passed ? "rewritten" : "needs_attention";
    const vEntry: RewriteVersionEntry = {
      versionId: `v_${Date.now().toString(36)}_edit`,
      createdAt: nowIso,
      source: "manual_edit",
      subject: nextSubj,
      body: nextBody,
      status: nextStatus,
      checkIssues: det.passed ? undefined : det.issues,
    };
    workspace.itemsByMessageId[msgId] = {
      ...item,
      rewrittenSubject: nextSubj,
      rewrittenBody: nextBody,
      status: nextStatus,
      statusReason: det.passed ? undefined : det.issues.join(" "),
      check: {
        passed: det.passed,
        attempts: item.check?.attempts ?? 1,
        issues: det.issues,
        criteria: {
          kbGroundedOnly: item.check?.criteria.kbGroundedOnly ?? true,
          matchesBrandVoice: item.check?.criteria.matchesBrandVoice ?? true,
          noPlaceholdersOrWrongNames: det.noPlaceholdersOrWrongNames,
          clearCtaAndLengthFit: det.clearCtaAndLengthFit,
          compliancePresent: det.compliancePresent,
        },
      },
      versions: [...item.versions, vEntry].slice(-25),
      updatedAt: nowIso,
    };
    updatedCount = 1;
  } else if (input.action === "reject" && item) {
    // Reject NEVER touches `messages` — keeps original untouched!
    workspace.itemsByMessageId[msgId] = {
      ...item,
      status: "rejected",
      rejectedAt: nowIso,
      updatedAt: nowIso,
    };
    updatedCount = 1;
  } else if (input.action === "restore_version" && item) {
    const chosen = item.versions.find((v) => v.versionId === input.versionId);
    if (!chosen) throw new Error("Version not found.");
    if (chosen.source === "original") {
      await store.updateMessageFields(input.ownerId, msgId, {
        subject: chosen.subject,
        body: chosen.body,
      });
      workspace.itemsByMessageId[msgId] = {
        ...item,
        rewrittenSubject: chosen.subject,
        rewrittenBody: chosen.body,
        status: "rejected",
        updatedAt: nowIso,
      };
    } else {
      workspace.itemsByMessageId[msgId] = {
        ...item,
        rewrittenSubject: chosen.subject,
        rewrittenBody: chosen.body,
        status: chosen.checkIssues?.length ? "needs_attention" : "rewritten",
        statusReason: chosen.checkIssues?.join(" "),
        updatedAt: nowIso,
      };
    }
    updatedCount = 1;
  } else if (input.action === "regenerate") {
    const lead = snap.leads.find((l) => l.id === ownedMsg.lead_id);
    if (!lead) throw new Error("Lead record not found.");
    const kb = extractKnowledgeForRewrite(snap);
    const updatedItem = await rewriteAndSelfCheckOneMessage({
      ownerId: input.ownerId,
      message: ownedMsg,
      lead,
      snap,
      kb,
      existingItem: item,
      instruction: input.instruction,
    });
    workspace.itemsByMessageId[msgId] = updatedItem;
    workspace.kbSectionsUsed = kb.sectionsUsed;
    workspace.kbGaps = kb.gaps;
    updatedCount = 1;
  }

  workspace.updatedAt = nowIso;
  await store.saveWorkspace(input.ownerId, workspace);
  return { workspace, updatedCount };
}

export async function getRewriteJobAndWorkspace(input: {
  ownerId: string;
  jobId?: string;
}): Promise<{ job: BackgroundJobRecord | null; workspace: EmailRewriteWorkspaceState }> {
  const store = getStore();
  const [wsRaw, rawJob] = await Promise.all([
    store.loadWorkspace(input.ownerId),
    input.jobId
      ? getBackgroundJobForOwner(input.ownerId, input.jobId)
      : getLatestBackgroundJobForOwner(input.ownerId, "email_review_rewrite"),
  ]);
  const job = rawJob ? await failStalledBackgroundJob(input.ownerId, rawJob, REWRITE_JOB_STALL_MS) : null;
  const workspace = wsRaw ?? defaultEmptyWorkspace(input.ownerId);
  return { job, workspace };
}
