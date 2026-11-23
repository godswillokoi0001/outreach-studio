"use client";

import { useRef, useState } from "react";
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

let activeRunner: string | null = null;

export function BatchRunner({
  type,
  campaignId,
  label,
  variant = "default",
  onDone,
  confirmText,
  limit = 3,
}: {
  type: "research" | "qualify" | "compose" | "send" | "followup" | "sync";
  campaignId?: string;
  label: string;
  variant?: "default" | "primary";
  onDone?: () => void | Promise<void>;
  confirmText?: string;
  limit?: number;
}) {
  const { user, workspaceToken, reconnectWorkspace } = useAuth();
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef(false);

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
    if (confirmText && !window.confirm(confirmText)) return;

    activeRunner = `${type}:${campaignId ?? "all"}`;
    stopRef.current = false;
    setRunning(true);
    setError(null);
    setNote("Starting…");
    let total = 0;
    try {
      for (let i = 0; i < 80; i++) {
        if (stopRef.current) {
          setNote(`Stopped. ${total} processed; progress is saved.`);
          break;
        }
        const result = await executeBatch();
        total += result.processed;
        if (result.errors.length) setError(result.errors.slice(0, 3).join(" · "));
        if (result.info) setNote(result.info);
        else setNote(`${total} processed${result.remaining ? `, ${result.remaining} remaining` : ""}…`);

        if (result.remaining <= 0) {
          setNote(total ? `Done: ${total} processed.` : result.info || "Nothing to process.");
          break;
        }
        if (result.processed === 0 && !result.waitSeconds) {
          setNote(result.info || "Nothing further to process.");
          break;
        }
        if (result.waitSeconds) {
          const wait = Math.min(result.waitSeconds, 60);
          setNote(`${result.info ? `${result.info} ` : ""}Waiting ${wait}s…`);
          await new Promise((resolve) => setTimeout(resolve, wait * 1000));
        }
      }
      await onDone?.();
    } catch (err) {
      setError(errorMessage(err));
      setNote(null);
    } finally {
      activeRunner = null;
      setRunning(false);
    }
  };

  return (
    <span className="row" style={{ gap: 8 }}>
      <button
        className={`btn btn-sm${variant === "primary" ? " btn-primary" : ""}`}
        onClick={() => void run()}
        disabled={running}
        type="button"
      >
        {running ? (
          <>
            <span className="spinner" /> {label}…
          </>
        ) : (
          label
        )}
      </button>
      {running && (
        <button className="btn btn-sm btn-ghost" onClick={() => (stopRef.current = true)} type="button">
          Stop
        </button>
      )}
      {note && !error && <span className="tiny">{note}</span>}
      {error && <span className="tiny" style={{ color: "var(--bad)" }}>{error}</span>}
    </span>
  );
}
