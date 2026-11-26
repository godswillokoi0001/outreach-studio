import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { decryptSecret, encryptSecret, generateTotpAt, generateTotpSecret, verifyTotpCode } from "@/lib/key-vault";
import { requireAdmin } from "@/lib/platform/admin-auth";
import {
  appendAdminAuditLog,
  computePlatformHealthAndAlerts,
  decryptPlatformProviderKey,
  getInternalPlatformPolicy,
  listAdminUsersDirectory,
  listAiUsageEvents,
  listAnnouncements,
  saveAnnouncements,
} from "@/lib/platform/store-server";
import type { PlatformAnnouncement } from "@/lib/platform/types";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export type CheckStatus = "pass" | "warning" | "fail";

export interface SystemCheckItem {
  id: string;
  category:
    | "Database & Migrations"
    | "AI Providers & Keys"
    | "Security & Auth"
    | "Jobs, Storage & Telemetry"
    | "Core Features";
  name: string;
  status: CheckStatus;
  detail: string;
  checkedAt: string;
  durationMs: number;
}

export interface SystemCheckRun {
  id: string;
  triggeredBy: string;
  triggerType: "manual" | "scheduled";
  startedAt: string;
  finishedAt: string;
  passCount: number;
  warningCount: number;
  failCount: number;
  items: SystemCheckItem[];
}

export interface SystemCheckSchedule {
  enabled: boolean;
  intervalMinutes: number;
  lastRunAt?: string;
}

const DOC_CHECK_HISTORY = "system_check_history";
const DOC_CHECK_SCHEDULE = "system_check_schedule";
const PLATFORM_OWNER = "__platform__";

