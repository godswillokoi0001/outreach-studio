import type { SendingTier } from "./global-knowledge/types";
import type { Campaign, Lead, LeadStatus, Message } from "./types";

export const DEFAULT_CAMPAIGN_MIN_SCORE = 65;
export const FREE_GMAIL_STARTER_DAILY_CAP = 20;

export type ReplyClassCode = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8";
export type ReplySequenceAction = "PAUSE" | "SNOOZE" | "STOP" | "GLOBAL_SUPPRESS";

const FREE_INBOX_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
]);

export function resolveUserSendingTier(
  senderEmail?: string | null,
  explicitTier?: SendingTier | string | null,
): SendingTier {
  if (explicitTier === "authenticated_custom_domain" || explicitTier === "free_gmail_starter") {
    if (explicitTier === "authenticated_custom_domain") return "authenticated_custom_domain";
  }
  const email = String(senderEmail ?? "").trim().toLowerCase();
  const domain = email.includes("@") ? email.split("@")[1] ?? "" : "";
  if (domain && !FREE_INBOX_DOMAINS.has(domain)) {
    return "authenticated_custom_domain";
  }
  return "free_gmail_starter";
}

export function isSelfSendEmail(senderEmail?: string | null, recipientEmail?: string | null): boolean {
  const from = String(senderEmail ?? "").trim().toLowerCase();
  const to = String(recipientEmail ?? "").trim().toLowerCase();
  return Boolean(from && to && from === to);
}

export function isLeadKillSwitchTriggered(lead: Partial<Lead> | null | undefined): boolean {
  if (!lead) return true;
  if (lead.status === "disqualified" || lead.status === "unsubscribed" || lead.status === "suppressed" || lead.status === "bounced") {
    return true;
  }
  const reason = lead.score_reason as
    | (Lead["score_reason"] & { kill_switch_triggered?: boolean; tier?: string })
    | null
    | undefined;
  if (!reason) return false;
  if (reason.kill_switch_triggered === true) return true;
  if (reason.tier === "DISQUALIFIED") return true;
  if (reason.category === "not_qualified") return true;
  return false;
}

export interface SendEligibilityResult {
  eligible: boolean;
  code:
    | "OK"
    | "MISSING_EMAIL"
    | "SUPPRESSED"
    | "SELF_SEND"
    | "KILL_SWITCH"
    | "UNSCORED"
    | "BELOW_MIN_SCORE";
  reason: string | null;
}

/**
 * Hard code-level qualification & deliverability firewall enforced before
 * queuing, approving, or sending any campaign email.
 */
export function evaluateLeadSendEligibility(input: {
  lead: Partial<Lead>;
  campaign?: Partial<Campaign> | null;
  minScore?: number | null;
  senderEmail?: string | null;
  suppressedEmails?: Iterable<string>;
}): SendEligibilityResult {
  const recipient = String(input.lead.email_norm || input.lead.email || "").trim().toLowerCase();
  if (!recipient || !recipient.includes("@")) {
    return { eligible: false, code: "MISSING_EMAIL", reason: "Prospect has no valid email address." };
  }

  if (input.suppressedEmails) {
    for (const sup of input.suppressedEmails) {
      if (sup.trim().toLowerCase() === recipient) {
        return {
          eligible: false,
          code: "SUPPRESSED",
          reason: `Recipient ${recipient} is on the permanent suppression list.`,
        };
      }
    }
  }

  if (isSelfSendEmail(input.senderEmail, recipient)) {
    return {
      eligible: false,
      code: "SELF_SEND",
      reason: `Self-send blocked: sender (${input.senderEmail}) and recipient (${recipient}) are identical. Use a separate external inbox to test deliverability.`,
    };
  }

  if (isLeadKillSwitchTriggered(input.lead)) {
    const disqReason =
      (input.lead.score_reason as { disqualification_reason?: string; disqualify_reason?: string } | null)
        ?.disqualification_reason ||
      input.lead.score_reason?.disqualify_reason ||
      `Prospect status/classification (${input.lead.status ?? "disqualified"}) triggered disqualification kill-switch.`;
    return {
      eligible: false,
      code: "KILL_SWITCH",
      reason: disqReason,
    };
  }

  const threshold = Number.isFinite(Number(input.minScore))
    ? Number(input.minScore)
    : Number.isFinite(Number(input.campaign?.config?.min_score))
      ? Number(input.campaign?.config?.min_score)
      : DEFAULT_CAMPAIGN_MIN_SCORE;

  const score = input.lead.score;
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return {
      eligible: false,
      code: "UNSCORED",
      reason: `Prospect has not been qualified yet (minimum required score: ${threshold}).`,
    };
  }

  if (score < threshold) {
    return {
      eligible: false,
      code: "BELOW_MIN_SCORE",
      reason: `Prospect score (${score}/100) is below the campaign minimum score (${threshold}/100).`,
    };
  }

  return { eligible: true, code: "OK", reason: null };
}

