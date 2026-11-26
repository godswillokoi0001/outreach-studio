export function statusTone(status: string): "ok" | "warn" | "bad" | "info" | "gold" | undefined {
  switch (status) {
    case "qualified":
    case "sent":
    case "approved":
    case "converted":
    case "approved_campaign":
      return "ok";
    case "researched":
    case "email_generated":
    case "pending_approval":
      return "info";
    case "replied":
    case "followup_pending":
    case "needs_research":
      return "gold";
    case "disqualified":
    case "bounced":
    case "failed":
    case "unsubscribed":
    case "suppressed":
      return "bad";
    case "queued_research":
    case "new":
    case "draft":
    case "paused":
      return "warn";
    default:
      return undefined;
  }
}

export function priorityTone(priority: string | null): "ok" | "warn" | "bad" | "info" | "gold" | undefined {
  switch (priority) {
    case "high":
      return "ok";
    case "medium":
      return "gold";
    case "low":
      return "warn";
    case "not_qualified":
      return "bad";
    case "needs_research":
      return "info";
    default:
      return undefined;
  }
}

export const STATUS_LABELS: Record<string, string> = {
  new: "Unprocessed",
  queued_research: "Awaiting research",
  researched: "Researched",
  qualified: "Qualified",
  disqualified: "Disqualified",
  needs_research: "Needs research",
  email_generated: "Email drafted",
  approved: "Approved",
  sent: "Sent",
  replied: "Replied",
  bounced: "Bounced",
  followup_pending: "Follow-up pending",
  converted: "Converted",
  unsubscribed: "Opted out",
  suppressed: "Suppressed",
  draft: "Draft",
  pending_approval: "Awaiting approval",
  sending: "Sending",
  failed: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
  paused: "Paused",
  completed: "Completed",
  archived: "Archived",
  running: "Running",
};

export function label(value: string | null | undefined): string {
  if (!value) return "—";
  return STATUS_LABELS[value] ?? value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtDay(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

export function scoreClass(score: number | null | undefined): string {
  if (!score) return "low";
  if (score >= 75) return "high";
  if (score >= 50) return "mid";
  return "low";
}
