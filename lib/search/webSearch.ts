import { listAdminSearchKeys } from "@/lib/llm/store";
import type { SearchProviderId } from "@/lib/llm/types";
import {
  getCachedSearchEnrichment,
  isSearchProviderAvailable,
  markSearchProviderExhausted,
  recordSearchProviderUsage,
  setCachedSearchEnrichment,
} from "./quotaAndCache";
import { checkMobilePageSpeed } from "./pagespeed";
import {
  decodeHtmlEntities,
  fetchWithTimeout,
  inspectProspectWebsite,
  inspectProspectWebsites,
  isDirectoryUrl,
  stripHtmlToText,
  type InspectedWebsite,
} from "./siteInspector";

export { inspectProspectWebsite, inspectProspectWebsites, isDirectoryUrl, type InspectedWebsite };

export type ActiveSearchProvider = SearchProviderId | "duckduckgo" | "osm";

export interface WebSearchResult {
  title: string;
  url: string;
  domain: string;
  snippet: string;
  sourceProvider: ActiveSearchProvider;
  businessName?: string;
  address?: string;
  phone?: string;
  email?: string;
}

export interface WebSearchResponse {
  query: string;
  results: WebSearchResult[];
  providersTried: ActiveSearchProvider[];
  providersSucceeded: ActiveSearchProvider[];
  cacheHit?: boolean;
  errors: string[];
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function extractDomain(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
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

class SearchQuotaOrRateError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Search Provider 1: Exa Search API (Monthly-Refilling)
// ---------------------------------------------------------------------------

async function searchExa(query: string, apiKey: string, maxResults = 10): Promise<WebSearchResult[]> {
  const { res, text } = await fetchWithTimeout(
    "https://api.exa.ai/search",
    {
      method: "POST",
      headers: {
        "x-api-key": apiKey.trim(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        numResults: Math.min(12, Math.max(3, maxResults)),
        type: "auto",
        contents: { highlights: { numSentences: 2 } },
      }),
    },
    7_000,
    200_000,
  );
  if (res.status === 402 || res.status === 429) {
    throw new SearchQuotaOrRateError(`Exa HTTP ${res.status}`, res.status);
  }
  if (!res.ok) throw new Error(`Exa HTTP ${res.status}: ${text.slice(0, 140)}`);

  const data = JSON.parse(text) as {
    results?: { title?: string; url?: string; highlights?: string[]; text?: string }[];
  };
  return (Array.isArray(data.results) ? data.results : [])
    .map((r) => {
      const url = cleanResultUrl(String(r.url ?? ""));
      const snippet = Array.isArray(r.highlights) && r.highlights.length > 0
        ? r.highlights.join(" ").trim().slice(0, 420)
        : String(r.text ?? "").trim().slice(0, 420);
      return {
        title: String(r.title ?? "").trim() || url,
        url,
        domain: extractDomain(url),
        snippet,
        sourceProvider: "exa" as const,
      };
    })
    .filter((r) => r.url.startsWith("http"));
}

// ---------------------------------------------------------------------------
// Search Provider 2: Tavily Search API (Monthly-Refilling)
// ---------------------------------------------------------------------------

async function searchTavily(query: string, apiKey: string, maxResults = 10): Promise<WebSearchResult[]> {
  const { res, text } = await fetchWithTimeout(
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
    7_000,
    180_000,
  );
  if (res.status === 402 || res.status === 429) {
    throw new SearchQuotaOrRateError(`Tavily HTTP ${res.status}`, res.status);
  }
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}: ${text.slice(0, 160)}`);

  const data = JSON.parse(text) as {
    results?: { title?: string; url?: string; content?: string }[];
  };
  return (Array.isArray(data.results) ? data.results : [])
    .map((r) => {
      const url = cleanResultUrl(String(r.url ?? ""));
      return {
        title: String(r.title ?? "").trim() || url,
        url,
        domain: extractDomain(url),
        snippet: String(r.content ?? "").trim().slice(0, 420),
        sourceProvider: "tavily" as const,
      };
    })
    .filter((r) => r.url.startsWith("http"));
}

// ---------------------------------------------------------------------------
// Search Provider 3: Firecrawl Search API (Monthly-Refilling)
// ---------------------------------------------------------------------------

async function searchFirecrawl(query: string, apiKey: string, maxResults = 10): Promise<WebSearchResult[]> {
  const { res, text } = await fetchWithTimeout(
    "https://api.firecrawl.dev/v1/search",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        limit: Math.min(10, Math.max(3, maxResults)),
      }),
    },
    7_000,
    200_000,
  );
  if (res.status === 402 || res.status === 429) {
    throw new SearchQuotaOrRateError(`Firecrawl HTTP ${res.status}`, res.status);
  }
  if (!res.ok) throw new Error(`Firecrawl HTTP ${res.status}: ${text.slice(0, 160)}`);

  const data = JSON.parse(text) as {
    data?: { title?: string; url?: string; description?: string; markdown?: string }[];
  };
  return (Array.isArray(data.data) ? data.data : [])
    .map((r) => {
      const url = cleanResultUrl(String(r.url ?? ""));
      return {
        title: String(r.title ?? "").trim() || url,
        url,
        domain: extractDomain(url),
        snippet: String(r.description || r.markdown || "").trim().slice(0, 420),
        sourceProvider: "firecrawl" as const,
      };
    })
    .filter((r) => r.url.startsWith("http"));
}

// ---------------------------------------------------------------------------
// Search Provider 4: Brave Search & Serper (Reserve)
// ---------------------------------------------------------------------------

async function searchBrave(query: string, apiKey: string, maxResults = 10): Promise<WebSearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(12, Math.max(3, maxResults))}`;
  const { res, text } = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: { Accept: "application/json", "X-Subscription-Token": apiKey.trim() },
    },
    7_000,
    180_000,
  );
  if (res.status === 402 || res.status === 429) {
    throw new SearchQuotaOrRateError(`Brave HTTP ${res.status}`, res.status);
  }
  if (!res.ok) throw new Error(`Brave Search HTTP ${res.status}: ${text.slice(0, 160)}`);

  const data = JSON.parse(text) as {
    web?: { results?: { title?: string; url?: string; description?: string }[] };
  };
  return (Array.isArray(data.web?.results) ? data.web.results : [])
    .map((r) => {
      const resUrl = cleanResultUrl(String(r.url ?? ""));
      return {
        title: String(r.title ?? "").trim() || resUrl,
        url: resUrl,
        domain: extractDomain(resUrl),
        snippet: String(r.description ?? "").trim().slice(0, 420),
        sourceProvider: "brave" as const,
      };
    })
    .filter((r) => r.url.startsWith("http"));
}

