"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  AlertCircle,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Send,
  ShieldAlert,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { motion } from "framer-motion";
import { buildQuickWorkspaceSummary, executeAgentTool } from "@/lib/agent-executor";
import {
  describeToolCall,
  getConfirmationPrompt,
  isConfirmationRequired,
  normalizeAgentTurnResponse,
  type AgentContent,
  type AgentFunctionCall,
  type AgentTurnResponse,
  type AppRoute,
} from "@/lib/agent-meta";
import { authedPost, errorMessage } from "@/lib/client";
import { getWorkspaceAccessToken } from "@/lib/firebase";
import { getSettings } from "@/lib/firestore-store";
import { useAuth } from "./AuthProvider";
import { useAgentPresence } from "./AgentPresence";

interface ActionStep {
  id: string;
  toolName: string;
  label: string;
  status: "running" | "done" | "error" | "cancelled" | "awaiting";
  summary?: string;
  needsWorkspace?: boolean;
  navigatedTo?: AppRoute;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  steps?: ActionStep[];
  modelUsed?: string;
  error?: string;
  retryPrompt?: string;
}

interface PendingConfirmation {
  assistantMsgId: string;
  modelContent: AgentContent;
  baseHistory: AgentContent[];
  priorResponses: { id?: string; name: string; response: Record<string, unknown> }[];
  gatedCalls: AgentFunctionCall[];
  round: number;
  model?: string;
}

const MAX_TOOL_ROUNDS = 8;

let localIdSeq = 0;
function makeLocalId(prefix: string): string {
  localIdSeq += 1;
  return `${prefix}_${localIdSeq}`;
}

const STARTER_PROMPTS = [
  "Give me a live summary of my pipeline and what needs attention",
  "Find 5 dental clinics in Austin with outdated websites and save them to Leads",
  "Plan and create a website redesign campaign for my unprocessed leads",
  "Run research, qualify my leads, and draft outreach emails",
];

function renderInlineFormatting(line: string, keyPrefix: string): ReactNode[] {
  const tokens = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return tokens.map((tok, idx) => {
    if (tok.startsWith("**") && tok.endsWith("**") && tok.length > 4) {
      return <strong key={`${keyPrefix}-b-${idx}`}>{tok.slice(2, -2)}</strong>;
    }
    if (tok.startsWith("`") && tok.endsWith("`") && tok.length > 2) {
      return (
        <code key={`${keyPrefix}-c-${idx}`} className="chat-inline-code">
          {tok.slice(1, -1)}
        </code>
      );
    }
    return <span key={`${keyPrefix}-t-${idx}`}>{tok}</span>;
  });
}

