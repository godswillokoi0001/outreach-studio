"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Bell,
  CheckCheck,
  CheckCircle2,
  Mail,
  Trash2,
} from "lucide-react";
import type { AdminRole } from "@/lib/platform/types";
import type {
  AdminNotificationRecord,
  CriticalEmailAlertPrefs,
} from "@/lib/platform/notifications";
import { Badge, Banner, Card, Empty, Field } from "../ui";
import { BrandLoader } from "../BrandLoader";
import { useConfirm, useToast } from "../Feedback";
import { adminFetch } from "./admin-client";
import { AdminPaginationBar } from "./AdminPaginationBar";

export function AdminNotificationsTab({
  role,
  sessionToken,
  onNavigateTab,
  onUnreadCountChange,
}: {
  role: AdminRole;
  sessionToken: string;
  onNavigateTab?: (tab: string) => void;
  onUnreadCountChange?: (count: number) => void;
}) {
  const toast = useToast();
  const confirmDialog = useConfirm();
  const canManage = role === "admin" || role === "super_admin";

  const [notifications, setNotifications] = useState<AdminNotificationRecord[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [readFilter, setReadFilter] = useState<"all" | "unread" | "read">("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [emailPrefs, setEmailPrefs] = useState<CriticalEmailAlertPrefs>({
    enabled: false,
    recipientEmail: "",
  });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingPrefs, setSavingPrefs] = useState(false);

  const loadNotifications = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        read: readFilter,
        type: typeFilter,
      });
      const res = await adminFetch<{
        notifications: AdminNotificationRecord[];
        totalCount: number;
        unreadCount: number;
        emailPrefs: CriticalEmailAlertPrefs;
      }>(`/api/admin/notifications?${qs.toString()}`, { sessionToken });

      setNotifications(res.notifications ?? []);
      setTotalCount(res.totalCount ?? 0);
      setUnreadCount(res.unreadCount ?? 0);
      setEmailPrefs(res.emailPrefs ?? { enabled: false, recipientEmail: "" });
      onUnreadCountChange?.(res.unreadCount ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load notifications.");
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, readFilter, typeFilter, sessionToken, onUnreadCountChange]);

  useEffect(() => {
    const t = window.setTimeout(() => void loadNotifications(), 0);
    return () => window.clearTimeout(t);
  }, [loadNotifications]);

  const markRead = async (id: string) => {
    try {
      await adminFetch("/api/admin/notifications", {
        method: "POST",
        sessionToken,
        body: { action: "mark_read", id },
      });
      await loadNotifications();
    } catch (err) {
      toast.error("Failed", err instanceof Error ? err.message : "Error");
    }
  };

  const markAllRead = async () => {
    try {
      await adminFetch("/api/admin/notifications", {
        method: "POST",
        sessionToken,
        body: { action: "mark_all_read" },
      });
      toast.success("All notifications marked read");
      await loadNotifications();
    } catch (err) {
      toast.error("Failed", err instanceof Error ? err.message : "Error");
    }
  };

  const clearList = async (range: "read" | "all") => {
    const ok = await confirmDialog({
      title: range === "read" ? "Clear read notifications?" : "Clear all notifications?",
      message:
        range === "read"
          ? "Already-read notifications will be removed from this feed."
          : "Every notification in the admin feed will be cleared.",
      confirmLabel: "Clear notifications",
      tone: "bad",
    });
    if (!ok) return;
    try {
      const res = await adminFetch<{ removed: number }>("/api/admin/notifications", {
        method: "POST",
        sessionToken,
        body: { action: "clear", range },
      });
      toast.success(`Cleared ${res.removed} notification(s)`);
      setPage(1);
      await loadNotifications();
    } catch (err) {
      toast.error("Failed", err instanceof Error ? err.message : "Error");
    }
  };

  const saveEmailAlerts = async (next: CriticalEmailAlertPrefs) => {
    setSavingPrefs(true);
    try {
      const res = await adminFetch<{ emailPrefs: CriticalEmailAlertPrefs }>(
        "/api/admin/notifications",
        {
          method: "POST",
          sessionToken,
          body: {
            action: "update_email_prefs",
            enabled: next.enabled,
            recipientEmail: next.recipientEmail,
          },
        },
      );
      setEmailPrefs(res.emailPrefs);
      toast.success(
        res.emailPrefs.enabled ? "Critical email alerts enabled" : "Critical email alerts paused",
      );
    } catch (err) {
      toast.error("Could not save setting", err instanceof Error ? err.message : "Error");
    } finally {
      setSavingPrefs(false);
    }
  };

  if (loading && notifications.length === 0) return <BrandLoader />;

  const severityTone = (s: AdminNotificationRecord["severity"]) =>
    s === "critical" || s === "high" ? "bad" : s === "medium" ? "warn" : "info";

  return (
    <div className="stack" style={{ gap: 16 }}>
      {error && <Banner tone="bad">{error}</Banner>}

      <Card
        title="Platform Alert Feed & Notifications"
        sub="Grouped operational alerts across failed system checks, provider key failures, background jobs, security events, and cleanup runs."
        actions={
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <Badge tone={unreadCount > 0 ? "bad" : "ok"}>{unreadCount} Unread</Badge>
            <select
              className="input"
              aria-label="Filter notifications by status"
              value={readFilter}
              onChange={(e) => {
                setReadFilter(e.target.value as "all" | "unread" | "read");
                setPage(1);
              }}
              style={{ width: "auto" }}
            >
              <option value="all">All</option>
              <option value="unread">Unread only</option>
              <option value="read">Read only</option>
            </select>
            <select
              className="input"
              aria-label="Filter notifications by type"
              value={typeFilter}
              onChange={(e) => {
                setTypeFilter(e.target.value);
                setPage(1);
              }}
              style={{ width: "auto" }}
            >
              <option value="all">All categories</option>
              <option value="system_check">System Checks</option>
              <option value="provider_error">AI Providers &amp; Keys</option>
              <option value="background_job">Background Jobs</option>
              <option value="security_auth">Security &amp; Logins</option>
              <option value="quota_spend">Quota &amp; Spend</option>
              <option value="cleanup">Database Cleanup</option>
              <option value="abuse">Abuse &amp; Spikes</option>
            </select>
            {unreadCount > 0 && (
              <button type="button" className="btn btn-sm" onClick={() => void markAllRead()}>
                <CheckCheck size={13} />
                <span>Mark all read</span>
              </button>
            )}
            {canManage && notifications.length > 0 && (
              <>
                <button type="button" className="btn btn-sm" onClick={() => void clearList("read")}>
                  Clear Read
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => void clearList("all")}
                >
                  <Trash2 size={12} />
                  <span>Clear All</span>
                </button>
              </>
            )}
          </div>
        }
      >
        {notifications.length === 0 ? (
          <Empty title="No matching admin notifications">
            All real-time checks, background jobs, and provider keys are operating cleanly.
          </Empty>
        ) : (
          <>
            <div className="stack" style={{ gap: 8 }}>
              {notifications.map((n) => (
                <div
                  key={n.id}
                  style={{
                    padding: 12,
                    borderRadius: 10,
                    border: `1px solid ${!n.readAt ? "var(--teal-deep)" : "var(--line)"}`,
                    background: !n.readAt ? "var(--surface)" : "var(--surface-2)",
                  }}
                >
                  <div
                    className="row"
                    style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}
                  >
                    <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      {n.severity === "high" || n.severity === "critical" ? (
                        <AlertTriangle size={14} style={{ color: "var(--bad)" }} />
                      ) : (
                        <Bell size={14} style={{ color: "var(--teal-deep)" }} />
                      )}
                      <span className="strong">{n.title}</span>
                      <Badge tone={severityTone(n.severity)}>{n.severity.toUpperCase()}</Badge>
                      <Badge>{n.type.replace(/_/g, " ")}</Badge>
                      {n.count > 1 && <Badge tone="info">×{n.count} grouped</Badge>}
                      {!n.readAt && <Badge tone="ok">Unread</Badge>}
                    </div>

                    <div className="row" style={{ gap: 6 }}>
                      {n.targetTab && onNavigateTab && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => onNavigateTab(n.targetTab!)}
                        >
                          Open
                        </button>
                      )}
                      {!n.readAt && (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => void markRead(n.id)}
                          title="Mark read"
                        >
                          <CheckCircle2 size={13} />
                          <span>Mark read</span>
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="tiny muted" style={{ marginTop: 4 }}>
                    {n.message}
                  </div>
                  <div className="tiny muted" style={{ marginTop: 4 }}>
                    Updated {new Date(n.updatedAt).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>

            <AdminPaginationBar
              page={page}
              pageSize={pageSize}
              totalCount={totalCount}
              onPageChange={setPage}
              onPageSizeChange={(next) => {
                setPageSize(next);
                setPage(1);
              }}
            />
          </>
        )}
      </Card>

      {canManage && (
        <Card
          title="Critical Alert Email Preference"
          sub="Optionally forward high/critical platform alerts (outages, lockouts, failed system checks) to an admin inbox."
        >
          <div className="row" style={{ gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
            <label className="check">
              <input
                type="checkbox"
                checked={emailPrefs.enabled}
                disabled={savingPrefs}
                onChange={(e) =>
                  void saveEmailAlerts({ ...emailPrefs, enabled: e.target.checked })
                }
              />
              <span>Notify by email for critical alerts</span>
            </label>
            <div style={{ minWidth: 260 }}>
              <Field label="Alert Email Address">
                <input
                  className="input"
                  type="email"
                  value={emailPrefs.recipientEmail}
                  onChange={(e) =>
                    setEmailPrefs((p) => ({ ...p, recipientEmail: e.target.value }))
                  }
                  placeholder="ops-alerts@company.com"
                />
              </Field>
            </div>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={savingPrefs}
              onClick={() => void saveEmailAlerts(emailPrefs)}
              style={{ marginBottom: 14 }}
            >
              <Mail size={13} />
              <span>Save Preference</span>
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}
