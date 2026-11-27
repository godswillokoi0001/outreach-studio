import { findUnresolvedPlaceholders, stripUnresolvedPlaceholders } from "./outreach-utils";
import type { Message } from "./types";

export type RewriteScope = "all" | "selected" | "unapproved";

export type RewriteItemStatus =
  | "pending"
  | "rewritten"
  | "accepted"
  | "needs_attention"
  | "rejected"
  | "failed";

export interface KnowledgeSectionStatus {
  key:
    | "business_overview"
    | "offer_pricing"
    | "proof_credibility"
    | "ideal_customer"
    | "brand_voice"
    | "messaging_guidelines"
    | "sample_emails";
  label: string;
  present: boolean;
  charCount: number;
}

export interface KnowledgeGapItem {
  key: string;
  label: string;
  promptToFill: string;
}

export interface RewritePreflightSummary {
  scope: RewriteScope;
  totalReviewableEmails: number;
  inScopeEmails: number;
  uniqueLeadsCount: number;
  messageIdsInScope: string[];
  sectionsUsed: KnowledgeSectionStatus[];
  gaps: KnowledgeGapItem[];
  sampleEmailsFound: number;
  kbEmpty: boolean;
}

export interface LeadRewriteAnalysis {
  whoTheyAre: {
    decisionMaker: string;
    role: string;
    seniority: string;
    company: string;
    industry: string;
    size: string;
    location: string;
  };
  needsAndPainPoints: string[];
  qualificationSummary: {
    score: number | null;
    tier: string;
    buyingIntentSignals: string[];
    timingOrTriggers: string[];
  };
  pastEngagement: {
    emailsSent: number;
    repliesCount: number;
    opensCount: number;
    clicksCount: number;
    summary: string;
  };
  verifiedHooks: { hook: string; source: string }[];
  chosenPattern: {
    framework: string;
    frameworkReason: string;
    toneAndFormality: string;
    toneReason: string;
    lengthAndStructure: string;
    lengthReason: string;
    subjectLineApproach: string;
    subjectReason: string;
    ctaStyle: string;
    ctaReason: string;
    followUpTiming: string;
    followUpReason: string;
    overallReason: string;
  };
}

export interface RewriteCheckResult {
  passed: boolean;
  attempts: number;
  issues: string[];
  criteria: {
    kbGroundedOnly: boolean;
    noPlaceholdersOrWrongNames: boolean;
    matchesBrandVoice: boolean;
    clearCtaAndLengthFit: boolean;
    compliancePresent: boolean;
  };
}

export interface RewriteVersionEntry {
  versionId: string;
  createdAt: string;
  source: "original" | "ai_rewrite" | "ai_regenerate" | "manual_edit";
  subject: string;
  body: string;
  instruction?: string;
  status: RewriteItemStatus;
  checkIssues?: string[];
}

export interface EmailRewriteItem {
  messageId: string;
  leadId: string;
  campaignId: string | null;
  business: string;
  leadEmail: string | null;
  kind: Message["kind"];
  step: number;
  originalSubject: string;
  originalBody: string;
  rewrittenSubject: string;
  rewrittenBody: string;
  subjectOptions: string[];
  status: RewriteItemStatus;
  statusReason?: string;
  analysis: LeadRewriteAnalysis | null;
  check: RewriteCheckResult | null;
  versions: RewriteVersionEntry[];
  kbGapsNoted: string[];
  acceptedAt?: string;
  rejectedAt?: string;
  updatedAt: string;
}

export interface CrossLeadPatternInsight {
  pattern: string;
  segment: string;
  explanation: string;
  isRecommendation: boolean;
}

export interface CrossLeadPatternSummary {
  basedOnEngagementData: boolean;
  label: string;
  patterns: CrossLeadPatternInsight[];
}

export interface EmailRewriteWorkspaceState {
  ownerId: string;
  activeJobId: string | null;
  lastScope: RewriteScope;
  pausedForQuota: boolean;
  pausedMessage: string | null;
  kbSectionsUsed: KnowledgeSectionStatus[];
  kbGaps: KnowledgeGapItem[];
  crossLeadSummary: CrossLeadPatternSummary | null;
  itemsByMessageId: Record<string, EmailRewriteItem>;
  updatedAt: string;
}