async function searchSerper(query: string, apiKey: string, maxResults = 10): Promise<WebSearchResult[]> {
  const { res, text } = await fetchWithTimeout(
    "https://google.serper.dev/search",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": apiKey.trim() },
      body: JSON.stringify({ q: query, num: Math.min(12, Math.max(3, maxResults)) }),
    },
    7_000,
    180_000,
  );
  if (res.status === 402 || res.status === 429) {
    throw new SearchQuotaOrRateError(`Serper HTTP ${res.status}`, res.status);
  }
  if (!res.ok) throw new Error(`Serper HTTP ${res.status}: ${text.slice(0, 160)}`);

  const data = JSON.parse(text) as {
    organic?: { title?: string; link?: string; snippet?: string }[];
  };
  return (Array.isArray(data.organic) ? data.organic : [])
    .map((r) => {
      const resUrl = cleanResultUrl(String(r.link ?? ""));
      return {
        title: String(r.title ?? "").trim() || resUrl,
        url: resUrl,
        domain: extractDomain(resUrl),
        snippet: String(r.snippet ?? "").trim().slice(0, 420),
        sourceProvider: "serper" as const,
      };
    })
    .filter((r) => r.url.startsWith("http"));
}

// ---------------------------------------------------------------------------
// Keyless Fallback A: DuckDuckGo HTML / Lite ($0 Forever)
// ---------------------------------------------------------------------------

export function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  if (!html || /anomaly-modal|cc=botnet|Please verify you are human/i.test(html)) {
    return results;
  }

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
      domain: extractDomain(cur.url),
      snippet: snip,
      sourceProvider: "duckduckgo",
    });
  }

  if (results.length === 0) {
    const liteRegex = /<a[^>]+href=["']([^"']+)["'][^>]+class=["'][^"']*result-link[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = liteRegex.exec(html)) !== null) {
      const url = cleanResultUrl(decodeHtmlEntities(m[1] ?? ""));
      const title = decodeHtmlEntities(stripHtmlToText(m[2] ?? ""));
      if (url.startsWith("http") && title) {
        results.push({ title, url, domain: extractDomain(url), snippet: "", sourceProvider: "duckduckgo" });
      }
    }
  }

  return results;
}

