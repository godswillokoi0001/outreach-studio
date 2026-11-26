import type { Settings } from "./types";

export type RecommendationCategory =
  | "location"
  | "niche"
  | "messaging"
  | "channels_timing"
  | "offer_strategy";

export type ImpactRating = "high" | "medium" | "low";

export interface GrowthProfile {
  whoYouAre: string;
  whatYouSell: string;
  industry: string;
  offer: string;
  priceRange: string;
  location: string;
  idealCustomer: string;
  updatedAt?: string;
}

export const EMPTY_GROWTH_PROFILE: GrowthProfile = {
  whoYouAre: "",
  whatYouSell: "",
  industry: "",
  offer: "",
  priceRange: "",
  location: "",
  idealCustomer: "",
};

export interface SuggestedActionPlan {
  targetIndustry: string;
  targetLocation: string;
  targetAudience: string;
  angle: string;
  hook: string;
  subjectLine: string;
  offer: string;
  channel: string;
  timing: string;
  goal: string;
}

export interface GrowthRecommendation {
  id: string;
  category: RecommendationCategory;
  title: string;
  summary: string;
  reason: string;
  evidence: string;
  sourceUrl: string;
  sourceTitle: string;
  impact: ImpactRating;
  confidence: number;
  priorityOrder: number;
  suggestedAction: SuggestedActionPlan;
  basedOnAnalytics?: boolean;
}

export interface PostAnalysisInsights {
  whatWorked: string[];
  whatDidnt: string[];
  nextMoves: string[];
}

export interface GrowthAdvisorReport {
  overallStrategy: string;
  profileFingerprint: string;
  generatedAt: string;
  expiresAt: string;
  sources: { uri: string; title: string }[];
  recommendations: GrowthRecommendation[];
  postAnalysisInsights?: PostAnalysisInsights;
}

export interface IntentSignal {
  signal: string;
  strength: "strong" | "moderate" | "weak";
  evidence: string;
}

export interface ExecutedProspect {
  id: string;
  selected: boolean;
  business: string;
  contactName: string;
  role: string;
  email: string;
  phone: string;
  website: string;
  location: string;
  industry: string;
  sourceUrl: string;
  sourceDate: string;
  buyingIntentScore: number;
  buyingIntentLevel: "high" | "medium" | "low";
  buyingIntentReasoning: string;
  signals: IntentSignal[];
  complianceNote: string;
  draftSubject?: string;
  draftBody?: string;
}

export interface ExecutedCampaignBlueprint {
  campaignName: string;
  targetAudience: string;
  targetLocation: string;
  targetIndustry: string;
  messagingAngle: string;
  hook: string;
  subjectLine: string;
  sampleEmailBody: string;
  channel: string;
  schedule: {
    sendDays: string;
    windowStart: number;
    windowEnd: number;
    followupDays: number[];
    dailyLimit: number;
  };
  goal: string;
  complianceChecklist: string[];
  prospects: ExecutedProspect[];
  groundingUrls: { uri: string; title: string }[];
}

export const CATEGORY_LABELS: Record<RecommendationCategory, string> = {
  location: "Target locations",
  niche: "Niche & audience",
  messaging: "Messaging & hooks",
  channels_timing: "Channels & timing",
  offer_strategy: "Offer & strategy",
};

/** Computes a deterministic lightweight hash string for cache invalidation. */
export function computeProfileFingerprint(input: {
  profile: GrowthProfile;
  knowledgeDigest: string;
  settings: Pick<Settings, "sender_company" | "sender_name" | "sender_role" | "physical_address">;
  metricsSummary: { leads: number; campaigns: number; sent: number; replies: number; positive: number };
}): string {
  const payload = JSON.stringify({
    p: {
      whoYouAre: input.profile.whoYouAre.trim(),
      whatYouSell: input.profile.whatYouSell.trim(),
      industry: input.profile.industry.trim(),
      offer: input.profile.offer.trim(),
      priceRange: input.profile.priceRange.trim(),
      location: input.profile.location.trim(),
      idealCustomer: input.profile.idealCustomer.trim(),
    },
    k: input.knowledgeDigest.slice(0, 1200).trim(),
    s: `${input.settings.sender_company}|${input.settings.sender_name}|${input.settings.physical_address}`,
    m: input.metricsSummary,
  });

  // Deterministic FNV-1a 32-bit hash
  let hash = 2166136261;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `ga_${(hash >>> 0).toString(36)}`;
}

/** Checks if the user's profile has enough context to run tailored internet research. */
export function evaluateProfileCompleteness(
  profile: GrowthProfile,
  knowledgeDigest: string,
  settings: Pick<Settings, "sender_company" | "sender_name" | "sender_role">,
): {
  complete: boolean;
  missingFields: string[];
  score: number;
} {
  const hasKnowledge = knowledgeDigest.trim().length >= 60;
  const missingFields: string[] = [];

  const hasIdentity = Boolean(profile.whoYouAre.trim() || settings.sender_company.trim() || settings.sender_name.trim() || hasKnowledge);
  if (!hasIdentity) missingFields.push("Who you are / Company");

  const hasWhatYouSell = Boolean(profile.whatYouSell.trim() || hasKnowledge);
  if (!hasWhatYouSell) missingFields.push("What you sell or do");

  const hasIndustry = Boolean(profile.industry.trim());
  if (!hasIndustry) missingFields.push("Industry");

  const hasOffer = Boolean(profile.offer.trim() || hasKnowledge);
  if (!hasOffer) missingFields.push("Core offer");

  const hasPrice = Boolean(profile.priceRange.trim());
  if (!hasPrice) missingFields.push("Price range");

  const hasLocation = Boolean(profile.location.trim());
  if (!hasLocation) missingFields.push("Target or base location");

  const totalChecks = 6;
  const completedChecks = totalChecks - missingFields.length;
  const score = Math.round((completedChecks / totalChecks) * 100);

  // Require at least identity/offer context plus key business parameters (or filled profile)
  const complete = missingFields.length <= 1 && (hasWhatYouSell || hasOffer) && hasIndustry;
  return { complete, missingFields, score };
}

/** Returns true if the cached Growth Advisor report needs an automatic background refresh. */
export function isReportStale(report: GrowthAdvisorReport | null, currentFingerprint: string): boolean {
  if (!report) return true;
  if (!Array.isArray(report.recommendations) || report.recommendations.length === 0) return true;
  if (report.profileFingerprint !== currentFingerprint) return true;
  const expiry = Date.parse(report.expiresAt || "");
  if (Number.isNaN(expiry) || Date.now() > expiry) return true;
  return false;
}