export interface DeliverabilityCheckResult {
  tier: SendingTier;
  effectiveDailyCap: number;
  preferPlainText: boolean;
  urlCount: number;
  hasCalendarLink: boolean;
  warnings: string[];
  dailyCapExceeded: boolean;
}

const URL_REGEX = /https?:\/\/[^\s<>)"']+/gi;
const CALENDAR_LINK_REGEX = /(calendly\.com|cal\.com|hubspot\.com\/meetings|acuityscheduling\.com|tidycal\.com)/i;

export function checkSendingTierDeliverability(input: {
  tier: SendingTier;
  subject?: string | null;
  body?: string | null;
  configuredDailyLimit?: number | null;
  sendsTodayCount?: number | null;
  isColdTouch1?: boolean;
}): DeliverabilityCheckResult {
  const configured = Math.max(1, Number(input.configuredDailyLimit) || 25);
  const effectiveDailyCap =
    input.tier === "free_gmail_starter"
      ? Math.min(configured, FREE_GMAIL_STARTER_DAILY_CAP)
      : Math.min(configured, 200);

  const combined = `${input.subject ?? ""}\n${input.body ?? ""}`;
  const urls = combined.match(URL_REGEX) ?? [];
  const hasCalendarLink = CALENDAR_LINK_REGEX.test(combined);
  const warnings: string[] = [];

  if (input.tier === "free_gmail_starter") {
    if (urls.length >= 2) {
      warnings.push(
        `Draft contains ${urls.length} links. Free Gmail / Starter accounts should send with 0-1 links to avoid spam filters.`,
      );
    }
    if (input.isColdTouch1 && hasCalendarLink) {
      warnings.push("Calendar scheduling links on cold Touch 1 reduce reply rates and increase spam risk.");
    }
    if (/\battach(ed|ment)\b/i.test(combined)) {
      warnings.push("Mentioning or sending attachments on cold Gmail Starter emails triggers spam filters.");
    }
  } else if (urls.length >= 3) {
    warnings.push(`Draft contains ${urls.length} links; keep cold outreach to at most 1 clean link.`);
  }

  const sentToday = Math.max(0, Number(input.sendsTodayCount) || 0);
  const dailyCapExceeded = sentToday >= effectiveDailyCap;
  if (dailyCapExceeded) {
    warnings.push(
      `Daily send limit reached for ${input.tier === "free_gmail_starter" ? "Free Gmail Starter" : "Custom Domain"} tier (${sentToday}/${effectiveDailyCap}).`,
    );
  }

  return {
    tier: input.tier,
    effectiveDailyCap,
    preferPlainText: input.tier === "free_gmail_starter",
    urlCount: urls.length,
    hasCalendarLink,
    warnings,
    dailyCapExceeded,
  };
}

export function addBusinessDaysIso(startDateIso: string, businessDays: number): string {
  const base = new Date(startDateIso);
  const d = Number.isNaN(base.getTime()) ? new Date() : base;
  let added = 0;
  while (added < businessDays) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) added += 1;
  }
  return d.toISOString().slice(0, 10);
}

export function mapReplyClassMeta(replyClass: ReplyClassCode): {
  sequence_action: ReplySequenceAction;
  legacy_classification:
    | "interested"
    | "more_info"
    | "pricing"
    | "objection"
    | "not_interested"
    | "referral"
    | "out_of_office"
    | "unsubscribe"
    | "other";
  suppress: boolean;
  leadStatus: LeadStatus;
} {
  switch (replyClass) {
    case "R1":
      return { sequence_action: "PAUSE", legacy_classification: "interested", suppress: false, leadStatus: "replied" };
    case "R2":
      return { sequence_action: "PAUSE", legacy_classification: "more_info", suppress: false, leadStatus: "replied" };
    case "R3":
      return { sequence_action: "PAUSE", legacy_classification: "objection", suppress: false, leadStatus: "replied" };
    case "R4":
      return { sequence_action: "PAUSE", legacy_classification: "referral", suppress: false, leadStatus: "replied" };
    case "R5":
      return { sequence_action: "SNOOZE", legacy_classification: "out_of_office", suppress: false, leadStatus: "replied" };
    case "R6":
      return { sequence_action: "PAUSE", legacy_classification: "other", suppress: false, leadStatus: "replied" };
    case "R7":
      return { sequence_action: "STOP", legacy_classification: "not_interested", suppress: false, leadStatus: "replied" };
    case "R8":
      return {
        sequence_action: "GLOBAL_SUPPRESS",
        legacy_classification: "unsubscribe",
        suppress: true,
        leadStatus: "unsubscribed",
      };
  }
}

/** Filters unsent pending/approved follow-up messages belonging to a lead. */
export function findCancellableFollowupMessageIds(messages: Pick<Message, "id" | "lead_id" | "kind" | "status">[], leadId: string): string[] {
  return messages
    .filter(
      (m) =>
        m.lead_id === leadId &&
        m.kind === "followup" &&
        (m.status === "draft" || m.status === "pending_approval" || m.status === "approved"),
    )
    .map((m) => m.id);
}
