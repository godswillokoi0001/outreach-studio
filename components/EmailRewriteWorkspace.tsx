"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Edit3,
  History,
  Loader2,
  RefreshCw,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import type { BackgroundJobRecord } from "@/lib/background-jobs";
import { authedGet, authedPost, errorMessage } from "@/lib/client";
import {
  diffEmailText,
  rewriteStatusLabel,
  rewriteStatusTone,
  type EmailRewriteItem,
  type EmailRewriteWorkspaceState,
  type RewritePreflightSummary,
  type RewriteScope,
} from "@/lib/email-rewrite";
import { Badge, Banner, Card, Modal } from "./ui";
import { useToast } from "./Feedback";

interface EmailRewriteWorkspaceProps {
  selectedIds: string[];
  preflightTrigger?: { scope: RewriteScope; selectedIds?: string[]; nonce: number } | null;
  onAcceptedChanges: () => Promise<void> | void;
  /** Saves the accepted rewrite and moves the email to "Approved, ready to send". */
  onApproveMessage?: (messageId: string) => Promise<void> | void;
}

type StatusFilter = "all" | "rewritten" | "accepted" | "needs_attention" | "failed";

export function EmailRewriteWorkspace({
  selectedIds,
  preflightTrigger,
  onAcceptedChanges,
  onApproveMessage,
}: EmailRewriteWorkspaceProps) {
  const toast = useToast();

  const [workspace, setWorkspace] = useState<EmailRewriteWorkspaceState | null>(null);
  const [job, setJob] = useState<BackgroundJobRecord | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedRewriteIds, setSelectedRewriteIds] = useState<string[]>([]);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");
  const [regenInstruction, setRegenInstruction] = useState("");
  const [bulkRegenInstruction, setBulkRegenInstruction] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);

  // Preflight modal state
  const [preflightOpen, setPreflightOpen] = useState(false);
  const [preflightScope, setPreflightScope] = useState<RewriteScope>("all");
  const [preflightSelectedIds, setPreflightSelectedIds] = useState<string[]>([]);
  const [preflight, setPreflight] = useState<RewritePreflightSummary | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [startInstruction, setStartInstruction] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadState = useCallback(async () => {
    try {
      const res = await authedGet<{
        job: BackgroundJobRecord | null;
        workspace: EmailRewriteWorkspaceState;
      }>("/api/ai/review-rewrite");
      setJob(res.job);
      setWorkspace(res.workspace);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => void loadState(), 0);
    return () => window.clearTimeout(t);
  }, [loadState]);

  // Poll cleanly while job is running/queued (and survive tab switches / refreshes)
  useEffect(() => {
    if (!job || (job.status !== "running" && job.status !== "queued")) return;
    const t = window.setInterval(() => {
      void loadState();
    }, 2500);
    return () => window.clearInterval(t);
  }, [job, loadState]);

  // Open preflight modal whenever parent triggers it ("Rewrite all with AI" or per-row "Rewrite")
  const loadPreflight = useCallback(async (scope: RewriteScope, ids: string[]) => {
    setPreflightLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ preflight: "1", scope });
      if (ids.length > 0) qs.set("selected", ids.join(","));
      const res = await authedGet<{
        preflight: RewritePreflightSummary;
        workspace: EmailRewriteWorkspaceState;
        latestJob: BackgroundJobRecord | null;
      }>(`/api/ai/review-rewrite?${qs.toString()}`);
      setPreflight(res.preflight);
      setWorkspace(res.workspace);
      if (res.latestJob) setJob(res.latestJob);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPreflightLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!preflightTrigger) return;
    const ids = preflightTrigger.selectedIds ?? selectedIds;
    const t = window.setTimeout(() => {
      setPreflightScope(preflightTrigger.scope);
      setPreflightSelectedIds(ids);
      setStartInstruction("");
      setPreflightOpen(true);
      void loadPreflight(preflightTrigger.scope, ids);
    }, 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preflightTrigger?.nonce]);

  const items = useMemo(() => {
    const raw = Object.values(workspace?.itemsByMessageId ?? {});
    return raw.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [workspace]);

  const filteredItems = useMemo(() => {
    if (statusFilter === "all") return items;
    if (statusFilter === "failed") {
      return items.filter((it) => it.status === "failed" || it.status === "rejected");
    }
    return items.filter((it) => it.status === statusFilter);
  }, [items, statusFilter]);

  const activeItem: EmailRewriteItem | null = useMemo(() => {
    if (filteredItems.length === 0) return null;
    return filteredItems.find((it) => it.messageId === activeMessageId) ?? filteredItems[0];
  }, [filteredItems, activeMessageId]);

  const counts = useMemo(() => {
    const c = { rewritten: 0, accepted: 0, needs_attention: 0, failed: 0, pending: 0 };
    for (const it of items) {
      if (it.status === "rewritten") c.rewritten += 1;
      else if (it.status === "accepted") c.accepted += 1;
      else if (it.status === "needs_attention") c.needs_attention += 1;
      else if (it.status === "failed" || it.status === "rejected") c.failed += 1;
      else c.pending += 1;
    }
    return c;
  }, [items]);

  const startRewrite = async (opts?: { retryFailedOnly?: boolean }) => {
    setBusyAction(opts?.retryFailedOnly ? "retry" : "start");
    setError(null);
    try {
      const res = await authedPost<{
        job: BackgroundJobRecord;
        workspace: EmailRewriteWorkspaceState;
        reused: boolean;
      }>("/api/ai/review-rewrite", {
        scope: preflightScope,
        selectedIds: preflightSelectedIds,
        retryFailedOnly: Boolean(opts?.retryFailedOnly),
        instruction: startInstruction.trim() || undefined,
      });
      setJob(res.job);
      setWorkspace(res.workspace);
      setPreflightOpen(false);
      toast.success(
        opts?.retryFailedOnly ? "Retrying remaining emails" : "AI Rewrite started",
        "You can stay or leave this page — progress is saved automatically.",
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyAction(null);
    }
  };

  const runItemAction = async (
    action: "accept" | "accept_all_passed" | "edit" | "reject" | "regenerate" | "restore_version",
    payload?: {
      messageId?: string;
      subject?: string;
      body?: string;
      instruction?: string;
      versionId?: string;
    },
  ): Promise<boolean> => {
    setBusyAction(`${action}:${payload?.messageId ?? "bulk"}`);
    setError(null);
    try {
      const res = await authedPost<{ workspace: EmailRewriteWorkspaceState; updatedCount: number }>(
        "/api/ai/review-rewrite/action",
        { action, ...payload },
      );
      setWorkspace(res.workspace);
      if (action === "accept" || action === "accept_all_passed" || action === "restore_version") {
        await onAcceptedChanges();
      }
      if (action === "accept_all_passed") {
        toast.success("Accepted passed rewrites", `${res.updatedCount} email(s) updated in review queue.`);
      } else if (action === "accept") {
        toast.success("Rewrite accepted", "Original preserved in version history.");
      } else if (action === "reject") {
        toast.info("Kept original", "Rewritten draft rejected without altering original.");
      } else if (action === "edit") {
        setEditing(false);
        toast.success("Edited rewrite saved");
      } else if (action === "regenerate") {
        toast.success("Email regenerated");
      } else if (action === "restore_version") {
        setHistoryOpen(false);
        toast.success("Version restored");
      }
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusyAction(null);
    }
  };

  const regenerateSelectedBulk = async () => {
    if (selectedRewriteIds.length === 0) return;
    setBusyAction("regen_bulk");
    setError(null);
    try {
      for (const msgId of selectedRewriteIds) {
        const res = await authedPost<{ workspace: EmailRewriteWorkspaceState }>(
          "/api/ai/review-rewrite/action",
          {
            action: "regenerate",
            messageId: msgId,
            instruction: bulkRegenInstruction.trim() || undefined,
          },
        );
        setWorkspace(res.workspace);
      }
      setSelectedRewriteIds([]);
      setBulkRegenInstruction("");
      toast.success("Regenerated selected emails");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyAction(null);
    }
  };

  const activeRunning = job && (job.status === "running" || job.status === "queued");
  const showPanel = Boolean(activeRunning || items.length > 0 || workspace?.pausedForQuota);

  /**
   * "Accept" used to leave the user unsure whether anything was saved. These
   * two explicit actions either save + approve (moves to Ready to Send) or save
   * the rewrite and keep it awaiting approval.
   */
  const acceptRewrite = async (opts: { approve: boolean }) => {
    if (!activeItem) return;
    const ok = await runItemAction("accept", {
      messageId: activeItem.messageId,
      subject: editing ? editSubject : activeItem.rewrittenSubject,
      body: editing ? editBody : activeItem.rewrittenBody,
    });
    if (!ok) return;
    setEditing(false);
    if (!opts.approve) {
      toast.success("Saved as draft", "It stays under Awaiting approval.");
      return;
    }
    if (onApproveMessage) {
      await onApproveMessage(activeItem.messageId);
    } else {
      toast.success("Rewrite saved");
    }
  };

  return (
    <>
      {error && (
        <div style={{ marginBottom: 12 }}>
          <Banner tone="bad">{error}</Banner>
        </div>
      )}

      {showPanel && (
        <Card
          title="AI Rewrite Studio"
          sub="Every rewrite is grounded strictly in your Knowledge Base and verified lead research. Originals stay untouched until you accept."
          actions={
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              {counts.rewritten > 0 && (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busyAction !== null || Boolean(activeRunning)}
                  onClick={() => void runItemAction("accept_all_passed")}
                >
                  <Check size={13} />
                  {busyAction === "accept_all_passed:bulk"
                    ? "Accepting…"
                    : `Accept all passed (${counts.rewritten})`}
                </button>
              )}
              {(counts.failed > 0 || counts.needs_attention > 0 || counts.pending > 0) && !activeRunning && (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busyAction !== null}
                  onClick={() => void startRewrite({ retryFailedOnly: true })}
                >
                  <RotateCcw size={12} />
                  {busyAction === "retry" ? "Retrying…" : "Retry failed / pending only"}
                </button>
              )}
            </div>
          }
        >
          {/* Live Job Progress Bar */}
          {activeRunning && job && (
            <div
              style={{
                padding: 12,
                borderRadius: 10,
                background: "var(--surface-2)",
                border: "1px solid var(--line)",
                marginBottom: 14,
              }}
            >
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
                <div className="row" style={{ gap: 8 }}>
                  <Loader2 size={15} className="spin" />
                  <span className="strong" style={{ fontSize: 13 }}>
                    {job.currentStep || "Running AI Rewrite…"}
                  </span>
                </div>
                <span className="tiny muted">
                  {job.progressPct}% ·{" "}
                  {job.estimatedSecondsRemaining > 0
                    ? `~${job.estimatedSecondsRemaining}s remaining`
                    : "finishing…"}
                </span>
              </div>
              <div
                style={{
                  height: 8,
                  borderRadius: 99,
                  background: "var(--line)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${Math.max(5, job.progressPct)}%`,
                    height: "100%",
                    background: "var(--teal, #20ccc8)",
                    transition: "width 0.3s ease",
                  }}
                />
              </div>
              <div className="tiny muted" style={{ marginTop: 6 }}>
                Running reliably in the background — you can leave this tab and return anytime.
              </div>
            </div>
          )}

          {/* Quota Pause Banner */}
          {workspace?.pausedForQuota && workspace.pausedMessage && (
            <div style={{ marginBottom: 12 }}>
              <Banner tone="warn">{workspace.pausedMessage}</Banner>
            </div>
          )}

          {/* Summary Bar + Cross-Lead Patterns + KB Gaps */}
          {items.length > 0 && !activeRunning && (
            <div className="grid grid-2" style={{ gap: 12, marginBottom: 14 }}>
              <div
                style={{
                  padding: 12,
                  borderRadius: 10,
                  background: "var(--surface-2)",
                  border: "1px solid var(--line)",
                }}
              >
                <div className="strong" style={{ fontSize: 12.5, marginBottom: 6 }}>
                  Cross-lead pattern analysis
                </div>
                <div className="tiny muted" style={{ marginBottom: 8 }}>
                  {workspace?.crossLeadSummary?.label ??
                    "Recommendations based on lead profiles and your Knowledge Base (never a guarantee of reply rate)."}
                </div>
                {workspace?.crossLeadSummary?.patterns.map((p, idx) => (
                  <div key={idx} className="tiny" style={{ marginBottom: 6 }}>
                    <strong>{p.segment}:</strong> {p.pattern} — <span className="muted">{p.explanation}</span>
                  </div>
                ))}
              </div>

              <div
                style={{
                  padding: 12,
                  borderRadius: 10,
                  background: "var(--surface-2)",
                  border: "1px solid var(--line)",
                }}
              >
                <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
                  <span className="strong" style={{ fontSize: 12.5 }}>
                    Knowledge Base gaps detected ({workspace?.kbGaps.length ?? 0})
                  </span>
                  <Link href="/knowledge" className="tiny" style={{ textDecoration: "underline" }}>
                    Update Knowledge Base
                  </Link>
                </div>
                {!workspace?.kbGaps.length ? (
                  <div className="tiny" style={{ color: "var(--ok)" }}>
                    All core Knowledge Base sections (including sample emails & proof) are present.
                  </div>
                ) : (
                  <ul className="tiny" style={{ paddingLeft: 16, margin: 0 }}>
                    {workspace.kbGaps.slice(0, 4).map((g) => (
                      <li key={g.key} style={{ marginBottom: 4 }}>
                        <strong>{g.label}:</strong> <span className="muted">{g.promptToFill}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {/* Status Filters & Bulk Actions */}
          {items.length > 0 && (
            <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
              {(
                [
                  ["all", `All (${items.length})`],
                  ["rewritten", `Rewritten (${counts.rewritten})`],
                  ["accepted", `Accepted (${counts.accepted})`],
                  ["needs_attention", `Needs attention (${counts.needs_attention})`],
                  ["failed", `Failed / Rejected (${counts.failed})`],
                ] as [StatusFilter, string][]
              ).map(([key, txt]) => (
                <button
                  key={key}
                  type="button"
                  className={`btn btn-sm ${statusFilter === key ? "btn-primary" : "btn-ghost"}`}
                  onClick={() => setStatusFilter(key)}
                >
                  {txt}
                </button>
              ))}

              {selectedRewriteIds.length > 0 && (
                <div className="row" style={{ gap: 6, marginLeft: "auto", flexWrap: "wrap" }}>
                  <input
                    className="input"
                    style={{ width: 180, height: 30, fontSize: 12 }}
                    placeholder="Optional note (e.g. shorter)"
                    value={bulkRegenInstruction}
                    onChange={(e) => setBulkRegenInstruction(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busyAction !== null}
                    onClick={() => void regenerateSelectedBulk()}
                  >
                    <RefreshCw size={12} />
                    {busyAction === "regen_bulk"
                      ? "Regenerating…"
                      : `Regenerate selected (${selectedRewriteIds.length})`}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Master-Detail Side-by-Side Comparison Workspace */}
          {filteredItems.length > 0 && (
            <div className="rewrite-layout">
              {/* Left List of Emails */}
              <div className="stack" style={{ gap: 6, maxHeight: "65vh", overflowY: "auto" }}>
                {filteredItems.map((it) => {
                  const selected = it.messageId === activeItem?.messageId;
                  const checked = selectedRewriteIds.includes(it.messageId);
                  return (
                    <div
                      key={it.messageId}
                      onClick={() => {
                        setActiveMessageId(it.messageId);
                        setEditing(false);
                        setRegenInstruction("");
                      }}
                      style={{
                        padding: 10,
                        borderRadius: 10,
                        cursor: "pointer",
                        border: `1.5px solid ${selected ? "var(--teal, #20ccc8)" : "var(--line)"}`,
                        background: selected ? "var(--accent-soft)" : "var(--surface)",
                      }}
                    >
                      <div className="row" style={{ justifyContent: "space-between", gap: 6 }}>
                        <label
                          className="row"
                          style={{ gap: 6, flex: 1, minWidth: 0, cursor: "pointer" }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) =>
                              setSelectedRewriteIds((prev) =>
                                e.target.checked
                                  ? [...prev, it.messageId]
                                  : prev.filter((id) => id !== it.messageId),
                              )
                            }
                          />
                          <span className="strong tiny" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {it.business}
                          </span>
                        </label>
                        <Badge tone={rewriteStatusTone(it.status)}>{rewriteStatusLabel(it.status)}</Badge>
                      </div>
                      <div className="tiny muted" style={{ marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {it.rewrittenSubject || it.originalSubject || "(no subject)"}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Right Side-by-Side Diff + Analysis + Controls */}
              {activeItem && (
                <div className="stack" style={{ gap: 12 }}>
                  {/* Header + Per-Email Action Bar */}
                  <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <span className="strong">{activeItem.business}</span>
                      <Badge tone={rewriteStatusTone(activeItem.status)}>
                        {rewriteStatusLabel(activeItem.status)}
                      </Badge>
                      {activeItem.analysis?.chosenPattern.framework && (
                        <Badge tone="info">{activeItem.analysis.chosenPattern.framework}</Badge>
                      )}
                    </div>
                    <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => setShowDiff((p) => !p)}
                      >
                        {showDiff ? "Plain view" : "Highlight diff"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => setHistoryOpen(true)}
                      >
                        <History size={12} />
                        History ({activeItem.versions.length})
                      </button>
                      {!editing ? (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => {
                            setEditSubject(activeItem.rewrittenSubject);
                            setEditBody(activeItem.rewrittenBody);
                            setEditing(true);
                          }}
                        >
                          <Edit3 size={12} />
                          Edit
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          disabled={busyAction !== null}
                          onClick={() =>
                            void runItemAction("edit", {
                              messageId: activeItem.messageId,
                              subject: editSubject,
                              body: editBody,
                            })
                          }
                        >
                          Save edit
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={
                          busyAction !== null ||
                          activeItem.status === "pending" ||
                          (activeItem.status === "needs_attention" && !activeItem.check?.passed)
                        }
                        onClick={() => void acceptRewrite({ approve: true })}
                        title="Saves the rewrite and moves it to Approved, ready to send"
                      >
                        <Check size={12} />
                        {busyAction === `accept:${activeItem.messageId}`
                          ? "Saving…"
                          : "Save & Approve (Ready to Send)"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={
                          busyAction !== null ||
                          activeItem.status === "pending" ||
                          (activeItem.status === "needs_attention" && !activeItem.check?.passed)
                        }
                        onClick={() => void acceptRewrite({ approve: false })}
                        title="Saves the rewrite and keeps it in Awaiting approval"
                      >
                        Save Draft Only
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        disabled={busyAction !== null}
                        onClick={() =>
                          void runItemAction("reject", { messageId: activeItem.messageId })
                        }
                      >
                        <X size={12} />
                        Reject (keep original)
                      </button>
                    </div>
                  </div>

                  {/* Needs attention / Failed Banner */}
                  {activeItem.statusReason && (
                    <Banner tone={activeItem.status === "needs_attention" ? "warn" : "bad"}>
                      <strong>{rewriteStatusLabel(activeItem.status)}:</strong> {activeItem.statusReason}
                    </Banner>
                  )}

                  {/* Regenerate with optional instruction */}
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    <input
                      className="input"
                      style={{ flex: 1, minWidth: 200, height: 32, fontSize: 12.5 }}
                      placeholder="Optional regenerate instruction (e.g. shorter, more formal, mention local audit)…"
                      value={regenInstruction}
                      onChange={(e) => setRegenInstruction(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busyAction !== null}
                      onClick={() =>
                        void runItemAction("regenerate", {
                          messageId: activeItem.messageId,
                          instruction: regenInstruction.trim() || undefined,
                        })
                      }
                    >
                      <RefreshCw size={12} />
                      {busyAction === `regenerate:${activeItem.messageId}` ? "Regenerating…" : "Regenerate"}
                    </button>
                  </div>

                  {/* Rewritten email, with the original diff tucked away */}
                  <div className="grid grid-2" style={{ gap: 12 }}>
                    <div
                      style={{
                        padding: 12,
                        borderRadius: 10,
                        border: "1px solid var(--line)",
                        background: "var(--surface-2)",
                      }}
                    >
                      <div className="tiny strong muted" style={{ marginBottom: 6 }}>
                        ORIGINAL (preserved until accepted)
                      </div>
                      <div className="strong" style={{ fontSize: 13, marginBottom: 8 }}>
                        {activeItem.originalSubject || "(no subject)"}
                      </div>
                      <div className="tiny" style={{ whiteSpace: "pre-wrap", lineHeight: 1.55 }}>
                        {showDiff ? (
                          diffEmailText(activeItem.originalBody, activeItem.rewrittenBody).map((tok, i) =>
                            tok.type === "add" ? null : (
                              <span
                                key={i}
                                style={
                                  tok.type === "remove"
                                    ? {
                                        background: "var(--bad-soft)",
                                        color: "var(--bad)",
                                        textDecoration: "line-through",
                                      }
                                    : undefined
                                }
                              >
                                {tok.text}
                              </span>
                            ),
                          )
                        ) : (
                          activeItem.originalBody
                        )}
                      </div>
                    </div>

                    <div
                      style={{
                        padding: 12,
                        borderRadius: 10,
                        border: "1px solid var(--teal, #20ccc8)",
                        background: "var(--surface)",
                      }}
                    >
                      <div className="tiny strong" style={{ color: "var(--teal-ink, var(--teal-deep))", marginBottom: 6 }}>
                        AI REWRITE
                      </div>

                      {activeItem.subjectOptions.length > 0 && !editing && (
                        <div className="row" style={{ gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
                          <span className="tiny muted">Subject options:</span>
                          {activeItem.subjectOptions.map((opt) => (
                            <button
                              key={opt}
                              type="button"
                              className={`btn btn-sm ${opt === activeItem.rewrittenSubject ? "btn-primary" : "btn-ghost"}`}
                              style={{ padding: "2px 7px", fontSize: 11.5 }}
                              onClick={() =>
                                void runItemAction("edit", {
                                  messageId: activeItem.messageId,
                                  subject: opt,
                                  body: activeItem.rewrittenBody,
                                })
                              }
                            >
                              {opt}
                            </button>
                          ))}
                        </div>
                      )}

                      {editing ? (
                        <div className="stack" style={{ gap: 8 }}>
                          <input
                            className="input"
                            value={editSubject}
                            onChange={(e) => setEditSubject(e.target.value)}
                          />
                          <textarea
                            className="textarea"
                            style={{ minHeight: 190 }}
                            value={editBody}
                            onChange={(e) => setEditBody(e.target.value)}
                          />
                        </div>
                      ) : (
                        <>
                          <div className="strong" style={{ fontSize: 13, marginBottom: 8 }}>
                            {activeItem.rewrittenSubject || "(no subject)"}
                          </div>
                          <div className="tiny" style={{ whiteSpace: "pre-wrap", lineHeight: 1.55 }}>
                            {showDiff ? (
                              diffEmailText(activeItem.originalBody, activeItem.rewrittenBody).map((tok, i) =>
                                tok.type === "remove" ? null : (
                                  <span
                                    key={i}
                                    style={
                                      tok.type === "add"
                                        ? {
                                            background: "var(--ok-soft)",
                                            color: "var(--ok)",
                                            fontWeight: 500,
                                          }
                                        : undefined
                                    }
                                  >
                                    {tok.text}
                                  </span>
                                ),
                              )
                            ) : (
                              activeItem.rewrittenBody
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Self-Check Audit Badges */}
                  {activeItem.check && (
                    <div
                      style={{
                        padding: 10,
                        borderRadius: 10,
                        background: "var(--surface-2)",
                        border: "1px solid var(--line)",
                      }}
                    >
                      <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                        <span className="tiny strong">
                          Self-check ({activeItem.check.attempts} attempt{activeItem.check.attempts === 1 ? "" : "s"}):
                        </span>
                        <Badge tone={activeItem.check.criteria.kbGroundedOnly ? "ok" : "bad"}>
                          {activeItem.check.criteria.kbGroundedOnly ? "✓" : "✕"} KB & Research Grounded
                        </Badge>
                        <Badge tone={activeItem.check.criteria.noPlaceholdersOrWrongNames ? "ok" : "bad"}>
                          {activeItem.check.criteria.noPlaceholdersOrWrongNames ? "✓" : "✕"} Names & No Placeholders
                        </Badge>
                        <Badge tone={activeItem.check.criteria.matchesBrandVoice ? "ok" : "bad"}>
                          {activeItem.check.criteria.matchesBrandVoice ? "✓" : "✕"} Brand Voice
                        </Badge>
                        <Badge tone={activeItem.check.criteria.clearCtaAndLengthFit ? "ok" : "bad"}>
                          {activeItem.check.criteria.clearCtaAndLengthFit ? "✓" : "✕"} CTA & Length
                        </Badge>
                        <Badge tone={activeItem.check.criteria.compliancePresent ? "ok" : "bad"}>
                          {activeItem.check.criteria.compliancePresent ? "✓" : "✕"} Compliance
                        </Badge>
                      </div>
                    </div>
                  )}

                  {/* Lead-by-Lead Analysis & Chosen Pattern Reasoning */}
                  {activeItem.analysis && (
                    <div
                      style={{
                        padding: 12,
                        borderRadius: 10,
                        background: "var(--surface-2)",
                        border: "1px solid var(--line)",
                      }}
                    >
                      <div className="strong" style={{ fontSize: 12.5, marginBottom: 8 }}>
                        Lead analysis & why this pattern was chosen
                      </div>
                      <div className="grid grid-2" style={{ gap: 10 }}>
                        <div className="stack tiny" style={{ gap: 4 }}>
                          <div>
                            <strong>Who they are:</strong> {activeItem.analysis.whoTheyAre.decisionMaker} (
                            {activeItem.analysis.whoTheyAre.role}, {activeItem.analysis.whoTheyAre.seniority}) ·{" "}
                            {activeItem.analysis.whoTheyAre.industry} · {activeItem.analysis.whoTheyAre.location}
                          </div>
                          <div>
                            <strong>Qualification & triggers:</strong> Score{" "}
                            {activeItem.analysis.qualificationSummary.score ?? "—"} (
                            {activeItem.analysis.qualificationSummary.tier}) ·{" "}
                            {activeItem.analysis.qualificationSummary.buyingIntentSignals.join(", ") || "No signals recorded"}
                          </div>
                          <div>
                            <strong>Past engagement:</strong> {activeItem.analysis.pastEngagement.summary}
                          </div>
                          <div>
                            <strong>Verified hooks:</strong>{" "}
                            {activeItem.analysis.verifiedHooks.length > 0
                              ? activeItem.analysis.verifiedHooks.map((h) => `${h.hook} [${h.source}]`).join("; ")
                              : "None verified — no hooks guessed."}
                          </div>
                        </div>

                        <div className="stack tiny" style={{ gap: 4 }}>
                          <div>
                            <strong>Framework:</strong> {activeItem.analysis.chosenPattern.framework} —{" "}
                            <span className="muted">{activeItem.analysis.chosenPattern.frameworkReason}</span>
                          </div>
                          <div>
                            <strong>Tone & structure:</strong> {activeItem.analysis.chosenPattern.toneAndFormality} ·{" "}
                            {activeItem.analysis.chosenPattern.lengthAndStructure} —{" "}
                            <span className="muted">{activeItem.analysis.chosenPattern.toneReason}</span>
                          </div>
                          <div>
                            <strong>CTA & follow-up:</strong> {activeItem.analysis.chosenPattern.ctaStyle} ·{" "}
                            {activeItem.analysis.chosenPattern.followUpTiming} —{" "}
                            <span className="muted">{activeItem.analysis.chosenPattern.ctaReason}</span>
                          </div>
                          <div>
                            <strong>Summary reason:</strong> {activeItem.analysis.chosenPattern.overallReason}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {/* Pre-Flight Scope & Knowledge Summary Confirmation Modal */}
      <Modal
        open={preflightOpen}
        onClose={() => setPreflightOpen(false)}
        title="Rewrite emails with AI"
        large
      >
        <div className="stack" style={{ gap: 12 }}>
          <div>
            <div className="label" style={{ marginBottom: 6 }}>Choose which emails to rewrite</div>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              {(
                [
                  ["all", "All emails (recommended default)"],
                  ["selected", `Only selected (${preflightSelectedIds.length})`],
                  ["unapproved", "Only not yet approved"],
                ] as [RewriteScope, string][]
              ).map(([val, txt]) => (
                <button
                  key={val}
                  type="button"
                  disabled={val === "selected" && preflightSelectedIds.length === 0}
                  className={`btn btn-sm ${preflightScope === val ? "btn-primary" : ""}`}
                  onClick={() => {
                    setPreflightScope(val);
                    void loadPreflight(val, preflightSelectedIds);
                  }}
                >
                  {txt}
                </button>
              ))}
            </div>
          </div>

          {preflightLoading && !preflight ? (
            <div className="row" style={{ gap: 8 }}>
              <Loader2 size={15} className="spin" />
              <span className="tiny">Checking Knowledge Base & emails in scope…</span>
            </div>
          ) : preflight ? (
            <>
              <Banner tone={preflight.inScopeEmails > 0 ? "info" : "warn"}>
                <strong>
                  {preflight.inScopeEmails} email{preflight.inScopeEmails === 1 ? "" : "s"}
                </strong>{" "}
                across <strong>{preflight.uniqueLeadsCount}</strong> unique lead
                {preflight.uniqueLeadsCount === 1 ? "" : "s"} will be analysed, rewritten, and self-checked. Nothing
                is sent automatically, and originals are preserved until you accept.
              </Banner>

              <div>
                <div className="label" style={{ marginBottom: 6 }}>
                  Knowledge Base sections used (source of truth)
                </div>
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  {preflight.sectionsUsed.map((sec) => (
                    <Badge key={sec.key} tone={sec.present ? "ok" : "warn"}>
                      {sec.present ? (
                        <CheckCircle2 size={11} style={{ marginRight: 4 }} />
                      ) : (
                        <AlertTriangle size={11} style={{ marginRight: 4 }} />
                      )}
                      {sec.label}
                    </Badge>
                  ))}
                </div>
              </div>

              {preflight.gaps.length > 0 && (
                <Banner tone="warn">
                  <div className="stack" style={{ gap: 4 }}>
                    <div className="strong">
                      {preflight.gaps.length} Knowledge Base gap{preflight.gaps.length === 1 ? "" : "s"} found (AI will not guess missing facts):
                    </div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {preflight.gaps.map((g) => (
                        <li key={g.key} className="tiny">
                          <strong>{g.label}</strong> — {g.promptToFill}
                        </li>
                      ))}
                    </ul>
                  </div>
                </Banner>
              )}
            </>
          ) : null}

          <div>
            <div className="label" style={{ marginBottom: 6 }}>Optional guidance for this run</div>
            <input
              className="input"
              placeholder="e.g. Keep under 75 words, lean into proof points when available"
              value={startInstruction}
              onChange={(e) => setStartInstruction(e.target.value)}
            />
          </div>

          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="btn btn-sm" onClick={() => setPreflightOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busyAction === "start" || !preflight || preflight.inScopeEmails === 0}
              onClick={() => void startRewrite()}
            >
              <Sparkles size={13} />
              {busyAction === "start"
                ? "Starting background job…"
                : `Confirm & rewrite ${preflight?.inScopeEmails ?? 0} email(s)`}
            </button>
          </div>
        </div>
      </Modal>

      {/* Version History Modal */}
      <Modal
        open={historyOpen && Boolean(activeItem)}
        onClose={() => setHistoryOpen(false)}
        title={`Version history — ${activeItem?.business ?? ""}`}
        large
      >
        {activeItem && (
          <div className="stack" style={{ gap: 10, maxHeight: "65vh", overflowY: "auto" }}>
            {activeItem.versions
              .slice()
              .reverse()
              .map((v) => (
                <div
                  key={v.versionId}
                  style={{
                    padding: 12,
                    borderRadius: 10,
                    border: "1px solid var(--line)",
                    background: "var(--surface-2)",
                  }}
                >
                  <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
                    <div className="row" style={{ gap: 6 }}>
                      <Badge tone={v.source === "original" ? undefined : "info"}>{v.source.replace(/_/g, " ")}</Badge>
                      <span className="tiny muted">{new Date(v.createdAt).toLocaleString()}</span>
                      {v.instruction && <span className="tiny">Instruction: &ldquo;{v.instruction}&rdquo;</span>}
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busyAction !== null}
                      onClick={() =>
                        void runItemAction("restore_version", {
                          messageId: activeItem.messageId,
                          versionId: v.versionId,
                        })
                      }
                    >
                      Restore this version
                    </button>
                  </div>
                  <div className="strong tiny" style={{ marginBottom: 4 }}>{v.subject}</div>
                  <div className="tiny" style={{ whiteSpace: "pre-wrap" }}>{v.body}</div>
                </div>
              ))}
          </div>
        )}
      </Modal>
    </>
  );
}
