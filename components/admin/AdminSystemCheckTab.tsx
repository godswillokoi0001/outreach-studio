"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock,
  Loader2,
  Play,
  RotateCcw,
  Trash2,
  XCircle,
} from "lucide-react";
import type { AdminRole } from "@/lib/platform/types";
import { Badge, Banner, Card, Empty } from "../ui";
import { BrandLoader } from "../BrandLoader";
import { useToast } from "../Feedback";
import { AdminClientError, adminFetch } from "./admin-client";
import {
  AdminClearConfirmModal,
  AdminPaginationBar,
  type ClearRangeOption,
} from "./AdminPaginationBar";

interface SystemCheckItem {
  id: string;
  category: string;
  name: string;
  status: "pass" | "warning" | "fail";
  detail: string;
  checkedAt: string;
  durationMs: number;
  rerunnable?: boolean;
}

interface SystemCheckRun {
  id: string;
  triggeredBy: string;
  triggerType: "manual" | "scheduled" | "single_module";
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
  reauthToken,
  onNeedReauth,
  onAskAiDiagnose,
}: {
  role: AdminRole;
  sessionToken: string;
  reauthToken?: string | null;
  onNeedReauth?: (label: string, retryFn: (freshToken: string) => Promise<void>) => void;
  onAskAiDiagnose?: (promptText: string) => void;
}) {
  const toast = useToast();
  const canRun = role === "admin" || role === "super_admin";

  const [history, setHistory] = useState<SystemCheckRun[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPageSize, setHistoryPageSize] = useState(10);
  const [historySort, setHistorySort] = useState<"newest" | "oldest">("newest");
  const [historyFilter, setHistoryFilter] = useState<"all" | "has_failures" | "manual" | "scheduled">("all");
  const [latestRun, setLatestRun] = useState<SystemCheckRun | null>(null);

  const [schedule, setSchedule] = useState<SystemCheckSchedule>({
    enabled: false,
    intervalMinutes: 60,
  });
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "fail" | "warning" | "pass">("all");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runningModuleId, setRunningModuleId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Clear history modal state
  const [clearModalOpen, setClearModalOpen] = useState(false);
  const [clearRange, setClearRange] = useState<ClearRangeOption>("30d");
  const [clearPreviewCount, setClearPreviewCount] = useState<number | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);

  const loadData = useCallback(async () => {
    setError(null);
    try {
      const qs = new URLSearchParams({
        historyPage: String(historyPage),
        historyPageSize: String(historyPageSize),
        historySort,
        historyFilter,
      });
      const res = await adminFetch<{
        history: SystemCheckRun[];
        historyTotal: number;
        latestRun: SystemCheckRun | null;
        schedule: SystemCheckSchedule;
      }>(`/api/admin/system-check?${qs.toString()}`, { sessionToken });
      setHistory(res.history ?? []);
      setHistoryTotal(res.historyTotal ?? 0);
      setLatestRun(res.latestRun ?? res.history?.[0] ?? null);
      setSchedule(res.schedule ?? { enabled: false, intervalMinutes: 60 });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load system check history.");
    } finally {
      setLoading(false);
    }
  }, [historyPage, historyPageSize, historySort, historyFilter, sessionToken]);

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
          latestRun: SystemCheckRun;
          history: SystemCheckRun[];
          historyTotal: number;
          schedule: SystemCheckSchedule;
        }>("/api/admin/system-check", {
          method: "POST",
          sessionToken,
          body: { action: "run_now", triggerType },
        });
        setLatestRun(res.run);
        setSelectedRunId(res.run.id);
        setSchedule(res.schedule);
        setHistoryPage(1);
        await loadData();
        if (res.run.failCount > 0) {
          toast.error(
            "Validation finished with failures",
            `${res.run.failCount} module(s)/check(s) failed — alert logged to Notifications.`,
          );
        } else {
          toast.success(
            "All modules validated",
            `${res.run.passCount} passed, ${res.run.warningCount} warning(s).`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Validation failed.";
        setError(msg);
        toast.error("Validation error", msg);
      } finally {
        setRunning(false);
      }
    },
    [canRun, running, sessionToken, loadData, toast],
  );

  const rerunModule = async (moduleId: string, moduleName: string) => {
    if (!canRun || running || runningModuleId) return;
    setRunningModuleId(moduleId);
    try {
      const res = await adminFetch<{ item: SystemCheckItem; run: SystemCheckRun }>(
        "/api/admin/system-check",
        {
          method: "POST",
          sessionToken,
          body: { action: "run_module", moduleId },
        },
      );
      setLatestRun(res.run);
      setSelectedRunId(res.run.id);
      await loadData();
      if (res.item.status === "pass") {
        toast.success(`Re-ran ${moduleName}`, res.item.detail);
      } else {
        toast.error(`${moduleName}: ${res.item.status.toUpperCase()}`, res.item.detail);
      }
    } catch (err) {
      toast.error("Could not re-run module", err instanceof Error ? err.message : "Error");
    } finally {
      setRunningModuleId(null);
    }
  };

  const updateSchedule = async (next: SystemCheckSchedule) => {
    try {
      const res = await adminFetch<{ schedule: SystemCheckSchedule }>("/api/admin/system-check", {
        method: "POST",
        sessionToken,
        body: {
          action: "update_schedule",
          enabled: next.enabled,
          intervalMinutes: next.intervalMinutes,
        },
      });
      setSchedule(res.schedule);
      toast.success(
        res.schedule.enabled ? "Auto validation enabled" : "Auto validation paused",
      );
    } catch (err) {
      toast.error("Could not save schedule", err instanceof Error ? err.message : "Error");
    }
  };

  const previewClearHistory = useCallback(
    async (nextRange: ClearRangeOption) => {
      if (!canRun) return;
      setLoadingPreview(true);
      try {
        const res = await adminFetch<{ count: number }>("/api/admin/system-check", {
          method: "POST",
          sessionToken,
          body: { action: "preview_clear_history", range: nextRange },
        });
        setClearPreviewCount(res.count ?? 0);
      } catch (err) {
        toast.error("Could not preview history", err instanceof Error ? err.message : "Error");
      } finally {
        setLoadingPreview(false);
      }
    },
    [canRun, sessionToken, toast],
  );

  const executeClearHistory = async (freshToken?: string) => {
    setClearingHistory(true);
    try {
      const res = await adminFetch<{ removedCount: number }>("/api/admin/system-check", {
        method: "POST",
        sessionToken,
        reauthToken: freshToken ?? reauthToken ?? null,
        body: { action: "clear_history", range: clearRange },
      });
      setClearModalOpen(false);
      setSelectedRunId(null);
      setHistoryPage(1);
      await loadData();
      toast.success("Diagnostic history cleared", `${res.removedCount} run(s) removed.`);
    } catch (err) {
      if (err instanceof AdminClientError && err.code === "ADMIN_REAUTH_REQUIRED" && onNeedReauth) {
        onNeedReauth(`Clear ${clearPreviewCount ?? 0} Diagnostic Check History entries`, (t) =>
          executeClearHistory(t),
        );
        return;
      }
      toast.error("Could not clear history", err instanceof Error ? err.message : "Error");
    } finally {
      setClearingHistory(false);
    }
  };

  if (loading && !latestRun && history.length === 0) return <BrandLoader />;

  const activeRun =
    history.find((h) => h.id === selectedRunId) ??
    (latestRun && latestRun.id === selectedRunId ? latestRun : null) ??
    latestRun ??
    history[0] ??
    null;

  const visibleItems =
    activeRun?.items.filter((i) => statusFilter === "all" || i.status === statusFilter) ?? [];

  return (
    <div className="stack" style={{ gap: 16 }}>
      {error && <Banner tone="bad">{error}</Banner>}

      <Card
        title="Validate Modules & System Diagnostics"
        sub="End-to-end validation across every core module (Onboarding, Knowledge Base, Growth Advisor, Analyse, Campaigns, Leads, Email Rewrite, Ask AI, Narrator, Providers, Auth, Jobs, Storage, DB) with single-module re-runs."
        actions={
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {canRun && (
              <>
                <label className="row tiny" style={{ gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={schedule.enabled}
                    onChange={(e) =>
                      void updateSchedule({ ...schedule, enabled: e.target.checked })
                    }
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
                  {running ? "Validating Modules…" : "Validate All Modules"}
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
                Running live diagnostics and sandbox module checks across the platform…
              </span>
            </div>
          </Banner>
        )}

        {!activeRun ? (
          <Empty title="No Validation Runs Recorded Yet">
            Click <strong>Validate All Modules</strong> to test every core workflow, database table,
            and AI routing component.
          </Empty>
        ) : (
          <div className="stack" style={{ gap: 14 }}>
            {activeRun.failCount > 0 && (
              <Banner tone="bad">
                <strong>{activeRun.failCount} module check(s) failed</strong> at{" "}
                {new Date(activeRun.finishedAt).toLocaleString()}. An admin notification was automatically
                created.
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
                Run by {activeRun.triggeredBy} ({activeRun.triggerType.replace(/_/g, " ")}) ·{" "}
                {new Date(activeRun.finishedAt).toLocaleString()}
              </span>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Module / Check</th>
                    <th>Category</th>
                    <th>Diagnostic Output</th>
                    <th className="num">Duration</th>
                    <th>Actions</th>
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
                      <td>
                        <div className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
                          {canRun && (
                            <button
                              type="button"
                              className="btn btn-sm btn-ghost"
                              disabled={running || runningModuleId !== null}
                              onClick={() => void rerunModule(item.id, item.name)}
                              title="Re-run this module"
                            >
                              {runningModuleId === item.id ? (
                                <Loader2 size={12} className="spin" />
                              ) : (
                                <RotateCcw size={12} />
                              )}
                              <span>Re-run this module</span>
                            </button>
                          )}
                          {item.status !== "pass" && onAskAiDiagnose && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() =>
                                onAskAiDiagnose(
                                  `Diagnose diagnostic failure on "${item.name}" (${item.id}): ${item.detail}`,
                                )
                              }
                              title="Ask Admin AI Assistant to investigate"
                            >
                              <Bot size={12} />
                              <span>Ask AI</span>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Card>

      {/* Paginated Run History */}
      <Card
        title="Check & Diagnostics History"
        sub="Browse, filter, sort, or clear past validation runs"
        actions={
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <select
              className="input"
              aria-label="Filter check history"
              value={historyFilter}
              onChange={(e) => {
                setHistoryFilter(
                  e.target.value as "all" | "has_failures" | "manual" | "scheduled",
                );
                setHistoryPage(1);
              }}
              style={{ width: "auto" }}
            >
              <option value="all">All runs</option>
              <option value="has_failures">With failures only</option>
              <option value="manual">Manual runs</option>
              <option value="scheduled">Scheduled runs</option>
            </select>
            <select
              className="input"
              aria-label="Sort check history"
              value={historySort}
              onChange={(e) => {
                setHistorySort(e.target.value === "oldest" ? "oldest" : "newest");
                setHistoryPage(1);
              }}
              style={{ width: "auto" }}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
            {canRun && historyTotal > 0 && (
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() => {
                  setClearModalOpen(true);
                  void previewClearHistory(clearRange);
                }}
              >
                <Trash2 size={12} />
                <span>Clear History</span>
              </button>
            )}
          </div>
        }
      >
        {history.length === 0 ? (
          <Empty title="No matching check history runs" />
        ) : (
          <>
            <div className="stack" style={{ gap: 6 }}>
              {history.map((run) => {
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
                      <span className="muted">
                        ({run.triggerType.replace(/_/g, " ")} · {run.triggeredBy})
                      </span>
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

            <AdminPaginationBar
              page={historyPage}
              pageSize={historyPageSize}
              totalCount={historyTotal}
              onPageChange={setHistoryPage}
              onPageSizeChange={(next) => {
                setHistoryPageSize(next);
                setHistoryPage(1);
              }}
            />
          </>
        )}
      </Card>

      {canRun && (
        <AdminClearConfirmModal
          open={clearModalOpen}
          title="Clear Check & Diagnostics History"
          description="Removes archived system validation run logs for the chosen range. Does not alter live user data or Admin Audit Logs."
          range={clearRange}
          previewCount={clearPreviewCount}
          loadingPreview={loadingPreview}
          clearing={clearingHistory}
          onRangeChange={(next) => {
            setClearRange(next);
            void previewClearHistory(next);
          }}
          onConfirm={() => void executeClearHistory()}
          onClose={() => setClearModalOpen(false)}
        />
      )}
    </div>
  );
}
