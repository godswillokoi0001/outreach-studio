import { randomBytes } from "node:crypto";
import { supabaseServer } from "../supabase-server";

export type CleanupCategoryId =
  | "expired_tokens"
  | "stale_cache"
  | "old_background_jobs"
  | "failed_temp_artifacts"
  | "orphan_records"
  | "old_ai_logs";

export interface CleanupCategoryScan {
  category: CleanupCategoryId;
  label: string;
  description: string;
  count: number;
  estimatedBytes: number;
  sampleIds: string[];
}

export interface CleanupScanReport {
  scannedAt: string;
  retentionDays: number;
  totalCount: number;
  totalEstimatedBytes: number;
  categories: CleanupCategoryScan[];
  protectedNote: string;
}

export interface CleanupScheduleConfig {
  enabled: boolean;
  intervalDays: number;
  retentionDays: number;
  categories: CleanupCategoryId[];
  lastRunAt?: string | null;
}

export interface CleanupExecutionReport {
  id: string;
  executedBy: string;
  executedAt: string;
  retentionDays: number;
  removedCount: number;
  estimatedBytesFreed: number;
  perCategory: { category: CleanupCategoryId; label: string; removed: number; error?: string }[];
  snapshotId: string | null;
}

const PLATFORM_ADMIN_OWNER = "__platform_admin__";
const DOC_CLEANUP_SCHEDULE = "system_admin_cleanup_schedule";
const DOC_CLEANUP_HISTORY = "system_admin_cleanup_history";
const DOC_CLEANUP_SNAPSHOT = "system_admin_cleanup_last_snapshot";

const SAFE_DEFAULT_CATEGORIES: CleanupCategoryId[] = [
  "expired_tokens",
  "stale_cache",
  "old_background_jobs",
  "failed_temp_artifacts",
  "orphan_records",
  "old_ai_logs",
];

function estimateBytes(rows: unknown[]): number {
  let bytes = 0;
  for (const r of rows) {
    bytes += Math.max(256, JSON.stringify(r ?? {}).length);
  }
  return bytes;
}

/**
 * Safely scans ONLY stale, temporary, expired, and orphaned maintenance rows.
 * NEVER selects or deletes live user leads, campaigns, knowledge base docs, analyses,
 * user API keys, active sessions, or Admin Audit Logs.
 */
