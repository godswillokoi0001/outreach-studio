import { randomBytes } from "node:crypto";
import { Type, type FunctionDeclaration } from "@google/genai";
import type { AgentContent } from "@/lib/agent-meta";
import { listAdminAiKeys, listAiExecutionLogs } from "@/lib/llm/store";
import { supabaseServer } from "@/lib/supabase-server";
import { scanSafeCleanupTargets } from "./cleanup";
import { MODULE_VALIDATORS, runSingleModuleCheck } from "./module-validator";
import {
  listAdminNotificationsPaginated,
  markNotificationsRead,
} from "./notifications";
import {
  appendAdminAuditLog,
  computePlatformHealthAndAlerts,
  getInternalPlatformPolicy,
  listAdminAuditLogs,
  listAdminUsersDirectory,
  listAiUsageEvents,
} from "./store-server";
import type { AdminRole } from "./types";

const PLATFORM_ADMIN_OWNER = "__platform_admin__";

export interface AdminChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  responseTimeMs?: number;
  proposedDiffs?: {
    title: string;
    filePath: string;
    evidence: "confirmed" | "likely";
    beforeSnippet: string;
    afterSnippet: string;
    explanation: string;
  }[];
  toolActions?: {
    id: string;
    name: string;
    status: "done" | "awaiting_confirmation" | "cancelled" | "error";
    summary?: string;
    args?: Record<string, unknown>;
  }[];
}

export interface AdminChatConversation {
  id: string;
  adminId: string;
  title: string;
  messages: AdminChatMessage[];
  contents: AgentContent[];
  createdAt: string;
  updatedAt: string;
}

const SECRET_PATTERNS: RegExp[] = [
  /enc:v1:[A-Za-z0-9+/=:_-]+/g,
  /scrypt:[A-Za-z0-9:_-]+/g,
  /\$2[aby]\$\d+\$[A-Za-z0-9./]+/g,
  /\b(AIza[0-9A-Za-z_-]{16,})\b/g,
  /\b(sk-[A-Za-z0-9_-]{12,})\b/g,
  /\b(gsk_[A-Za-z0-9_-]{12,})\b/g,
  /\b(nvapi-[A-Za-z0-9_-]{12,})\b/g,
  /\b(Bearer\s+[A-Za-z0-9._-]{16,})\b/gi,
];

/**
 * Redacts API keys, password hashes, encryption tokens, and optional PII
 * before supplying logs or diagnostics to the Admin AI Assistant.
 */
export function redactAdminChatText(raw: string, supportCaseId?: string | null): string {
  let out = raw;
  for (const pat of SECRET_PATTERNS) {
    out = out.replace(pat, "[REDACTED_SECRET]");
  }
  if (!supportCaseId?.trim()) {
    // Mask non-admin user emails unless an explicit support case ticket is referenced
    out = out.replace(
      /([a-zA-Z0-9._%+-]{2})[a-zA-Z0-9._%+-]*@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g,
      "$1***@$2",
    );
  }
  return out;
}

export const ADMIN_CHAT_READ_ONLY_TOOLS = new Set([
  "get_system_health",
  "list_recent_admin_notifications",
  "list_background_jobs",
  "read_audit_and_error_logs",
  "run_cleanup_scan",
]);

export const ADMIN_CHAT_CONFIRM_TOOLS = new Set([
  "rerun_module_check",
  "retry_failed_job",
  "clear_stuck_job",
  "propose_code_or_config_fix",
  "mark_notification_resolved",
]);

