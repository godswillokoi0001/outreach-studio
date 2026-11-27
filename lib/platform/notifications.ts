import { randomBytes } from "node:crypto";
import { supabaseServer } from "../supabase-server";

export type AdminNotificationType =
  | "system_check"
  | "provider_error"
  | "quota_spend"
  | "background_job"
  | "security_auth"
  | "cleanup"
  | "abuse";

export type AdminNotificationSeverity = "low" | "medium" | "high" | "critical";

export interface AdminNotificationRecord {
  id: string;
  ownerId: string;
  type: AdminNotificationType;
  severity: AdminNotificationSeverity;
  title: string;
  message: string;
  dedupKey: string | null;
  count: number;
  targetTab?: string;
  readAt: string | null;
  dismissedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CriticalEmailAlertPrefs {
  enabled: boolean;
  recipientEmail: string;
}

const PLATFORM_ADMIN_OWNER = "__platform_admin__";
const DOC_NOTIFICATIONS = "system_admin_notifications";
const DOC_EMAIL_PREFS = "system_admin_notification_email_prefs";
const DEDUP_WINDOW_MS = 6 * 60 * 60 * 1000;

function mapSqlNotificationRow(r: Record<string, unknown>): AdminNotificationRecord {
  return {
    id: String(r.id ?? ""),
    ownerId: String(r.owner_id ?? PLATFORM_ADMIN_OWNER),
    type: (String(r.type ?? "system_check") as AdminNotificationType) || "system_check",
    severity: (String(r.severity ?? "medium") as AdminNotificationSeverity) || "medium",
    title: String(r.title ?? ""),
    message: String(r.message ?? ""),
    dedupKey: r.dedup_key ? String(r.dedup_key) : null,
    count: Math.max(1, Number(r.count ?? 1)),
    targetTab: r.target_tab ? String(r.target_tab) : undefined,
    readAt: r.read_at ? String(r.read_at) : null,
    dismissedAt: r.dismissed_at ? String(r.dismissed_at) : null,
    createdAt: String(r.created_at ?? new Date().toISOString()),
    updatedAt: String(r.updated_at ?? new Date().toISOString()),
  };
}

async function readFallbackNotifications(): Promise<AdminNotificationRecord[]> {
  if (!supabaseServer) return [];
  const { data } = await supabaseServer
    .from("knowledge")
    .select("content")
    .eq("id", DOC_NOTIFICATIONS)
    .eq("owner_id", PLATFORM_ADMIN_OWNER)
    .maybeSingle();
  const raw = (data as { content?: string } | null)?.content;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AdminNotificationRecord[]) : [];
  } catch {
    return [];
  }
}

async function writeFallbackNotifications(items: AdminNotificationRecord[]): Promise<void> {
  if (!supabaseServer) return;
  await supabaseServer.from("knowledge").upsert(
    {
      id: DOC_NOTIFICATIONS,
      owner_id: PLATFORM_ADMIN_OWNER,
      category: "system_platform_notifications",
      title: "Admin Notifications Feed",
      content: JSON.stringify(items.slice(0, 250)),
      sort: 999,
      is_master: false,
      updated_at: new Date().toISOString(),
    } as never,
    { onConflict: "id" },
  );
}

async function readAllNotificationsRaw(): Promise<{
  items: AdminNotificationRecord[];
  useSql: boolean;
}> {
  if (!supabaseServer) return { items: [], useSql: false };
  const { data, error } = await supabaseServer
    .from("admin_notifications")
    .select("*")
    .eq("owner_id", PLATFORM_ADMIN_OWNER)
    .is("dismissed_at", null)
    .order("updated_at", { ascending: false })
    .limit(400);

  if (!error && Array.isArray(data)) {
    return {
      items: data.map((row) => mapSqlNotificationRow(row as Record<string, unknown>)),
      useSql: true,
    };
  }
  const fallback = (await readFallbackNotifications()).filter((n) => !n.dismissedAt);
  fallback.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { items: fallback, useSql: false };
}

/**
 * Records a grouped/deduped Admin Notification (merges unread alerts sharing `dedupKey` within 6h).
 */