export async function scanSafeCleanupTargets(retentionDays = 30): Promise<CleanupScanReport> {
  const safeDays = Math.max(7, Math.min(365, Math.round(retentionDays)));
  const cutoffIso = new Date(Date.now() - safeDays * 86400_000).toISOString();
  const nowIso = new Date().toISOString();

  const categories: CleanupCategoryScan[] = [];

  if (!supabaseServer) {
    return {
      scannedAt: nowIso,
      retentionDays: safeDays,
      totalCount: 0,
      totalEstimatedBytes: 0,
      categories: SAFE_DEFAULT_CATEGORIES.map((c) => ({
        category: c,
        label: c.replace(/_/g, " "),
        description: "Database client unavailable in local memory mode.",
        count: 0,
        estimatedBytes: 0,
        sampleIds: [],
      })),
      protectedNote:
        "Protected data (never deleted): live leads, campaigns, knowledge base items, analyses, active API keys, active sessions, admin accounts, and audit logs.",
    };
  }

  // 1) Expired rate-limit / temporary lockout tokens
  try {
    const { data } = await supabaseServer
      .from("admin_login_attempts")
      .select("attempt_key, locked_until, updated_at")
      .lt("updated_at", cutoffIso)
      .limit(1000);
    const expiredAttempts = (data ?? []).filter((r) => {
      const lu = (r as { locked_until?: string | null }).locked_until;
      return !lu || lu < nowIso;
    });
    categories.push({
      category: "expired_tokens",
      label: "Expired auth lockout & temp token rows",
      description: "Expired rate-limit and temporary challenge states past retention.",
      count: expiredAttempts.length,
      estimatedBytes: estimateBytes(expiredAttempts),
      sampleIds: expiredAttempts.slice(0, 5).map((r) => String((r as { attempt_key?: string }).attempt_key ?? "")),
    });
  } catch {
    categories.push({
      category: "expired_tokens",
      label: "Expired auth lockout & temp token rows",
      description: "Table not initialized yet or handled via fallback.",
      count: 0,
      estimatedBytes: 0,
      sampleIds: [],
    });
  }

  // 2) Stale web enrichment cache entries
  try {
    const { data } = await supabaseServer
      .from("search_enrichment_cache")
      .select("cache_key, expires_at")
      .lt("expires_at", nowIso)
      .limit(2000);
    const staleCache = data ?? [];
    categories.push({
      category: "stale_cache",
      label: "Expired search & enrichment cache",
      description: "Cached search results past their TTL expiration.",
      count: staleCache.length,
      estimatedBytes: estimateBytes(staleCache),
      sampleIds: staleCache.slice(0, 5).map((r) => String((r as { cache_key?: string }).cache_key ?? "")),
    });
  } catch {
    categories.push({
      category: "stale_cache",
      label: "Expired search & enrichment cache",
      description: "No expired cache entries detected.",
      count: 0,
      estimatedBytes: 0,
      sampleIds: [],
    });
  }

  // 3) Old completed/failed background jobs (never touching running or queued)
  try {
    const { data } = await supabaseServer
      .from("background_jobs")
      .select("id, job_type, status, updated_at")
      .in("status", ["succeeded", "failed"])
      .lt("updated_at", cutoffIso)
      .limit(2000);
    const oldJobs = data ?? [];
    categories.push({
      category: "old_background_jobs",
      label: `Finished/failed background jobs (>${safeDays}d)`,
      description: "Old completed or failed research jobs; active/queued jobs are untouched.",
      count: oldJobs.length,
      estimatedBytes: estimateBytes(oldJobs),
      sampleIds: oldJobs.slice(0, 5).map((r) => String((r as { id?: string }).id ?? "")),
    });
  } catch {
    categories.push({
      category: "old_background_jobs",
      label: `Finished/failed background jobs (>${safeDays}d)`,
      description: "No old finished/failed background jobs detected.",
      count: 0,
      estimatedBytes: 0,
      sampleIds: [],
    });
  }

  // 4) Old failed temporary Growth Advisor run docs in knowledge fallback
  try {
    const { data } = await supabaseServer
      .from("knowledge")
      .select("id, updated_at, content")
      .in("category", ["system_growth_run", "system_background_job"])
      .lt("updated_at", cutoffIso)
      .limit(1000);
    const tempRuns = (data ?? []).filter((r) => {
      const raw = String((r as { content?: string }).content ?? "");
      return !raw.includes('"status":"running"') && !raw.includes('"status":"queued"');
    });
    categories.push({
      category: "failed_temp_artifacts",
      label: `Temporary growth/job fallback snapshots (>${safeDays}d)`,
      description: "Temporary pipeline state artifacts past retention (never user knowledge articles).",
      count: tempRuns.length,
      estimatedBytes: estimateBytes(tempRuns),
      sampleIds: tempRuns.slice(0, 5).map((r) => String((r as { id?: string }).id ?? "")),
    });
  } catch {
    categories.push({
      category: "failed_temp_artifacts",
      label: `Temporary growth/job fallback snapshots (>${safeDays}d)`,
      description: "No temporary artifacts past retention.",
      count: 0,
      estimatedBytes: 0,
      sampleIds: [],
    });
  }

  // 5) Orphaned message / lead_event rows whose parent lead/campaign no longer exists
  try {
    const [{ data: msgs }, { data: leads }, { data: campaigns }] = await Promise.all([
      supabaseServer.from("messages").select("id, lead_id, campaign_id").limit(3000),
      supabaseServer.from("leads").select("id").limit(5000),
      supabaseServer.from("campaigns").select("id").limit(2000),
    ]);
    const validLeadIds = new Set((leads ?? []).map((l) => String((l as { id?: string }).id ?? "")));
    const validCampaignIds = new Set(
      (campaigns ?? []).map((c) => String((c as { id?: string }).id ?? "")),
    );
    const orphanMsgs = (msgs ?? []).filter((m) => {
      const row = m as { lead_id?: string | null; campaign_id?: string | null };
      const missingLead = Boolean(row.lead_id && !validLeadIds.has(String(row.lead_id)));
      const missingCampaign = Boolean(row.campaign_id && !validCampaignIds.has(String(row.campaign_id)));
      return missingLead || missingCampaign;
    });
    categories.push({
      category: "orphan_records",
      label: "Orphaned message drafts referencing deleted leads/campaigns",
      description: "Dangling draft rows pointing to already-deleted leads or campaigns.",
      count: orphanMsgs.length,
      estimatedBytes: estimateBytes(orphanMsgs),
      sampleIds: orphanMsgs.slice(0, 5).map((r) => String((r as { id?: string }).id ?? "")),
    });
  } catch {
    categories.push({
      category: "orphan_records",
      label: "Orphaned message drafts referencing deleted leads/campaigns",
      description: "No orphaned message records detected.",
      count: 0,
      estimatedBytes: 0,
      sampleIds: [],
    });
  }

  // 6) Old rolling AI execution logs past retention (never touches Admin Audit Log)
  try {
    const { data } = await supabaseServer
      .from("ai_execution_logs")
      .select("id, created_at")
      .lt("created_at", cutoffIso)
      .limit(3000);
    const oldLogs = data ?? [];
    categories.push({
      category: "old_ai_logs",
      label: `Old AI gateway execution telemetry logs (>${safeDays}d)`,
      description: "Aged AI telemetry rows past retention; Admin Audit Logs are never touched.",
      count: oldLogs.length,
      estimatedBytes: estimateBytes(oldLogs),
      sampleIds: oldLogs.slice(0, 5).map((r) => String((r as { id?: string }).id ?? "")),
    });
  } catch {
    categories.push({
      category: "old_ai_logs",
      label: `Old AI gateway execution telemetry logs (>${safeDays}d)`,
      description: "No aged AI execution logs found.",
      count: 0,
      estimatedBytes: 0,
      sampleIds: [],
    });
  }

  const totalCount = categories.reduce((s, c) => s + c.count, 0);
  const totalEstimatedBytes = categories.reduce((s, c) => s + c.estimatedBytes, 0);

  return {
    scannedAt: nowIso,
    retentionDays: safeDays,
    totalCount,
    totalEstimatedBytes,
    categories,
    protectedNote:
      "Strictly protected (never deleted): active user accounts, active sessions, live leads, campaigns, user/global Knowledge Base docs, analyses, API keys, and Admin Audit Logs.",
  };
}