export const ADMIN_ASSISTANT_TOOLS: FunctionDeclaration[] = [
  {
    name: "get_system_health",
    description:
      "Read-only summary of current AI gateway error rate, provider key health, active alerts, and latency.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "list_recent_admin_notifications",
    description: "Read-only list of recent grouped system notifications and unread count.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        onlyUnread: { type: Type.BOOLEAN, description: "Only list unread notifications." },
      },
    },
  },
  {
    name: "list_background_jobs",
    description:
      "Read-only list of recent, stuck, or failed background jobs across Growth Research and pipelines.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        statusFilter: {
          type: Type.STRING,
          description: "all | failed | running | queued",
        },
      },
    },
  },
  {
    name: "read_audit_and_error_logs",
    description:
      "Read-only sanitized inspection of recent Admin Audit Logs and recent AI execution failures (all secrets & tokens redacted).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        limit: { type: Type.NUMBER, description: "Max items to return (default 15)." },
      },
    },
  },
  {
    name: "run_cleanup_scan",
    description: "Read-only scan of cleanable stale/expired/orphaned database records.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        retentionDays: { type: Type.NUMBER, description: "Retention days threshold (default 30)." },
      },
    },
  },
  {
    name: "rerun_module_check",
    description:
      "Re-run a specific platform module validation check (requires administrator confirmation before running).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        moduleId: {
          type: Type.STRING,
          description: `Module ID from: ${MODULE_VALIDATORS.map((m) => m.id).join(", ")}`,
        },
      },
      required: ["moduleId"],
    },
  },
  {
    name: "clear_stuck_job",
    description:
      "Cancel/mark a stuck background job as failed so users can restart cleanly (requires confirmation).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        jobId: { type: Type.STRING, description: "ID of the stuck background job." },
        reason: { type: Type.STRING, description: "Short reason shown in the job error message." },
      },
      required: ["jobId"],
    },
  },
  {
    name: "retry_failed_job",
    description: "Reset a failed background job note or mark notification acknowledged (requires confirmation).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        jobId: { type: Type.STRING, description: "ID of the failed job." },
      },
      required: ["jobId"],
    },
  },
  {
    name: "mark_notification_resolved",
    description: "Mark one admin notification ID as read/acknowledged (requires confirmation).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        notificationId: { type: Type.STRING, description: "Notification ID to mark read." },
      },
      required: ["notificationId"],
    },
  },
  {
    name: "propose_code_or_config_fix",
    description:
      "Present a reviewable unified diff or config remediation proposal with confirmed vs likely evidence (requires confirmation before applying/recording).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING },
        filePath: { type: Type.STRING },
        evidence: { type: Type.STRING, description: "confirmed | likely" },
        beforeSnippet: { type: Type.STRING },
        afterSnippet: { type: Type.STRING },
        explanation: { type: Type.STRING },
      },
      required: ["title", "filePath", "evidence", "beforeSnippet", "afterSnippet", "explanation"],
    },
  },
];

