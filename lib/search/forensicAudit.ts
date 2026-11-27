import { Type, type Schema } from "@google/genai";
import { normalizeWebsite } from "@/lib/columns";
import { LLMGateway } from "@/lib/llm/gateway";
import { isFetchableUrl } from "@/lib/outreach-utils";
import type { AuditEvidenceItem } from "@/lib/types";
import { checkMobilePageSpeed, type PageSpeedMetrics } from "./pagespeed";
import { getCachedSearchEnrichment, setCachedSearchEnrichment } from "./quotaAndCache";
import { decodeHtmlEntities } from "./siteInspector";

const AUDIT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const FREE_SUBDOMAIN_HOSTS: { pattern: RegExp; platform: string }[] = [
  { pattern: /(?:^|\.)carrd\.co$/i, platform: "Carrd free subdomain" },
  { pattern: /(?:^|\.)wixsite\.com$/i, platform: "Wix free subdomain" },
  { pattern: /(?:^|\.)blogspot\.com$/i, platform: "Blogger free subdomain" },
  { pattern: /(?:^|\.)wordpress\.com$/i, platform: "WordPress.com free subdomain" },
  { pattern: /(?:^|\.)weebly\.com$/i, platform: "Weebly free subdomain" },
  { pattern: /(?:^|\.)sites\.google\.com$/i, platform: "Google Sites free subdomain" },
  { pattern: /(?:^|\.)godaddysites\.com$/i, platform: "GoDaddy builder free subdomain" },
  { pattern: /(?:^|\.)linktr\.ee$/i, platform: "Linktree profile" },
  { pattern: /(?:^|\.)bio\.site$/i, platform: "Bio.site profile" },
];

const PLACEHOLDER_TOKENS = [
  "lorem ipsum",
  "dolor sit amet",
  "coming soon",
  "under construction",
  "site under maintenance",
  "sample text",
  "insert your text",
];

const ABOVE_FOLD_CTA_RE =
  /\b(book|schedule|call|quote|estimate|contact|get started|request|appointment|consult|free look|demo|buy now|order now)\b/i;

export interface BrokenNavLink {
  url: string;
  label: string;
  status: number | "network_error";
}

export interface VisibleDomAnalysis {
  visibleText: string;
  visiblePlaceholders: string[];
  hiddenDomOnlyArtifacts: string[];
  hasViewportMeta: boolean;
  hasH1: boolean;
  h1Text: string;
  title: string;
  ctaCountAboveFold: number;
  hasClickablePhone: boolean;
  hasClickableEmail: boolean;
  copyrightYear: number | null;
}

export interface ForensicAuditResult {
  url: string;
  finalUrl: string;
  reachable: boolean;
  httpStatus: number;
  failureKind: "ok" | "dead_site" | "temp_timeout" | "blocked" | "not_checked";
  redirected: boolean;
  isHttps: boolean;
  freeSubdomainPlatform: string | null;
  brokenLinks: BrokenNavLink[];
  dom: VisibleDomAnalysis;
  lighthouse: PageSpeedMetrics | null;
  mobileScreenshotUrl: string | null;
  auditEvidence: AuditEvidenceItem[];
  siteLooksSolid: boolean;
  overallVerdict: string;
  checkedAt: string;
}

