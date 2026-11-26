"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cpu,
  GripVertical,
  History,
  ImagePlus,
  MessageSquare,
  Mic,
  MoreHorizontal,
  MousePointer2,
  PanelRight,
  Paperclip,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  Square,
  Trash2,
  Volume2,
  Wrench,
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
  type AgentPart,
  type AgentTurnResponse,
  type AppRoute,
} from "@/lib/agent-meta";
import { authedPost, errorMessage } from "@/lib/client";
import { setActiveAiConfig } from "@/lib/ai-client";
import {
  enabledProviders,
  readActiveProviderId,
  setActiveProviderId,
  toAiConfig,
  useModelProviders,
} from "@/lib/ai/providers";
import { withRetry } from "@/lib/retry";
import { readWorkspaceToken as getWorkspaceAccessToken } from "@/lib/workspace-token";
import { getSettings } from "@/lib/store";
import { buildLiveKnowledgeDigest } from "@/lib/pipeline-client";
import { useAuth } from "./AuthProvider";
import { BrandMark } from "./BrandMark";
import { Menu, MenuItem, MenuSeparator } from "./Menu";
import { BrandLoader } from "./BrandLoader";
import { useAgentPresence } from "./AgentPresence";
import { useConfirm } from "./Feedback";

type OperatorMode = "chat" | "agent" | "developer";
type DockMode = "floating" | "docked";

interface ActionStep {
  id: string;
  toolName: string;
  label: string;
  status: "running" | "done" | "error" | "cancelled" | "awaiting";
  summary?: string;
  needsWorkspace?: boolean;
  navigatedTo?: AppRoute;
  /** Set once the change was checked against the page/state. */
  verified?: boolean;
  attempts?: number;
}

interface Conversation {
  id: string;
  title: string;
  mode: OperatorMode;
  model?: string;
  providerId?: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  contents: AgentContent[];
}

interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  /** Base64 without the data: prefix, sent as inline data. */
  data: string;
  dataUrl: string;
  size: number;
}

interface VoiceNote {
  mimeType: string;
  data: string;
  dataUrl: string;
  seconds: number;
  transcript: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  steps?: ActionStep[];
  modelUsed?: string;
  error?: string;
  retryPrompt?: string;
  attachments?: { name: string; dataUrl?: string }[];
  voice?: { seconds: number; transcript: string };
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}

const IMAGE_TYPES = /^image\/(png|jpe?g|webp|gif)$/i;
const MAX_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("That file could not be read."));
    reader.readAsDataURL(file);
  });
}