export async function executeAdminChatTool(input: {
  name: string;
  args: Record<string, unknown>;
  adminId: string;
  adminEmail: string;
  adminRole: AdminRole;
  supportCaseId?: string | null;
}): Promise<{ ok: boolean; summary: string; data: Record<string, unknown> }> {
  const { name, args } = input;

  if (name === "get_system_health") {
    const [users, events, policy, poolKeys] = await Promise.all([
      listAdminUsersDirectory(),
      listAiUsageEvents({ sinceIso: new Date(Date.now() - 24 * 3600_000).toISOString(), limit: 500 }),
      getInternalPlatformPolicy(),
      listAdminAiKeys(),
    ]);
    const health = await computePlatformHealthAndAlerts(users, events, policy);
    const poolSummary = poolKeys.map((k) => ({
      provider: k.provider,
      label: k.label,
      healthStatus: k.healthStatus,
      lastError: k.lastError ? redactAdminChatText(k.lastError, input.supportCaseId) : null,
    }));
    return {
      ok: true,
      summary: `Error rate ${health.errorRatePct}%, avg latency ${health.avgLatencyMs}ms, ${health.alerts.length} alert(s), ${poolKeys.length} pooled key(s).`,
      data: {
        confirmed: true,
        errorRatePct: health.errorRatePct,
        avgLatencyMs: health.avgLatencyMs,
        failedJobsCount: health.failedJobsCount,
        alerts: health.alerts,
        pooledKeys: poolSummary,
      },
    };
  }

  if (name === "list_recent_admin_notifications") {
    const onlyUnread = Boolean(args.onlyUnread);
    const res = await listAdminNotificationsPaginated({
      page: 1,
      pageSize: 15,
      readFilter: onlyUnread ? "unread" : "all",
    });
    return {
      ok: true,
      summary: `${res.unreadCount} unread / ${res.totalCount} total notification(s).`,
      data: {
        confirmed: true,
        unreadCount: res.unreadCount,
        notifications: res.notifications.map((n) => ({
          id: n.id,
          type: n.type,
          severity: n.severity,
          title: n.title,
          message: redactAdminChatText(n.message, input.supportCaseId),
          count: n.count,
          readAt: n.readAt,
          updatedAt: n.updatedAt,
        })),
      },
    };
  }

  if (name === "list_background_jobs") {
    if (!supabaseServer) {
      return { ok: false, summary: "Database unavailable.", data: { error: "DB unavailable" } };
    }
    const statusFilter = String(args.statusFilter ?? "all").toLowerCase();
    let q = supabaseServer
      .from("background_jobs")
      .select("id, job_type, status, current_step, progress_pct, error_message, started_at, updated_at")
      .order("updated_at", { ascending: false })
      .limit(20);
    if (statusFilter !== "all") {
      q = q.eq("status", statusFilter);
    }
    const { data, error } = await q;
    if (error) {
      return { ok: false, summary: error.message, data: { error: error.message } };
    }
    const jobs = (data ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      return {
        id: String(row.id ?? ""),
        jobType: String(row.job_type ?? ""),
        status: String(row.status ?? ""),
        currentStep: String(row.current_step ?? ""),
        progressPct: Number(row.progress_pct ?? 0),
        errorMessage: row.error_message
          ? redactAdminChatText(String(row.error_message), input.supportCaseId)
          : null,
        updatedAt: String(row.updated_at ?? ""),
      };
    });
    return {
      ok: true,
      summary: `Fetched ${jobs.length} background job(s).`,
      data: { confirmed: true, jobs },
    };
  }

  if (name === "read_audit_and_error_logs") {
    const limit = Math.max(5, Math.min(30, Number(args.limit ?? 15) || 15));
    const [audit, aiErrors] = await Promise.all([
      listAdminAuditLogs(limit),
      listAiExecutionLogs({ limit }),
    ]);
    const sanitizedAudit = audit.map((a) => ({
      action: a.action,
      actorEmail: a.actorEmail,
      actorRole: a.actorRole,
      targetType: a.targetType,
      targetId: a.targetId,
      createdAt: a.createdAt,
    }));
    const failedAi = aiErrors
      .filter((l) => l.status !== "success")
      .map((l) => ({
        feature: l.feature,
        provider: l.actualProvider,
        model: l.actualModel,
        status: l.status,
        errorSummary: redactAdminChatText(l.errorSummary ?? "", input.supportCaseId),
        createdAt: l.createdAt,
      }));
    return {
      ok: true,
      summary: `${sanitizedAudit.length} audit entry(ies), ${failedAi.length} recent AI error(s).`,
      data: { confirmed: true, auditLogs: sanitizedAudit, recentAiErrors: failedAi },
    };
  }

  if (name === "run_cleanup_scan") {
    const scan = await scanSafeCleanupTargets(Number(args.retentionDays ?? 30));
    return {
      ok: true,
      summary: `Found ${scan.totalCount} safe cleanable item(s).`,
      data: { confirmed: true, scan },
    };
  }

  if (name === "rerun_module_check") {
    const moduleId = String(args.moduleId ?? "").trim();
    const res = await runSingleModuleCheck(moduleId);
    if (!res) {
      return { ok: false, summary: `Unknown moduleId: ${moduleId}`, data: { error: "Unknown module" } };
    }
    await appendAdminAuditLog({
      actorId: input.adminId,
      actorEmail: input.adminEmail,
      actorRole: input.adminRole,
      action: "admin_ai_rerun_module_check",
      targetType: "system_check",
      targetId: res.id,
      details: { status: res.status, detail: res.detail },
    });
    return {
      ok: true,
      summary: `${res.name}: ${res.status.toUpperCase()} — ${res.detail}`,
      data: { confirmed: true, result: res },
    };
  }

  if (name === "clear_stuck_job" || name === "retry_failed_job") {
    if (!supabaseServer) {
      return { ok: false, summary: "Database unavailable.", data: { error: "DB unavailable" } };
    }
    const jobId = String(args.jobId ?? "").trim();
    if (!jobId) {
      return { ok: false, summary: "jobId is required.", data: { error: "Missing jobId" } };
    }
    const nowIso = new Date().toISOString();
    const nextMessage =
      name === "clear_stuck_job"
        ? String(args.reason ?? "Cleared by administrator after stalling.")
        : "Marked cleared/ready for retry by administrator.";
    const { error } = await supabaseServer
      .from("background_jobs")
      .update({
        status: "failed",
        error_message: nextMessage,
        finished_at: nowIso,
        updated_at: nowIso,
      } as never)
      .eq("id", jobId);
    if (error) {
      return { ok: false, summary: error.message, data: { error: error.message } };
    }
    await appendAdminAuditLog({
      actorId: input.adminId,
      actorEmail: input.adminEmail,
      actorRole: input.adminRole,
      action: name === "clear_stuck_job" ? "admin_ai_cleared_stuck_job" : "admin_ai_reset_job",
      targetType: "background_job",
      targetId: jobId,
      details: { reason: nextMessage },
    });
    return {
      ok: true,
      summary: `Job ${jobId} updated safely; user can click Retry to start a fresh run.`,
      data: { confirmed: true, jobId, status: "failed", message: nextMessage },
    };
  }

  if (name === "mark_notification_resolved") {
    const id = String(args.notificationId ?? "").trim();
    if (!id) return { ok: false, summary: "Missing notificationId.", data: { error: "Missing ID" } };
    const updated = await markNotificationsRead([id]);
    await appendAdminAuditLog({
      actorId: input.adminId,
      actorEmail: input.adminEmail,
      actorRole: input.adminRole,
      action: "admin_ai_resolved_notification",
      targetType: "admin_notifications",
      targetId: id,
      details: { updated },
    });
    return {
      ok: true,
      summary: updated > 0 ? "Notification marked read." : "Notification was already read or not found.",
      data: { confirmed: true, updated },
    };
  }

  if (name === "propose_code_or_config_fix") {
    const proposal = {
      title: String(args.title ?? "Proposed Remediation"),
      filePath: String(args.filePath ?? ""),
      evidence: (args.evidence === "confirmed" ? "confirmed" : "likely") as "confirmed" | "likely",
      beforeSnippet: String(args.beforeSnippet ?? ""),
      afterSnippet: String(args.afterSnippet ?? ""),
      explanation: String(args.explanation ?? ""),
    };
    await appendAdminAuditLog({
      actorId: input.adminId,
      actorEmail: input.adminEmail,
      actorRole: input.adminRole,
      action: "admin_ai_proposed_fix_approved",
      targetType: "code_diff_proposal",
      targetId: proposal.filePath || proposal.title,
      details: { title: proposal.title, evidence: proposal.evidence },
    });
    return {
      ok: true,
      summary: `Diff review prepared (${proposal.evidence} evidence) for ${proposal.filePath}. Code patches require manual commit/review and are never auto-written without review.`,
      data: { confirmed: true, proposal },
    };
  }

  return { ok: false, summary: `Unknown admin tool: ${name}`, data: { error: "Unknown tool" } };
}

