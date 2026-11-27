import { normalizeWebsite } from "@/lib/columns";
import { listAdminSearchKeys } from "@/lib/llm/store";
import type { SearchProviderId } from "@/lib/llm/types";
import { isFetchableUrl } from "@/lib/outreach-utils";

export type ActiveSearchProvider = SearchProviderId | "duckduckgo" | "osm";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  sourceProvider: ActiveSearchProvider;
  businessName?: string;
  address?: string;
  phone?: string;
  email?: string;
}

export interface InspectedWebsite {
  url: string;
  finalUrl: string;
  reachable: boolean;
  status: number;
  title: string;
  metaDescription: string;
  h1: string;
  https: boolean;
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
  error?: string;
}

export interface WebSearchResponse {
  query: string;
  results: WebSearchResult[];
  providersTried: ActiveSearchProvider[];
  providersSucceeded: ActiveSearchProvider[];
  errors: string[];
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const DIRECTORY_HOST_PATTERN =
  /(?:^|\.)(yelp\.com|yellowpages\.com|bbb\.org|mapquest\.com|foursquare\.com|tripadvisor\.|angieslist\.com|angi\.com|thumbtack\.com|bark\.com|expertise\.com|clutch\.co|g2\.com|capterra\.com|wikipedia\.org|wikidata\.org|openstreetmap\.org|facebook\.com|instagram\.com|linkedin\.com|tiktok\.com|youtube\.com|x\.com|twitter\.com|reddit\.com)$/i;

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

function stripHtmlToText(html: string): string {
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

function decodeHtmlEntities(str: string): string {
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

async function fetchTextWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  maxBytes = 260_000,
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

function cleanResultUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";
  if (trimmed.includes("duckduckgo.com/l/?")) {
    try {
      const parsed = new URL(trimmed.startsWith("//") ? `https:${trimmed}` : trimmed);
      const uddg = parsed.searchParams.get("uddg");
      if (uddg) return uddg;
    } catch {
      /* keep raw */
    }
  }
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return trimmed;
}

export function isDirectoryUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return DIRECTORY_HOST_PATTERN.test(host);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Search Provider 1: Tavily Search API
// ---------------------------------------------------------------------------

async function searchTavily(query: string, apiKey: string, maxResults = 10): Promise<WebSearchResult[]> {
  const { res, text } = await fetchTextWithTimeout(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey.trim(),
        query,
        search_depth: "basic",
        max_results: Math.min(12, Math.max(3, maxResults)),
        include_answer: false,
      }),
    },
    8_000,
    180_000,
  );
  if (!res.ok) {
    throw new Error(`Tavily HTTP ${res.status}: ${text.slice(0, 160)}`);
  }
  const data = JSON.parse(text) as {
    results?: { title?: string; url?: string; content?: string }[];
  };
  const items = Array.isArray(data.results) ? data.results : [];
  return items
    .map((r) => ({
      title: String(r.title ?? "").trim(),
      url: cleanResultUrl(String(r.url ?? "")),
      snippet: String(r.content ?? "").trim().slice(0, 420),
      sourceProvider: "tavily" as const,
    }))
    .filter((r) => r.url.startsWith("http"));
}

// ---------------------------------------------------------------------------
// Search Provider 2: Brave Search & Serper
// ---------------------------------------------------------------------------

