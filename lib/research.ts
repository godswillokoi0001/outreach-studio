import { Type, type Schema } from "@google/genai";
import { normalizeWebsite } from "./columns";
import { geminiJSON } from "./gemini";
import { isFetchableUrl } from "./outreach-utils";
import type { Lead, ResearchResult } from "./types";

export interface SiteSnapshot {
  url: string;
  reachable: boolean;
  status: number;
  finalUrl: string;
  title: string;
  description: string;
  text: string;
  signals: {
    https: boolean;
    hasViewport: boolean;
    hasContactForm: boolean;
    hasPhoneLink: boolean;
    hasEmailLink: boolean;
    ctaPhrases: string[];
    h1: string;
    socialLinks: number;
    copyrightYear: number | null;
    platform: string | null;
    wordCount: number;
  };
  error?: string;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

const CTA_WORDS = [
  "contact us",
  "get started",
  "request a quote",
  "book a call",
  "book now",
  "apply now",
  "learn more",
  "call now",
  "enquire",
  "inquire",
  "get a quote",
  "schedule",
  "sign up",
  "speak to us",
  "send message",
];

export async function fetchSite(website: string | null): Promise<SiteSnapshot | null> {
  const url = website ? normalizeWebsite(website) : null;
  if (!url || !isFetchableUrl(url)) return null;

  const signals: SiteSnapshot["signals"] = {
    https: url.startsWith("https://"),
    hasViewport: false,
    hasContactForm: false,
    hasPhoneLink: false,
    hasEmailLink: false,
    ctaPhrases: [],
    h1: "",
    socialLinks: 0,
    copyrightYear: null,
    platform: null,
    wordCount: 0,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.8",
      },
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("html")) {
      return {
        url,
        reachable: res.ok,
        status: res.status,
        finalUrl: res.url || url,
        title: "",
        description: "",
        text: "",
        signals,
        error: `Response was not HTML (${contentType || "unknown content type"}).`,
      };
    }
    const html = (await res.text()).slice(0, 400_000);
    const lower = html.toLowerCase();
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim().slice(0, 200);
    const description = (
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] ??
      html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i)?.[1] ??
      ""
    )
      .trim()
      .slice(0, 400);
    const text = stripHtml(html).slice(0, 12_000);
    const linkText = (html.match(/<(a|button)[^>]*>([\s\S]{0,120}?)<\/\1>/gi) ?? [])
      .map((chunk) => stripHtml(chunk).toLowerCase())
      .join(" | ");

    signals.hasViewport = /<meta[^>]+name=["']viewport["']/i.test(html);
    signals.hasContactForm = /<form[\s\S]{0,4000}?<\/form>/i.test(html);
    signals.hasPhoneLink = /href=["']tel:/i.test(html);
    signals.hasEmailLink = /href=["']mailto:/i.test(html);
    signals.ctaPhrases = CTA_WORDS.filter((phrase) => linkText.includes(phrase)).slice(0, 6);
    signals.h1 = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "").slice(0, 160);
    signals.socialLinks = (
      lower.match(/facebook\.com|instagram\.com|linkedin\.com|twitter\.com|x\.com|youtube\.com/g) ?? []
    ).length;
    const copyright = html.match(/(?:©|&copy;|copyright)\s*(\d{4})/i);
    signals.copyrightYear = copyright ? Number(copyright[1]) : null;
    signals.wordCount = text.split(/\s+/).filter(Boolean).length;
    if (lower.includes("wp-content")) signals.platform = "WordPress";
    else if (lower.includes("wixstatic") || lower.includes("wix.com")) signals.platform = "Wix";
    else if (lower.includes("squarespace")) signals.platform = "Squarespace";
    else if (lower.includes("shopify")) signals.platform = "Shopify";
    else if (lower.includes("webflow")) signals.platform = "Webflow";
    else if (lower.includes("godaddysites")) signals.platform = "GoDaddy Website Builder";
    else if (lower.includes("blogger.com") || lower.includes("blogspot")) signals.platform = "Blogger";

    return {
      url,
      reachable: res.ok,
      status: res.status,
      finalUrl: res.url || url,
      title,
      description,
      text,
      signals,
    };
  } catch (err) {
    return {
      url,
      reachable: false,
      status: 0,
      finalUrl: url,
      title: "",
      description: "",
      text: "",
      signals,
      error: err instanceof Error ? err.message : "Website could not be reached.",
    };
  } finally {
    clearTimeout(timer);
  }
}

