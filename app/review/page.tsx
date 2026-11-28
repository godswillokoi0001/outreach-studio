"use client";

import { BrandLoader } from "@/components/BrandLoader";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, Info, Loader2, Save, Sparkles, Trash2, X } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { BatchRunner } from "@/components/Runner";
import { Badge, Banner, Card, Empty, Pager } from "@/components/ui";
import { MobileFeedRow } from "@/components/ui/MobileFeedRow";
import { EmailBodyEditor } from "@/components/EmailBodyEditor";
import { EmailRewriteWorkspace } from "@/components/EmailRewriteWorkspace";
import type { RewriteScope } from "@/lib/email-rewrite";
import { useConfirm, useToast } from "@/components/Feedback";
import { authedPost, errorMessage } from "@/lib/client";
import type { ComposedEmail } from "@/lib/compose";
import {
  hasSendableEmail,
  MAX_REWRITE_BATCH,
  prospectDisplayName,
  QUICK_REWRITE_BATCH,
} from "@/lib/review-queue";
import {
  approveAllMessagesInCampaign,
  deleteMessage,
  deleteMessages,
  getSettings,
  listCampaigns,
  listLeads,
  listMessages,
  updateLeadFields,
  updateMessageContent,
  updateMessageStatus,
} from "@/lib/store";
import { fmtDate, label, statusTone } from "@/lib/format";
import { formatEmailHtml } from "@/lib/email-format";
import { buildLiveKnowledgeDigest, sendMessageNow } from "@/lib/pipeline-client";
import type { Campaign, Lead, Message } from "@/lib/types";
import { LeadResearchModal } from "@/components/LeadResearchModal";
import {
  clearEmailDraft,
  readEmailDraft,
  usePersistedPageState,
  writeEmailDraft,
} from "@/lib/usePersistedPageState";

interface MessageRow extends Message {
  business: string | null;
  lead_email: string | null;
  contact_name: string | null;
  website: string | null;
  score: number | null;
  industry: string | null;
  displayName: string;
}

const TABS = [
  ["pending_approval", "Awaiting approval"],
  ["approved", "Approved, ready to send"],
  ["sent", "Sent"],
  ["cancelled,failed", "Rejected / failed"],
  ["missing_email", "Missing email (cannot send)"],
  ["all", "All emails"],
] as const;

const PAGE_SIZE = 20;

