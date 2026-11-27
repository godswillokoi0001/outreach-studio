import { normalizeWebsite } from "@/lib/columns";
import { listAdminSearchKeys } from "@/lib/llm/store";
import { isFetchableUrl } from "@/lib/outreach-utils";
import { verifyEmailDeliverability, type EmailInboxType } from "./emailVerify";
import {
  isSearchProviderAvailable,
  markSearchProviderExhausted,
  recordSearchProviderUsage,
} from "./quotaAndCache";
import {
  decodeHtmlEntities,
  fetchWithTimeout,
  inspectProspectWebsite,
  stripHtmlToText,
  type InspectedWebsite,
} from "./siteInspector";
import { WebSearchService } from "./webSearch";

export interface DecisionMakerLead {
  name: string;
  role: string;
}

export interface SocialProfileLink {
  platform: string;
  url: string;
  handle?: string;
}

export interface DeepContactProfile {
  business: string;
  website: string;
  domain: string;
  location: string;
  emails: string[];
  primaryEmail: string;
  emailType: EmailInboxType;
  mxVerified: boolean;
  phones: string[];
  primaryPhone: string;
  socials: SocialProfileLink[];
  decisionMakers: DecisionMakerLead[];
  contactPagesChecked: string[];
  inspectedSite: InspectedWebsite | null;
  hasVerifiedContact: boolean;
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const EMAIL_BLOCKLIST_RE =
  /(?:^example@|@example\.|@sentry\.|@wixpress\.com|@squarespace\.com|@wordpress\.org|noreply@|no-reply@|donotreply@|mailer-daemon@|\.(?:png|jpg|jpeg|gif|svg|webp|css|js)$)/i;

const NON_NAME_STOPWORDS = new Set([
  "About",
  "Home",
  "Contact",
  "Services",
  "Clinic",
  "Dental",
  "Dentistry",
  "Family",
  "Welcome",
  "Privacy",
  "Terms",
  "Book",
  "Schedule",
  "Office",
  "Appointments",
  "Team",
  "Staff",
  "Patient",
  "Patients",
  "Reviews",
  "Blog",
  "News",
  "Learn",
  "Read",
  "More",
  "Click",
  "View",
  "Menu",
  "Login",
  "Sign",
  "Email",
  "Phone",
  "Hours",
]);

/** Decodes Cloudflare `/cdn-cgi/l/email-protection` `data-cfemail` hex XOR strings cleanly. */
export function decodeCfEmail(hex: string): string {
  const clean = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6,}$/i.test(clean) || clean.length % 2 !== 0) return "";
  try {
    const key = Number.parseInt(clean.slice(0, 2), 16);
    let out = "";
    for (let i = 2; i < clean.length; i += 2) {
      out += String.fromCharCode(Number.parseInt(clean.slice(i, i + 2), 16) ^ key);
    }
    const lower = out.trim().toLowerCase();
    if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(lower) && !EMAIL_BLOCKLIST_RE.test(lower)) {
      return lower;
    }
    return "";
  } catch {
    return "";
  }
}

export function extractEmailsDeep(html: string, text: string): string[] {
  const found = new Set<string>();

  // 1. Explicit mailto:
  const mailtoRe = /href=["']mailto:([^"'?#\s>]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = mailtoRe.exec(html)) !== null) {
    const em = decodeURIComponent(m[1] ?? "").trim().toLowerCase();
    if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(em) && !EMAIL_BLOCKLIST_RE.test(em)) {
      found.add(em);
    }
  }

  // 2. Cloudflare data-cfemail & email-protection href hashes
  const cfAttrRe = /data-cfemail=["']([0-9a-f]+)["']/gi;
  while ((m = cfAttrRe.exec(html)) !== null) {
    const decoded = decodeCfEmail(m[1] ?? "");
    if (decoded) found.add(decoded);
  }
  const cfHrefRe = /\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/gi;
  while ((m = cfHrefRe.exec(html)) !== null) {
    const decoded = decodeCfEmail(m[1] ?? "");
    if (decoded) found.add(decoded);
  }

  // 3. [at] / (at) obfuscated emails
  const obfRe = /\b([a-z0-9._%+-]+)\s*(?:\[at\]|\(at\))\s*([a-z0-9.-]+)\s*(?:\.|\[dot\]|\(dot\))\s*([a-z]{2,})\b/gi;
  while ((m = obfRe.exec(text)) !== null) {
    const em = `${m[1]}@${m[2]}.${m[3]}`.toLowerCase();
    if (!EMAIL_BLOCKLIST_RE.test(em)) found.add(em);
  }

  // 4. Direct plaintext regex
  const plainRe = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;
  while ((m = plainRe.exec(text)) !== null) {
    const em = (m[0] ?? "").trim().toLowerCase();
    if (!EMAIL_BLOCKLIST_RE.test(em)) found.add(em);
  }

  return Array.from(found).slice(0, 8);
}

