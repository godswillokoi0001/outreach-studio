/**
 * Pure helpers for the Email Review screen. Keeping them here (instead of inside
 * the page component) means the queue rules are testable without a browser.
 */

const INVALID_DISPLAY_NAME_RE =
  /^(?:n\/?a|na|none|null|unknown|info(?:rmation)?|church office|(?:the )?office|pastor\s*\/?\s*church office|admin|support|sales|contact|team|verified google listing|no contact name|not provided|not verified)$/i;

/** True only when the text is a real human/business name worth showing. */
export function isUsableDisplayName(raw?: string | null): boolean {
  const value = (raw ?? "").trim().replace(/[.,;:]+$/, "");
  if (value.length < 2) return false;
  if (INVALID_DISPLAY_NAME_RE.test(value)) return false;
  if (/^[a-z0-9]{4,}$/i.test(value) && /\d/.test(value)) return false; // ids such as jbw2xmu5gvr
  if (!/\s/.test(value) && /^[A-Za-z0-9_-]{10,}$/.test(value) && /[a-z]/.test(value) && /[A-Z0-9]/.test(value)) {
    return false;
  }
  return /[a-z]/i.test(value);
}

function titleCaseLocalPart(local: string): string {
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Never render raw `N/A`, `Verified Google listing`, or random ids as the
 * prospect's name. Fall back to the business name, then the email local part,
 * then the domain.
 */
export function prospectDisplayName(input: {
  business?: string | null;
  contactName?: string | null;
  email?: string | null;
  website?: string | null;
}): string {
  if (isUsableDisplayName(input.business)) return (input.business ?? "").trim();
  if (isUsableDisplayName(input.contactName)) return (input.contactName ?? "").trim();

  const email = (input.email ?? "").trim();
  const local = email.includes("@") ? email.split("@")[0] : "";
  if (local && isUsableDisplayName(local)) return titleCaseLocalPart(local);

  const host = (input.website ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split("/")[0];
  if (host && isUsableDisplayName(host)) return host;

  return "Unnamed prospect";
}

/** An email can only be approved for sending when a real address exists. */
export function hasSendableEmail(email?: string | null): boolean {
  const value = (email ?? "").trim();
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(value);
}

export const MAX_REWRITE_BATCH = 20;
export const QUICK_REWRITE_BATCH = 10;