// ---------------------------------------------------------------------------
// Persistence per adminId (`admin_chat_conversations` with knowledge fallback)
// ---------------------------------------------------------------------------

function docIdForAdminChat(adminId: string): string {
  return `system_admin_chat_${adminId}`;
}

export async function listAdminChatConversations(
  adminId: string,
): Promise<AdminChatConversation[]> {
  if (!supabaseServer || !adminId) return [];
  const { data, error } = await supabaseServer
    .from("admin_chat_conversations")
    .select("*")
    .eq("admin_id", adminId)
    .order("updated_at", { ascending: false })
    .limit(40);

  if (!error && Array.isArray(data)) {
    return data.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: String(r.id ?? ""),
        adminId: String(r.admin_id ?? adminId),
        title: String(r.title ?? "Admin Debug Session"),
        messages: Array.isArray(r.messages) ? (r.messages as AdminChatMessage[]) : [],
        contents: Array.isArray(r.contents) ? (r.contents as AgentContent[]) : [],
        createdAt: String(r.created_at ?? new Date().toISOString()),
        updatedAt: String(r.updated_at ?? new Date().toISOString()),
      };
    });
  }

  const { data: kb } = await supabaseServer
    .from("knowledge")
    .select("content")
    .eq("id", docIdForAdminChat(adminId))
    .eq("owner_id", PLATFORM_ADMIN_OWNER)
    .maybeSingle();
  const raw = (kb as { content?: string } | null)?.content;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AdminChatConversation[]) : [];
  } catch {
    return [];
  }
}

export async function saveAdminChatConversation(
  conv: AdminChatConversation,
): Promise<void> {
  if (!supabaseServer) return;
  const nowIso = new Date().toISOString();
  const safe: AdminChatConversation = {
    ...conv,
    title: conv.title.slice(0, 180),
    updatedAt: nowIso,
  };

  const { error } = await supabaseServer.from("admin_chat_conversations").upsert(
    {
      id: safe.id,
      admin_id: safe.adminId,
      title: safe.title,
      messages: safe.messages,
      contents: safe.contents,
      created_at: safe.createdAt,
      updated_at: safe.updatedAt,
    } as never,
    { onConflict: "id" },
  );

  if (error) {
    const existing = await listAdminChatConversations(safe.adminId);
    const merged = [safe, ...existing.filter((c) => c.id !== safe.id)].slice(0, 30);
    await supabaseServer.from("knowledge").upsert(
      {
        id: docIdForAdminChat(safe.adminId),
        owner_id: PLATFORM_ADMIN_OWNER,
        category: "system_platform_admin_chat",
        title: `Admin AI Chat History (${safe.adminId})`,
        content: JSON.stringify(merged),
        sort: 999,
        is_master: false,
        updated_at: nowIso,
      } as never,
      { onConflict: "id" },
    );
  }
}

export async function clearAdminChatConversations(adminId: string): Promise<void> {
  if (!supabaseServer) return;
  await supabaseServer.from("admin_chat_conversations").delete().eq("admin_id", adminId);
  await supabaseServer
    .from("knowledge")
    .delete()
    .eq("id", docIdForAdminChat(adminId))
    .eq("owner_id", PLATFORM_ADMIN_OWNER);
}

export function createNewAdminConversation(adminId: string, firstMessage: string): AdminChatConversation {
  const nowIso = new Date().toISOString();
  return {
    id: `achat_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`,
    adminId,
    title: firstMessage.trim().slice(0, 70) || "Platform Diagnostics",
    messages: [],
    contents: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}
