import { Type, type Schema } from "@google/genai";
import { buildOrchestratedSystemPrompt } from "./ai/orchestrator";
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
    score: { type: Type.INTEGER, description: "0-100 Module 1 quantitative fit score" },
    tier: { type: Type.STRING, enum: ["A", "B", "C", "DISQUALIFIED"] },
    kill_switch_triggered: { type: Type.BOOLEAN },
    disqualification_reason: { type: Type.STRING, description: "Reason if disqualified, otherwise empty" },
    missing_data: { type: Type.ARRAY, items: { type: Type.STRING } },
    awareness_level: {
      type: Type.STRING,
      enum: ["Unaware", "Problem-Aware", "Solution-Aware", "Product-Aware", "Most-Aware"],
    },
    recommended_template_id: {
      type: Type.STRING,
      enum: ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11", "T12"],
    },
    personalized_hook_candidates: { type: Type.ARRAY, items: { type: Type.STRING } },
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
    "score",
    "tier",
    "kill_switch_triggered",
    "missing_data",
    "awareness_level",
    "recommended_template_id",
    "personalized_hook_candidates",
  ],
};

const RESEARCH_TASK = `Analyze this prospect strictly using Module 1 (Signal-Based Prospecting, Research Waterfall, Quantitative Scoring, Buyer Awareness & Anti-Hallucination Firewall) and the Active User Business Profile.

Mandatory Output Rules:
- Never invent facts, emails, names, social links, stats, or technical/DOM defects not verified in the supplied raw website snapshot or owner notes.
- If no website HTML was supplied, website_status must be "no_site_known" or "not_checked".
- Evaluate ALL Hard Kill-Switches (KILL-1 scope/exclusion trap, KILL-2 inactive/abandoned, KILL-3 invalid/opted-out channel, KILL-4 zero verifiable facts). If ANY triggers, set kill_switch_triggered=true, score=0, tier="DISQUALIFIED", and explain in disqualification_reason.
- Score honestly 0-100 across Fit (0-25), WTP/Budget Proof (0-30), Trigger Timing (0-25), Reachability/Depth (0-20), mapping tier to A (80-100), B (65-79), C (50-64), or DISQUALIFIED (<50).
- List verified facts separately from missing_data (what is still unknown) and inferences.
- Pick exact awareness_level ("Unaware" | "Problem-Aware" | "Solution-Aware" | "Product-Aware" | "Most-Aware"), recommended_template_id ("T1"-"T12"), and 1-3 sharp personalized_hook_candidates grounded ONLY in verified facts.`;

export async function researchLeadServer(
  lead: Lead,
  knowledge: string,
  options?: { model?: string; ownerId?: string },
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

  const orchestrated = await buildOrchestratedSystemPrompt({
    workflow: "research_and_qualify",
    ownerId: options?.ownerId ?? lead.ownerId ?? null,
    knowledgeDigest: knowledge,
    taskInstructions: RESEARCH_TASK,
  });

  const user = `PROSPECT RECORD
Business: ${lead.business ?? "(unknown)"}
Contact: ${lead.contact_name ?? "(unknown)"} ${lead.role ? `(${lead.role})` : ""}
Email: ${lead.email ?? "(none)"}
Location: ${lead.location ?? "(unknown)"}
Industry (from source): ${lead.industry ?? "(unknown)"}
Source notes: ${lead.notes ?? "(none)"}
${lead.extra ? `Extra spreadsheet data: ${lead.extra}` : ""}

${siteBlock}

${manual ? `OWNER-SUPPLIED RESEARCH (treat as reliable observations from the business owner):\n${manual}` : ""}

Run Workflow A (research_and_qualify) and return the complete structured JSON.`;

  const result = await geminiJSON<ResearchResult>({
    system: orchestrated.system,
    user,
    schema: RESEARCH_SCHEMA,
    model: options?.model,
  });

  const killSwitch = Boolean(result.kill_switch_triggered);
  const clampedScore = killSwitch ? 0 : Math.max(0, Math.min(100, Number(result.score ?? result.confidence ?? 0)));

  return {
    ...result,
    score: clampedScore,
    kill_switch_triggered: killSwitch,
    disqualification_reason: killSwitch ? (result.disqualification_reason || "Hard kill-switch triggered.") : null,
    tier: killSwitch
      ? "DISQUALIFIED"
      : clampedScore >= 80
        ? "A"
        : clampedScore >= 65
          ? "B"
          : clampedScore >= 50
            ? "C"
            : "DISQUALIFIED",
    checked_at: new Date().toISOString(),
    technical_signals: snapshot
      ? { ...snapshot.signals, status: snapshot.status, reachable: snapshot.reachable }
      : undefined,
  };
}
