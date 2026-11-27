"use client";

import { useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/client";
import {
  runComposeBatch,
  runFollowupsBatch,
  runQualifyBatch,
  runResearchBatch,
  runSendBatch,
  runSyncBatch,
  type BatchResult,
} from "@/lib/pipeline-client";
import { useAuth } from "./AuthProvider";
import { useTaskDock, type TaskHandle } from "./Loading";
import { confirmDialog } from "./Feedback";

let activeRunner: string | null = null;

/** A batch that loses the tab to a reload or crash is resumed from a user-scoped key. */
function jobStorageKey(uid: string): string {
  return `os:outreach-batch-job:${uid || "anon"}`;
}
const MAX_STALLS = 2;
const RESUME_WINDOW_MS = 45 * 60 * 1000;

interface StoredJob {
  type: RunnerType;
  campaignId?: string;
  limit: number;
  startedAt: number;
}

function readStoredJob(uid: string): StoredJob | null {
  try {
    const raw = window.localStorage.getItem(jobStorageKey(uid));
    return raw ? (JSON.parse(raw) as StoredJob) : null;
  } catch {
    return null;
  }
}

function writeStoredJob(uid: string, job: StoredJob | null): void {
  try {
    if (job) window.localStorage.setItem(jobStorageKey(uid), JSON.stringify(job));
    else window.localStorage.removeItem(jobStorageKey(uid));
  } catch {
    /* storage unavailable */
  }
}

type RunnerType = "research" | "qualify" | "compose" | "send" | "followup" | "sync";

const PER_ITEM_MS: Record<RunnerType, number> = {
  research: 12_000,
  qualify: 8_000,
  compose: 12_000,
  send: 4_000,
  followup: 12_000,
  sync: 8_000,
};

const TITLES: Record<RunnerType, string> = {
  research: "Researching prospects",
  qualify: "Qualifying prospects",
  compose: "Writing emails",
  send: "Sending emails",
  followup: "Preparing follow-ups",
  sync: "Syncing replies",
};

const START_DETAIL: Record<RunnerType, string> = {
  research: "Fetching websites and collecting evidence…",
  qualify: "Scoring opportunities against your offer…",
  compose: "Drafting first emails in your voice…",
  send: "Checking Gmail and your send limits…",
  followup: "Finding prospects whose follow-up is due…",
  sync: "Reading your inbox for new replies…",
};

export function BatchRunner({
  type,
  campaignId,
  label,
  variant = "default",
  onDone,
  confirmText,
  limit = 3,
}: {
  type: RunnerType;
  campaignId?: string;
  label: string;
  variant?: "default" | "primary";
  onDone?: () => void | Promise<void>;
  confirmText?: string;
  limit?: number;
}) {
  const { user, workspaceToken, reconnectWorkspace } = useAuth();
  const dock = useTaskDock();
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef(false);
  const stallCount = useRef(0);
  const pausedRef = useRef(false);
  const runRef = useRef<(() => Promise<void>) | null>(null);

  const executeBatch = async (): Promise<BatchResult> => {
    switch (type) {
      case "research":
        return runResearchBatch(user.uid, campaignId, limit);
      case "qualify":
        return runQualifyBatch(user.uid, campaignId, limit);
      case "compose":
        return runComposeBatch(user.uid, campaignId, limit);
      case "followup":
        return runFollowupsBatch(user.uid, campaignId, limit);
      case "send":
        return runSendBatch(user.uid, campaignId, limit);
      case "sync":
        return runSyncBatch(user.uid, limit);
    }
  };

  const run = async () => {
    if (activeRunner) return;
    if ((type === "send" || type === "sync") && !workspaceToken) {
      const ok = await reconnectWorkspace();
      if (!ok) return;
    }
    if (confirmText) {
      const proceed = await confirmDialog({
        title: type === "send" ? "Send these emails?" : "Confirm this action",
        message: confirmText,
        confirmLabel: type === "send" ? "Send now" : "Continue",
        tone: type === "send" ? "bad" : "info",
      });
      if (!proceed) return;
    }

    activeRunner = `${user.uid}:${type}:${campaignId ?? "all"}`;
    stopRef.current = false;
    stallCount.current = 0;
    pausedRef.current = false;
    writeStoredJob(user.uid, { type, campaignId, limit, startedAt: Date.now() });
    setRunning(true);
    setError(null);
    setNote(null);

    const startedAt = Date.now();
    let handle: TaskHandle = { update: () => undefined, finish: () => undefined };
    handle = dock.start({
      title: TITLES[type],
      detail: START_DETAIL[type],
      estimatedMs: Math.max(1, limit) * PER_ITEM_MS[type] + 2500,
      onStop: () => {
        stopRef.current = true;
        handle.update({ detail: "Stopping after the current item…" });
      },
    });

    let total = 0;
    let ended = false;
    try {
      for (let i = 0; i < 80; i++) {
        if (stopRef.current) {
          ended = true;
          handle.finish("stopped", `Stopped after ${total} item${total === 1 ? "" : "s"}. Progress is saved.`);
          setNote(`Stopped. ${total} processed; progress is saved.`);
          break;
        }

        const result = await executeBatch();
        total += result.processed;
        if (result.errors.length) setError(result.errors.slice(0, 3).join(" · "));

        const lastDetail =
          result.details.length > 0
            ? result.details[result.details.length - 1]
            : result.info ?? `${total} processed so far…`;

        const remainingMs =
          Math.max(0, result.remaining) * PER_ITEM_MS[type] + Math.max(0, result.waitSeconds ?? 0) * 1000;

        handle.update({
          detail: lastDetail,
          count: total,
          estimatedMs: Date.now() - startedAt + Math.max(1200, remainingMs),
        });

        // A batch that processed nothing because of errors is a stall, not a
        // finished run — even when the queue looks empty, the same leads are
        // still waiting and will be retried.
        const stalled =
          result.processed === 0 && result.errors.length > 0 && !result.waitSeconds;

        if (stalled && stallCount.current < MAX_STALLS) {
          // Server-side LLMGateway already failed over across healthy keys.
          // Wait at most 2-4s once or twice instead of stalling the UI for minutes.
          stallCount.current += 1;
          const waitSec = Math.min(4, stallCount.current * 2);
          setError(null);
          handle.update({
            detail: `Retrying briefly in ${waitSec}s (attempt ${stallCount.current}/${MAX_STALLS})…`,
            estimatedMs: Date.now() - startedAt + waitSec * 1000 + 4_000,
          });
          await new Promise<void>((resolve) => setTimeout(resolve, waitSec * 1000));
          continue;
        }

        const pausedMessage = stalled
          ? `Paused after ${MAX_STALLS} retries. ${result.errors[0]} Press the button to continue; progress is saved.`
          : null;

        if (pausedMessage) {
          ended = true;
          // Keep the job marker: reloading the page picks the run back up.
          pausedRef.current = true;
          handle.finish("error", pausedMessage);
          setNote(pausedMessage);
          break;
        }

        if (result.remaining <= 0) {
          ended = true;
          const message = total ? `Finished: ${total} processed.` : result.info || "Nothing to process.";
          handle.finish(result.errors.length && !total ? "error" : "done", message);
          setNote(message);
          break;
        }

        if (result.processed === 0 && !result.waitSeconds) {
          ended = true;
          const message = result.info || "Nothing further to process.";
          handle.finish("done", message);
          setNote(message);
          break;
        }

        stallCount.current = 0;
        if (result.waitSeconds) {
          const wait = Math.min(result.waitSeconds, 60);
          handle.update({
            detail: `${result.info ? `${result.info}. ` : ""}Waiting ${wait}s to respect your send interval…`,
            estimatedMs: Date.now() - startedAt + wait * 1000 + Math.max(1200, result.remaining * PER_ITEM_MS[type]),
          });
          await new Promise((resolve) => setTimeout(resolve, wait * 1000));
        }
      }
      if (!ended) {
        const message = `Processed ${total}. Press the button again to keep going from where this stopped.`;
        handle.finish("done", message);
        setNote(message);
      }
      await onDone?.();
    } catch (err) {
      const message = errorMessage(err);
      setError(message);
      setNote(null);
      handle.finish("error", message);
    } finally {
      activeRunner = null;
      // A paused run stays resumable; a finished or stopped one does not.
      writeStoredJob(
        user.uid,
        pausedRef.current && !stopRef.current
          ? { type, campaignId, limit, startedAt: Date.now() }
          : null,
      );
      setRunning(false);
    }
  };

  useEffect(() => {
    runRef.current = run;
  });

  // Resume a batch that was interrupted by a reload or a crash. Sending is
  // excluded: email always needs a deliberate confirmation press.
  useEffect(() => {
    if (type === "send") return undefined;
    const job = readStoredJob(user.uid);
    if (!job || job.type !== type || job.campaignId !== campaignId) return undefined;
    if (Date.now() - job.startedAt > RESUME_WINDOW_MS) {
      writeStoredJob(user.uid, null);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      if (activeRunner) return;
      setNote("Resuming the interrupted batch…");
      void runRef.current?.();
    }, 700);
    return () => window.clearTimeout(timer);
  }, [user.uid, type, campaignId]);

  return (
    <span className="row" style={{ gap: 8 }}>
      <button
        className={`btn btn-sm${variant === "primary" ? " btn-primary" : ""}`}
        onClick={() => void run()}
        disabled={running}
        type="button"
      >
        {running ? "Working…" : label}
      </button>
      {note && !error && <span className="tiny">{note}</span>}
      {error && (
        <span className="tiny" style={{ color: "var(--bad)" }}>
          {error}
        </span>
      )}
    </span>
  );
}
