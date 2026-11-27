"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bot,
  CheckCircle2,
  History,
  Loader2,
  Plus,
  Send,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import { formatResponseTime } from "@/lib/format";
import type { AdminChatConversation, AdminChatMessage } from "@/lib/platform/admin-chat";
import type { AgentContent, AgentFunctionCall } from "@/lib/agent-meta";
import { Badge, Banner } from "../ui";
import { useToast } from "../Feedback";
import { adminFetch } from "./admin-client";

interface PendingActionState {
  assistantMsgId: string;
  modelContent: AgentContent;
  baseHistory: AgentContent[];
  priorResponses: { id?: string; name: string; response: Record<string, unknown> }[];
  gatedCalls: AgentFunctionCall[];
}

export function AdminAssistantDrawer({
  open,
  initialPrompt,
  onClearInitialPrompt,
  onClose,
}: {
  open: boolean;
  initialPrompt?: string | null;
  onClearInitialPrompt?: () => void;
  onClose: () => void;
}) {
  const toast = useToast();

  const [conversations, setConversations] = useState<AdminChatConversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<"chat" | "history">("chat");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingActionState | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const loadConversations = useCallback(async () => {
    try {
      const res = await adminFetch<{ conversations: AdminChatConversation[] }>("/api/admin/chat");
      const list = res.conversations ?? [];
      setConversations(list);
      if (list.length > 0 && !activeId) {
        setActiveId(list[0]!.id);
      }
    } catch {
      /* ignore silent load */
    }
  }, [activeId]);

  useEffect(() => {
    if (!open) return undefined;
    const t = window.setTimeout(() => {
      void loadConversations();
    }, 0);
    return () => window.clearTimeout(t);
  }, [open, loadConversations]);

  useEffect(() => {
    if (!open || !initialPrompt) return undefined;
    const t = window.setTimeout(() => {
      setView("chat");
      setInput(initialPrompt);
      onClearInitialPrompt?.();
    }, 0);
    return () => window.clearTimeout(t);
  }, [open, initialPrompt, onClearInitialPrompt]);

  const activeConv = conversations.find((c) => c.id === activeId) ?? null;

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [open, activeConv?.messages.length, pendingAction]);

  const sendMessage = async (textOverride?: string) => {
    const text = (textOverride ?? input).trim();
    if (!text || busy || pendingAction) return;
    setBusy(true);
    setError(null);
    setInput("");
    try {
      const res = await adminFetch<{
        conversation: AdminChatConversation;
        conversations: AdminChatConversation[];
        pendingAction: PendingActionState | null;
      }>("/api/admin/chat", {
        method: "POST",
        body: {
          action: "send",
          conversationId: activeConv?.id,
          message: text,
        },
      });
      setConversations(res.conversations ?? [res.conversation]);
      setActiveId(res.conversation.id);
      setPendingAction(res.pendingAction ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reach Admin AI Assistant.");
      setInput(text);
    } finally {
      setBusy(false);
    }
  };

  const resolvePendingAction = async (approved: boolean) => {
    if (!pendingAction || !activeConv || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await adminFetch<{
        conversation: AdminChatConversation;
        conversations: AdminChatConversation[];
        pendingAction: PendingActionState | null;
      }>("/api/admin/chat", {
        method: "POST",
        body: {
          action: "confirm_action",
          conversationId: activeConv.id,
          approved,
          pendingAction,
        },
      });
      setConversations(res.conversations ?? [res.conversation]);
      setPendingAction(res.pendingAction ?? null);
      if (approved) toast.success("Admin action executed & logged");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to complete action.");
    } finally {
      setBusy(false);
    }
  };

  const clearHistory = async () => {
    try {
      await adminFetch("/api/admin/chat", {
        method: "POST",
        body: { action: "clear_history" },
      });
      setConversations([]);
      setActiveId(null);
      setPendingAction(null);
      toast.success("Admin assistant history cleared");
    } catch (err) {
      toast.error("Failed", err instanceof Error ? err.message : "Error");
    }
  };

  if (!open) return null;

  return (
    <aside
      aria-label="Platform Admin AI Assistant"
      style={{
        position: "fixed",
        top: 56,
        right: 0,
        bottom: 0,
        width: "min(430px, 100vw)",
        background: "var(--surface)",
        borderLeft: "1px solid var(--line)",
        boxShadow: "-8px 0 32px rgba(15, 23, 42, 0.14)",
        zIndex: 60,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header — intentionally ZERO model switcher per requirements */}
      <div
        className="row"
        style={{
          justifyContent: "space-between",
          alignItems: "center",
          padding: "12px 14px",
          borderBottom: "1px solid var(--line)",
          background: "var(--surface-2)",
        }}
      >
        <div className="row" style={{ gap: 8 }}>
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 9,
              background: "var(--accent)",
              color: "#fff",
              display: "grid",
              placeItems: "center",
            }}
          >
            <Bot size={16} />
          </div>
          <div>
            <div className="strong" style={{ fontSize: 13.5 }}>
              Admin AI Debug Assistant
            </div>
            <div className="tiny muted">Admin-only · Platform routing · Audit-logged</div>
          </div>
        </div>

        <div className="row" style={{ gap: 4 }}>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            title="New diagnostic session"
            onClick={() => {
              setActiveId(null);
              setPendingAction(null);
              setView("chat");
            }}
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            title="Saved sessions"
            onClick={() => setView((v) => (v === "history" ? "chat" : "history"))}
          >
            <History size={14} />
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            title="Close assistant"
            aria-label="Close AI Assistant"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 14 }} className="stack">
        {error && <Banner tone="bad">{error}</Banner>}

        {view === "history" ? (
          <div className="stack" style={{ gap: 8 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="strong tiny">Your Admin Sessions ({conversations.length})</span>
              {conversations.length > 0 && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => void clearHistory()}
                >
                  <Trash2 size={12} /> Clear All
                </button>
              )}
            </div>
            {conversations.length === 0 ? (
              <div className="tiny muted">No saved admin debugging sessions yet.</div>
            ) : (
              conversations.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    setActiveId(c.id);
                    setView("chat");
                  }}
                  style={{
                    textAlign: "left",
                    padding: 10,
                    borderRadius: 8,
                    border: `1px solid ${c.id === activeId ? "var(--teal-deep)" : "var(--line)"}`,
                    background: "var(--surface-2)",
                    cursor: "pointer",
                  }}
                >
                  <div className="strong tiny">{c.title}</div>
                  <div className="tiny muted">
                    {c.messages.length} msg(s) · {new Date(c.updatedAt).toLocaleString()}
                  </div>
                </button>
              ))
            )}
          </div>
        ) : (
          <>
            {!activeConv || activeConv.messages.length === 0 ? (
              <div className="stack" style={{ gap: 10 }}>
                <Banner tone="info">
                  <div className="tiny">
                    Ask about failed system checks, provider cooldowns, stuck background jobs, or
                    cleanup scans. Secrets &amp; private user PII are automatically redacted, and fixes
                    always require confirmation before applying.
                  </div>
                </Banner>
                {[
                  "Check current platform health and explain any active alerts",
                  "Inspect recent failed background jobs or AI provider errors",
                  "Run a safe database cleanup scan",
                ].map((q) => (
                  <button
                    key={q}
                    type="button"
                    className="btn btn-sm"
                    style={{ justifyContent: "flex-start", textAlign: "left", whiteSpace: "normal" }}
                    onClick={() => void sendMessage(q)}
                  >
                    {q}
                  </button>
                ))}
              </div>
            ) : (
              activeConv.messages.map((msg: AdminChatMessage) => (
                <div
                  key={msg.id}
                  className="stack"
                  style={{
                    gap: 6,
                    alignSelf: msg.role === "user" ? "flex-end" : "stretch",
                    maxWidth: msg.role === "user" ? "88%" : "100%",
                  }}
                >
                  <div
                    style={{
                      padding: "9px 12px",
                      borderRadius: 10,
                      fontSize: 12.8,
                      lineHeight: 1.5,
                      whiteSpace: "pre-wrap",
                      background: msg.role === "user" ? "var(--accent)" : "var(--surface-2)",
                      color: msg.role === "user" ? "#f4fbf8" : "var(--ink)",
                      border: msg.role === "assistant" ? "1px solid var(--line)" : "none",
                    }}
                  >
                    {msg.text}
                    {msg.toolActions && msg.toolActions.length > 0 && (
                      <div className="stack" style={{ gap: 4, marginTop: 8 }}>
                        {msg.toolActions.map((act) => (
                          <div
                            key={act.id}
                            className="tiny"
                            style={{
                              padding: "4px 8px",
                              borderRadius: 6,
                              background: "var(--surface)",
                              border: "1px solid var(--line-soft)",
                              display: "flex",
                              gap: 6,
                              alignItems: "center",
                            }}
                          >
                            <CheckCircle2 size={11} style={{ color: "var(--teal-deep)", flexShrink: 0 }} />
                            <span>
                              <strong>{act.name}</strong>: {act.summary}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {msg.proposedDiffs &&
                      msg.proposedDiffs.map((diff, idx) => (
                        <div
                          key={idx}
                          className="stack"
                          style={{
                            gap: 4,
                            marginTop: 8,
                            padding: 8,
                            borderRadius: 8,
                            background: "var(--surface)",
                            border: "1px solid var(--line)",
                          }}
                        >
                          <div className="row" style={{ justifyContent: "space-between", gap: 6 }}>
                            <strong className="tiny">{diff.title}</strong>
                            <Badge tone={diff.evidence === "confirmed" ? "ok" : "warn"}>
                              {diff.evidence === "confirmed" ? "Confirmed" : "Likely cause"}
                            </Badge>
                          </div>
                          <div className="tiny muted">{diff.filePath}</div>
                          <pre
                            style={{
                              margin: 0,
                              padding: 6,
                              borderRadius: 6,
                              background: "var(--surface-2)",
                              fontSize: 11,
                              overflowX: "auto",
                            }}
                          >
                            {`- ${diff.beforeSnippet}\n+ ${diff.afterSnippet}`}
                          </pre>
                        </div>
                      ))}
                    {typeof msg.responseTimeMs === "number" && msg.responseTimeMs > 0 && (
                      <div className="tiny muted" style={{ marginTop: 5 }}>
                        Response time · {formatResponseTime(msg.responseTimeMs)}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}

            {pendingAction && (
              <div
                style={{
                  padding: 12,
                  borderRadius: 10,
                  border: "1.5px solid var(--warn, #d97706)",
                  background: "var(--surface-2)",
                }}
                className="stack"
              >
                <div className="row tiny strong" style={{ gap: 6 }}>
                  <ShieldAlert size={14} style={{ color: "var(--warn, #d97706)" }} />
                  <span>Apply this fix? Confirmation required</span>
                </div>
                <div className="tiny muted">
                  Actions: {pendingAction.gatedCalls.map((g) => g.name).join(", ")}
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={busy}
                    onClick={() => void resolvePendingAction(true)}
                  >
                    Confirm &amp; Execute
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => void resolvePendingAction(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Input */}
      {view === "chat" && (
        <div style={{ padding: 12, borderTop: "1px solid var(--line)", background: "var(--surface-2)" }}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sendMessage();
            }}
            className="row"
            style={{ gap: 8, alignItems: "flex-end" }}
          >
            <textarea
              className="textarea"
              rows={2}
              style={{ minHeight: 48, flex: 1 }}
              value={input}
              disabled={busy || Boolean(pendingAction)}
              placeholder={
                pendingAction
                  ? "Confirm or cancel the pending action above…"
                  : "Ask about health, failed modules, logs, or cleanup…"
              }
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void sendMessage();
                }
              }}
            />
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={busy || !input.trim() || Boolean(pendingAction)}
            >
              {busy ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
            </button>
          </form>
        </div>
      )}
    </aside>
  );
}