async function searchDuckDuckGo(query: string, maxResults = 10): Promise<WebSearchResult[]> {
  const { res, text } = await fetchWithTimeout(
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

  const lite = await fetchWithTimeout(
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    { method: "GET", headers: { "User-Agent": BROWSER_UA, Accept: "text/html" } },
    6_000,
    180_000,
  );
  if (!lite.res.ok) throw new Error(`DuckDuckGo returned HTTP ${lite.res.status}`);
  return parseDuckDuckGoHtml(lite.text).slice(0, maxResults);
}

// ---------------------------------------------------------------------------
// Keyless Fallback B: OpenStreetMap Nominatim + Overpass Local Business API
// ---------------------------------------------------------------------------

function inferOsmFilters(niche: string): string[] {
  const lower = niche.toLowerCase();
  const pairs: { re: RegExp; tags: string[] }[] = [
    { re: /dent|orthodon|clinic|doctor|medical|health|chiro|optom|physio/, tags: ['["amenity"~"dentist|clinic|doctors|hospital|pharmacy"]', '["healthcare"]'] },
    { re: /church|ministry|parish|chapel|synagogue|mosque|temple/, tags: ['["amenity"="place_of_worship"]'] },
    { re: /ngo|nonprofit|charity|foundation|humanitarian/, tags: ['["office"="ngo"]', '["amenity"="social_facility"]'] },
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
  const geo = await fetchWithTimeout(
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

  const geoRows = JSON.parse(geo.text) as { boundingbox?: string[] }[];
  const bbox = geoRows[0]?.boundingbox;
  if (!Array.isArray(bbox) || bbox.length !== 4) return [];

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

  const ovp = await fetchWithTimeout(
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
    const address = [
      tags["addr:housenumber"],
      tags["addr:street"],
      tags["addr:city"] || cleanLoc,
      tags["addr:state"],
    ]
      .filter(Boolean)
      .join(" ")
      .trim();

    let matchScore = 0;
    const tagBlob = `${name} ${Object.values(tags).join(" ")}`.toLowerCase();
    for (const kw of keywords) {
      if (tagBlob.includes(kw)) matchScore += 3;
    }
    if (website) matchScore += 4;
    if (email) matchScore += 2;
    if (phone) matchScore += 1;

    const osmUrl = `https://www.openstreetmap.org/${el.type || "node"}/${el.id || ""}`;
    const fullUrl = website && /^https?:\/\//i.test(website) ? website : website ? `https://${website}` : osmUrl;
    scored.push({
      score: matchScore,
      item: {
        title: name,
        url: fullUrl,
        domain: extractDomain(fullUrl),
        snippet: [
          address ? `Address: ${address}` : "",
          phone ? `Phone: ${phone}` : "",
          email ? `Email: ${email}` : "",
          tags.amenity || tags.office || tags.shop || tags.craft
            ? `Category: ${tags.amenity || tags.office || tags.shop || tags.craft}`
            : "",
          "Source: OpenStreetMap",
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
// Admin Verification Helper (supports ALL 7 Search/Enrichment Providers)
// ---------------------------------------------------------------------------

export async function verifySearchKey(input: {
  provider: SearchProviderId;
  apiKey: string;
}): Promise<{ ok: boolean; count: number; ms: number; sampleTitle?: string }> {
  const started = Date.now();
  const key = input.apiKey.trim();
  if (!key) throw new Error("API key is required.");

  if (input.provider === "jina") {
    const { res, text } = await fetchWithTimeout(
      "https://r.jina.ai/https://example.com",
      { method: "GET", headers: { Authorization: `Bearer ${key}`, Accept: "text/plain" } },
      6_000,
      20_000,
    );
    if (!res.ok) throw new Error(`Jina Reader HTTP ${res.status}: ${text.slice(0, 120)}`);
    return { ok: true, count: 1, ms: Date.now() - started, sampleTitle: "Example Domain" };
  }

  if (input.provider === "pagespeed") {
    const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(
      "https://example.com",
    )}&strategy=mobile&category=performance&key=${encodeURIComponent(key)}`;
    const { res, text } = await fetchWithTimeout(endpoint, { method: "GET" }, 8_000, 120_000);
    if (!res.ok) throw new Error(`PageSpeed HTTP ${res.status}: ${text.slice(0, 120)}`);
    return { ok: true, count: 1, ms: Date.now() - started, sampleTitle: "PageSpeed v5" };
  }

  if (input.provider === "hunter") {
    const { res, text } = await fetchWithTimeout(
      `https://api.hunter.io/v2/account?api_key=${encodeURIComponent(key)}`,
      { method: "GET" },
      6_000,
      20_000,
    );
    if (!res.ok) throw new Error(`Hunter HTTP ${res.status}: ${text.slice(0, 120)}`);
    return { ok: true, count: 1, ms: Date.now() - started, sampleTitle: "Hunter.io Account" };
  }

  if (input.provider === "cufinder") {
    const { res, text } = await fetchWithTimeout(
      "https://api.cufinder.io/api/v2/dte",
      {
        method: "POST",
        headers: { "x-api-key": key, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ company_name: "Stripe", country: "US" }).toString(),
      },
      6_000,
      20_000,
    );
    if (!res.ok) throw new Error(`CUFinder HTTP ${res.status}: ${text.slice(0, 120)}`);
    return { ok: true, count: 1, ms: Date.now() - started, sampleTitle: "CUFinder API" };
  }

  let results: WebSearchResult[] = [];
  if (input.provider === "exa") results = await searchExa("B2B SaaS websites", key, 3);
  else if (input.provider === "tavily") results = await searchTavily("test", key, 3);
  else if (input.provider === "firecrawl") results = await searchFirecrawl("test", key, 3);
  else if (input.provider === "brave") results = await searchBrave("test", key, 3);
  else results = await searchSerper("test", key, 3);

  return {
    ok: true,
    count: results.length,
    ms: Date.now() - started,
    sampleTitle: results[0]?.title,
  };
}

// ---------------------------------------------------------------------------
// Zero-Cost-First WebSearchService Cascade
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
      bypassCache?: boolean;
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

    const cacheKey = `search:${cleanQuery.toLowerCase()}:${(options?.locationHint ?? "").toLowerCase()}`;
    if (!options?.bypassCache) {
      const cached = await getCachedSearchEnrichment<WebSearchResponse>(cacheKey);
      if (cached && cached.results.length > 0) {
        return { ...cached, cacheHit: true };
      }
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
    const seenDomains = new Set<string>();

    const addResults = (rows: WebSearchResult[], provider: ActiveSearchProvider) => {
      if (rows.length > 0 && !providersSucceeded.includes(provider)) {
        providersSucceeded.push(provider);
      }
      for (const r of rows) {
        const normUrl = r.url.toLowerCase().replace(/\/+$/, "");
        const domain = r.domain || extractDomain(r.url);
        if (!normUrl || seenUrls.has(normUrl)) continue;
        // Deduplicate multiple pages from the exact same non-directory domain
        if (domain && !isDirectoryUrl(r.url) && seenDomains.has(domain)) continue;
        seenUrls.add(normUrl);
        if (domain) seenDomains.add(domain);
        results.push({ ...r, domain });
      }
    };

    const parsedLoc =
      options?.locationHint && options?.nicheHint
        ? { niche: options.nicheHint, location: options.locationHint }
        : extractLocationHint(cleanQuery);

    // 1. Smart Zero-Cost-First: For local/geo queries, run OpenStreetMap (0 credits) immediately!
    const osmPromise =
      parsedLoc && parsedLoc.location
        ? (providersTried.push("osm"),
          searchOpenStreetMapBusinesses(parsedLoc.niche, parsedLoc.location, maxResults)
            .then(async (rows) => {
              await recordSearchProviderUsage("osm", 1);
              addResults(rows, "osm");
            })
            .catch((err) => {
              errors.push(`osm: ${err instanceof Error ? err.message : String(err)}`);
            }))
        : Promise.resolve();

    // 2. Web search cascade: Monthly-refilling keys (Exa -> Tavily -> Firecrawl -> Brave) -> One-time reserve (Serper)
    const apiChain: {
      id: SearchProviderId;
      fn: (q: string, k: string, max: number) => Promise<WebSearchResult[]>;
    }[] = [
      { id: "exa", fn: searchExa },
      { id: "tavily", fn: searchTavily },
      { id: "firecrawl", fn: searchFirecrawl },
      { id: "brave", fn: searchBrave },
      { id: "serper", fn: searchSerper },
    ];

    for (const entry of apiChain) {
      const apiKey = keyMap.get(entry.id);
      if (!apiKey) continue;
      if (!(await isSearchProviderAvailable(entry.id))) continue;

      providersTried.push(entry.id);
      try {
        const rows = await entry.fn(cleanQuery, apiKey, maxResults);
        await recordSearchProviderUsage(entry.id, 1);
        addResults(rows, entry.id);
        if (results.filter((r) => !isDirectoryUrl(r.url)).length >= Math.min(6, maxResults)) {
          break;
        }
      } catch (err) {
        if (err instanceof SearchQuotaOrRateError) {
          await markSearchProviderExhausted(entry.id);
        }
        errors.push(`${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await osmPromise;

    // 3. Keyless DuckDuckGo HTML fallback whenever we still need results
    if (results.length < Math.min(4, maxResults)) {
      providersTried.push("duckduckgo");
      try {
        const ddgRows = await searchDuckDuckGo(cleanQuery, maxResults);
        await recordSearchProviderUsage("duckduckgo", 1);
        addResults(ddgRows, "duckduckgo");
      } catch (err) {
        errors.push(`duckduckgo: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const response: WebSearchResponse = {
      query: cleanQuery,
      results: results.slice(0, maxResults * 2),
      providersTried,
      providersSucceeded,
      errors,
    };

    if (response.results.length > 0 && !options?.bypassCache) {
      await setCachedSearchEnrichment(cacheKey, "search", response);
    }

    return response;
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

    return WebSearchService.search(query, {
      maxResults: Math.min(14, Math.max(6, input.count * 2)),
      locationHint: input.location,
      nicheHint: input.industry,
    });
  },
};

export { checkMobilePageSpeed };