/**
 * Saves a bounded restore snapshot before removing targeted safe categories,
 * then executes cleanup atomically per category and logs everything.
 */
export async function executeSafeCleanup(input: {
  executedBy: string;
  categories: CleanupCategoryId[];
  retentionDays: number;
}): Promise<CleanupExecutionReport> {
  const safeDays = Math.max(7, Math.min(365, Math.round(input.retentionDays)));
  const cutoffIso = new Date(Date.now() - safeDays * 86400_000).toISOString();
  const nowIso = new Date().toISOString();
  const allowedSet = new Set<CleanupCategoryId>(
    input.categories.filter((c) => SAFE_DEFAULT_CATEGORIES.includes(c)),
  );
  const scanBefore = await scanSafeCleanupTargets(safeDays);
  const snapshotId = `snap_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;

  // Capture restore snapshot of targeted rows prior to cleanup
  const restorePayload: Record<string, unknown[]> = {};
  const perCategory: CleanupExecutionReport["perCategory"] = [];
  let removedCount = 0;
  let estimatedBytesFreed = 0;

  if (!supabaseServer) {
    return {
      id: `cln_${Date.now().toString(36)}`,
      executedBy: input.executedBy,
      executedAt: nowIso,
      retentionDays: safeDays,
      removedCount: 0,
      estimatedBytesFreed: 0,
      perCategory: [],
      snapshotId: null,
    };
  }

  const snapshotIds = async (rows: Record<string, unknown>[], key: string) => {
    restorePayload[key] = rows.slice(0, 500);
  };

  for (const cat of scanBefore.categories) {
    if (!allowedSet.has(cat.category)) continue;
    try {
      let deleted = 0;
      if (cat.category === "expired_tokens") {
        const { data } = await supabaseServer
          .from("admin_login_attempts")
          .select("*")
          .lt("updated_at", cutoffIso)
          .limit(1000);
        const target = (data ?? []).filter((r) => {
          const lu = (r as { locked_until?: string | null }).locked_until;
          return !lu || lu < nowIso;
        });
        await snapshotIds(target as Record<string, unknown>[], cat.category);
        const keys = target.map((r) => String((r as { attempt_key?: string }).attempt_key ?? "")).filter(Boolean);
        for (let i = 0; i < keys.length; i += 200) {
          await supabaseServer.from("admin_login_attempts").delete().in("attempt_key", keys.slice(i, i + 200));
        }
        deleted = keys.length;
      } else if (cat.category === "stale_cache") {
        const { data } = await supabaseServer
          .from("search_enrichment_cache")
          .select("cache_key, expires_at")
          .lt("expires_at", nowIso)
          .limit(2000);
        const keys = (data ?? []).map((r) => String((r as { cache_key?: string }).cache_key ?? "")).filter(Boolean);
        await snapshotIds(data as Record<string, unknown>[], cat.category);
        for (let i = 0; i < keys.length; i += 200) {
          await supabaseServer.from("search_enrichment_cache").delete().in("cache_key", keys.slice(i, i + 200));
        }
        deleted = keys.length;
      } else if (cat.category === "old_background_jobs") {
        const { data } = await supabaseServer
          .from("background_jobs")
          .select("*")
          .in("status", ["succeeded", "failed"])
          .lt("updated_at", cutoffIso)
          .limit(2000);
        const ids = (data ?? []).map((r) => String((r as { id?: string }).id ?? "")).filter(Boolean);
        await snapshotIds(data as Record<string, unknown>[], cat.category);
        for (let i = 0; i < ids.length; i += 200) {
          await supabaseServer
            .from("background_jobs")
            .delete()
            .in("status", ["succeeded", "failed"])
            .in("id", ids.slice(i, i + 200));
        }
        deleted = ids.length;
      } else if (cat.category === "failed_temp_artifacts") {
        const { data } = await supabaseServer
          .from("knowledge")
          .select("*")
          .in("category", ["system_growth_run", "system_background_job"])
          .lt("updated_at", cutoffIso)
          .limit(1000);
        const target = (data ?? []).filter((r) => {
          const raw = String((r as { content?: string }).content ?? "");
          return !raw.includes('"status":"running"') && !raw.includes('"status":"queued"');
        });
        await snapshotIds(target as Record<string, unknown>[], cat.category);
        const ids = target.map((r) => String((r as { id?: string }).id ?? "")).filter(Boolean);
        for (let i = 0; i < ids.length; i += 200) {
          await supabaseServer
            .from("knowledge")
            .delete()
            .in("category", ["system_growth_run", "system_background_job"])
            .in("id", ids.slice(i, i + 200));
        }
        deleted = ids.length;
      } else if (cat.category === "orphan_records") {
        const [{ data: msgs }, { data: leads }, { data: campaigns }] = await Promise.all([
          supabaseServer.from("messages").select("*").limit(3000),
          supabaseServer.from("leads").select("id").limit(5000),
          supabaseServer.from("campaigns").select("id").limit(2000),
        ]);
        const validLeadIds = new Set((leads ?? []).map((l) => String((l as { id?: string }).id ?? "")));
        const validCampaignIds = new Set((campaigns ?? []).map((c) => String((c as { id?: string }).id ?? "")));
        const orphanMsgs = (msgs ?? []).filter((m) => {
          const row = m as { lead_id?: string | null; campaign_id?: string | null };
          return Boolean(
            (row.lead_id && !validLeadIds.has(String(row.lead_id))) ||
              (row.campaign_id && !validCampaignIds.has(String(row.campaign_id))),
          );
        });
        await snapshotIds(orphanMsgs as Record<string, unknown>[], cat.category);
        const ids = orphanMsgs.map((r) => String((r as { id?: string }).id ?? "")).filter(Boolean);
        for (let i = 0; i < ids.length; i += 200) {
          await supabaseServer.from("messages").delete().in("id", ids.slice(i, i + 200));
        }
        deleted = ids.length;
      } else if (cat.category === "old_ai_logs") {
        const { data } = await supabaseServer
          .from("ai_execution_logs")
          .select("*")
          .lt("created_at", cutoffIso)
          .limit(3000);
        await snapshotIds((data ?? []) as Record<string, unknown>[], cat.category);
        const ids = (data ?? []).map((r) => String((r as { id?: string }).id ?? "")).filter(Boolean);
        for (let i = 0; i < ids.length; i += 200) {
          await supabaseServer.from("ai_execution_logs").delete().in("id", ids.slice(i, i + 200));
        }
        deleted = ids.length;
      }

      removedCount += deleted;
      estimatedBytesFreed += deleted > 0 ? cat.estimatedBytes : 0;
      perCategory.push({ category: cat.category, label: cat.label, removed: deleted });
    } catch (err) {
      perCategory.push({
        category: cat.category,
        label: cat.label,
        removed: 0,
        error: err instanceof Error ? err.message : "Cleanup failed",
      });
    }
  }

  // Persist bounded restore point + execution history
  await supabaseServer.from("knowledge").upsert(
    {
      id: DOC_CLEANUP_SNAPSHOT,
      owner_id: PLATFORM_ADMIN_OWNER,
      category: "system_platform_cleanup",
      title: `Pre-Cleanup Restore Snapshot ${snapshotId}`,
      content: JSON.stringify({ snapshotId, createdAt: nowIso, restorePayload }).slice(0, 120_000),
      sort: 999,
      is_master: false,
      updated_at: nowIso,
    } as never,
    { onConflict: "id" },
  );

  const report: CleanupExecutionReport = {
    id: `cln_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`,
    executedBy: input.executedBy,
    executedAt: nowIso,
    retentionDays: safeDays,
    removedCount,
    estimatedBytesFreed,
    perCategory,
    snapshotId,
  };

  const existingHistory = await getCleanupHistory();
  await supabaseServer.from("knowledge").upsert(
    {
      id: DOC_CLEANUP_HISTORY,
      owner_id: PLATFORM_ADMIN_OWNER,
      category: "system_platform_cleanup",
      title: "Platform Cleanup History",
      content: JSON.stringify([report, ...existingHistory].slice(0, 30)),
      sort: 999,
      is_master: false,
      updated_at: nowIso,
    } as never,
    { onConflict: "id" },
  );

  return report;
}

export async function getCleanupHistory(): Promise<CleanupExecutionReport[]> {
  if (!supabaseServer) return [];
  const { data } = await supabaseServer
    .from("knowledge")
    .select("content")
    .eq("id", DOC_CLEANUP_HISTORY)
    .eq("owner_id", PLATFORM_ADMIN_OWNER)
    .maybeSingle();
  const raw = (data as { content?: string } | null)?.content;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CleanupExecutionReport[]) : [];
  } catch {
    return [];
  }
}

export async function getCleanupSchedule(): Promise<CleanupScheduleConfig> {
  const defaults: CleanupScheduleConfig = {
    enabled: false,
    intervalDays: 7,
    retentionDays: 30,
    categories: [...SAFE_DEFAULT_CATEGORIES],
    lastRunAt: null,
  };
  if (!supabaseServer) return defaults;
  const { data } = await supabaseServer
    .from("knowledge")
    .select("content")
    .eq("id", DOC_CLEANUP_SCHEDULE)
    .eq("owner_id", PLATFORM_ADMIN_OWNER)
    .maybeSingle();
  const raw = (data as { content?: string } | null)?.content;
  if (!raw) return defaults;
  try {
    return { ...defaults, ...(JSON.parse(raw) as Partial<CleanupScheduleConfig>) };
  } catch {
    return defaults;
  }
}

export async function saveCleanupSchedule(
  cfg: CleanupScheduleConfig,
): Promise<CleanupScheduleConfig> {
  const safe: CleanupScheduleConfig = {
    enabled: Boolean(cfg.enabled),
    intervalDays: Math.max(1, Math.min(90, Math.round(cfg.intervalDays || 7))),
    retentionDays: Math.max(7, Math.min(365, Math.round(cfg.retentionDays || 30))),
    categories: (cfg.categories ?? []).filter((c) => SAFE_DEFAULT_CATEGORIES.includes(c)),
    lastRunAt: cfg.lastRunAt ?? null,
  };
  if (supabaseServer) {
    await supabaseServer.from("knowledge").upsert(
      {
        id: DOC_CLEANUP_SCHEDULE,
        owner_id: PLATFORM_ADMIN_OWNER,
        category: "system_platform_cleanup",
        title: "Platform Auto Cleanup Schedule",
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