export interface DiffToken {
  type: "equal" | "add" | "remove";
  text: string;
}

/**
 * Pure client-safe word/whitespace diff for highlighting changes between
 * original email text and AI-rewritten email text side-by-side.
 */
export function diffEmailText(before: string, after: string): DiffToken[] {
  const a = before.split(/(\s+)/).filter((t) => t.length > 0);
  const b = after.split(/(\s+)/).filter((t) => t.length > 0);

  // Guard quadratic DP on ultra-long bodies
  if (a.length > 450 || b.length > 450) {
    return [
      { type: "remove", text: before },
      { type: "add", text: after },
    ];
  }

  const m = a.length;
  const n = b.length;
  const dp: Uint16Array[] = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const raw: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      raw.push({ type: "equal", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw.push({ type: "remove", text: a[i] });
      i++;
    } else {
      raw.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < m) {
    raw.push({ type: "remove", text: a[i++] });
  }
  while (j < n) {
    raw.push({ type: "add", text: b[j++] });
  }

  // Merge adjacent tokens of the same type for clean rendering
  const merged: DiffToken[] = [];
  for (const tok of raw) {
    const prev = merged[merged.length - 1];
    if (prev && prev.type === tok.type) {
      prev.text += tok.text;
    } else {
      merged.push({ ...tok });
    }
  }
  return merged;
}

const BANNED_REWRITE_SLOP_RE =
  /\b(?:hope this (?:email|note|message) finds you well|i came across your website|i was browsing your site|game[- ]changer|synergy|delve into|unlock your potential|revolutionize your|circle back|touch base)\b/i;

const OPTOUT_PHRASE_RE =
  /\b(?:opt[\s-]?out|unsubscribe|stop|no longer|prefer not|let me know if (?:not|you'?d rather)|say (?:no|stop)|drop me a no)\b/i;

/**
 * Deterministic verification gates enforced on every AI rewrite & manual edit.
 */
export function runDeterministicRewriteAudit(input: {
  subject: string;
  body: string;
  kind: Message["kind"];
  leadBusiness: string | null;
  leadContactName: string | null;
  senderName: string;
  senderCompany: string;
  otherLeadBusinesses?: string[];
  sampleEmails?: string[];
}): {
  passed: boolean;
  noPlaceholdersOrWrongNames: boolean;
  clearCtaAndLengthFit: boolean;
  compliancePresent: boolean;
  issues: string[];
} {
  const issues: string[] = [];
  const subj = input.subject.trim();
  const body = input.body.trim();
  const combined = `${subj}\n${body}`;

  // 1. Placeholders or wrong company / invented names
  let noPlaceholdersOrWrongNames = true;
  const unresolved = findUnresolvedPlaceholders(combined);
  if (unresolved.length > 0) {
    noPlaceholdersOrWrongNames = false;
    issues.push(`Unresolved placeholder(s) remaining: ${unresolved.join(", ")}.`);
  }

  // Guard against unverified/generic bracket tokens not caught elsewhere
  if (/\[[A-Za-z][A-Za-z0-9 _/-]{1,35}\]/.test(combined)) {
    noPlaceholdersOrWrongNames = false;
    issues.push("Square-bracket placeholder left inside subject or body.");
  }

  // If lead had NO contact_name, reject greeting with a fabricated person name (allow Hi/Hello/Hi there/Team/Company)
  if (!input.leadContactName?.trim()) {
    const greetMatch = body.match(/^(?:hi|hello|hey|dear)\s+([A-Z][a-z]{2,20})(?:[,\s!]|$)/m);
    if (
      greetMatch?.[1] &&
      !["There", "Team", "Folks", "Everyone", "Friends"].includes(greetMatch[1]) &&
      !(input.leadBusiness && input.leadBusiness.toLowerCase().includes(greetMatch[1].toLowerCase()))
    ) {
      noPlaceholdersOrWrongNames = false;
      issues.push(
        `Greeting addresses "${greetMatch[1]}" even though this lead record has no verified contact name.`,
      );
    }
  }

  // Check if another prospect's company name accidentally leaked in
  const ownBiz = (input.leadBusiness ?? "").trim().toLowerCase();
  for (const other of input.otherLeadBusinesses ?? []) {
    const cleanOther = other.trim().toLowerCase();
    if (cleanOther.length >= 6 && cleanOther !== ownBiz && combined.toLowerCase().includes(cleanOther)) {
      noPlaceholdersOrWrongNames = false;
      issues.push(`Wrong company name "${other}" appeared in email meant for "${input.leadBusiness}".`);
    }
  }

  // 2. Clear CTA, non-copy-paste sample check, banned slop, and length fit
  let clearCtaAndLengthFit = true;
  const words = body.split(/\s+/).filter(Boolean).length;
  if (!subj) {
    clearCtaAndLengthFit = false;
    issues.push("Missing subject line.");
  }
  if (words < 20 || words > 230) {
    clearCtaAndLengthFit = false;
    issues.push(`Body length (${words} words) is outside the crisp 20-230 word range.`);
  }
  if (BANNED_REWRITE_SLOP_RE.test(body)) {
    clearCtaAndLengthFit = false;
    issues.push("Contains generic AI opener or cliché phrasing.");
  }
  if (!body.includes("?") && !/\b(?:worth a|open to|make sense|send over|reply|let me know|happy to share)\b/i.test(body)) {
    clearCtaAndLengthFit = false;
    issues.push("Missing a clear low-friction call to action or question.");
  }

  // Ensure sample emails were NOT copied verbatim
  const normBody = body.toLowerCase().replace(/\s+/g, " ").trim();
  for (const sample of input.sampleEmails ?? []) {
    const normSample = sample.toLowerCase().replace(/\s+/g, " ").trim();
    if (normSample.length >= 50 && normBody.includes(normSample.slice(0, Math.min(100, normSample.length)))) {
      clearCtaAndLengthFit = false;
      issues.push("Email copied too closely from a Knowledge Base sample instead of tailoring to this lead.");
      break;
    }
  }

  // 3. Compliance & sender identity check
  let compliancePresent = true;
  if (input.kind !== "reply") {
    if (!OPTOUT_PHRASE_RE.test(body)) {
      compliancePresent = false;
      issues.push("Missing clear opt-out or unsubscribe line required for outreach compliance.");
    }
  }
  const hasSender =
    (input.senderName && body.toLowerCase().includes(input.senderName.split(" ")[0].toLowerCase())) ||
    (input.senderCompany && body.toLowerCase().includes(input.senderCompany.toLowerCase())) ||
    /\n\s*[A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20})?\s*$/.test(body);
  if (!hasSender) {
    compliancePresent = false;
    issues.push("Missing sender name/company sign-off.");
  }

  return {
    passed: noPlaceholdersOrWrongNames && clearCtaAndLengthFit && compliancePresent,
    noPlaceholdersOrWrongNames,
    clearCtaAndLengthFit,
    compliancePresent,
    issues,
  };
}

export function sanitizeRewrittenText(raw: string): string {
  return stripUnresolvedPlaceholders(raw);
}

export function rewriteStatusLabel(status: RewriteItemStatus): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "rewritten":
      return "Rewritten";
    case "accepted":
      return "Accepted";
    case "needs_attention":
      return "Needs attention";
    case "rejected":
      return "Rejected";
    case "failed":
      return "Failed";
  }
}

export function rewriteStatusTone(
  status: RewriteItemStatus,
): "ok" | "warn" | "bad" | "info" | undefined {
  switch (status) {
    case "rewritten":
      return "info";
    case "accepted":
      return "ok";
    case "needs_attention":
      return "warn";
    case "failed":
    case "rejected":
      return "bad";
    default:
      return undefined;
  }
}

export function filterReviewableMessageIds(
  messages: Pick<Message, "id" | "kind" | "status">[],
  scope: RewriteScope,
  selectedIds: string[],
): string[] {
  const reviewable = messages.filter(
    (m) => !(m.kind === "reply" && m.status === "draft") && m.status !== "sent" && m.status !== "sending",
  );
  if (scope === "selected") {
    const chosen = new Set(selectedIds);
    return reviewable.filter((m) => chosen.has(m.id)).map((m) => m.id);
  }
  if (scope === "unapproved") {
    return reviewable
      .filter((m) => m.status !== "approved")
      .map((m) => m.id);
  }
  return reviewable.map((m) => m.id);
}
