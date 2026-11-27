import { buildOrchestratedSystemPrompt, stripUnresolvedPlaceholders } from "./ai/orchestrator";
import { getActiveOwnerAiContext } from "./ai/context";
import { LLMGateway } from "./llm/gateway";
import {
  type ExecutedCampaignBlueprint,
  type ExecutedProspect,
  type GrowthAdvisorReport,
  type GrowthProfile,
  type GrowthRecommendation,
  type ImpactRating,
  type IntentSignal,
  type RecommendationCategory,
} from "./growth-advisor";
import type { PerformanceInsight } from "./intelligence";
import type { Settings } from "./types";

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

  const taskInstructions = `You are a Principal B2B Growth Advisor and Market Intelligence Strategist.
Today's date is ${today}.
Search the live web using Google Search grounding and deliver actionable, evidence-backed growth recommendations specifically tailored to the Active User's business profile, price point, location, and past campaign performance — following Modules 1-3 strictly (signal-based WTP, copywriting psychology, and routing cadence).

MANDATORY RESEARCH RULES:
1. Search the web for what is actually working right now in ${today.slice(0, 4)} for businesses matching the user's profile and offer.
2. Ground every recommendation in real reasoning AND include a real, verifiable sourceUrl + sourceTitle from your search results. Never fabricate URLs.
3. Cover ALL 5 recommendation categories: location, niche, messaging, channels_timing, offer_strategy.
4. Rate each recommendation honestly with impact ("high" | "medium" | "low") and confidence (0-100), and assign priorityOrder.
5. ${
    hasAnalytics
      ? "Populate postAnalysisInsights summarizing what worked, what didn't work in the measured numbers, and concrete next moves, flagging relevant recommendations with basedOnAnalytics: true."
      : "If past campaigns exist in metricsSummary, factor them in honestly. Do not invent metrics."
  }

Return ONLY valid JSON matching this exact structure (no markdown wrapper):
{
  "overallStrategy": "string",
  "recommendations": [
    {
      "id": "rec_1",
      "category": "location | niche | messaging | channels_timing | offer_strategy",
      "title": "Actionable recommendation headline",
      "summary": "Specific recommendation tailored to their offer and price range",
      "reason": "Short explanation of why this works right now",
      "evidence": "Specific market signal, benchmark, or trend discovered from search",
      "sourceUrl": "https://...",
      "sourceTitle": "Source publication or page title",
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
- Market reach & locations: ${input.profile.marketScope?.join(", ") || "Not specified"} · Target/Base Location: ${input.profile.location || input.settings.physical_address || "Not specified"} · Languages: ${input.profile.outreachLanguages?.join(", ") || "English"}
- Ideal Customer Profile: ${input.profile.idealCustomer || "Not specified"} · Target industries: ${input.profile.targetIndustries?.join(", ") || "Any"} · Decision-maker roles: ${input.profile.targetRoles?.join(", ") || "Decision makers"} · Company size: ${input.profile.targetCompanySize || "Any"}
- Buying triggers: ${input.profile.buyingTriggers?.join(", ") || "None specified"}
- Sales cycle & preferred channels: ${input.profile.salesCycleLength || "Not specified"} · Channels: ${input.profile.preferredChannels?.join(", ") || "Cold Email"}
- Primary goal & capacity: ${input.profile.primaryGoal || "Qualified leads"} · Target leads/mo: ${input.profile.monthlyTargetLeads ?? "Flexible"} · Weekly outreach capacity: ${input.profile.weeklyOutreachCapacity ?? "Flexible"}
- Proof assets & exclusions: ${input.profile.proofAssets?.join(", ") || "Standard"} · Exclusions (DO NOT target): ${input.profile.exclusions || "None"} · Voice: ${input.profile.tonePreference?.join(", ") || "Consultative"}
${input.profile.allowComplianceSafeClaims !== false ? "- Compliance rule: Strictly avoid unverified ROI claims or hype." : ""}

PAST CAMPAIGN & ANALYTICS METRICS:
${JSON.stringify(input.metricsSummary, null, 2).slice(0, 4000)}

${
  input.analyticsInsight
    ? `RECENT AI PERFORMANCE REVIEW:\nHeadline: ${input.analyticsInsight.headline}\nObservations: ${input.analyticsInsight.observations.join(" | ")}\nRecommendations: ${input.analyticsInsight.recommendations.map((r) => `${r.title}: ${r.detail}`).join(" | ")}`
    : ""
}

Generate 6 to 8 high-precision, diverse recommendations covering location, niche, messaging, channels_timing, and offer_strategy.`;

  void input.model;
  const { data, groundingUrls } = await LLMGateway.completeGroundedJSON<{
    overallStrategy?: string;
    recommendations?: Record<string, unknown>[];
    postAnalysisInsights?: {
      whatWorked?: unknown[];
      whatDidnt?: unknown[];
      nextMoves?: unknown[];
    };
  }>({
    ownerId: input.ownerId || getActiveOwnerAiContext()?.ownerId || "anonymous",
    taskType: "smart",
    feature: "growth_advisor",
    systemPrompt: orchestrated.system,
    messages: [{ role: "user", content: user }],
  });

  const recs: GrowthRecommendation[] = (Array.isArray(data.recommendations) ? data.recommendations : [])
    .map((raw, idx) => {
      const actionRaw = (raw.suggestedAction && typeof raw.suggestedAction === "object"
        ? raw.suggestedAction
        : {}) as Record<string, unknown>;
      const fallbackUrl = groundingUrls[idx % Math.max(1, groundingUrls.length)]?.uri ?? "";
      const fallbackTitle = groundingUrls[idx % Math.max(1, groundingUrls.length)]?.title ?? "Web research";

      return {
        id: cleanStr(raw.id, 60) || `rec_${Date.now()}_${idx + 1}`,
        category: normalizeCategory(raw.category),
        title: cleanStr(raw.title, 180) || "Growth Recommendation",
        summary: cleanStr(raw.summary, 600),
        reason: cleanStr(raw.reason, 450),
        evidence: cleanStr(raw.evidence, 450),
        sourceUrl: cleanStr(raw.sourceUrl, 400) || fallbackUrl,
        sourceTitle: cleanStr(raw.sourceTitle, 140) || fallbackTitle,
        impact: normalizeImpact(raw.impact),
        confidence: clampNum(raw.confidence, 10, 99, 75),
        priorityOrder: clampNum(raw.priorityOrder, 1, 20, idx + 1),
        basedOnAnalytics: Boolean(raw.basedOnAnalytics),
        suggestedAction: {
          targetIndustry: cleanStr(actionRaw.targetIndustry, 160) || input.profile.industry || "B2B Services",
          targetLocation: cleanStr(actionRaw.targetLocation, 160) || input.profile.location || "United States",
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
  const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hour refresh cycle

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
  };
}

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
  const today = new Date().toISOString().slice(0, 10);
  const rec = input.recommendation;

  const targetContext = rec
    ? `EXECUTING RECOMMENDATION:
Title: ${rec.title}
Category: ${rec.category}
Summary: ${rec.summary}
Target Niche: ${rec.suggestedAction.targetIndustry}
Target Location: ${rec.suggestedAction.targetLocation}
Target Audience: ${rec.suggestedAction.targetAudience}
Suggested Angle: ${rec.suggestedAction.angle}
Suggested Hook: ${rec.suggestedAction.hook}
Suggested Subject Line: ${rec.suggestedAction.subjectLine}
Suggested Offer: ${rec.suggestedAction.offer}
Channel: ${rec.suggestedAction.channel}
Timing: ${rec.suggestedAction.timing}
Goal: ${rec.suggestedAction.goal}`
    : `EXECUTING OVERALL GROWTH STRATEGY:
Strategy: ${input.overallStrategy || "Launch high-intent campaign tailored to business profile"}
Target Industry: ${input.profile.industry}
Target Location: ${input.profile.location}
Ideal Customer: ${input.profile.idealCustomer}
Core Offer: ${input.profile.offer}`;

  const taskInstructions = `Today is ${today}.
The user clicked "Execute" on a Growth Advisor recommendation.
Using live Google Search grounding and Modules 1-3 strictly:
1. Build a complete, ready-to-review Campaign Plan tailored to their offer, price point (${input.profile.priceRange || "B2B"}), and target region.
2. Search the public web right now for 5 to 8 REAL, LAWFUL, PUBLICLY LISTED B2B prospects matching this recommendation's target niche & location.
3. For EVERY prospect:
   - Provide ONLY factual, publicly available business details (company name, website, public email/phone if verified—never invent emails!, decision-maker name & role if publicly listed, sourceUrl, sourceDate = "${today}"). Leave missing fields as ""!
   - Never include any of these already-existing emails: ${input.existingEmails.slice(0, 40).join(", ") || "none"}.
   - Score **Buying Intent (0-100)** strictly per Module 1 WTP + Fit + Timing + Reachability.
   - Include regional privacy/anti-spam complianceNote and complianceChecklist.
4. Draft short, personalized Module 2/3 emails (45-95 words, plain text, zero AI slop, zero unresolved {{...}} tags when specific prospect details exist, explicit opt-out note).

Return ONLY valid JSON matching the ExecutedCampaignBlueprint schema.`;

  const orchestrated = await buildOrchestratedSystemPrompt({
    workflow: "growth_advisor",
    ownerId: input.ownerId ?? null,
    settings: input.settings,
    knowledgeDigest: input.knowledgeDigest,
    taskInstructions,
  });

  const user = `USER PROFILE:
Company/Sender: ${input.profile.whoYouAre || input.settings.sender_company || input.settings.sender_name || "Operator"} (${input.settings.sender_role || "Founder"})
What They Sell: ${input.profile.whatYouSell || "See knowledge base"}
Core Offer: ${input.profile.offer || "See knowledge base"}
Price Range: ${input.profile.priceRange || "Not specified"}
Base Location: ${input.profile.location || input.settings.physical_address || "Not specified"}
Sender Physical Address (for compliance footer): ${input.settings.physical_address || "Required before sending"}
Unsubscribe Email: ${input.settings.unsubscribe_email || input.settings.sender_email || "reply to opt out"}

${targetContext}

Output strictly JSON with keys: campaignName, targetAudience, targetLocation, targetIndustry, messagingAngle, hook, subjectLine, sampleEmailBody, channel, schedule { sendDays, windowStart, windowEnd, followupDays, dailyLimit }, goal, complianceChecklist[], prospects[].`;

  void input.model;
  const { data, groundingUrls } = await LLMGateway.completeGroundedJSON<{
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
    complianceChecklist?: unknown[];
    prospects?: Record<string, unknown>[];
  }>({
    ownerId: input.ownerId || getActiveOwnerAiContext()?.ownerId || "anonymous",
    taskType: "smart",
    feature: "growth_execute",
    systemPrompt: orchestrated.system,
    messages: [{ role: "user", content: user }],
  });

  const existingSet = new Set(input.existingEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const seenKeys = new Set<string>();

  const prospects: ExecutedProspect[] = (Array.isArray(data.prospects) ? data.prospects : [])
    .map((raw, idx) => {
      const email = cleanStr(raw.email, 200).toLowerCase();
      const validEmail = email.includes("@") && !email.includes(" ") && !existingSet.has(email) ? email : "";
      const signals: IntentSignal[] = Array.isArray(raw.signals)
        ? raw.signals
            .map((s) => {
              const obj = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
              const rawStrength = cleanStr(obj.strength, 20).toLowerCase();
              const strength: IntentSignal["strength"] =
                rawStrength === "strong" || rawStrength === "moderate" || rawStrength === "weak"
                  ? rawStrength
                  : "moderate";
              return {
                signal: cleanStr(obj.signal, 200),
                strength,
                evidence: cleanStr(obj.evidence, 300),
              };
            })
            .filter((s) => s.signal)
        : [];

      const intentScore = clampNum(raw.buyingIntentScore, 5, 99, 65);
      const intentLevel: ExecutedProspect["buyingIntentLevel"] =
        intentScore >= 78 ? "high" : intentScore >= 55 ? "medium" : "low";

      return {
        id: `exec_p_${Date.now()}_${idx}`,
        selected: intentScore >= 55, // Auto-select medium/high intent; let user review all
        business: cleanStr(raw.business, 200),
        contactName: cleanStr(raw.contactName, 140),
        role: cleanStr(raw.role, 120),
        email: validEmail,
        phone: cleanStr(raw.phone, 60),
        website: cleanStr(raw.website, 300),
        location: cleanStr(raw.location, 180) || rec?.suggestedAction.targetLocation || input.profile.location,
        industry: cleanStr(raw.industry, 140) || rec?.suggestedAction.targetIndustry || input.profile.industry,
        sourceUrl: cleanStr(raw.sourceUrl, 400) || groundingUrls[0]?.uri || "",
        sourceDate: cleanStr(raw.sourceDate, 30) || today,
        buyingIntentScore: intentScore,
        buyingIntentLevel: intentLevel,
        buyingIntentReasoning: cleanStr(raw.buyingIntentReasoning, 450) || "Matches target segment criteria.",
        signals,
        complianceNote:
          cleanStr(raw.complianceNote, 240) || "Publicly listed B2B directory / official website; include opt-out link.",
        draftSubject: stripUnresolvedPlaceholders(cleanStr(raw.draftSubject, 180)),
        draftBody: stripUnresolvedPlaceholders(cleanStr(raw.draftBody, 3000)),
      };
    })
    .filter((p) => {
      if (!p.business) return false;
      const key = (p.website || p.business).toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    })
    .sort((a, b) => b.buyingIntentScore - a.buyingIntentScore); // Prioritise highest buying intent first!

  return {
    campaignName:
      cleanStr(data.campaignName, 180) ||
      (rec ? `${rec.title.slice(0, 60)} Campaign` : "Growth Advisor Priority Campaign"),
    targetAudience: cleanStr(data.targetAudience, 300) || rec?.suggestedAction.targetAudience || input.profile.idealCustomer,
    targetLocation: cleanStr(data.targetLocation, 200) || rec?.suggestedAction.targetLocation || input.profile.location,
    targetIndustry: cleanStr(data.targetIndustry, 160) || rec?.suggestedAction.targetIndustry || input.profile.industry,
    messagingAngle: cleanStr(data.messagingAngle, 400) || rec?.suggestedAction.angle || "",
    hook: cleanStr(data.hook, 300) || rec?.suggestedAction.hook || "",
    subjectLine: cleanStr(data.subjectLine, 180) || rec?.suggestedAction.subjectLine || "Quick question for {{company}}",
    sampleEmailBody: cleanStr(data.sampleEmailBody, 4000) || "",
    channel: cleanStr(data.channel, 120) || rec?.suggestedAction.channel || "Cold Email",
    schedule: {
      sendDays: cleanStr(data.schedule?.sendDays, 40) || input.settings.send_days || "mon,tue,wed,thu,fri",
      windowStart: clampNum(data.schedule?.windowStart, 0, 23, input.settings.send_window_start || 9),
      windowEnd: clampNum(data.schedule?.windowEnd, 1, 23, input.settings.send_window_end || 17),
      followupDays: Array.isArray(data.schedule?.followupDays)
        ? data.schedule!.followupDays.map((d) => clampNum(d, 1, 30, 3)).slice(0, 5)
        : [3, 7],
      dailyLimit: clampNum(data.schedule?.dailyLimit, 1, 100, input.settings.daily_limit || 25),
    },
    goal: cleanStr(data.goal, 250) || rec?.suggestedAction.goal || "Convert high-intent leads into qualified meetings",
    complianceChecklist: Array.isArray(data.complianceChecklist)
      ? data.complianceChecklist.map((c) => cleanStr(c, 220)).filter(Boolean)
      : [
          "Only public B2B corporate contact details sourced lawfully",
          "Include clear opt-out / unsubscribe instructions in every email",
          "Respect regional B2B electronic communication & suppression list rules",
        ],
    prospects,
    groundingUrls: groundingUrls.slice(0, 12),
  };
}
