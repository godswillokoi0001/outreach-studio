"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Database,
  Loader2,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { AdminRole } from "@/lib/platform/types";
import type {
  CleanupCategoryId,
  CleanupExecutionReport,
  CleanupScanReport,
  CleanupScheduleConfig,
} from "@/lib/platform/cleanup";
import { Badge, Banner, Card, Empty, Modal } from "../ui";
import { BrandLoader } from "../BrandLoader";
import { useToast } from "../Feedback";
import { AdminClientError, adminFetch } from "./admin-client";

function fmtBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function AdminCleanupTab({
  role,
  sessionToken,
  reauthToken,
  onNeedReauth,
}: {
  role: AdminRole;
  sessionToken: string;
  reauthToken?: string | null;
  onNeedReauth: (label: string, retryFn: (freshToken: string) => Promise<void>) => void;
}) {
  const toast = useToast();
  const canExecute = role === "admin" || role === "super_admin";

  const [retentionDays, setRetentionDays] = useState(30);
  const [scan, setScan] = useState<CleanupScanReport | null>(null);
  const [selectedCategories, setSelectedCategories] = useState<CleanupCategoryId[]>([]);
  const [history, setHistory] = useState<CleanupExecutionReport[]>([]);
  const [schedule, setSchedule] = useState<CleanupScheduleConfig>({
    enabled: false,
    intervalDays: 7,
    retentionDays: 30,
    categories: [],
  });
  const [lastReport, setLastReport] = useState<CleanupExecutionReport | null>(null);

  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [ackSafe, setAckSafe] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    setError(null);
    try {
      const res = await adminFetch<{
        schedule: CleanupScheduleConfig;
        history: CleanupExecutionReport[];
      }>("/api/admin/cleanup", { sessionToken });
      setSchedule(res.schedule);
      setHistory(res.history ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load cleanup state.");
    } finally {
      setLoading(false);
    }
  }, [sessionToken]);

  useEffect(() => {
    const t = window.setTimeout(() => void loadConfig(), 0);
    return () => window.clearTimeout(t);
  }, [loadConfig]);

  const runScan = async () => {
    setScanning(true);
    setError(null);
    try {
      const res = await adminFetch<{ scan: CleanupScanReport }>("/api/admin/cleanup", {
        method: "POST",
        sessionToken,
        body: { action: "scan", retentionDays },
      });
      setScan(res.scan);
      setSelectedCategories(
        res.scan.categories.filter((c) => c.count > 0).map((c) => c.category),
      );
    } catch (err) {
      toast.error("Scan failed", err instanceof Error ? err.message : "Error");
    } finally {
      setScanning(false);
    }
  };

  const executeCleanup = async (freshToken?: string) => {
    if (selectedCategories.length === 0) return;
    setExecuting(true);
    try {
      const res = await adminFetch<{
        report: CleanupExecutionReport;
        history: CleanupExecutionReport[];
      }>("/api/admin/cleanup", {
        method: "POST",
        sessionToken,
        reauthToken: freshToken ?? reauthToken ?? null,
        body: {
          action: "execute",
          categories: selectedCategories,
          retentionDays,
        },
      });
      setConfirmOpen(false);
      setAckSafe(false);
      setLastReport(res.report);
      setHistory(res.history ?? []);
      toast.success(
        "Cleanup completed",
        `Removed ${res.report.removedCount} item(s) (~${fmtBytes(res.report.estimatedBytesFreed)}).`,
      );
      await runScan();
    } catch (err) {
      if (err instanceof AdminClientError && err.code === "ADMIN_REAUTH_REQUIRED") {
        onNeedReauth(
          `Run Safe Database Cleanup (${selectedCategories.length} category/ies)`,
          (t) => executeCleanup(t),
        );
        return;
      }
      toast.error("Cleanup failed", err instanceof Error ? err.message : "Error");
    } finally {
      setExecuting(false);
    }
  };

  const updateAutoSchedule = async (next: CleanupScheduleConfig) => {
    try {
      const res = await adminFetch<{ schedule: CleanupScheduleConfig }>("/api/admin/cleanup", {
        method: "POST",
        sessionToken,
        body: { action: "update_schedule", schedule: next },
      });
      setSchedule(res.schedule);
      toast.success(res.schedule.enabled ? "Auto-cleanup enabled" : "Auto-cleanup paused");
    } catch (err) {
      toast.error("Failed", err instanceof Error ? err.message : "Error");
    }
  };

  if (loading) return <BrandLoader />;

  const selectedCount =
    scan?.categories
      .filter((c) => selectedCategories.includes(c.category))
      .reduce((s, c) => s + c.count, 0) ?? 0;
  const selectedBytes =
    scan?.categories
      .filter((c) => selectedCategories.includes(c.category))
      .reduce((s, c) => s + c.estimatedBytes, 0) ?? 0;

  return (
    <div className="stack" style={{ gap: 16 }}>
      {error && <Banner tone="bad">{error}</Banner>}

      <Banner tone="info">
        <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
          <ShieldCheck size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <div className="tiny">
            <strong>Live-Data Protection Guaranteed:</strong> Cleanup ONLY targets expired tokens,
            stale search cache, temp/failed fallback snapshots, aged finished jobs, orphaned drafts,
            and aged AI logs. Active sessions, user accounts, live leads, campaigns, Knowledge Base
            documents, analyses, personal/platform API keys, and Admin Audit Logs are{" "}
            <strong>never modified or deleted</strong>. A restore-point snapshot is saved automatically
            before every deletion.
          </div>
        </div>
      </Banner>

      <Card
        title="Safe Database Maintenance & Cleanup"
        sub="Scan first to review exact counts and estimated space to be freed before confirming."
        actions={
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <label className="row tiny muted" style={{ gap: 6 }}>
              <span>Retention:</span>
              <select
                className="input"
                aria-label="Retention days"
                value={retentionDays}
                onChange={(e) => setRetentionDays(Number(e.target.value))}
                style={{ width: "auto" }}
              >
                <option value={7}>Older than 7 days</option>
                <option value={30}>Older than 30 days</option>
                <option value={90}>Older than 90 days</option>
              </select>
            </label>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={scanning || executing}
              onClick={() => void runScan()}
            >
              {scanning ? <Loader2 size={13} className="spin" /> : <Search size={13} />}
              <span>{scanning ? "Scanning…" : "Scan Database"}</span>
            </button>
          </div>
        }
      >
        {!scan ? (
          <Empty title="Run a scan first">
            Click <strong>Scan Database</strong> to safely count cleanable temporary, expired, and
            orphaned items without modifying anything.
          </Empty>
        ) : (
          <div className="stack" style={{ gap: 12 }}>
            <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div className="row" style={{ gap: 8 }}>
                <Badge tone="info">
                  Scanned {new Date(scan.scannedAt).toLocaleTimeString()}
                </Badge>
                <Badge tone={scan.totalCount > 0 ? "warn" : "ok"}>
                  {scan.totalCount} cleanable item(s) · ~{fmtBytes(scan.totalEstimatedBytes)}
                </Badge>
              </div>
              {canExecute && selectedCount > 0 && (
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  disabled={executing}
                  onClick={() => setConfirmOpen(true)}
                >
                  <Trash2 size={13} />
                  <span>
                    Clean Selected ({selectedCount} · ~{fmtBytes(selectedBytes)})
                  </span>
                </button>
              )}
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 34 }}>Pick</th>
                    <th>Category</th>
                    <th className="num">Items</th>
                    <th className="num">Est. Size</th>
                    <th>What is included</th>
                  </tr>
                </thead>
                <tbody>
                  {scan.categories.map((cat) => {
                    const checked = selectedCategories.includes(cat.category);
                    return (
                      <tr key={cat.category}>
                        <td>
                          <input
                            type="checkbox"
                            disabled={!canExecute || cat.count === 0}
                            checked={checked}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedCategories((prev) => [...prev, cat.category]);
                              } else {
                                setSelectedCategories((prev) =>
                                  prev.filter((x) => x !== cat.category),
                                );
                              }
                            }}
                          />
                        </td>
                        <td className="strong tiny">{cat.label}</td>
                        <td className="num strong tiny">{cat.count}</td>
                        <td className="num tiny muted">{fmtBytes(cat.estimatedBytes)}</td>
                        <td className="tiny muted">{cat.description}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {lastReport && (
          <div style={{ marginTop: 12 }}>
            <Banner tone="ok">
              <div className="row" style={{ gap: 8 }}>
                <CheckCircle2 size={15} />
                <span className="tiny">
                  <strong>Last Cleanup Report:</strong> Removed {lastReport.removedCount} item(s),
                  freed ~{fmtBytes(lastReport.estimatedBytesFreed)}. Backup snapshot ID:{" "}
                  <code>{lastReport.snapshotId}</code>.
                </span>
              </div>
            </Banner>
          </div>
        )}
      </Card>

      {canExecute && (
        <Card
          title="Optional Auto-Cleanup Schedule"
          sub="When enabled, stale items past retention are eligible for automated maintenance runs (never touching live user data or audit logs)."
        >
          <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <label className="check tiny">
              <input
                type="checkbox"
                checked={schedule.enabled}
                onChange={(e) =>
                  void updateAutoSchedule({ ...schedule, enabled: e.target.checked })
                }
              />
              <span>Enable automatic safe cleanup</span>
            </label>
            <select
              className="input"
              style={{ width: "auto" }}
              value={schedule.intervalDays}
              onChange={(e) =>
                void updateAutoSchedule({ ...schedule, intervalDays: Number(e.target.value) })
              }
            >
              <option value={1}>Daily</option>
              <option value={7}>Weekly</option>
              <option value={30}>Monthly</option>
            </select>
            <select
              className="input"
              style={{ width: "auto" }}
              value={schedule.retentionDays}
              onChange={(e) =>
                void updateAutoSchedule({ ...schedule, retentionDays: Number(e.target.value) })
              }
            >
              <option value={14}>Keep 14 days</option>
              <option value={30}>Keep 30 days</option>
              <option value={90}>Keep 90 days</option>
            </select>
          </div>
        </Card>
      )}

      {history.length > 0 && (
        <Card title="Cleanup Run History" sub="Recent maintenance reports and restore-point snapshots">
          <div className="stack" style={{ gap: 8 }}>
            {history.slice(0, 10).map((h) => (
              <div
                key={h.id}
                className="row"
                style={{
                  justifyContent: "space-between",
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--line)",
                  background: "var(--surface)",
                }}
              >
                <div className="row tiny" style={{ gap: 8 }}>
                  <Database size={13} />
                  <strong>{new Date(h.executedAt).toLocaleString()}</strong>
                  <span className="muted">by {h.executedBy}</span>
                </div>
                <div className="row tiny" style={{ gap: 8 }}>
                  <Badge tone="ok">{h.removedCount} removed</Badge>
                  <Badge>{fmtBytes(h.estimatedBytesFreed)}</Badge>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Confirm Safe Database Cleanup"
      >
        <div className="stack" style={{ gap: 12 }}>
          <Banner tone="warn">
            <div className="row tiny" style={{ gap: 8 }}>
              <AlertTriangle size={15} />
              <span>
                About to remove <strong>{selectedCount}</strong> stale/temp record(s) (~
                {fmtBytes(selectedBytes)}). A restore snapshot will be captured first, and
                re-authentication is enforced.
              </span>
            </div>
          </Banner>
          <div className="stack tiny" style={{ gap: 4 }}>
            {scan?.categories
              .filter((c) => selectedCategories.includes(c.category))
              .map((c) => (
                <div key={c.category} className="row" style={{ justifyContent: "space-between" }}>
                  <span>{c.label}</span>
                  <strong>
                    {c.count} (~{fmtBytes(c.estimatedBytes)})
                  </strong>
                </div>
              ))}
          </div>
          <label className="check tiny">
            <input
              type="checkbox"
              checked={ackSafe}
              onChange={(e) => setAckSafe(e.target.checked)}
            />
            <span>Confirm running safe maintenance cleanup with automatic backup snapshot.</span>
          </label>
          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={!ackSafe || executing}
              onClick={() => void executeCleanup()}
            >
              {executing ? <Loader2 size={13} className="spin" /> : <Calendar size={13} />}
              <span>{executing ? "Cleaning…" : "Execute Cleanup"}</span>
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
