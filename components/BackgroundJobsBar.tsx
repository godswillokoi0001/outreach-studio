"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Sparkles } from "lucide-react";
import { authedGet } from "@/lib/client";
import type { BackgroundJobRecord } from "@/lib/background-jobs";
import { useToast } from "./Feedback";

export const BACKGROUND_JOB_EVENT = "knowrevo:background-job-updated";

export function formatApproxEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "Almost done…";
  if (seconds < 15) return "About 10 seconds left";
  if (seconds < 60) return `About ${Math.ceil(seconds / 5) * 5} seconds left`;
  const mins = Math.ceil(seconds / 60);
  return mins === 1 ? "About 1 minute left" : `About ${mins} minutes left`;
}

export function BackgroundJobsBar({ uid }: { uid: string }) {
  const toast = useToast();
  const [job, setJob] = useState<BackgroundJobRecord | null>(null);
  const [recentFinish, setRecentFinish] = useState(false);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const notifiedFinishedIdRef = useRef<string | null>(null);

  const pollOnce = useCallback(async () => {
    try {
      const res = await authedGet<{ job: BackgroundJobRecord | null }>(
        "/api/ai/growth-advisor/jobs",
      );
      const latest = res.job ?? null;
      setJob(latest);

      const ageMs = latest?.finishedAt ? Date.now() - new Date(latest.finishedAt).getTime() : 999_999;
      setRecentFinish(Boolean(latest && ageMs < 5 * 60_000));

      if (latest && latest.status === "succeeded" && notifiedFinishedIdRef.current !== latest.id) {
        if (ageMs < 120_000) {
          notifiedFinishedIdRef.current = latest.id;
          toast.success(
            "Growth Advisor ready",
            "Your personalized growth recommendations are ready to view.",
          );
        }
      }
      return latest;
    } catch {
      return null;
    }
  }, [toast]);

  useEffect(() => {
    notifiedFinishedIdRef.current = null;
    const t = window.setTimeout(() => {
      void pollOnce();
    }, 0);
    return () => window.clearTimeout(t);
  }, [uid, pollOnce]);

  useEffect(() => {
    const onKick = () => {
      setDismissedKey(null);
      void pollOnce();
    };
    window.addEventListener(BACKGROUND_JOB_EVENT, onKick);
    return () => window.removeEventListener(BACKGROUND_JOB_EVENT, onKick);
  }, [pollOnce]);

  const isActive = job?.status === "queued" || job?.status === "running";

  useEffect(() => {
    if (!isActive) return;
    const timer = window.setInterval(() => {
      void pollOnce();
    }, 2200);
    return () => window.clearInterval(timer);
  }, [isActive, pollOnce]);

  if (!job) return null;
  const currentDismissKey = `${uid}:${job.id}`;
  if (dismissedKey === currentDismissKey) return null;

  if (isActive) {
    return (
      <Link
        href="/growth-advisor"
        className="btn btn-sm"
        style={{
          gap: 6,
          background: "var(--surface-2)",
          borderColor: "var(--line)",
          maxWidth: 270,
          overflow: "hidden",
        }}
        title={`${job.currentStep} (${job.progressPct}% — ${formatApproxEta(job.estimatedSecondsRemaining)})`}
      >
        <Loader2 size={13} className="spin" style={{ color: "var(--teal-deep)", flexShrink: 0 }} />
        <span className="tiny strong" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          Growth Research {job.progressPct}%
        </span>
      </Link>
    );
  }

  if (!recentFinish) return null;

  if (job.status === "succeeded") {
    return (
      <Link
        href="/growth-advisor"
        onClick={() => setDismissedKey(currentDismissKey)}
        className="btn btn-sm"
        style={{ gap: 6, borderColor: "var(--ok, #16a34a)", color: "var(--ok, #15803d)" }}
      >
        <CheckCircle2 size={13} />
        <span className="tiny strong">View recommendations</span>
      </Link>
    );
  }

  if (job.status === "failed") {
    return (
      <Link
        href="/growth-advisor"
        onClick={() => setDismissedKey(currentDismissKey)}
        className="btn btn-sm"
        style={{ gap: 6, borderColor: "var(--bad, #dc2626)", color: "var(--bad, #b91c1c)" }}
        title={job.errorMessage || "Growth research failed"}
      >
        <AlertTriangle size={13} />
        <span className="tiny strong">Research needs retry</span>
        <Sparkles size={11} />
      </Link>
    );
  }

  return null;
}
