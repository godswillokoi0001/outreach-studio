import { b64url } from "./crypto";
import { escapeEmailHtml, formatEmailText, wrapEmailHtml } from "./email-format";
import type {
  AuditLog,
  Campaign,
  CampaignConfig,
  Lead,
  Message,
  Reply,
  SendLog,
  Settings,
} from "./types";

// ---------------------------------------------------------------------------
// ID & String Sanitization (stable ids for every row)
// ---------------------------------------------------------------------------

const UNRESOLVED_BRACE_TAG_RE = /\{\{\s*[^{}\r\n]{1,100}\s*\}\}/g;
const UNRESOLVED_BRACKET_TAG_RE =
  /\[\s*(?:(?:PROSPECT|USER|YOUR|INSERT|COMPANY|OPTIONAL)_[A-Z0-9_ ]{1,60}|(?:First|Last|Full|Prospect|Contact|Your|Company|Business)?\s*Name|(?:Company|Business|Website|City|Location|Role|Title|Industry|Date|Day|Time|Phone|Email)\s*(?:Name|Title|URL|Link)?)\s*\]/gi;

export function findUnresolvedPlaceholders(text: string): string[] {
  const braces = text.match(UNRESOLVED_BRACE_TAG_RE) ?? [];
  const brackets = text.match(UNRESOLVED_BRACKET_TAG_RE) ?? [];
  return Array.from(new Set([...braces, ...brackets]));
}

/**
 * Post-generation safety sanitizer: removes any accidental unresolved `{{...}}`
 * or bracketed `[First Name]` skeleton tags so raw placeholders never reach output.
 */
