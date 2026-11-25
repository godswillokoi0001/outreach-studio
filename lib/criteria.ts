/**
 * The criteria form shared by Prospect research and Campaigns. Every option
 * list is fixed so the AI receives a clean, comparable brief instead of free
 * text, and the Auto mode has something valid to choose from.
 */

export interface ResearchCriteria {
  industry: string;
  businessSize: string;
  services: string[];
  budget: string;
  onlinePresence: string;
  rating: string;
  count: number;
  minScore: number;
  focus: string;
  /** True when Auto mode chose these values. */
  auto: boolean;
  /** Why Auto mode picked them, shown to the user before running. */
  autoRationale: string;
}

export const INDUSTRY_OPTIONS = [
  "Dentists & dental clinics",
  "Medical clinics & hospitals",
  "Pharmacies",
  "Law firms",
  "Accounting & tax firms",
  "Real estate agencies",
  "Property developers",
  "Microfinance banks",
  "Insurance brokers",
  "Private schools",
  "Training & coaching",
  "Restaurants & cafes",
  "Hotels & hospitality",
  "Beauty salons & spas",
  "Fitness studios",
  "Fashion & retail brands",
  "E-commerce stores",
  "Construction & engineering",
  "Logistics & haulage",
  "Manufacturing",
  "Agriculture & agribusiness",
  "Travel agencies",
  "Event planners",
  "Marketing agencies",
  "NGOs & foundations",
  "Churches & faith organisations",
  "Automotive dealers & repair",
  "Furniture & interiors",
  "Technology startups",
  "Professional consultants",
];

export const BUSINESS_SIZE_OPTIONS = [
  "Solo owner / freelancer",
  "2–10 staff",
  "11–50 staff",
  "51–200 staff",
  "200+ staff",
  "Any size",
];

export const SERVICE_OPTIONS = [
  "Website redesign",
  "Business website development",
  "Landing page",
  "E-commerce website",
  "Brand identity",
  "Graphic design",
  "Video editing",
  "Social media content",
  "Digital presence audit",
  "Website maintenance",
  "SEO",
  "Google Business Profile setup",
];

export const BUDGET_OPTIONS = [
  "Under $500",
  "$500 – $1,500",
  "$1,500 – $5,000",
  "$5,000 – $15,000",
  "$15,000+",
  "Not sure yet",
];

export const ONLINE_PRESENCE_OPTIONS = [
  "No website at all",
  "Social media only",
  "Outdated website",
  "Basic website, rarely updated",
  "Good website, weak marketing",
  "Strong online presence",
  "Any presence",
];

export const RATING_OPTIONS = [
  "No reviews yet",
  "Below 3.0 stars",
  "3.0 – 3.9 stars",
  "4.0 – 4.4 stars",
  "4.5+ stars",
  "Any rating",
];

export const DEFAULT_CRITERIA: ResearchCriteria = {
  industry: "",
  businessSize: "Any size",
  services: [],
  budget: "Not sure yet",
  onlinePresence: "Any presence",
  rating: "Any rating",
  count: 8,
  minScore: 55,
  focus: "",
  auto: false,
  autoRationale: "",
};

export const CRITERIA_OPTION_SETS = {
  industry: INDUSTRY_OPTIONS,
  businessSize: BUSINESS_SIZE_OPTIONS,
  services: SERVICE_OPTIONS,
  budget: BUDGET_OPTIONS,
  onlinePresence: ONLINE_PRESENCE_OPTIONS,
  rating: RATING_OPTIONS,
};

/** Everything the AI needs, written as a short brief. */
export function criteriaToFocus(criteria: ResearchCriteria): string {
  const lines: string[] = [];
  if (criteria.industry) lines.push(`Industry: ${criteria.industry}`);
  if (criteria.businessSize && criteria.businessSize !== "Any size") lines.push(`Business size: ${criteria.businessSize}`);
  if (criteria.services.length) lines.push(`Services we want to pitch: ${criteria.services.join(", ")}`);
  if (criteria.budget && criteria.budget !== "Not sure yet") lines.push(`Budget range: ${criteria.budget}`);
  if (criteria.onlinePresence && criteria.onlinePresence !== "Any presence") {
    lines.push(`Online presence: ${criteria.onlinePresence}`);
  }
  if (criteria.rating && criteria.rating !== "Any rating") lines.push(`Review rating: ${criteria.rating}`);
  if (criteria.focus.trim()) lines.push(`Extra notes: ${criteria.focus.trim()}`);
  return lines.join("\n");
}

export function criteriaSummary(criteria: ResearchCriteria): string[] {
  const chips: string[] = [];
  if (criteria.industry) chips.push(criteria.industry);
  if (criteria.businessSize && criteria.businessSize !== "Any size") chips.push(criteria.businessSize);
  if (criteria.onlinePresence && criteria.onlinePresence !== "Any presence") chips.push(criteria.onlinePresence);
  if (criteria.rating && criteria.rating !== "Any rating") chips.push(criteria.rating);
  if (criteria.budget && criteria.budget !== "Not sure yet") chips.push(criteria.budget);
  for (const service of criteria.services) chips.push(service);
  return chips;
}

/** Keeps whatever the model returned inside the fixed option lists. */
export function sanitizeCriteria(raw: Partial<ResearchCriteria>, base: ResearchCriteria): ResearchCriteria {
  const pick = (value: unknown, options: string[], fallback: string) =>
    typeof value === "string" && options.includes(value) ? value : fallback;

  const services = Array.isArray(raw.services)
    ? raw.services.filter((service): service is string => SERVICE_OPTIONS.includes(String(service))).slice(0, 4)
    : base.services;

  return {
    industry: pick(raw.industry, INDUSTRY_OPTIONS, base.industry),
    businessSize: pick(raw.businessSize, BUSINESS_SIZE_OPTIONS, base.businessSize),
    services,
    budget: pick(raw.budget, BUDGET_OPTIONS, base.budget),
    onlinePresence: pick(raw.onlinePresence, ONLINE_PRESENCE_OPTIONS, base.onlinePresence),
    rating: pick(raw.rating, RATING_OPTIONS, base.rating),
    count:
      typeof raw.count === "number" && Number.isFinite(raw.count)
        ? Math.max(3, Math.min(20, Math.round(raw.count)))
        : base.count,
    minScore:
      typeof raw.minScore === "number" && Number.isFinite(raw.minScore)
        ? Math.max(0, Math.min(100, Math.round(raw.minScore)))
        : base.minScore,
    focus: typeof raw.focus === "string" ? raw.focus.slice(0, 600) : base.focus,
    auto: typeof raw.auto === "boolean" ? raw.auto : base.auto,
    autoRationale: typeof raw.autoRationale === "string" ? raw.autoRationale.slice(0, 600) : base.autoRationale,
  };
}
