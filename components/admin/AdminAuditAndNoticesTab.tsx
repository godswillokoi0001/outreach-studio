"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Lock, Megaphone, Search, Trash2 } from "lucide-react";
import type { AdminAuditEntry, AdminRole, PlatformAnnouncement } from "@/lib/platform/types";
import { Badge, Banner, Card, Empty, Field } from "../ui";
import { BrandLoader } from "../BrandLoader";
import { useConfirm, useToast } from "../Feedback";
import { adminFetch } from "./admin-client";

export function AdminAuditAndNoticesTab({
  role,
  sessionToken,
  mode = "both",
}: {
  role: AdminRole;
  sessionToken?: string;
  mode?: "announcements" | "audit" | "both";
}) {
  const toast = useToast();
  const confirmDialog = useConfirm();
  const canPublish = role === "admin" || role === "super_admin";

  const [logs, setLogs] = useState<AdminAuditEntry[]>([]);
  const [announcements, setAnnouncements] = useState<PlatformAnnouncement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [tone, setTone] = useState<"info" | "warn" | "ok">("info");
  const [targetGroup, setTargetGroup] = useState<PlatformAnnouncement["targetGroup"]>("all");
  const [publishing, setPublishing] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [overviewRes, annRes] = await Promise.all([
        mode === "announcements"
          ? Promise.resolve({ adminAuditLogs: [] as AdminAuditEntry[] })
          : adminFetch<{ adminAuditLogs: AdminAuditEntry[] }>("/api/admin/overview?range=all", { sessionToken }),
        mode === "audit"
          ? Promise.resolve({ announcements: [] as PlatformAnnouncement[] })
          : adminFetch<{ announcements: PlatformAnnouncement[] }>("/api/admin/announcements", { sessionToken }),
      ]);
      setLogs(overviewRes.adminAuditLogs ?? []);
      setAnnouncements(annRes.announcements ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data.");
    } finally {
      setLoading(false);
    }
  }, [mode, sessionToken]);

  useEffect(() => {
    const t = window.setTimeout(() => void loadAll(), 0);
    return () => window.clearTimeout(t);
  }, [loadAll]);

  const filteredLogs = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return logs;
    return logs.filter(
      (l) =>
        l.actorEmail.toLowerCase().includes(q) ||
        l.action.toLowerCase().includes(q) ||
        l.targetType.toLowerCase().includes(q) ||
        l.targetId.toLowerCase().includes(q) ||
        l.ipAddress.toLowerCase().includes(q),
    );
  }, [logs, search]);

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
      await loadAll();
    } catch (err) {
      toast.error("Could not publish announcement", err instanceof Error ? err.message : "Error");
    } finally {
      setPublishing(false);
    }
  };

  const deactivateNotice = async (id: string) => {
    const ok = await confirmDialog({
      title: "Deactivate announcement?",
      message: "Users will immediately stop seeing this banner in their workspace.",
      confirmLabel: "Deactivate",
      tone: "bad",
    });
    if (!ok) return;
    try {
      await adminFetch(`/api/admin/announcements?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        sessionToken,
      });
      toast.success("Announcement deactivated");
      await loadAll();
    } catch (err) {
      toast.error("Failed", err instanceof Error ? err.message : "Error");
    }
  };

  if (loading && logs.length === 0 && announcements.length === 0) return <BrandLoader />;

  const showAnnouncements = mode === "both" || mode === "announcements";
  const showAudit = mode === "both" || mode === "audit";

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
                      onChange={(e) => setTargetGroup(e.target.value as PlatformAnnouncement["targetGroup"])}
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
                    placeholder="Write a concise user banner…"
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
                <div className="strong tiny">Active &amp; Recent Banners</div>
                {announcements.length === 0 ? (
                  <Empty title="No announcements published" />
                ) : (
                  announcements.slice(0, 8).map((a) => (
                    <div
                      key={a.id}
                      style={{
                        padding: 10,
                        borderRadius: 8,
                        border: "1px solid var(--line)",
                        background: a.active ? "var(--surface)" : "var(--surface-2)",
                        opacity: a.active ? 1 : 0.65,
                      }}
                    >
                      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                        <strong className="tiny">{a.title}</strong>
                        <div className="row" style={{ gap: 6 }}>
                          <Badge tone={a.active ? "ok" : undefined}>{a.active ? "Active" : "Inactive"}</Badge>
                          {a.active && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => void deactivateNotice(a.id)}
                              title="Deactivate"
                            >
                              <Trash2 size={12} />
                            </button>
                          )}
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
              <Banner tone="info">Support role can view announcements but cannot publish or remove them.</Banner>
              {announcements.length === 0 ? (
                <Empty title="No announcements published" />
              ) : (
                announcements.map((a) => (
                  <div key={a.id} style={{ padding: 10, border: "1px solid var(--line)", borderRadius: 8 }}>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <strong className="tiny">{a.title}</strong>
                      <Badge tone={a.active ? "ok" : undefined}>{a.active ? "Active" : "Inactive"}</Badge>
                    </div>
                    <div className="tiny muted" style={{ marginTop: 4 }}>{a.message}</div>
                  </div>
                ))
              )}
            </div>
          )}
        </Card>
      )}

      {showAudit && (
        <Card
          title="Immutable Admin Audit Log"
          sub="Searchable, append-only record of administrative sign-ins, security events, and mutations. Cannot be edited or deleted."
          actions={
            <div className="row" style={{ gap: 8 }}>
              <div style={{ position: "relative" }}>
                <Search
                  size={13}
                  style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }}
                />
                <input
                  className="input"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search email, action, target, IP…"
                  style={{ paddingLeft: 30, minWidth: 240 }}
                />
              </div>
              <Badge tone="info">
                <Lock size={11} style={{ marginRight: 4 }} /> Read-only
              </Badge>
            </div>
          }
        >
          {filteredLogs.length === 0 ? (
            <Empty title={search ? "No matching audit entries" : "No admin audit entries recorded yet"} />
          ) : (
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
                  {filteredLogs.map((entry) => (
                    <tr key={entry.id}>
                      <td className="tiny nowrap">{new Date(entry.createdAt).toLocaleString()}</td>
                      <td className="tiny strong">{entry.actorEmail}</td>
                      <td>
                        <Badge>{entry.actorRole.replace("_", " ")}</Badge>
                      </td>
                      <td className="tiny">{entry.action.replace(/_/g, " ")}</td>
                      <td className="tiny muted">
                        {entry.targetType}: {entry.targetId}
                      </td>
                      <td className="tiny muted">{entry.ipAddress}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
