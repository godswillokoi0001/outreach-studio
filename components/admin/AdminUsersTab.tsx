"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Ban,
  CheckCircle2,
  Download,
  Eye,
  Mail,
  RotateCcw,
  Search,
  Trash2,
  UserCheck,
} from "lucide-react";
import type { AdminRole, AdminUserSummary } from "@/lib/platform/types";
import { Badge, Banner, Card, Empty, Field, Modal, Pager } from "../ui";
import { BrandLoader } from "../BrandLoader";
import { useConfirm, useToast } from "../Feedback";
import { AdminClientError, adminFetch } from "./admin-client";

interface UserDetailPayload {
  user: AdminUserSummary & { plan: string; totpEnabled: boolean; usageResetAt: string | null };
  keySourceSummary: {
    mode: "platform" | "personal";
    label: string;
    usageStats?: {
      platformRequestsToday: number;
      platformRequestsMonth: number;
      platformDailyLimit: number;
      platformMonthlyLimit: number;
      personalRequestsMonth: number;
      personalTokensMonth: number;
      personalCostMonthUsd: number;
    };
  };
  campaigns: { id: string; name: string; status: string; created_at: string }[];
  recentActivity: { id: string; action: string; entity: string; entity_id: string; created_at: string }[];
}

export function AdminUsersTab({
  role,
  sessionToken,
  reauthToken,
  onNeedReauth,
}: {
  role: AdminRole;
  sessionToken: string;
  reauthToken: string | null;
  onNeedReauth: (label: string, retryFn: (freshReauthToken: string) => Promise<void>) => void;
}) {
  const confirmDialog = useConfirm();
  const toast = useToast();

  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 15;

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [roleFilter, setRoleFilter] = useState("all");
  const [onboardingFilter, setOnboardingFilter] = useState("all");
  const [keySourceFilter, setKeySourceFilter] = useState("all");
  const [sortBy, setSortBy] = useState("createdAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // User Detail Modal
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detail, setDetail] = useState<UserDetailPayload | null>(null);

  // Bulk Message Modal
  const [bulkMsgOpen, setBulkMsgOpen] = useState(false);
  const [bulkMsgTitle, setBulkMsgTitle] = useState("");
  const [bulkMsgBody, setBulkMsgBody] = useState("");
  const exportCounterRef = useRef(0);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        search,
        status: statusFilter,
        role: roleFilter,
        onboarding: onboardingFilter,
        keySource: keySourceFilter,
        sortBy,
        sortDir,
        page: String(page),
        pageSize: String(pageSize),
      });
      const res = await adminFetch<{ users: AdminUserSummary[]; total: number }>(
        `/api/admin/users?${qs.toString()}`,
        { sessionToken },
      );
      setUsers(res.users);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load users.");
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, roleFilter, onboardingFilter, keySourceFilter, sortBy, sortDir, page, sessionToken]);

  useEffect(() => {
    const t = window.setTimeout(() => void loadUsers(), 0);
    return () => window.clearTimeout(t);
  }, [loadUsers]);

  const openUserDetail = async (ownerId: string) => {
    setDetailOpen(true);
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await adminFetch<UserDetailPayload>(`/api/admin/users/${encodeURIComponent(ownerId)}`, {
        sessionToken,
      });
      setDetail(res);
    } catch (err) {
      toast.error("Could not open user profile", err instanceof Error ? err.message : "Error");
      setDetailOpen(false);
    } finally {
      setDetailLoading(false);
    }
  };

  const runUserPatch = async (
    ownerId: string,
    label: string,
    body: Record<string, unknown>,
    tokenOverride?: string,
  ) => {
    try {
      await adminFetch(`/api/admin/users/${encodeURIComponent(ownerId)}`, {
        method: "PATCH",
        sessionToken,
        reauthToken: tokenOverride ?? reauthToken,
        body,
      });
      toast.success("Action completed", label);
      await loadUsers();
      if (detailOpen && detail?.user.ownerId === ownerId) {
        await openUserDetail(ownerId);
      }
    } catch (err) {
      if (err instanceof AdminClientError && err.code === "ADMIN_REAUTH_REQUIRED") {
        onNeedReauth(label, (fresh) => runUserPatch(ownerId, label, body, fresh));
        return;
      }
      toast.error("Action failed", err instanceof Error ? err.message : "Error");
    }
  };

  const handleDeleteUser = async (ownerId: string, email: string, tokenOverride?: string) => {
    if (!tokenOverride) {
      const ok = await confirmDialog({
        title: `Permanently delete user ${email}?`,
        message: "All of their campaigns, leads, messages, Knowledge Base, and account links will be permanently erased.",
        confirmLabel: "Delete permanently",
        tone: "bad",
      });
      if (!ok) return;
    }

    try {
      await adminFetch(`/api/admin/users/${encodeURIComponent(ownerId)}`, {
        method: "DELETE",
        sessionToken,
        reauthToken: tokenOverride ?? reauthToken,
      });
      toast.success("User deleted", email);
      setDetailOpen(false);
      await loadUsers();
    } catch (err) {
      if (err instanceof AdminClientError && err.code === "ADMIN_REAUTH_REQUIRED") {
        onNeedReauth(`Delete user ${email}`, (fresh) => handleDeleteUser(ownerId, email, fresh));
        return;
      }
      toast.error("Could not delete user", err instanceof Error ? err.message : "Error");
    }
  };

  const handleExportUser = async (ownerId: string, email: string) => {
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(ownerId)}/export`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Export failed.");
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `user-${email.replace(/[^a-z0-9]/gi, "_")}-export.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("User data exported", email);
    } catch (err) {
      toast.error("Export failed", err instanceof Error ? err.message : "Error");
    }
  };

  const runBulkAction = async (
    action: "suspend" | "reactivate" | "export" | "message",
    tokenOverride?: string,
  ) => {
    if (selectedIds.length === 0) return;

    if (!tokenOverride && (action === "suspend" || action === "reactivate")) {
      const ok = await confirmDialog({
        title: `${action === "suspend" ? "Suspend" : "Reactivate"} ${selectedIds.length} selected users?`,
        message: "Suspended users are blocked immediately from logging in or calling AI endpoints.",
        confirmLabel: action === "suspend" ? "Suspend selected" : "Reactivate selected",
        tone: action === "suspend" ? "bad" : "info",
      });
      if (!ok) return;
    }

    try {
      const res = await adminFetch<{ ok: boolean; exported?: unknown[]; updated?: number }>("/api/admin/users", {
        method: "POST",
        sessionToken,
        reauthToken: tokenOverride ?? reauthToken,
        body: {
          action,
          userIds: selectedIds,
          ...(action === "message" ? { title: bulkMsgTitle, message: bulkMsgBody } : {}),
        },
      });

      if (action === "export" && res.exported) {
        const blob = new Blob([JSON.stringify(res.exported, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `bulk-users-export-${++exportCounterRef.current}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success("Bulk export ready");
      } else {
        toast.success("Bulk action completed");
        if (action === "message") {
          setBulkMsgOpen(false);
          setBulkMsgTitle("");
          setBulkMsgBody("");
        }
        setSelectedIds([]);
        await loadUsers();
      }
    } catch (err) {
      if (err instanceof AdminClientError && err.code === "ADMIN_REAUTH_REQUIRED") {
        onNeedReauth(`Bulk ${action}`, (fresh) => runBulkAction(action, fresh));
        return;
      }
      toast.error("Bulk action failed", err instanceof Error ? err.message : "Error");
    }
  };

  const isSupport = role === "support";
  const allVisibleSelected = users.length > 0 && users.every((u) => selectedIds.includes(u.ownerId));

  return (
    <div className="stack" style={{ gap: 14 }}>
      {error && <Banner tone="bad">{error}</Banner>}

      {/* Filter Toolbar */}
      <Card>
        <div className="stack" style={{ gap: 10 }}>
          <div className="grid grid-3" style={{ gap: 10 }}>
            <div style={{ position: "relative" }}>
              <Search size={14} style={{ position: "absolute", left: 10, top: 11, color: "var(--muted)" }} />
              <input
                className="input"
                style={{ paddingLeft: 30 }}
                placeholder="Search name, email or ID…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </div>

            <select
              className="input"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="all">All statuses</option>
              <option value="active">Active only</option>
              <option value="suspended">Suspended only</option>
            </select>

            <select
              className="input"
              value={roleFilter}
              onChange={(e) => {
                setRoleFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="all">All roles</option>
              <option value="user">Regular Users</option>
              <option value="support">Support</option>
              <option value="admin">Admin</option>
              <option value="super_admin">Super Admin</option>
            </select>
          </div>

          <div className="grid grid-3" style={{ gap: 10 }}>
            <select
              className="input"
              value={onboardingFilter}
              onChange={(e) => {
                setOnboardingFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="all">Onboarding: Any</option>
              <option value="completed">Onboarding completed</option>
              <option value="incomplete">Onboarding incomplete</option>
            </select>

            <select
              className="input"
              value={keySourceFilter}
              onChange={(e) => {
                setKeySourceFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="all">Key source: Any</option>
              <option value="platform">Platform key</option>
              <option value="personal">Personal BYOK</option>
            </select>

            <div className="row" style={{ gap: 6 }}>
              <select className="input" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                <option value="createdAt">Sort: Sign-up date</option>
                <option value="lastActiveAt">Sort: Last active</option>
                <option value="aiRequestsMonth">Sort: AI usage</option>
                {!isSupport && <option value="aiCostMonthUsd">Sort: AI cost</option>}
                <option value="name">Sort: Name</option>
              </select>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
              >
                {sortDir === "asc" ? "↑" : "↓"}
              </button>
            </div>
          </div>

          {/* Bulk Actions Bar */}
          {!isSupport && selectedIds.length > 0 && (
            <div
              className="row"
              style={{
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: 8,
                padding: "8px 12px",
                borderRadius: 8,
                background: "var(--surface-2)",
                border: "1px solid var(--teal-deep)",
              }}
            >
              <span className="tiny strong">{selectedIds.length} user(s) selected</span>
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                <button type="button" className="btn btn-sm" onClick={() => void runBulkAction("suspend")}>
                  <Ban size={12} /> Suspend
                </button>
                <button type="button" className="btn btn-sm" onClick={() => void runBulkAction("reactivate")}>
                  <CheckCircle2 size={12} /> Reactivate
                </button>
                <button type="button" className="btn btn-sm" onClick={() => void runBulkAction("export")}>
                  <Download size={12} /> Export JSON
                </button>
                <button type="button" className="btn btn-sm btn-primary" onClick={() => setBulkMsgOpen(true)}>
                  <Mail size={12} /> Message selected
                </button>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Users Table */}
      <Card title={`Users (${total})`} sub="Click any user to inspect activity, usage, and controls">
        {loading && users.length === 0 ? (
          <BrandLoader />
        ) : users.length === 0 ? (
          <Empty title="No matching users found" />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {!isSupport && (
                      <th style={{ width: 32 }}>
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          onChange={(e) =>
                            setSelectedIds(e.target.checked ? users.map((u) => u.ownerId) : [])
                          }
                        />
                      </th>
                    )}
                    <th>User</th>
                    <th>Role & Status</th>
                    <th>Onboarding</th>
                    <th>AI Usage (30d)</th>
                    <th>Key Source</th>
                    <th>Signed up / Active</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.ownerId}>
                      {!isSupport && (
                        <td>
                          <input
                            type="checkbox"
                            checked={selectedIds.includes(u.ownerId)}
                            onChange={(e) =>
                              setSelectedIds((prev) =>
                                e.target.checked
                                  ? [...prev, u.ownerId]
                                  : prev.filter((id) => id !== u.ownerId),
                              )
                            }
                          />
                        </td>
                      )}
                      <td>
                        <div className="strong">{u.name}</div>
                        <div className="tiny muted">{u.email}</div>
                      </td>
                      <td>
                        <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                          <Badge tone={u.role === "super_admin" ? "ok" : u.role !== "user" ? "info" : undefined}>
                            {u.role.replace("_", " ")}
                          </Badge>
                          <Badge tone={u.status === "suspended" ? "bad" : "ok"}>{u.status}</Badge>
                        </div>
                      </td>
                      <td className="tiny">
                        <Badge tone={u.onboardingCompleted ? "ok" : "warn"}>
                          {u.onboardingCompleted ? "Done (100%)" : "Pending"}
                        </Badge>
                      </td>
                      <td className="tiny">
                        <div>{u.aiRequestsMonth} req</div>
                        {!isSupport && <div className="muted">${u.aiCostMonthUsd.toFixed(3)}</div>}
                      </td>
                      <td className="tiny">
                        <Badge tone={u.keySource === "personal" ? "ok" : undefined}>
                          {u.keySource === "personal" ? "Personal key" : "Platform"}
                        </Badge>
                      </td>
                      <td className="tiny muted">
                        <div>In: {new Date(u.createdAt).toLocaleDateString()}</div>
                        <div>Active: {new Date(u.lastActiveAt).toLocaleDateString()}</div>
                      </td>
                      <td>
                        <div className="row" style={{ gap: 4 }}>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => void openUserDetail(u.ownerId)}
                          >
                            <Eye size={12} /> View
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} />
          </>
        )}
      </Card>

      {/* User Detail Modal */}
      <Modal
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        title={detail ? `User Profile: ${detail.user.name}` : "Loading user…"}
        large
      >
        {detailLoading || !detail ? (
          <BrandLoader />
        ) : (
          <div className="stack" style={{ gap: 14 }}>
            <div className="grid grid-3" style={{ gap: 10 }}>
              <div style={{ padding: 10, borderRadius: 8, border: "1px solid var(--line)", background: "var(--surface-2)" }}>
                <div className="tiny muted">Account</div>
                <div className="strong">{detail.user.email}</div>
                <div className="tiny" style={{ marginTop: 4 }}>
                  <Badge tone={detail.user.status === "suspended" ? "bad" : "ok"}>{detail.user.status}</Badge>{" "}
                  <Badge>{detail.user.role.replace("_", " ")}</Badge>
                </div>
              </div>
              <div style={{ padding: 10, borderRadius: 8, border: "1px solid var(--line)", background: "var(--surface-2)" }}>
                <div className="tiny muted">Pipeline Records</div>
                <div className="strong">
                  {detail.user.campaignsCount} campaigns · {detail.user.leadsCount} leads
                </div>
                <div className="tiny muted">{detail.user.analysesCount} analyses run</div>
              </div>
              <div style={{ padding: 10, borderRadius: 8, border: "1px solid var(--line)", background: "var(--surface-2)" }}>
                <div className="tiny muted">AI Key Source &amp; Usage</div>
                <div className="strong">{detail.keySourceSummary.label}</div>
                {!isSupport && (
                  <div className="tiny muted">
                    {detail.user.aiRequestsMonth} req · ${detail.user.aiCostMonthUsd.toFixed(4)}
                  </div>
                )}
              </div>
            </div>

            {!isSupport && (
              <div
                style={{
                  padding: 12,
                  borderRadius: 10,
                  border: "1px solid var(--line)",
                  background: "var(--surface)",
                }}
              >
                <div className="strong tiny" style={{ marginBottom: 8 }}>Admin Actions</div>
                <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      void runUserPatch(
                        detail.user.ownerId,
                        detail.user.status === "suspended" ? "Reactivate user" : "Suspend user",
                        { action: detail.user.status === "suspended" ? "reactivate" : "suspend" },
                      )
                    }
                  >
                    {detail.user.status === "suspended" ? <UserCheck size={12} /> : <Ban size={12} />}
                    {detail.user.status === "suspended" ? "Reactivate account" : "Suspend account"}
                  </button>

                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      void runUserPatch(detail.user.ownerId, "Reset user usage limits", { action: "reset_usage" })
                    }
                  >
                    <RotateCcw size={12} /> Reset usage limits
                  </button>

                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void handleExportUser(detail.user.ownerId, detail.user.email)}
                  >
                    <Download size={12} /> Export data
                  </button>

                  {role === "super_admin" && (
                    <>
                      <select
                        className="input"
                        style={{ width: "auto" }}
                        value={detail.user.role}
                        onChange={(e) =>
                          void runUserPatch(detail.user.ownerId, `Change role to ${e.target.value}`, {
                            action: "change_role",
                            role: e.target.value,
                          })
                        }
                      >
                        <option value="user">Role: User</option>
                        <option value="support">Role: Support</option>
                        <option value="admin">Role: Admin</option>
                        <option value="super_admin">Role: Super Admin</option>
                      </select>

                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        style={{ color: "#b91c1c" }}
                        onClick={() => void handleDeleteUser(detail.user.ownerId, detail.user.email)}
                      >
                        <Trash2 size={12} /> Delete user
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}

            <div className="grid grid-2" style={{ gap: 12 }}>
              <div>
                <div className="strong tiny" style={{ marginBottom: 6 }}>Recent Campaigns ({detail.campaigns.length})</div>
                {detail.campaigns.length === 0 ? (
                  <Empty title="No campaigns" />
                ) : (
                  <div className="stack" style={{ gap: 4 }}>
                    {detail.campaigns.slice(0, 6).map((c) => (
                      <div key={c.id} className="row tiny" style={{ justifyContent: "space-between" }}>
                        <span>{c.name}</span>
                        <Badge>{c.status}</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <div className="strong tiny" style={{ marginBottom: 6 }}>Recent Activity</div>
                {detail.recentActivity.length === 0 ? (
                  <Empty title="No recent activity" />
                ) : (
                  <div className="stack" style={{ gap: 4 }}>
                    {detail.recentActivity.slice(0, 8).map((a) => (
                      <div key={a.id} className="row tiny" style={{ justifyContent: "space-between" }}>
                        <span>{a.action.replace(/_/g, " ")}</span>
                        <span className="muted">{new Date(a.created_at).toLocaleDateString()}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* Bulk Message Modal */}
      <Modal open={bulkMsgOpen} onClose={() => setBulkMsgOpen(false)} title={`Send Notice to ${selectedIds.length} User(s)`}>
        <div className="stack" style={{ gap: 10 }}>
          <Field label="Notice Title">
            <input
              className="input"
              value={bulkMsgTitle}
              onChange={(e) => setBulkMsgTitle(e.target.value)}
              placeholder="e.g. Action required: Workspace update"
            />
          </Field>
          <Field label="Message">
            <textarea
              className="input"
              rows={4}
              value={bulkMsgBody}
              onChange={(e) => setBulkMsgBody(e.target.value)}
              placeholder="Write your notice to selected users…"
            />
          </Field>
          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="btn btn-ghost" onClick={() => setBulkMsgOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!bulkMsgTitle.trim() || !bulkMsgBody.trim()}
              onClick={() => void runBulkAction("message")}
            >
              Send Notice
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
