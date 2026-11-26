"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  Play,
  XCircle,
} from "lucide-react";
import type { AdminRole } from "@/lib/platform/types";
import { Badge, Banner, Card, Empty } from "../ui";
import { BrandLoader } from "../BrandLoader";
import { useToast } from "../Feedback";
import { adminFetch } from "./admin-client";

interface SystemCheckItem {
  id: string;
  category: string;
  name: string;
  status: "pass" | "warning" | "fail";
  detail: string;
  checkedAt: string;
  durationMs: number;
}

interface SystemCheckRun {
  id: string;
  triggeredBy: string;
  triggerType: "manual" | "scheduled";
  startedAt: string;
  finishedAt: string;
  passCount: number;
  warningCount: number;
  failCount: number;
  items: SystemCheckItem[];
}

interface SystemCheckSchedule {
  enabled: boolean;
  intervalMinutes: number;
  lastRunAt?: string;
}

export function AdminSystemCheckTab({
  role,
  sessionToken,
}: {
  role: AdminRole;
  sessionToken: string;
}) {
  const toast = useToast();
  const canRun = role === "admin" || role === "super_admin";

  const [history, setHistory] = useState<SystemCheckRun[]>([]);
  const [schedule, setSchedule] = useState<SystemCheckSchedule>({ enabled: false, intervalMinutes: 60 });
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "fail" | "warning" | "pass">("all");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setError(null);
    try {
      const res = await adminFetch<{ history: SystemCheckRun[]; schedule: SystemCheckSchedule }>(
        "/api/admin/system-check",
        { sessionToken },
      );
      setHistory(res.history ?? []);
      setSchedule(res.schedule ?? { enabled: false, intervalMinutes: 60 });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load system check history.");
    } finally {
      setLoading(false);
    }
  }, [sessionToken]);

  useEffect(() => {
    const t = window.setTimeout(() => void loadData(), 0);
    return () => window.clearTimeout(t);
  }, [loadData]);

  const runNow = useCallback(
    async (triggerType: "manual" | "scheduled" = "manual") => {
      if (!canRun || running) return;
      setRunning(true);
      setError(null);
      try {
        const res = await adminFetch<{
          run: SystemCheckRun;
          history: SystemCheckRun[];
          schedule: SystemCheckSchedule;
        }>("/api/admin/system-check", {
          method: "POST",
          sessionToken,
          body: { action: "run_now", triggerType },
        });
        setHistory(res.history);
        setSchedule(res.schedule);
        setSelectedRunId(res.run.id);
        if (res.run.failCount > 0) {
          toast.error("System Check detected failures", `${res.run.failCount} check(s) failed and generated an admin alert.`);
        } else {
          toast.success("System Check complete", `${res.run.passCount} passed, ${res.run.warningCount} warning(s).`);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "System Check run failed.");
      } finally {
        setRunning(false);
      }
    },
    [canRun, running, sessionToken, toast],
  );

  // Scheduled automated trigger when dashboard is open & interval has elapsed
  useEffect(() => {
    if (!canRun || !schedule.enabled) return;
    const timer = window.setInterval(() => {
      const last = schedule.lastRunAt ? Date.parse(schedule.lastRunAt) : 0;
      const elapsedMin = (Date.now() - last) / 60_000;
      if (!last || elapsedMin >= schedule.intervalMinutes) {
        void runNow("scheduled");
      }
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [canRun, schedule, runNow]);

  const updateSchedule = async (next: SystemCheckSchedule) => {
    try {
      const res = await adminFetch<{ schedule: SystemCheckSchedule }>("/api/admin/system-check", {
        method: "POST",
        sessionToken,
        body: { action: "update_schedule", ...next },
      });
      setSchedule(res.schedule);
      toast.success(
        next.enabled ? "Scheduled System Check enabled" : "Scheduled System Check paused",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update schedule.");
    }
  };

  if (loading && history.length === 0) return <BrandLoader />;

  const activeRun =
    history.find((h) => h.id === selectedRunId) ?? history[0] ?? null;
  const visibleItems =
    activeRun?.items.filter((i) => statusFilter === "all" || i.status === statusFilter) ?? [];

  return (
    <div className="stack" style={{ gap: 16 }}>
      {error && <Banner tone="bad">{error}</Banner>}

      <Card
        title="Automated System Check & Diagnostics"
        sub="Live end-to-end checks for database health, encryption vault, AI provider keys, API error rates, and feature readiness"
        actions={
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {canRun && (
              <>
                <label className="row tiny" style={{ gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={schedule.enabled}
                    onChange={(e) => void updateSchedule({ ...schedule, enabled: e.target.checked })}
                  />
                  Auto-run every
                </label>
                <select
                  className="input"
                  style={{ width: "auto" }}
                  value={schedule.intervalMinutes}
                  onChange={(e) =>
                    void updateSchedule({ ...schedule, intervalMinutes: Number(e.target.value) })
                  }
                >
                  <option value={15}>15m</option>
                  <option value={60}>1h</option>
                  <option value={360}>6h</option>
                  <option value={1440}>24h</option>
                </select>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={running}
                  onClick={() => void runNow("manual")}
                >
                  {running ? <Loader2 size={13} className="spin" /> : <Play size={13} />}
                  {running ? "Running diagnostics…" : "Run System Check"}
                </button>
              </>
            )}
          </div>
        }
      >
        {running && (
          <Banner tone="info">
            <div className="row" style={{ gap: 8 }}>
              <Loader2 size={15} className="spin" />
              <span className="tiny">
                Executing live database, security vault, AI provider, telemetry, and feature diagnostics…
              </span>
            </div>
          </Banner>
        )}

        {!activeRun ? (
          <Empty title="No System Check runs recorded yet">
            Click <strong>Run System Check</strong> to inspect live platform health and create the first baseline report.
          </Empty>
        ) : (
          <div className="stack" style={{ gap: 14 }}>
            {activeRun.failCount > 0 && (
              <Banner tone="bad">
                <strong>{activeRun.failCount} check(s) failed</strong> during run at{" "}
                {new Date(activeRun.finishedAt).toLocaleString()}. An administrator alert was automatically recorded.
              </Banner>
            )}

            <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className={`btn btn-sm ${statusFilter === "all" ? "btn-primary" : ""}`}
                  onClick={() => setStatusFilter("all")}
                >
                  All ({activeRun.items.length})
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${statusFilter === "pass" ? "btn-primary" : ""}`}
                  onClick={() => setStatusFilter("pass")}
                >
                  Pass ({activeRun.passCount})
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${statusFilter === "warning" ? "btn-primary" : ""}`}
                  onClick={() => setStatusFilter("warning")}
                >
                  Warning ({activeRun.warningCount})
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${statusFilter === "fail" ? "btn-primary" : ""}`}
                  onClick={() => setStatusFilter("fail")}
                >
                  Fail ({activeRun.failCount})
                </button>
              </div>
              <span className="tiny muted">
                Run by {activeRun.triggeredBy} ({activeRun.triggerType}) ·{" "}
                {new Date(activeRun.finishedAt).toLocaleString()}
              </span>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Check</th>
                    <th>Category</th>
                    <th>Diagnostic Details</th>
                    <th className="num">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleItems.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <Badge
                          tone={
                            item.status === "pass"
                              ? "ok"
                              : item.status === "warning"
                                ? "warn"
                                : "bad"
                          }
                        >
                          {item.status === "pass" ? (
                            <CheckCircle2 size={11} style={{ marginRight: 4 }} />
                          ) : item.status === "warning" ? (
                            <AlertTriangle size={11} style={{ marginRight: 4 }} />
                          ) : (
                            <XCircle size={11} style={{ marginRight: 4 }} />
                          )}
                          {item.status.toUpperCase()}
                        </Badge>
                      </td>
                      <td className="strong">{item.name}</td>
                      <td className="tiny muted">{item.category}</td>
                      <td className="tiny wrap">{item.detail}</td>
                      <td className="num tiny muted">{item.durationMs}ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Card>

      {/* Run History */}
      {history.length > 0 && (
        <Card title="Past System Check Runs" sub="Select any previous run to inspect its snapshot">
          <div className="stack" style={{ gap: 6 }}>
            {history.slice(0, 10).map((run) => {
              const isSelected = activeRun?.id === run.id;
              return (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => setSelectedRunId(run.id)}
                  style={{
                    textAlign: "left",
                    padding: "8px 12px",
                    borderRadius: 8,
                    border: `1px solid ${isSelected ? "var(--teal-deep)" : "var(--line)"}`,
                    background: isSelected ? "var(--surface-2)" : "var(--surface)",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 8,
                    cursor: "pointer",
                  }}
                >
                  <div className="row tiny" style={{ gap: 8 }}>
                    <Clock size={13} />
                    <span className="strong">{new Date(run.finishedAt).toLocaleString()}</span>
                    <span className="muted">({run.triggerType} · {run.triggeredBy})</span>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <Badge tone="ok">{run.passCount} Pass</Badge>
                    {run.warningCount > 0 && <Badge tone="warn">{run.warningCount} Warn</Badge>}
                    {run.failCount > 0 && <Badge tone="bad">{run.failCount} Fail</Badge>}
                  </div>
                </button>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