export function extractPhonesDeep(html: string, text: string): string[] {
  const found = new Set<string>();
  const addPhone = (raw: string) => {
    const cleaned = raw.replace(/\s+/g, " ").trim();
    const digits = cleaned.replace(/\D/g, "");
    if (digits.length >= 10 && digits.length <= 15) {
      found.add(cleaned);
    }
  };

  const telRe = /href=["']tel:([^"'?\s>]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = telRe.exec(html)) !== null) {
    addPhone(decodeURIComponent(m[1] ?? ""));
  }

  // Standard US/UK/International phone patterns in visible text
  const textPhoneRe = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3,4}\)|\d{3,4})[\s.-]\d{3,4}[\s.-]\d{3,5}\b/g;
  while ((m = textPhoneRe.exec(text)) !== null) {
    addPhone(m[0] ?? "");
    if (found.size >= 5) break;
  }

  return Array.from(found).slice(0, 4);
}

function classifySocialPlatform(url: string): SocialProfileLink | null {
  const clean = url.replace(/[).,;]+$/, "").trim();
  const lower = clean.toLowerCase();
  if (/sharer|intent\/tweet|plugins\/|privacy|terms|policy/i.test(lower)) return null;

  const extractHandle = (re: RegExp): string | undefined => {
    const match = clean.match(re);
    return match?.[1] ? `@${match[1]}` : undefined;
  };

  if (lower.includes("linkedin.com/")) {
    return { platform: "LinkedIn", url: clean, handle: extractHandle(/linkedin\.com\/(?:company|in)\/([^/?#]+)/i) };
  }
  if (lower.includes("instagram.com/")) {
    return { platform: "Instagram", url: clean, handle: extractHandle(/instagram\.com\/([^/?#]+)/i) };
  }
  if (lower.includes("facebook.com/")) {
    return { platform: "Facebook", url: clean, handle: extractHandle(/facebook\.com\/([^/?#]+)/i) };
  }
  if (lower.includes("x.com/") || lower.includes("twitter.com/")) {
    return { platform: "X", url: clean, handle: extractHandle(/(?:x|twitter)\.com\/([^/?#]+)/i) };
  }
  if (lower.includes("youtube.com/")) {
    return { platform: "YouTube", url: clean };
  }
  if (lower.includes("tiktok.com/")) {
    return { platform: "TikTok", url: clean, handle: extractHandle(/tiktok\.com\/(@?[^/?#]+)/i) };
  }
  return null;
}

export function extractSocialsDeep(html: string): SocialProfileLink[] {
  const regex = /https?:\/\/(?:www\.)?(?:linkedin\.com|facebook\.com|instagram\.com|x\.com|twitter\.com|youtube\.com|tiktok\.com)\/[^\s"'<>]+/gi;
  const seen = new Set<string>();
  const out: SocialProfileLink[] = [];
  const matches = html.match(regex) ?? [];
  for (const raw of matches) {
    const parsed = classifySocialPlatform(raw);
    if (!parsed) continue;
    const key = parsed.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
    if (out.length >= 6) break;
  }
  return out;
}

export interface JsonLdExtractedData {
  emails: string[];
  phones: string[];
  addresses: string[];
  socials: SocialProfileLink[];
  decisionMakers: DecisionMakerLead[];
}

export function extractJsonLdContacts(html: string): JsonLdExtractedData {
  const out: JsonLdExtractedData = {
    emails: [],
    phones: [],
    addresses: [],
    socials: [],
    decisionMakers: [],
  };
  const emailSet = new Set<string>();
  const phoneSet = new Set<string>();
  const addrSet = new Set<string>();
  const socialSet = new Set<string>();
  const personSet = new Set<string>();

  const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;

  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const rec = node as Record<string, unknown>;
    if (Array.isArray(rec["@graph"])) visit(rec["@graph"]);

    if (typeof rec.email === "string") {
      const em = rec.email.replace(/^mailto:/i, "").trim().toLowerCase();
      if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(em) && !EMAIL_BLOCKLIST_RE.test(em)) {
        emailSet.add(em);
      }
    }

    if (typeof rec.telephone === "string") {
      const digits = rec.telephone.replace(/\D/g, "");
      if (digits.length >= 7 && digits.length <= 16) {
        phoneSet.add(rec.telephone.trim());
      }
    }

    if (rec.address && typeof rec.address === "object") {
      const a = rec.address as Record<string, unknown>;
      const parts = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode, a.addressCountry]
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.trim());
      if (parts.length > 0) addrSet.add(parts.join(", ").slice(0, 180));
    } else if (typeof rec.address === "string" && rec.address.trim()) {
      addrSet.add(rec.address.trim().slice(0, 180));
    }

    const sameAsList = Array.isArray(rec.sameAs)
      ? rec.sameAs
      : typeof rec.sameAs === "string"
        ? [rec.sameAs]
        : [];
    for (const sUrl of sameAsList) {
      if (typeof sUrl !== "string") continue;
      const soc = classifySocialPlatform(sUrl);
      if (soc && !socialSet.has(soc.url.toLowerCase())) {
        socialSet.add(soc.url.toLowerCase());
        out.socials.push(soc);
      }
    }

    const typeVal = String(rec["@type"] ?? "").toLowerCase();
    if (typeVal.includes("person") && typeof rec.name === "string" && rec.name.trim()) {
      const name = rec.name.trim().slice(0, 80);
      const role = typeof rec.jobTitle === "string" && rec.jobTitle.trim() ? rec.jobTitle.trim().slice(0, 80) : "Team Member";
      const key = name.toLowerCase();
      if (!personSet.has(key)) {
        personSet.add(key);
        out.decisionMakers.push({ name, role });
      }
    }

    for (const field of ["founder", "founders", "employee", "employees", "director", "contactPoint"]) {
      const val = rec[field];
      if (!val) continue;
      const items = Array.isArray(val) ? val : [val];
      for (const item of items) {
        if (typeof item === "string" && item.trim()) {
          const clean = item.trim().slice(0, 80);
          if (!personSet.has(clean.toLowerCase())) {
            personSet.add(clean.toLowerCase());
            out.decisionMakers.push({ name: clean, role: field === "founder" || field === "founders" ? "Founder" : "Leadership" });
          }
        } else {
          visit(item);
        }
      }
    }
  };

  while ((m = scriptRe.exec(html)) !== null) {
    const rawJson = decodeHtmlEntities(m[1] ?? "").trim();
    if (!rawJson) continue;
    try {
      const parsed = JSON.parse(rawJson);
      visit(parsed);
    } catch {
      /* ignore malformed JSON-LD */
    }
  }

  out.emails = Array.from(emailSet).slice(0, 6);
  out.phones = Array.from(phoneSet).slice(0, 4);
  out.addresses = Array.from(addrSet).slice(0, 2);
  return out;
}

export function extractVisibleDecisionMakers(text: string): DecisionMakerLead[] {
  const out: DecisionMakerLead[] = [];
  const seen = new Set<string>();
  const roleRe = "(?:Founder|Co-Founder|Owner|CEO|Chief Executive|Managing Director|Director|Practice Manager|Lead Dentist|Lead Pastor|Pastor|Dr\\.|Partner|Principal)";
  const nameRe = "(?:Dr\\.\\s+)?[A-Z][a-z]{1,18}\\s+[A-Z][a-z]{1,18}(?:\\s+[A-Z][a-z]{1,15})?";

  const isPlausibleName = (rawName: string): boolean => {
    const tokens = rawName.replace(/^Dr\.\s+/i, "").trim().split(/\s+/);
    if (tokens.length < 2) return false;
    return tokens.every((t) => !NON_NAME_STOPWORDS.has(t));
  };

  // Pattern A: "Dr. Sarah Chen, DDS / Founder" or "John Miller - Owner"
  const patA = new RegExp(`(${nameRe})\\s*(?:,|–|-|\\|)\\s*(${roleRe}[^\\n.;,]{0,30})`, "g");
  let m: RegExpExecArray | null;
  while ((m = patA.exec(text)) !== null) {
    const name = (m[1] ?? "").trim();
    const role = (m[2] ?? "").trim().slice(0, 60);
    if (isPlausibleName(name) && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      out.push({ name, role });
      if (out.length >= 4) return out;
    }
  }

  // Pattern B: "Founder: John Miller" or "Practice Owner — Jane Doe"
  const patB = new RegExp(`(${roleRe})\\s*(?::|–|-)\\s*(${nameRe})`, "g");
  while ((m = patB.exec(text)) !== null) {
    const role = (m[1] ?? "").trim().slice(0, 60);
    const name = (m[2] ?? "").trim();
    if (isPlausibleName(name) && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      out.push({ name, role });
      if (out.length >= 4) return out;
    }
  }

  return out;
}

function discoverSubpageLinks(html: string, baseUrl: string): string[] {
  const links = new Set<string>();
  const hrefRe = /<a[^>]+href=["']([^"'#]+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  const wantPathRe = /\/(?:contact(?:-us)?|about(?:-us)?|team|our-team|staff|leadership)(?:\/|$)/i;
  let baseOrigin = "";
  try {
    baseOrigin = new URL(baseUrl).origin;
  } catch {
    return [];
  }

  while ((m = hrefRe.exec(html)) !== null) {
    const raw = (m[1] ?? "").trim();
    if (!raw || raw.startsWith("mailto:") || raw.startsWith("tel:")) continue;
    try {
      const resolved = new URL(raw, baseUrl);
      if (resolved.origin !== baseOrigin) continue;
      if (wantPathRe.test(resolved.pathname) && resolved.pathname !== "/") {
        links.add(resolved.toString());
        if (links.size >= 3) break;
      }
    } catch {
      /* ignore invalid href */
    }
  }

  // Fallback standard paths if nav anchors weren't obvious
  for (const fallbackPath of ["/contact", "/about", "/team"]) {
    if (links.size >= 3) break;
    try {
      const u = new URL(fallbackPath, baseUrl).toString();
      if (isFetchableUrl(u)) links.add(u);
    } catch {
      /* ignore */
    }
  }

  return Array.from(links).slice(0, 3);
}

async function fetchHtmlQuick(url: string, timeoutMs = 4_000): Promise<string> {
  try {
    const { res, text } = await fetchWithTimeout(
      url,
      {
        method: "GET",
        redirect: "follow",
        headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml" },
      },
      timeoutMs,
      200_000,
    );
    if (!res.ok) return "";
    return text;
  } catch {
    return "";
  }
}

async function lookupHunterDomainEmails(domain: string): Promise<string[]> {
  if (!domain) return [];
  const keys = await listAdminSearchKeys();
  const hunterKey = keys.find((k) => k.provider === "hunter")?.apiKey;
  if (!hunterKey) return [];
  if (!(await isSearchProviderAvailable("hunter"))) return [];

  try {
    const { res, text } = await fetchWithTimeout(
      `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=5&api_key=${encodeURIComponent(hunterKey)}`,
      { method: "GET" },
      5_000,
      60_000,
    );
    if (res.status === 402 || res.status === 429) {
      await markSearchProviderExhausted("hunter");
      return [];
    }
    if (!res.ok) return [];
    await recordSearchProviderUsage("hunter", 1);

    const parsed = JSON.parse(text) as { data?: { emails?: { value?: string }[] } };
    return (parsed.data?.emails ?? [])
      .map((e) => (e.value ?? "").trim().toLowerCase())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function extractDomainSafe(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

export async function findDeepContactsForProspect(input: {
  business: string;
  website?: string;
  location?: string;
  osmPhone?: string;
  osmEmail?: string;
  osmAddress?: string;
  snippet?: string;
  allowTargetedSearch?: boolean;
  timeoutMs?: number;
}): Promise<DeepContactProfile> {
  const normSite = input.website ? normalizeWebsite(input.website) : null;
  const domain = normSite ? extractDomainSafe(normSite) : "";
  const timeoutMs = input.timeoutMs ?? 4_000;

  const emailSet = new Set<string>();
  const phoneSet = new Set<string>();
  const socialMap = new Map<string, SocialProfileLink>();
  const dmMap = new Map<string, DecisionMakerLead>();
  let resolvedLocation = (input.osmAddress || input.location || "").trim();

  if (input.osmEmail && !EMAIL_BLOCKLIST_RE.test(input.osmEmail.toLowerCase())) {
    emailSet.add(input.osmEmail.trim().toLowerCase());
  }
  if (input.osmPhone?.trim()) phoneSet.add(input.osmPhone.trim());

  // Extract any contact present in initial search snippet
  if (input.snippet) {
    for (const em of extractEmailsDeep("", input.snippet)) emailSet.add(em);
    for (const ph of extractPhonesDeep("", input.snippet)) phoneSet.add(ph);
  }

  let inspectedSite: InspectedWebsite | null = null;
  const checkedPages: string[] = [];

  if (normSite && isFetchableUrl(normSite)) {
    const rawHomeHtml = await fetchHtmlQuick(normSite, timeoutMs);
    inspectedSite = await inspectProspectWebsite(normSite, { timeoutMs });

    if (inspectedSite) {
      checkedPages.push(inspectedSite.finalUrl || normSite);
      for (const em of inspectedSite.emails) emailSet.add(em.toLowerCase());
      for (const ph of inspectedSite.phones) phoneSet.add(ph);
      for (const soc of inspectedSite.socialLinks) {
        socialMap.set(soc.url.toLowerCase(), soc);
      }
      for (const dm of extractVisibleDecisionMakers(inspectedSite.textSummary)) {
        dmMap.set(dm.name.toLowerCase(), dm);
      }
    }

    if (rawHomeHtml) {
      for (const em of extractEmailsDeep(rawHomeHtml, stripHtmlToText(rawHomeHtml))) emailSet.add(em);
      for (const ph of extractPhonesDeep(rawHomeHtml, stripHtmlToText(rawHomeHtml))) phoneSet.add(ph);
      for (const soc of extractSocialsDeep(rawHomeHtml)) socialMap.set(soc.url.toLowerCase(), soc);
      const jsonLd = extractJsonLdContacts(rawHomeHtml);
      for (const em of jsonLd.emails) emailSet.add(em);
      for (const ph of jsonLd.phones) phoneSet.add(ph);
      for (const soc of jsonLd.socials) socialMap.set(soc.url.toLowerCase(), soc);
      for (const dm of jsonLd.decisionMakers) dmMap.set(dm.name.toLowerCase(), dm);
      if (!resolvedLocation && jsonLd.addresses[0]) resolvedLocation = jsonLd.addresses[0];

      // Crawl up to 3 high-value contact/about/team subpages in parallel (0 credits)
      const subLinks = discoverSubpageLinks(rawHomeHtml, normSite);
      const subPages = await Promise.allSettled(
        subLinks.map(async (u) => ({ url: u, html: await fetchHtmlQuick(u, timeoutMs) })),
      );
      for (const res of subPages) {
        if (res.status !== "fulfilled" || !res.value.html) continue;
        const { url, html } = res.value;
        checkedPages.push(url);
        const text = stripHtmlToText(html);
        for (const em of extractEmailsDeep(html, text)) emailSet.add(em);
        for (const ph of extractPhonesDeep(html, text)) phoneSet.add(ph);
        for (const soc of extractSocialsDeep(html)) socialMap.set(soc.url.toLowerCase(), soc);
        for (const dm of extractVisibleDecisionMakers(text)) dmMap.set(dm.name.toLowerCase(), dm);
        const ld = extractJsonLdContacts(html);
        for (const em of ld.emails) emailSet.add(em);
        for (const ph of ld.phones) phoneSet.add(ph);
        for (const soc of ld.socials) socialMap.set(soc.url.toLowerCase(), soc);
        for (const dm of ld.decisionMakers) dmMap.set(dm.name.toLowerCase(), dm);
        if (!resolvedLocation && ld.addresses[0]) resolvedLocation = ld.addresses[0];
      }
    }
  }

  // Step C: One targeted WebSearch enrichment query ONLY if live website had zero emails OR zero owners
  if (input.allowTargetedSearch !== false && (emailSet.size === 0 || dmMap.size === 0) && input.business.trim()) {
    const city = resolvedLocation.split(",")[0]?.trim() || "";
    const query = `"${input.business.trim()}"${city ? ` "${city}"` : ""} ("@" OR email OR LinkedIn OR founder OR owner OR director)`;
    const enriched = await WebSearchService.search(query, { maxResults: 5 }).catch(() => null);
    for (const r of enriched?.results ?? []) {
      for (const em of extractEmailsDeep("", `${r.title} ${r.snippet}`)) emailSet.add(em);
      const soc = classifySocialPlatform(r.url);
      if (soc) socialMap.set(soc.url.toLowerCase(), soc);
      for (const dm of extractVisibleDecisionMakers(`${r.title} ${r.snippet}`)) {
        dmMap.set(dm.name.toLowerCase(), dm);
      }
    }
  }

  // Step D: Optional Hunter.io enrichment hook if key exists & still no email
  if (emailSet.size === 0 && domain) {
    for (const em of await lookupHunterDomainEmails(domain)) emailSet.add(em);
  }

  // Step E: MX Verification & direct-vs-role ranking
  const verifiedEmails: string[] = [];
  let bestEmail = "";
  let bestType: EmailInboxType = "invalid";
  let anyMx = false;

  for (const em of Array.from(emailSet).slice(0, 5)) {
    const check = await verifyEmailDeliverability(em);
    if (check.syntaxValid && !check.disposable) {
      verifiedEmails.push(check.email);
      if (check.mxVerified) anyMx = true;
      const shouldPromote =
        !bestEmail ||
        (check.mxVerified && !anyMx) ||
        (check.emailType === "direct" && bestType !== "direct");
      if (shouldPromote) {
        bestEmail = check.email;
        bestType = check.emailType;
      }
    }
  }

  const phones = Array.from(phoneSet).slice(0, 4);
  const socials = Array.from(socialMap.values()).slice(0, 6);
  const decisionMakers = Array.from(dmMap.values()).slice(0, 4);
  const hasVerifiedContact = verifiedEmails.length > 0 || phones.length > 0 || socials.length > 0;

  return {
    business: input.business.trim(),
    website: inspectedSite?.finalUrl || normSite || "",
    domain,
    location: resolvedLocation,
    emails: verifiedEmails,
    primaryEmail: bestEmail,
    emailType: bestType,
    mxVerified: anyMx,
    phones,
    primaryPhone: phones[0] ?? "",
    socials,
    decisionMakers,
    contactPagesChecked: checkedPages,
    inspectedSite,
    hasVerifiedContact,
  };
}