export function detectFreeSubdomainPlatform(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const item of FREE_SUBDOMAIN_HOSTS) {
      if (item.pattern.test(host)) return item.platform;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Strips scripts, styles, templates, hidden/aria-hidden containers, and inline
 * `display:none` / `visibility:hidden` elements so invisible theme markup (like
 * unused template `Lorem ipsum`) is NEVER reported as visible site text.
 */
export function extractVisibleDom(html: string): VisibleDomAnalysis {
  const withoutHiddenBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Strip common self-contained hidden elements cleanly
    .replace(
      /<(div|section|span|p|aside|li|ul|nav|footer|a)[^>]*(?:\bhidden\b|aria-hidden\s*=\s*["']true["']|style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"']*["'])[^>]*>[\s\S]*?<\/\1>/gi,
      " ",
    );

  const visibleText = decodeHtmlEntities(
    withoutHiddenBlocks
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ).slice(0, 12_000);

  const visibleLower = visibleText.toLowerCase();
  const rawLower = html.toLowerCase();

  const visiblePlaceholders: string[] = [];
  const hiddenDomOnlyArtifacts: string[] = [];
  for (const token of PLACEHOLDER_TOKENS) {
    if (visibleLower.includes(token)) {
      visiblePlaceholders.push(token);
    } else if (rawLower.includes(token)) {
      hiddenDomOnlyArtifacts.push(`hidden_dom_only:${token}`);
    }
  }

  const title = decodeHtmlEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").slice(0, 200));
  const h1Raw = withoutHiddenBlocks.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "";
  const h1Text = decodeHtmlEntities(h1Raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 160);
  const hasViewportMeta = /<meta[^>]+name=["']viewport["']/i.test(html);
  const hasClickablePhone = /href=["']tel:[^"']{5,}["']/i.test(html);
  const hasClickableEmail = /href=["']mailto:[^"']+@[^"']+["']/i.test(html);

  const aboveFoldHtml = withoutHiddenBlocks.slice(0, 7_500);
  const ctaMatches = aboveFoldHtml.match(/<(?:a|button)[^>]*>([\s\S]{1,120}?)<\/(?:a|button)>/gi) ?? [];
  const ctaCountAboveFold = ctaMatches.filter((chunk) =>
    ABOVE_FOLD_CTA_RE.test(chunk.replace(/<[^>]+>/g, " ")),
  ).length;

  const yearMatches = Array.from(visibleText.matchAll(/(?:©|copyright|\(c\))\s*(20\d{2})\b/gi))
    .map((m) => Number(m[1]))
    .filter((y) => y >= 2000 && y <= new Date().getUTCFullYear() + 1);
  const copyrightYear = yearMatches.length > 0 ? Math.max(...yearMatches) : null;

  return {
    visibleText,
    visiblePlaceholders,
    hiddenDomOnlyArtifacts,
    hasViewportMeta,
    hasH1: h1Text.length > 0,
    h1Text,
    title,
    ctaCountAboveFold,
    hasClickablePhone,
    hasClickableEmail,
    copyrightYear,
  };
}

/**
 * Checks up to 10 `<header>`, `<nav>`, and primary CTA links in parallel (3s cap per link)
 * using HEAD with GET fallback on 405/501. Ignores 403 bot walls; reports only 404/410/5xx/network.
 */
export async function checkBrokenLinksParallel(
  baseUrl: string,
  html: string,
  maxLinks = 10,
): Promise<BrokenNavLink[]> {
  let baseOrigin = "";
  try {
    baseOrigin = new URL(baseUrl).origin;
  } catch {
    return [];
  }

  const navSections = [
    ...(html.match(/<header[\s\S]*?<\/header>/gi) ?? []),
    ...(html.match(/<nav[\s\S]*?<\/nav>/gi) ?? []),
    html.slice(0, 8_000),
  ].join("\n");

  const linkRe = /<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi;
  const seen = new Set<string>();
  const candidates: { url: string; label: string }[] = [];

  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(navSections)) !== null) {
    const rawHref = (m[1] ?? "").trim();
    if (!rawHref || /^(?:mailto:|tel:|javascript:|data:)/i.test(rawHref)) continue;
    try {
      const resolved = new URL(rawHref, baseUrl);
      if (resolved.origin !== baseOrigin) continue;
      if (!isFetchableUrl(resolved.toString())) continue;
      const clean = resolved.toString().replace(/#.*$/, "");
      if (seen.has(clean) || clean === baseUrl.replace(/#.*$/, "")) continue;
      seen.add(clean);
      const label = decodeHtmlEntities((m[2] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()) || resolved.pathname;
      candidates.push({ url: clean, label: label.slice(0, 60) });
      if (candidates.length >= maxLinks) break;
    } catch {
      /* ignore invalid href */
    }
  }

  if (candidates.length === 0) return [];

  const results = await Promise.all(
    candidates.map(async (item): Promise<BrokenNavLink | null> => {
      const probe = async (method: "HEAD" | "GET") => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3_000);
        try {
          return await fetch(item.url, {
            method,
            redirect: "follow",
            headers: { "User-Agent": AUDIT_UA },
            signal: controller.signal,
            cache: "no-store",
          });
        } finally {
          clearTimeout(timer);
        }
      };

      try {
        let res = await probe("HEAD");
        if (res.status === 405 || res.status === 501) {
          res = await probe("GET");
        }
        // Ignore 403/401/429 WAF/bot walls; flag genuine 404/410/5xx dead links
        if (res.status === 404 || res.status === 410 || res.status >= 500) {
          return { url: item.url, label: item.label, status: res.status };
        }
        return null;
      } catch {
        // Do not mark abort timeouts as broken 404s unless clear network/DNS failure
        return null;
      }
    }),
  );

  return results.filter((x): x is BrokenNavLink => x !== null);
}

const VISION_AUDIT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    siteLooksSolid: { type: Type.BOOLEAN },
    overallVerdict: { type: Type.STRING },
    issues: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          issue: { type: Type.STRING },
          evidence_type: {
            type: Type.STRING,
            enum: ["lighthouse", "broken_link", "dom_visible", "vision_screenshot"],
          },
          proof: { type: Type.STRING },
        },
        required: ["issue", "evidence_type", "proof"],
      },
    },
  },
  required: ["siteLooksSolid", "overallVerdict", "issues"],
};

