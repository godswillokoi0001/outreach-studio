/**
 * Micro-research before drafting and rewriting.
 *
 * A cold email written from an empty research record is the single biggest
 * source of generic, dishonest copy ("I noticed your website is slow" when
 * nobody ever opened the site). Before composing or rewriting we run a real,
 * cheap Layer-A check on the prospect's public site: live fetch, visible DOM
 * facts, HTTPS, viewport, copyright/CTA signals. Findings are persisted onto
 * the lead so the next draft and the UI both see the same verified evidence.
 *
 * When the site cannot be reached, the record is explicitly marked
 * `limited_public_info` so the model writes an honest observation-free note
 * instead of inventing website flaws.
 */

import { supabaseServer } from "./supabase-server";
import type { Lead, ResearchResult } from "./types";

export type MicroResearchStatus = "verified" | "limited_public_info";

export interface MicroResearchOutcome {
  status: MicroResearchStatus;
  reachable: boolean;
  httpStatus: number;
  finalUrl: string;
  title: string;
  https: boolean;
  hasViewport: boolean;
  websiteFacts: string[];
  findings: ResearchResult["findings"];
  auditEvidence: NonNullable<ResearchResult["audit_evidence"]>;
  hookCandidates: string[];
  summary: string;
  confidence: number;
}

const FREEMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "gmx.com",
  "mail.com",
  "yandex.com",
  "zoho.com",
]);

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** A stored research record is thin when it carries no observed evidence. */
export function isThinResearch(research?: ResearchResult | null): boolean {
  if (!research) return true;
  const hooks = research.personalized_hook_candidates ?? [];
  const audit = research.audit_evidence ?? [];
  const issues = research.verified_site_issues ?? [];
  const findings = research.findings ?? [];
  return (
    research.insufficient_data === true ||
    (hooks.length === 0 && audit.length === 0 && issues.length === 0 && findings.length === 0)
  );
}

export function domainFromEmail(email?: string | null): string | null {
  const clean = (email ?? "").trim().toLowerCase();
  const at = clean.lastIndexOf("@");
  if (at <= 0) return null;
  const domain = clean.slice(at + 1).replace(/[^a-z0-9.-]/g, "");
  if (!domain.includes(".") || FREEMAIL_DOMAINS.has(domain)) return null;
  return domain;
}

/**
 * The site to inspect: the saved website, or (when that is missing) the
 * company domain of a work email. Freemail domains are never inspected.
 */