function FormattedReply({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <div className="chat-reply-text">
      {blocks.map((block, bIdx) => {
        const lines = block.split("\n").filter((l) => l.trim().length > 0);
        const isBulletList = lines.length > 0 && lines.every((l) => /^\s*[-*•]\s+/.test(l));
        if (isBulletList) {
          return (
            <ul key={bIdx} className="chat-list">
              {lines.map((l, lIdx) => (
                <li key={lIdx}>{renderInlineFormatting(l.replace(/^\s*[-*•]\s+/, ""), `${bIdx}-${lIdx}`)}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={bIdx}>
            {lines.map((l, lIdx) => (
              <span key={lIdx}>
                {renderInlineFormatting(l, `${bIdx}-${lIdx}`)}
                {lIdx < lines.length - 1 ? <br /> : null}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

export function DashboardChat({
  open,
  onClose,
  onDataMutated,
}: {
  open: boolean;
  onClose: () => void;
  onDataMutated: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, workspaceToken, reconnectWorkspace } = useAuth();
  const presence = useAgentPresence();
  const narrate = presence.narrate;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirmation | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [live, setLive] = useState(true);
  const [liveNote, setLiveNote] = useState<string | null>(null);

  const historyRef = useRef<AgentContent[]>([]);
  const pathnameRef = useRef(pathname);
  const cancelledRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [open, messages, pendingConfirm, busy]);

  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 60);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open]);

  // Tick a visible clock while the agent is working so progress is legible.
  useEffect(() => {
    if (!busy) return undefined;
    const id = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(id);
  }, [busy]);

  // "Full-time agent" presence: while idle and open, keep reading the workspace
  // and narrating what it notices, without taking any action on its own.
  useEffect(() => {
    if (!open || !live || busy || pendingConfirm) return undefined;
    let cancelled = false;
    const look = async () => {
      try {
        const summary = await buildQuickWorkspaceSummary(user.uid);
        if (cancelled) return;
        const lines = summary
          .split("\n")
          .map((line) => line.replace(/^#+\s*|^[-•*]\s*/, "").trim())
          .filter((line) => line.length > 8);
        const note = lines[1] ?? lines[0] ?? "Watching your workspace";
        setLiveNote(note.slice(0, 120));
        narrate(note.slice(0, 90));
      } catch {
        if (!cancelled) setLiveNote("Watching your workspace");
      }
    };
    void look();
    const id = window.setInterval(() => void look(), 12_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [open, live, busy, pendingConfirm, user.uid, narrate]);

  const updateAssistantMessage = (msgId: string, updater: (msg: ChatMessage) => ChatMessage) => {
    setMessages((prev) => prev.map((m) => (m.id === msgId ? updater(m) : m)));
  };

  const appendStep = (msgId: string, step: ActionStep) => {
    updateAssistantMessage(msgId, (m) => ({
      ...m,
      steps: [...(m.steps ?? []), step],
    }));
  };

  const patchStep = (msgId: string, stepId: string, patch: Partial<ActionStep>) => {
    updateAssistantMessage(msgId, (m) => ({
      ...m,
      steps: (m.steps ?? []).map((s) => (s.id === stepId ? { ...s, ...patch } : s)),
    }));
  };

  const makeExecEnv = () => ({
    uid: user.uid,
    navigate: (route: AppRoute) => {
      if (pathnameRef.current !== route) {
        pathnameRef.current = route;
        router.push(route);
      }
    },
    onDataMutated,
    hasWorkspaceToken: () => Boolean(getWorkspaceAccessToken()),
  });

  const runAgentLoop = async (
    assistantMsgId: string,
    contents: AgentContent[],
    startRound: number,
    model?: string,
  ) => {
    let workingHistory = [...contents];
    let round = startRound;
    let activeModel = model;

    while (round < MAX_TOOL_ROUNDS) {
      if (cancelledRef.current) {
        updateAssistantMessage(assistantMsgId, (m) => ({
          ...m,
          text: m.text || "Stopped before completing remaining steps.",
        }));
        return;
      }

      setStatusLabel(round === 0 ? "Thinking…" : "Reviewing results…");
      const summary = await buildQuickWorkspaceSummary(user.uid);
      const rawTurn = await authedPost<AgentTurnResponse>(
        "/api/ai/chat",
        {
          contents: workingHistory,
          model: activeModel,
          context: {
            currentPath: pathnameRef.current,
            workspaceConnected: Boolean(getWorkspaceAccessToken()),
            userEmail: user.email,
            userName: user.displayName,
            summary,
          },
        },
        { retryTransient: true },
      );

      const turn = normalizeAgentTurnResponse(rawTurn);
      if (turn.modelUsed) {
        activeModel = turn.modelUsed;
      }
      const modelContent = turn.modelContent;

      if (turn.functionCalls.length === 0) {
        workingHistory = [...workingHistory, modelContent];
        historyRef.current = workingHistory;
        updateAssistantMessage(assistantMsgId, (m) => ({
          ...m,
          text: turn.text || "Done.",
          modelUsed: turn.modelUsed,
          error: undefined,
          retryPrompt: undefined,
        }));
        return;
      }

      // Split non-gated vs confirmation-gated tool calls so safe actions (e.g. navigate_to_page) run immediately
      const safeCalls: AgentFunctionCall[] = [];
      const gatedCalls: AgentFunctionCall[] = [];
      for (const fc of turn.functionCalls) {
        const toolName = fc.name ?? "";
        if (isConfirmationRequired(toolName, fc.args)) {
          gatedCalls.push(fc);
        } else {
          safeCalls.push(fc);
        }
      }

      const env = makeExecEnv();
      const responses: { id?: string; name: string; response: Record<string, unknown> }[] = [];

      for (const fc of safeCalls) {
        if (cancelledRef.current) break;
        const toolName = fc.name ?? "unknown_tool";
        const stepId = makeLocalId("step");
        const label = describeToolCall(toolName, fc.args);
        setStatusLabel(label);
        const routeArg = typeof fc.args?.route === "string" ? fc.args.route : null;
        void presence.moveTo(routeArg ? `[data-agent-nav="${routeArg}"]` : "[data-agent-page]", {
          label,
          click: true,
          dwellMs: 280,
        });
        appendStep(assistantMsgId, {
          id: stepId,
          toolName,
          label,
          status: "running",
        });

        const res = await executeAgentTool(toolName, fc.args, env);
        patchStep(assistantMsgId, stepId, {
          status: res.ok ? "done" : "error",
          summary: res.summary,
          needsWorkspace: res.needsWorkspace,
          navigatedTo: res.navigatedTo,
        });
        narrate(res.summary ? `${label} — ${res.summary}`.slice(0, 110) : label);
        if (res.navigatedTo) {
          void presence.moveTo("[data-agent-page]", { label: `Now on ${res.navigatedTo}`, click: false, dwellMs: 620 });
        }
        responses.push({
          id: fc.id,
          name: toolName,
          response: res.data,
        });
      }

      if (cancelledRef.current) {
        updateAssistantMessage(assistantMsgId, (m) => ({
          ...m,
          text: m.text || "Stopped by operator.",
        }));
        return;
      }

      if (gatedCalls.length > 0) {
        for (const fc of gatedCalls) {
          const toolName = fc.name ?? "unknown_tool";
          appendStep(assistantMsgId, {
            id: makeLocalId("await"),
            toolName,
            label: describeToolCall(toolName, fc.args),
            status: "awaiting",
            summary: "Waiting for your confirmation",
          });
        }
        setPendingConfirm({
          assistantMsgId,
          modelContent,
          baseHistory: workingHistory,
          priorResponses: responses,
          gatedCalls,
          round,
          model: activeModel,
        });
        setStatusLabel(null);
        setBusy(false);
        return;
      }

      const responseTurn: AgentContent = {
        role: "user",
        parts: responses.map((r) => ({
          functionResponse: {
            ...(r.id ? { id: r.id } : {}),
            name: r.name,
            response: r.response,
          },
        })),
      };

      workingHistory = [...workingHistory, modelContent, responseTurn];
      historyRef.current = workingHistory;
      round += 1;
    }

    updateAssistantMessage(assistantMsgId, (m) => ({
      ...m,
      text:
        m.text ||
        "Completed the maximum batch of automated steps for this turn. Ask me to continue if you want me to run the next batch.",
    }));
  };

  const sendPrompt = async (promptText: string) => {
    const clean = promptText.trim();
    if (!clean || busy || pendingConfirm) return;

    cancelledRef.current = false;
    setInput("");
    setElapsed(0);
    setBusy(true);
    setStatusLabel("Preparing workspace context…");
    narrate("Reading your request and the current workspace…");
    void presence.moveTo("[data-agent-page]", {
      label: "Taking over the workspace",
      click: false,
      dwellMs: 180,
    });

    const userMsg: ChatMessage = {
      id: makeLocalId("u"),
      role: "user",
      text: clean,
    };
    const assistantId = makeLocalId("a");
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: "assistant",
      text: "",
      steps: [],
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    const prevHistory = historyRef.current;
    const nextHistory: AgentContent[] = [
      ...prevHistory,
      { role: "user", parts: [{ text: clean }] },
    ];

    try {
      const settings = await getSettings(user.uid).catch(() => null);
      await runAgentLoop(assistantId, nextHistory, 0, settings?.model);
    } catch (err) {
      // Only keep history clean if no tool exchange completed yet
      if (historyRef.current === prevHistory) {
        historyRef.current = prevHistory;
      }
      const msg = errorMessage(err);
      updateAssistantMessage(assistantId, (m) => ({
        ...m,
        error: msg,
        retryPrompt: clean,
        text: m.text || "I ran into an error while handling that request.",
      }));
    } finally {
      setStatusLabel(null);
      setBusy(false);
    }
  };

  const resolveConfirmation = async (approved: boolean) => {
    if (!pendingConfirm) return;
    const pending = pendingConfirm;
    setPendingConfirm(null);
    setBusy(true);
    setElapsed(0);
    cancelledRef.current = false;
    narrate(approved ? "Running the action you confirmed." : "Cancelling that action.");

    const env = makeExecEnv();
    const gatedResponses: { id?: string; name: string; response: Record<string, unknown> }[] = [];

    // Clear "awaiting" placeholder steps and replace with live execution steps
    updateAssistantMessage(pending.assistantMsgId, (m) => ({
      ...m,
      steps: (m.steps ?? []).filter((s) => s.status !== "awaiting"),
    }));

    for (const fc of pending.gatedCalls) {
      const toolName = fc.name ?? "unknown_tool";
      const stepId = makeLocalId("step");
      const label = describeToolCall(toolName, fc.args);

      if (!approved) {
        appendStep(pending.assistantMsgId, {
          id: stepId,
          toolName,
          label,
          status: "cancelled",
          summary: "Cancelled by user",
        });
        gatedResponses.push({
          id: fc.id,
          name: toolName,
          response: { cancelled_by_user: true, message: "The user declined to confirm this action." },
        });
        continue;
      }

      setStatusLabel(label);
      appendStep(pending.assistantMsgId, {
        id: stepId,
        toolName,
        label,
        status: "running",
      });
      const res = await executeAgentTool(toolName, fc.args, env);
      patchStep(pending.assistantMsgId, stepId, {
        status: res.ok ? "done" : "error",
        summary: res.summary,
        needsWorkspace: res.needsWorkspace,
        navigatedTo: res.navigatedTo,
      });
      gatedResponses.push({
        id: fc.id,
        name: toolName,
        response: res.data,
      });
    }

    const allResponses = [...pending.priorResponses, ...gatedResponses];
    const responseTurn: AgentContent = {
      role: "user",
      parts: allResponses.map((r) => ({
        functionResponse: {
          ...(r.id ? { id: r.id } : {}),
          name: r.name,
          response: r.response,
        },
      })),
    };

    const nextHistory = [...pending.baseHistory, pending.modelContent, responseTurn];
    historyRef.current = nextHistory;

    try {
      await runAgentLoop(pending.assistantMsgId, nextHistory, pending.round + 1, pending.model);
    } catch (err) {
      const msg = errorMessage(err);
      updateAssistantMessage(pending.assistantMsgId, (m) => ({
        ...m,
        error: msg,
        text: m.text || "I ran into an error while finishing that action.",
      }));
    } finally {
      setStatusLabel(null);
      setBusy(false);
    }
  };

  const resetChat = () => {
    cancelledRef.current = true;
    historyRef.current = [];
    setPendingConfirm(null);
    setMessages([]);
    setBusy(false);
    setStatusLabel(null);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendPrompt(input);
    }
  };

  if (!open) return null;

  const liveLine = busy
    ? statusLabel ?? "Working…"
    : pendingConfirm
      ? "Waiting for your confirmation"
      : live
        ? liveNote ?? "Watching your workspace"
        : "Monitoring paused";

  return (
    <motion.div
      className="agent-dock"
      data-collapsed={collapsed ? "true" : "false"}
      initial={{ opacity: 0, y: 16, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 250, damping: 26 }}
      aria-label="AI Operator"
    >
      <div className="chat-header">
        <div className="chat-header-title">
          <div className={`chat-avatar${busy ? " busy" : ""}`}>
            <Sparkles size={15} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="chat-title">AI Operator</div>
            <div className="chat-live-line" data-busy={busy ? "true" : "false"} title={liveLine}>
              <span className="chat-live-dot" />
              <span className="chat-live-text">{liveLine}</span>
              {busy && <span className="chat-elapsed">{elapsed}s</span>}
            </div>
          </div>
        </div>
        <div className="row" style={{ gap: 2 }}>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              setLive((value) => {
                const next = !value;
                if (next) narrate("Back on watch — reading the workspace.");
                else narrate("Monitoring paused.");
                return next;
              });
            }}
            title={live ? "Pause live monitoring" : "Resume live monitoring"}
            aria-label={live ? "Pause live monitoring" : "Resume live monitoring"}
            aria-pressed={live}
          >
            {live ? <Pause size={13} /> : <Play size={13} />}
          </button>
          {messages.length > 0 && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={resetChat}
              title="Start new conversation"
              aria-label="Reset conversation"
            >
              <RotateCcw size={13} />
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => setCollapsed((value) => !value)}
            title={collapsed ? "Expand AI Operator" : "Collapse AI Operator"}
            aria-label={collapsed ? "Expand AI Operator" : "Collapse AI Operator"}
            aria-expanded={!collapsed}
          >
            {collapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onClose}
            title="Close AI Operator"
            aria-label="Close AI Operator"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {collapsed ? null : (
      <>
      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-icon">
              <Bot size={20} />
            </div>
            <h3>Tell me what to do in your dashboard</h3>
            <p>
              I can find prospects, import Google Sheets, build campaigns, run research and qualification,
              draft or edit emails, sync Gmail replies, update settings, and navigate live while you watch.
            </p>
            <div className="chat-starters">
              {STARTER_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="chat-starter"
                  onClick={() => void sendPrompt(prompt)}
                >
                  <span>{prompt}</span>
                  <ArrowUpRight size={13} className="chat-starter-icon" />
                </button>
              ))}
            </div>
            <div className="chat-safety-note">
              <ShieldAlert size={13} />
              <span>
                Sending emails, approving drafts, deleting leads, and writing to Sheets always ask for your confirmation first.
              </span>
            </div>
          </div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className={`chat-msg chat-msg-${msg.role}`}>
              {msg.role === "user" ? (
                <div className="chat-bubble chat-bubble-user">{msg.text}</div>
              ) : (
                <div className="chat-assistant-block">
                  {msg.steps && msg.steps.length > 0 && (
                    <div className="chat-steps">
                      {msg.steps.map((step) => (
                        <div key={step.id} className={`chat-step chat-step-${step.status}`}>
                          <div className="chat-step-head">
                            {step.status === "running" && <Loader2 size={13} className="spin-icon chat-step-icon" />}
                            {step.status === "done" && <CheckCircle2 size={13} className="chat-step-icon ok" />}
                            {step.status === "error" && <AlertCircle size={13} className="chat-step-icon bad" />}
                            {step.status === "cancelled" && <X size={13} className="chat-step-icon muted" />}
                            {step.status === "awaiting" && <ShieldAlert size={13} className="chat-step-icon warn" />}
                            <span className="chat-step-label">{step.label}</span>
                            {step.navigatedTo && (
                              <button
                                type="button"
                                className="chat-step-route"
                                onClick={() => router.push(step.navigatedTo!)}
                              >
                                {step.navigatedTo}
                              </button>
                            )}
                          </div>
                          {step.summary && <div className="chat-step-summary">{step.summary}</div>}
                          {step.needsWorkspace && !workspaceToken && (
                            <div style={{ marginTop: 6 }}>
                              <button
                                type="button"
                                className="btn btn-sm btn-primary"
                                onClick={() => void reconnectWorkspace()}
                              >
                                Reconnect Gmail &amp; Sheets
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {msg.error && (
                    <div className="banner" data-tone="bad" style={{ padding: "8px 11px", fontSize: 12.4, flexDirection: "column", gap: 6 }}>
                      <div>{msg.error}</div>
                      {msg.retryPrompt && !busy && !pendingConfirm && (
                        <div>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => void sendPrompt(msg.retryPrompt!)}
                          >
                            <RotateCcw size={12} />
                            <span>Retry</span>
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {msg.text && (
                    <div className="chat-bubble chat-bubble-assistant">
                      <FormattedReply text={msg.text} />
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}

        {pendingConfirm && (
          <div className="chat-confirm">
            <div className="chat-confirm-head">
              <ShieldAlert size={15} />
              <span>Confirmation required before executing</span>
            </div>
            <div className="chat-confirm-items">
              {pendingConfirm.gatedCalls.map((fc, idx) => {
                const prompt = getConfirmationPrompt(fc.name ?? "", fc.args);
                return (
                  <div key={`${fc.name ?? "call"}-${idx}`} className="chat-confirm-item">
                    <div className="strong">{prompt.title}</div>
                    <div className="tiny" style={{ color: "var(--ink-2)" }}>
                      {prompt.detail}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => void resolveConfirmation(true)}
              >
                {pendingConfirm.gatedCalls.length === 1
                  ? getConfirmationPrompt(
                      pendingConfirm.gatedCalls[0].name ?? "",
                      pendingConfirm.gatedCalls[0].args,
                    ).confirmLabel
                  : `Confirm & run (${pendingConfirm.gatedCalls.length})`}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void resolveConfirmation(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {busy && statusLabel && (
          <div className="chat-working">
            <Loader2 size={13} className="spin-icon" />
            <span>{statusLabel}</span>
          </div>
        )}
      </div>

      <div className="chat-input-bar">
        <textarea
          ref={inputRef}
          className="chat-textarea"
          rows={2}
          placeholder={
            pendingConfirm
              ? "Confirm or cancel the pending action above…"
              : "Tell me what you want done in Outreach Studio…"
          }
          value={input}
          disabled={busy || Boolean(pendingConfirm)}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="chat-input-actions">
          <span className="tiny">
            {workspaceToken ? "Gmail & Sheets active" : "Workspace disconnected"}
          </span>
          {busy ? (
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => {
                cancelledRef.current = true;
              }}
            >
              <Square size={11} />
              <span>Stop</span>
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!input.trim() || Boolean(pendingConfirm)}
              onClick={() => void sendPrompt(input)}
            >
              <Send size={13} />
              <span>Run</span>
            </button>
          )}
        </div>
      </div>
      </>
      )}
    </motion.div>
  );
}
