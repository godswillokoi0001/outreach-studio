import type { AppUser } from "./auth";

export type WorkMode = "solo" | "team" | "agency";
export type MarketReach = "local" | "national" | "international";
export type PrimaryObjective = "leads" | "sales" | "bookings" | "awareness";

export interface OnboardingAnswers {
  // Screen 2: About you
  fullName: string;
  email: string;
  photoUrl: string;
  roleTitle: string;
  workMode: WorkMode | "";

  // Screen 3: Your business
  businessName: string;
  website: string;
  industry: string;
  yearStarted: string;
  companySize: string;
  businessLocation: string;

  // Screen 4: What you do
  businessDescription: string;
  mainServices: string[];
  customServiceInput: string;
  mainProblemSolved: string;

  // Screen 5: Your offer
  priceRange: string;
  differentiators: string;
  proof: string;
  hasGuarantee: boolean;
  guaranteeDetails: string;

  // Screen 6: Ideal customer
  idealCustomerSummary: string;
  icpIndustries: string[];
  icpRoles: string[];
  icpCompanySize: string;
  icpLocation: string;
  icpPainPoints: string;
  icpBuyingTriggers: string[];
  icpExclusions: string;

  // Screen 7: Markets and locations
  marketReach: MarketReach[];
  currentMarkets: string;
  expansionMarkets: string;

  // Screen 8: Goals
  primaryObjective: PrimaryObjective | "";
  targetNumber: number;
  targetMetricLabel: string;
  timeline: string;
  monthlyBudget: number;

  // Screen 9: Marketing so far
  channelsUsed: string[];
  whatWorked: string;
  whatDidntWork: string;
  toolsInUse: string[];

  // Screen 10: Brand and voice
  brandTones: string[];
  wordsToUse: string;
  wordsToAvoid: string;
  sampleMessages: string;

  // Screen 11: Online presence
  linkedinUrl: string;
  xUrl: string;
  instagramUrl: string;
  facebookUrl: string;
  youtubeUrl: string;
  tiktokUrl: string;
  bookingOrPortfolioUrl: string;
  logoDataUrl: string;
  uploadedSourceNames: string[];
}

export const DEFAULT_ONBOARDING_ANSWERS: OnboardingAnswers = {
  fullName: "",
  email: "",
  photoUrl: "",
  roleTitle: "",
  workMode: "",
  businessName: "",
  website: "",
  industry: "",
  yearStarted: "",
  companySize: "",
  businessLocation: "",
  businessDescription: "",
  mainServices: [],
  customServiceInput: "",
  mainProblemSolved: "",
  priceRange: "",
  differentiators: "",
  proof: "",
  hasGuarantee: false,
  guaranteeDetails: "",
  idealCustomerSummary: "",
  icpIndustries: [],
  icpRoles: [],
  icpCompanySize: "",
  icpLocation: "",
  icpPainPoints: "",
  icpBuyingTriggers: [],
  icpExclusions: "",
  marketReach: [],
  currentMarkets: "",
  expansionMarkets: "",
  primaryObjective: "",
  targetNumber: 20,
  targetMetricLabel: "qualified leads / month",
  timeline: "90 days",
  monthlyBudget: 1000,
  channelsUsed: [],
  whatWorked: "",
  whatDidntWork: "",
  toolsInUse: [],
  brandTones: [],
  wordsToUse: "",
  wordsToAvoid: "",
  sampleMessages: "",
  linkedinUrl: "",
  xUrl: "",
  instagramUrl: "",
  facebookUrl: "",
  youtubeUrl: "",
  tiktokUrl: "",
  bookingOrPortfolioUrl: "",
  logoDataUrl: "",
  uploadedSourceNames: [],
};

export interface OnboardingState {
  status: "not_started" | "in_progress" | "completed";
  currentStep: number;
  answers: OnboardingAnswers;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
}

export type SectionProvenance = "ai_generated" | "user_edited";

export interface KnowledgeSection {
  id: string;
  key: string;
  title: string;
  content: string;
  provenance: SectionProvenance;
  updatedAt: string;
  missingGaps?: string[];
}

export interface KnowledgeVersion {
  id: string;
  timestamp: string;
  summary: string;
  authorNote: string;
  sections: KnowledgeSection[];
}

export interface StructuredKnowledgeBase {
  sections: KnowledgeSection[];
  missingGaps: string[];
  versions: KnowledgeVersion[];
  generatedAt?: string;
  updatedAt: string;
}

