import { randomBytes } from "node:crypto";
import { buildOrchestratedSystemPrompt, stripUnresolvedPlaceholders } from "./ai/orchestrator";
import { getActiveOwnerAiContext } from "./ai/context";
import { getRegionalComplianceGuidance } from "./compliance/regionalRules";
import { LLMGateway } from "./llm/gateway";
import {
  type ExecutedCampaignBlueprint,
  type ExecutedProspect,
  type GrowthAdvisorReport,
  type GrowthExecuteRunState,
  type GrowthExecuteStage,
  type GrowthMarketTrend,
  type GrowthPipelineDiagnosis,
  type GrowthPlayCard,
  type GrowthProfile,
  type GrowthRecommendation,
  type GrowthRunCandidate,
  type GrowthRunInspectedSite,
  type ImpactRating,
  type IntentSignal,
  type RecommendationCategory,
} from "./growth-advisor";
import type { PerformanceInsight } from "./intelligence";
import { checkMobilePageSpeed } from "./search/pagespeed";
import { findDeepContactsForProspect } from "./search/contactFinder";
import { runForensicWebsiteAudit } from "./search/forensicAudit";
import { validateContactableLead } from "./search/contactGate";
import { isDirectoryUrl } from "./search/siteInspector";
import { WebSearchService } from "./search/webSearch";
import { supabaseServer } from "./supabase-server";
import type { Settings } from "./types";

const MAX_STAGE_SEARCH_QUERIES = 4;
const MAX_STAGE_INSPECT_SITES = 10;

// Fast in-memory fallback run store (mirrors growth_execute_runs DB table)
const memoryRunStore = new Map<string, GrowthExecuteRunState>();

