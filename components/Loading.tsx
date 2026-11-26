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

export type TaskStatus = "running" | "done" | "error" | "stopped";

export interface TaskPatch {
  detail?: string;
  count?: number;
  estimatedMs?: number;
}

export interface TaskHandle {
  update: (patch: TaskPatch) => void;
  finish: (status: Exclude<TaskStatus, "running">, message?: string) => void;
}

export interface StartTaskOptions {
  title: string;
  detail?: string;
  estimatedMs?: number;
  onStop?: () => void;
}

interface DockTask {
  id: string;
  title: string;
  detail?: string;
  count?: number;
  estimatedMs: number;
  startedAt: number;
  status: TaskStatus;
  message?: string;
  onStop?: () => void;
}

interface TaskDockValue {
  start: (options: StartTaskOptions) => TaskHandle;
}

const TaskDockContext = createContext<TaskDockValue | null>(null);

export function useTaskDock(): TaskDockValue {
  const ctx = useContext(TaskDockContext);
  if (!ctx) throw new Error("useTaskDock must be used inside TaskDockProvider.");
  return ctx;
}

export function TaskDockProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<DockTask[]>([]);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const id of pending) window.clearTimeout(id);
    };
  }, []);

  const start = useCallback((options: StartTaskOptions): TaskHandle => {
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const task: DockTask = {
      id,
      title: options.title,
      detail: options.detail,
      estimatedMs: Math.max(1200, options.estimatedMs ?? 6000),
      startedAt: Date.now(),
      status: "running",
      onStop: options.onStop,
    };
    setTasks((current) => [...current.slice(-2), task]);

    return {
      update(patch: TaskPatch) {
        setTasks((current) =>
          current.map((item) =>
            item.id === id
              ? {
                  ...item,
                  detail: patch.detail ?? item.detail,
                  count: patch.count ?? item.count,
                  estimatedMs: patch.estimatedMs ? Math.max(1200, patch.estimatedMs) : item.estimatedMs,
                }
              : item,
          ),
        );
      },
      finish(status, message) {
        setTasks((current) =>
          current.map((item) =>
            item.id === id
              ? {
                  ...item,
                  status,
                  message: message ?? item.message,
                  onStop: undefined,
                }
              : item,
          ),
        );
        const timer = window.setTimeout(
          () => setTasks((current) => current.filter((item) => item.id !== id)),
          status === "error" ? 9000 : 5500,
        );
        timers.current.push(timer);
      },
    };
  }, []);

  const value = useMemo<TaskDockValue>(() => ({ start }), [start]);

  return (
    <TaskDockContext.Provider value={value}>
      {children}
      <AnimatePresence>
        {tasks.length > 0 && (
          <motion.div
            className="taskdock dock"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            aria-live="polite"
          >
            {tasks.map((task) => (
              <DockItem key={task.id} task={task} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </TaskDockContext.Provider>
  );
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  running: "Working",
  done: "Done",
  error: "Failed",
  stopped: "Stopped",
};

function DockItem({ task }: { task: DockTask }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (task.status !== "running") return;
    const id = window.setInterval(() => setNow(Date.now()), 400);
    return () => window.clearInterval(id);
  }, [task.status]);

  const percent =
    task.status === "running"
      ? Math.min(97, Math.max(3, Math.round(((now - task.startedAt) / task.estimatedMs) * 100)))
      : 100;

  return (
    <div className="taskdock-item dock-card" data-status={task.status}>
      <div className="taskdock-head dock-top">
        <span className="taskdock-title dock-title">{task.title}</span>
        <span className="taskdock-status">{STATUS_LABEL[task.status]}</span>
      </div>
      {task.detail && <div className="taskdock-detail dock-detail">{task.detail}</div>}
      {task.message && <div className="taskdock-message">{task.message}</div>}
      <div className="taskdock-bar dock-track">
        <span className="taskdock-fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="taskdock-foot dock-foot">
        <span className="taskdock-count">
          {typeof task.count === "number" && task.count > 0 ? `${task.count} processed` : ""}
        </span>
        {task.status === "running" && task.onStop && (
          <button className="btn btn-sm btn-ghost dock-stop" type="button" onClick={task.onStop}>
            Stop
          </button>
        )}
      </div>
    </div>
  );
}
