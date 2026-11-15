export type LeadField =
  | "business"
  | "contact_name"
  | "role"
  | "email"
  | "website"
  | "phone"
  | "location"
  | "industry"
  | "notes";

export const LEAD_FIELDS: LeadField[] = [
  "business",
  "contact_name",
  "role",
  "email",
  "website",
  "phone",
  "location",
  "industry",
  "notes",
];

const SYNONYMS: Record<LeadField, string[]> = {
  business: [
    "business",
    "businessname",
    "company",
    "companyname",
    "organisation",
    "organization",
    "org",
    "brand",
    "church",
    "ministry",
    "institution",
    "company/organisation",
    "nameofbusiness",
    "accountname",
  ],
  contact_name: [
    "contact",
    "contactperson",
    "contactname",
    "fullname",
    "firstname",
    "name",
    "owner",
    "founder",
    "ceo",
    "pastor",
    "manager",
    "proprietor",
    "decisionmaker",
    "poc",
  ],
  role: ["role", "position", "jobtitle", "title", "designation", "occupation"],
  email: ["email", "emailaddress", "mail", "contactemail", "e-mail", "email1", "workemail", "primaryemail"],
  website: ["website", "web", "url", "site", "domain", "webaddress", "weburl", "companywebsite", "link"],
  phone: ["phone", "phonenumber", "telephone", "tel", "mobile", "contactnumber", "whatsapp", "gsm", "number"],
  location: ["location", "city", "state", "address", "country", "town", "region", "area", "lga", "branch"],
  industry: ["industry", "sector", "category", "niche", "businesstype", "type", "vertical", "field"],
  notes: ["notes", "note", "remarks", "description", "comment", "comments", "about", "details", "otherinfo"],
};

function norm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Maps detected header names onto lead fields. Exact synonym matches win over
 * partial matches, and each column can only be used once.
 */
export function mapHeaders(headers: string[]): Record<LeadField, number> {
  const normalized = headers.map((h) => norm(h));
  const used = new Set<number>();
  const result = {} as Record<LeadField, number>;
  for (const field of LEAD_FIELDS) result[field] = -1;

  const candidates: { field: LeadField; index: number; score: number }[] = [];
  for (const field of LEAD_FIELDS) {
    normalized.forEach((header, index) => {
      if (!header) return;
      const synonyms = SYNONYMS[field];
      if (synonyms.includes(header)) {
        candidates.push({ field, index, score: 100 });
        return;
      }
      for (const syn of synonyms) {
        if (syn.length >= 4 && header.includes(syn)) {
          candidates.push({ field, index, score: 60 + Math.min(syn.length, 20) });
          break;
        }
      }
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  for (const candidate of candidates) {
    if (used.has(candidate.index)) continue;
    if (result[candidate.field] !== -1) continue;
    result[candidate.field] = candidate.index;
    used.add(candidate.index);
  }
  // A column literally named "name" is a business name when no business column exists.
  if (result.business === -1 && result.contact_name !== -1 && normalized[result.contact_name] === "name") {
    result.business = result.contact_name;
    result.contact_name = -1;
  }
  return result;
}

export function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase().replace(/^mailto:/, "");
  if (!email || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return null;
  return email;
}

export function normalizeWebsite(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  if (/^(n\/?a|none|-|nil|no website)$/i.test(raw)) return null;
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, "")}`;
  try {
    const url = new URL(withProto);
    if (!url.hostname.includes(".")) return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function extractEmailsFromRow(cells: string[]): string | null {
  for (const cell of cells) {
    const match = String(cell ?? "").match(/[^\s,;<>]+@[^\s,;<>]+\.[a-z]{2,}/i);
    if (match) return normalizeEmail(match[0]);
  }
  return null;
}
