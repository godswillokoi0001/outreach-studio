"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { Badge, Banner, Card, Empty, Modal, Pager, Progress } from "@/components/ui";
import { errorMessage } from "@/lib/client";
import { listLeads, listMessages, listOpenEvents } from "@/lib/firestore-store";
import { fmtDate, label, statusTone } from "@/lib/format";
import type { EmailOpen, Lead, Message } from "@/lib/types";

interface SentRow extends Message {
  business: string | null;
  lead_email: string | null;
}

const PAGE_SIZE = 20;

export default function SentPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState("sent");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<SentRow | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [opens, setOpens] = useState<EmailOpen[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
              <Progress label="Loading sent emails…" />
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
                      <td className="tiny">{message.kind === "followup" ? "Follow-up" : "Initial"}</td>
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
            <pre className="pre">{open.body}</pre>
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
