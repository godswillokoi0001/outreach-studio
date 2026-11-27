import { normalizeWebsite } from "@/lib/columns";
import { listAdminSearchKeys } from "@/lib/llm/store";
import { isFetchableUrl } from "@/lib/outreach-utils";
import {
  getCachedSearchEnrichment,
  isSearchProviderAvailable,
  markSearchProviderExhausted,
  recordSearchProviderUsage,
  setCachedSearchEnrichment,
} from "./quotaAndCache";

export interface InspectedWebsite {
  url: string;
  finalUrl: string;
  reachable: boolean;
  status: number;
  httpStatus: number;
  isHttps: boolean;
  https: boolean;
  title: string;
  metaDescription: string;
  h1: string;
  hasViewport: boolean;
  hasContactForm: boolean;
  emails: string[];
  phones: string[];
  socialLinks: { platform: string; url: string }[];
  platform: string | null;
  statusHints: string[];
  ctaPhrases: string[];
  copyrightYear: number | null;
  wordCount: number;
  textSummary: string;
  enrichmentSource: "direct_html" | "jina_reader" | "firecrawl" | "cache";
  error?: string;
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const DIRECTORY_HOST_PATTERN =
  /(?:^|\.)(yelp\.com|yellowpages\.com|bbb\.org|mapquest\.com|foursquare\.com|tripadvisor\.|angieslist\.com|angi\.com|thumbtack\.com|bark\.com|expertise\.com|clutch\.co|g2\.com|capterra\.com|wikipedia\.org|wikidata\.org|openstreetmap\.org|exa\.ai|zocdoc\.com|healthgrades\.com|webmd\.com|vitals\.com|opencare\.com|facebook\.com|instagram\.com|linkedin\.com|tiktok\.com|youtube\.com|x\.com|twitter\.com|reddit\.com)$/i;

const EMAIL_BLOCKLIST_PATTERN =
  /(?:^example@|@example\.|@sentry\.|@wixpress\.com|@squarespace\.com|@wordpress\.org|noreply@|no-reply@|donotreply@|\.(?:png|jpg|jpeg|gif|svg|webp|css|js)$)/i;

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

export function isDirectoryUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return DIRECTORY_HOST_PATTERN.test(host);
  } catch {
    return false;
  }
}

export function stripHtmlToText(html: string): string {
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
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(Number(num)))
    .trim();
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  maxBytes = 250_000,
): Promise<{ res: Response; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    const raw = await res.text();
    return { res, text: raw.slice(0, maxBytes) };
  } finally {
    clearTimeout(timer);
  }
}

function extractEmailsFromContent(html: string, text: string): string[] {
  const found = new Set<string>();

  const mailtoRegex = /href=["']mailto:([^"'?#\s>]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = mailtoRegex.exec(html)) !== null) {
    const email = decodeURIComponent(m[1] ?? "").trim().toLowerCase();
    if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email) && !EMAIL_BLOCKLIST_PATTERN.test(email)) {
      found.add(email);
    }
  }

  const plainRegex = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;
  while ((m = plainRegex.exec(text)) !== null) {
    const email = (m[0] ?? "").trim().toLowerCase();
    if (!EMAIL_BLOCKLIST_PATTERN.test(email)) {
      found.add(email);
    }
  }

  return Array.from(found).slice(0, 6);
}