export function stripUnresolvedPlaceholders(text: string): string {
  return text
    .replace(UNRESOLVED_BRACE_TAG_RE, "")
    .replace(UNRESOLVED_BRACKET_TAG_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([,.;:!?])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const INVALID_CONTACT_NAME_RE =
  /^(?:n\/?a|na|none|null|unknown|info(?:rmation)?|church office|(?:the )?office|pastor\s*\/?\s*church office|admin|support|sales|contact|contact person|customer service|front desk|no contact name|not provided|not verified)$/i;

/** True only when a contact name is a real human name we may greet by name. */
export function isUsableContactName(raw?: string | null): boolean {
  const value = (raw ?? "").trim().replace(/[.,;:]+$/, "");
  if (value.length < 2 || value.length > 60) return false;
  if (INVALID_CONTACT_NAME_RE.test(value)) return false;
  if (/[<>{}\[\]@/\\|]/.test(value)) return false;
  if (/\d{3,}/.test(value)) return false;
  // Random identifiers such as "jbw2xmu5GVR" are never a person's name.
  if (!/\s/.test(value) && /^[A-Za-z0-9_-]{10,}$/.test(value) && /[a-z]/.test(value) && /[A-Z0-9]/.test(value)) {
    return false;
  }
  return /[a-z]/i.test(value);
}

/** First name to greet with, or null when the record has no usable name. */
export function contactFirstName(raw?: string | null): string | null {
  if (!isUsableContactName(raw)) return null;
  const first = (raw ?? "").trim().split(/\s+/)[0].replace(/[^A-Za-z'\u2019-]/g, "");
  if (first.length < 2) return null;
  return first[0].toUpperCase() + first.slice(1);
}

const GREETING_LINE_RE = /^(\s*)(hi|hello|hey|dear)(\s*)(.*)$/i;

/**
 * Repairs an empty or unusable greeting. Placeholder stripping turns
 * "Hi {{first_name}}," into "Hi ," and unverified lead records produce
 * "Hi N/A," or "Hi Church Office," — none of these may reach a prospect.
 */
export function normalizeEmailGreeting(
  body: string,
  contactName?: string | null,
  role?: string | null,
): string {
  if (!body.trim()) return body;
  const lines = body.split("\n");
  const idx = lines.findIndex((line) => line.trim().length > 0);
  if (idx < 0) return body;

  const match = lines[idx].match(GREETING_LINE_RE);
  if (!match) return body;
  const [, indent, , , rest] = match;
  const restTrimmed = rest.trim();
  const commaAt = restTrimmed.indexOf(",");
  const namePart = (commaAt >= 0 ? restTrimmed.slice(0, commaAt) : restTrimmed).trim();
  const trailing = commaAt >= 0 ? restTrimmed.slice(commaAt + 1).trim() : "";

  // A usable name already sits in the greeting: leave the line untouched.
  if (namePart && isUsableContactName(namePart)) return body;
  // "Hi there," / "Hello again," style greetings are already clean.
  if (/^(?:there|again|all)$/i.test(namePart)) return body;
  if (!namePart && !restTrimmed) return body;
  if (!namePart && /\.$/.test(restTrimmed)) return body;

  const first = contactFirstName(contactName);
  const isPastor = /\b(?:pastor|pastoral|reverend|rev\.?|minister|deacon|elder|father)\b/i.test(role ?? "");
  const greeting = first ? `Hi ${first}` : isPastor ? "Hi Pastor" : "Hi there";
  lines[idx] = `${indent}${trailing ? `${greeting}, ${trailing}` : `${greeting},`}`;
  return lines.join("\n");
}

export function sanitizeId(raw: string, prefix = "doc"): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (cleaned && cleaned.length <= 100) {
    return `${prefix}_${cleaned}`.slice(0, 128);
  }
  // Fallback deterministic FNV-1a hex hash
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${prefix}_${(h >>> 0).toString(16)}`;
}

export function clampStr(value: string | null | undefined, maxLen: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLen);
}

export function clampReqStr(value: string | null | undefined, maxLen: number, fallback = ""): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, maxLen);
}

// ---------------------------------------------------------------------------
// Google Sheets URL & Column Helpers
// ---------------------------------------------------------------------------

export function parseSheetUrl(input: string): { spreadsheetId: string; gid: string | null } {
  const value = input.trim();
  if (!value) throw new Error("Paste a Google Sheets URL.");
  const match = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!match && /^[a-zA-Z0-9-_]{30,}$/.test(value)) {
    return { spreadsheetId: value, gid: null };
  }
  if (!match) throw new Error("That does not look like a Google Sheets URL.");
  const gidMatch = value.match(/[#&?]gid=(\d+)/);
  return { spreadsheetId: match[1], gid: gidMatch ? gidMatch[1] : null };
}

export function columnLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Email Composition & RFC822 MIME Formatting
// ---------------------------------------------------------------------------

/**
 * Normalise a stored email body without destroying the owner's formatting.
 * Paragraph breaks, `**bold**`, `*italic*` and `- ` lists are the light Markdown
 * the send renderer understands, so they are kept as written and turned into
 * styled HTML at dispatch time.
 */
export function cleanEmailText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[•*]\s+/gm, "- ")
    .replace(/\{\{\s*[^{}\r\n]{1,100}\s*\}\}/g, "")
    .replace(/\[(your|insert|company|name|prospect_[^\]]*|user_[^\]]*)[^\]]*\]/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([,.;:!?])/g, "$1")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function validateEmail(subject: string, body: string): string | null {
  if (!subject || subject.trim().length < 3) return "Subject line is missing or too short.";
  if (subject.length > 120) return "Subject line is too long.";
  if (/\{\{[^}]+\}\}/.test(subject) || /\{\{[^}]+\}\}/.test(body)) {
    return "Draft contains an unresolved {{...}} placeholder tag.";
  }
  if (!body || body.trim().split(/\s+/).length < 15) return "Email body is too short.";
  if (body.trim().split(/\s+/).length > 400) return "Email body is too long for cold outreach.";
  if (/\[[^\]]{2,40}\]/.test(body)) return "Email still contains an unfilled placeholder.";
  return null;
}

function wrapBase64(value: string): string {
  return value.replace(/(.{76})/g, "$1\r\n");
}

function bytesToBinary(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

function encodeSubject(subject: string): string {
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${btoa(bytesToBinary(new TextEncoder().encode(subject)))}?=`;
}

export interface RawEmailInput {
  to: string;
  from: string;
  fromName: string;
  subject: string;
  body: string;
  rfcMessageId: string;
  inReplyTo?: string | null;
  /** Absolute URL of the 1x1 open-tracking pixel. Omit to disable tracking pixel. */
  openPixelUrl?: string | null;
  /** True for Free Gmail / Starter cold outreach to send pure text/plain. */
  plainTextOnly?: boolean;
}


/** Builds a signed-less but unguessable tracking URL for one sent message. */
export function buildOpenPixelUrl(
  origin: string,
  params: { ownerId: string; messageId: string; leadId?: string | null },
): string {
  const base = origin.replace(/\/$/, "");
  const query = new URLSearchParams({ u: params.ownerId, m: params.messageId });
  if (params.leadId) query.set("l", params.leadId);
  return `${base}/api/track/open?${query.toString()}`;
}

export function buildRawEmail(input: RawEmailInput): string {
  const body = input.body;
  const headers: string[] = [
    `From: ${input.fromName ? `${input.fromName} ` : ""}<${input.from}>`,
    `To: ${input.to}`,
    `Subject: ${encodeSubject(input.subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${input.rfcMessageId}`,
    `MIME-Version: 1.0`,
    `X-Outreach-Message-Id: ${input.rfcMessageId.replace(/[<>]/g, "")}`,
  ];
  if (input.inReplyTo) headers.push(`In-Reply-To: ${input.inReplyTo}`);

  if (input.plainTextOnly) {
    headers.push(`Content-Type: text/plain; charset="UTF-8"`);
    headers.push(`Content-Transfer-Encoding: base64`);
    const plain = wrapBase64(btoa(bytesToBinary(new TextEncoder().encode(formatEmailText(body)))));
    return `${headers.join("\r\n")}\r\n\r\n${plain}`;
  }

  const pixel = input.openPixelUrl
    ? `<img src="${escapeEmailHtml(input.openPixelUrl)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0;" />`
    : "";

  // Every email goes out as HTML with a text/plain alternative — replies too,
  // where tracking is off and there is no pixel. Sending plain text only is
  // what made paragraphs and lists collapse in some mail clients.
  const boundary = `os_alt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const html = wrapEmailHtml(body, pixel);
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

  const textPart = [
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    "",
    wrapBase64(btoa(bytesToBinary(new TextEncoder().encode(formatEmailText(body))))),
  ].join("\r\n");

  const htmlPart = [
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    "",
    wrapBase64(btoa(bytesToBinary(new TextEncoder().encode(html)))),
  ].join("\r\n");

  return `${headers.join("\r\n")}\r\n\r\n${textPart}\r\n${htmlPart}\r\n--${boundary}--`;
}

export function encodeBase64Url(value: string): string {
  return b64url(new TextEncoder().encode(value));
}

export function createRfcMessageId(messageId: string, senderEmail: string): string {
  const domain = senderEmail.split("@")[1] || "outreach.local";
  return `<outreach.${messageId}.${Date.now().toString(36)}@${domain}>`;
}

// ---------------------------------------------------------------------------
// Send Window & Rate Guards
// ---------------------------------------------------------------------------

export function getLocalSendParts(settings: Settings, nowMs = Date.now()) {
  const shifted = new Date(nowMs + settings.timezone_offset * 60_000);
  const day = shifted.getUTCDay() === 0 ? 7 : shifted.getUTCDay();
  const startOfLocalDayUtc =
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) -
    settings.timezone_offset * 60_000;
  return {
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    day,
    startOfLocalDayUtc,
  };
}

export interface WindowCheck {
  allowed: boolean;
  reason?: string;
  localTime: string;
}

export function checkSendWindow(settings: Settings, nowMs = Date.now()): WindowCheck {
  const { hour, minute, day } = getLocalSendParts(settings, nowMs);
  const localTime = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const days = settings.send_days
    .split(",")
    .map((d) => Number(d.trim()))
    .filter((d) => d >= 1 && d <= 7);
  if (days.length && !days.includes(day)) {
    return {
      allowed: false,
      reason: `Today is outside the configured sending days (${settings.send_days}).`,
      localTime,
    };
  }
  if (hour < settings.send_window_start || hour >= settings.send_window_end) {
    return {
      allowed: false,
      reason: `Outside sending hours (${settings.send_window_start}:00-${settings.send_window_end}:00 local).`,
      localTime,
    };
  }
  return { allowed: true, localTime };
}

export function defaultCampaignConfig(settings: Settings): CampaignConfig {
  return {
    services: ["Website redesign"],
    target_industry: "any",
    objective: "Start a conversation about improving their digital presence",
    tone: "conversational and professional",
    min_score: settings.min_score,
    lead_count: 10,
    send_limit: settings.campaign_limit,
    interval_seconds: settings.interval_seconds,
    followup_days: [4, 9],
    auto_approve_initial: false,
    auto_approve_followups: false,
    require_approval: true,
    identity: "company",
    extra_instructions: "",
  };
}

// ---------------------------------------------------------------------------
// URL Guard & Analytics / Follow-up Pure Aggregators
// ---------------------------------------------------------------------------

const BLOCKED_HOSTS =
  /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/i;

export function isFetchableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return false;
    return !BLOCKED_HOSTS.test(parsed.hostname);
  } catch {
    return false;
  }
}

export interface FollowupCandidate {
  lead: Lead;
  campaign: Campaign;
  config: CampaignConfig;
  step: number;
  daysSince: number;
}

export function findFollowupCandidatesFromData(input: {
  leads: Lead[];
  campaigns: Campaign[];
  messages: Message[];
  replies: Reply[];
  nowMs?: number;
  limit?: number;
}): FollowupCandidate[] {
  const nowMs = input.nowMs ?? Date.now();
  const limit = input.limit ?? 50;
  const campaignMap = new Map(input.campaigns.map((c) => [c.id, c]));
  const replyLeadIds = new Set(input.replies.map((r) => r.lead_id).filter(Boolean) as string[]);

  const eligibleLeads = input.leads
    .filter((l) => (l.status === "sent" || l.status === "followup_pending") && Boolean(l.last_contacted_at))
    .sort((a, b) => (a.last_contacted_at ?? "").localeCompare(b.last_contacted_at ?? ""));

  const out: FollowupCandidate[] = [];
  for (const lead of eligibleLeads) {
    if (!lead.campaign_id) continue;
    if (replyLeadIds.has(lead.id)) continue;
    const campaign = campaignMap.get(lead.campaign_id);
    if (!campaign || campaign.status === "paused" || campaign.status === "archived") continue;
    const config = campaign.config;
    const leadMessages = input.messages.filter((m) => m.lead_id === lead.id);
    const sentMessages = leadMessages
      .filter((m) => m.status === "sent")
      .sort((a, b) => (b.sent_at ?? "").localeCompare(a.sent_at ?? ""));
    const step = sentMessages.length;
    if (step === 0) continue;
    const gaps = config.followup_days?.length ? config.followup_days : [4, 9];
    if (step > gaps.length) continue;
    const hasPending = leadMessages.some(
      (m) => m.status === "pending_approval" || m.status === "approved" || m.status === "sending",
    );
    if (hasPending) continue;
    const lastSentAt = sentMessages[0]?.sent_at;
    if (!lastSentAt) continue;
    const days = (nowMs - new Date(lastSentAt).getTime()) / 86_400_000;
    const gap = gaps[step - 1] ?? gaps[gaps.length - 1];
    if (days >= gap) {
      out.push({ lead, campaign, config, step: step + 1, daysSince: Math.floor(days) });
      if (out.length >= limit) break;
    }
  }
  return out;
}

const POSITIVE_CLASSES = new Set(["interested", "more_info", "pricing"]);

export function computeDashboardStats(input: {
  leads: Lead[];
  campaigns: Campaign[];
  messages: Message[];
  replies: Reply[];
  sendLogs: SendLog[];
  auditLogs: AuditLog[];
}) {
  const byStatus: Record<string, number> = {};
  for (const lead of input.leads) {
    byStatus[lead.status] = (byStatus[lead.status] ?? 0) + 1;
  }

  const researched = input.leads.filter((l) => Boolean(l.research_at)).length;
  const qualified = input.leads.filter((l) =>
    ["qualified", "email_generated", "approved", "sent", "replied", "converted", "followup_pending"].includes(
      l.status,
    ),
  ).length;
  const disqualified = byStatus.disqualified ?? 0;

  const emails = {
    generated: input.messages.length,
    pending: input.messages.filter((m) => m.status === "pending_approval").length,
    sent: input.messages.filter((m) => m.status === "sent").length,
    failed: input.messages.filter((m) => m.status === "failed").length,
  };

  const replyByType: Record<string, number> = {};
  let positive = 0;
  for (const r of input.replies) {
    replyByType[r.classification] = (replyByType[r.classification] ?? 0) + 1;
    if (POSITIVE_CLASSES.has(r.classification)) positive += 1;
  }

  const followupsDue = findFollowupCandidatesFromData({
    leads: input.leads,
    campaigns: input.campaigns,
    messages: input.messages,
    replies: input.replies,
  }).length;

  const sendsMap = new Map<string, number>();
  const cutoff = Date.now() - 14 * 86_400_000;
  for (const s of input.sendLogs) {
    if (s.status !== "sent") continue;
    const ts = new Date(s.at).getTime();
    if (Number.isNaN(ts) || ts < cutoff) continue;
    const day = s.at.slice(0, 10);
    sendsMap.set(day, (sendsMap.get(day) ?? 0) + 1);
  }
  const sends = Array.from(sendsMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, c]) => ({ day, c }));

  const campaigns = input.campaigns.slice(0, 12).map((c) => {
    const campLeads = input.leads.filter((l) => l.campaign_id === c.id);
    const campMsgs = input.messages.filter((m) => m.campaign_id === c.id);
    const campLeadIds = new Set(campLeads.map((l) => l.id));
    const campReplies = input.replies.filter((r) => r.lead_id && campLeadIds.has(r.lead_id));
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      leads: campLeads.length,
      sent: campMsgs.filter((m) => m.status === "sent").length,
      pending: campMsgs.filter((m) => m.status === "pending_approval").length,
      replies: campReplies.length,
    };
  });

  const activity = input.auditLogs.slice(0, 12).map((a) => ({
    action: a.action,
    entity: a.entity,
    created_at: a.created_at,
    detail: a.detail ? JSON.stringify(a.detail) : null,
  }));

  return {
    leads: {
      total: input.leads.length,
      byStatus,
      researched,
      qualified,
      disqualified,
    },
    emails,
    replies: {
      total: input.replies.length,
      positive,
      byType: replyByType,
    },
    followupsDue,
    sends,
    campaigns,
    activity,
  };
}

export function computeAnalyticsMetrics(input: {
  leads: Lead[];
  campaigns: Campaign[];
  messages: Message[];
  replies: Reply[];
}) {
  const funnel: Record<string, number> = {
    researched: input.leads.filter((l) => Boolean(l.research_at)).length,
    qualified: input.leads.filter((l) =>
      ["qualified", "email_generated", "approved", "sent", "replied", "converted", "followup_pending"].includes(
        l.status,
      ),
    ).length,
    converted: input.leads.filter((l) => l.status === "converted").length,
  };

  const replyTypes: Record<string, number> = {};
  let positive = 0;
  for (const r of input.replies) {
    replyTypes[r.classification] = (replyTypes[r.classification] ?? 0) + 1;
    if (POSITIVE_CLASSES.has(r.classification)) positive += 1;
  }

  const delivery = {
    sent: input.messages.filter((m) => m.status === "sent").length,
    failed: input.messages.filter((m) => m.status === "failed").length,
    pending: input.messages.filter((m) => m.status === "pending_approval").length,
  };

  const sendsByDayMap = new Map<string, number>();
  for (const m of input.messages) {
    if (m.status !== "sent" || !m.sent_at) continue;
    const day = m.sent_at.slice(0, 10);
    sendsByDayMap.set(day, (sendsByDayMap.get(day) ?? 0) + 1);
  }
  const sendsByDay = Array.from(sendsByDayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, c]) => ({ day, c }));

  const replyLeadIds = new Set(input.replies.map((r) => r.lead_id).filter(Boolean) as string[]);
  const sentLeadIds = new Set(
    input.messages.filter((m) => m.status === "sent").map((m) => m.lead_id),
  );

  const campaigns = input.campaigns.map((c) => {
    const campLeads = input.leads.filter((l) => l.campaign_id === c.id);
    const campLeadIds = new Set(campLeads.map((l) => l.id));
    const campMsgs = input.messages.filter((m) => m.campaign_id === c.id && m.status === "sent");
    const campReplies = input.replies.filter((r) => r.lead_id && campLeadIds.has(r.lead_id));
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      leads: campLeads.length,
      sent: campMsgs.length,
      replies: campReplies.length,
      positive: campReplies.filter((r) => POSITIVE_CLASSES.has(r.classification)).length,
    };
  });

  const industryMap = new Map<string, { leads: number; contacted: number; replied: number }>();
  for (const l of input.leads) {
    const key = l.industry?.trim() || "Unspecified";
    const row = industryMap.get(key) ?? { leads: 0, contacted: 0, replied: 0 };
    row.leads += 1;
    if (sentLeadIds.has(l.id)) row.contacted += 1;
    if (replyLeadIds.has(l.id)) row.replied += 1;
    industryMap.set(key, row);
  }
  const industries = Array.from(industryMap.entries())
    .map(([industry, counts]) => ({ industry, ...counts }))
    .sort((a, b) => b.leads - a.leads)
    .slice(0, 15);

  const angleMap = new Map<string, { sent: number; replied: number }>();
  for (const m of input.messages) {
    if (m.status !== "sent" || !m.angle) continue;
    const row = angleMap.get(m.angle) ?? { sent: 0, replied: 0 };
    row.sent += 1;
    if (replyLeadIds.has(m.lead_id)) row.replied += 1;
    angleMap.set(m.angle, row);
  }
  const angles = Array.from(angleMap.entries())
    .map(([angle, counts]) => ({ angle, ...counts }))
    .sort((a, b) => b.sent - a.sent)
    .slice(0, 15);

  const replyRate = delivery.sent ? Math.round((input.replies.length / delivery.sent) * 100) : 0;

  return {
    funnel,
    sendsByDay,
    replyTypes,
    campaigns,
    industries,
    angles,
    delivery,
    totals: {
      leads: input.leads.length,
      campaigns: input.campaigns.length,
      replies: input.replies.length,
      replyRate,
      positive,
    },
  };
}
