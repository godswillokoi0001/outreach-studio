"use client";

import { useRef, useState } from "react";
import { api, errorMessage } from "@/lib/client";

interface BatchResponse {
  processed: number;
  remaining: number;
  details: string[];
  errors: string[];
  waitSeconds?: number;
  info?: string;
}

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
  onDone?: () => void;
  confirmText?: string;
  limit?: number;
}) {
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef(false);

  const run = async () => {
    if (activeRunner) return;
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
        const result = await api.post<BatchResponse>("/api/process", { type, campaignId, limit });
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
      onDone?.();
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
        onClick={run}
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