export async function recordAdminNotification(input: {
  type: AdminNotificationType;
  severity: AdminNotificationSeverity;
  title: string;
  message: string;
  dedupKey?: string;
  targetTab?: string;
}): Promise<AdminNotificationRecord | null> {
  if (!supabaseServer) return null;
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const { items, useSql } = await readAllNotificationsRaw();

  const dedupKey = input.dedupKey?.trim() || null;
  const existing = dedupKey
    ? items.find(
        (n) =>
          n.dedupKey === dedupKey &&
          !n.readAt &&
          !n.dismissedAt &&
          nowMs - new Date(n.updatedAt).getTime() <= DEDUP_WINDOW_MS,
      )
    : undefined;

  if (existing) {
    const updated: AdminNotificationRecord = {
      ...existing,
      severity: input.severity,
      title: input.title.slice(0, 180),
      message: input.message.slice(0, 600),
      count: existing.count + 1,
      targetTab: input.targetTab ?? existing.targetTab,
      updatedAt: nowIso,
    };
    if (useSql) {
      await supabaseServer
        .from("admin_notifications")
        .update({
          severity: updated.severity,
          title: updated.title,
          message: updated.message,
          count: updated.count,
          updated_at: updated.updatedAt,
        } as never)
        .eq("id", existing.id);
    } else {
      await writeFallbackNotifications(
        items.map((n) => (n.id === existing.id ? updated : n)),
      );
    }
    return updated;
  }

  const created: AdminNotificationRecord = {
    id: `notif_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`,
    ownerId: PLATFORM_ADMIN_OWNER,
    type: input.type,
    severity: input.severity,
    title: input.title.slice(0, 180),
    message: input.message.slice(0, 600),
    dedupKey,
    count: 1,
    targetTab: input.targetTab,
    readAt: null,
    dismissedAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  if (useSql) {
    const { error } = await supabaseServer.from("admin_notifications").insert({
      id: created.id,
      owner_id: created.ownerId,
      type: created.type,
      severity: created.severity,
      title: created.title,
      message: created.message,
      dedup_key: created.dedupKey,
      count: created.count,
      read_at: null,
      dismissed_at: null,
      created_at: created.createdAt,
      updated_at: created.updatedAt,
    } as never);
    if (!error) return created;
  }

  await writeFallbackNotifications([created, ...items]);
  return created;
}

/**
 * Inspects real failed jobs, repeated admin login failures, and recent AI errors
 * so genuine operational incidents automatically surface as grouped notifications.
 */
export async function syncLiveSystemNotifications(): Promise<void> {
  if (!supabaseServer) return;
  try {
    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const [failedJobsRes, failedLoginsRes, keyErrorsRes] = await Promise.all([
      supabaseServer
        .from("background_jobs")
        .select("id, job_type, error_message, updated_at")
        .eq("status", "failed")
        .gte("updated_at", sinceIso)
        .order("updated_at", { ascending: false })
        .limit(10),
      supabaseServer
        .from("audit_logs")
        .select("id, created_at, detail")
        .eq("owner_id", PLATFORM_ADMIN_OWNER)
        .in("action", ["admin_login_failed", "admin_login_lockout"])
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: false })
        .limit(20),
      supabaseServer
        .from("admin_ai_keys")
        .select("id, provider, label, health_status, last_error")
        .in("health_status", ["cooling_down", "invalid", "exhausted"])
        .limit(15),
    ]);

    const failedJobs = failedJobsRes.data ?? [];
    if (failedJobs.length > 0) {
      const firstErr = String((failedJobs[0] as { error_message?: string }).error_message ?? "Job error");
      await recordAdminNotification({
        type: "background_job",
        severity: failedJobs.length >= 3 ? "high" : "medium",
        title: `${failedJobs.length} failed background job(s) in last 24h`,
        message: `Latest failure: ${firstErr.slice(0, 220)}`,
        dedupKey: "live_failed_jobs_24h",
        targetTab: "health",
      });
    }

    const failedLogins = failedLoginsRes.data ?? [];
    if (failedLogins.length >= 3) {
      await recordAdminNotification({
        type: "security_auth",
        severity: "high",
        title: `${failedLogins.length} failed admin login attempts in last 24h`,
        message: "Inspect Audit Log & Security to review IP addresses and lockouts.",
        dedupKey: "live_admin_login_failures_24h",
        targetTab: "audit",
      });
    }

    const badKeys = keyErrorsRes.data ?? [];
    if (badKeys.length > 0) {
      const labels = badKeys
        .map((k) => String((k as { label?: string; provider?: string }).label || (k as { provider?: string }).provider || "key"))
        .slice(0, 3)
        .join(", ");
      await recordAdminNotification({
        type: "provider_error",
        severity: "medium",
        title: `${badKeys.length} platform AI key(s) cooling down or failing`,
        message: `Affected: ${labels}. Review Providers & Models for key health or quota saturation.`,
        dedupKey: "live_ai_key_health",
        targetTab: "providers",
      });
    }
  } catch {
    /* non-blocking sync */
  }
}

