import { accessToken, getAccount, listGmailMessages, sendGmailMessage } from "./google";
import { first, run, now, logEvent } from "./db";
import { b64url } from "./crypto";
import { validateEmail } from "./compose";
import type { Lead, Message, Settings } from "./types";

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

export function optOutLine(): string {
  return `If you would rather not hear from me again, reply "unsubscribe" or let me know and I will not follow up.`;
}

export interface RawEmailInput {
  to: string;
  from: string;
  fromName: string;
  subject: string;
  body: string;
  rfcMessageId: string;
  inReplyTo?: string | null;
  settings: Settings;
}

export function buildRawEmail(input: RawEmailInput): string {
  const body = input.body.toLowerCase().includes("unsubscribe")
    ? input.body
    : `${input.body}\n\n${optOutLine()}`;
  const headers: string[] = [
    `From: ${input.fromName ? `${input.fromName} ` : ""}<${input.from}>`,
    `To: ${input.to}`,
    `Subject: ${encodeSubject(input.subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${input.rfcMessageId}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    `X-Outreach-Message-Id: ${input.rfcMessageId.replace(/[<>]/g, "")}`,
  ];
  if (input.inReplyTo) headers.push(`In-Reply-To: ${input.inReplyTo}`);
  if (input.settings.unsubscribe_email) {
    headers.push(`List-Unsubscribe: <mailto:${input.settings.unsubscribe_email}?subject=unsubscribe>`);
  }
  const encodedBody = wrapBase64(btoa(bytesToBinary(new TextEncoder().encode(body))));
  return `${headers.join("\r\n")}\r\n\r\n${encodedBody}`;
}

export function messageIdFor(message: Message, senderEmail: string): string {
  if (message.rfc_message_id) return message.rfc_message_id;
  const domain = senderEmail.split("@")[1] || "outreach.local";
  return `<outreach.${message.id}.${Date.now().toString(36)}@${domain}>`;
}

function localParts(settings: Settings) {
  const shifted = new Date(Date.now() + settings.timezone_offset * 60_000);
  const day = shifted.getUTCDay() === 0 ? 7 : shifted.getUTCDay();
  const startOfLocalDayUtc =
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) -
    settings.timezone_offset * 60_000;
  return { hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes(), day, startOfLocalDayUtc };
}

export interface WindowCheck {
  allowed: boolean;
  reason?: string;
  localTime: string;
}

export function checkSendWindow(settings: Settings): WindowCheck {
  const { hour, minute, day } = localParts(settings);
  const localTime = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const days = settings.send_days.split(",").map((d) => Number(d.trim())).filter((d) => d >= 1 && d <= 7);
  if (days.length && !days.includes(day)) {
    return { allowed: false, reason: `Today is outside the configured sending days (${settings.send_days}).`, localTime };
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

export async function sendsToday(ownerSub: string, settings: Settings): Promise<number> {
  const { startOfLocalDayUtc } = localParts(settings);
  const row = await first<{ c: number }>(
    `SELECT COUNT(*) AS c FROM send_log WHERE owner_sub = ? AND status = 'sent' AND at >= ?`,
    ownerSub,
    new Date(startOfLocalDayUtc).toISOString(),
  );
  return row?.c ?? 0;
}

export async function lastSendAt(ownerSub: string): Promise<number | null> {
  const row = await first<{ at: string }>(
    `SELECT at FROM send_log WHERE owner_sub = ? AND status = 'sent' ORDER BY at DESC LIMIT 1`,
    ownerSub,
  );
  return row?.at ? new Date(row.at).getTime() : null;
}

export interface SendOutcome {
  messageId: string;
  status: "sent" | "already_sent" | "failed" | "blocked";
  detail?: string;
}

/**
 * Sends one approved message. Safe to resume: the deterministic Message-ID and
 * the "sending" status are persisted before the API call, so an interrupted
 * send is reconciled against Gmail instead of being resent.
 */
export async function sendApprovedMessage(
  ownerSub: string,
  message: Message,
  lead: Lead,
  settings: Settings,
): Promise<SendOutcome> {
  const account = await getAccount(ownerSub);
  if (!account?.email) return { messageId: message.id, status: "blocked", detail: "No Gmail account connected." };
  if (!message.body || !message.subject) {
    return { messageId: message.id, status: "blocked", detail: "Message has no content." };
  }
  const invalid = validateEmail(message.subject, message.body);
  if (invalid) {
    await run(
      `UPDATE messages SET status = 'failed', error = ?, updated_at = ? WHERE owner_sub = ? AND id = ?`,
      invalid,
      now(),
      ownerSub,
      message.id,
    );
    return { messageId: message.id, status: "failed", detail: invalid };
  }
  if (!lead.email) return { messageId: message.id, status: "blocked", detail: "Prospect has no email address." };

  if (message.status === "sending" && message.rfc_message_id) {
    const reconciled = await findSentByMessageId(ownerSub, message.rfc_message_id);
    if (reconciled) {
      await markSent(ownerSub, message, lead, reconciled.id, reconciled.threadId);
      return { messageId: message.id, status: "already_sent", detail: "Found in Gmail after a retry." };
    }
  }

  const rfcMessageId = messageIdFor(message, account.email);
  await run(
    `UPDATE messages SET status = 'sending', rfc_message_id = ?, updated_at = ? WHERE owner_sub = ? AND id = ?`,
    rfcMessageId,
    now(),
    ownerSub,
    message.id,
  );

  try {
    await accessToken(ownerSub);
    const raw = buildRawEmail({
      to: lead.email,
      from: account.email,
      fromName: settings.sender_name,
      subject: message.subject,
      body: message.body,
      rfcMessageId,
      inReplyTo: message.kind === "followup" ? message.rfc_message_id : null,
      settings,
    });
    const res = await sendGmailMessage(ownerSub, b64url(new TextEncoder().encode(raw)));
    await markSent(ownerSub, { ...message, rfc_message_id: rfcMessageId }, lead, res.id, res.threadId);
    return { messageId: message.id, status: "sent" };
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Sending failed.";
    const reconciled = await findSentByMessageId(ownerSub, rfcMessageId).catch(() => null);
    if (reconciled) {
      await markSent(ownerSub, { ...message, rfc_message_id: rfcMessageId }, lead, reconciled.id, reconciled.threadId);
      return { messageId: message.id, status: "already_sent", detail };
    }
    await run(
      `UPDATE messages SET status = 'failed', error = ?, updated_at = ? WHERE owner_sub = ? AND id = ?`,
      detail,
      now(),
      ownerSub,
      message.id,
    );
    await run(`UPDATE leads SET status = 'approved', updated_at = ? WHERE owner_sub = ? AND id = ?`, now(), ownerSub, lead.id);
    return { messageId: message.id, status: "failed", detail };
  }
}

async function findSentByMessageId(
  ownerSub: string,
  rfcMessageId: string,
): Promise<{ id: string; threadId: string } | null> {
  const query = `rfc822msgid:${rfcMessageId.replace(/[<>]/g, "")}`;
  const found = await listGmailMessages(ownerSub, query, 5);
  return found.length ? found[0] : null;
}

async function markSent(
  ownerSub: string,
  message: Message,
  lead: Lead,
  gmailId: string,
  threadId: string,
): Promise<void> {
  await run(
    `UPDATE messages SET status = 'sent', gmail_id = ?, thread_id = ?, sent_at = ?, error = NULL, updated_at = ?
     WHERE owner_sub = ? AND id = ?`,
    gmailId,
    threadId,
    now(),
    now(),
    ownerSub,
    message.id,
  );
  await run(
    `UPDATE leads SET status = ?, last_contacted_at = ?, updated_at = ? WHERE owner_sub = ? AND id = ?`,
    message.kind === "followup" ? "followup_pending" : "sent",
    now(),
    now(),
    ownerSub,
    lead.id,
  );
  await run(
    `INSERT INTO send_log (owner_sub, id, lead_id, message_id, status, at) VALUES (?,?,?,?,'sent',?)`,
    ownerSub,
    crypto.randomUUID(),
    lead.id,
    message.id,
    now(),
  );
  await logEvent(ownerSub, lead.id, "email_sent", { messageId: message.id, kind: message.kind, gmailId });
}

export async function isSuppressed(ownerSub: string, email: string | null): Promise<boolean> {
  if (!email) return true;
  const row = await first<{ email: string }>(
    `SELECT email FROM suppressions WHERE owner_sub = ? AND email = ?`,
    ownerSub,
    email.toLowerCase(),
  );
  return Boolean(row);
}

export async function addSuppression(ownerSub: string, email: string, reason: string): Promise<void> {
  await run(
    `INSERT INTO suppressions (owner_sub, email, reason, created_at) VALUES (?,?,?,?)
     ON CONFLICT(owner_sub, email) DO UPDATE SET reason = excluded.reason`,
    ownerSub,
    email.toLowerCase(),
    reason,
    now(),
  );
}

export async function hasBeenContacted(ownerSub: string, email: string | null, leadId: string): Promise<boolean> {
  if (!email) return false;
  const row = await first<{ c: number }>(
    `SELECT COUNT(*) AS c FROM messages m JOIN leads l ON l.id = m.lead_id AND l.owner_sub = m.owner_sub
     WHERE m.owner_sub = ? AND (l.email_norm = ? OR m.lead_id = ?) AND m.status IN ('sent','sending')`,
    ownerSub,
    email.toLowerCase(),
    leadId,
  );
  return Boolean(row?.c);
}