async function searchBrave(query: string, apiKey: string, maxResults = 10): Promise<WebSearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(12, Math.max(3, maxResults))}`;
  const { res, text } = await fetchTextWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey.trim(),
      },
    },
    7_000,
    180_000,
  );
  if (!res.ok) {
    throw new Error(`Brave Search HTTP ${res.status}: ${text.slice(0, 160)}`);
  }
  const data = JSON.parse(text) as {
    web?: { results?: { title?: string; url?: string; description?: string }[] };
  };
  const items = Array.isArray(data.web?.results) ? data.web.results : [];
  return items
    .map((r) => ({
      title: String(r.title ?? "").trim(),
      url: cleanResultUrl(String(r.url ?? "")),
      snippet: String(r.description ?? "").trim().slice(0, 420),
      sourceProvider: "brave" as const,
    }))
    .filter((r) => r.url.startsWith("http"));
}

async function searchSerper(query: string, apiKey: string, maxResults = 10): Promise<WebSearchResult[]> {
  const { res, text } = await fetchTextWithTimeout(
    "https://google.serper.dev/search",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey.trim(),
      },
      body: JSON.stringify({
        q: query,
        num: Math.min(12, Math.max(3, maxResults)),
      }),
    },
    7_000,
    180_000,
  );
  if (!res.ok) {
    throw new Error(`Serper HTTP ${res.status}: ${text.slice(0, 160)}`);
  }
  const data = JSON.parse(text) as {
    organic?: { title?: string; link?: string; snippet?: string }[];
  };
  const items = Array.isArray(data.organic) ? data.organic : [];
  return items
    .map((r) => ({
      title: String(r.title ?? "").trim(),
      url: cleanResultUrl(String(r.link ?? "")),
      snippet: String(r.snippet ?? "").trim().slice(0, 420),
      sourceProvider: "serper" as const,
    }))
    .filter((r) => r.url.startsWith("http"));
}

// ---------------------------------------------------------------------------
// Search Provider 3A: DuckDuckGo HTML / Lite Keyless Fallback ($0 Forever)
// ---------------------------------------------------------------------------

export function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  if (!html) return results;

  // Guard cleanly if DDG returned an anti-bot challenge page
  if (/anomaly-modal|cc=botnet|Please verify you are human/i.test(html)) {
    return results;
  }

  // Primary HTML layout: <a class="result__a" href="...">Title</a> ... <a class="result__snippet" ...>Snippet</a>
  const anchorRegex = /<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<(?:a|div)[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/gi;

  const anchors: { url: string; title: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = anchorRegex.exec(html)) !== null) {
    const url = cleanResultUrl(decodeHtmlEntities(m[1] ?? ""));
    const title = decodeHtmlEntities(stripHtmlToText(m[2] ?? ""));
    if (url.startsWith("http") && title) {
      anchors.push({ url, title, index: m.index });
    }
  }

  const snippets: { text: string; index: number }[] = [];
  while ((m = snippetRegex.exec(html)) !== null) {
    snippets.push({
      text: decodeHtmlEntities(stripHtmlToText(m[1] ?? "")).slice(0, 420),
      index: m.index,
    });
  }

  for (let i = 0; i < anchors.length; i++) {
    const cur = anchors[i];
    const nextIdx = anchors[i + 1]?.index ?? html.length;
    const snip = snippets.find((s) => s.index > cur.index && s.index < nextIdx)?.text ?? "";
    results.push({
      title: cur.title,
      url: cur.url,
      snippet: snip,
      sourceProvider: "duckduckgo",
    });
  }

  // Lite layout fallback: <a rel="nofollow" href="..." class='result-link'>
  if (results.length === 0) {
    const liteRegex = /<a[^>]+href=["']([^"']+)["'][^>]+class=["'][^"']*result-link[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = liteRegex.exec(html)) !== null) {
      const url = cleanResultUrl(decodeHtmlEntities(m[1] ?? ""));
      const title = decodeHtmlEntities(stripHtmlToText(m[2] ?? ""));
      if (url.startsWith("http") && title) {
        results.push({ title, url, snippet: "", sourceProvider: "duckduckgo" });
      }
    }
  }

  return results;
}

async function searchDuckDuckGo(query: string, maxResults = 10): Promise<WebSearchResult[]> {
  const { res, text } = await fetchTextWithTimeout(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    {
      method: "GET",
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    },
    7_000,
    240_000,
  );
  if (res.ok) {
    const parsed = parseDuckDuckGoHtml(text);
    if (parsed.length > 0) return parsed.slice(0, maxResults);
  }

  // Lite fallback endpoint
  const lite = await fetchTextWithTimeout(
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    {
      method: "GET",
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml",
      },
    },
    6_000,
    180_000,
  );
  if (!lite.res.ok) {
    throw new Error(`DuckDuckGo returned HTTP ${lite.res.status}`);
  }
  return parseDuckDuckGoHtml(lite.text).slice(0, maxResults);
}

// ---------------------------------------------------------------------------
// Search Provider 3B: OpenStreetMap Nominatim + Overpass Local Business API
// ---------------------------------------------------------------------------

function inferOsmFilters(niche: string): string[] {
  const lower = niche.toLowerCase();
  const pairs: { re: RegExp; tags: string[] }[] = [
    { re: /dent|orthodon|clinic|doctor|medical|health|chiro|optom|physio/, tags: ['["amenity"~"dentist|clinic|doctors|hospital|pharmacy"]', '["healthcare"]'] },
    { re: /church|ministry|parish|chapel|synagogue|mosque|temple/, tags: ['["amenity"="place_of_worship"]'] },
    { re: /restaur|cafe|coffee|bakery|bistro|food|dining|pizza|bar\b/, tags: ['["amenity"~"restaurant|cafe|fast_food|bakery|bar"]'] },
    { re: /law|legal|attorney|account|tax|cpa|consult|agency|studio|real estate|realtor|insur/, tags: ['["office"]'] },
    { re: /salon|barber|spa|beauty|gym|fitness|yoga/, tags: ['["shop"~"hairdresser|beauty"]', '["leisure"~"fitness_centre|sports_centre"]'] },
    { re: /plumb|hvac|electric|roof|construct|contractor|landscap|clean|auto|repair|garage/, tags: ['["craft"]', '["shop"~"car_repair|hardware"]'] },
    { re: /school|tutor|academy|daycare|preschool|kindergarten/, tags: ['["amenity"~"school|kindergarten|college|training"]'] },
    { re: /hotel|motel|inn|resort|lodg/, tags: ['["tourism"~"hotel|motel|guest_house"]'] },
    { re: /store|shop|retail|boutique|jewel|florist|pet/, tags: ['["shop"]'] },
  ];

  const matched = new Set<string>();
  for (const entry of pairs) {
    if (entry.re.test(lower)) {
      for (const t of entry.tags) matched.add(t);
    }
  }
  if (matched.size === 0) {
    matched.add('["office"]');
    matched.add('["shop"]');
    matched.add('["amenity"~"restaurant|cafe|clinic|dentist|school|place_of_worship"]');
  }
  return Array.from(matched).slice(0, 3);
}

export async function searchOpenStreetMapBusinesses(
  niche: string,
  location: string,
  maxResults = 10,
): Promise<WebSearchResult[]> {
  const cleanLoc = location.trim();
  if (!cleanLoc) return [];

  const geoUrl = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(cleanLoc)}`;
  const geo = await fetchTextWithTimeout(
    geoUrl,
    {
      headers: {
        "User-Agent": "KnowrevoOutreach/1.0 (+https://knowrevo.app)",
        Accept: "application/json",
      },
    },
    5_000,
    40_000,
  );
  if (!geo.res.ok) return [];

  const geoRows = JSON.parse(geo.text) as { boundingbox?: string[]; display_name?: string }[];
  const bbox = geoRows[0]?.boundingbox;
  if (!Array.isArray(bbox) || bbox.length !== 4) return [];

  // Nominatim returns [south, north, west, east]; clamp span to avoid huge slow city queries
  const s = Number(bbox[0]);
  const n = Number(bbox[1]);
  const w = Number(bbox[2]);
  const e = Number(bbox[3]);
  if (![s, n, w, e].every(Number.isFinite)) return [];
  const latSpan = Math.min(0.45, Math.max(0.04, Math.abs(n - s)));
  const lonSpan = Math.min(0.45, Math.max(0.04, Math.abs(e - w)));
  const midLat = (s + n) / 2;
  const midLon = (w + e) / 2;
  const clampedBbox = `${(midLat - latSpan / 2).toFixed(4)},${(midLon - lonSpan / 2).toFixed(4)},${(midLat + latSpan / 2).toFixed(4)},${(midLon + lonSpan / 2).toFixed(4)}`;

  const filters = inferOsmFilters(niche);
  const queryBody = `[out:json][timeout:6];(${filters
    .map((f) => `node${f}["name"](${clampedBbox});way${f}["name"](${clampedBbox});`)
    .join("")});out center ${Math.min(40, maxResults * 4)};`;

  const ovp = await fetchTextWithTimeout(
    "https://overpass-api.de/api/interpreter",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "KnowrevoOutreach/1.0 (+https://knowrevo.app)",
      },
      body: `data=${encodeURIComponent(queryBody)}`,
    },
    7_000,
    240_000,
  );
  if (!ovp.res.ok) return [];

  const ovpData = JSON.parse(ovp.text) as {
    elements?: { tags?: Record<string, string>; id?: number; type?: string }[];
  };
  const elements = Array.isArray(ovpData.elements) ? ovpData.elements : [];

  const keywords = niche
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((k) => k.length > 2 && !["and", "for", "with", "the", "services", "local"].includes(k));

  const scored: { score: number; item: WebSearchResult }[] = [];
  for (const el of elements) {
    const tags = el.tags ?? {};
    const name = (tags.name ?? "").trim();
    if (!name) continue;
    const website = (tags.website || tags["contact:website"] || tags.url || "").trim();
    const email = (tags.email || tags["contact:email"] || "").trim();
    const phone = (tags.phone || tags["contact:phone"] || "").trim();
    const addressParts = [
      tags["addr:housenumber"],
      tags["addr:street"],
      tags["addr:city"] || cleanLoc,
      tags["addr:state"],
    ].filter(Boolean);
    const address = addressParts.join(" ").trim();
    const tagBlob = `${name} ${Object.values(tags).join(" ")}`.toLowerCase();

    let matchScore = 0;
    for (const kw of keywords) {
      if (tagBlob.includes(kw)) matchScore += 3;
    }
    if (website) matchScore += 4;
    if (email) matchScore += 2;
    if (phone) matchScore += 1;

    const osmUrl = `https://www.openstreetmap.org/${el.type || "node"}/${el.id || ""}`;
    scored.push({
      score: matchScore,
      item: {
        title: name,
        url: website && /^https?:\/\//i.test(website) ? website : website ? `https://${website}` : osmUrl,
        snippet: [
          address ? `Address: ${address}` : "",
          phone ? `Phone: ${phone}` : "",
          email ? `Email: ${email}` : "",
          tags.amenity || tags.office || tags.shop || tags.craft ? `Category: ${tags.amenity || tags.office || tags.shop || tags.craft}` : "",
          `Source: OpenStreetMap`,
        ]
          .filter(Boolean)
          .join(" · "),
        sourceProvider: "osm",
        businessName: name,
        address: address || cleanLoc,
        phone: phone || undefined,
        email: email || undefined,
      },
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults).map((s) => s.item);
}

// ---------------------------------------------------------------------------
// Key Verification Helper (for Admin Web Search Slots)
// ---------------------------------------------------------------------------

export async function verifySearchKey(input: {
  provider: SearchProviderId;
  apiKey: string;
}): Promise<{ ok: boolean; count: number; ms: number; sampleTitle?: string }> {
  const started = Date.now();
  const key = input.apiKey.trim();
  if (!key) throw new Error("API key is required.");

  let results: WebSearchResult[] = [];
  if (input.provider === "tavily") {
    results = await searchTavily("test", key, 3);
  } else if (input.provider === "brave") {
    results = await searchBrave("test", key, 3);
  } else {
    results = await searchSerper("test", key, 3);
  }
  return {
    ok: true,
    count: results.length,
    ms: Date.now() - started,
    sampleTitle: results[0]?.title,
  };
}

// ---------------------------------------------------------------------------
// Fast Live Website Inspector (Parallel, Strictly Verified Signals Only)
// ---------------------------------------------------------------------------

function extractEmailsFromHtml(html: string, text: string): string[] {
  const found = new Set<string>();

  // 1. Explicit mailto: links
  const mailtoRegex = /href=["']mailto:([^"'?#\s>]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = mailtoRegex.exec(html)) !== null) {
    const email = decodeURIComponent(m[1] ?? "").trim().toLowerCase();
    if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email) && !EMAIL_BLOCKLIST_PATTERN.test(email)) {
      found.add(email);
    }
  }

  // 2. Visible plaintext email matches
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