export async function listAdminNotificationsPaginated(options?: {
  page?: number;
  pageSize?: number;
  readFilter?: "all" | "unread" | "read";
  typeFilter?: string;
}): Promise<{
  notifications: AdminNotificationRecord[];
  totalCount: number;
  unreadCount: number;
  recentUnread: AdminNotificationRecord[];
}> {
  await syncLiveSystemNotifications();
  const { items } = await readAllNotificationsRaw();
  const unreadItems = items.filter((n) => !n.readAt);

  let filtered = items;
  if (options?.readFilter === "unread") {
    filtered = filtered.filter((n) => !n.readAt);
  } else if (options?.readFilter === "read") {
    filtered = filtered.filter((n) => Boolean(n.readAt));
  }
  if (options?.typeFilter && options.typeFilter !== "all") {
    filtered = filtered.filter((n) => n.type === options.typeFilter);
  }

  const page = Math.max(1, options?.page ?? 1);
  const pageSize =
    options?.pageSize === 10 || options?.pageSize === 50 ? options.pageSize : 25;
  const from = (page - 1) * pageSize;

  return {
    notifications: filtered.slice(from, from + pageSize),
    totalCount: filtered.length,
    unreadCount: unreadItems.length,
    recentUnread: unreadItems.slice(0, 6),
  };
}

export async function markNotificationsRead(ids?: string[]): Promise<number> {
  if (!supabaseServer) return 0;
  const nowIso = new Date().toISOString();
  const { items, useSql } = await readAllNotificationsRaw();
  const targetSet = ids && ids.length > 0 ? new Set(ids) : null;

  let updatedCount = 0;
  const next = items.map((n) => {
    if (!n.readAt && (!targetSet || targetSet.has(n.id))) {
      updatedCount += 1;
      return { ...n, readAt: nowIso, updatedAt: nowIso };
    }
    return n;
  });

  if (useSql) {
    let q = supabaseServer
      .from("admin_notifications")
      .update({ read_at: nowIso, updated_at: nowIso } as never)
      .eq("owner_id", PLATFORM_ADMIN_OWNER)
      .is("read_at", null);
    if (ids && ids.length > 0) q = q.in("id", ids);
    await q;
  } else {
    await writeFallbackNotifications(next);
  }
  return updatedCount;
}

export async function clearNotifications(range: "all" | "read" | "7d" | "30d"): Promise<number> {
  if (!supabaseServer) return 0;
  const { items, useSql } = await readAllNotificationsRaw();
  const cutoffIso =
    range === "7d"
      ? new Date(Date.now() - 7 * 86400_000).toISOString()
      : range === "30d"
        ? new Date(Date.now() - 30 * 86400_000).toISOString()
        : null;

  const shouldRemove = (n: AdminNotificationRecord) => {
    if (range === "read") return Boolean(n.readAt);
    if (cutoffIso) return n.createdAt < cutoffIso;
    return true;
  };

  const removedIds = items.filter(shouldRemove).map((n) => n.id);
  const remaining = items.filter((n) => !shouldRemove(n));

  if (useSql && removedIds.length > 0) {
    for (let i = 0; i < removedIds.length; i += 200) {
      await supabaseServer
        .from("admin_notifications")
        .delete()
        .eq("owner_id", PLATFORM_ADMIN_OWNER)
        .in("id", removedIds.slice(i, i + 200));
    }
  } else {
    await writeFallbackNotifications(remaining);
  }
  return removedIds.length;
}

export async function getCriticalEmailAlertPrefs(): Promise<CriticalEmailAlertPrefs> {
  if (!supabaseServer) return { enabled: false, recipientEmail: "" };
  const { data } = await supabaseServer
    .from("knowledge")
    .select("content")
    .eq("id", DOC_EMAIL_PREFS)
    .eq("owner_id", PLATFORM_ADMIN_OWNER)
    .maybeSingle();
  const raw = (data as { content?: string } | null)?.content;
  if (!raw) return { enabled: false, recipientEmail: "" };
  try {
    const parsed = JSON.parse(raw) as Partial<CriticalEmailAlertPrefs>;
    return {
      enabled: Boolean(parsed.enabled),
      recipientEmail: String(parsed.recipientEmail ?? ""),
    };
  } catch {
    return { enabled: false, recipientEmail: "" };
  }
}

export async function saveCriticalEmailAlertPrefs(
  prefs: CriticalEmailAlertPrefs,
): Promise<CriticalEmailAlertPrefs> {
  const safe: CriticalEmailAlertPrefs = {
    enabled: Boolean(prefs.enabled),
    recipientEmail: prefs.recipientEmail.trim().toLowerCase(),
  };
  if (supabaseServer) {
    await supabaseServer.from("knowledge").upsert(
      {
        id: DOC_EMAIL_PREFS,
        owner_id: PLATFORM_ADMIN_OWNER,
        category: "system_platform_notifications",
        title: "Critical Admin Email Alert Prefs",
        content: JSON.stringify(safe),
        sort: 999,
        is_master: false,
        updated_at: new Date().toISOString(),
      } as never,
      { onConflict: "id" },
    );
  }
  return safe;
}
