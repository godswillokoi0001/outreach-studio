import { classifyEmailType } from "./emailClassify";

const SYNTHETIC_PLACEHOLDER_PATTERNS = [
  /@example\.(?:com|org|net)$/i,
  /@test\./i,
  /@invalid$/i,
  /(?:^|\.)placeholder(?:\.|$)/i,
  /^(?:placeholder|tbd|unknown|none|fake|test|demo|sample|noreply|no-reply|donotreply)@/i,
];

export function isPlaceholderOrSyntheticEmail(email: string): boolean {
  const clean = email.trim().toLowerCase();
  if (!clean || !clean.includes("@") || clean.includes(" ")) return false;
  return SYNTHETIC_PLACEHOLDER_PATTERNS.some((re) => re.test(clean));
}

export interface ContactableCandidateInput {
  business?: string;
  website?: string;
  location?: string;
  email?: string;
  phone?: string;
  socials?: { platform?: string; url?: string }[];
  decisionMaker?: string;
  mxVerified?: boolean;
}

export interface ContactabilityVerdict {
  contactable: boolean;
  reason?: string;
  completenessRank: number;
}

/**
 * Hard "No Verified Contact = Do Not Save" firewall.
 * Rejects any discovered prospect missing verified business + website/location OR lacking
 * at least one real contact channel (verified email, phone, or social URL).
 */
export function validateContactableLead(input: ContactableCandidateInput): ContactabilityVerdict {
  const business = (input.business ?? "").trim();
  const website = (input.website ?? "").trim();
  const location = (input.location ?? "").trim();
  const email = (input.email ?? "").trim().toLowerCase();
  const phone = (input.phone ?? "").trim();
  const socials = Array.isArray(input.socials) ? input.socials.filter((s) => Boolean(s?.url?.trim())) : [];

  if (!business) {
    return { contactable: false, reason: "Missing verified business name.", completenessRank: 0 };
  }
  if (!website && !location) {
    return { contactable: false, reason: "Missing both verified website URL and location.", completenessRank: 0 };
  }

  if (email && isPlaceholderOrSyntheticEmail(email)) {
    return { contactable: false, reason: `Placeholder email rejected (${email}).`, completenessRank: 0 };
  }

  const hasEmail = Boolean(email && email.includes("@") && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email));
  const hasPhone = phone.replace(/\D/g, "").length >= 7;
  const hasSocial = socials.length > 0;

  if (!hasEmail && !hasPhone && !hasSocial) {
    return {
      contactable: false,
      reason: "No verified email, phone number, or social profile found.",
      completenessRank: 0,
    };
  }

  const emailType = hasEmail ? classifyEmailType(email) : "invalid";
  const completenessRank =
    (hasEmail ? 100 : 0) +
    (hasEmail && input.mxVerified ? 20 : 0) +
    (emailType === "direct" ? 30 : 0) +
    (input.decisionMaker?.trim() ? 25 : 0) +
    (hasPhone ? 15 : 0) +
    (hasSocial ? 10 : 0) +
    (location ? 10 : 0);

  return { contactable: true, completenessRank };
}

/**
 * Hard anti-placeholder gate for operator `add_lead` tool calls.
 * Blocks invented `info@` or placeholder emails and zero-contact leads unless
 * the human user explicitly typed those details or they came from verified discovery.
 */
export function validateOperatorAddLead(
  args: {
    business?: string;
    email?: string;
    phone?: string;
    website?: string;
    location?: string;
    social?: string;
    socials?: unknown[];
  },
  context?: {
    userTextCorpus?: string;
    verifiedEvidenceCorpus?: string;
  },
): { allowed: boolean; error?: string } {
  const business = (args.business ?? "").trim();
  const email = (args.email ?? "").trim().toLowerCase();
  const phone = (args.phone ?? "").trim();
  const socialStr = (args.social ?? "").trim();
  const socialsArr = Array.isArray(args.socials) ? args.socials.filter(Boolean) : [];

  if (!business) {
    return { allowed: false, error: "Business name is required." };
  }

  if (email && isPlaceholderOrSyntheticEmail(email)) {
    return {
      allowed: false,
      error: "BLOCKED: Cannot add unverified or placeholder leads. Live discovery must succeed and extract real contact details.",
    };
  }

  const hasSocial = Boolean(socialStr || socialsArr.length > 0);
  const hasPhone = phone.replace(/\D/g, "").length >= 7;
  const hasEmail = Boolean(email && email.includes("@"));

  if (!hasEmail && !hasPhone && !hasSocial) {
    return {
      allowed: false,
      error: "BLOCKED: Cannot add unverified or placeholder leads. Live discovery must succeed and extract real contact details.",
    };
  }

  const combinedCorpus = `${context?.userTextCorpus ?? ""}\n${context?.verifiedEvidenceCorpus ?? ""}`.toLowerCase();
  if (combinedCorpus.trim()) {
    // Reject guessed `info@<domain>` or unverified emails that never appeared in user prompt OR verified discovery output
    if (hasEmail && !combinedCorpus.includes(email)) {
      return {
        allowed: false,
        error: "BLOCKED: Cannot add unverified or placeholder leads. Live discovery must succeed and extract real contact details.",
      };
    }
  }

  return { allowed: true };
}

/**
 * Audits existing persisted leads so legacy test/unverified/placeholder rows
 * are flagged cleanly as "Needs Contact Verification" and can be filtered or removed in 1 click.
 */
export function isLeadMissingVerifiedContact(lead: {
  business?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  location?: string | null;
  notes?: string | null;
  research?: {
    socials?: unknown[];
    contact_verification_status?: string;
    mx_verified?: boolean;
  } | null;
}): { needsVerification: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const email = String(lead.email ?? "").trim().toLowerCase();
  const phone = String(lead.phone ?? "").trim();
  const hasValidEmailSyntax = Boolean(email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email));
  const isPlaceholder = Boolean(email && isPlaceholderOrSyntheticEmail(email));
  const hasPhone = phone.replace(/\D/g, "").length >= 7;
  const hasResearchSocial = Boolean(
    Array.isArray(lead.research?.socials) && lead.research!.socials.length > 0,
  );
  const notesLower = String(lead.notes ?? "").toLowerCase();
  const hasNoteSocial = /https?:\/\/(?:www\.)?(?:linkedin|facebook|instagram|twitter|x)\.com\//i.test(notesLower);

  if (isPlaceholder) {
    reasons.push(`Placeholder email (${email})`);
  } else if (email && !hasValidEmailSyntax) {
    reasons.push(`Invalid email format (${email})`);
  }
  if (!hasValidEmailSyntax && !hasPhone && !hasResearchSocial && !hasNoteSocial) {
    reasons.push("Missing verified email, phone, or social link");
  }
  if (!String(lead.business ?? "").trim()) {
    reasons.push("Missing business name");
  }
  if (!String(lead.website ?? "").trim() && !String(lead.location ?? "").trim()) {
    reasons.push("Missing website and location");
  }

  return {
    needsVerification: reasons.length > 0,
    reasons,
  };
}