function extractSocialLinks(html: string): { platform: string; url: string }[] {
  const platforms: { name: string; re: RegExp }[] = [
    { name: "LinkedIn", re: /https?:\/\/(?:www\.)?linkedin\.com\/[^\s"'<>]+/gi },
    { name: "Instagram", re: /https?:\/\/(?:www\.)?instagram\.com\/[^\s"'<>]+/gi },
    { name: "Facebook", re: /https?:\/\/(?:www\.)?facebook\.com\/[^\s"'<>]+/gi },
    { name: "X", re: /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^\s"'<>]+/gi },
    { name: "YouTube", re: /https?:\/\/(?:www\.)?youtube\.com\/[^\s"'<>]+/gi },
  ];

  const seen = new Set<string>();
  const out: { platform: string; url: string }[] = [];
  for (const p of platforms) {
    const matches = html.match(p.re) ?? [];
    for (const raw of matches) {
      const clean = raw.replace(/[).,;]+$/, "");
      if (seen.has(clean.toLowerCase())) continue;
      if (/sharer|intent\/tweet|plugins\/|policy|privacy/i.test(clean)) continue;
      seen.add(clean.toLowerCase());
      out.push({ platform: p.name, url: clean });
      if (out.length >= 6) return out;
    }
  }
  return out;
}

async function fetchViaJinaReader(targetUrl: string): Promise<string | null> {
  try {
    const keys = await listAdminSearchKeys();
    const jinaKey = keys.find((k) => k.provider === "jina")?.apiKey;
    const jinaAvailable = !jinaKey || (await isSearchProviderAvailable("jina"));
    if (!jinaAvailable) return null;

    const headers: Record<string, string> = {
      Accept: "text/plain",
      "X-Return-Format": "text",
    };
    if (jinaKey) headers.Authorization = `Bearer ${jinaKey}`;

    const { res, text } = await fetchWithTimeout(
      `https://r.jina.ai/${targetUrl}`,
      { method: "GET", headers },
      5_000,
      40_000,
    );
    if (jinaKey) {
      if (res.status === 402 || res.status === 429) {
        await markSearchProviderExhausted("jina");
        return null;
      }
      if (res.ok) await recordSearchProviderUsage("jina", 1);
    }
    if (!res.ok) return null;
    const cleaned = text.trim();
    return cleaned.length > 60 ? cleaned.slice(0, 7_000) : null;
  } catch {
    return null;
  }
}

async function fetchViaFirecrawlScrape(targetUrl: string): Promise<string | null> {
  try {
    const keys = await listAdminSearchKeys();
    const fcKey = keys.find((k) => k.provider === "firecrawl")?.apiKey;
    if (!fcKey) return null;
    if (!(await isSearchProviderAvailable("firecrawl"))) return null;

    const { res, text } = await fetchWithTimeout(
      "https://api.firecrawl.dev/v1/scrape",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${fcKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: targetUrl, formats: ["markdown"] }),
      },
      6_000,
      50_000,
    );
    if (res.status === 402 || res.status === 429) {
      await markSearchProviderExhausted("firecrawl");
      return null;
    }
    if (!res.ok) return null;
    await recordSearchProviderUsage("firecrawl", 1);

    const parsed = JSON.parse(text) as { data?: { markdown?: string } };
    const md = (parsed.data?.markdown ?? "").trim();
    return md.length > 60 ? md.slice(0, 7_000) : null;
  } catch {
    return null;
  }
}

export async function inspectProspectWebsite(
  rawUrl: string | null | undefined,
  options?: { timeoutMs?: number; checkContactPage?: boolean; bypassCache?: boolean },
): Promise<InspectedWebsite | null> {
  const url = rawUrl ? normalizeWebsite(rawUrl) : null;
  if (!url || !isFetchableUrl(url)) return null;

  const cacheKey = `site:${url.toLowerCase().replace(/\/+$/, "")}`;
  if (!options?.bypassCache) {
    const cached = await getCachedSearchEnrichment<InspectedWebsite>(cacheKey);
    if (cached) {
      return { ...cached, enrichmentSource: "cache" };
    }
  }

  const timeoutMs = options?.timeoutMs ?? 5_000;
  try {
    const { res, text: html } = await fetchWithTimeout(
      url,
      {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
      timeoutMs,
      250_000,
    );

    const contentType = res.headers.get("content-type") ?? "";
    const finalUrl = res.url || url;
    if (!contentType.includes("html") && !html.toLowerCase().includes("<html")) {
      const result: InspectedWebsite = {
        url,
        finalUrl,
        reachable: res.ok,
        status: res.status,
        httpStatus: res.status,
        isHttps: finalUrl.startsWith("https://"),
        https: finalUrl.startsWith("https://"),
        title: "",
        metaDescription: "",
        h1: "",
        hasViewport: false,
        hasContactForm: false,
        emails: [],
        phones: [],
        socialLinks: [],
        platform: null,
        statusHints: [],
        ctaPhrases: [],
        copyrightYear: null,
        wordCount: 0,
        textSummary: "",
        enrichmentSource: "direct_html",
        error: `Non-HTML response (${contentType || "unknown"})`,
      };
      return result;
    }

    const lower = html.toLowerCase();
    const title = decodeHtmlEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").slice(0, 200));
    const metaDescription = decodeHtmlEntities(
      (
        html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] ??
        html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i)?.[1] ??
        ""
      ).slice(0, 400),
    );
    const h1 = stripHtmlToText(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "").slice(0, 160);
    let visibleText = stripHtmlToText(html).slice(0, 8_000);
    let enrichmentSource: InspectedWebsite["enrichmentSource"] = "direct_html";

    // Zero-cost-first JS fallback: only invoke Jina Reader (or Firecrawl) when plain HTML < 250 chars
    if (res.ok && visibleText.length < 250) {
      const jinaText = await fetchViaJinaReader(finalUrl);
      if (jinaText) {
        visibleText = jinaText;
        enrichmentSource = "jina_reader";
      } else {
        const fcText = await fetchViaFirecrawlScrape(finalUrl);
        if (fcText) {
          visibleText = fcText;
          enrichmentSource = "firecrawl";
        }
      }
    }

    let emails = extractEmailsFromContent(html, visibleText);

    const phonesSet = new Set<string>();
    const telRegex = /href=["']tel:([^"'?\s>]+)/gi;
    let tm: RegExpExecArray | null;
    while ((tm = telRegex.exec(html)) !== null) {
      const p = decodeURIComponent(tm[1] ?? "").trim();
      if (p.length >= 7 && p.length <= 24) phonesSet.add(p);
    }

    const hasViewport = /<meta[^>]+name=["']viewport["']/i.test(html);
    const hasContactForm = /<form[\s\S]{0,4000}?<\/form>/i.test(html);
    const isHttps = finalUrl.startsWith("https://");

    let platform: string | null = null;
    if (lower.includes("wp-content")) platform = "WordPress";
    else if (lower.includes("wixstatic") || lower.includes("wix.com")) platform = "Wix";
    else if (lower.includes("squarespace")) platform = "Squarespace";
    else if (lower.includes("shopify")) platform = "Shopify";
    else if (lower.includes("webflow")) platform = "Webflow";
    else if (lower.includes("godaddysites")) platform = "GoDaddy Website Builder";
    else if (lower.includes("carrd.co")) platform = "Carrd";
    else if (lower.includes("blogspot") || lower.includes("blogger.com")) platform = "Blogger";

    const statusHints: string[] = [];
    if (!res.ok) statusHints.push(`HTTP ${res.status} response`);
    if (!isHttps) statusHints.push("Not using HTTPS");
    if (!hasViewport) statusHints.push("Missing mobile viewport meta tag");
    if (/coming soon|under construction|under maintenance|maintenance mode|launching soon/i.test(visibleText)) {
      statusHints.push("Coming soon / under construction text detected");
    }

    const copyright = html.match(/(?:©|&copy;|copyright)\s*(\d{4})/i);
    const copyrightYear = copyright ? Number(copyright[1]) : null;
    const linkText = (html.match(/<(a|button)[^>]*>([\s\S]{0,120}?)<\/\1>/gi) ?? [])
      .map((chunk) => stripHtmlToText(chunk).toLowerCase())
      .join(" | ");
    const ctaPhrases = CTA_WORDS.filter((phrase) => linkText.includes(phrase)).slice(0, 6);
    const socialLinks = extractSocialLinks(html);

    // Optional fast check on /contact or /about if no email found on homepage
    if (options?.checkContactPage && emails.length === 0 && res.ok) {
      for (const pathSuffix of ["/contact", "/about"]) {
        try {
          const subUrl = new URL(pathSuffix, finalUrl).toString();
          if (!isFetchableUrl(subUrl)) continue;
          const subRes = await fetchWithTimeout(
            subUrl,
            { headers: { "User-Agent": BROWSER_UA, Accept: "text/html" } },
            2_500,
            120_000,
          );
          if (subRes.res.ok) {
            const subText = stripHtmlToText(subRes.text);
            const subEmails = extractEmailsFromContent(subRes.text, subText);
            if (subEmails.length > 0) {
              emails = subEmails;
              break;
            }
          }
        } catch {
          /* continue */
        }
      }
    }

    const inspected: InspectedWebsite = {
      url,
      finalUrl,
      reachable: res.ok,
      status: res.status,
      httpStatus: res.status,
      isHttps,
      https: isHttps,
      title,
      metaDescription,
      h1,
      hasViewport,
      hasContactForm,
      emails,
      phones: Array.from(phonesSet).slice(0, 4),
      socialLinks,
      platform,
      statusHints,
      ctaPhrases,
      copyrightYear,
      wordCount: visibleText.split(/\s+/).filter(Boolean).length,
      textSummary: visibleText.slice(0, 6_500),
      enrichmentSource,
    };

    if (res.ok && !options?.bypassCache) {
      await setCachedSearchEnrichment(cacheKey, "site", inspected);
    }

    return inspected;
  } catch (err) {
    return {
      url,
      finalUrl: url,
      reachable: false,
      status: 0,
      httpStatus: 0,
      isHttps: url.startsWith("https://"),
      https: url.startsWith("https://"),
      title: "",
      metaDescription: "",
      h1: "",
      hasViewport: false,
      hasContactForm: false,
      emails: [],
      phones: [],
      socialLinks: [],
      platform: null,
      statusHints: ["Website unreachable"],
      ctaPhrases: [],
      copyrightYear: null,
      wordCount: 0,
      textSummary: "",
      enrichmentSource: "direct_html",
      error: err instanceof Error ? err.message : "Failed to fetch website",
    };
  }
}

export async function inspectProspectWebsites(
  urls: string[],
  options?: { maxSites?: number; timeoutMs?: number; checkContactPage?: boolean },
): Promise<InspectedWebsite[]> {
  const unique = Array.from(new Set(urls.map((u) => normalizeWebsite(u) ?? "").filter(Boolean)))
    .filter((u) => !isDirectoryUrl(u))
    .slice(0, options?.maxSites ?? 8);

  if (unique.length === 0) return [];
  const settled = await Promise.allSettled(
    unique.map((u) =>
      inspectProspectWebsite(u, {
        timeoutMs: options?.timeoutMs ?? 5_000,
        checkContactPage: options?.checkContactPage,
      }),
    ),
  );

  return settled
    .filter((r): r is PromiseFulfilledResult<InspectedWebsite | null> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((v): v is InspectedWebsite => Boolean(v));
}
