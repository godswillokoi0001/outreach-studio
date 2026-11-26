"use client";

import { BrandLoader } from "@/components/BrandLoader";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { Badge, Banner, Card, Empty, Modal, Pager } from "@/components/ui";
import { useConfirm, useToast } from "@/components/Feedback";
import { errorMessage } from "@/lib/client";
import {
  clearOpenEvents,
  listLeads,
  listMessages,
  listOpenEvents,
  updateLeadFields,
  updateMessageStatus,
} from "@/lib/store";
import { formatEmailHtml } from "@/lib/email-format";
import { fmtDate, label, statusTone } from "@/lib/format";
import type { EmailOpen, Lead, Message } from "@/lib/types";

interface SentRow extends Message {
  business: string | null;
  lead_email: string | null;
}

const PAGE_SIZE = 20;

export default function SentPage() {
  const { user } = useAuth();
  const confirmDialog = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState("sent");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<SentRow | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [opens, setOpens] = useState<EmailOpen[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [m, l, o] = await Promise.all([
        listMessages(user.uid),
        listLeads(user.uid),
        listOpenEvents(user.uid),
      ]);
      setMessages(m);
      setLeads(l);
      setOpens(o);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [user.uid]);

  useEffect(() => {
    const onRefresh = () => void reload();
    window.addEventListener("os:data-refreshed", onRefresh);
    return () => window.removeEventListener("os:data-refreshed", onRefresh);
  }, [reload]);

  useEffect(() => {
    let active = true;
    Promise.all([listMessages(user.uid), listLeads(user.uid), listOpenEvents(user.uid)]).then(
      ([m, l, o]) => {
        if (!active) return;
        setMessages(m);
        setLeads(l);
        setOpens(o);
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

  const rows: SentRow[] = useMemo(() => {
    const leadMap = new Map(leads.map((l) => [l.id, l]));
    return messages.map((m) => {
      const lead = leadMap.get(m.lead_id);
      return {
        ...m,
        business: lead?.business ?? null,
        lead_email: lead?.email ?? null,
      };
    });
  }, [messages, leads]);

  // Opens arrive after the email is read, so keep the list fresh instead of
  // showing "Not yet" until the page is reloaded by hand.
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (document.hidden) return;
      listOpenEvents(user.uid)
        .then((next) => {
          if (active) setOpens(next);
        })
        .catch(() => undefined);
    };
    // One read a minute, never while the tab is in the background: every tick
    // is a real table scan on Supabase.
    const timer = window.setInterval(refresh, 60_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [user.uid]);

  /** Take a sent email out of the sent list and put it back in review. */
  const revertToReview = async (message: SentRow) => {
    const ok = await confirmDialog({
      title: "Send this email back to review?",
      message:
        "It leaves the sent list and returns to the review queue, where you can edit it or approve it again. The recipient already received the original message.",
      confirmLabel: "Back to review",
      cancelLabel: "Keep as sent",
      tone: "info",
    });
    if (!ok) return;
    setBusy(message.id);
    try {
      await updateMessageStatus(user.uid, message.id, "pending_approval", {
        sent_at: null,
        gmail_id: null,
        thread_id: null,
        error: null,
        approved_at: null,
      });
      if (message.lead_id) {
        await updateLeadFields(user.uid, message.lead_id, { status: "email_generated" });
      }
      setOpen(null);
      await reload();
      toast.success("Moved back to review", "The email is waiting in Email review.");
    } catch (err) {
      toast.error("Could not move the email", errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  /** Delete every recorded open so the Opened column and signals start fresh. */
  const clearOpens = async () => {
    const ok = await confirmDialog({
      title: "Clear the open history?",
      message:
        `${opens.length} recorded open${opens.length === 1 ? "" : "s"} are deleted. The sent emails stay, and new opens are still tracked from now on. This cannot be undone.`,
      confirmLabel: "Clear history",
      tone: "bad",
    });
    if (!ok) return;
    setBusy("clears-opens");
    try {
      const removed = await clearOpenEvents(user.uid);
      await reload();
      toast.success(
        "Open history cleared",
        `${removed} open${removed === 1 ? "" : "s"} removed. New opens are still recorded.`,
      );
    } catch (err) {
      toast.error("Could not clear the open history", errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const openStats = useMemo(() => {
    const map = new Map<string, { count: number; last: string }>();
    for (const event of opens) {
      const current = map.get(event.message_id);
      if (!current) {
        map.set(event.message_id, { count: 1, last: event.opened_at });
      } else {
        current.count += 1;
        if (event.opened_at > current.last) current.last = event.opened_at;
      }
    }
    return map;
  }, [opens]);

  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const r of rows) map[r.status] = (map[r.status] ?? 0) + 1;
    return map;
  }, [rows]);

  const filtered = useMemo(() => rows.filter((r) => r.status === tab), [rows, tab]);
  const paged = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page],
  );

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Sent emails</h1>
          <p className="page-sub">
            Every message Gmail confirmed as sent, with the original content and the Gmail message ID used to match
            replies back to the prospect.
          </p>
        </div>
        <div className="row-end">
          <button
            className="btn btn-sm btn-danger"
            onClick={() => void clearOpens()}
            disabled={busy !== null || opens.length === 0}
            type="button"
            title="Delete every recorded email open"
          >
            <Trash2 size={12} aria-hidden="true" />
            {busy === "clears-opens" ? "Clearing…" : `Clear open history (${opens.length})`}
          </button>
        </div>
      </div>

      <div className="stack">
        {error && <Banner tone="bad">{error}</Banner>}
        <Card tight>
          <div style={{ padding: "12px 16px 0" }}>
            <div className="tabs">
              {[
                ["sent", "Sent"],
                ["failed", "Failed"],
                ["cancelled", "Cancelled"],
                ["sending", "In flight"],
              ].map(([value, text]) => (
                <button
                  key={value}
                  className={`tab${tab === value ? " active" : ""}`}
                  onClick={() => {
                    setTab(value);
                    setPage(1);
                  }}
                  type="button"
                >
                  {text}
                  {counts[value] ? ` (${counts[value]})` : ""}
                </button>
              ))}
            </div>
          </div>

          {loading && messages.length === 0 ? (
            <div style={{ padding: 18 }}>
              <BrandLoader />
            </div>
          ) : paged.length === 0 ? (
            <div style={{ padding: 18 }}>
              <Empty title="Nothing here yet">
                Approve emails in the review queue, then run &ldquo;Send approved&rdquo; from a campaign.
              </Empty>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Prospect</th>
                    <th>Subject</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Opened</th>
                    <th>Sent</th>
                  </tr>
                </thead>
                <tbody>
                  {paged.map((message) => (
                    <tr key={message.id} className="clickable" onClick={() => setOpen(message)}>
                      <td>
                        <div className="strong">{message.business ?? "—"}</div>
                        <div className="tiny">{message.lead_email ?? ""}</div>
                      </td>
                      <td style={{ maxWidth: 340 }}>{message.subject ?? "—"}</td>
                      <td className="tiny">
                        {message.kind === "followup"
                          ? "Follow-up"
                          : message.kind === "reply"
                            ? "Your reply"
                            : "Initial"}
                      </td>
                      <td>
                        <Badge tone={statusTone(message.status)}>{label(message.status)}</Badge>
                        {message.error && <div className="tiny">{message.error.slice(0, 90)}</div>}
                      </td>
                      <td>
                        {openStats.get(message.id) ? (
                          <Badge tone="ok">Opened {openStats.get(message.id)!.count}×</Badge>
                        ) : message.status === "sent" ? (
                          <span className="tiny">Not yet</span>
                        ) : (
                          <span className="tiny">—</span>
                        )}
                      </td>
                      <td className="tiny nowrap">{fmtDate(message.sent_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ padding: "0 16px 14px" }}>
            <Pager page={page} pageSize={PAGE_SIZE} total={filtered.length} onPage={setPage} />
          </div>
        </Card>
      </div>

      <Modal open={Boolean(open)} onClose={() => setOpen(null)} title={open?.subject ?? "Email"} large>
        {open && (
          <>
            <div className="row" style={{ marginBottom: 12 }}>
              <Badge tone={statusTone(open.status)}>{label(open.status)}</Badge>
              <span className="tiny">
                To {open.lead_email ?? "—"} · {fmtDate(open.sent_at)}
              </span>
            </div>
            <div
              style={{
                padding: "14px 16px",
                border: "1px solid var(--line)",
                borderRadius: 10,
                background: "var(--surface)",
                fontSize: 15,
                lineHeight: 1.65,
              }}
              // The renderer escapes the body first; only p/br/strong/em/ul/li/a are emitted.
              dangerouslySetInnerHTML={{ __html: formatEmailHtml(open.body ?? "") }}
            />
            {(open.status === "sent" || open.status === "failed") && (
              <div className="row" style={{ marginTop: 12 }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void revertToReview(open)}
                  disabled={busy === open.id}
                >
                  <RotateCcw size={12} aria-hidden="true" />
                  {busy === open.id ? "Moving…" : "Send back to review"}
                </button>
              </div>
            )}
            <div className="divider" />
            <div className="open-summary" data-open={openStats.get(open.id) ? "true" : "false"}>
              <span className="open-summary-dot" />
              {openStats.get(open.id) ? (
                <span>
                  <strong>
                    Opened {openStats.get(open.id)!.count} time
                    {openStats.get(open.id)!.count === 1 ? "" : "s"}
                  </strong>{" "}
                  · last {fmtDate(openStats.get(open.id)!.last)}
                </span>
              ) : (
                <span>
                  <strong>No open recorded</strong> — either it has not been read yet, or the recipient&apos;s mail
                  client blocks remote images.
                </span>
              )}
            </div>
            <div className="divider" />
            <dl className="kv">
              <dt>Gmail message ID</dt>
              <dd className="mono">{open.gmail_id ?? "—"}</dd>
              <dt>Thread ID</dt>
              <dd className="mono">{open.thread_id ?? "—"}</dd>
              {open.error && (
                <>
                  <dt>Error</dt>
                  <dd>{open.error}</dd>
                </>
              )}
            </dl>
          </>
        )}
      </Modal>
    </main>
  );
}
