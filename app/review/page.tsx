"use client";

import { useEffect, useState } from "react";
import { api, errorMessage, useApi } from "@/lib/client";
import { Badge, Banner, Card, Empty, Modal, Pager, Progress } from "@/components/ui";
import { fmtDate, label, statusTone } from "@/lib/format";

interface MessageRow {
  id: string;
  lead_id: string;
  campaign_id: string | null;
  kind: string;
  step: number;
  subject: string | null;
  body: string | null;
  angle: string | null;
  rationale: string | null;
  service: string | null;
  status: string;
  created_at: string;
  business: string | null;
  lead_email: string | null;
  contact_name: string | null;
  score: number | null;
  industry: string | null;
}

const TABS = [
  ["pending_approval", "Awaiting approval"],
  ["approved", "Approved, ready to send"],
  ["cancelled,failed", "Rejected / failed"],
  ["all", "All emails"],
] as const;

export default function ReviewPage() {
  const [tab, setTab] = useState<string>("pending_approval");
  const [campaign, setCampaign] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<MessageRow | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const campaigns = useApi<{ campaigns: { id: string; name: string }[] }>("/api/campaigns");
  const { data, loading, reload } = useApi<{
    messages: MessageRow[];
    total: number;
    page: number;
    pageSize: number;
    counts: Record<string, number>;
  }>(`/api/messages?status=${tab}&campaign=${campaign}&page=${page}&pageSize=20`, [tab, campaign, page]);

  useEffect(() => {
    if (!open) return;
    setSubject(open.subject ?? "");
    setBody(open.body ?? "");
  }, [open]);

  const act = async (action: string, id?: string) => {
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      if (action === "approve_all") {
        if (!campaign) {
          setError("Select a campaign to approve in bulk.");
          return;
        }
        const result = await api.patch<{ changed: number }>("/api/messages", { action: "approve_all", campaignId: campaign });
        setNotice(`${result.changed} emails approved. They will send during your sending window.`);
      } else {
        const result = await api.patch<{ subject?: string; body?: string }>("/api/messages", {
          id,
          action,
          subject: action === "reject" ? undefined : subject,
          body: action === "reject" ? undefined : body,
        });
        if (action === "regenerate" && result.subject) {
          setSubject(result.subject);
          setBody(result.body ?? "");
        }
        setNotice(`${label(action === "approve" ? "approved" : action === "reject" ? "cancelled" : action)} successfully.`);
        if (action !== "edit" && action !== "regenerate") setOpen(null);
      }
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Email review</h1>
          <p className="page-sub">
            Every email is written from the stored research. Read it, edit it, or regenerate it. Only approved emails
            can be sent, and only inside your sending window and limits.
          </p>
        </div>
      </div>

      <div className="stack">
        {error && <Banner tone="bad">{error}</Banner>}
        {notice && <Banner tone="ok">{notice}</Banner>}

        <Card tight>
          <div style={{ padding: "12px 16px 0" }}>
            <div className="tabs">
              {TABS.map(([value, text]) => (
                <button
                  key={value}
                  className={`tab${tab === value ? " active" : ""}`}
                  onClick={() => { setTab(value); setPage(1); }}
                  type="button"
                >
                  {text}{value === "pending_approval" && data?.counts.pending_approval ? ` (${data.counts.pending_approval})` : ""}
                </button>
              ))}
            </div>
            <div className="row" style={{ paddingBottom: 14 }}>
              <select className="select" style={{ maxWidth: 320 }} value={campaign} onChange={(e) => { setCampaign(e.target.value); setPage(1); }}>
                <option value="">All campaigns</option>
                {(campaigns.data?.campaigns ?? []).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <button className="btn btn-sm" onClick={() => act("approve_all")} disabled={!campaign || busy !== null} type="button">
                Approve all pending in campaign
              </button>
              <span className="tiny row-end">{data?.total ?? 0} emails</span>
            </div>
          </div>

          {loading && !data ? (
            <div style={{ padding: 18 }}><Progress label="Loading emails…" /></div>
          ) : data && data.messages.length === 0 ? (
            <div style={{ padding: 18 }}>
              <Empty title="Nothing in this view">
                Generate emails from the Prospect research or Campaigns page once prospects are qualified.
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
                    <th>Score</th>
                    <th>Status</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.messages.map((message) => (
                    <tr key={message.id} className="clickable" onClick={() => setOpen(message)}>
                      <td>
                        <div className="strong">{message.business ?? "—"}</div>
                        <div className="tiny">{message.lead_email ?? "no email"} · {message.contact_name ?? "no contact name"}</div>
                      </td>
                      <td style={{ maxWidth: 320 }}>{message.subject ?? "—"}</td>
                      <td className="tiny">{message.kind === "followup" ? `Follow-up ${message.step}` : "Initial"}</td>
                      <td className="num">{message.score ?? "—"}</td>
                      <td><Badge tone={statusTone(message.status)}>{label(message.status)}</Badge></td>
                      <td className="tiny nowrap">{fmtDate(message.created_at)}</td>
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

      <Modal open={Boolean(open)} onClose={() => setOpen(null)} title={open?.business ?? "Email"} large>
        {open && (
          <>
            <div className="row" style={{ marginBottom: 12 }}>
              <Badge tone={statusTone(open.status)}>{label(open.status)}</Badge>
              {open.service && <Badge tone="info">{open.service}</Badge>}
              {open.angle && <Badge tone="gold">{open.angle}</Badge>}
            </div>
            <div className="field">
              <span className="label">Subject</span>
              <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <div className="field">
              <span className="label">Body</span>
              <textarea className="textarea" style={{ minHeight: 260 }} value={body} onChange={(e) => setBody(e.target.value)} />
            </div>
            {open.rationale && (
              <div style={{ marginBottom: 12 }}>
                <div className="label">Why this approach</div>
                <p className="tiny" style={{ whiteSpace: "pre-wrap" }}>{open.rationale}</p>
              </div>
            )}
            <div className="row">
              <button className="btn btn-sm" onClick={() => act("edit", open.id)} disabled={busy !== null} type="button">Save changes</button>
              <button className="btn btn-sm btn-primary" onClick={() => act("approve", open.id)} disabled={busy !== null} type="button">Approve email</button>
              <button className="btn btn-sm" onClick={() => act("regenerate", open.id)} disabled={busy !== null} type="button">
                {busy === "regenerate" ? "Rewriting…" : "Regenerate with AI"}
              </button>
              <button className="btn btn-sm btn-danger" onClick={() => act("reject", open.id)} disabled={busy !== null} type="button">Reject</button>
              <span className="tiny row-end">To: {open.lead_email ?? "no address"}</span>
            </div>
          </>
        )}
      </Modal>
    </main>
  );
}