function cleanStr(value: unknown, max = 500): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function clampNum(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizeCategory(raw: unknown): RecommendationCategory {
  const v = cleanStr(raw, 40).toLowerCase();
  if (v === "location" || v === "locations" || v === "target_locations") return "location";
  if (v === "niche" || v === "audience" || v === "niche_audience") return "niche";
  if (v === "messaging" || v === "hooks" || v === "copy") return "messaging";
  if (v === "channels_timing" || v === "channels" || v === "timing") return "channels_timing";
  return "offer_strategy";
}

function normalizeImpact(raw: unknown): ImpactRating {
  const v = cleanStr(raw, 20).toLowerCase();
  if (v === "high" || v === "medium" || v === "low") return v;
  return "medium";
}

function extractDomain(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

async function saveRunState(state: GrowthExecuteRunState): Promise<void> {
  const next: GrowthExecuteRunState = { ...state, updatedAt: new Date().toISOString() };
  memoryRunStore.set(`${next.ownerId}:${next.runId}`, next);

  if (!supabaseServer) return;
  try {
    const { error } = await supabaseServer.from("growth_execute_runs").upsert(
      {
        id: next.runId,
        owner_id: next.ownerId,
        status: next.status,
        current_stage: next.currentStage,
        state_json: next,
        updated_at: next.updatedAt,
      } as never,
      { onConflict: "id" },
    );
    if (error) {
      await supabaseServer.from("knowledge").upsert(
        {
          id: `system_growth_run_${next.ownerId}_${next.runId}`,
          owner_id: next.ownerId,
          category: "system_growth_run",
          title: `Growth Execute Run ${next.runId}`,
          content: JSON.stringify(next),
          sort: 999,
          is_master: false,
          updated_at: next.updatedAt,
        } as never,
        { onConflict: "id" },
      );
    }
  } catch {
    /* non-blocking */
  }
}

export async function loadRunState(ownerId: string, runId: string): Promise<GrowthExecuteRunState | null> {
  const mem = memoryRunStore.get(`${ownerId}:${runId}`);
  if (mem) return mem;

  if (!supabaseServer) return null;
  try {
    const { data, error } = await supabaseServer
      .from("growth_execute_runs")
      .select("state_json")
      .eq("id", runId)
      .eq("owner_id", ownerId)
      .maybeSingle();
    if (!error && data) {
      const st = (data as { state_json?: GrowthExecuteRunState }).state_json ?? null;
      if (st) {
        memoryRunStore.set(`${ownerId}:${runId}`, st);
        return st;
      }
    }
    const { data: kRow } = await supabaseServer
      .from("knowledge")
      .select("content")
      .eq("id", `system_growth_run_${ownerId}_${runId}`)
      .eq("owner_id", ownerId)
      .maybeSingle();
    const raw = (kRow as { content?: string } | null)?.content;
    if (raw) {
      const parsed = JSON.parse(raw) as GrowthExecuteRunState;
      memoryRunStore.set(`${ownerId}:${runId}`, parsed);
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function clearGrowthRunStoreForTests(): void {
  memoryRunStore.clear();
}

// ---------------------------------------------------------------------------
// Growth Advisor Report Generator (Pre-fetched $0 Search + Balanced Seat)
// ---------------------------------------------------------------------------

async function loadLiveAccountMetrics(
  ownerId: string | undefined,
  fallbackSummary: Record<string, unknown>,
): Promise<{
  summary: Record<string, unknown>;
  untouchedNewLeads: number;
  totalLeads: number;
}> {
  if (!ownerId || ownerId === "anonymous" || !supabaseServer) {
    const untouched = Number(fallbackSummary.untouchedNewLeads ?? fallbackSummary.newLeads ?? 0) || 0;
    const total = Number(fallbackSummary.totalLeads ?? 0) || 0;
    return { summary: fallbackSummary, untouchedNewLeads: untouched, totalLeads: total };
  }
  try {
    const [leadsRes, campsRes, msgsRes, repliesRes] = await Promise.all([
      supabaseServer.from("leads").select("status,score").eq("owner_id", ownerId).limit(500),
      supabaseServer.from("campaigns").select("status").eq("owner_id", ownerId).limit(100),
      supabaseServer.from("messages").select("status,kind").eq("owner_id", ownerId).limit(500),
      supabaseServer.from("replies").select("classification").eq("owner_id", ownerId).limit(200),
    ]);
    const leads = (leadsRes.data ?? []) as { status?: string; score?: number | null }[];
    const camps = (campsRes.data ?? []) as { status?: string }[];
    const msgs = (msgsRes.data ?? []) as { status?: string }[];
    const replies = (repliesRes.data ?? []) as { classification?: string }[];

    const untouchedNewLeads = leads.filter((l) => l.status === "new" || l.status === "queued_research").length;
    const qualifiedLeads = leads.filter((l) => l.status === "qualified").length;
    const sentMessages = msgs.filter((m) => m.status === "sent").length;
    const replyRatePct = sentMessages > 0 ? Math.round((replies.length / sentMessages) * 1000) / 10 : 0;

    return {
      summary: {
        ...fallbackSummary,
        liveWorkspaceMetrics: {
          totalLeads: leads.length,
          untouchedNewLeads,
          qualifiedAwaitingDraft: qualifiedLeads,
          campaignsTotal: camps.length,
          sentMessages,
          repliesCount: replies.length,
          replyRatePct,
        },
      },
      untouchedNewLeads,
      totalLeads: leads.length,
    };
  } catch {
    return { summary: fallbackSummary, untouchedNewLeads: 0, totalLeads: 0 };
  }
}

export async function generateGrowthAdvisorReportServer(input: {
  ownerId?: string;
  profile: GrowthProfile;
  knowledgeDigest: string;
  settings: Settings;
  metricsSummary: Record<string, unknown>;
  analyticsInsight?: PerformanceInsight | null;
  fingerprint: string;
  model?: string;
}): Promise<GrowthAdvisorReport> {
  const today = new Date().toISOString().slice(0, 10);
  const hasAnalytics = Boolean(input.analyticsInsight);
  const year = today.slice(0, 4);

  const primaryIndustry =
    input.profile.industry || input.profile.targetIndustries?.[0] || "B2B services";
  const primaryLocation = input.profile.location || input.settings.physical_address || "";
  const offerFocus = (input.profile.offer || input.profile.whatYouSell || primaryIndustry).slice(0, 80);
  const queryA = `${primaryIndustry} market trends buyer pain points ${year}`;
  const queryB = primaryLocation
    ? `${primaryIndustry} businesses in ${primaryLocation}`
    : `${input.profile.idealCustomer || primaryIndustry} buying trends ${year}`;
  const queryC = `${offerFocus} client acquisition objections ${year}`;

  const [webA, webB, webC, accountSnapshot] = await Promise.all([
    WebSearchService.search(queryA, { maxResults: 4 }).catch(() => null),
    WebSearchService.search(queryB, { maxResults: 4, locationHint: primaryLocation }).catch(() => null),
    WebSearchService.search(queryC, { maxResults: 3 }).catch(() => null),
    loadLiveAccountMetrics(input.ownerId, input.metricsSummary),
  ]);

  const combinedSources = [...(webA?.results ?? []), ...(webB?.results ?? []), ...(webC?.results ?? [])].slice(0, 12);
  const groundingUrls = combinedSources.map((s) => ({ uri: s.url, title: s.title || s.url }));
  const compliance = getRegionalComplianceGuidance({
    targetLocation: primaryLocation,
    senderLocation: input.settings.physical_address,
    physicalAddress: input.settings.physical_address,
  });

  const liveSearchContext =
    combinedSources.length > 0
      ? `\nVERIFIED LIVE MARKET SOURCES (cite ONLY exact URLs from this list in sourceUrl — never invent URLs):\n${combinedSources
          .map((s, i) => `[${i + 1}] ${s.title} (${s.url})\n${s.snippet}`)
          .join("\n\n")}`
      : "\nNote: No live external snippets returned; ground every recommendation strictly in the user's business profile, metrics, and regional compliance rules without fabricating URLs.";

  const taskInstructions = `You are a Principal B2B Growth Advisor and Market Intelligence Strategist.
Today's date is ${today}.
Using Modules 1-3 strictly, the VERIFIED LIVE MARKET SOURCES below, and Regional Compliance (${compliance.frameworkName}), deliver actionable growth recommendations tailored to the Active User's business profile, price point, location, and campaign metrics.

MANDATORY RULES:
1. Ground recommendations in supplied user context + VERIFIED LIVE MARKET SOURCES (copy exact verifiable sourceUrl + sourceTitle; if none applies, leave sourceUrl as ""). Never fabricate URLs.
2. Cover ALL 5 recommendation categories: location, niche, messaging, channels_timing, offer_strategy.
3. Respect compliance rules for ${compliance.region} (${compliance.frameworkName}): ${compliance.requirements.slice(0, 2).join("; ")}.
4. Rate each recommendation with impact ("high" | "medium" | "low"), confidence (0-100), and priorityOrder.
5. ${
    hasAnalytics
      ? "Populate postAnalysisInsights summarizing what worked, what didn't work in the measured numbers, and concrete next moves, flagging relevant recommendations with basedOnAnalytics: true."
      : "If past campaigns exist in metricsSummary, factor them in honestly. Do not invent metrics."
  }

Return ONLY valid JSON:
{
  "overallStrategy": "string",
  "marketPulse": [
    { "trend": "Concrete 2026 shift in buyer behavior or demand", "whyNow": "Why this creates immediate urgency for the user's offer", "sourceUrl": "https://...", "sourceTitle": "Source title" }
  ],
  "pipelineDiagnosis": {
    "summary": "Candid 2-sentence diagnosis of pipeline health & positioning from real numbers",
    "strengths": ["What currently stands out in offer/positioning"],
    "bottlenecks": ["Honest bottleneck or positioning gap"],
    "untouchedLeadsCount": ${accountSnapshot.untouchedNewLeads},
    "quickWinAction": "Immediate action on existing untouched/qualified leads or narrowest segment"
  },
  "topPlays": [
    {
      "rank": 1,
      "title": "Play #1 headline",
      "microNiche": "Specific sub-niche",
      "geoFocus": "Specific city/region",
      "whyNow": "Timely buyer trigger or market proof",
      "wedgeOffer": "Low-friction entry wedge matching Knowledge Base",
      "openingHook": "Concrete personalized first-line angle",
      "channelSequence": "Email -> LinkedIn -> Warm Loom/Phone cadence",
      "referralLoop": "Post-delivery referral ask",
      "realisticWeeklyTarget": "e.g. 25 prospects -> 4-6 replies -> 1-2 discovery calls",
      "linkedRecommendationId": "rec_1"
    }
  ],
  "recommendations": [
    {
      "id": "rec_1",
      "category": "location | niche | messaging | channels_timing | offer_strategy",
      "title": "Actionable recommendation headline",
      "summary": "Specific recommendation tailored to their offer and price range",
      "reason": "Short explanation of why this works right now",
      "evidence": "Specific market signal, benchmark, or profile observation",
      "sourceUrl": "https://...",
      "sourceTitle": "Source title",
      "impact": "high | medium | low",
      "confidence": 85,
      "priorityOrder": 1,
      "basedOnAnalytics": false,
      "suggestedAction": {
        "targetIndustry": "Specific target niche",
        "targetLocation": "Specific city/region",
        "targetAudience": "Decision-maker role & company profile",
        "angle": "Core outreach pitch angle",
        "hook": "Opening personalized hook",
        "subjectLine": "Compelling 2-5 word lowercase email subject line",
        "offer": "Specific CTA / low-friction lead magnet",
        "channel": "Primary & secondary channels",
        "timing": "Best days & time window",
        "goal": "Measurable campaign outcome"
      }
    }
  ],
  "postAnalysisInsights": {
    "whatWorked": ["string"],
    "whatDidnt": ["string"],
    "nextMoves": ["string"]
  }
}`;

  const orchestrated = await buildOrchestratedSystemPrompt({
    workflow: "growth_advisor",
    ownerId: input.ownerId ?? null,
    settings: input.settings,
    knowledgeDigest: input.knowledgeDigest,
    taskInstructions,
  });

  const user = `USER BUSINESS PROFILE:
- Who they are: ${input.profile.whoYouAre || input.settings.sender_company || input.settings.sender_name || "Not specified"} (${input.profile.primaryRole || input.settings.sender_role || "Founder/Operator"})
- Business stage & team: ${input.profile.businessStage || "Not specified"} · Team: ${input.profile.teamStructure || "Not specified"}
- Business model & pricing: ${input.profile.businessModel || "Not specified"} · Pricing structure: ${input.profile.pricingStructure || "Not specified"} · Avg deal: ${input.profile.averageDealValue ? `$${input.profile.averageDealValue}` : input.profile.priceRange || "Not specified"}
- What they sell / deliverables: ${input.profile.whatYouSell || "See knowledge base"} ${input.profile.deliverablesSummary ? `(${input.profile.deliverablesSummary})` : ""}
- Industry: ${input.profile.industry || "Not specified"}
- Core Offer & CTA style: ${input.profile.offer || "Not specified"} · Preferred CTA: ${input.profile.offerCtaStyle || "Not specified"}
- Price Range: ${input.profile.priceRange || "Not specified"}
- Market reach & locations: ${input.profile.marketScope?.join(", ") || "Not specified"} · Target/Base Location: ${primaryLocation || "Not specified"} · Languages: ${input.profile.outreachLanguages?.join(", ") || "English"}
- Ideal Customer Profile: ${input.profile.idealCustomer || "Not specified"} · Target industries: ${input.profile.targetIndustries?.join(", ") || "Any"} · Decision-maker roles: ${input.profile.targetRoles?.join(", ") || "Decision makers"} · Company size: ${input.profile.targetCompanySize || "Any"}
- Buying triggers: ${input.profile.buyingTriggers?.join(", ") || "None specified"}
- Sales cycle & preferred channels: ${input.profile.salesCycleLength || "Not specified"} · Channels: ${input.profile.preferredChannels?.join(", ") || "Cold Email"}
- Primary goal & capacity: ${input.profile.primaryGoal || "Qualified leads"} · Target leads/mo: ${input.profile.monthlyTargetLeads ?? "Flexible"} · Weekly outreach capacity: ${input.profile.weeklyOutreachCapacity ?? "Flexible"}
- Proof assets & exclusions: ${input.profile.proofAssets?.join(", ") || "Standard"} · Exclusions (DO NOT target): ${input.profile.exclusions || "None"} · Voice: ${input.profile.tonePreference?.join(", ") || "Consultative"}
- Active Regional Compliance (${compliance.frameworkName}): ${compliance.requirements.join(" | ")}

PAST CAMPAIGN & LIVE WORKSPACE PIPELINE METRICS:
${JSON.stringify(accountSnapshot.summary, null, 2).slice(0, 3500)}

${
  input.analyticsInsight
    ? `RECENT AI PERFORMANCE REVIEW:\nHeadline: ${input.analyticsInsight.headline}\nObservations: ${input.analyticsInsight.observations.join(" | ")}\nRecommendations: ${input.analyticsInsight.recommendations.map((r) => `${r.title}: ${r.detail}`).join(" | ")}`
    : ""
}
${liveSearchContext}

Generate marketPulse (3 trends with verified sources), candid pipelineDiagnosis (flagging ${accountSnapshot.untouchedNewLeads} untouched leads if > 0), topPlays (Top 3 Ranked Growth Plays linked to rec_1..rec_3), and 6 recommendations covering location, niche, messaging, channels_timing, and offer_strategy.`;

  void input.model;
  const { data } = await LLMGateway.completeJSON<{
    overallStrategy?: string;
    marketPulse?: Record<string, unknown>[];
    pipelineDiagnosis?: Record<string, unknown>;
    topPlays?: Record<string, unknown>[];
    recommendations?: Record<string, unknown>[];
    postAnalysisInsights?: {
      whatWorked?: unknown[];
      whatDidnt?: unknown[];
      nextMoves?: unknown[];
    };
  }>({
    ownerId: input.ownerId || getActiveOwnerAiContext()?.ownerId || "anonymous",
    taskType: "balanced",
    feature: "growth_advisor",
    systemPrompt: orchestrated.system,
    messages: [{ role: "user", content: user }],
    maxTokens: 2800,
  });

  const allowedSourceUrls = new Set(groundingUrls.map((g) => g.uri.toLowerCase()));
  const recs: GrowthRecommendation[] = (Array.isArray(data.recommendations) ? data.recommendations : [])
    .map((raw, idx) => {
      const actionRaw = (raw.suggestedAction && typeof raw.suggestedAction === "object"
        ? raw.suggestedAction
        : {}) as Record<string, unknown>;
      const rawUrl = cleanStr(raw.sourceUrl, 400);
      const safeUrl =
        rawUrl && allowedSourceUrls.has(rawUrl.toLowerCase())
          ? rawUrl
          : groundingUrls[idx % Math.max(1, groundingUrls.length)]?.uri ?? "";
      const fallbackTitle = groundingUrls[idx % Math.max(1, groundingUrls.length)]?.title ?? "Market intelligence";

      return {
        id: cleanStr(raw.id, 60) || `rec_${Date.now()}_${idx + 1}`,
        category: normalizeCategory(raw.category),
        title: cleanStr(raw.title, 180) || "Growth Recommendation",
        summary: cleanStr(raw.summary, 600),
        reason: cleanStr(raw.reason, 450),
        evidence: cleanStr(raw.evidence, 450),
        sourceUrl: safeUrl,
        sourceTitle: cleanStr(raw.sourceTitle, 140) || fallbackTitle,
        impact: normalizeImpact(raw.impact),
        confidence: clampNum(raw.confidence, 10, 99, 75),
        priorityOrder: clampNum(raw.priorityOrder, 1, 20, idx + 1),
        basedOnAnalytics: Boolean(raw.basedOnAnalytics),
        suggestedAction: {
          targetIndustry: cleanStr(actionRaw.targetIndustry, 160) || primaryIndustry,
          targetLocation: cleanStr(actionRaw.targetLocation, 160) || primaryLocation || "United States",
          targetAudience: cleanStr(actionRaw.targetAudience, 240) || input.profile.idealCustomer || "Decision makers",
          angle: cleanStr(actionRaw.angle, 300),
          hook: cleanStr(actionRaw.hook, 300),
          subjectLine: cleanStr(actionRaw.subjectLine, 160),
          offer: cleanStr(actionRaw.offer, 300) || input.profile.offer,
          channel: cleanStr(actionRaw.channel, 120) || "Cold Email",
          timing: cleanStr(actionRaw.timing, 140) || "Tue–Thu, 09:00–11:30 local time",
          goal: cleanStr(actionRaw.goal, 200) || "Generate qualified discovery conversations",
        },
      };
    })
    .filter((r) => r.title && r.summary)
    .sort((a, b) => a.priorityOrder - b.priorityOrder);

  const now = new Date();
  const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const postInsights =
    hasAnalytics && data.postAnalysisInsights
      ? {
          whatWorked: Array.isArray(data.postAnalysisInsights.whatWorked)
            ? data.postAnalysisInsights.whatWorked.map((x) => cleanStr(x, 260)).filter(Boolean)
            : [],
          whatDidnt: Array.isArray(data.postAnalysisInsights.whatDidnt)
            ? data.postAnalysisInsights.whatDidnt.map((x) => cleanStr(x, 260)).filter(Boolean)
            : [],
          nextMoves: Array.isArray(data.postAnalysisInsights.nextMoves)
            ? data.postAnalysisInsights.nextMoves.map((x) => cleanStr(x, 260)).filter(Boolean)
            : [],
        }
      : undefined;

  const marketPulse: GrowthMarketTrend[] = (Array.isArray(data.marketPulse) ? data.marketPulse : [])
    .slice(0, 4)
    .map((m, idx) => {
      const rawUrl = cleanStr(m.sourceUrl, 400);
      const safeUrl =
        rawUrl && allowedSourceUrls.has(rawUrl.toLowerCase())
          ? rawUrl
          : groundingUrls[idx % Math.max(1, groundingUrls.length)]?.uri ?? "";
      return {
        trend: cleanStr(m.trend, 220),
        whyNow: cleanStr(m.whyNow, 300),
        sourceUrl: safeUrl,
        sourceTitle: cleanStr(m.sourceTitle, 140) || groundingUrls[idx]?.title || "Market signal",
      };
    })
    .filter((m) => Boolean(m.trend));

  const diagRaw = data.pipelineDiagnosis && typeof data.pipelineDiagnosis === "object" ? data.pipelineDiagnosis : null;
  const pipelineDiagnosis: GrowthPipelineDiagnosis | undefined = diagRaw
    ? {
        summary: cleanStr(diagRaw.summary, 420),
        strengths: Array.isArray(diagRaw.strengths) ? diagRaw.strengths.map((x) => cleanStr(x, 200)).filter(Boolean) : [],
        bottlenecks: Array.isArray(diagRaw.bottlenecks) ? diagRaw.bottlenecks.map((x) => cleanStr(x, 200)).filter(Boolean) : [],
        untouchedLeadsCount: accountSnapshot.untouchedNewLeads,
        quickWinAction: cleanStr(diagRaw.quickWinAction, 260),
      }
    : undefined;

  const topPlays: GrowthPlayCard[] = (Array.isArray(data.topPlays) ? data.topPlays : [])
    .slice(0, 3)
    .map((p, idx) => ({
      rank: clampNum(p.rank, 1, 3, idx + 1),
      title: cleanStr(p.title, 160),
      microNiche: cleanStr(p.microNiche, 120),
      geoFocus: cleanStr(p.geoFocus, 120) || primaryLocation || "Target region",
      whyNow: cleanStr(p.whyNow, 260),
      wedgeOffer: cleanStr(p.wedgeOffer, 220) || input.profile.offer,
      openingHook: cleanStr(p.openingHook, 220),
      channelSequence: cleanStr(p.channelSequence, 180) || "Cold Email + LinkedIn",
      referralLoop: cleanStr(p.referralLoop, 200),
      realisticWeeklyTarget: cleanStr(p.realisticWeeklyTarget, 140),
      linkedRecommendationId: cleanStr(p.linkedRecommendationId, 60) || recs[idx]?.id,
    }))
    .filter((p) => Boolean(p.title));

  return {
    overallStrategy:
      cleanStr(data.overallStrategy, 900) ||
      "Prioritize high-intent decision makers in verified target segments using evidence-backed messaging.",
    profileFingerprint: input.fingerprint,
    generatedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    sources: groundingUrls.slice(0, 12),
    recommendations: recs,
    postAnalysisInsights: postInsights,
    ...(marketPulse.length ? { marketPulse } : {}),
    ...(pipelineDiagnosis?.summary ? { pipelineDiagnosis } : {}),
    ...(topPlays.length ? { topPlays } : {}),
  };
}

// ---------------------------------------------------------------------------
// Phase 2: 4-Stage Checkpointed Zero-Timeout Growth Execute Pipeline
// ---------------------------------------------------------------------------

/** Stage 1: Offer Fit, Deterministic Regional Compliance & Search Query Strategy */
export async function executeGrowthStageStrategy(input: {
  runId?: string;
  ownerId: string;
  recommendation?: GrowthRecommendation | null;
  overallStrategy?: string;
  profile: GrowthProfile;
  knowledgeDigest: string;
  settings: Settings;
}): Promise<{ runId: string; state: GrowthExecuteRunState; summary: string }> {
  const runId = input.runId?.trim() || `grun_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
  const rec = input.recommendation;

  const targetLocation =
    rec?.suggestedAction.targetLocation || input.profile.location || input.settings.physical_address || "";
  const targetIndustry = rec?.suggestedAction.targetIndustry || input.profile.industry || "B2B Services";
  const compliance = getRegionalComplianceGuidance({
    targetLocation,
    senderLocation: input.settings.physical_address,
    physicalAddress: input.settings.physical_address,
  });

  const optOutDirective =
    input.settings.include_opt_out_footer === true
      ? "include a brief plain opt-out line at the bottom"
      : "do NOT add a generic unsubscribe or 'rather not hear' footer unless required by campaign rules";

  const taskInstructions = `Execute Growth Advisor STAGE 1 (Offer Fit, Compliance & Campaign Search Strategy).
Design the campaign plan AND produce 3 to 4 crisp public web search queries that locate real operating businesses/organizations needing the user's offer.

Return ONLY valid JSON:
{
  "offerFitDiagnosis": "2-sentence diagnosis of how user offer solves target segment's immediate pain",
  "campaignName": "short specific campaign name",
  "targetAudience": "decision-maker roles and organization profile",
  "targetLocation": "city/region",
  "targetIndustry": "niche/industry",
  "messagingAngle": "core outreach angle",
  "hook": "1-sentence observation pattern to check on live prospect websites",
  "subjectLine": "2-5 word lowercase email subject line",
  "sampleEmailBody": "short 50-100 word plain-text sample in the user's exact Knowledge-Brain voice (${optOutDirective})",
  "channel": "Cold Email",
  "schedule": { "sendDays": "mon,tue,wed,thu,fri", "windowStart": 9, "windowEnd": 17, "followupDays": [3, 7], "dailyLimit": 25 },
  "goal": "measurable outcome",
  "searchQueries": ["3-4 concise web queries e.g. dental clinics in Austin", "..."]
}`;

  const orchestrated = await buildOrchestratedSystemPrompt({
    workflow: "growth_advisor",
    ownerId: input.ownerId,
    settings: input.settings,
    knowledgeDigest: input.knowledgeDigest,
    taskInstructions,
  });

  const user = `USER PROFILE:
Who: ${input.profile.whoYouAre || input.settings.sender_company || input.settings.sender_name} (${input.settings.sender_role || "Founder"})
What They Sell: ${input.profile.whatYouSell || "See Knowledge Base"}
Offer: ${input.profile.offer || "See Knowledge Base"}
Price Range: ${input.profile.priceRange || "B2B"}
Target Industries: ${targetIndustry}
Target Location: ${targetLocation || "United States"}
Ideal Customer: ${input.profile.idealCustomer || rec?.suggestedAction.targetAudience || "Decision makers"}
Exclusions: ${input.profile.exclusions || "None"}

RECOMMENDATION / STRATEGY:
Title: ${rec?.title || "Overall Growth Strategy"}
Summary: ${rec?.summary || input.overallStrategy || "Build high-intent campaign"}
Suggested Angle: ${rec?.suggestedAction.angle || ""}
Regional Compliance (${compliance.frameworkName}): ${compliance.requirements.join("; ")}`;

  const { data } = await LLMGateway.completeJSON<{
    offerFitDiagnosis?: string;
    campaignName?: string;
    targetAudience?: string;
    targetLocation?: string;
    targetIndustry?: string;
    messagingAngle?: string;
    hook?: string;
    subjectLine?: string;
    sampleEmailBody?: string;
    channel?: string;
    schedule?: {
      sendDays?: string;
      windowStart?: number;
      windowEnd?: number;
      followupDays?: number[];
      dailyLimit?: number;
    };
    goal?: string;
    searchQueries?: unknown[];
  }>({
    ownerId: input.ownerId,
    taskType: "balanced",
    feature: "growth_execute_strategy",
    systemPrompt: orchestrated.system,
    messages: [{ role: "user", content: user }],
    maxTokens: 1800,
  });

  const defaultQuery = `${targetIndustry}${targetLocation ? ` in ${targetLocation}` : ""}`.trim();
  const queries = (Array.isArray(data.searchQueries) ? data.searchQueries : [])
    .map((q) => cleanStr(q, 140))
    .filter(Boolean)
    .slice(0, MAX_STAGE_SEARCH_QUERIES);
  if (queries.length === 0 && defaultQuery) {
    queries.push(defaultQuery);
  }

  const state: GrowthExecuteRunState = {
    runId,
    ownerId: input.ownerId,
    status: "in_progress",
    currentStage: "discover",
    completedStages: ["strategy"],
    recommendationTitle: rec?.title || "Growth Strategy Campaign",
    strategy: {
      offerFitDiagnosis: cleanStr(data.offerFitDiagnosis, 400) || "Aligned with active offer & ICP.",
      campaignName:
        cleanStr(data.campaignName, 160) ||
        (rec ? `${rec.title.slice(0, 55)} Campaign` : "Growth Priority Campaign"),
      targetAudience: cleanStr(data.targetAudience, 240) || rec?.suggestedAction.targetAudience || input.profile.idealCustomer,
      targetLocation: cleanStr(data.targetLocation, 160) || targetLocation || "Target Region",
      targetIndustry: cleanStr(data.targetIndustry, 140) || targetIndustry,
      messagingAngle: cleanStr(data.messagingAngle, 320) || rec?.suggestedAction.angle || "",
      hook: cleanStr(data.hook, 260) || rec?.suggestedAction.hook || "",
      subjectLine: cleanStr(data.subjectLine, 140) || rec?.suggestedAction.subjectLine || "Quick question",
      sampleEmailBody: stripUnresolvedPlaceholders(cleanStr(data.sampleEmailBody, 2500)),
      channel: cleanStr(data.channel, 80) || rec?.suggestedAction.channel || "Cold Email",
      schedule: {
        sendDays: cleanStr(data.schedule?.sendDays, 40) || input.settings.send_days || "mon,tue,wed,thu,fri",
        windowStart: clampNum(data.schedule?.windowStart, 0, 23, input.settings.send_window_start || 9),
        windowEnd: clampNum(data.schedule?.windowEnd, 1, 23, input.settings.send_window_end || 17),
        followupDays: Array.isArray(data.schedule?.followupDays)
          ? data.schedule!.followupDays.map((d) => clampNum(d, 1, 30, 3)).slice(0, 5)
          : [3, 7],
        dailyLimit: clampNum(data.schedule?.dailyLimit, 1, 100, input.settings.daily_limit || 25),
      },
      goal: cleanStr(data.goal, 220) || rec?.suggestedAction.goal || "Generate qualified conversations",
      complianceChecklist: [
        `${compliance.frameworkName} (${compliance.region})`,
        ...compliance.requirements,
      ],
      complianceFramework: compliance.frameworkName,
      searchQueries: queries,
    },
    updatedAt: new Date().toISOString(),
  };

  await saveRunState(state);
  return {
    runId,
    state,
    summary: `Strategy & ${compliance.frameworkName} checks ready · ${queries.length} live search queries prepared`,
  };
}

/** Stage 2: Execute Search Cascade (Hard Cap 4 Queries) + Deduplicate Against Existing Leads */
export async function executeGrowthStageDiscover(input: {
  runId: string;
  ownerId: string;
  existingEmails?: string[];
  existingWebsites?: string[];
}): Promise<{ runId: string; state: GrowthExecuteRunState; summary: string }> {
  const existingState = await loadRunState(input.ownerId, input.runId);
  if (!existingState?.strategy) {
    throw new Error("Stage 1 strategy state not found for this run. Start from Stage 1.");
  }

  const queries = existingState.strategy.searchQueries.slice(0, MAX_STAGE_SEARCH_QUERIES);
  const responses = await Promise.all(
    queries.map((q) =>
      WebSearchService.search(q, {
        maxResults: 8,
        locationHint: existingState.strategy!.targetLocation,
        nicheHint: existingState.strategy!.targetIndustry,
      }).catch(() => null),
    ),
  );

  const existingEmailSet = new Set((input.existingEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean));
  const existingDomainSet = new Set(
    (input.existingWebsites ?? []).map((w) => extractDomain(w)).filter(Boolean),
  );

  const candidates: GrowthRunCandidate[] = [];
  const seenDomains = new Set<string>();
  const providersUsed = new Set<string>();
  let totalRaw = 0;
  let duplicatesRemoved = 0;

  for (const res of responses) {
    if (!res) continue;
    for (const p of res.providersSucceeded) providersUsed.add(p);

    for (const r of res.results) {
      totalRaw += 1;
      if (r.email && existingEmailSet.has(r.email.toLowerCase())) {
        duplicatesRemoved += 1;
        continue;
      }
      const dom = r.domain || extractDomain(r.url);
      if (dom && existingDomainSet.has(dom)) {
        duplicatesRemoved += 1;
        continue;
      }
      // Filter out aggregator directory links & agency portfolio showcase pages
      if (isDirectoryUrl(r.url) && r.sourceProvider !== "osm") continue;
      if (/\/(?:portfolio|case-studies?|our-work|work\/)/i.test(r.url)) continue;
      if (dom && seenDomains.has(dom)) continue;
      if (dom) seenDomains.add(dom);

      candidates.push({
        business: r.businessName || r.title.split(/[|\-–—]/)[0].trim() || dom || "Unknown Business",
        website: isDirectoryUrl(r.url) ? "" : r.url,
        domain: dom,
        sourceUrl: r.url,
        snippet: r.snippet,
        address: r.address,
        phone: r.phone,
        email: r.email,
        sourceProvider: r.sourceProvider,
      });

      if (candidates.length >= MAX_STAGE_INSPECT_SITES) break;
    }
    if (candidates.length >= MAX_STAGE_INSPECT_SITES) break;
  }

  const nextState: GrowthExecuteRunState = {
    ...existingState,
    currentStage: "inspect",
    completedStages: Array.from(new Set([...existingState.completedStages, "discover"])) as GrowthExecuteStage[],
    discovered: {
      candidates,
      totalFound: totalRaw,
      duplicatesRemoved,
      providersUsed: Array.from(providersUsed),
    },
    updatedAt: new Date().toISOString(),
  };

  await saveRunState(nextState);
  return {
    runId: input.runId,
    state: nextState,
    summary: `Found ${candidates.length} unique prospect candidates (${duplicatesRemoved} duplicates skipped)`,
  };
}

/** Stage 3: $0 Deep Multi-Page Contact Extraction + DNS MX Email Guard */
export async function executeGrowthStageInspect(input: {
  runId: string;
  ownerId: string;
  checkPageSpeed?: boolean;
}): Promise<{ runId: string; state: GrowthExecuteRunState; summary: string }> {
  const existingState = await loadRunState(input.ownerId, input.runId);
  if (!existingState?.discovered) {
    throw new Error("Stage 2 discovery results not found for this run.");
  }

  const candidates = existingState.discovered.candidates.slice(0, MAX_STAGE_INSPECT_SITES);
  const targetLocation = existingState.strategy?.targetLocation || "";

  const inspectOne = async (c: GrowthRunCandidate, idx: number): Promise<GrowthRunInspectedSite> => {
    const [deep, forensic] = await Promise.all([
      findDeepContactsForProspect({
        business: c.business,
        website: c.website || undefined,
        location: c.address || targetLocation,
        osmPhone: c.phone,
        osmEmail: c.email,
        osmAddress: c.address,
        snippet: c.snippet,
        timeoutMs: 5_000,
        allowTargetedSearch: true,
      }),
      c.website && idx < 4
        ? runForensicWebsiteAudit(c.website, {
            ownerId: input.ownerId,
            runVision: Boolean(input.checkPageSpeed && idx < 2),
            checkLinks: true,
            timeoutMs: 6_000,
          }).catch(() => null)
        : Promise.resolve(null),
    ]);
    const site = deep.inspectedSite;
    let mobileScore: number | null = forensic?.lighthouse?.mobileScore ?? null;
    if (mobileScore === null && input.checkPageSpeed && site?.reachable && idx < 3) {
      const ps = await checkMobilePageSpeed(site.finalUrl, { timeoutMs: 5_000 }).catch(() => null);
      mobileScore = ps?.mobileScore ?? null;
    }

    const combinedIssues = Array.from(
      new Set([
        ...(forensic?.auditEvidence.map((e) => `${e.issue} (${e.proof})`) ?? []),
        ...deep.verifiedSiteIssues,
      ]),
    ).slice(0, 4);

    return {
      business: c.business,
      url: c.website || c.sourceUrl,
      finalUrl: deep.website || c.website || c.sourceUrl,
      reachable: site?.reachable ?? false,
      httpStatus: site?.httpStatus ?? 0,
      isHttps: site?.isHttps ?? (c.website || "").startsWith("https://"),
      hasViewport: site?.hasViewport ?? false,
      hasContactForm: site?.hasContactForm ?? false,
      platform: site?.platform ?? null,
      title: site?.title || c.business,
      h1: site?.h1 || "",
      statusHints: site?.statusHints ?? [],
      verifiedEmails: deep.emails,
      mxVerified: deep.mxVerified,
      emailType: deep.emailType,
      verifiedPhones: deep.phones,
      socialLinks: deep.socials,
      decisionMakers: deep.decisionMakers,
      location: deep.location || c.address || targetLocation,
      contactSourceUrls: deep.contactSourceUrls,
      verifiedSiteIssues: combinedIssues,
      snippet: c.snippet,
      textSummary: site?.textSummary?.slice(0, 1200) || c.snippet.slice(0, 800),
      sourceUrl: c.sourceUrl,
      mobileScore,
    };
  };

  // Batch into 2 mini-batches of max 5 to stay fast & parallel under serverless limits
  const batchA = candidates.slice(0, 5);
  const batchB = candidates.slice(5, 10);
  const sitesA = await Promise.all(batchA.map((c, i) => inspectOne(c, i)));
  const sitesB = batchB.length > 0 ? await Promise.all(batchB.map((c, i) => inspectOne(c, i + 5))) : [];
  const sites = [...sitesA, ...sitesB];

  const reachableCount = sites.filter((s) => s.reachable).length;
  const verifiedEmailsCount = sites.filter((s) => s.verifiedEmails.length > 0).length;

  const nextState: GrowthExecuteRunState = {
    ...existingState,
    currentStage: "score_and_build",
    completedStages: Array.from(new Set([...existingState.completedStages, "inspect"])) as GrowthExecuteStage[],
    inspected: {
      sites,
      inspectedCount: sites.length,
      reachableCount,
      verifiedEmailsCount,
    },
    updatedAt: new Date().toISOString(),
  };

  await saveRunState(nextState);
  return {
    runId: input.runId,
    state: nextState,
    summary: `Verified ${reachableCount}/${sites.length} live sites · ${verifiedEmailsCount} public contact emails checked`,
  };
}

/** Stage 4: Score Buying Intent, Generate Personalized First-Line Hooks & Build Blueprint */
export async function executeGrowthStageScoreAndBuild(input: {
  runId: string;
  ownerId: string;
  profile: GrowthProfile;
  knowledgeDigest: string;
  settings: Settings;
  existingEmails?: string[];
}): Promise<{ runId: string; state: GrowthExecuteRunState; blueprint: ExecutedCampaignBlueprint; summary: string }> {
  const existingState = await loadRunState(input.ownerId, input.runId);
  if (!existingState?.strategy || !existingState.inspected) {
    throw new Error("Earlier Growth Advisor stages missing. Run Stages 1–3 before Stage 4.");
  }

  const today = new Date().toISOString().slice(0, 10);
  const strat = existingState.strategy;
  const sites = existingState.inspected.sites;

  if (sites.length === 0) {
    const emptyBlueprint: ExecutedCampaignBlueprint = {
      campaignName: strat.campaignName,
      targetAudience: strat.targetAudience,
      targetLocation: strat.targetLocation,
      targetIndustry: strat.targetIndustry,
      messagingAngle: strat.messagingAngle,
      hook: strat.hook,
      subjectLine: strat.subjectLine,
      sampleEmailBody: strat.sampleEmailBody,
      channel: strat.channel,
      schedule: strat.schedule,
      goal: strat.goal,
      complianceChecklist: strat.complianceChecklist,
      prospects: [],
      groundingUrls: [],
    };
    const nextState: GrowthExecuteRunState = {
      ...existingState,
      status: "completed",
      currentStage: "score_and_build",
      completedStages: Array.from(new Set([...existingState.completedStages, "score_and_build"])) as GrowthExecuteStage[],
      blueprint: emptyBlueprint,
    };
    await saveRunState(nextState);
    return { runId: input.runId, state: nextState, blueprint: emptyBlueprint, summary: "No verified prospects to score" };
  }

  const verifiedEmailCorpus = new Set(sites.flatMap((s) => s.verifiedEmails.map((e) => e.toLowerCase())));
  const verifiedUrlCorpus = new Set(sites.flatMap((s) => [s.url.toLowerCase(), s.finalUrl.toLowerCase(), s.sourceUrl.toLowerCase()]));

  const siteDossier = sites
    .map((s, idx) => {
      const dmLine = s.decisionMakers?.length
        ? `\nDecision Makers: ${s.decisionMakers.map((d) => `${d.name} (${d.role})`).join("; ")}`
        : "";
      const socialLine = s.socialLinks?.length
        ? `\nSocials: ${s.socialLinks.slice(0, 3).map((x) => `${x.platform}:${x.url}`).join(" | ")}`
        : "";
      return `[${idx + 1}] Business: ${s.business}${s.location ? ` | Location: ${s.location}` : ""}
URL: ${s.finalUrl} (HTTP ${s.httpStatus}, Reachable: ${s.reachable})
Title/H1: ${s.title} / ${s.h1 || "(none)"}
HTTPS: ${s.isHttps} | Viewport: ${s.hasViewport} | Contact Form: ${s.hasContactForm} | Platform: ${s.platform || "unknown"}${s.mobileScore !== null && s.mobileScore !== undefined ? ` | Mobile PageSpeed: ${s.mobileScore}/100` : ""}
Verified Emails: ${s.verifiedEmails.join(", ") || "(none found)"} (MX Verified: ${s.mxVerified}, Type: ${s.emailType})
Verified Phones: ${s.verifiedPhones.join(", ") || "(none found)"}${dmLine}${socialLine}
Signals/Hints: ${s.statusHints.join("; ") || "(none)"}
Visible Site Copy: ${s.textSummary.slice(0, 400)}`;
    })
    .join("\n\n");

  const taskInstructions = `Execute Growth Advisor STAGE 4 (Buying-Intent Scoring + Personalized First Lines).
Evaluate ONLY the verified prospects listed in VERIFIED SITE DOSSIER below using Modules 1-3 strictly:
1. Never invent businesses, emails, URLs, or technical defects absent from VERIFIED SITE DOSSIER. If Verified Emails is "(none found)", set "email": "".
2. Score Buying Intent (0-100) using Module 1 Fit + WTP Proof + Trigger Timing + Reachability.
3. For each prospect, select recommendedTemplateId ("T1"-"T12"; use "T10" if emailType is "role_inbox"), write a sharp 1-2 sentence verified firstLine citing ONLY real verified site facts/audit issues observed on their site/listing, plus concise plain-text draftSubject (2-5 words) and draftBody (50-115 words, zero {{...}} placeholders, ${
    input.settings.include_opt_out_footer === true
      ? "include one brief plain opt-out line at the bottom"
      : "omit generic opt-out/unsubscribe footers"
  }).

Return ONLY valid JSON:
{
  "prospects": [
    {
      "business": "exact name from dossier",
      "contactName": "name if observed else empty string",
      "role": "role if observed else empty string",
      "email": "exact verified email from dossier or empty string",
      "phone": "exact verified phone or empty string",
      "website": "exact URL from dossier",
      "location": "city/region",
      "industry": "industry",
      "sourceUrl": "exact source URL from dossier",
      "buyingIntentScore": 82,
      "buyingIntentReasoning": "transparent Module 1 evidence-backed reasoning",
      "signals": [{ "signal": "short signal name", "strength": "strong | moderate | weak", "evidence": "verified observation from dossier" }],
      "recommendedTemplateId": "T1",
      "firstLine": "verified personalized opening line",
      "draftSubject": "2-5 word lowercase subject",
      "draftBody": "complete plain-text cold email body"
    }
  ]
}`;

  const orchestrated = await buildOrchestratedSystemPrompt({
    workflow: "growth_advisor",
    ownerId: input.ownerId,
    settings: input.settings,
    knowledgeDigest: input.knowledgeDigest,
    taskInstructions,
  });

  const user = `CAMPAIGN STRATEGY:
Name: ${strat.campaignName}
Angle: ${strat.messagingAngle}
Core Offer: ${input.profile.offer || "See KB"}
Sender: ${input.settings.sender_name || "Founder"} (${input.settings.sender_company || input.profile.whoYouAre})
Physical Address: ${input.settings.physical_address || "Required before sending"}
Regional Compliance: ${strat.complianceFramework}

VERIFIED SITE DOSSIER (${sites.length} candidates):
${siteDossier}

Score, prioritize highest buying intent first, and draft non-hallucinated outreach JSON.`;

  const { data } = await LLMGateway.completeJSON<{ prospects?: Record<string, unknown>[] }>({
    ownerId: input.ownerId,
    taskType: "balanced",
    feature: "growth_execute_score",
    systemPrompt: orchestrated.system,
    messages: [{ role: "user", content: user }],
    maxTokens: 2200,
  });

  const existingSet = new Set((input.existingEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean));
  const seenKeys = new Set<string>();

  const prospects: ExecutedProspect[] = (Array.isArray(data.prospects) ? data.prospects : [])
    .map((raw, idx) => {
      const siteRef =
        sites.find(
          (s) =>
            s.finalUrl.toLowerCase() === cleanStr(raw.website, 300).toLowerCase() ||
            s.business.toLowerCase() === cleanStr(raw.business, 200).toLowerCase(),
        ) ?? sites[idx];

      // Strict anti-hallucination guard on emails
      const rawEmail = cleanStr(raw.email, 200).toLowerCase();
      const verifiedEmail =
        rawEmail && verifiedEmailCorpus.has(rawEmail) && !existingSet.has(rawEmail)
          ? rawEmail
          : siteRef?.verifiedEmails.find((e) => !existingSet.has(e)) ?? "";

      const rawUrl = cleanStr(raw.sourceUrl, 400);
      const safeSourceUrl =
        rawUrl && verifiedUrlCorpus.has(rawUrl.toLowerCase()) ? rawUrl : siteRef?.sourceUrl ?? "";

      const rawWebsite = cleanStr(raw.website, 300);
      const safeWebsite =
        rawWebsite && verifiedUrlCorpus.has(rawWebsite.toLowerCase()) ? rawWebsite : siteRef?.finalUrl ?? "";

      const intentScore = clampNum(raw.buyingIntentScore, 5, 99, 65);
      const intentLevel: ExecutedProspect["buyingIntentLevel"] =
        intentScore >= 78 ? "high" : intentScore >= 55 ? "medium" : "low";

      const signals: IntentSignal[] = Array.isArray(raw.signals)
        ? raw.signals
            .map((s) => {
              const obj = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
              const st = cleanStr(obj.strength, 20).toLowerCase();
              return {
                signal: cleanStr(obj.signal, 200),
                strength: (st === "strong" || st === "moderate" || st === "weak" ? st : "moderate") as IntentSignal["strength"],
                evidence: cleanStr(obj.evidence, 300),
              };
            })
            .filter((s) => s.signal)
        : [];

      const fallbackDm = siteRef?.decisionMakers?.[0];
      return {
        id: `exec_p_${Date.now()}_${idx}`,
        selected: intentScore >= 55 && Boolean(verifiedEmail || safeWebsite),
        business: cleanStr(raw.business, 200) || siteRef?.business || "",
        contactName: cleanStr(raw.contactName, 140) || fallbackDm?.name || "",
        role: cleanStr(raw.role, 120) || fallbackDm?.role || "",
        email: verifiedEmail,
        phone: cleanStr(raw.phone, 60) || siteRef?.verifiedPhones[0] || "",
        website: safeWebsite,
        location: cleanStr(raw.location, 180) || siteRef?.location || strat.targetLocation,
        industry: cleanStr(raw.industry, 140) || strat.targetIndustry,
        socials: siteRef?.socialLinks ?? [],
        sourceUrl: safeSourceUrl,
        sourceDate: today,
        buyingIntentScore: intentScore,
        buyingIntentLevel: intentLevel,
        buyingIntentReasoning: cleanStr(raw.buyingIntentReasoning, 450) || "Verified against Module 1 criteria.",
        signals,
        complianceNote: `${strat.complianceFramework}: verified public B2B source.`,
        firstLine: stripUnresolvedPlaceholders(cleanStr(raw.firstLine, 320)),
        recommendedTemplateId: cleanStr(raw.recommendedTemplateId, 10) || (siteRef?.emailType === "role_inbox" ? "T10" : "T1"),
        mxVerified: siteRef?.mxVerified ?? false,
        emailType: siteRef?.emailType ?? "invalid",
        contactSourceUrls: siteRef?.contactSourceUrls ?? [],
        verifiedSiteIssues: siteRef?.verifiedSiteIssues ?? [],
        draftSubject: stripUnresolvedPlaceholders(cleanStr(raw.draftSubject, 180)) || strat.subjectLine,
        draftBody: stripUnresolvedPlaceholders(cleanStr(raw.draftBody, 3000)),
      };
    })
    .filter((p) => {
      if (!p.business) return false;
      const verdict = validateContactableLead({
        business: p.business,
        website: p.website,
        location: p.location,
        email: p.email,
        phone: p.phone,
        socials: p.socials,
        decisionMaker: p.contactName,
        mxVerified: p.email ? p.mxVerified : undefined,
        requireEmail: strat.channel.toLowerCase() === "email",
      });
      if (!verdict.contactable) return false;
      const k = (p.website || p.business).toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
      if (seenKeys.has(k)) return false;
      seenKeys.add(k);
      return true;
    })
    .sort((a, b) => b.buyingIntentScore - a.buyingIntentScore);

  const blueprint: ExecutedCampaignBlueprint = {
    campaignName: strat.campaignName,
    targetAudience: strat.targetAudience,
    targetLocation: strat.targetLocation,
    targetIndustry: strat.targetIndustry,
    messagingAngle: strat.messagingAngle,
    hook: strat.hook,
    subjectLine: strat.subjectLine,
    sampleEmailBody: strat.sampleEmailBody,
    channel: strat.channel,
    schedule: strat.schedule,
    goal: strat.goal,
    complianceChecklist: strat.complianceChecklist,
    prospects,
    groundingUrls: sites.slice(0, 12).map((s) => ({ uri: s.finalUrl, title: s.title || s.business })),
  };

  const nextState: GrowthExecuteRunState = {
    ...existingState,
    status: "completed",
    currentStage: "score_and_build",
    completedStages: Array.from(new Set([...existingState.completedStages, "score_and_build"])) as GrowthExecuteStage[],
    blueprint,
    updatedAt: new Date().toISOString(),
  };

  await saveRunState(nextState);
  const skippedCount = Math.max(0, sites.length - prospects.length);
  return {
    runId: input.runId,
    state: nextState,
    blueprint,
    summary: `Found ${sites.length} candidates -> Skipped ${skippedCount} without verified contacts -> Prioritized ${prospects.length} contactable buyers (${prospects.filter((p) => p.buyingIntentLevel === "high").length} high intent)`,
  };
}

/** Backwards-compatible wrapper composing Stages 1 -> 2 -> 3 -> 4 cleanly. */
export async function executeRecommendationServer(input: {
  ownerId?: string;
  recommendation?: GrowthRecommendation | null;
  overallStrategy?: string;
  profile: GrowthProfile;
  knowledgeDigest: string;
  settings: Settings;
  existingEmails: string[];
  model?: string;
}): Promise<ExecutedCampaignBlueprint> {
  void input.model;
  const ownerId = input.ownerId || getActiveOwnerAiContext()?.ownerId || "anonymous";

  const s1 = await executeGrowthStageStrategy({
    ownerId,
    recommendation: input.recommendation,
    overallStrategy: input.overallStrategy,
    profile: input.profile,
    knowledgeDigest: input.knowledgeDigest,
    settings: input.settings,
  });

  await executeGrowthStageDiscover({
    runId: s1.runId,
    ownerId,
    existingEmails: input.existingEmails,
  });

  await executeGrowthStageInspect({
    runId: s1.runId,
    ownerId,
  });

  const s4 = await executeGrowthStageScoreAndBuild({
    runId: s1.runId,
    ownerId,
    profile: input.profile,
    knowledgeDigest: input.knowledgeDigest,
    settings: input.settings,
    existingEmails: input.existingEmails,
  });

  return s4.blueprint;
}
