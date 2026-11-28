/**
 * Follow-up board: one deterministic model for the /follow-ups tabs, the
 * dashboard alert and the nav badge.
 *
 * A follow-up exists only while the sequence is alive: the lead was contacted,
 * the campaign is active, there is no pending draft and no reply/opt-out. When
 * a reply, bounce or opt-out arrives the lead leaves the board automatically,
 * which is the "pause on reply" contract.
 */

import type { Campaign, Lead, Message, Reply } from "./types";

export type FollowupUrgency = "overdue" | "due_today" | "upcoming";

export interface FollowupBoardItem {
  leadId: string;
  business: string | null;
  email: string | null;
  campaignId: string;
  campaignName: string;
  step: number;
  totalSteps: number;
  gapDays: number;
  daysSince: number;
  dueDate: string;
  urgency: FollowupUrgency;
  lastSentSubject: string | null;
  lastContactedAt: string | null;
}

export interface SentFollowupItem {
  messageId: string;
  leadId: string;
  business: string | null;
  email: string | null;
  subject: string | null;
  step: number;
  sentAt: string | null;
}

export interface StoppedFollowupItem {
  leadId: string;
  business: string | null;
  email: string | null;
  reason: string;
}

export interface FollowupBoard {
  due: FollowupBoardItem[];
  upcoming: FollowupBoardItem[];
  sent: SentFollowupItem[];
  stopped: StoppedFollowupItem[];
  dueTodayCount: number;
  overdueCount: number;
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A reply, bounce or opt-out stops the sequence immediately. */
export function followupStopReason(
  lead: Pick<Lead, "status">,
  hasReply: boolean,
): string | null {
  if (hasReply) return "Replied";
  switch (lead.status) {
    case "unsubscribed":
      return "Opted out";
    case "bounced":
      return "Bounced";
    case "suppressed":
      return "Suppressed";
    case "replied":
      return "Replied";
    default:
      return null;
  }
}

/**
 * Builds the four tabs from real records. Pure: the caller supplies `nowMs`,
 * so DST, tests and time zones behave predictably.
 */
export function buildFollowupBoard(input: {
  leads: Lead[];
  campaigns: Campaign[];
  messages: Message[];
  replies: Reply[];
  nowMs?: number;
}): FollowupBoard {
  const nowMs = input.nowMs ?? Date.now();
  const today = dayKey(nowMs);
  const campaignMap = new Map(input.campaigns.map((c) => [c.id, c]));
  const repliedLeadIds = new Set(input.replies.map((r) => r.lead_id).filter(Boolean) as string[]);

  const due: FollowupBoardItem[] = [];
  const upcoming: FollowupBoardItem[] = [];
  const stopped: StoppedFollowupItem[] = [];

  for (const lead of input.leads) {
    const stopReason = followupStopReason(lead, repliedLeadIds.has(lead.id));
    const leadMessages = input.messages.filter((m) => m.lead_id === lead.id);
    const sentMessages = leadMessages
      .filter((m) => m.status === "sent")
      .sort((a, b) => (b.sent_at ?? "").localeCompare(a.sent_at ?? ""));

    if (stopReason) {
      // Only surface stops that actually had a sequence running.
      if (sentMessages.length > 0) {
        stopped.push({
          leadId: lead.id,
          business: lead.business,
          email: lead.email,
          reason: stopReason,
        });
      }
      continue;
    }

    if (lead.status !== "sent" && lead.status !== "followup_pending") continue;
    if (!lead.campaign_id || !lead.last_contacted_at) continue;
    const campaign = campaignMap.get(lead.campaign_id);
    if (!campaign || campaign.status === "paused" || campaign.status === "archived") continue;

    const step = sentMessages.length;
    if (step === 0) continue;
    const gaps = campaign.config.followup_days?.length ? campaign.config.followup_days : [4, 9];
    if (step > gaps.length) continue;
    if (
      leadMessages.some(
        (m) => m.status === "pending_approval" || m.status === "approved" || m.status === "sending",
      )
    ) {
      // A draft is already waiting in review; it is not "due" again.
      continue;
    }

    // The lead's last-touch timestamp is the authoritative schedule anchor
    // (a snooze shifts it), while the newest sent message supplies the subject.
    const lastMs = new Date(lead.last_contacted_at).getTime();
    if (!Number.isFinite(lastMs)) continue;

    const gapDays = gaps[step - 1] ?? gaps[gaps.length - 1];
    const dueMs = lastMs + gapDays * 86_400_000;
    const dueDate = dayKey(dueMs);
    const urgency: FollowupUrgency = dueDate < today ? "overdue" : dueDate === today ? "due_today" : "upcoming";
    const item: FollowupBoardItem = {
      leadId: lead.id,
      business: lead.business,
      email: lead.email,
      campaignId: campaign.id,
      campaignName: campaign.name,
      step: step + 1,
      totalSteps: gaps.length + 1,
      gapDays,
      daysSince: Math.max(0, Math.floor((nowMs - lastMs) / 86_400_000)),
      dueDate,
      urgency,
      lastSentSubject: sentMessages[0]?.subject ?? null,
      lastContactedAt: lead.last_contacted_at,
    };
    if (urgency === "upcoming") upcoming.push(item);
    else due.push(item);
  }

  due.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  upcoming.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const sent: SentFollowupItem[] = input.messages
    .filter((m) => m.kind === "followup" && m.status === "sent")
    .map((m) => {
      const lead = input.leads.find((l) => l.id === m.lead_id);
      return {
        messageId: m.id,
        leadId: m.lead_id,
        business: lead?.business ?? null,
        email: lead?.email ?? null,
        subject: m.subject,
        step: m.step,
        sentAt: m.sent_at,
      };
    })
    .sort((a, b) => (b.sentAt ?? "").localeCompare(a.sentAt ?? ""))
    .slice(0, 100);

  return {
    due,
    upcoming,
    sent,
    stopped: stopped.slice(0, 100),
    dueTodayCount: due.filter((d) => d.urgency === "due_today").length,
    overdueCount: due.filter((d) => d.urgency === "overdue").length,
  };
}

/**
 * Move a due follow-up two days out without inventing a schedule record: shift
 * the last-touch timestamp so the campaign gap lands in exactly two days.
 */
export function snoozeLastContactedAt(input: {
  lastContactedAt: string;
  gapDays: number;
  days?: number;
  nowMs?: number;
}): string {
  const nowMs = input.nowMs ?? Date.now();
  const days = input.days ?? 2;
  return new Date(nowMs - (input.gapDays - days) * 86_400_000).toISOString();
}
