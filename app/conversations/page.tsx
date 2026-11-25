"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { Badge, Banner, Card, Empty, Pager, Progress } from "@/components/ui";
import { authedPost, errorMessage } from "@/lib/client";
import {
  addSuppression,
  getSettings,
  listLeads,
  listMessages,
  listReplies,
  recordOutgoingReply,
  updateLeadFields,
  updateReplyHandled,
} from "@/lib/store";
import { createRfcMessageId } from "@/lib/outreach-utils";
import { fmtDate } from "@/lib/format";
import type { Lead, Message, Reply } from "@/lib/types";

interface ReplyRow extends Reply {
  business: string | null;
  industry: string | null;
  campaign_id: string | null;
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

const POSITIVE_CLASSES = new Set(["interested", "more_info", "pricing"]);

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

const PAGE_SIZE = 15;

export default function ConversationsPage() {
  const { user, workspaceToken, reconnectWorkspace } = useAuth();
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [replies, setReplies] = useState<Reply[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [r, l, m] = await Promise.all([
        listReplies(user.uid),
        listLeads(user.uid),
        listMessages(user.uid),
      ]);
      setReplies(r);
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
      listReplies(user.uid),
      listLeads(user.uid),
      listMessages(user.uid),
    ]).then(
      ([r, l, m]) => {
        if (!active) return;
        setReplies(r);
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

  const rows: ReplyRow[] = useMemo(() => {
    const leadMap = new Map(leads.map((l) => [l.id, l]));
    return replies.map((r) => {
      const lead = r.lead_id ? leadMap.get(r.lead_id) : undefined;
      return {
        ...r,
        business: lead?.business ?? null,
        industry: lead?.industry ?? null,
        campaign_id: lead?.campaign_id ?? null,
      };
    });
  }, [replies, leads]);

  const threads = useMemo(() => {
    const map: Record<string, Message[]> = {};
    for (const m of messages) {
      if (m.status !== "sent") continue;
      map[m.lead_id] = map[m.lead_id] ?? [];
      map[m.lead_id].push(m);
    }
    return map;
  }, [messages]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (filter === "needs_attention") return !r.handled;
      if (filter === "positive") return POSITIVE_CLASSES.has(r.classification);
      if (filter === "pricing") return r.classification === "pricing";
      if (filter === "objection") return r.classification === "objection";
      if (filter === "unsubscribe") return r.classification === "unsubscribe";
      return true;
    });
  }, [rows, filter]);

  const paged = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page],
  );

  const toggleHandled = async (reply: ReplyRow) => {
    setBusy(reply.id);
    setError(null);
    setNotice(null);
    try {
      await updateReplyHandled(user.uid, reply.id, !reply.handled);
      setNotice(reply.handled ? "Marked as not handled." : "Marked as handled.");
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const suppressReply = async (reply: ReplyRow) => {
    if (!window.confirm("Stop all contact with this prospect and add them to the suppression list?")) return;
    setBusy(reply.id);
    setError(null);
    setNotice(null);
    try {
      const targetEmail = reply.from_email || (reply.lead_id ? leads.find((l) => l.id === reply.lead_id)?.email : null);
      if (targetEmail) {
        await addSuppression(user.uid, targetEmail, "Stopped via Conversations");
      }
      if (reply.lead_id) {
        await updateLeadFields(user.uid, reply.lead_id, { status: "suppressed" });
      }
      await updateReplyHandled(user.uid, reply.id, true);
      setNotice("Prospect suppressed. No further emails will be sent.");
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  // Refresh as soon as the background reply sync finishes.
  useEffect(() => {
    const onRefresh = () => void reload();
    window.addEventListener("os:data-refreshed", onRefresh);
    return () => window.removeEventListener("os:data-refreshed", onRefresh);
  }, [reload]);

  const sendReply = async (reply: ReplyRow) => {
    const body = (drafts[reply.id] ?? reply.draft_reply ?? "").trim();
    if (!body) {
      setError("Write a reply before sending it.");
      return;
    }
    setSending(reply.id);
    setError(null);
    setNotice(null);
    try {
      if (!workspaceToken) {
        const ok = await reconnectWorkspace();
        if (!ok) throw new Error("Connect Google before replying.");
      }
      const lead = reply.lead_id ? leads.find((l) => l.id === reply.lead_id) : undefined;
      const to = reply.from_email || lead?.email || "";
      if (!to) throw new Error("This reply has no address to answer.");

      const [settings, profile] = await Promise.all([
        getSettings(user.uid),
        authedPost<{ emailAddress: string }>(
          "/api/workspace/gmail",
          { action: "profile" },
          { requireWorkspace: true },
        ),
      ]);
      const senderEmail = settings.sender_email?.trim() || profile.emailAddress;
      const baseSubject = reply.subject ?? "";
      const subject = /^re:/i.test(baseSubject)
        ? baseSubject
        : `Re: ${baseSubject || "your message"}`;
      const rfcMessageId = createRfcMessageId(`reply-${reply.id}`, senderEmail);

      const sent = await authedPost<{ id: string; threadId: string }>(
        "/api/workspace/gmail",
        {
          action: "send",
          email: {
            to,
            from: senderEmail,
            fromName: settings.sender_name || settings.sender_company || senderEmail,
            subject,
            body,
            rfcMessageId,
            threadId: reply.thread_id ?? null,
            unsubscribeEmail: settings.unsubscribe_email || senderEmail,
            tracking: { enabled: false },
          },
        },
        { requireWorkspace: true },
      );

      await recordOutgoingReply(user.uid, {
        lead_id: reply.lead_id ?? "",
        campaign_id: reply.campaign_id,
        subject,
        body,
        gmail_id: sent.id,
        thread_id: sent.threadId ?? reply.thread_id ?? null,
      });
      if (reply.lead_id) {
        await updateLeadFields(user.uid, reply.lead_id, { status: "replied" });
      }
      await updateReplyHandled(user.uid, reply.id, true);
      setNotice(`Reply sent to ${to}. Follow-ups for this prospect stay stopped.`);
      setDrafts((current) => ({ ...current, [reply.id]: "" }));
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(null);
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
                <button
                  key={value}
                  className={`tab${filter === value ? " active" : ""}`}
                  onClick={() => {
                    setFilter(value);
                    setPage(1);
                  }}
                  type="button"
                >
                  {text}
                </button>
              ))}
            </div>
          </div>

          {loading && replies.length === 0 ? (
            <div style={{ padding: 18 }}>
              <Progress label="Loading conversations…" />
            </div>
          ) : paged.length === 0 ? (
            <div style={{ padding: 18 }}>
              <Empty title="No replies yet">
                Replies sync automatically when the app loads. You can also press &ldquo;Sync&rdquo; in the top bar.
                Replies are matched by sender address and classified automatically.
              </Empty>
            </div>
          ) : (
            <div className="stack" style={{ padding: 16 }}>
              {paged.map((reply) => (
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
                      <div className="label" style={{ marginBottom: 4 }}>
                        Suggested reply
                      </div>
                      <pre className="pre" style={{ background: "#fff" }}>
                        {reply.draft_reply}
                      </pre>
                      <div className="row" style={{ marginTop: 6 }}>
                        <button
                          className="btn btn-sm"
                          onClick={() => void copy(reply.draft_reply ?? "")}
                          type="button"
                        >
                          Copy reply
                        </button>
                      </div>
                    </div>
                  )}

                  {reply.lead_id && (threads[reply.lead_id]?.length ?? 0) > 0 && (
                    <details style={{ marginBottom: 8 }}>
                      <summary className="tiny" style={{ cursor: "pointer" }}>
                        Show emails sent to this prospect
                      </summary>
                      <div className="stack" style={{ gap: 8, marginTop: 8 }}>
                        {threads[reply.lead_id].map((message) => (
                          <div key={message.id}>
                            <div className="tiny">
                              {fmtDate(message.sent_at)} ·{" "}
                              {message.kind === "followup"
                                ? "Follow-up"
                                : message.kind === "reply"
                                  ? "Your reply"
                                  : "Initial"}
                              :{" "}
                              {message.subject}
                            </div>
                            <pre className="pre" style={{ background: "#fff", fontSize: 12.4 }}>
                              {message.body}
                            </pre>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}

                  <div style={{ marginBottom: 10 }}>
                    <div className="label" style={{ marginBottom: 4 }}>
                      Send a reply from here
                    </div>
                    <textarea
                      className="textarea"
                      rows={4}
                      value={drafts[reply.id] ?? reply.draft_reply ?? ""}
                      onChange={(e) =>
                        setDrafts((current) => ({ ...current, [reply.id]: e.target.value }))
                      }
                      placeholder="Write your answer…"
                    />
                    <div className="row" style={{ marginTop: 6 }}>
                      <button
                        className="btn btn-sm btn-primary"
                        onClick={() => void sendReply(reply)}
                        disabled={sending !== null}
                        type="button"
                      >
                        {sending === reply.id ? "Sending…" : "Send reply"}
                      </button>
                      {reply.draft_reply && (
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() =>
                            setDrafts((current) => ({
                              ...current,
                              [reply.id]: reply.draft_reply ?? "",
                            }))
                          }
                          disabled={sending !== null}
                          type="button"
                        >
                          Reset to suggestion
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="row">
                    <button
                      className="btn btn-sm"
                      onClick={() => void toggleHandled(reply)}
                      disabled={busy === reply.id}
                      type="button"
                    >
                      {reply.handled ? "Mark unhandled" : "Mark handled"}
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => void suppressReply(reply)}
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
          <div style={{ padding: "0 16px 14px" }}>
            <Pager page={page} pageSize={PAGE_SIZE} total={filtered.length} onPage={setPage} />
          </div>
        </Card>
      </div>
    </main>
  );
}
