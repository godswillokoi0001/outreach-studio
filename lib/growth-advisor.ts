import type { OnboardingAnswers } from "./onboarding";
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

  // Expanded structured option-driven profile
  businessStage?: string;
  businessStageOther?: string;
  teamStructure?: string;
  businessWebsite?: string;
  primaryRole?: string;
  primaryRoleOther?: string;

  businessModel?: string;
  businessModelOther?: string;
  pricingStructure?: string;
  pricingStructureOther?: string;
  averageDealValue?: number;
  deliverablesSummary?: string;

  targetIndustries?: string[];
  targetIndustriesOther?: string;
  targetRoles?: string[];
  targetRolesOther?: string;
  targetCompanySize?: string;
  buyingTriggers?: string[];
  buyingTriggersOther?: string;

  marketScope?: string[];
  outreachLanguages?: string[];
  outreachLanguagesOther?: string;

  salesCycleLength?: string;
  preferredChannels?: string[];
  preferredChannelsOther?: string;
  offerCtaStyle?: string;
  offerCtaStyleOther?: string;

  primaryGoal?: string;
  primaryGoalOther?: string;
  monthlyTargetLeads?: number;
  weeklyOutreachCapacity?: number;
  monthlyMarketingBudget?: string;

  proofAssets?: string[];
  proofAssetsOther?: string;
  exclusions?: string;
  tonePreference?: string[];
  allowComplianceSafeClaims?: boolean;
  skippedSections?: string[];
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
  targetIndustries: [],
  targetRoles: [],
  buyingTriggers: [],
  marketScope: [],
  outreachLanguages: ["English"],
  preferredChannels: [],
  proofAssets: [],
  tonePreference: [],
  averageDealValue: 2500,
  monthlyTargetLeads: 50,
  weeklyOutreachCapacity: 150,
  allowComplianceSafeClaims: true,
  skippedSections: [],
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

export interface GrowthMarketTrend {
  trend: string;
  whyNow: string;
  sourceUrl: string;
  sourceTitle: string;
}

export interface GrowthSaturationSignal {
  /** The overcrowded angle, pitch or segment to stop using. */
  angle: string;
  whySaturated: string;
  whatToDoInstead: string;
  sourceUrl?: string;
  sourceTitle?: string;
}

export interface GrowthPipelineDiagnosis {
  summary: string;
  strengths: string[];
  bottlenecks: string[];
  untouchedLeadsCount: number;
  quickWinAction: string;
}

export interface GrowthPlayCard {
  rank: number;
  title: string;
  microNiche: string;
  geoFocus: string;
  whyNow: string;
  wedgeOffer: string;
  openingHook: string;
  channelSequence: string;
  referralLoop: string;
  realisticWeeklyTarget: string;
  linkedRecommendationId?: string;
}

export interface GrowthAdvisorReport {
  overallStrategy: string;
  profileFingerprint: string;
  generatedAt: string;
  expiresAt: string;
  sources: { uri: string; title: string }[];
  recommendations: GrowthRecommendation[];
  postAnalysisInsights?: PostAnalysisInsights;
  marketPulse?: GrowthMarketTrend[];
  saturatedAngles?: GrowthSaturationSignal[];
  pipelineDiagnosis?: GrowthPipelineDiagnosis;
  topPlays?: GrowthPlayCard[];
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
  socials?: { platform: string; url: string }[];
  sourceUrl: string;
  sourceDate: string;
  buyingIntentScore: number;
  buyingIntentLevel: "high" | "medium" | "low";
  buyingIntentReasoning: string;
  signals: IntentSignal[];
  complianceNote: string;
  draftSubject?: string;
  draftBody?: string;
  firstLine?: string;
  recommendedTemplateId?: string;
  mxVerified?: boolean;
  emailType?: "direct" | "role_inbox" | "invalid";
  contactSourceUrls?: { channel: string; value: string; sourceUrl: string }[];
  verifiedSiteIssues?: string[];
}

export type GrowthExecuteStage = "strategy" | "discover" | "inspect" | "score_and_build";

