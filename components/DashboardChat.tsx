"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  GripVertical,
  History,
  Loader2,
  MousePointer2,
  Pause,
  Play,
  RotateCcw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
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
import { withRetry } from "@/lib/retry";
import { readWorkspaceToken as getWorkspaceAccessToken } from "@/lib/workspace-token";
import { getSettings } from "@/lib/store";
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

// One request keeps running until the job is actually finished. Real work
// (research → qualify → compose → review) needs dozens of model turns, so this
// is only a runaway guard, not a place to stop and ask the operator.
const MAX_TOOL_ROUNDS = 60;
const CONFIRM_KEY = "agent-operator-confirm-risky";
const RECENT_KEY = "agent-operator-recent";
const DOCK_KEY = "agent-operator-dock";
const RECENT_LIMIT = 40;

interface RecentAction {
  id: string;
  label: string;
  toolName: string;
  status: ActionStep["status"];
  at: number;
  summary?: string;
}

function timeAgo(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const noopSubscribe = () => () => {};

function readStored<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

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
  const cursorEnabled = presence.enabled;
  const setCursorEnabled = presence.setEnabled;
  const setAgentBusy = presence.setBusy;

  // Autopilot is the default: the operator runs the whole job. Operators who
  // want a pause before external/irreversible actions can switch it back on.
  const [confirmRisky, setConfirmRisky] = useState(() => {
    if (typeof window === "undefined") return false;
    return readStored<boolean>(CONFIRM_KEY) === true;
  });
  const confirmRiskyRef = useRef(confirmRisky);

  const toggleConfirmRisky = () => {
    const next = !confirmRiskyRef.current;
    confirmRiskyRef.current = next;
    setConfirmRisky(next);
    try {
      window.localStorage.setItem(CONFIRM_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
    narrate(
      next
        ? "Confirmations on — I'll pause before sending, deleting or writing to Sheets."
        : "Autopilot on — I won't stop to ask.",
    );
  };

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusyState] = useState(false);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirmation | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [live, setLive] = useState(true);
  const [liveNote, setLiveNote] = useState<string | null>(null);
  const [view, setView] = useState<"chat" | "history">("chat");
  // The panel only exists in the browser: its saved position and work log come
  // from localStorage, and mounting after hydration keeps those reads out of
  // effects and out of the server render.
  const hydrated = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  const [recent, setRecent] = useState<RecentAction[]>(() => {
    if (typeof window === "undefined") return [];
    const stored = readStored<RecentAction[]>(RECENT_KEY);
    return Array.isArray(stored) ? stored.slice(0, RECENT_LIMIT) : [];
  });
  const [dockPos, setDockPos] = useState<{ x: number; y: number } | null>(() => {
    if (typeof window === "undefined") return null;
    const stored = readStored<{ x: number; y: number }>(DOCK_KEY);
    return stored && Number.isFinite(stored.x) && Number.isFinite(stored.y) ? stored : null;
  });
  const [dragging, setDragging] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const setBusy = (value: boolean) => {
    setBusyState(value);
    setAgentBusy(value);
  };

  const historyRef = useRef<AgentContent[]>([]);
  const pathnameRef = useRef(pathname);
  const cancelledRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);
  const dockPosRef = useRef<{ x: number; y: number } | null>(dockPos);
  const dragStartRef = useRef<{ pointerX: number; pointerY: number; left: number; top: number } | null>(null);

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    try {
      window.localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    } catch {
      /* storage unavailable */
    }
  }, [recent]);

  useEffect(() => {
    if (view !== "history") return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [view]);

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

  const recordRecent = (step: ActionStep) => {
    setRecent((prev) =>
      [
        {
          id: step.id,
          label: step.label,
          toolName: step.toolName,
          status: step.status,
          at: Date.now(),
          summary: step.summary,
        },
        ...prev.filter((entry) => entry.id !== step.id),
      ].slice(0, RECENT_LIMIT),
    );
  };

  const appendStep = (msgId: string, step: ActionStep) => {
    updateAssistantMessage(msgId, (m) => ({
      ...m,
      steps: [...(m.steps ?? []), step],
    }));
    recordRecent(step);
  };

  const patchStep = (msgId: string, stepId: string, patch: Partial<ActionStep>) => {
    updateAssistantMessage(msgId, (m) => ({
      ...m,
      steps: (m.steps ?? []).map((s) => (s.id === stepId ? { ...s, ...patch } : s)),
    }));
    if (patch.status) {
      const nextStatus = patch.status;
      setRecent((prev) =>
        prev.map((entry) =>
          entry.id === stepId
            ? { ...entry, status: nextStatus, summary: patch.summary ?? entry.summary }
            : entry,
        ),
      );
    }
  };

  const persistDock = (next: { x: number; y: number } | null) => {
    dockPosRef.current = next;
    setDockPos(next);
    try {
      if (next) window.localStorage.setItem(DOCK_KEY, JSON.stringify(next));
      else window.localStorage.removeItem(DOCK_KEY);
    } catch {
      /* storage unavailable */
    }
  };

  const onHeaderPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (window.innerWidth < 900) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, textarea, select")) return;
    const dock = dockRef.current;
    if (!dock) return;
    const rect = dock.getBoundingClientRect();
    dragStartRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      left: rect.left,
      top: rect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const onHeaderPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    const dock = dockRef.current;
    if (!start || !dock) return;
    const width = dock.offsetWidth;
    const height = dock.offsetHeight;
    const x = Math.min(
      Math.max(8, start.left + (event.clientX - start.pointerX)),
      Math.max(8, window.innerWidth - width - 8),
    );
    const y = Math.min(
      Math.max(8, start.top + (event.clientY - start.pointerY)),
      Math.max(8, window.innerHeight - height - 8),
    );
    dockPosRef.current = { x, y };
    setDockPos({ x, y });
  };

  const onHeaderPointerUp = () => {
    if (!dragStartRef.current) return;
    dragStartRef.current = null;
    setDragging(false);
    persistDock(dockPosRef.current);
  };

  const resetDock = () => {
    dragStartRef.current = null;
    setDragging(false);
    persistDock(null);
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
    const narration: string[] = [];

    // Keep the model's running commentary in the reply bubble so the operator
    // reads what is happening instead of waiting on a silent panel.
    const showNarration = (line: string) => {
      const clean = line.trim();
      if (!clean) return;
      if (narration[narration.length - 1] === clean) return;
      narration.push(clean);
      updateAssistantMessage(assistantMsgId, (m) => ({ ...m, text: narration.join("\n\n") }));
    };

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
      const rawTurn = await withRetry(
        () =>
          authedPost<AgentTurnResponse>(
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
          ),
        {
          attempts: 8,
          baseDelayMs: 5_000,
          maxDelayMs: 60_000,
          onRetry: ({ attempt, attempts, delayMs }) => {
            const seconds = Math.round(delayMs / 1000);
            setStatusLabel(`Service busy — retrying in ${seconds}s (attempt ${attempt}/${attempts})`);
            narrate(`Service busy. Retrying in ${seconds}s…`);
          },
        },
      );

      const turn = normalizeAgentTurnResponse(rawTurn);
      if (turn.modelUsed) {
        activeModel = turn.modelUsed;
      }
      const modelContent = turn.modelContent;
      if (turn.functionCalls.length > 0) {
        showNarration(turn.text);
      }

      if (turn.functionCalls.length === 0) {
        workingHistory = [...workingHistory, modelContent];
        historyRef.current = workingHistory;
        updateAssistantMessage(assistantMsgId, (m) => ({
          ...m,
          text: [...narration, turn.text.trim()].filter(Boolean).join("\n\n") || "Done.",
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
        if (confirmRiskyRef.current && isConfirmationRequired(toolName, fc.args)) {
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
        `I reached this run's safety limit (${MAX_TOOL_ROUNDS} steps) before the job was fully done. Everything so far is saved — send "continue" and I'll pick up exactly where I stopped.`,
    }));
  };

  const sendPrompt = async (promptText: string) => {
    const clean = promptText.trim();
    if (!clean || busy || pendingConfirm) return;

    cancelledRef.current = false;
    setView("chat");
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

  const liveLine = busy
    ? statusLabel ?? "Working…"
    : pendingConfirm
      ? "Waiting for your confirmation"
      : live
        ? liveNote ?? "Watching your workspace"
        : "Monitoring paused";

  if (!hydrated) return null;

  // Closing the panel must not hide a run that is still going: keep a compact
  // progress chip on screen until the operator stops it or the job finishes.
  if (!open) {
    if (!busy) return null;
    return (
      <div className="agent-mini" role="status" aria-live="polite" aria-label="AI Operator is working">
        <span className="agent-mini-spinner" aria-hidden="true" />
        <span className="agent-mini-text">{liveLine}</span>
        <span className="agent-mini-elapsed">{elapsed}s</span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            cancelledRef.current = true;
          }}
        >
          <Square size={11} />
          <span>Stop</span>
        </button>
      </div>
    );
  }

  return (
    <motion.div
      ref={dockRef}
      className="agent-dock"
      data-collapsed={collapsed ? "true" : "false"}
      data-dragging={dragging ? "true" : "false"}
      initial={{ opacity: 0, y: 16, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 250, damping: 26 }}
      style={
        dockPos
          ? { left: dockPos.x, top: dockPos.y, right: "auto", bottom: "auto" }
          : undefined
      }
      aria-label="AI Operator"
    >
      <div
        className="chat-header"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
        onDoubleClick={resetDock}
        title={dockPos ? "Drag to move · double-click to dock it back" : "Drag to move this panel"}
      >
        <div className="chat-header-title">
          <span className="chat-drag-grip" aria-hidden="true">
            <GripVertical size={13} />
          </span>
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
            className="btn btn-sm btn-ghost chat-toggle-btn"
            data-on={confirmRisky ? "true" : "false"}
            onClick={toggleConfirmRisky}
            title={
              confirmRisky
                ? "Ask me before sending, deleting or writing to Sheets (on)"
                : "Autopilot: run risky actions without asking (click to require confirmation)"
            }
            aria-label={confirmRisky ? "Turn off action confirmations" : "Require confirmation for risky actions"}
            aria-pressed={confirmRisky}
          >
            {confirmRisky ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost chat-toggle-btn"
            data-on={cursorEnabled ? "true" : "false"}
            onClick={() => {
              const next = !cursorEnabled;
              setCursorEnabled(next);
              if (next) narrate("AI cursor on — I'll show every move.");
            }}
            title={cursorEnabled ? "Hide the AI cursor" : "Show the AI cursor"}
            aria-label={cursorEnabled ? "Hide the AI cursor" : "Show the AI cursor"}
            aria-pressed={cursorEnabled}
          >
            <MousePointer2 size={13} />
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost chat-toggle-btn"
            data-on={view === "history" ? "true" : "false"}
            onClick={() => setView((value) => (value === "history" ? "chat" : "history"))}
            title={view === "history" ? "Back to the conversation" : "Recent work history"}
            aria-label={view === "history" ? "Back to the conversation" : "Recent work history"}
          >
            <History size={13} />
          </button>
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
        {view === "history" ? (
          <div className="agent-history">
            <div className="agent-history-head">
              <div>
                <div className="strong">Recent work</div>
                <div className="tiny">
                  {recent.length > 0
                    ? `${recent.length} action${recent.length === 1 ? "" : "s"} logged`
                    : "Nothing logged yet"}
                </div>
              </div>
              {recent.length > 0 && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => setRecent([])}
                  title="Clear history"
                  aria-label="Clear history"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
            {recent.length === 0 ? (
              <div className="agent-history-empty">
                <History size={18} />
                <p>
                  Every move I make is logged here — navigation, research, drafts, sends and settings
                  changes — with the time it happened.
                </p>
              </div>
            ) : (
              <div className="agent-history-list">
                {recent.map((entry) => (
                  <div key={entry.id} className="agent-history-row" data-status={entry.status}>
                    <span className="agent-history-icon">
                      {entry.status === "running" && <Loader2 size={12} className="spin-icon" />}
                      {entry.status === "done" && <CheckCircle2 size={12} />}
                      {entry.status === "error" && <AlertCircle size={12} />}
                      {entry.status === "cancelled" && <X size={12} />}
                      {entry.status === "awaiting" && <ShieldAlert size={12} />}
                    </span>
                    <span className="agent-history-body">
                      <span className="agent-history-label">{entry.label}</span>
                      {entry.summary && <span className="agent-history-summary">{entry.summary}</span>}
                    </span>
                    <span className="agent-history-time">{timeAgo(entry.at, now)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : messages.length === 0 ? (
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
                Autopilot runs the whole job without stopping. Use the shield button above if you want a pause before sending emails, deleting leads or writing to Sheets.
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
              : "Tell me what you want done in Knowrevo…"
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
