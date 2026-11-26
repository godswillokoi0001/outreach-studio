"use client";

import { useCallback, useEffect, useState } from "react";
import { Lock, Megaphone, Trash2 } from "lucide-react";
import type { AdminAuditEntry, AdminRole, PlatformAnnouncement } from "@/lib/platform/types";
import { Badge, Banner, Card, Empty, Field } from "../ui";
import { BrandLoader } from "../BrandLoader";
import { useToast } from "../Feedback";
import { adminFetch } from "./admin-client";

export function AdminAuditAndNoticesTab({
  role,
  sessionToken,
}: {
  role: AdminRole;
  sessionToken: string;
}) {
  const toast = useToast();
  const canPublish = role === "admin" || role === "super_admin";

  const [logs, setLogs] = useState<AdminAuditEntry[]>([]);
  const [announcements, setAnnouncements] = useState<PlatformAnnouncement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
        adminFetch<{ adminAuditLogs: AdminAuditEntry[] }>("/api/admin/overview?range=all", { sessionToken }),
        adminFetch<{ announcements: PlatformAnnouncement[] }>("/api/admin/announcements", { sessionToken }),
      ]);
      setLogs(overviewRes.adminAuditLogs ?? []);
      setAnnouncements(annRes.announcements ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audit log & notices.");
    } finally {
      setLoading(false);
    }
  }, [sessionToken]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

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

  if (loading && logs.length === 0) return <BrandLoader />;

  return (
    <div className="stack" style={{ gap: 16 }}>
      {error && <Banner tone="bad">{error}</Banner>}

      {/* Announcements Manager */}
      {canPublish && (
        <Card
          title="Platform Announcements & Notices"
          sub="Send banners to all users or specific groups (e.g. incomplete onboarding)"
        >
          <div className="grid grid-2" style={{ gap: 16 }}>
            <form onSubmit={publishNotice} className="stack" style={{ gap: 10 }}>
              <Field label="Title">
                <input
                  className="input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. New Anthropic Claude 3.7 Sonnet enabled"
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
                    <option value="incomplete_onboarding">Users with incomplete onboarding</option>
                  </select>
                </Field>
                <Field label="Tone">
                  <select className="input" value={tone} onChange={(e) => setTone(e.target.value as "info" | "warn" | "ok")}>
                    <option value="info">Info (Blue)</option>
                    <option value="ok">Positive (Green)</option>
                    <option value="warn">Warning (Amber)</option>
                  </select>
                </Field>
              </div>
              <Field label="Message">
                <textarea
                  className="input"
                  rows={3}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Write your notice…"
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
              <div className="strong tiny">Active &amp; Recent Announcements</div>
              {announcements.length === 0 ? (
                <Empty title="No announcements published" />
              ) : (
                announcements.slice(0, 6).map((a) => (
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
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="tiny muted" style={{ marginTop: 3 }}>{a.message}</div>
                    <div className="tiny muted" style={{ marginTop: 4 }}>
                      Target: {a.targetGroup} · By {a.createdByEmail}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </Card>
      )}

      {/* Immutable Admin Audit Log */}
      <Card
        title="Immutable Admin Audit Log"
        sub="Every administrative action (who, what, when, and originating IP) is permanently appended. Admins cannot edit or delete this log."
        actions={
          <Badge tone="info">
            <Lock size={11} style={{ marginRight: 4 }} /> Append-only
          </Badge>
        }
      >
        {logs.length === 0 ? (
          <Empty title="No admin audit entries recorded yet" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Role</th>
                  <th>Action</th>
                  <th>Target</th>
                  <th>From (IP)</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((entry) => (
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
    </div>
  );
}