function parseDataUrlBase64(dataUrl: string): { mimeType: string; dataBase64: string } | null {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], dataBase64: match[2] };
}

function buildDeterministicAuditEvidence(input: {
  isHttps: boolean;
  failureKind: ForensicAuditResult["failureKind"];
  httpStatus: number;
  freeSubdomainPlatform: string | null;
  brokenLinks: BrokenNavLink[];
  dom: VisibleDomAnalysis;
  lighthouse: PageSpeedMetrics | null;
}): { auditEvidence: AuditEvidenceItem[]; siteLooksSolid: boolean; overallVerdict: string } {
  const items: AuditEvidenceItem[] = [];

  if (input.failureKind === "dead_site") {
    items.push({
      issue: `Website returned HTTP ${input.httpStatus || "error"} and could not be loaded cleanly.`,
      evidence_type: "broken_link",
      proof: `Live HTTP check returned status ${input.httpStatus || "unreachable"}`,
    });
  }

  if (input.brokenLinks.length > 0) {
    const first = input.brokenLinks[0];
    items.push({
      issue: `Header/navigation link "${first.label}" leads to HTTP ${first.status}.`,
      evidence_type: "broken_link",
      proof: `${first.url} -> HTTP ${first.status}`,
    });
  }

  if (input.dom.visiblePlaceholders.length > 0) {
    items.push({
      issue: `Visible page copy still contains unfinished placeholder text ("${input.dom.visiblePlaceholders[0]}").`,
      evidence_type: "dom_visible",
      proof: `Visible DOM matched "${input.dom.visiblePlaceholders[0]}"`,
    });
  }

  if (input.lighthouse && input.lighthouse.mobileScore < 65) {
    const lcpPart =
      input.lighthouse.lcpSeconds !== null ? `, LCP ${input.lighthouse.lcpSeconds}s` : "";
    const topAudit = input.lighthouse.failedAudits[0];
    items.push({
      issue: `Mobile PageSpeed scores ${input.lighthouse.mobileScore}/100${lcpPart}${
        topAudit ? ` (${topAudit.title}${topAudit.displayValue ? `: ${topAudit.displayValue}` : ""})` : ""
      }.`,
      evidence_type: "lighthouse",
      proof: `Lighthouse Mobile Performance ${input.lighthouse.mobileScore}/100${lcpPart}`,
    });
  } else if (!input.dom.hasViewportMeta && input.failureKind === "ok") {
    items.push({
      issue: "Page HTML is missing a mobile <meta name=\"viewport\"> tag.",
      evidence_type: "dom_visible",
      proof: "HTML head lacks <meta name=\"viewport\">",
    });
  } else if (!input.isHttps && input.failureKind === "ok") {
    items.push({
      issue: "Website loads over unencrypted HTTP instead of HTTPS.",
      evidence_type: "dom_visible",
      proof: "Final URL protocol is http://",
    });
  } else if (input.freeSubdomainPlatform && items.length < 2) {
    items.push({
      issue: `Site runs on a free ${input.freeSubdomainPlatform} URL instead of a standalone custom domain.`,
      evidence_type: "dom_visible",
      proof: input.freeSubdomainPlatform,
    });
  } else if (!input.dom.hasClickablePhone && input.dom.ctaCountAboveFold === 0 && items.length < 2) {
    items.push({
      issue: "Above-the-fold view has no clickable tap-to-call link or primary action button.",
      evidence_type: "dom_visible",
      proof: `ctaCountAboveFold=0, hasClickablePhone=false`,
    });
  }

  const trimmed = items.slice(0, 2);
  const mobileHealthy = !input.lighthouse || input.lighthouse.mobileScore >= 80;
  const siteLooksSolid =
    input.failureKind === "ok" &&
    input.isHttps &&
    input.brokenLinks.length === 0 &&
    input.dom.visiblePlaceholders.length === 0 &&
    mobileHealthy &&
    trimmed.length === 0;

  return {
    auditEvidence: trimmed,
    siteLooksSolid,
    overallVerdict: siteLooksSolid
      ? "Site looks solid / low friction — low redesign priority"
      : trimmed[0]?.issue ?? "Minor usability improvements possible",
  };
}