export const KB_SECTION_TEMPLATES: { key: string; title: string }[] = [
  { key: "business_overview", title: "Business overview" },
  { key: "products_services", title: "Products and services" },
  { key: "offer_pricing", title: "Offer, pricing and differentiators" },
  { key: "ideal_customer", title: "Ideal customer profile and exclusions" },
  { key: "markets_locations", title: "Target markets and locations" },
  { key: "goals_budget", title: "Goals and budget" },
  { key: "brand_voice", title: "Brand voice and messaging guidelines" },
  { key: "past_marketing", title: "Past marketing performance" },
  { key: "proof_credibility", title: "Proof and credibility" },
  { key: "online_presence", title: "Online presence" },
];

export function prefillAnswersFromUser(base: OnboardingAnswers, user: AppUser | null): OnboardingAnswers {
  if (!user) return base;
  return {
    ...base,
    fullName: base.fullName || user.displayName || "",
    email: base.email || user.email || "",
    photoUrl: base.photoUrl || user.photoURL || "",
  };
}

export function validateUrlStrict(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true; // optional empty is valid
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withProto);
    return Boolean(parsed.hostname && parsed.hostname.includes("."));
  } catch {
    return false;
  }
}

export function normalizeUrlInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function compileSectionsToMasterMarkdown(sections: KnowledgeSection[]): string {
  return sections
    .map((section) => `## ${section.title}\n\n${section.content.trim() || "Not provided."}`)
    .join("\n\n---\n\n");
}

export function computeOnboardingCompleteness(
  answers: OnboardingAnswers,
  structuredKb?: StructuredKnowledgeBase | null,
): {
  score: number;
  missingEssentials: string[];
  missingNiceToHave: string[];
  isEssentialsComplete: boolean;
} {
  const checks: { label: string; filled: boolean; essential: boolean }[] = [
    { label: "Full name & role", filled: Boolean(answers.fullName.trim() && answers.roleTitle.trim()), essential: true },
    { label: "Business name & industry", filled: Boolean(answers.businessName.trim() && answers.industry.trim()), essential: true },
    { label: "Business location", filled: Boolean(answers.businessLocation.trim()), essential: false },
    { label: "What you do & main services", filled: Boolean(answers.businessDescription.trim() || answers.mainServices.length > 0), essential: true },
    { label: "Problem you solve", filled: Boolean(answers.mainProblemSolved.trim()), essential: false },
    { label: "Pricing & differentiators", filled: Boolean(answers.priceRange.trim() || answers.differentiators.trim()), essential: true },
    { label: "Proof & results", filled: Boolean(answers.proof.trim()), essential: false },
    { label: "Ideal customer profile", filled: Boolean(answers.idealCustomerSummary.trim() || answers.icpRoles.length > 0 || answers.icpPainPoints.trim()), essential: true },
    { label: "Target markets & locations", filled: Boolean(answers.currentMarkets.trim() || answers.expansionMarkets.trim() || answers.marketReach.length > 0), essential: false },
    { label: "Goals & timeline", filled: Boolean(answers.primaryObjective), essential: false },
    { label: "Brand voice & tone", filled: Boolean(answers.brandTones.length > 0 || answers.sampleMessages.trim()), essential: false },
    { label: "Website or online presence", filled: Boolean(answers.website.trim() || answers.linkedinUrl.trim()), essential: false },
  ];

  let score = Math.round((checks.filter((c) => c.filled).length / checks.length) * 100);
  const missingEssentials = checks.filter((c) => c.essential && !c.filled).map((c) => c.label);
  const missingNiceToHave = checks.filter((c) => !c.essential && !c.filled).map((c) => c.label);

  // If user directly filled structured KB sections even if onboarding fields were short, credit them cleanly
  if (structuredKb && structuredKb.sections.length >= 6) {
    const nonEmptySections = structuredKb.sections.filter(
      (s) => s.content.trim() && !/^not provided\.?$/i.test(s.content.trim()),
    ).length;
    const kbScore = Math.round((nonEmptySections / KB_SECTION_TEMPLATES.length) * 100);
    score = Math.max(score, kbScore);
  }

  return {
    score,
    missingEssentials,
    missingNiceToHave,
    isEssentialsComplete: missingEssentials.length === 0,
  };
}