export function resolveLeadWebsite(lead: Pick<Lead, "website" | "email">): string | null {
  const raw = (lead.website ?? "").trim();
  if (raw) {
    try {
      const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      const parsed = new URL(withScheme);
      if (!parsed.hostname.includes(".")) return null;
      return parsed.toString();
    } catch {
      return null;
    }
  }
  const domain = domainFromEmail(lead.email);
  return domain ? `https://${domain}` : null;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function visibleText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

export interface ParsedSite {
  title: string;
  description: string;
  heading: string;
  hasViewport: boolean;
  copyrightYear: number | null;
  hasPrimaryCta: boolean;
  hasContactLink: boolean;
  hasPhoneLink: boolean;
}

/** Pure Layer-A DOM extraction so the rules can be unit tested. */
export function analyseSiteHtml(html: string): ParsedSite {
  const source = html ?? "";
  const text = visibleText(source);
  const title =
    decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1] ?? "").trim()).slice(0, 180) ||
    (text.split(/[.!?]/)[0] ?? "").slice(0, 120);
  const description = decodeEntities(
    (/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i.exec(source)?.[1] ??
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i.exec(source)?.[1] ??
      "")
      .trim(),
  ).slice(0, 220);
  const heading = decodeEntities(
    (/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(source)?.[1] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  ).slice(0, 160);
  const yearMatch = /(?:©|&copy;|copyright)\s*(?:[^0-9]{0,20})(20\d{2})/i.exec(text);
  return {
    title,
    description,
    heading,
    hasViewport: /<meta[^>]+name=["']viewport["']/i.test(source),
    copyrightYear: yearMatch ? Number(yearMatch[1]) : null,
    hasPrimaryCta:
      /(?:book (?:a |your )?(?:call|appointment|consultation)|schedule (?:a |your )?(?:call|appointment)|get started|request (?:a )?quote|free (?:consultation|quote|audit)|contact us|start (?:a )?project|buy now|add to cart)/i.test(
        text,
      ),
    hasContactLink: /href=["'][^"']*(?:contact|about)[^"']*["']/i.test(source),
    hasPhoneLink: /href=["']tel:/i.test(source),
  };
}

export interface MicroResearchInput {
  business?: string | null;
  website?: string | null;
  email?: string | null;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  nowYear?: number;
  timeoutMs?: number;
}

/**
 * Fetch and analyse a prospect's public site. Never throws: an unreachable or
 * missing site returns an explicit `limited_public_info` outcome.
 */
export async function microResearchSite(input: MicroResearchInput): Promise<MicroResearchOutcome> {
  const nowYear = input.nowYear ?? new Date().getFullYear();
  const website = resolveLeadWebsite({ website: input.website ?? null, email: input.email ?? null });

  if (!website) {
    return {
      status: "limited_public_info",
      reachable: false,
      httpStatus: 0,
      finalUrl: "",
      title: "",
      https: false,
      hasViewport: false,
      websiteFacts: [],
      findings: [],
      auditEvidence: [],
      hookCandidates: [],
      summary:
        "No public website was available for this prospect, so no website observations were made. Write an honest, respectful note without inventing site flaws.",
      confidence: 30,
    };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 4_800);
  let html = "";
  let httpStatus = 0;
  let finalUrl = website;
  let https = website.toLowerCase().startsWith("https://");
  try {
    const response = await fetchImpl(website, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml",
      },
    });
    httpStatus = response.status;
    finalUrl = response.url || website;
    https = finalUrl.toLowerCase().startsWith("https://");
    if (response.ok) {
      html = (await response.text()).slice(0, 300_000);
    }
  } catch {
    html = "";
  } finally {
    clearTimeout(timeout);
  }

  const reachable = Boolean(html) && httpStatus >= 200 && httpStatus < 400;
  if (!reachable) {
    return {
      status: "limited_public_info",
      reachable: false,
      httpStatus,
      finalUrl,
      title: "",
      https,
      hasViewport: false,
      websiteFacts: [],
      findings: [],
      auditEvidence: [],
      hookCandidates: [],
      summary: `The prospect's website (${website}) could not be reached during a live check (HTTP ${httpStatus || "no response"}). Use only public directory facts; do not claim anything about the site.`,
      confidence: 35,
    };
  }

  const parsed = analyseSiteHtml(html);
  const websiteFacts: string[] = [];
  const findings: ResearchResult["findings"] = [];
  const auditEvidence: NonNullable<ResearchResult["audit_evidence"]> = [];

  websiteFacts.push(`Live site reachable at ${finalUrl} (HTTP ${httpStatus}).`);
  if (parsed.title) websiteFacts.push(`Page title: ${parsed.title}.`);
  if (parsed.heading) websiteFacts.push(`Main heading: ${parsed.heading}.`);
  if (parsed.description) websiteFacts.push(`Meta description: ${parsed.description}.`);
  websiteFacts.push(https ? "Served over HTTPS." : "Served over plain HTTP (no TLS).");
  websiteFacts.push(parsed.hasViewport ? "Declares a mobile viewport." : "No mobile viewport meta tag.");

  if (!https) {
    findings.push({
      area: "Security",
      observation: "Site loads over plain HTTP.",
      severity: "medium",
      evidence: `Fetched ${finalUrl} without TLS.`,
    });
    auditEvidence.push({
      evidence_type: "dom_visible",
      issue: "No HTTPS on the public site",
      proof: `${finalUrl} responded over http:// during a live check.`,
    });
  }
  if (!parsed.hasViewport) {
    findings.push({
      area: "Mobile",
      observation: "No viewport meta tag, so the page is not mobile-optimised.",
      severity: "high",
      evidence: "The served HTML has no <meta name=\"viewport\">.",
    });
    auditEvidence.push({
      evidence_type: "dom_visible",
      issue: "Missing mobile viewport",
      proof: "Live HTML contained no viewport meta tag.",
    });
  }
  if (parsed.copyrightYear && parsed.copyrightYear < nowYear - 1) {
    findings.push({
      area: "Freshness",
      observation: `Footer copyright is dated ${parsed.copyrightYear}, so the site looks stale.`,
      severity: "low",
      evidence: `Visible copyright year ${parsed.copyrightYear} against current year ${nowYear}.`,
    });
    auditEvidence.push({
      evidence_type: "dom_visible",
      issue: `Outdated copyright (${parsed.copyrightYear})`,
      proof: `Footer shows © ${parsed.copyrightYear}.`,
    });
  }
  if (!parsed.hasPrimaryCta) {
    findings.push({
      area: "Conversion",
      observation: "No clear primary call to action was visible on the landing page.",
      severity: "medium",
      evidence: "Checked visible text for booking, quote, consultation or contact CTA wording.",
    });
    auditEvidence.push({
      evidence_type: "dom_visible",
      issue: "No obvious primary CTA",
      proof: "Landing page visible text had no booking/quote/consultation CTA.",
    });
  }
  if (!parsed.hasContactLink) {
    findings.push({
      area: "Navigation",
      observation: "No contact/about navigation link was found in the page HTML.",
      severity: "low",
      evidence: "No href containing contact or about was present.",
    });
  }

  const hookCandidates: string[] = [];
  if (parsed.heading && parsed.heading.length >= 8) {
    hookCandidates.push(`Their site leads with "${parsed.heading.slice(0, 90)}".`);
  }
  if (parsed.description && parsed.description.length >= 20) {
    hookCandidates.push(`They describe themselves as: ${parsed.description.slice(0, 120)}.`);
  }
  if (auditEvidence[0]) {
    hookCandidates.push(`Verified site observation: ${auditEvidence[0].issue.toLowerCase()}.`);
  }

  return {
    status: "verified",
    reachable: true,
    httpStatus,
    finalUrl,
    title: parsed.title,
    https,
    hasViewport: parsed.hasViewport,
    websiteFacts,
    findings,
    auditEvidence,
    hookCandidates,
    summary:
      [
        parsed.title ? `${parsed.title}.` : "",
        parsed.description,
        parsed.heading ? `Leads with "${parsed.heading}".` : "",
      ]
        .filter(Boolean)
        .join(" ")
        .slice(0, 600) || `Live site verified at ${finalUrl}.`,
    confidence: auditEvidence.length > 0 ? 78 : 62,
  };
}

/** Merge a fresh micro-research outcome into any previously stored research. */
export function mergeMicroResearch(
  previous: ResearchResult | null | undefined,
  outcome: MicroResearchOutcome,
  lead: Pick<Lead, "business" | "industry" | "location">,
): ResearchResult {
  const base: ResearchResult = previous ?? {
    business_name_confirmed: Boolean(lead.business),
    industry: lead.industry ?? "",
    summary: "",
    website_status: "not_checked",
    website_facts: [],
    verified_facts: [],
    findings: [],
    inferences: [],
    opportunities: [],
    recommended_angle: "",
    confidence: 0,
    insufficient_data: true,
    notes: "",
  };

  const websiteStatus: ResearchResult["website_status"] =
    outcome.status === "limited_public_info"
      ? outcome.httpStatus > 0
        ? "unreachable"
        : "no_site_known"
      : "reachable";

  return {
    ...base,
    business_name_confirmed: base.business_name_confirmed || Boolean(lead.business),
    industry: base.industry || lead.industry || "",
    summary: base.summary && !isThinResearch(base) ? base.summary : outcome.summary,
    website_status: websiteStatus,
    website_facts: Array.from(new Set([...(base.website_facts ?? []), ...outcome.websiteFacts])).slice(0, 12),
    findings: [...(base.findings ?? []), ...outcome.findings].slice(0, 10),
    verified_site_issues: Array.from(
      new Set([
        ...((base.verified_site_issues as string[] | undefined) ?? []),
        ...outcome.auditEvidence.map((e) => `${e.issue}: ${e.proof}`),
      ]),
    ).slice(0, 8),
    personalized_hook_candidates: Array.from(
      new Set([...(base.personalized_hook_candidates ?? []), ...outcome.hookCandidates]),
    ).slice(0, 6),
    audit_evidence: [...((base.audit_evidence as NonNullable<ResearchResult["audit_evidence"]>) ?? []), ...outcome.auditEvidence].slice(
      0,
      6,
    ),
    recommended_angle:
      base.recommended_angle ||
      (outcome.auditEvidence[0]
        ? `Lead with the verified ${outcome.auditEvidence[0].issue.toLowerCase()} and a concrete fix.`
        : "Lead with a specific observation about their business, not generic praise."),
    confidence: Math.max(base.confidence ?? 0, outcome.confidence),
    insufficient_data: outcome.status === "limited_public_info",
    research_status: outcome.status,
    notes: [base.notes, outcome.summary].filter(Boolean).join("\n").slice(0, 1_500),
    checked_at: new Date().toISOString(),
  };
}

/**
 * Run micro-research for a lead when its research is thin, persist the verified
 * findings, and return the enriched lead. Best-effort persistence: a mirror
 * table without the research columns must never block drafting.
 */
export async function ensureLeadMicroResearch(ownerId: string, lead: Lead): Promise<Lead> {
  if (!isThinResearch(lead.research)) return lead;
  let outcome: MicroResearchOutcome;
  try {
    outcome = await microResearchSite({
      business: lead.business,
      website: lead.website,
      email: lead.email,
    });
  } catch {
    return lead;
  }
  const research = mergeMicroResearch(lead.research, outcome, lead);
  const client = supabaseServer;
  if (client) {
    try {
      await client
        .from("leads")
        .update({
          research,
          research_at: new Date().toISOString(),
          research_ok: outcome.status === "verified",
        } as never)
        .eq("id", lead.id)
        .eq("owner_id", ownerId);
    } catch {
      /* mirror table or offline: the enriched record is still used for this draft */
    }
  }
  return { ...lead, research, research_at: new Date().toISOString(), research_ok: outcome.status === "verified" };
}