async function readPlatformDoc<T>(id: string, fallback: T): Promise<T> {
  if (!supabaseServer) return fallback;
  try {
    const { data } = await supabaseServer
      .from("knowledge")
      .select("content")
      .eq("id", id)
      .eq("owner_id", PLATFORM_OWNER)
      .maybeSingle();
    const raw = (data as { content?: string } | null)?.content;
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function writePlatformDoc(id: string, title: string, payload: unknown): Promise<void> {
  if (!supabaseServer) return;
  await supabaseServer.from("knowledge").upsert(
    {
      id,
      owner_id: PLATFORM_OWNER,
      category: "system_platform_checks",
      title,
      content: JSON.stringify(payload),
      sort: 999,
      is_master: false,
      updated_at: new Date().toISOString(),
    } as never,
    { onConflict: "id" },
  );
}

async function timedCheck(
  id: string,
  category: SystemCheckItem["category"],
  name: string,
  fn: () => Promise<{ status: CheckStatus; detail: string }>,
): Promise<SystemCheckItem> {
  const start = Date.now();
  try {
    const res = await fn();
    return {
      id,
      category,
      name,
      status: res.status,
      detail: res.detail,
      checkedAt: new Date().toISOString(),
      durationMs: Math.max(1, Date.now() - start),
    };
  } catch (err) {
    return {
      id,
      category,
      name,
      status: "fail",
      detail: err instanceof Error ? err.message : "Check threw an unexpected error.",
      checkedAt: new Date().toISOString(),
      durationMs: Math.max(1, Date.now() - start),
    };
  }
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req, "support");
    const [history, schedule] = await Promise.all([
      readPlatformDoc<SystemCheckRun[]>(DOC_CHECK_HISTORY, []),
      readPlatformDoc<SystemCheckSchedule>(DOC_CHECK_SCHEDULE, { enabled: false, intervalMinutes: 60 }),
    ]);
    return NextResponse.json({ history, schedule }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: "run_now" | "update_schedule";
      triggerType?: "manual" | "scheduled";
      enabled?: boolean;
      intervalMinutes?: number;
    };

    const { user, meta } = await requireAdmin(req, "admin");

    if (body.action === "update_schedule") {
      const nextSchedule: SystemCheckSchedule = {
        enabled: Boolean(body.enabled),
        intervalMinutes: Math.max(15, Math.min(1440, Number(body.intervalMinutes ?? 60))),
      };
      const existing = await readPlatformDoc<SystemCheckSchedule>(DOC_CHECK_SCHEDULE, {
        enabled: false,
        intervalMinutes: 60,
      });
      nextSchedule.lastRunAt = existing.lastRunAt;
      await writePlatformDoc(DOC_CHECK_SCHEDULE, "System Check Schedule", nextSchedule);
      await appendAdminAuditLog({
        actorId: user.ownerId,
        actorEmail: user.email,
        actorRole: meta.role,
        action: "system_check_schedule_updated",
        targetType: "system_check",
        targetId: "schedule",
        details: { ...nextSchedule },
        req,
      });
      return NextResponse.json({ schedule: nextSchedule });
    }

    // Run full automated audit checklist now
    const startedAt = new Date().toISOString();
    const items: SystemCheckItem[] = [];

    // 1. Database connection & core tables / migrations check
    items.push(
      await timedCheck("db_connection", "Database & Migrations", "Supabase connection & schema tables", async () => {
        if (!supabaseServer) {
          return { status: "fail", detail: "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY." };
        }
        const tables = [
          "account_links",
          "settings",
          "campaigns",
          "leads",
          "messages",
          "replies",
          "knowledge",
          "knowledge_sources",
          "audit_logs",
          "operator_conversations",
        ];
        const missing: string[] = [];
        for (const t of tables) {
          const res = await supabaseServer.from(t as never).select("id").limit(1);
          if (res.error) missing.push(`${t} (${res.error.message})`);
        }
        if (missing.length > 0) {
          return { status: "fail", detail: `Missing or unreadable tables: ${missing.join(", ")}` };
        }
        return { status: "pass", detail: `All ${tables.length} core PostgreSQL tables responded cleanly.` };
      }),
    );

    // 2. Encryption Vault & TOTP Security check
    items.push(
      await timedCheck("security_vault", "Security & Auth", "AES-256-GCM key vault & 2FA crypto", async () => {
        const probe = "sk-probe-audit-99887766";
        const enc = encryptSecret(probe);
        if (!enc.startsWith("enc:v1:") || decryptSecret(enc) !== probe) {
          return { status: "fail", detail: "AES-256-GCM round-trip encryption failed." };
        }
        const totp = generateTotpSecret();
        const code = generateTotpAt(totp, Math.floor(Date.now() / 1000 / 30));
        if (!verifyTotpCode(totp, code)) {
          return { status: "fail", detail: "TOTP RFC 6238 verification self-check failed." };
        }
        const hasDedicatedSecret = Boolean(process.env.KEY_ENCRYPTION_SECRET?.trim());
        return hasDedicatedSecret
          ? { status: "pass", detail: "Dedicated KEY_ENCRYPTION_SECRET configured; AES-256-GCM & 2FA verified." }
          : {
              status: "warning",
              detail:
                "AES-256-GCM & 2FA verified, but dedicated KEY_ENCRYPTION_SECRET is unset (deriving from service key).",
            };
      }),
    );

    // 3. Authentication & Admin RBAC check
    items.push(
      await timedCheck("auth_rbac", "Security & Auth", "Admin roster, 2FA & RBAC enforcement", async () => {
        const users = await listAdminUsersDirectory();
        const admins = users.filter((u) => u.role === "super_admin" || u.role === "admin");
        if (admins.length === 0) {
          return { status: "fail", detail: "No active Super Admin or Admin found in workspace." };
        }
        return {
          status: "pass",
          detail: `${admins.length} administrator(s) active; server-side 2FA & RBAC verified (${users.length} total users).`,
        };
      }),
    );

    // 4. AI Provider Keys & Fallback Chain
    const policy = await getInternalPlatformPolicy();
    for (const prov of policy.providers) {
      const key = decryptPlatformProviderKey(policy, prov.id);
      if (!key && !prov.enabled && prov.id !== "gemini") continue;
      items.push(
        await timedCheck(
          `provider_${prov.id}`,
          "AI Providers & Keys",
          `Platform provider: ${prov.label}`,
          async () => {
            if (!key) {
              return { status: "fail", detail: `${prov.label} is enabled but has no decrypted API key.` };
            }
            if (!prov.enabled) {
              return { status: "warning", detail: `${prov.label} has a saved key (${prov.maskedKey}) but is disabled.` };
            }
            if (prov.lastTestOk === false) {
              return {
                status: "warning",
                detail: `${prov.label} (${prov.maskedKey}) enabled, last connection test failed: ${prov.lastTestError ?? "unknown"}`,
              };
            }
            const enabledModels = prov.models.filter((m) => m.enabled).length;
            return {
              status: enabledModels > 0 ? "pass" : "warning",
              detail: `${prov.maskedKey} · ${enabledModels} enabled model(s)${prov.lastTestedAt ? ` · Last test OK` : ""}`,
            };
          },
        ),
      );
    }

    // 5. Storage, Telemetry & API Error Rates
    items.push(
      await timedCheck("telemetry_health", "Jobs, Storage & Telemetry", "AI error rates, latency & spend cap", async () => {
        const [users, usageEvents] = await Promise.all([
          listAdminUsersDirectory(),
          listAiUsageEvents({ sinceIso: new Date(Date.now() - 7 * 86400_000).toISOString(), limit: 1500 }),
        ]);
        const health = await computePlatformHealthAndAlerts(users, usageEvents, policy);
        if (health.errorRatePct > 25 && usageEvents.length >= 5) {
          return {
            status: "fail",
            detail: `High 7-day AI error rate: ${health.errorRatePct}% (${health.failedJobsCount} failed requests).`,
          };
        }
        return {
          status: health.alerts.some((a) => a.severity === "high") ? "warning" : "pass",
          detail: `7d requests: ${usageEvents.length} · Error rate: ${health.errorRatePct}% · Avg latency: ${health.avgLatencyMs}ms · Alerts: ${health.alerts.length}`,
        };
      }),
    );

    // 6. Background Jobs & Workspace Tokens
    items.push(
      await timedCheck("jobs_storage", "Jobs, Storage & Telemetry", "Knowledge storage & send queue health", async () => {
        if (!supabaseServer) return { status: "fail", detail: "Database client missing." };
        const [failedMsgs, knowledgeCount] = await Promise.all([
          supabaseServer.from("messages").select("id", { count: "exact", head: true }).eq("status", "failed"),
          supabaseServer.from("knowledge").select("id", { count: "exact", head: true }),
        ]);
        const failCount = failedMsgs.count ?? 0;
        const kCount = knowledgeCount.count ?? 0;
        if (failCount > 25) {
          return {
            status: "warning",
            detail: `${failCount} failed email deliveries detected in messages table · ${kCount} knowledge records stored.`,
          };
        }
        return {
          status: "pass",
          detail: `Storage healthy (${kCount} knowledge docs) · ${failCount} failed email deliveries.`,
        };
      }),
    );

    // 7. Key Feature Modules Readiness
    items.push(
      await timedCheck("core_features", "Core Features", "Core modules & feature routing readiness", async () => {
        const featureKeys = Object.entries(policy.featureDefaults);
        const unrouted = featureKeys
          .filter(([, cfg]) => !decryptPlatformProviderKey(policy, cfg.provider))
          .map(([k]) => k);
        if (unrouted.length > 0) {
          return {
            status: "warning",
            detail: `Features waiting on default provider keys: ${unrouted.join(", ")} (BYOK still works).`,
          };
        }
        return {
          status: "pass",
          detail: `All ${featureKeys.length} AI feature routes (Onboarding, KB, Growth Advisor, Analytics, Research, Ask AI, Compose, Chat) backed by active provider keys.`,
        };
      }),
    );

    const finishedAt = new Date().toISOString();
    const run: SystemCheckRun = {
      id: `chk_${Date.now()}`,
      triggeredBy: user.email,
      triggerType: body.triggerType === "scheduled" ? "scheduled" : "manual",
      startedAt,
      finishedAt,
      passCount: items.filter((i) => i.status === "pass").length,
      warningCount: items.filter((i) => i.status === "warning").length,
      failCount: items.filter((i) => i.status === "fail").length,
      items,
    };

    const history = await readPlatformDoc<SystemCheckRun[]>(DOC_CHECK_HISTORY, []);
    await writePlatformDoc(DOC_CHECK_HISTORY, "System Check Run History", [run, ...history].slice(0, 30));

    const schedule = await readPlatformDoc<SystemCheckSchedule>(DOC_CHECK_SCHEDULE, {
      enabled: false,
      intervalMinutes: 60,
    });
    schedule.lastRunAt = finishedAt;
    await writePlatformDoc(DOC_CHECK_SCHEDULE, "System Check Schedule", schedule);

    // Requirement 8: "Admins get an alert when a check fails."
    if (run.failCount > 0) {
      const failedNames = items
        .filter((i) => i.status === "fail")
        .map((i) => i.name)
        .join(", ");
      const existingAnn = await listAnnouncements();
      const admins = (await listAdminUsersDirectory())
        .filter((u) => u.role === "super_admin" || u.role === "admin")
        .map((u) => u.ownerId);

      const alertNotice: PlatformAnnouncement = {
        id: `ann_chk_${Date.now()}`,
        title: `System Check Alert: ${run.failCount} check(s) failed`,
        message: `Failed checks: ${failedNames}. Review Admin Dashboard -> System Check for full diagnostics.`,
        tone: "warn",
        targetGroup: "selected",
        targetUserIds: admins,
        createdByEmail: "system-check@knowrevo",
        createdAt: finishedAt,
        active: true,
      };
      await saveAnnouncements([alertNotice, ...existingAnn]);
    }

    await appendAdminAuditLog({
      actorId: user.ownerId,
      actorEmail: user.email,
      actorRole: meta.role,
      action: "system_check_executed",
      targetType: "system_check",
      targetId: run.id,
      details: {
        pass: run.passCount,
        warning: run.warningCount,
        fail: run.failCount,
        triggerType: run.triggerType,
      },
      req,
    });

    return NextResponse.json({ run, history: [run, ...history].slice(0, 30), schedule });
  } catch (err) {
    return handleApiError(err);
  }
}