export interface GrowthRunCandidate {
  business: string;
  website: string;
  domain: string;
  sourceUrl: string;
  snippet: string;
  address?: string;
  phone?: string;
  email?: string;
  sourceProvider: string;
}

export interface GrowthRunInspectedSite {
  business: string;
  url: string;
  finalUrl: string;
  reachable: boolean;
  httpStatus: number;
  isHttps: boolean;
  hasViewport: boolean;
  hasContactForm: boolean;
  platform: string | null;
  title: string;
  h1: string;
  statusHints: string[];
  verifiedEmails: string[];
  mxVerified: boolean;
  emailType: "direct" | "role_inbox" | "invalid";
  verifiedPhones: string[];
  socialLinks: { platform: string; url: string }[];
  decisionMakers?: { name: string; role: string }[];
  location?: string;
  contactSourceUrls?: { channel: string; value: string; sourceUrl: string }[];
  verifiedSiteIssues?: string[];
  snippet: string;
  textSummary: string;
  sourceUrl: string;
  mobileScore?: number | null;
}

export interface GrowthExecuteRunState {
  runId: string;
  ownerId: string;
  status: "in_progress" | "completed" | "failed";
  currentStage: GrowthExecuteStage;
  completedStages: GrowthExecuteStage[];
  recommendationTitle: string;
  strategy?: {
    offerFitDiagnosis: string;
    campaignName: string;
    targetAudience: string;
    targetLocation: string;
    targetIndustry: string;
    messagingAngle: string;
    hook: string;
    subjectLine: string;
    sampleEmailBody: string;
    channel: string;
    schedule: ExecutedCampaignBlueprint["schedule"];
    goal: string;
    complianceChecklist: string[];
    complianceFramework: string;
    searchQueries: string[];
  };
  discovered?: {
    candidates: GrowthRunCandidate[];
    totalFound: number;
    duplicatesRemoved: number;
    providersUsed: string[];
  };
  inspected?: {
    sites: GrowthRunInspectedSite[];
    inspectedCount: number;
    reachableCount: number;
    verifiedEmailsCount: number;
  };
  blueprint?: ExecutedCampaignBlueprint;
  updatedAt: string;
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

/** Merges empty GrowthProfile fields from completed/in-progress Onboarding answers cleanly. */
export function hydrateGrowthProfileFromOnboarding(
  profile: GrowthProfile,
  answers: OnboardingAnswers | null | undefined,
  settings?: Pick<Settings, "sender_company" | "sender_name" | "sender_role" | "physical_address">,
): GrowthProfile {
  if (!answers) {
    return {
      ...EMPTY_GROWTH_PROFILE,
      ...profile,
      whoYouAre: profile.whoYouAre || settings?.sender_company || settings?.sender_name || "",
      location: profile.location || settings?.physical_address || "",
    };
  }
  return {
    ...EMPTY_GROWTH_PROFILE,
    ...profile,
    whoYouAre: profile.whoYouAre || answers.businessName || settings?.sender_company || answers.fullName || settings?.sender_name || "",
    whatYouSell: profile.whatYouSell || answers.businessDescription || answers.mainServices.join(", "),
    industry: profile.industry || answers.industry || "",
    offer: profile.offer || answers.differentiators || answers.mainProblemSolved || "",
    priceRange: profile.priceRange || answers.priceRange || "",
    location: profile.location || answers.currentMarkets || answers.businessLocation || settings?.physical_address || "",
    idealCustomer: profile.idealCustomer || answers.idealCustomerSummary || answers.icpRoles.join(", "),
    businessWebsite: profile.businessWebsite || answers.website || "",
    primaryRole: profile.primaryRole || answers.roleTitle || settings?.sender_role || "",
    teamStructure: profile.teamStructure || answers.workMode || "",
    targetIndustries:
      profile.targetIndustries && profile.targetIndustries.length > 0
        ? profile.targetIndustries
        : answers.icpIndustries ?? [],
    targetRoles:
      profile.targetRoles && profile.targetRoles.length > 0
        ? profile.targetRoles
        : answers.icpRoles ?? [],
    targetCompanySize: profile.targetCompanySize || answers.icpCompanySize || "",
    buyingTriggers:
      profile.buyingTriggers && profile.buyingTriggers.length > 0
        ? profile.buyingTriggers
        : answers.icpBuyingTriggers ?? [],
    marketScope:
      profile.marketScope && profile.marketScope.length > 0
        ? profile.marketScope
        : answers.marketReach ?? [],
    preferredChannels:
      profile.preferredChannels && profile.preferredChannels.length > 0
        ? profile.preferredChannels
        : answers.channelsUsed ?? [],
    exclusions: profile.exclusions || answers.icpExclusions || "",
    tonePreference:
      profile.tonePreference && profile.tonePreference.length > 0
        ? profile.tonePreference
        : answers.brandTones ?? [],
  };
}

/** Computes a deterministic lightweight hash string for cache invalidation. */
export function computeProfileFingerprint(input: {
  profile: GrowthProfile;
  knowledgeDigest: string;
  settings: Pick<Settings, "sender_company" | "sender_name" | "sender_role" | "physical_address">;
  metricsSummary: { leads: number; campaigns: number; sent: number; replies: number; positive: number };
}): string {
  const p = input.profile;
  const payload = JSON.stringify({
    p: {
      whoYouAre: (p.whoYouAre ?? "").trim(),
      whatYouSell: (p.whatYouSell ?? "").trim(),
      industry: (p.industry ?? "").trim(),
      offer: (p.offer ?? "").trim(),
      priceRange: (p.priceRange ?? "").trim(),
      location: (p.location ?? "").trim(),
      idealCustomer: (p.idealCustomer ?? "").trim(),
      businessStage: p.businessStage ?? "",
      businessModel: p.businessModel ?? "",
      pricingStructure: p.pricingStructure ?? "",
      averageDealValue: p.averageDealValue ?? 0,
      targetIndustries: p.targetIndustries ?? [],
      targetRoles: p.targetRoles ?? [],
      targetCompanySize: p.targetCompanySize ?? "",
      buyingTriggers: p.buyingTriggers ?? [],
      marketScope: p.marketScope ?? [],
      salesCycleLength: p.salesCycleLength ?? "",
      preferredChannels: p.preferredChannels ?? [],
      offerCtaStyle: p.offerCtaStyle ?? "",
      primaryGoal: p.primaryGoal ?? "",
      monthlyTargetLeads: p.monthlyTargetLeads ?? 0,
      weeklyOutreachCapacity: p.weeklyOutreachCapacity ?? 0,
      proofAssets: p.proofAssets ?? [],
      exclusions: p.exclusions ?? "",
      tonePreference: p.tonePreference ?? [],
    },
    k: input.knowledgeDigest.slice(0, 1200).trim(),
    s: `${input.settings.sender_company}|${input.settings.sender_name}|${input.settings.physical_address}`,
    m: input.metricsSummary,
  });

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

  const hasIndustry = Boolean(profile.industry.trim() || (profile.targetIndustries?.length ?? 0) > 0);
  if (!hasIndustry) missingFields.push("Industry");

  const hasOffer = Boolean(profile.offer.trim() || hasKnowledge);
  if (!hasOffer) missingFields.push("Core offer");

  const hasPrice = Boolean(profile.priceRange.trim() || profile.pricingStructure || (profile.averageDealValue ?? 0) > 0);
  if (!hasPrice) missingFields.push("Price range");

  const hasLocation = Boolean(profile.location.trim() || (profile.marketScope?.length ?? 0) > 0);
  if (!hasLocation) missingFields.push("Target or base location");

  const bonusChecks = [
    Boolean(profile.businessModel),
    Boolean((profile.targetRoles?.length ?? 0) > 0 || profile.idealCustomer.trim()),
    Boolean((profile.preferredChannels?.length ?? 0) > 0),
    Boolean(profile.primaryGoal),
  ];

  const coreCompleted = 6 - missingFields.length;
  const bonusBoost = Math.min(missingFields.length, Math.floor(bonusChecks.filter(Boolean).length / 2));
  const score = Math.min(100, Math.round(((coreCompleted + bonusBoost) / 6) * 100));

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