/**
 * 3-Layer Forensic Website Auditor:
 * Layer A: Deterministic DOM + broken nav/CTA link checker + strict hidden-vs-visible isolation
 * Layer B: Google PageSpeed Insights (Mobile + Accessibility + SEO + real mobile screenshot) + optional Cloudflare/ScreenshotOne fallback
 * Layer C: Multimodal Gemini Flash Vision inspection over the rendered mobile screenshot + deterministic facts JSON
 */
export async function runForensicWebsiteAudit(
  rawUrl: string | null | undefined,
  options?: {
    ownerId?: string | null;
    runVision?: boolean;
    checkLinks?: boolean;
    timeoutMs?: number;
    skipLlm?: boolean;
    bypassCache?: boolean;
  },
): Promise<ForensicAuditResult | null> {
  const url = rawUrl ? normalizeWebsite(rawUrl) : null;
  if (!url || !isFetchableUrl(url)) return null;

  const cacheKey = `forensic:v1:${url.toLowerCase().replace(/\/+$/, "")}`;
  if (!options?.bypassCache) {
    const cached = await getCachedSearchEnrichment<ForensicAuditResult>(cacheKey);
    if (cached) return cached;
  }

  let html = "";
  let finalUrl = url;
  let httpStatus = 0;
  let reachable = false;
  let failureKind: ForensicAuditResult["failureKind"] = "ok";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 6_500);

  // Start Layer B (PageSpeed + mobile screenshot) immediately in parallel with Layer A HTML fetch
  const lighthousePromise = checkMobilePageSpeed(url, {
    timeoutMs: 12_000,
    bypassCache: options?.bypassCache,
  }).catch(() => null);

  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": AUDIT_UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: controller.signal,
      cache: "no-store",
    });
    httpStatus = res.status;
    finalUrl = res.url || url;
    html = (await res.text()).slice(0, 260_000);
    if (res.ok) {
      reachable = true;
      failureKind = "ok";
    } else if (res.status === 403 || res.status === 429) {
      failureKind = "blocked";
    } else {
      failureKind = "dead_site";
    }
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    failureKind = isAbort ? "temp_timeout" : "dead_site";
  } finally {
    clearTimeout(timer);
  }

  const isHttps = finalUrl.startsWith("https://");
  const freeSubdomainPlatform = detectFreeSubdomainPlatform(finalUrl);
  const dom = html
    ? extractVisibleDom(html)
    : {
        visibleText: "",
        visiblePlaceholders: [],
        hiddenDomOnlyArtifacts: [],
        hasViewportMeta: false,
        hasH1: false,
        h1Text: "",
        title: "",
        ctaCountAboveFold: 0,
        hasClickablePhone: false,
        hasClickableEmail: false,
        copyrightYear: null,
      };

  const [brokenLinks, lighthouse] = await Promise.all([
    html && options?.checkLinks !== false && reachable
      ? checkBrokenLinksParallel(finalUrl, html, 10)
      : Promise.resolve([]),
    lighthousePromise,
  ]);

  const deterministic = buildDeterministicAuditEvidence({
    isHttps,
    failureKind,
    httpStatus,
    freeSubdomainPlatform,
    brokenLinks,
    dom,
    lighthouse,
  });

  let auditEvidence = deterministic.auditEvidence;
  let siteLooksSolid = deterministic.siteLooksSolid;
  let overallVerdict = deterministic.overallVerdict;

  const mobileScreenshotUrl = lighthouse?.screenshotDataUrl ?? null;

  // Layer C: Multimodal Vision critique ONLY when a real mobile screenshot was captured
  if (
    !options?.skipLlm &&
    options?.runVision !== false &&
    mobileScreenshotUrl &&
    failureKind !== "dead_site"
  ) {
    const parsedImg = parseDataUrlBase64(mobileScreenshotUrl);
    if (parsedImg) {
      try {
        const deterministicSummary = {
          finalUrl,
          isHttps,
          freeSubdomainPlatform,
          brokenLinks,
          hasViewportMeta: dom.hasViewportMeta,
          ctaCountAboveFold: dom.ctaCountAboveFold,
          hasClickablePhone: dom.hasClickablePhone,
          visiblePlaceholders: dom.visiblePlaceholders,
          mobilePerformanceScore: lighthouse?.mobileScore ?? null,
          lcpSeconds: lighthouse?.lcpSeconds ?? null,
          clsScore: lighthouse?.clsScore ?? null,
          failedAudits: lighthouse?.failedAudits ?? [],
        };

        const visionRes = await LLMGateway.completeJSON<{
          siteLooksSolid?: boolean;
          overallVerdict?: string;
          issues?: AuditEvidenceItem[];
        }>({
          ownerId: options?.ownerId ?? "system",
          taskType: "fast",
          feature: "forensic_vision_audit",
          requiresVision: true,
          temperature: 0.1,
          maxTokens: 450,
          schema: VISION_AUDIT_SCHEMA,
          systemPrompt: `You are inspecting a real 390px mobile screenshot of a prospect website alongside deterministic Lighthouse + DOM facts.
RULES:
1. Return AT MOST 2 strongest undeniable issues, EVERY item grounded either in what is visibly wrong on the screenshot or in the deterministic facts JSON.
2. NEVER invent invisible faults, never use vague marketing filler ("conversion optimization", "improved mobile responsiveness", "modernize design"), and never claim placeholder text exists unless visiblePlaceholders in the JSON is non-empty.
3. If mobilePerformanceScore >= 80, isHttps is true, brokenLinks is empty, and the mobile screenshot looks clean and legible above the fold, set siteLooksSolid=true, issues=[], and overallVerdict="Site looks solid / low friction — low redesign priority".`,
          messages: [
            {
              role: "user",
              content: `Deterministic site measurements:\n${JSON.stringify(deterministicSummary, null, 2)}`,
              images: [parsedImg],
            },
          ],
        });

        const visionIssues = Array.isArray(visionRes.data?.issues)
          ? visionRes.data.issues
              .filter(
                (x): x is AuditEvidenceItem =>
                  Boolean(
                    x &&
                      typeof x.issue === "string" &&
                      x.issue.trim() &&
                      typeof x.proof === "string" &&
                      x.proof.trim() &&
                      ["lighthouse", "broken_link", "dom_visible", "vision_screenshot"].includes(x.evidence_type),
                  ),
              )
              .slice(0, 2)
          : [];

        if (visionRes.data?.siteLooksSolid && deterministic.auditEvidence.length === 0) {
          siteLooksSolid = true;
          auditEvidence = [];
          overallVerdict =
            visionRes.data.overallVerdict?.trim() ||
            "Site looks solid / low friction — low redesign priority";
        } else if (visionIssues.length > 0) {
          // Prefer deterministic broken-link / Lighthouse proof first if Vision omitted it, combined max 2
          const merged: AuditEvidenceItem[] = [];
          for (const item of [...deterministic.auditEvidence, ...visionIssues]) {
            if (!merged.some((m) => m.issue.toLowerCase() === item.issue.toLowerCase())) {
              merged.push(item);
            }
            if (merged.length >= 2) break;
          }
          auditEvidence = merged;
          siteLooksSolid = false;
          overallVerdict = visionRes.data.overallVerdict?.trim() || merged[0].issue;
        }
      } catch {
        // Vision fallback cleanly preserves deterministic auditEvidence without blocking
      }
    }
  }

  const result: ForensicAuditResult = {
    url,
    finalUrl,
    reachable,
    httpStatus,
    failureKind,
    redirected: finalUrl.replace(/\/+$/, "") !== url.replace(/\/+$/, ""),
    isHttps,
    freeSubdomainPlatform,
    brokenLinks,
    dom,
    lighthouse,
    mobileScreenshotUrl,
    auditEvidence,
    siteLooksSolid,
    overallVerdict,
    checkedAt: new Date().toISOString(),
  };

  await setCachedSearchEnrichment(cacheKey, "site", result);
  return result;
}
