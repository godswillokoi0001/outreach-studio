"use client";

import { BrandLoader } from "@/components/BrandLoader";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Check, Clock, Mail, PauseCircle, Send } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { BatchRunner } from "@/components/Runner";
import { Badge, Banner, Card, Empty, Stat } from "@/components/ui";
import { confirmDialog, useToast } from "@/components/Feedback";
import { errorMessage } from "@/lib/client";
import { loadFollowupBoard, updateLeadFields } from "@/lib/store";
import { snoozeLastContactedAt, type FollowupBoard } from "@/lib/followups";
import { fmtDate } from "@/lib/format";
import { usePersistedPageState } from "@/lib/usePersistedPageState";

type TabKey = "due" | "upcoming" | "sent" | "stopped";

export default function FollowupsPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [board, setBoard] = useState<FollowupBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = usePersistedPageState<TabKey>("followups:tab", "due");

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setBoard(await loadFollowupBoard(user.uid));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [user.uid]);

  useEffect(() => {
    const onRefresh = () => void reload();
    window.addEventListener("os:data-refreshed", onRefresh);
    return () => window.removeEventListener("os:data-refreshed", onRefresh);
  }, [reload]);

  useEffect(() => {
    let active = true;
    loadFollowupBoard(user.uid).then(
      (res) => {
        if (!active) return;
        setBoard(res);
        setLoading(false);
      },
      (err) => {
        if (!active) return;
        setError(errorMessage(err));
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [user.uid]);

  const snooze = async (leadId: string, lastContactedAt: string | null, gapDays: number) => {
    if (!lastContactedAt) return;
    setBusy(leadId);
    try {
      await updateLeadFields(user.uid, leadId, {
        last_contacted_at: snoozeLastContactedAt({ lastContactedAt, gapDays }),
      });
      toast.success("Snoozed +2 days", "This follow-up will reappear in two days.");
      await reload();
    } catch (err) {
      toast.error("Could not snooze", errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const stop = async (leadId: string, name: string | null) => {
    const ok = await confirmDialog({
      title: `Stop follow-ups for ${name ?? "this prospect"}?`,
      message:
        "The prospect is marked Suppressed, so no further follow-up will be scheduled or sent. You can change the status again from Leads.",
      confirmLabel: "Stop follow-ups",
      tone: "bad",
    });
    if (!ok) return;
    setBusy(leadId);
    try {
      await updateLeadFields(user.uid, leadId, { status: "suppressed" });
      toast.success("Follow-ups stopped", "This prospect will not receive more automated emails.");
      await reload();
    } catch (err) {
      toast.error("Could not stop follow-ups", errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const tabs = useMemo(
    () => [
      { key: "due" as const, label: "Due now", count: board?.due.length ?? 0 },
      { key: "upcoming" as const, label: "Upcoming", count: board?.upcoming.length ?? 0 },
      { key: "sent" as const, label: "Sent", count: board?.sent.length ?? 0 },
      { key: "stopped" as const, label: "Stopped", count: board?.stopped.length ?? 0 },
    ],
    [board],
  );

  const dueRows = board?.due ?? [];
  const upcomingRows = board?.upcoming ?? [];

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Follow-ups</h1>
          <p className="page-sub">
            Every follow-up is scheduled from the campaign cadence, stops the moment a prospect replies or opts out,
            and always adds a new reason to respond instead of repeating the first email.
          </p>
        </div>
      </div>

      <div className="stack">
        {error && <Banner tone="bad">{error}</Banner>}

        <div className="grid grid-auto">
          <Stat
            label="Due now"
            value={board?.due.length ?? 0}
            accent
            note={
              board
                ? `${board.overdueCount} overdue · ${board.dueTodayCount} due today`
                : "No reply yet"
            }
          />
          <Stat label="Upcoming" value={board?.upcoming.length ?? 0} note="Scheduled by campaign cadence" />
          <Stat label="Follow-ups sent" value={board?.sent.length ?? 0} />
          <Stat label="Stopped" value={board?.stopped.length ?? 0} note="Replied or opted out" />
        </div>

        <Card title="Run the follow-up queue" sub="Drafts the next scheduled message for every due prospect.">
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <BatchRunner type="followup" label="Prepare due follow-ups" limit={2} variant="primary" onDone={reload} />
            <BatchRunner
              type="send"
              label="Send approved emails"
              limit={2}
              confirmText="Send every approved email now, including follow-ups, from your connected Gmail account? They go to real prospects."
              onDone={reload}
            />
            <Link className="btn btn-sm" href="/review">
              Review drafted follow-ups
            </Link>
          </div>
          <p className="hint" style={{ marginTop: 8 }}>
            Gaps default to Day +3, +7 and +14 and are configurable per campaign. Replying, bouncing or opting out
            removes a prospect automatically.
          </p>
        </Card>

        <div className="tabs" role="tablist" aria-label="Follow-up queues">
          {tabs.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              className={`tab${tab === item.key ? " active" : ""}`}
              onClick={() => setTab(item.key)}
            >
              {item.label}
              <span className="badge" style={{ marginLeft: 6 }}>
                {item.count}
              </span>
            </button>
          ))}
        </div>

        {loading && !board ? (
          <BrandLoader />
        ) : tab === "due" ? (
          <Card title="Due now" sub="Overdue first, then due today">
            {dueRows.length === 0 ? (
              <Empty title="Nothing due">Prospects become eligible after the campaign follow-up gap with no reply.</Empty>
            ) : (
              <FollowupList
                items={dueRows}
                busy={busy}
                onSnooze={snooze}
                onStop={stop}
              />
            )}
          </Card>
        ) : tab === "upcoming" ? (
          <Card title="Upcoming" sub="Scheduled but not due yet">
            {upcomingRows.length === 0 ? (
              <Empty title="No upcoming follow-ups" />
            ) : (
              <FollowupList items={upcomingRows} busy={busy} onSnooze={snooze} onStop={stop} />
            )}
          </Card>
        ) : tab === "sent" ? (
          <Card title="Sent follow-ups" sub="Already delivered on the same thread">
            {(board?.sent.length ?? 0) === 0 ? (
              <Empty title="No follow-ups sent yet" />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Prospect</th>
                      <th>Subject</th>
                      <th className="num">Step</th>
                      <th>Sent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {board?.sent.map((item) => (
                      <tr key={item.messageId}>
                        <td style={{ minWidth: 0 }}>
                          <div className="strong truncate">{item.business ?? item.email ?? "—"}</div>
                          <div className="tiny muted truncate">{item.email ?? ""}</div>
                        </td>
                        <td className="truncate">{item.subject ?? "—"}</td>
                        <td className="num">{item.step}</td>
                        <td className="tiny nowrap">{item.sentAt ? fmtDate(item.sentAt) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        ) : (
          <Card title="Stopped" sub="Sequences ended by a reply, bounce or opt-out">
            {(board?.stopped.length ?? 0) === 0 ? (
              <Empty title="No stopped sequences" />
            ) : (
              <div className="stack" style={{ gap: 8 }}>
                {board?.stopped.map((item) => (
                  <div
                    key={item.leadId}
                    className="row"
                    style={{
                      justifyContent: "space-between",
                      gap: 10,
                      padding: "10px 12px",
                      border: "1px solid var(--line-soft)",
                      borderRadius: 10,
                      minWidth: 0,
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="strong truncate">{item.business ?? item.email ?? "—"}</div>
                      <div className="tiny muted truncate">{item.email ?? ""}</div>
                    </div>
                    <Badge tone="info">{item.reason}</Badge>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}
      </div>
    </main>
  );
}

function FollowupList({
  items,
  busy,
  onSnooze,
  onStop,
}: {
  items: FollowupBoard["due"];
  busy: string | null;
  onSnooze: (leadId: string, lastContactedAt: string | null, gapDays: number) => Promise<void>;
  onStop: (leadId: string, name: string | null) => Promise<void>;
}) {
  return (
    <>
      <div className="mobile-only stack" style={{ gap: 10 }}>
        {items.map((item) => (
          <article
            key={`${item.leadId}-${item.step}`}
            className="card"
            style={{ padding: 12, borderRadius: 12, display: "grid", gap: 8, minWidth: 0 }}
          >
            <div className="row" style={{ justifyContent: "space-between", gap: 8, minWidth: 0 }}>
              <div className="strong truncate" style={{ minWidth: 0 }}>
                {item.business ?? item.email ?? "Untitled prospect"}
              </div>
              <Badge tone={item.urgency === "overdue" ? "bad" : "warn"}>
                {item.urgency === "overdue" ? "Overdue" : "Due today"}
              </Badge>
            </div>
            <div className="tiny muted truncate">{item.email ?? item.campaignName}</div>
            <div className="tiny muted">
              Step {item.step} of {item.totalSteps} · {item.daysSince}d since last touch ·{" "}
              {item.lastSentSubject ? `Last: ${item.lastSentSubject}` : item.campaignName}
            </div>
            <FollowupActions item={item} busy={busy} onSnooze={onSnooze} onStop={onStop} />
          </article>
        ))}
      </div>

      <div className="table-wrap desktop-only">
        <table>
          <thead>
            <tr>
              <th style={{ width: "26%" }}>Prospect</th>
              <th style={{ width: "20%" }}>Email</th>
              <th style={{ width: "14%" }}>Step</th>
              <th style={{ width: "14%" }}>Days since touch</th>
              <th style={{ width: "26%" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={`${item.leadId}-${item.step}`}>
                <td style={{ minWidth: 0 }}>
                  <div className="strong truncate">{item.business ?? "—"}</div>
                  <div className="tiny muted truncate">
                    {item.campaignName}
                    {item.lastSentSubject ? ` · ${item.lastSentSubject}` : ""}
                  </div>
                </td>
                <td className="tiny truncate">{item.email ?? "—"}</td>
                <td className="tiny nowrap">
                  <Badge tone={item.urgency === "overdue" ? "bad" : "warn"}>
                    Step {item.step} of {item.totalSteps}
                  </Badge>
                </td>
                <td className="num">{item.daysSince}</td>
                <td>
                  <FollowupActions item={item} busy={busy} onSnooze={onSnooze} onStop={onStop} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function FollowupActions({
  item,
  busy,
  onSnooze,
  onStop,
}: {
  item: FollowupBoard["due"][number];
  busy: string | null;
  onSnooze: (leadId: string, lastContactedAt: string | null, gapDays: number) => Promise<void>;
  onStop: (leadId: string, name: string | null) => Promise<void>;
}) {
  const disabled = busy === item.leadId;
  return (
    <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
      <Link
        className="btn btn-sm btn-primary"
        href="/review"
        style={{ minHeight: 44, display: "inline-flex", alignItems: "center", gap: 6 }}
      >
        <Mail size={14} />
        Draft / Review &amp; Send
      </Link>
      <button
        type="button"
        className="btn btn-sm"
        disabled={disabled}
        onClick={() => void onSnooze(item.leadId, item.lastContactedAt, item.gapDays)}
        style={{ minHeight: 44, display: "inline-flex", alignItems: "center", gap: 6 }}
      >
        <Clock size={14} />
        Snooze +2d
      </button>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        disabled={disabled}
        onClick={() => void onStop(item.leadId, item.business)}
        style={{ minHeight: 44, display: "inline-flex", alignItems: "center", gap: 6 }}
      >
        {disabled ? <PauseCircle size={14} /> : <Check size={14} />}
        Mark done / Stop
      </button>
      <span className="tiny muted row" style={{ gap: 4 }}>
        <Send size={12} /> due {item.dueDate}
      </span>
    </div>
  );
}
