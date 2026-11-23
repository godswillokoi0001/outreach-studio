"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { Badge, Banner, Card, Empty, Modal, Pager, Progress } from "@/components/ui";
import { authedPost, errorMessage } from "@/lib/client";
import type { ComposedEmail } from "@/lib/compose";
import {
  approveAllMessagesInCampaign,
  getSettings,
  listCampaigns,
  listLeads,
  listMessages,
  updateLeadFields,
  updateMessageContent,
  updateMessageStatus,
} from "@/lib/firestore-store";
import { fmtDate, label, statusTone } from "@/lib/format";
import { buildLiveKnowledgeDigest } from "@/lib/pipeline-client";
import type { Campaign, Lead, Message } from "@/lib/types";

interface MessageRow extends Message {
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

const PAGE_SIZE = 20;

export default function ReviewPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<string>("pending_approval");
  const [campaign, setCampaign] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<MessageRow | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, l, m] = await Promise.all([
        listCampaigns(user.uid),
        listLeads(user.uid),
        listMessages(user.uid),
      ]);
      setCampaigns(c);
      setLeads(l);
      setMessages(m);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [user.uid]);

  useEffect(() => {
    let active = true;
    Promise.all([
      listCampaigns(user.uid),
      listLeads(user.uid),
      listMessages(user.uid),
    ]).then(
      ([c, l, m]) => {
        if (!active) return;
        setCampaigns(c);
        setLeads(l);
        setMessages(m);
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

  const rows: MessageRow[] = useMemo(() => {
    const leadMap = new Map(leads.map((l) => [l.id, l]));
    return messages.map((m) => {
      const lead = leadMap.get(m.lead_id);
      return {
        ...m,
        business: lead?.business ?? null,
        lead_email: lead?.email ?? null,
        contact_name: lead?.contact_name ?? null,
        score: lead?.score ?? null,
        industry: lead?.industry ?? null,
      };
    });
  }, [messages, leads]);

  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const m of rows) {
      map[m.status] = (map[m.status] ?? 0) + 1;
    }
    return map;
  }, [rows]);

  const filtered = useMemo(() => {
    const allowed = tab === "all" ? null : new Set(tab.split(","));
    return rows.filter((m) => {
      if (allowed && !allowed.has(m.status)) return false;
      if (campaign && m.campaign_id !== campaign) return false;
      return true;
    });
  }, [rows, tab, campaign]);

  const paged = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page],
  );

  const openMessageModal = (message: MessageRow) => {
    setOpen(message);
    setSubject(message.subject ?? "");
    setBody(message.body ?? "");
  };

  const act = async (action: "approve_all" | "edit" | "approve" | "reject" | "regenerate", id?: string) => {
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      if (action === "approve_all") {
        if (!campaign) {
          setError("Select a campaign to approve in bulk.");
          return;
        }
        const changed = await approveAllMessagesInCampaign(user.uid, campaign);
        setNotice(`${changed} emails approved. They will send during your sending window.`);
      } else if (id) {
        const currentMsg = messages.find((m) => m.id === id);
        if (!currentMsg) throw new Error("Message not found.");

        if (action === "edit") {
          await updateMessageContent(user.uid, id, { subject, body });
          setNotice("Changes saved.");
        } else if (action === "approve") {
          await updateMessageContent(user.uid, id, { subject, body });
          await updateMessageStatus(user.uid, id, "approved", { approved_at: new Date().toISOString() });
          await updateLeadFields(user.uid, currentMsg.lead_id, { status: "approved" });
          setNotice("Approved successfully.");
          setOpen(null);
        } else if (action === "reject") {
          await updateMessageStatus(user.uid, id, "cancelled");
          setNotice("Message rejected.");
          setOpen(null);
        } else if (action === "regenerate") {
          const lead = leads.find((l) => l.id === currentMsg.lead_id);
          const camp = campaigns.find((c) => c.id === currentMsg.campaign_id);
          if (!lead || !camp) throw new Error("Lead or campaign record is missing.");
          const [settings, knowledge] = await Promise.all([
            getSettings(user.uid),
            buildLiveKnowledgeDigest(user.uid),
          ]);
          const originalSent =
            currentMsg.kind === "followup"
              ? messages.find((m) => m.lead_id === lead.id && m.status === "sent")
              : undefined;

          const { composed } = await authedPost<{ composed: ComposedEmail }>("/api/ai/compose", {
            kind: currentMsg.kind,
            lead,
            research: lead.research,
            campaign: camp.config,
            settings,
            knowledge,
            original: originalSent,
            step: currentMsg.step,
            model: settings.model,
          });
          await updateMessageContent(user.uid, id, {
            subject: composed.subject,
            body: composed.body,
            angle: composed.angle,
            rationale: composed.rationale,
            service: composed.service,
          });
          setSubject(composed.subject);
          setBody(composed.body);
          setNotice("Email regenerated with Gemini.");
        }
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
        <div className="row-end">
          <button
            className="btn btn-sm btn-primary"
            onClick={() => {
              const nextInQueue = filtered.find((item) => item.status === "pending_approval") ?? filtered[0];
              if (nextInQueue) openMessageModal(nextInQueue);
            }}
            disabled={filtered.length === 0}
            type="button"
          >
            Review next email
          </button>
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
                  onClick={() => {
                    setTab(value);
                    setPage(1);
                  }}
                  type="button"
                >
                  {text}
                  {value === "pending_approval" && counts.pending_approval ? ` (${counts.pending_approval})` : ""}
                </button>
              ))}
            </div>
            <div className="row" style={{ paddingBottom: 14 }}>
              <select
                className="select"
                style={{ maxWidth: 320 }}
                value={campaign}
                onChange={(e) => {
                  setCampaign(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All campaigns</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button
                className="btn btn-sm"
                onClick={() => void act("approve_all")}
                disabled={!campaign || busy !== null}
                type="button"
              >
                Approve all pending in campaign
              </button>
              <span className="tiny row-end">{filtered.length} emails</span>
            </div>
          </div>

          {loading && messages.length === 0 ? (
            <div style={{ padding: 18 }}>
              <Progress label="Loading emails…" />
            </div>
          ) : paged.length === 0 ? (
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
                  {paged.map((message) => (
                    <tr key={message.id} className="clickable" onClick={() => openMessageModal(message)}>
                      <td>
                        <div className="strong">{message.business ?? "—"}</div>
                        <div className="tiny">
                          {message.lead_email ?? "no email"} · {message.contact_name ?? "no contact name"}
                        </div>
                      </td>
                      <td style={{ maxWidth: 320 }}>{message.subject ?? "—"}</td>
                      <td className="tiny">{message.kind === "followup" ? `Follow-up ${message.step}` : "Initial"}</td>
                      <td className="num">{message.score ?? "—"}</td>
                      <td>
                        <Badge tone={statusTone(message.status)}>{label(message.status)}</Badge>
                      </td>
                      <td className="tiny nowrap">{fmtDate(message.created_at)}</td>
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
              <textarea
                className="textarea"
                style={{ minHeight: 260 }}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </div>
            {open.rationale && (
              <div style={{ marginBottom: 12 }}>
                <div className="label">Why this approach</div>
                <p className="tiny" style={{ whiteSpace: "pre-wrap" }}>
                  {open.rationale}
                </p>
              </div>
            )}
            <div className="row" style={{ marginBottom: 10 }}>
              <button
                className="btn btn-sm btn-primary"
                onClick={() => void act("approve", open.id)}
                disabled={busy !== null}
                type="button"
              >
                Approve and send later
              </button>
              <button
                className="btn btn-sm"
                onClick={() => void act("edit", open.id)}
                disabled={busy !== null}
                type="button"
              >
                Save my edits
              </button>
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => void act("regenerate", open.id)}
                disabled={busy !== null}
                type="button"
              >
                {busy === "regenerate" ? "Rewriting…" : "Regenerate with AI"}
              </button>
              <span className="tiny row-end">To: {open.lead_email ?? "no address"}</span>
            </div>
            <div className="row">
              <button
                className="btn btn-sm btn-danger"
                onClick={() => void act("reject", open.id)}
                disabled={busy !== null}
                type="button"
              >
                Reject this email
              </button>
              <span className="tiny">Rejected emails are never sent.</span>
            </div>
          </>
        )}
      </Modal>
    </main>
  );
}