export default function ReviewPage() {
  const { user, workspaceToken, reconnectWorkspace } = useAuth();
  const confirmDialog = useConfirm();
  const toast = useToast();
  const [tab, setTab, resetTab] = usePersistedPageState<string>("review:tab", "pending_approval");
  const [campaign, setCampaign, resetCampaign] = usePersistedPageState<string>("review:campaign", "");
  const [page, setPage, resetPage] = usePersistedPageState<number>("review:page", 1);
  const [openEmailId, setOpenEmailId] = usePersistedPageState<string | null>("review:open", null);
  const [researchLead, setResearchLead] = useState<Lead | null>(null);
  const [review, setReview] = useState<MessageRow | null>(null);
  const [drawerMode, setDrawerMode] = useState<"review" | "rewrite" | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [subjectIdeas, setSubjectIdeas] = useState<string[]>([]);
  const [subjectBusy, setSubjectBusy] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [rewriteTrigger, setRewriteTrigger] = useState<{
    scope: RewriteScope;
    selectedIds?: string[];
    nonce: number;
  } | null>(null);

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [emailFooter, setEmailFooter] = useState("");
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
      getSettings(user.uid),
    ]).then(
      ([c, l, m, settings]) => {
        if (!active) return;
        setCampaigns(c);
        setLeads(l);
        setMessages(m);
        setEmailFooter(settings.email_footer ?? "");
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

  useEffect(() => {
    const onRefresh = () => void reload();
    window.addEventListener("os:data-refreshed", onRefresh);
    return () => window.removeEventListener("os:data-refreshed", onRefresh);
  }, [reload]);

  const closeDrawer = useCallback(() => {
    setDrawerMode(null);
    setReview(null);
    setSubjectIdeas([]);
    setOpenEmailId(null);
  }, [setOpenEmailId]);

  useEffect(() => {
    if (!drawerMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDrawer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerMode, closeDrawer]);

  const rows: MessageRow[] = useMemo(() => {
    const leadMap = new Map(leads.map((l) => [l.id, l]));
    // Reply drafts belong to Conversations; showing them here would invite a
    // duplicate answer to the same prospect.
    return messages
      .filter((m) => !(m.kind === "reply" && m.status === "draft"))
      .map((m) => {
        const lead = leadMap.get(m.lead_id);
        return {
          ...m,
          business: lead?.business ?? null,
          lead_email: lead?.email ?? null,
          contact_name: lead?.contact_name ?? null,
          website: lead?.website ?? null,
          score: lead?.score ?? null,
          industry: lead?.industry ?? null,
          displayName: prospectDisplayName({
            business: lead?.business,
            contactName: lead?.contact_name,
            email: lead?.email,
            website: lead?.website,
          }),
        };
      });
  }, [messages, leads]);

  const inCampaign = useMemo(
    () => (campaign ? rows.filter((m) => m.campaign_id === campaign) : rows),
    [rows, campaign],
  );

  const counts = useMemo(() => {
    const sendable = inCampaign.filter((m) => hasSendableEmail(m.lead_email));
    return {
      pending: sendable.filter((m) => m.status === "pending_approval").length,
      approved: sendable.filter((m) => m.status === "approved").length,
      sent: inCampaign.filter((m) => m.status === "sent").length,
      rejected: inCampaign.filter((m) => m.status === "cancelled" || m.status === "failed").length,
      missingEmail: inCampaign.filter(
        (m) => !hasSendableEmail(m.lead_email) && m.status !== "sent",
      ).length,
      all: inCampaign.length,
    };
  }, [inCampaign]);

  const tabCount = (value: string): number => {
    if (value === "pending_approval") return counts.pending;
    if (value === "approved") return counts.approved;
    if (value === "sent") return counts.sent;
    if (value === "cancelled,failed") return counts.rejected;
    if (value === "missing_email") return counts.missingEmail;
    return counts.all;
  };

  const filtered = useMemo(() => {
    if (tab === "missing_email") {
      return inCampaign.filter((m) => !hasSendableEmail(m.lead_email) && m.status !== "sent");
    }
    const allowed = tab === "all" ? null : new Set(tab.split(","));
    return inCampaign.filter((m) => {
      // An email without an address can never be sent: keep it out of the
      // approval queue so review time is never spent on it.
      if (!hasSendableEmail(m.lead_email) && m.status === "pending_approval") return false;
      if (allowed && !allowed.has(m.status)) return false;
      return true;
    });
  }, [inCampaign, tab]);

  const paged = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page],
  );

  const nextBatchIds = useMemo(
    () =>
      inCampaign
        .filter((m) => m.status === "pending_approval" && hasSendableEmail(m.lead_email))
        .slice(0, QUICK_REWRITE_BATCH)
        .map((m) => m.id),
    [inCampaign],
  );

  // Reopen the email that was being reviewed before the user navigated away.
  useEffect(() => {
    if (loading || review || drawerMode || !openEmailId) return;
    const row = rows.find((item) => item.id === openEmailId);
    if (!row) return;
    // Deferred one tick so restoring the drawer never cascades a render
    // inside the effect that observes freshly loaded messages.
    const timer = window.setTimeout(() => {
      const draft = readEmailDraft(row.id);
      setReview(row);
      setDrawerMode("review");
      setSubject(draft?.subject ?? row.subject ?? "");
      setBody(draft?.body ?? row.body ?? "");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loading, review, drawerMode, openEmailId, rows]);

  // Keep unsaved edits per email so leaving and returning never loses them.
  useEffect(() => {
    if (!review || drawerMode !== "review") return;
    const unchanged = subject === (review.subject ?? "") && body === (review.body ?? "");
    if (unchanged) return;
    writeEmailDraft(review.id, { subject, body });
  }, [review, drawerMode, subject, body]);

  const openReview = (message: MessageRow) => {
    const draft = readEmailDraft(message.id);
    setReview(message);
    setDrawerMode("review");
    setOpenEmailId(message.id);
    setSubject(draft?.subject ?? message.subject ?? "");
    setBody(draft?.body ?? message.body ?? "");
    setSubjectIdeas([]);
    setError(null);
  };

  const launchRewrite = (ids: string[]) => {
    if (ids.length === 0) return;
    setRewriteTrigger({
      scope: "selected",
      selectedIds: ids.slice(0, MAX_REWRITE_BATCH),
      nonce: Date.now(),
    });
    setDrawerMode("rewrite");
    setError(null);
  };

  const suggestSubject = async (message: MessageRow) => {
    if (!body.trim()) {
      setError("Write the email first — subjects come from what you actually say.");
      return;
    }
    setSubjectBusy(true);
    setError(null);
    try {
      const res = await authedPost<{ subjects: string[] }>("/api/ai/subject", {
        kind: message.kind,
        body: body.slice(0, 6000),
        originalSubject: message.subject ?? "",
        business: message.displayName,
      });
      setSubjectIdeas(res.subjects ?? []);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubjectBusy(false);
    }
  };

  /** Approve = save edits + mark approved, with a confirmed toast. */
  const approveMessage = async (message: MessageRow) => {
    setBusy(`approve:${message.id}`);
    setError(null);
    setNotice(null);
    try {
      await updateMessageContent(user.uid, message.id, { subject, body });
      clearEmailDraft(message.id);
      await updateMessageStatus(user.uid, message.id, "approved", {
        approved_at: new Date().toISOString(),
      });
      await updateLeadFields(user.uid, message.lead_id, { status: "approved" });
      toast.success("Approved & moved to Ready to Send", "Your edits are saved.");
      closeDrawer();
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  /** Approve a message whose content the rewrite workspace already saved. */
  const approveMessageById = async (messageId: string) => {
    const target = messages.find((m) => m.id === messageId);
    if (!target) throw new Error("Message not found.");
    await updateMessageStatus(user.uid, messageId, "approved", {
      approved_at: new Date().toISOString(),
    });
    await updateLeadFields(user.uid, target.lead_id, { status: "approved" });
    toast.success("Approved & moved to Ready to Send", "The rewritten email is saved.");
    closeDrawer();
    await reload();
  };

  const saveDraftOnly = async (message: MessageRow) => {
    setBusy(`save:${message.id}`);
    setError(null);
    try {
      await updateMessageContent(user.uid, message.id, { subject, body });
      clearEmailDraft(message.id);
      toast.success("Changes saved", "It stays under Awaiting approval.");
      setReview({ ...message, subject, body });
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const sendNow = async (message: MessageRow) => {
    setBusy(`send:${message.id}`);
    setError(null);
    setNotice(null);
    try {
      if (!workspaceToken) {
        const ok = await reconnectWorkspace();
        if (!ok) throw new Error("Connect Google before sending emails.");
      }
      await updateMessageContent(user.uid, message.id, { subject, body });
      clearEmailDraft(message.id);
      if (message.status !== "approved") {
        await updateMessageStatus(user.uid, message.id, "approved", {
          approved_at: new Date().toISOString(),
        });
        await updateLeadFields(user.uid, message.lead_id, { status: "approved" });
      }
      const result = await sendMessageNow(user.uid, message.id);
      setNotice(result.info);
      closeDrawer();
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const act = async (action: "approve_all" | "reject" | "regenerate", id?: string) => {
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

        if (action === "reject") {
          await updateMessageStatus(user.uid, id, "cancelled");
          toast.info("Rejected", "This email will never be sent.");
          closeDrawer();
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
          setNotice("Email rewritten.");
        }
      }
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  /** Remove one email record that will never be sent. */
  const removeMessage = async (message: MessageRow) => {
    const ok = await confirmDialog({
      title: "Delete this email?",
      message:
        "The email record is deleted from your account. The prospect stays in Leads, and nothing is sent.",
      confirmLabel: "Delete email",
      tone: "bad",
    });
    if (!ok) return;
    setBusy(`delete:${message.id}`);
    setError(null);
    try {
      await deleteMessage(user.uid, message.id);
      closeDrawer();
      await reload();
      toast.success("Email deleted", "It is gone from the review queue.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  /** Clear the whole rejected/failed pile in one confirmed action. */
  const removeRejected = async () => {
    const ids = rows
      .filter((m) => m.status === "cancelled" || m.status === "failed")
      .map((m) => m.id);
    if (ids.length === 0) return;
    const ok = await confirmDialog({
      title: `Delete ${ids.length} rejected and failed email${ids.length === 1 ? "" : "s"}?`,
      message:
        "These records are deleted from your account and their open history with them. Prospects stay in Leads, and nothing is sent. This cannot be undone.",
      confirmLabel: "Delete them",
      tone: "bad",
    });
    if (!ok) return;
    setBusy("delete_rejected");
    setError(null);
    setNotice(null);
    try {
      const removed = await deleteMessages(user.uid, ids);
      await reload();
      toast.success(
        "Rejected and failed emails deleted",
        `${removed} record${removed === 1 ? "" : "s"} removed from your account.`,
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const allOnPageSelected = paged.length > 0 && paged.every((m) => selectedIds.includes(m.id));

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Email review</h1>
          <p className="page-sub">
            Read, edit, and approve. Only approved emails can be sent, and only inside your sending
            window and limits.
          </p>
        </div>
        <div className="row-end" style={{ gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn btn-sm"
            disabled={selectedIds.length === 0}
            onClick={() => launchRewrite(selectedIds)}
            title={`Rewrite up to ${MAX_REWRITE_BATCH} selected emails with AI`}
          >
            <Sparkles size={13} aria-hidden="true" />
            Rewrite Selected ({Math.min(selectedIds.length, MAX_REWRITE_BATCH)})
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={nextBatchIds.length === 0}
            onClick={() => launchRewrite(nextBatchIds)}
            title={`Rewrite the next ${QUICK_REWRITE_BATCH} emails awaiting approval`}
          >
            <Sparkles size={13} aria-hidden="true" />
            Rewrite Next {QUICK_REWRITE_BATCH}
          </button>
        </div>
      </div>

      <div className="stack">
        {error && <Banner tone="bad">{error}</Banner>}
        {notice && <Banner tone="ok">{notice}</Banner>}

        <Card tight>
          <div style={{ padding: "12px 16px 0" }}>
            <div className="tabs">
              {TABS.map(([value, text]) => {
                const count = tabCount(value);
                return (
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
                    {value !== "all" && count > 0 ? ` (${count})` : ""}
                  </button>
                );
              })}
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
              {counts.rejected > 0 && (
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => void removeRejected()}
                  disabled={busy !== null}
                  type="button"
                  title="Delete every rejected and failed email record"
                >
                  <Trash2 size={12} aria-hidden="true" />
                  {busy === "delete_rejected"
                    ? "Deleting…"
                    : `Delete rejected & failed (${counts.rejected})`}
                </button>
              )}
              <BatchRunner
                type="send"
                label={`Send Approved (${counts.approved})`}
                limit={2}
                confirmText="Send every approved email now from your connected Gmail account? They go to real prospects."
                onDone={reload}
              />
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                title="Clear saved filters and close any open email"
                onClick={() => {
                  resetTab();
                  resetCampaign();
                  resetPage();
                  closeDrawer();
                }}
              >
                Clear / Reset
              </button>
              <span className="tiny row-end">{filtered.length} emails</span>
            </div>
          </div>

          {loading && messages.length === 0 ? (
            <div style={{ padding: 18 }}>
              <BrandLoader />
            </div>
          ) : paged.length === 0 ? (
            <div style={{ padding: 18 }}>
              <Empty title="Nothing in this view">
                {tab === "missing_email"
                  ? "Every email in this campaign has a deliverable address."
                  : "Generate emails from the Prospect research or Campaigns page once prospects are qualified."}
              </Empty>
            </div>
          ) : (
            <>
            <div className="m-feed mobile-only">
              {paged.map((message) => (
                <MobileFeedRow
                  key={message.id}
                  title={message.displayName}
                  subtitle={message.subject ?? "No subject yet"}
                  meta={`${hasSendableEmail(message.lead_email) ? message.lead_email : "no email"} · ${fmtDate(message.created_at)}`}
                  side={message.score ?? "—"}
                  status={label(message.status)}
                  statusTone={statusTone(message.status) as "ok" | "warn" | "bad" | "info"}
                  onClick={() => openReview(message)}
                />
              ))}
            </div>
            <div className="table-wrap desktop-only">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 32 }}>
                      <input
                        type="checkbox"
                        aria-label="Select page emails"
                        checked={allOnPageSelected}
                        onChange={(e) =>
                          setSelectedIds((prev) =>
                            e.target.checked
                              ? Array.from(new Set([...prev, ...paged.map((m) => m.id)]))
                              : prev.filter((id) => !paged.some((m) => m.id === id)),
                          )
                        }
                      />
                    </th>
                    <th>Prospect</th>
                    <th>Subject</th>
                    <th>Type</th>
                    <th>Score</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {paged.map((message) => (
                    <tr key={message.id} className="clickable" onClick={() => openReview(message)}>
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select email for ${message.displayName}`}
                          checked={selectedIds.includes(message.id)}
                          onChange={(e) =>
                            setSelectedIds((prev) =>
                              e.target.checked
                                ? [...prev, message.id]
                                : prev.filter((id) => id !== message.id),
                            )
                          }
                        />
                      </td>
                      <td>
                        <div className="strong">{message.displayName}</div>
                        <div className="tiny">
                          {hasSendableEmail(message.lead_email) ? message.lead_email : "no email"}
                        </div>
                      </td>
                      <td style={{ maxWidth: 320 }}>{message.subject ?? "—"}</td>
                      <td className="tiny">
                        {message.kind === "followup"
                          ? `Follow-up ${message.step}`
                          : message.kind === "reply"
                            ? "Your reply"
                            : "Initial"}
                      </td>
                      <td className="num">{message.score ?? "—"}</td>
                      <td>
                        <Badge tone={statusTone(message.status)}>{label(message.status)}</Badge>
                      </td>
                      <td className="tiny nowrap">{fmtDate(message.created_at)}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          title="View research & contact"
                          aria-label={`View research and contact for ${message.displayName}`}
                          onClick={() => {
                            const lead = leads.find((item) => item.id === message.lead_id);
                            if (lead) setResearchLead(lead);
                          }}
                        >
                          <Info size={12} aria-hidden="true" />
                        </button>
                        {message.status !== "sent" && message.status !== "sending" && (
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => launchRewrite([message.id])}
                          >
                            <Sparkles size={12} aria-hidden="true" />
                            Rewrite
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
          <div style={{ padding: "0 16px 14px" }}>
            <Pager page={page} pageSize={PAGE_SIZE} total={filtered.length} onPage={setPage} />
          </div>
        </Card>
      </div>

      {drawerMode && (
        <div
          onClick={closeDrawer}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(12, 20, 24, 0.42)",
            zIndex: 60,
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <aside
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Email review panel"
            className="review-drawer"
            style={{
              width: "min(760px, 100vw)",
              height: "100%",
              overflowY: "auto",
              background: "var(--surface)",
              borderLeft: "1px solid var(--line)",
              boxShadow: "-18px 0 40px rgba(0,0,0,0.14)",
              padding: "16px 18px 40px",
            }}
          >
            <div
              className="row"
              style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}
            >
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={closeDrawer}
                title="Back to the email list"
              >
                <ChevronLeft size={13} aria-hidden="true" />
                Back to Email List
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={closeDrawer}
                aria-label="Close review panel"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>

            {drawerMode === "rewrite" ? (
              <>
                <EmailRewriteWorkspace
                  selectedIds={selectedIds}
                  preflightTrigger={rewriteTrigger}
                  onAcceptedChanges={reload}
                  onApproveMessage={approveMessageById}
                />
              </>
            ) : review ? (
              <div className="stack" style={{ gap: 12 }}>
                <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <span className="strong" style={{ fontSize: 16 }}>
                    {review.displayName}
                  </span>
                  <Badge tone={statusTone(review.status)}>{label(review.status)}</Badge>
                  {review.service && <Badge tone="info">{review.service}</Badge>}
                  {review.angle && <Badge tone="gold">{review.angle}</Badge>}
                </div>

                <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
                  <div className="tiny">
                    <strong>To:</strong>{" "}
                    {hasSendableEmail(review.lead_email) ? review.lead_email : "no email address"}
                    {review.contact_name ? ` · ${review.contact_name}` : ""}
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      const lead = leads.find((item) => item.id === review.lead_id);
                      if (lead) setResearchLead(lead);
                      else setError("No research record is attached to this prospect.");
                    }}
                  >
                    <Info size={12} aria-hidden="true" />
                    View Research &amp; Contact
                  </button>
                </div>

                {!hasSendableEmail(review.lead_email) && (
                  <Banner tone="warn">
                    This prospect has no email address, so this draft cannot be sent. Find a contact
                    in Leads before approving it.
                  </Banner>
                )}

                <div className="field">
                  <span className="label">Subject</span>
                  <div className="row reply-subject-row">
                    <input
                      className="input"
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                    />
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => void suggestSubject(review)}
                      disabled={subjectBusy || busy !== null}
                      type="button"
                      title="Ask AI for subject lines based on this email"
                    >
                      <Sparkles size={12} aria-hidden="true" />
                      {subjectBusy ? "Thinking…" : "Suggest"}
                    </button>
                  </div>
                  {subjectIdeas.length > 0 && (
                    <div className="row refine-tones" style={{ marginTop: 6 }}>
                      {subjectIdeas.map((idea) => (
                        <button
                          key={idea}
                          className="btn btn-sm btn-ghost"
                          type="button"
                          title="Use this subject"
                          onClick={() => setSubject(idea)}
                        >
                          {idea}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <EmailBodyEditor value={body} onChange={setBody} minHeight={260} />

                {emailFooter.trim() && (
                  <div className="footer-preview">
                    <div className="tiny strong" style={{ marginBottom: 6 }}>
                      Email footer — added automatically when this is sent
                    </div>
                    <div dangerouslySetInnerHTML={{ __html: formatEmailHtml(emailFooter) }} />
                  </div>
                )}

                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => void approveMessage(review)}
                    disabled={busy !== null || !hasSendableEmail(review.lead_email)}
                    type="button"
                  >
                    {busy === `approve:${review.id}` ? (
                      <>
                        <Loader2 size={12} className="spin" aria-hidden="true" />
                        Approving…
                      </>
                    ) : (
                      <>
                        <Check size={12} aria-hidden="true" />
                        Approve &amp; Save
                      </>
                    )}
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => void saveDraftOnly(review)}
                    disabled={busy !== null}
                    type="button"
                  >
                    <Save size={12} aria-hidden="true" />
                    {busy === `save:${review.id}` ? "Saving…" : "Save Changes"}
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => void act("regenerate", review.id)}
                    disabled={busy !== null}
                    type="button"
                  >
                    {busy === "regenerate" ? "Rewriting…" : "Rewrite with AI"}
                  </button>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => void sendNow(review)}
                    disabled={busy !== null || !hasSendableEmail(review.lead_email)}
                    type="button"
                  >
                    {busy === `send:${review.id}` ? "Sending…" : "Send now"}
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => void act("reject", review.id)}
                    disabled={busy !== null}
                    type="button"
                  >
                    Reject
                  </button>
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={() => void removeMessage(review)}
                    disabled={busy !== null}
                    type="button"
                  >
                    <Trash2 size={12} aria-hidden="true" />
                    {busy === `delete:${review.id}` ? "Deleting…" : "Delete"}
                  </button>
                </div>

                {review.rationale && (
                  <details>
                    <summary className="tiny strong" style={{ cursor: "pointer" }}>
                      Why AI wrote this ▸
                    </summary>
                    <p className="tiny" style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>
                      {review.rationale}
                    </p>
                  </details>
                )}

                <details>
                  <summary className="tiny strong" style={{ cursor: "pointer" }}>
                    Compare with original ▸
                  </summary>
                  <div className="tiny" style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>
                    {review.body || "(no original body stored)"}
                  </div>
                </details>
              </div>
            ) : null}
          </aside>
        </div>
      )}

      {researchLead && (
        <LeadResearchModal lead={researchLead} onClose={() => setResearchLead(null)} />
      )}
    </main>
  );
}
