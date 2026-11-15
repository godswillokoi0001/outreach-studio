"use client";

import { useState } from "react";
import { useApi } from "@/lib/client";
import { Badge, Banner, Card, Empty, Modal, Pager, Progress } from "@/components/ui";
import { fmtDate, label, statusTone } from "@/lib/format";

interface SentRow {
  id: string;
  subject: string | null;
  body: string | null;
  status: string;
  kind: string;
  sent_at: string | null;
  gmail_id: string | null;
  thread_id: string | null;
  error: string | null;
  business: string | null;
  lead_email: string | null;
}

export default function SentPage() {
  const [tab, setTab] = useState("sent");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<SentRow | null>(null);
  const { data, loading, error } = useApi<{ messages: SentRow[]; total: number; page: number; pageSize: number; counts: Record<string, number> }>(
    `/api/messages?status=${tab}&page=${page}&pageSize=20`,
    [tab, page],
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
                <button key={value} className={`tab${tab === value ? " active" : ""}`} onClick={() => { setTab(value); setPage(1); }} type="button">
                  {text}{data?.counts[value] ? ` (${data.counts[value]})` : ""}
                </button>
              ))}
            </div>
          </div>

          {loading && !data ? (
            <div style={{ padding: 18 }}><Progress label="Loading sent emails…" /></div>
          ) : data && data.messages.length === 0 ? (
            <div style={{ padding: 18 }}>
              <Empty title="Nothing here yet">
                Approve emails in the review queue, then run “Send approved” from a campaign.
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
                    <th>Sent</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.messages.map((message) => (
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
                      <td className="tiny nowrap">{fmtDate(message.sent_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data && (
            <div style={{ padding: "0 16px 14px" }}>
              <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
            </div>
          )}
        </Card>
      </div>

      <Modal open={Boolean(open)} onClose={() => setOpen(null)} title={open?.subject ?? "Email"} large>
        {open && (
          <>
            <div className="row" style={{ marginBottom: 12 }}>
              <Badge tone={statusTone(open.status)}>{label(open.status)}</Badge>
              <span className="tiny">To {open.lead_email ?? "—"} · {fmtDate(open.sent_at)}</span>
            </div>
            <pre className="pre">{open.body}</pre>
            <div className="divider" />
            <dl className="kv">
              <dt>Gmail message ID</dt><dd className="mono">{open.gmail_id ?? "—"}</dd>
              <dt>Thread ID</dt><dd className="mono">{open.thread_id ?? "—"}</dd>
              {open.error && (<><dt>Error</dt><dd>{open.error}</dd></>)}
            </dl>
          </>
        )}
      </Modal>
    </main>
  );
}