function formatSeconds(total: number): string {
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
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
const MODE_KEY = "agent-operator-mode";
const DOCK_MODE_KEY = "agent-operator-dock-mode";
const CONV_KEY = "agent-operator-conversations";
const ACTIVE_KEY = "agent-operator-active";
const RECENT_LIMIT = 40;
const DEVELOPER_MODE_KEY = "os:developer-mode";

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
const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

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
  const confirmDialog = useConfirm();
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

  // Attachments, voice notes and the model switcher. Providers come from the
  // browser's model vault (Settings → Model providers); keys never enter the
  // bundle and are only attached to authenticated AI requests.
  const providers = useModelProviders();
  const [providerChoice, setProviderChoice] = useState<string | null>(null);
  const storedProviderId = readActiveProviderId();
  const providerId =
    providerChoice ?? (storedProviderId || providers.find((provider) => provider.enabled)?.id || "");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  const [fileDrag, setFileDrag] = useState(false);
  const [voice, setVoice] = useState<VoiceNote | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [waveBars, setWaveBars] = useState<number[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const transcriptRef = useRef("");
  const recordTimerRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const waveTimerRef = useRef<number | null>(null);
  const recordSecondsRef = useRef(0);

  const activeSavedProvider = providers.find((provider) => provider.id === providerId) ?? null;
  const visionCapable = activeSavedProvider ? activeSavedProvider.vision : true;
  const audioCapable = activeSavedProvider ? activeSavedProvider.audio : true;
  const providerInfoRef = useRef<{ id: string; model: string }>({ id: "", model: "" });

  // Operator modes: chat answers only, agent operates the app, developer
  // diagnoses and proposes patches.
  const [mode, setMode] = useState<OperatorMode>(() => {
    const stored = typeof window === "undefined" ? null : readStored<OperatorMode>(MODE_KEY);
    return stored === "chat" || stored === "agent" || stored === "developer" ? stored : "agent";
  });
  // Developer mode is switched on from Settings, never from the operator menu.
  const [developerEnabled, setDeveloperEnabled] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(DEVELOPER_MODE_KEY) === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    const sync = () => {
      let enabled = false;
      try {
        enabled = window.localStorage.getItem(DEVELOPER_MODE_KEY) === "true";
      } catch {
        enabled = false;
      }
      setDeveloperEnabled(enabled);
      // Turning developer mode off from Settings also leaves that mode behind.
      if (!enabled) setMode((current) => (current === "developer" ? "agent" : current));
    };
    window.addEventListener("storage", sync);
    window.addEventListener(DEVELOPER_MODE_KEY, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(DEVELOPER_MODE_KEY, sync);
    };
  }, []);
  const [dockMode, setDockMode] = useState<DockMode>(() => {
    const stored = typeof window === "undefined" ? null : readStored<DockMode>(DOCK_MODE_KEY);
    return stored === "docked" ? "docked" : "floating";
  });
  const [conversations, setConversations] = useState<Conversation[]>(() => {
    if (typeof window === "undefined") return [];
    const stored = readStored<Conversation[]>(CONV_KEY);
    return Array.isArray(stored) ? stored : [];
  });
  const [activeId, setActiveId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return readStored<string>(ACTIVE_KEY);
  });
  const [search, setSearch] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const modeRef = useRef<OperatorMode>(mode);
  const activeIdRef = useRef<string | null>(activeId);

  const setBusy = (value: boolean) => {
    setBusyState(value);
    setAgentBusy(value);
  };

  const historyRef = useRef<AgentContent[]>([]);
  const knowledgeRef = useRef<string>("");
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

  // Keep the request config and the per-chat provider marker in sync with the
  // selected model (an external system, so this belongs in an effect).
  useEffect(() => {
    providerInfoRef.current = { id: providerId, model: activeSavedProvider?.model ?? "" };
    if (activeSavedProvider) setActiveAiConfig(toAiConfig(activeSavedProvider));
  }, [providerId, activeSavedProvider]);

  useEffect(() => {
    try {
      window.localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    } catch {
      /* storage unavailable */
    }
  }, [recent]);

  useEffect(() => {
    modeRef.current = mode;
    try {
      window.localStorage.setItem(MODE_KEY, JSON.stringify(mode));
    } catch {
      /* storage unavailable */
    }
  }, [mode]);

  useEffect(() => {
    try {
      window.localStorage.setItem(DOCK_MODE_KEY, JSON.stringify(dockMode));
    } catch {
      /* storage unavailable */
    }
    document.body.dataset.operatorDock = dockMode === "docked" ? "true" : "false";
    return () => {
      delete document.body.dataset.operatorDock;
    };
  }, [dockMode]);

  useEffect(() => {
    activeIdRef.current = activeId;
    try {
      if (activeId) window.localStorage.setItem(ACTIVE_KEY, JSON.stringify(activeId));
      else window.localStorage.removeItem(ACTIVE_KEY);
    } catch {
      /* storage unavailable */
    }
  }, [activeId]);

  useEffect(() => {
    try {
      window.localStorage.setItem(CONV_KEY, JSON.stringify(conversations.slice(0, 40)));
    } catch {
      /* storage unavailable */
    }
  }, [conversations]);

  // Keep the open conversation saved as it grows, so reopening the operator
  // (or reloading) returns the same thread, action log included.
  useEffect(() => {
    if (!hydrated || !activeId || messages.length === 0) return;
    setConversations((prev) => {
      const existing = prev.find((item) => item.id === activeId);
      const firstUser = messages.find((message) => message.role === "user");
      const title = existing?.title || (firstUser?.text ?? "New conversation").slice(0, 70);
      const modelUsed = [...messages].reverse().find((message) => message.modelUsed)?.modelUsed;
      // Base64 media is stripped before persisting: the transcript, file names
      // and the conversation survive, without filling the browser's storage quota.
      const storedMessages = messages.map((message) => ({
        ...message,
        attachments: message.attachments?.map((attachment) => ({ name: attachment.name })),
      }));
      const storedContents = historyRef.current.map((turn) => ({
        ...turn,
        parts: turn.parts.map((part) =>
          part.inlineData
            ? { text: part.inlineData.mimeType.startsWith("image/") ? "[image attached]" : "[voice note attached]" }
            : part,
        ),
      }));
      const entry: Conversation = {
        id: activeId,
        title,
        mode: existing?.mode ?? modeRef.current,
        model: providerInfoRef.current.model || modelUsed || existing?.model,
        providerId: providerInfoRef.current.id || existing?.providerId,
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        messages: storedMessages,
        contents: storedContents,
      };
      return [entry, ...prev.filter((item) => item.id !== activeId)].slice(0, 40);
    });
  }, [messages, activeId, hydrated]);

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
    if (window.innerWidth < 900 || dockMode === "docked") return;
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

  /**
   * Check that an action actually changed something. Navigation is confirmed
   * against the live route; data actions are confirmed against the tool's own
   * result. A step is only marked "verified" when this passes.
   */
  const verifyAction = async (
    toolName: string,
    result: { ok: boolean; summary: string; data: Record<string, unknown>; navigatedTo?: AppRoute },
    routeArg: string | null,
  ): Promise<{ verified: boolean; note: string }> => {
    if (!result.ok) return { verified: false, note: "Action failed" };
    if (toolName === "navigate_to_page") {
      const want = result.navigatedTo ?? routeArg;
      if (!want) return { verified: false, note: "No route returned" };
      for (let attempt = 0; attempt < 10; attempt += 1) {
        if (pathnameRef.current === want) return { verified: true, note: `Page is ${want}` };
        await wait(120);
      }
      return { verified: false, note: `Still on ${pathnameRef.current}` };
    }
    const data = (result.data ?? {}) as Record<string, unknown>;
    if (typeof data.error === "string" && data.error) return { verified: false, note: data.error };
    if (data.saved === false || data.updated === false || data.deleted === false) {
      return { verified: false, note: "The action reported no change" };
    }
    return { verified: true, note: "Change confirmed" };
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
    runMode: OperatorMode = "agent",
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
              mode: runMode,
              context: {
                currentPath: pathnameRef.current,
                workspaceConnected: Boolean(getWorkspaceAccessToken()),
                userEmail: user.email,
                userName: user.displayName,
                summary,
                knowledge: knowledgeRef.current,
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
      // Chat mode is conversation only: any tool call is ignored, never run.
      const requestedCalls = runMode === "chat" ? [] : turn.functionCalls;
      if (requestedCalls.length > 0) {
        showNarration(turn.text);
      }

      if (requestedCalls.length === 0) {
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
      for (const fc of requestedCalls) {
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

        let attempts = 1;
        let res = await executeAgentTool(toolName, fc.args, env);
        // One honest retry for transient failures — never for a missing Google session.
        while (!res.ok && !res.needsWorkspace && attempts < 2 && !cancelledRef.current) {
          attempts += 1;
          await wait(700);
          res = await executeAgentTool(toolName, fc.args, env);
        }
        const check = await verifyAction(toolName, res, routeArg);
        patchStep(assistantMsgId, stepId, {
          status: res.ok ? "done" : "error",
          summary: check.verified ? `${res.summary} · verified` : `${res.summary} · ${check.note}`,
          needsWorkspace: res.needsWorkspace,
          navigatedTo: res.navigatedTo,
          verified: check.verified,
          attempts,
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

  const chooseProvider = (id: string) => {
    const next = providers.find((provider) => provider.id === id) ?? null;
    setProviderChoice(id);
    if (!next) {
      setActiveProviderId("");
      return;
    }
    setActiveProviderId(next.id);
    setActiveAiConfig(toAiConfig(next));
    setConversations((prev) =>
      prev.map((conversation) =>
        conversation.id === activeIdRef.current
          ? { ...conversation, providerId: next.id, model: next.model }
          : conversation,
      ),
    );
    narrate(`${next.name || next.model} selected for this chat.`);
  };

  const addFiles = async (files: File[]) => {
    setAttachNotice(null);
    if (files.length === 0) return;
    if (!visionCapable) {
      setAttachNotice(
        `The selected model (${activeSavedProvider?.name || activeSavedProvider?.model || "current model"}) cannot read images. Switch to a vision-capable model in Settings → Model providers.`,
      );
      return;
    }
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      setAttachNotice(`You can attach up to ${MAX_ATTACHMENTS} images per message.`);
      return;
    }

    const accepted: Attachment[] = [];
    const problems: string[] = [];
    for (const file of files.slice(0, room)) {
      if (!IMAGE_TYPES.test(file.type)) {
        problems.push(`${file.name} is not a PNG, JPG, WEBP or GIF image.`);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        problems.push(`${file.name} is larger than 4 MB.`);
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const data = dataUrl.split(",")[1] ?? "";
        if (!data) {
          problems.push(`${file.name} could not be read.`);
          continue;
        }
        accepted.push({
          id: `${Date.now()}-${file.name}-${accepted.length}`,
          name: file.name,
          mimeType: file.type,
          data,
          dataUrl,
          size: file.size,
        });
      } catch {
        problems.push(`${file.name} could not be read.`);
      }
    }

    if (accepted.length > 0) {
      setAttachments((prev) => [...prev, ...accepted].slice(0, MAX_ATTACHMENTS));
      narrate(`${accepted.length} image${accepted.length === 1 ? "" : "s"} attached.`);
    }
    if (problems.length > 0) setAttachNotice(problems.join(" "));
  };

  const stopAudioCapture = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
    if (waveTimerRef.current) {
      window.clearInterval(waveTimerRef.current);
      waveTimerRef.current = null;
    }
    if (recordTimerRef.current) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    setWaveBars([]);
  };

  const transcribe = async (note: { mimeType: string; data: string }) => {
    setTranscribing(true);
    try {
      const res = await authedPost<{ transcript: string }>("/api/ai/transcribe", { audio: note });
      setVoice((current) =>
        current && current.data === note.data ? { ...current, transcript: res.transcript } : current,
      );
      if (!res.transcript) setRecordError("No speech was detected in that recording.");
    } catch (err) {
      setRecordError(errorMessage(err));
    } finally {
      setTranscribing(false);
    }
  };

  const finishRecording = async () => {
    const mimeType = recorderRef.current?.mimeType?.split(";")[0] || "audio/webm";
    const chunks = chunksRef.current;
    const seconds = recordSecondsRef.current;
    stopAudioCapture();
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    recorderRef.current = null;
    setRecording(false);
    if (chunks.length === 0) {
      setRecordError("Nothing was recorded. Check the microphone and try again.");
      return;
    }
    const blob = new Blob(chunks, { type: mimeType });
    const dataUrl = await readFileAsDataUrl(blob);
    const data = dataUrl.split(",")[1] ?? "";
    const transcript = transcriptRef.current.trim();
    setVoice({ mimeType, data, dataUrl, seconds, transcript });
    if (!transcript) void transcribe({ mimeType, data });
  };

  const startRecording = async () => {
    setRecordError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setRecordError("This browser cannot record audio. Type the note instead.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      transcriptRef.current = "";
      chunksRef.current = [];
      recordSecondsRef.current = 0;
      setRecordSeconds(0);

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        void finishRecording();
      };
      recorderRef.current = recorder;
      recorder.start(250);
      setRecording(true);

      // Real input levels, so the user can see the microphone is live.
      try {
        const AudioCtor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AudioCtor) {
          const ctx = new AudioCtor();
          audioCtxRef.current = ctx;
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 64;
          ctx.createMediaStreamSource(stream).connect(analyser);
          const buffer = new Uint8Array(analyser.frequencyBinCount);
          waveTimerRef.current = window.setInterval(() => {
            analyser.getByteFrequencyData(buffer);
            setWaveBars(Array.from({ length: 20 }, (_, index) => Math.max(6, Math.round((buffer[index * 2] ?? 0) / 4))));
          }, 120);
        }
      } catch {
        /* the waveform is cosmetic; recording still works */
      }

      recordTimerRef.current = window.setInterval(() => {
        recordSecondsRef.current += 1;
        setRecordSeconds(recordSecondsRef.current);
        if (recordSecondsRef.current >= 120) recorderRef.current?.stop();
      }, 1000);

      // Browser speech recognition provides a free live transcript. When it is
      // missing, the selected provider transcribes the audio instead.
      const speechWindow = window as unknown as {
        SpeechRecognition?: new () => SpeechRecognitionLike;
        webkitSpeechRecognition?: new () => SpeechRecognitionLike;
      };
      const Recognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
      if (Recognition) {
        try {
          const recognition = new Recognition();
          recognition.continuous = true;
          recognition.interimResults = true;
          recognition.lang = navigator.language || "en-US";
          recognition.onresult = (event) => {
            let text = "";
            for (let index = 0; index < event.results.length; index += 1) {
              text += event.results[index]?.[0]?.transcript ?? "";
            }
            transcriptRef.current = text.trim();
          };
          recognition.onerror = () => undefined;
          recognition.start();
          recognitionRef.current = recognition;
        } catch {
          recognitionRef.current = null;
        }
      }

      narrate("Recording a voice note…");
    } catch {
      setRecordError("Microphone permission was refused. Allow it in your browser settings, or type the note instead.");
    }
  };

  const stopRecording = () => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    } else {
      stopAudioCapture();
      setRecording(false);
    }
  };

  const cancelRecording = () => {
    chunksRef.current = [];
    transcriptRef.current = "";
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      recorder.stop();
    }
    recorderRef.current = null;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    stopAudioCapture();
    setRecording(false);
    setRecordSeconds(0);
    recordSecondsRef.current = 0;
    setRecordError(null);
  };

  const sendPrompt = async (promptText: string) => {
    const clean = promptText.trim();
    const pendingAttachments = attachments;
    const pendingVoice = voice;
    if ((!clean && pendingAttachments.length === 0 && !pendingVoice) || busy || pendingConfirm) return;
    if (!clean && pendingVoice && !pendingVoice.transcript && !audioCapable) {
      setRecordError(
        "This model cannot read audio and no transcript was produced. Type the note, or switch to an audio-capable model.",
      );
      return;
    }

    cancelledRef.current = false;
    setView("chat");
    setInput("");
    setAttachments([]);
    setVoice(null);
    setAttachNotice(null);
    setRecordError(null);
    setElapsed(0);
    if (!activeIdRef.current) {
      const id = makeLocalId("conv");
      activeIdRef.current = id;
      setActiveId(id);
    }
    setBusy(true);
    setStatusLabel("Preparing workspace context…");
    narrate("Reading your request and the current workspace…");
    void presence.moveTo("[data-agent-page]", {
      label: "Taking over the workspace",
      click: false,
      dwellMs: 180,
    });

    const parts: AgentPart[] = [];
    const promptWithVoice = [clean, pendingVoice?.transcript ? `Voice note transcript: ${pendingVoice.transcript}` : ""]
      .filter(Boolean)
      .join("\n\n");
    if (promptWithVoice) parts.push({ text: promptWithVoice });
    for (const file of pendingAttachments) {
      parts.push({ inlineData: { mimeType: file.mimeType, data: file.data } });
    }
    if (pendingVoice && audioCapable) {
      parts.push({ inlineData: { mimeType: pendingVoice.mimeType, data: pendingVoice.data } });
    }

    const userMsg: ChatMessage = {
      id: makeLocalId("u"),
      role: "user",
      text:
        clean ||
        (pendingVoice
          ? `Voice note (${formatSeconds(pendingVoice.seconds)})${pendingVoice.transcript ? `: “${pendingVoice.transcript}”` : ""}`
          : `${pendingAttachments.length} image${pendingAttachments.length === 1 ? "" : "s"} attached`),
      attachments:
        pendingAttachments.length > 0
          ? pendingAttachments.map((file) => ({ name: file.name, dataUrl: file.dataUrl }))
          : undefined,
      voice: pendingVoice ? { seconds: pendingVoice.seconds, transcript: pendingVoice.transcript } : undefined,
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
    const nextHistory: AgentContent[] = [...prevHistory, { role: "user", parts }];

    try {
      const settings = await getSettings(user.uid).catch(() => null);
      // Read the knowledge base once per request: it is the source of truth for
      // every draft, plan and claim the operator makes in this turn.
      knowledgeRef.current = await buildLiveKnowledgeDigest(user.uid).catch(() => "");
      await runAgentLoop(assistantId, nextHistory, 0, activeSavedProvider?.model || settings?.model, mode);
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
    activeIdRef.current = null;
    setActiveId(null);
    setPendingConfirm(null);
    setMessages([]);
    setBusy(false);
    setStatusLabel(null);
    setView("chat");
  };

  const openConversation = (conversation: Conversation) => {
    cancelledRef.current = true;
    historyRef.current = conversation.contents ?? [];
    activeIdRef.current = conversation.id;
    setActiveId(conversation.id);
    setMessages(conversation.messages ?? []);
    setMode(conversation.mode ?? "agent");
    const restore = providers.find((provider) => provider.id === conversation.providerId);
    if (restore) {
      setProviderChoice(restore.id);
      setActiveProviderId(restore.id);
      setActiveAiConfig(toAiConfig(restore));
    }
    setPendingConfirm(null);
    setBusy(false);
    setStatusLabel(null);
    setView("chat");
  };

  const deleteConversation = (id: string) => {
    setConversations((prev) => prev.filter((item) => item.id !== id));
    if (activeIdRef.current === id) resetChat();
  };

  const commitRename = () => {
    if (!renaming) return;
    const value = renaming.value.trim();
    if (value) {
      setConversations((prev) =>
        prev.map((item) => (item.id === renaming.id ? { ...item, title: value } : item)),
      );
    }
    setRenaming(null);
  };

  const clearAllConversations = () => {
    setConversations([]);
    resetChat();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendPrompt(input);
    }
  };

  const filteredConversations = useMemo(() => {
    const query = search.trim().toLowerCase();
    const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!query) return sorted;
    return sorted.filter(
      (conversation) =>
        conversation.title.toLowerCase().includes(query) ||
        conversation.messages.some((message) => message.text.toLowerCase().includes(query)),
    );
  }, [conversations, search]);

  const modeOptions: { value: OperatorMode; label: string; icon: typeof MessageSquare; hint: string }[] = [
    {
      value: "chat",
      label: "Chat",
      icon: MessageSquare,
      hint: "Conversation only — nothing in your workspace is changed",
    },
    {
      value: "agent",
      label: "Agent",
      icon: MousePointer2,
      hint: "Operate the app: research, campaigns, drafts and sends",
    },
    ...(developerEnabled
      ? [
          {
            value: "developer" as OperatorMode,
            label: "Developer",
            icon: Wrench,
            hint: "Diagnose problems and propose fixes",
          },
        ]
      : []),
  ];

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
      <div className="agent-mini" role="status" aria-live="polite" aria-label="Operator is working">
        <BrandLoader variant="thinking" size={16} />
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
      data-dock={dockMode}
      data-mode={mode}
      initial={{ opacity: 0, y: 16, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 250, damping: 26 }}
      style={
        dockMode === "docked"
          ? undefined
          : dockPos
            ? { left: dockPos.x, top: dockPos.y, right: "auto", bottom: "auto" }
            : undefined
      }
      aria-label="Operator"
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
            <BrandMark size={20} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="chat-title">Operator</div>
            <div className="chat-live-line" data-busy={busy ? "true" : "false"} title={liveLine}>
              <span className="chat-live-dot" />
              <span className="chat-live-text">{liveLine}</span>
              {busy && <span className="chat-elapsed">{elapsed}s</span>}
            </div>
          </div>
        </div>
        <div className="chat-header-tools">
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => setCollapsed((value) => !value)}
            title={collapsed ? "Expand operator" : "Collapse operator"}
            aria-label={collapsed ? "Expand operator" : "Collapse operator"}
            aria-expanded={!collapsed}
          >
            {collapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onClose}
            title="Close operator"
            aria-label="Close operator"
          >
            <X size={15} />
          </button>
        </div>
        <div className="chat-toolbar">
        <div className="agent-mode-switch" role="group" aria-label="Operator mode">
          {modeOptions.map((option) => {
            const Icon = option.icon;
            return (
              <button
                key={option.value}
                type="button"
                className="agent-mode"
                data-on={mode === option.value ? "true" : "false"}
                aria-pressed={mode === option.value}
                title={option.hint}
                onClick={() => setMode(option.value)}
              >
                <Icon size={12} aria-hidden="true" />
                <span>{option.label}</span>
              </button>
            );
          })}
        </div>
        <label className="chat-model" title="Model used by the operator in this chat">
          <Cpu size={12} aria-hidden="true" />
          <select
            value={providerId}
            onChange={(event) => chooseProvider(event.target.value)}
            aria-label="Model provider"
            disabled={busy}
          >
            {enabledProviders(providers).length === 0 ? <option value="">Default model</option> : null}
            {enabledProviders(providers).map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name || provider.model || provider.provider}
              </option>
            ))}
          </select>
        </label>
        <div className="chat-toolbar-actions">
          <button
            type="button"
            className="btn btn-sm btn-ghost chat-toggle-btn"
            data-on={dockMode === "docked" ? "true" : "false"}
            onClick={() => setDockMode((value) => (value === "docked" ? "floating" : "docked"))}
            title={dockMode === "docked" ? "Float the operator (draggable)" : "Dock the operator to the right"}
            aria-label={dockMode === "docked" ? "Float the operator" : "Dock the operator"}
            aria-pressed={dockMode === "docked"}
          >
            <PanelRight size={13} />
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost chat-toggle-btn"
            data-on={view === "history" ? "true" : "false"}
            onClick={() => setView((value) => (value === "history" ? "chat" : "history"))}
            title={view === "history" ? "Back to the conversation" : "Recent work history"}
            aria-label={view === "history" ? "Back to the conversation" : "Recent work history"}
            aria-pressed={view === "history"}
          >
            <History size={13} />
          </button>
          <Menu label="Operator settings" align="end" className="chat-overflow" trigger={<MoreHorizontal size={14} />}>
            {(close) => (
              <>
                <MenuItem
                  onClick={() => {
                    toggleConfirmRisky();
                    close();
                  }}
                  hint={confirmRisky ? "on" : "off"}
                >
                  {confirmRisky ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}
                  <span>Confirm risky actions</span>
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    const next = !cursorEnabled;
                    setCursorEnabled(next);
                    if (next) narrate("AI cursor on — I'll show every move.");
                    close();
                  }}
                  hint={cursorEnabled ? "on" : "off"}
                >
                  <MousePointer2 size={13} />
                  <span>Show AI cursor</span>
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    setLive((value) => {
                      const next = !value;
                      if (next) narrate("Back on watch — reading the workspace.");
                      else narrate("Monitoring paused.");
                      return next;
                    });
                    close();
                  }}
                  hint={live ? "on" : "paused"}
                >
                  {live ? <Pause size={13} /> : <Play size={13} />}
                  <span>Live monitoring</span>
                </MenuItem>
                {messages.length > 0 ? (
                  <>
                    <MenuSeparator />
                    <MenuItem
                      onClick={() => {
                        resetChat();
                        close();
                      }}
                    >
                      <RotateCcw size={13} />
                      <span>New conversation</span>
                    </MenuItem>
                  </>
                ) : null}
              </>
            )}
          </Menu>
        </div>
        </div>
      </div>

      {collapsed ? null : (
      <>
      <div className="chat-messages" ref={scrollRef}>
        {view === "history" ? (
          <div className="agent-history">
            <div className="agent-convos">
              <div className="agent-history-head">
                <div>
                  <div className="strong">Conversations</div>
                  <div className="tiny">
                    {conversations.length > 0 ? `${conversations.length} saved` : "Nothing saved yet"}
                  </div>
                </div>
                <div className="row" style={{ gap: 4 }}>
                  <button type="button" className="btn btn-sm" onClick={resetChat} title="New chat">
                    <Plus size={12} aria-hidden="true" />
                    <span>New</span>
                  </button>
                  {conversations.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        void confirmDialog({
                          title: "Delete every saved conversation?",
                          message: "The whole operator history is removed from this browser. This cannot be undone.",
                          confirmLabel: "Delete all",
                          tone: "bad",
                        }).then((ok) => {
                          if (ok) clearAllConversations();
                        });
                      }}
                      title="Clear all conversations"
                      aria-label="Clear all conversations"
                    >
                      <Trash2 size={12} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>

              <label className="agent-search">
                <Search size={13} aria-hidden="true" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search conversations"
                  aria-label="Search conversations"
                />
              </label>

              {filteredConversations.length === 0 ? (
                <p className="agent-convos-empty">
                  Conversations are saved here with their messages and action log. Start one from the chat tab.
                </p>
              ) : (
                <ul className="agent-convos-list">
                  {filteredConversations.map((conversation) => (
                    <li key={conversation.id} className="agent-convo" data-active={conversation.id === activeId}>
                      {renaming?.id === conversation.id ? (
                        <form
                          className="agent-convo-rename"
                          onSubmit={(event) => {
                            event.preventDefault();
                            commitRename();
                          }}
                        >
                          <input
                            autoFocus
                            value={renaming.value}
                            onChange={(event) => setRenaming({ id: conversation.id, value: event.target.value })}
                            onBlur={commitRename}
                            aria-label="Conversation name"
                          />
                        </form>
                      ) : (
                        <button
                          type="button"
                          className="agent-convo-open"
                          onClick={() => openConversation(conversation)}
                          title={conversation.title}
                        >
                          <span className="agent-convo-title">{conversation.title}</span>
                          <span className="agent-convo-meta">
                            {conversation.mode} · {timeAgo(conversation.updatedAt, now)}
                          </span>
                        </button>
                      )}
                      <div className="agent-convo-actions">
                        <button
                          type="button"
                          onClick={() => setRenaming({ id: conversation.id, value: conversation.title })}
                          aria-label="Rename conversation"
                          title="Rename"
                        >
                          <Pencil size={12} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            void confirmDialog({
                              title: "Delete this conversation?",
                              message: "Its messages and action log are removed from this browser.",
                              confirmLabel: "Delete",
                              tone: "bad",
                            }).then((ok) => {
                              if (ok) deleteConversation(conversation.id);
                            });
                          }}
                          aria-label="Delete conversation"
                          title="Delete"
                        >
                          <Trash2 size={12} aria-hidden="true" />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

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
                      {entry.status === "running" && <BrandLoader variant="inline" size={12} />}
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
              <MousePointer2 size={19} />
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
                <div className="chat-bubble chat-bubble-user">
                  {msg.attachments && msg.attachments.length > 0 ? (
                    <div className="chat-bubble-media">
                      {msg.attachments.map((attachment, index) =>
                        attachment.dataUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element -- a data URL of the user's own upload
                          <img key={`${attachment.name}-${index}`} src={attachment.dataUrl} alt={attachment.name} />
                        ) : (
                          <span key={`${attachment.name}-${index}`} className="chat-bubble-file">
                            <ImagePlus size={12} aria-hidden="true" /> {attachment.name}
                          </span>
                        ),
                      )}
                    </div>
                  ) : null}
                  {msg.voice ? (
                    <div className="chat-bubble-voice">
                      <Volume2 size={12} aria-hidden="true" />
                      <span>Voice note · {formatSeconds(msg.voice.seconds)}</span>
                      {msg.voice.transcript ? <em>“{msg.voice.transcript}”</em> : null}
                    </div>
                  ) : null}
                  {msg.text}
                </div>
              ) : (
                <div className="chat-assistant-block">
                  {msg.steps && msg.steps.length > 0 && (
                    <div className="chat-steps">
                      {msg.steps.map((step) => (
                        <div key={step.id} className={`chat-step chat-step-${step.status}`}>
                          <div className="chat-step-head">
                            {step.status === "running" && <BrandLoader variant="inline" size={13} />}
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
            <BrandLoader variant="inline" size={13} />
            <span>{statusLabel}</span>
          </div>
        )}
      </div>

      <div
        className="chat-input-bar"
        data-file-drag={fileDrag ? "true" : "false"}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
            setFileDrag(true);
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFileDrag(false);
        }}
        onDrop={(event) => {
          if (event.dataTransfer.files?.length) {
            event.preventDefault();
            setFileDrag(false);
            void addFiles(Array.from(event.dataTransfer.files));
          }
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          hidden
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            void addFiles(files);
          }}
        />

        {recording ? (
          <div className="chat-recorder" role="status" aria-live="polite">
            <span className="chat-rec-dot" aria-hidden="true" />
            <div className="chat-wave" aria-hidden="true">
              {(waveBars.length ? waveBars : Array.from({ length: 20 }, () => 8)).map((height, index) => (
                <span key={index} style={{ height }} />
              ))}
            </div>
            <span className="chat-rec-time">{formatSeconds(recordSeconds)}</span>
            <div className="row" style={{ gap: 6 }}>
              <button type="button" className="btn btn-sm btn-primary" onClick={stopRecording}>
                <Square size={11} />
                <span>Stop</span>
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={cancelRecording}
                aria-label="Cancel recording"
                title="Discard this recording"
              >
                <X size={12} />
              </button>
            </div>
          </div>
        ) : (
          <>
            {attachments.length > 0 || voice || attachNotice || recordError ? (
              <div className="chat-attachments">
                {attachments.map((file) => (
                  <figure key={file.id} className="chat-attachment">
                    {/* eslint-disable-next-line @next/next/no-img-element -- preview of the user's own upload */}
                    <img src={file.dataUrl} alt={file.name} />
                    <button
                      type="button"
                      onClick={() => setAttachments((prev) => prev.filter((item) => item.id !== file.id))}
                      aria-label={`Remove ${file.name}`}
                      title="Remove image"
                    >
                      <X size={11} />
                    </button>
                  </figure>
                ))}

                {voice ? (
                  <div className="chat-voice">
                    <audio controls src={voice.dataUrl} aria-label="Voice note playback" />
                    <div className="chat-voice-body">
                      <span className="tiny strong">
                        <Volume2 size={11} aria-hidden="true" /> Voice note · {formatSeconds(voice.seconds)}
                      </span>
                      {transcribing ? (
                        <span className="tiny chat-voice-status">
                          <BrandLoader variant="inline" size={11} /> Transcribing…
                        </span>
                      ) : (
                        <input
                          className="input"
                          value={voice.transcript}
                          onChange={(event) => setVoice({ ...voice, transcript: event.target.value })}
                          placeholder="Transcript (edit if needed)"
                          aria-label="Voice note transcript"
                        />
                      )}
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        setVoice(null);
                        setRecordError(null);
                      }}
                      aria-label="Remove voice note"
                      title="Remove voice note"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ) : null}

                {attachNotice ? (
                  <p className="chat-input-note" role="alert">
                    {attachNotice}
                  </p>
                ) : null}
                {recordError ? (
                  <p className="chat-input-note" role="alert">
                    {recordError}
                  </p>
                ) : null}
              </div>
            ) : null}

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
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files ?? []);
                if (files.length > 0) {
                  event.preventDefault();
                  void addFiles(files);
                }
              }}
            />
            <div className="chat-input-actions">
              <div className="chat-input-tools">
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => fileInputRef.current?.click()}
                  title="Attach images (or drop / paste them)"
                  aria-label="Attach images"
                  disabled={busy || Boolean(pendingConfirm)}
                >
                  <ImagePlus size={13} />
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => void startRecording()}
                  title="Record a voice note"
                  aria-label="Record a voice note"
                  disabled={busy || Boolean(pendingConfirm)}
                >
                  <Mic size={13} />
                </button>
                {attachments.length > 0 ? (
                  <span className="chat-attach-count">
                    <Paperclip size={11} aria-hidden="true" /> {attachments.length}
                  </span>
                ) : null}
                <span className="tiny">
                  {workspaceToken ? "Gmail & Sheets active" : "Workspace disconnected"}
                </span>
              </div>
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
                  disabled={(!input.trim() && attachments.length === 0 && !voice) || Boolean(pendingConfirm)}
                  onClick={() => void sendPrompt(input)}
                >
                  <Send size={13} />
                  <span>Run</span>
                </button>
              )}
            </div>
          </>
        )}
      </div>
      </>
      )}
    </motion.div>
  );
}