export async function inspectProspectWebsite(
  rawUrl: string | null | undefined,
  options?: { timeoutMs?: number; checkContactPage?: boolean },
): Promise<InspectedWebsite | null> {
  const url = rawUrl ? normalizeWebsite(rawUrl) : null;
  if (!url || !isFetchableUrl(url)) return null;

  const timeoutMs = options?.timeoutMs ?? 5_000;
  try {
    const { res, text: html } = await fetchTextWithTimeout(
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
      return {
        url,
        finalUrl,
        reachable: res.ok,
        status: res.status,
        title: "",
        metaDescription: "",
        h1: "",
        https: finalUrl.startsWith("https://"),
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
        error: `Non-HTML response (${contentType || "unknown"})`,
      };
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
    const visibleText = stripHtmlToText(html).slice(0, 10_000);
    let emails = extractEmailsFromHtml(html, visibleText);

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
    if (!isHttps) statusHints.push("Not using HTTPS");
    if (!hasViewport) statusHints.push("Missing mobile viewport meta tag");
    if (/coming soon|under construction|maintenance mode|launching soon/i.test(visibleText)) {
      statusHints.push("Coming soon / under construction text detected");
    }

    const copyright = html.match(/(?:©|&copy;|copyright)\s*(\d{4})/i);
    const copyrightYear = copyright ? Number(copyright[1]) : null;
    const linkText = (html.match(/<(a|button)[^>]*>([\s\S]{0,120}?)<\/\1>/gi) ?? [])
      .map((chunk) => stripHtmlToText(chunk).toLowerCase())
      .join(" | ");
    const ctaPhrases = CTA_WORDS.filter((phrase) => linkText.includes(phrase)).slice(0, 6);
    const socialLinks = extractSocialLinks(html);

    // Optional ultra-fast /contact page email check only if requested and homepage had no email
    if (options?.checkContactPage && emails.length === 0 && res.ok) {
      try {
        const contactUrl = new URL("/contact", finalUrl).toString();
        if (isFetchableUrl(contactUrl)) {
          const contactRes = await fetchTextWithTimeout(
            contactUrl,
            { headers: { "User-Agent": BROWSER_UA, Accept: "text/html" } },
            2_500,
            120_000,
          );
          if (contactRes.res.ok) {
            const cText = stripHtmlToText(contactRes.text);
            emails = extractEmailsFromHtml(contactRes.text, cText);
          }
        }
      } catch {
        /* fast optional check */
      }
    }

    return {
      url,
      finalUrl,
      reachable: res.ok,
      status: res.status,
      title,
      metaDescription,
      h1,
      https: isHttps,
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
      textSummary: visibleText.slice(0, 4_000),
    };
  } catch (err) {
    return {
      url,
      finalUrl: url,
      reachable: false,
      status: 0,
      title: "",
      metaDescription: "",
      h1: "",
      https: url.startsWith("https://"),
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

// ---------------------------------------------------------------------------
// Unified Multi-Provider WebSearchService
// ---------------------------------------------------------------------------

function extractLocationHint(query: string): { niche: string; location: string } | null {
  const m = query.match(/^(.+?)\s+(?:in|near|around|across)\s+([a-zA-Z0-9 ,.-]{2,60})$/i);
  if (!m) return null;
  return { niche: m[1].trim(), location: m[2].trim() };
}

export const WebSearchService = {
  async search(
    query: string,
    options?: {
      maxResults?: number;
      locationHint?: string;
      nicheHint?: string;
    },
  ): Promise<WebSearchResponse> {
    const cleanQuery = query.trim();
    const maxResults = Math.min(15, Math.max(3, options?.maxResults ?? 10));
    const providersTried: ActiveSearchProvider[] = [];
    const providersSucceeded: ActiveSearchProvider[] = [];
    const errors: string[] = [];

    if (!cleanQuery) {
      return { query: cleanQuery, results: [], providersTried, providersSucceeded, errors };
    }

    const adminKeys = await listAdminSearchKeys();
    const keyMap = new Map<SearchProviderId, string>();
    for (const k of adminKeys) {
      if (!keyMap.has(k.provider) && k.apiKey) {
        keyMap.set(k.provider, k.apiKey);
      }
    }

    const results: WebSearchResult[] = [];
    const seenUrls = new Set<string>();
    const addResults = (rows: WebSearchResult[], provider: ActiveSearchProvider) => {
      if (rows.length > 0 && !providersSucceeded.includes(provider)) {
        providersSucceeded.push(provider);
      }
      for (const r of rows) {
        const norm = r.url.toLowerCase().replace(/\/+$/, "");
        if (!norm || seenUrls.has(norm)) continue;
        seenUrls.add(norm);
        results.push(r);
      }
    };

    // 1. Try configured API search keys in priority order (Tavily -> Brave -> Serper)
    const apiChain: { id: SearchProviderId; fn: (q: string, k: string, max: number) => Promise<WebSearchResult[]> }[] = [
      { id: "tavily", fn: searchTavily },
      { id: "brave", fn: searchBrave },
      { id: "serper", fn: searchSerper },
    ];

    for (const entry of apiChain) {
      const apiKey = keyMap.get(entry.id);
      if (!apiKey) continue;
      providersTried.push(entry.id);
      try {
        const rows = await entry.fn(cleanQuery, apiKey, maxResults);
        addResults(rows, entry.id);
        if (results.length >= maxResults) break;
      } catch (err) {
        errors.push(`${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 2. If web search still needs results, run Zero-Key DuckDuckGo + OSM Overpass (for local queries)
    if (results.length < Math.min(4, maxResults)) {
      const parsedLoc =
        options?.locationHint && options?.nicheHint
          ? { niche: options.nicheHint, location: options.locationHint }
          : extractLocationHint(cleanQuery);

      const tasks: Promise<void>[] = [];

      providersTried.push("duckduckgo");
      tasks.push(
        searchDuckDuckGo(cleanQuery, maxResults)
          .then((rows) => addResults(rows, "duckduckgo"))
          .catch((err) => {
            errors.push(`duckduckgo: ${err instanceof Error ? err.message : String(err)}`);
          }),
      );

      if (parsedLoc && parsedLoc.location) {
        providersTried.push("osm");
        tasks.push(
          searchOpenStreetMapBusinesses(parsedLoc.niche, parsedLoc.location, maxResults)
            .then((rows) => addResults(rows, "osm"))
            .catch((err) => {
              errors.push(`osm: ${err instanceof Error ? err.message : String(err)}`);
            }),
        );
      }

      await Promise.allSettled(tasks);
    }

    return {
      query: cleanQuery,
      results: results.slice(0, maxResults * 2),
      providersTried,
      providersSucceeded,
      errors,
    };
  },

  async searchForProspects(input: {
    industry: string;
    location: string;
    focus?: string;
    count: number;
  }): Promise<WebSearchResponse> {
    const query = [input.industry.trim(), input.location.trim() ? `in ${input.location.trim()}` : "", input.focus?.trim()]
      .filter(Boolean)
      .join(" ")
      .slice(0, 220);

    const maxResults = Math.min(14, Math.max(6, input.count * 2));
    const webRes = await WebSearchService.search(query, {
      maxResults,
      locationHint: input.location,
      nicheHint: input.industry,
    });

    // If user supplied a location and OSM wasn't already queried (e.g. Tavily answered partially),
    // also enrich with free OSM business addresses/phones/websites in parallel if count wasn't filled cleanly.
    const nonDirCount = webRes.results.filter((r) => !isDirectoryUrl(r.url)).length;
    if (input.location.trim() && nonDirCount < input.count && !webRes.providersTried.includes("osm")) {
      webRes.providersTried.push("osm");
      try {
        const osmRows = await searchOpenStreetMapBusinesses(input.industry, input.location, maxResults);
        if (osmRows.length > 0) {
          webRes.providersSucceeded.push("osm");
          const seen = new Set(webRes.results.map((r) => r.url.toLowerCase().replace(/\/+$/, "")));
          for (const row of osmRows) {
            const norm = row.url.toLowerCase().replace(/\/+$/, "");
            if (!seen.has(norm)) {
              seen.add(norm);
              webRes.results.push(row);
            }
          }
        }
      } catch (err) {
        webRes.errors.push(`osm: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return webRes;
  },
};
