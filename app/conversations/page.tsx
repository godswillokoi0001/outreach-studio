"use client";

import { useState } from "react";
import { api, errorMessage, useApi } from "@/lib/client";
import { Badge, Banner, Card, Empty, Pager, Progress } from "@/components/ui";
import { fmtDate } from "@/lib/format";

interface ReplyRow {
  id: string;
  lead_id: string | null;
  subject: string | null;
  snippet: string | null;
  body: string | null;
  from_email: string | null;
  received_at: string | null;
  classification: string | null;
  summary: string | null;
  recommended_action: string | null;
  draft_reply: string | null;
  handled: number;
  business: string | null;
  industry: string | null;
  campaign_id: string | null;
}

interface ThreadMessage {
  id: string;
  subject: string | null;
  body: string | null;
  sent_at: string | null;
  kind: string;
}

const CLASS_LABELS: Record<string, string> = {
  interested: "Interested",
  more_info: "Wants more info",
  pricing: "Asking about pricing",
  objection: "Objection",
  not_interested: "Not interested",
  referral: "Referral",
  out_of_office: "Out of office",
  unsubscribe: "Unsubscribe",
  bounce: "Bounced",
  other: "Other",
};

function classTone(classification: string | null): string | undefined {
  switch (classification) {
    case "interested":
    case "more_info":
    case "pricing":
      return "ok";
    case "referral":
      return "info";
    case "objection":
    case "out_of_office":
      return "warn";
    case "not_interested":
    case "unsubscribe":
    case "bounce":
      return "bad";
    default:
      return undefined;
  }
}

export default function ConversationsPage() {
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const { data, loading, reload } = useApi<{
    replies: ReplyRow[];
    threads: Record<string, ThreadMessage[]>;
    total: number;
    page: number;
    pageSize: number;
    counts: Record<string, number>;
  }>(`/api/replies?filter=${filter}&page=${page}&pageSize=15`, [filter, page]);

  const act = async (id: string, body: Record<string, unknown>, message: string) => {
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      await api.patch("/api/replies", { id, ...body });
      setNotice(message);
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Suggested reply copied to your clipboard.");
    } catch {
      setError("Could not copy automatically. Select the text and copy it manually.");
    }
  };

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Conversations</h1>
          <p className="page-sub">
            Replies are classified automatically and each one comes with a suggested answer in your voice. Follow-ups
            for that prospect stop as soon as a reply arrives.
          </p>
        </div>
      </div>

      <div className="stack">
        {error && <Banner tone="bad">{error}</Banner>}
        {notice && <Banner tone="ok">{notice}</Banner>}

        <Card tight>
          <div style={{ padding: "12px 16px 0" }}>
            <div className="tabs">
              {[
                ["all", "All replies"],
                ["needs_attention", "Needs attention"],
                ["positive", "Positive"],
                ["pricing", "Pricing"],
                ["objection", "Objections"],
                ["unsubscribe", "Unsubscribes"],
              ].map(([value, text]) => (
                <button key={value} className={`tab${filter === value ? " active" : ""}`} onClick={() => { setFilter(value); setPage(1); }} type="button">
                  {text}
                </button>
              ))}
            </div>
          </div>

          {loading && !data ? (
            <div style={{ padding: 18 }}><Progress label="Loading conversations…" /></div>
          ) : data && data.replies.length === 0 ? (
            <div style={{ padding: 18 }}>
              <Empty title="No replies yet">
                Use “Sync replies” in the top bar after prospects start answering. Replies are matched by sender
                address and classified automatically.
              </Empty>
            </div>
          ) : (
            <div className="stack" style={{ padding: 16 }}>
              {data?.replies.map((reply) => (
                <div key={reply.id} className="card" style={{ boxShadow: "none", background: "var(--surface-2)" }}>
                  <div className="row" style={{ marginBottom: 6 }}>
                    <div>
                      <div className="strong">{reply.business ?? reply.from_email ?? "Unknown sender"}</div>
                      <div className="tiny">
                        {reply.from_email} · {fmtDate(reply.received_at)} {reply.handled ? "· handled" : ""}
                      </div>
                    </div>
                    <div className="row-end row">
                      <Badge tone={classTone(reply.classification)}>
                        {CLASS_LABELS[reply.classification ?? "other"] ?? reply.classification}
                      </Badge>
                    </div>
                  </div>

                  {reply.summary && <p style={{ fontSize: 13 }}>{reply.summary}</p>}
                  <p className="quote" style={{ marginBottom: 10 }}>
                    {(reply.body ?? reply.snippet ?? "").slice(0, 600) || "(no readable body)"}
                  </p>

                  {reply.recommended_action && (
                    <p className="tiny" style={{ marginBottom: 8 }}>
                      <strong>Next step:</strong> {reply.recommended_action}
                    </p>
                  )}

                  {reply.draft_reply && (
                    <div style={{ marginBottom: 10 }}>
                      <div className="label" style={{ marginBottom: 4 }}>Suggested reply</div>
                      <pre className="pre" style={{ background: "#fff" }}>{reply.draft_reply}</pre>
                      <div className="row" style={{ marginTop: 6 }}>
                        <button className="btn btn-sm" onClick={() => copy(reply.draft_reply ?? "")} type="button">Copy reply</button>
                      </div>
                    </div>
                  )}

                  {reply.lead_id && (data?.threads[reply.lead_id]?.length ?? 0) > 0 && (
                    <details style={{ marginBottom: 8 }}>
                      <summary className="tiny" style={{ cursor: "pointer" }}>Show emails sent to this prospect</summary>
                      <div className="stack" style={{ gap: 8, marginTop: 8 }}>
                        {data?.threads[reply.lead_id].map((message) => (
                          <div key={message.id}>
                            <div className="tiny">{fmtDate(message.sent_at)} · {message.kind === "followup" ? "Follow-up" : "Initial"}: {message.subject}</div>
                            <pre className="pre" style={{ background: "#fff", fontSize: 12.4 }}>{message.body}</pre>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}

                  <div className="row">
                    <button
                      className="btn btn-sm"
                      onClick={() => act(reply.id, { handled: !reply.handled }, reply.handled ? "Marked as not handled." : "Marked as handled.")}
                      disabled={busy === reply.id}
                      type="button"
                    >
                      {reply.handled ? "Mark unhandled" : "Mark handled"}
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => {
                        if (!window.confirm("Stop all contact with this prospect and add them to the suppression list?")) return;
                        act(reply.id, { suppress: true }, "Prospect suppressed. No further emails will be sent.");
                      }}
                      disabled={busy === reply.id}
                      type="button"
                    >
                      Stop contact
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {data && (
            <div style={{ padding: "0 16px 14px" }}>
              <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
            </div>
          )}
        </Card>
      </div>
    </main>
  );
}
