"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertCircle, CheckCircle2, Loader2, X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

/* ------------------------------------------------------------------ *
 * Formatting helpers
 * ------------------------------------------------------------------ */

export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export function fmtEta(ms: number): string {
  if (ms <= 600) return "almost done";
  if (ms < 60_000) return `~${Math.max(5, Math.round(ms / 5000) * 5)}s left`;
  const mins = Math.max(1, Math.round(ms / 60_000));
  return `~${mins} min${mins === 1 ? "" : "s"} left`;
}

/** Ticking elapsed time. Returns 0 while inactive. */
export function useElapsed(active: boolean): number {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    const timer = setInterval(() => setMs(Date.now() - started), 200);
    return () => clearInterval(timer);
  }, [active]);
  return ms;
}

/* ------------------------------------------------------------------ *
 * Loading panel — used for every page/section load
 * ------------------------------------------------------------------ */

export interface LoadingStep {
  label: string;
  /** Approximate duration of this step in ms. */
  ms: number;
}

export function LoadingPanel({
  label,
  hint,
  estimateMs,
  steps,
  compact,
}: {
  label: string;
  hint?: string;
  /** Rough time this usually takes. Drives the bar and the countdown. */
  estimateMs?: number;
  steps?: LoadingStep[];
  compact?: boolean;
}) {
  const elapsed = useElapsed(true);
  const cumulative = useMemo(() => {
    if (!steps?.length) return [];
    let total = 0;
    return steps.map((step) => {
      total += step.ms;
      return total;
    });
  }, [steps]);

  const estimatedTotal = estimateMs ?? (cumulative.length ? cumulative[cumulative.length - 1] : undefined);
  const pct = estimatedTotal ? Math.min(94, Math.round((elapsed / estimatedTotal) * 94)) : null;
  const remaining = estimatedTotal ? estimatedTotal - elapsed : 0;
  const activeStep = cumulative.findIndex((until) => elapsed < until);

  return (
    <div className={`load-panel${compact ? " compact" : ""}`} role="status" aria-live="polite">
      <div className="load-head">
        <span className="load-ring" aria-hidden="true" />
        <div className="load-copy">
          <div className="load-label">{label}</div>
          <div className="load-hint">
            {steps?.length && activeStep >= 0 ? steps[activeStep].label : hint ?? "Reading your workspace…"}
          </div>
        </div>
        <div className="load-timing">
          <span className="load-elapsed">{fmtClock(elapsed)}</span>
          {estimatedTotal ? (
            <span className="load-eta">{remaining > 600 ? fmtEta(remaining) : "finishing up"}</span>
          ) : null}
        </div>
      </div>

      <div className={`load-track${pct === null ? " indeterminate" : ""}`} aria-hidden="true">
        <motion.span
          initial={{ width: "6%" }}
          animate={{ width: pct === null ? "36%" : `${Math.max(6, pct)}%` }}
          transition={{ type: "spring", stiffness: 120, damping: 24 }}
        />
      </div>

      {steps?.length ? (
        <ul className="load-steps">
          {steps.map((step, index) => {
            const done = activeStep === -1 ? true : index < activeStep;
            const current = index === activeStep;
            return (
              <li key={step.label} data-state={done ? "done" : current ? "current" : "next"}>
                <span className="load-step-dot" aria-hidden="true" />
                {step.label}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Skeletons
 * ------------------------------------------------------------------ */

export function Skeleton({
  height = 16,
  width = "100%",
  radius = 8,
  className,
}: {
  height?: number | string;
  width?: number | string;
  radius?: number;
  className?: string;
}) {
  return (
    <div
      className={`skel${className ? ` ${className}` : ""}`}
      style={{ height, width, borderRadius: radius }}
      aria-hidden="true"
    />
  );
}

export function CardSkeleton({ lines = 3, height = 180 }: { lines?: number; height?: number }) {
  return (
    <section className="card" aria-hidden="true" style={{ minHeight: height }}>
      <Skeleton height={13} width="38%" />
      <div style={{ height: 12 }} />
      {Array.from({ length: lines }).map((_, index) => (
        <div key={index} style={{ marginBottom: 8 }}>
          <Skeleton height={11} width={`${88 - index * 12}%`} />
        </div>
      ))}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Task dock — the floating "what is running right now" panel
 * ------------------------------------------------------------------ */

export type TaskStatus = "running" | "done" | "error" | "stopped";

interface DockTask {
  id: string;
  title: string;
  detail: string;
  status: TaskStatus;
  startedAt: number;
  estimatedMs: number;
  count?: number;
  elapsedAtEnd?: number;
  onStop?: () => void;
}

export interface TaskHandle {
  update: (patch: { detail?: string; estimatedMs?: number; count?: number }) => void;
  finish: (status: Exclude<TaskStatus, "running">, detail?: string) => void;
}

interface TaskDockValue {
  start: (opts: { title: string; detail?: string; estimatedMs: number; onStop?: () => void }) => TaskHandle;
}

const TaskDockContext = createContext<TaskDockValue | null>(null);

export function useTaskDock(): TaskDockValue {
  const value = useContext(TaskDockContext);
  if (!value) {
    // Safe no-op fallback so components never crash outside the provider.
    return {
      start: () => ({ update: () => undefined, finish: () => undefined }),
    };
  }
  return value;
}

export function TaskDockProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<DockTask[]>([]);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const dismiss = useCallback((id: string) => {
    setTasks((prev) => prev.filter((task) => task.id !== id));
    const timer = timers.current[id];
    if (timer) {
      clearTimeout(timer);
      delete timers.current[id];
    }
  }, []);

  const start = useCallback<TaskDockValue["start"]>((opts) => {
    const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const task: DockTask = {
      id,
      title: opts.title,
      detail: opts.detail ?? "Preparing…",
      status: "running",
      startedAt: Date.now(),
      estimatedMs: Math.max(1200, opts.estimatedMs),
      onStop: opts.onStop,
    };
    setTasks((prev) => [...prev.slice(-2), task]);

    return {
      update: (patch) =>
        setTasks((prev) =>
          prev.map((item) =>
            item.id === id
              ? {
                  ...item,
                  detail: patch.detail ?? item.detail,
                  estimatedMs: patch.estimatedMs ?? item.estimatedMs,
                  count: patch.count ?? item.count,
                }
              : item,
          ),
        ),
      finish: (status, detail) => {
        setTasks((prev) =>
          prev.map((item) =>
            item.id === id
              ? {
                  ...item,
                  status,
                  detail: detail ?? item.detail,
                  onStop: undefined,
                  elapsedAtEnd: Date.now() - item.startedAt,
                }
              : item,
          ),
        );
        timers.current[id] = setTimeout(() => dismiss(id), status === "error" ? 14_000 : 5_500);
      },
    };
  }, [dismiss]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of Object.values(pending)) clearTimeout(timer);
    };
  }, []);

  const value = useMemo(() => ({ start }), [start]);

  return (
    <TaskDockContext.Provider value={value}>
      {children}
      <div className="dock" aria-live="polite">
        <AnimatePresence initial={false}>
          {tasks.map((task) => (
            <DockCard key={task.id} task={task} onDismiss={() => dismiss(task.id)} />
          ))}
        </AnimatePresence>
      </div>
    </TaskDockContext.Provider>
  );
}

function DockCard({ task, onDismiss }: { task: DockTask; onDismiss: () => void }) {
  const running = task.status === "running";
  const elapsed = useElapsed(running);
  const spent = running ? elapsed : task.elapsedAtEnd ?? 0;
  const pct = running ? Math.min(97, Math.max(4, Math.round((spent / task.estimatedMs) * 100))) : 100;
  const remaining = Math.max(0, task.estimatedMs - spent);

  const tone =
    task.status === "error" ? "bad" : task.status === "done" ? "ok" : task.status === "stopped" ? "warn" : "run";

  return (
    <motion.div
      className="dock-card"
      data-tone={tone}
      layout
      initial={{ opacity: 0, y: 22, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 28, scale: 0.95 }}
      transition={{ type: "spring", stiffness: 340, damping: 30 }}
    >
      <div className="dock-top">
        <span className="dock-icon" aria-hidden="true">
          {task.status === "error" ? (
            <AlertCircle size={15} />
          ) : task.status === "done" ? (
            <CheckCircle2 size={15} />
          ) : (
            <Loader2 size={15} className="spin-icon" />
          )}
        </span>
        <div className="dock-copy">
          <div className="dock-title">{task.title}</div>
          <div className="dock-detail">{task.detail}</div>
        </div>
        {!running && (
          <button className="dock-x" onClick={onDismiss} type="button" aria-label="Dismiss">
            <X size={13} />
          </button>
        )}
      </div>

      <div className="dock-track" aria-hidden="true">
        <motion.span
          data-tone={tone}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        />
      </div>

      <div className="dock-foot">
        <span>
          {fmtClock(spent)} elapsed
          {running && remaining > 800 ? ` · ${fmtEta(remaining)}` : ""}
          {running && task.count ? ` · ${task.count} done` : ""}
        </span>
        {running && task.onStop && (
          <button className="dock-stop" onClick={task.onStop} type="button">
            Stop
          </button>
        )}
      </div>
    </motion.div>
  );
}
