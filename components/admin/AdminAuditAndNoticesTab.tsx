"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, Lock, Megaphone, Search, Trash2 } from "lucide-react";
import type { AdminAuditEntry, AdminRole, PlatformAnnouncement } from "@/lib/platform/types";
import { Badge, Banner, Card, Empty, Field } from "../ui";
import { BrandLoader } from "../BrandLoader";
import { useConfirm, useToast } from "../Feedback";
import { AdminClientError, adminFetch } from "./admin-client";
import {
  AdminClearConfirmModal,
  AdminPaginationBar,
  type ClearRangeOption,
} from "./AdminPaginationBar";

export function AdminAuditAndNoticesTab({
  role,
  sessionToken,
  reauthToken,
  onNeedReauth,
  mode = "both",
}: {
  role: AdminRole;
  sessionToken?: string;
  reauthToken?: string | null;
  onNeedReauth?: (label: string, retryFn: (freshToken: string) => Promise<void>) => void;
  mode?: "announcements" | "audit" | "both";
}) {
  const toast = useToast();
  const confirmDialog = useConfirm();
  const canPublish = role === "admin" || role === "super_admin";
  const isSuperAdmin = role === "super_admin";

  // Server-paginated audit logs state
  const [logs, setLogs] = useState<(AdminAuditEntry & { isPermanent?: boolean })[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [sort, setSort] = useState<"newest" | "oldest">("newest");

  // Announcements state
  const [announcements, setAnnouncements] = useState<PlatformAnnouncement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [tone, setTone] = useState<"info" | "warn" | "ok">("info");
  const [targetGroup, setTargetGroup] = useState<PlatformAnnouncement["targetGroup"]>("all");
  const [publishing, setPublishing] = useState(false);

  // Clear modal state (super_admin only)
  const [clearModalOpen, setClearModalOpen] = useState(false);
  const [clearRange, setClearRange] = useState<ClearRangeOption>("all");
  const [clearPreviewCount, setClearPreviewCount] = useState<number | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [clearingLogs, setClearingLogs] = useState(false);

  const loadAudit = useCallback(async () => {
    if (mode === "announcements") return;
    const qs = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      search: search.trim(),
      role: roleFilter,
      sort,
    });
    const res = await adminFetch<{
      entries: (AdminAuditEntry & { isPermanent?: boolean })[];
      totalCount: number;
    }>(`/api/admin/audit-logs?${qs.toString()}`, { sessionToken });
    setLogs(res.entries ?? []);
    setTotalCount(res.totalCount ?? 0);
  }, [mode, page, pageSize, search, roleFilter, sort, sessionToken]);

  const loadNotices = useCallback(async () => {
    if (mode === "audit") return;
    const res = await adminFetch<{ announcements: PlatformAnnouncement[] }>(
      "/api/admin/announcements",
      { sessionToken },
    );
    setAnnouncements(res.announcements ?? []);
  }, [mode, sessionToken]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await Promise.all([loadAudit(), loadNotices()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data.");
    } finally {
      setLoading(false);
    }
  }, [loadAudit, loadNotices]);

  useEffect(() => {
    const t = window.setTimeout(() => void loadAll(), 0);
    return () => window.clearTimeout(t);
  }, [loadAll]);

  const previewClearCount = useCallback(
    async (nextRange: ClearRangeOption) => {
      if (!isSuperAdmin) return;
      setLoadingPreview(true);
      try {
        const res = await adminFetch<{ count: number }>("/api/admin/audit-logs", {
          method: "POST",
          sessionToken,
          body: { action: "preview_clear", range: nextRange },
        });
        setClearPreviewCount(res.count ?? 0);
      } catch (err) {
        toast.error("Could not preview audit count", err instanceof Error ? err.message : "Error");
      } finally {
        setLoadingPreview(false);
      }
    },
    [isSuperAdmin, sessionToken, toast],
  );

  const openClearModal = () => {
    setClearModalOpen(true);
    void previewClearCount(clearRange);
  };

  const executeClearLogs = async (freshToken?: string) => {
    if (!isSuperAdmin) return;
    setClearingLogs(true);
    try {
      const res = await adminFetch<{ removedCount: number; summary: string }>(
        "/api/admin/audit-logs",
        {
          method: "POST",
          sessionToken,
          reauthToken: freshToken ?? reauthToken ?? null,
          body: { action: "clear", range: clearRange },
        },
      );
      setClearModalOpen(false);
      toast.success("Audit log cleared", res.summary);
      setPage(1);
      await loadAudit();
    } catch (err) {
      if (err instanceof AdminClientError && err.code === "ADMIN_REAUTH_REQUIRED" && onNeedReauth) {
        onNeedReauth(`Clear ${clearPreviewCount ?? 0} Admin Audit Log entries`, (t) =>
          executeClearLogs(t),
        );
        return;
      }
      toast.error("Could not clear audit log", err instanceof Error ? err.message : "Error");
    } finally {
      setClearingLogs(false);
    }
  };

  const downloadCsv = () => {
    const qs = new URLSearchParams({
      search: search.trim(),
      role: roleFilter,
      sort,
      format: "csv",
    });
    window.open(`/api/admin/audit-logs?${qs.toString()}`, "_blank", "noopener,noreferrer");
  };

  const publishNotice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !message.trim()) return;
    setPublishing(true);
    try {
      await adminFetch("/api/admin/announcements", {
        method: "POST",
        sessionToken,
        body: { title, message, tone, targetGroup },
      });
      setTitle("");
      setMessage("");
      toast.success("Announcement published", `Target group: ${targetGroup}`);
      await loadNotices();
    } catch (err) {
      toast.error("Could not publish announcement", err instanceof Error ? err.message : "Error");
    } finally {
      setPublishing(false);
    }
  };

  const deactivateNotice = async (id: string) => {
    const ok = await confirmDialog({
      title: "Deactivate announcement?",
      message: "Users will immediately stop seeing this notice in their workspace.",
      confirmLabel: "Deactivate",
      tone: "bad",
    });
    if (!ok) return;
    try {
      await adminFetch(`/api/admin/announcements?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        sessionToken,
      });
      toast.success("Announcement removed");
      await loadNotices();
    } catch (err) {
      toast.error("Failed", err instanceof Error ? err.message : "Error");
    }
  };

  if (loading && logs.length === 0 && announcements.length === 0) return <BrandLoader />;

  const showAnnouncements = mode === "both" || mode === "announcements";
  const showAudit = mode === "both" || mode === "audit";
  const activeAnnouncements = announcements.filter((a) => a.active);

  return (
    <div className="stack" style={{ gap: 16 }}>
      {error && <Banner tone="bad">{error}</Banner>}

      {showAnnouncements && (
        <Card
          title="User Announcements"
          sub="Send clean, targeted notices to all users or specific onboarding cohorts."
        >
          {canPublish ? (
            <div className="grid grid-2" style={{ gap: 16 }}>
              <form onSubmit={publishNotice} className="stack" style={{ gap: 10 }}>
                <Field label="Title">
                  <input
                    className="input"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. Scheduled maintenance tonight"
                  />
                </Field>
                <div className="grid grid-2" style={{ gap: 8 }}>
                  <Field label="Audience">
                    <select
                      className="input"
                      value={targetGroup}
                      onChange={(e) =>
                        setTargetGroup(e.target.value as PlatformAnnouncement["targetGroup"])
                      }
                    >
                      <option value="all">All users</option>
                      <option value="active">Active users</option>
                      <option value="incomplete_onboarding">Incomplete onboarding</option>
                    </select>
                  </Field>
                  <Field label="Tone">
                    <select
                      className="input"
                      value={tone}
                      onChange={(e) => setTone(e.target.value as "info" | "warn" | "ok")}
                    >
                      <option value="info">Info</option>
                      <option value="ok">Positive</option>
                      <option value="warn">Warning</option>
                    </select>
                  </Field>
                </div>
                <Field label="Message">
                  <textarea
                    className="input"
                    rows={3}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="Write a concise user announcement…"
                  />
                </Field>
                <button
                  type="submit"
                  className="btn btn-primary btn-sm"
                  disabled={publishing || !title.trim() || !message.trim()}
                >
                  <Megaphone size={13} />
                  {publishing ? "Publishing…" : "Publish announcement"}
                </button>
              </form>

              <div className="stack" style={{ gap: 8 }}>
                <div className="strong tiny">Active Announcements</div>
                {activeAnnouncements.length === 0 ? (
                  <Empty title="No active user announcements" />
                ) : (
                  activeAnnouncements.map((a) => (
                    <div
                      key={a.id}
                      style={{
                        padding: 10,
                        borderRadius: 8,
                        border: "1px solid var(--line)",
                        background: "var(--surface)",
                      }}
                    >
                      <div
                        className="row"
                        style={{ justifyContent: "space-between", alignItems: "center", gap: 6 }}
                      >
                        <strong className="tiny">{a.title}</strong>
                        <div className="row" style={{ gap: 6 }}>
                          <Badge tone="ok">Active</Badge>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => void deactivateNotice(a.id)}
                            title="Deactivate announcement"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>
                      <div className="tiny muted" style={{ marginTop: 3 }}>
                        {a.message}
                      </div>
                      <div className="tiny muted" style={{ marginTop: 4 }}>
                        Target: {a.targetGroup} · By {a.createdByEmail}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              <Banner tone="info">
                Support role can view active announcements but cannot publish or remove them.
              </Banner>
              {activeAnnouncements.length === 0 ? (
                <Empty title="No active user announcements" />
              ) : (
                activeAnnouncements.map((a) => (
                  <div
                    key={a.id}
                    style={{ padding: 10, border: "1px solid var(--line)", borderRadius: 8 }}
                  >
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <strong className="tiny">{a.title}</strong>
                      <Badge tone="ok">Active</Badge>
                    </div>
                    <div className="tiny muted" style={{ marginTop: 4 }}>
                      {a.message}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </Card>
      )}

      {showAudit && (
        <Card
          title="Admin Audit Log"
          sub="Searchable security & administrative log. Clear operations are restricted to Super Admin with 2FA re-auth and leave a permanent record."
          actions={
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <div style={{ position: "relative" }}>
                <Search
                  size={13}
                  style={{
                    position: "absolute",
                    left: 10,
                    top: "50%",
                    transform: "translateY(-50%)",
                    color: "var(--muted)",
                  }}
                />
                <input
                  className="input"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  placeholder="Search email, action, target, IP…"
                  style={{ paddingLeft: 30, minWidth: 210 }}
                />
              </div>

              <select
                className="input"
                aria-label="Filter by admin role"
                value={roleFilter}
                onChange={(e) => {
                  setRoleFilter(e.target.value);
                  setPage(1);
                }}
                style={{ width: "auto" }}
              >
                <option value="all">All roles</option>
                <option value="super_admin">Super Admin</option>
                <option value="admin">Admin</option>
                <option value="support">Support</option>
              </select>

              <select
                className="input"
                aria-label="Sort audit entries"
                value={sort}
                onChange={(e) => {
                  setSort(e.target.value === "oldest" ? "oldest" : "newest");
                  setPage(1);
                }}
                style={{ width: "auto" }}
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
              </select>

              <button type="button" className="btn btn-sm" onClick={downloadCsv}>
                <Download size={12} />
                <span>CSV</span>
              </button>

              {isSuperAdmin ? (
                <button type="button" className="btn btn-sm btn-danger" onClick={openClearModal}>
                  <Trash2 size={12} />
                  <span>Clear Log</span>
                </button>
              ) : (
                <Badge tone="info">
                  <Lock size={11} style={{ marginRight: 4 }} /> Read-only
                </Badge>
              )}
            </div>
          }
        >
          {logs.length === 0 ? (
            <Empty title={search || roleFilter !== "all" ? "No matching audit entries" : "No admin audit entries recorded yet"} />
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Actor</th>
                      <th>Role</th>
                      <th>Action</th>
                      <th>Target</th>
                      <th>IP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((entry) => (
                      <tr key={entry.id}>
                        <td className="tiny nowrap">
                          {new Date(entry.createdAt).toLocaleString()}
                        </td>
                        <td className="tiny strong">{entry.actorEmail}</td>
                        <td>
                          <Badge>{entry.actorRole.replace("_", " ")}</Badge>
                        </td>
                        <td className="tiny">
                          <div className="row" style={{ gap: 6, alignItems: "center" }}>
                            <span>{entry.action.replace(/_/g, " ")}</span>
                            {entry.isPermanent && <Badge tone="warn">Permanent</Badge>}
                          </div>
                        </td>
                        <td className="tiny muted">
                          {typeof entry.details?.summary === "string"
                            ? entry.details.summary
                            : `${entry.targetType}: ${entry.targetId}`}
                        </td>
                        <td className="tiny muted">{entry.ipAddress}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
      )}

      {isSuperAdmin && (
        <AdminClearConfirmModal
          open={clearModalOpen}
          title="Clear Admin Audit Log"
          description="Only Super Admins can clear non-permanent audit log entries. Re-authentication is required, and a permanent unclearable audit entry will record this clear action."
          range={clearRange}
          previewCount={clearPreviewCount}
          loadingPreview={loadingPreview}
          clearing={clearingLogs}
          canDownloadCsv
          onDownloadCsv={downloadCsv}
          onRangeChange={(nextRange) => {
            setClearRange(nextRange);
            void previewClearCount(nextRange);
          }}
          onConfirm={() => void executeClearLogs()}
          onClose={() => setClearModalOpen(false)}
        />
      )}
    </div>
  );
}