const RESEARCH_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    business_name_confirmed: { type: Type.BOOLEAN },
    industry: { type: Type.STRING },
    summary: { type: Type.STRING, description: "2-4 sentences describing what the business does, for whom." },
    website_status: { type: Type.STRING, enum: ["no_site_known", "unreachable", "reachable", "not_checked"] },
    website_facts: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Concrete observations from the fetched website data only.",
    },
    verified_facts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { fact: { type: Type.STRING }, source: { type: Type.STRING } },
        required: ["fact", "source"],
      },
    },
    findings: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          area: { type: Type.STRING },
          observation: { type: Type.STRING },
          severity: { type: Type.STRING, enum: ["low", "medium", "high"] },
          evidence: { type: Type.STRING },
        },
        required: ["area", "observation", "severity", "evidence"],
      },
    },
    inferences: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Unverified reasoning, clearly labelled as inference.",
    },
    opportunities: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          opportunity: { type: Type.STRING },
          service: { type: Type.STRING },
          rationale: { type: Type.STRING },
        },
        required: ["opportunity", "service", "rationale"],
      },
    },
    recommended_angle: { type: Type.STRING },
    confidence: { type: Type.INTEGER },
    insufficient_data: { type: Type.BOOLEAN },
    notes: { type: Type.STRING },
  },
  required: [
    "business_name_confirmed",
    "industry",
    "summary",
    "website_status",
    "website_facts",
    "verified_facts",
    "findings",
    "inferences",
    "opportunities",
    "recommended_angle",
    "confidence",
    "insufficient_data",
    "notes",
  ],
};

const RESEARCH_SYSTEM = `You are a B2B prospect researcher working for the business described in the knowledge base you are given.

Your job is to establish what is actually true about a prospect business, using only the material provided. You are honest about the limits of the evidence.

Hard rules:
- Never invent facts. If the provided website data does not show something, do not claim it.
- Only state a website problem when the provided website data shows it. Quote or point to the specific evidence in the evidence field.
- If no website HTML was supplied, website_status must be "no_site_known" (never seen one) or "not_checked". Never claim the site is broken, outdated, slow or insecure without evidence.
- Separate verified facts (seen in the data) from inferences (your reasoning).
- Findings must be about communication, clarity, credibility and customer acquisition - the kinds of problem the sender's services can fix.
- Do not comment on prices, revenue, staff, ownership or anything personal.
- If there is not enough information to say anything useful, set insufficient_data to true and keep confidence below 40.
- confidence is 0-100 and reflects the quality of evidence available, not how promising the prospect is.
- recommended_angle is one sentence: the specific, evidence-backed reason to contact this business.
- services must be named using the sender's own service names from the knowledge base where possible.`;

export async function researchLeadServer(
  lead: Lead,
  knowledge: string,
  options?: { model?: string },
): Promise<ResearchResult> {
  const snapshot = await fetchSite(lead.website);
  const manual = (lead.manual_research ?? "").trim();

  const siteBlock = snapshot
    ? `WEBSITE CHECK (live fetch just now)
URL: ${snapshot.url}
Final URL: ${snapshot.finalUrl}
Reachable: ${snapshot.reachable} (HTTP ${snapshot.status})${snapshot.error ? ` - ${snapshot.error}` : ""}
Title: ${snapshot.title || "(none)"}
Meta description: ${snapshot.description || "(none)"}
H1: ${snapshot.signals.h1 || "(none)"}
HTTPS: ${snapshot.signals.https}
Mobile viewport meta tag: ${snapshot.signals.hasViewport}
Contact form present: ${snapshot.signals.hasContactForm}
Telephone link: ${snapshot.signals.hasPhoneLink}
Email link: ${snapshot.signals.hasEmailLink}
Call-to-action phrases found: ${snapshot.signals.ctaPhrases.join(", ") || "(none)"}
Social links found: ${snapshot.signals.socialLinks}
Footer copyright year: ${snapshot.signals.copyrightYear ?? "(not found)"}
Detected platform: ${snapshot.signals.platform ?? "(unknown)"}
Approximate word count on homepage: ${snapshot.signals.wordCount}

PAGE TEXT (truncated to 8000 characters):
${snapshot.text.slice(0, 8000)}`
    : `WEBSITE CHECK: none available. ${lead.website ? "The stored URL could not be fetched." : "No website URL is stored for this prospect."}`;

  const user = `${knowledge ? `BUSINESS KNOWLEDGE BASE\n${knowledge}\n\n` : ""}PROSPECT RECORD
Business: ${lead.business ?? "(unknown)"}
Contact: ${lead.contact_name ?? "(unknown)"} ${lead.role ? `(${lead.role})` : ""}
Email: ${lead.email ?? "(none)"}
Location: ${lead.location ?? "(unknown)"}
Industry (from source): ${lead.industry ?? "(unknown)"}
Source notes: ${lead.notes ?? "(none)"}
${lead.extra ? `Extra spreadsheet data: ${lead.extra}` : ""}

${siteBlock}

${manual ? `OWNER-SUPPLIED RESEARCH (treat as reliable observations from the business owner):\n${manual}` : ""}

Research this business for a web design / digital services outreach decision.`;

  const result = await geminiJSON<ResearchResult>({
    system: RESEARCH_SYSTEM,
    user,
    schema: RESEARCH_SCHEMA,
    model: options?.model,
  });

  return {
    ...result,
    checked_at: new Date().toISOString(),
    technical_signals: snapshot
      ? { ...snapshot.signals, status: snapshot.status, reachable: snapshot.reachable }
      : undefined,
  };
}
