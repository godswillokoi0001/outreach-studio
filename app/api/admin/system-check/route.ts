import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { requireAdmin } from "@/lib/platform/admin-auth";
import {
  MODULE_VALIDATORS,
  runAllModuleAndInfraChecks,
  runSingleModuleCheck,
  type SystemCheckItem,
} from "@/lib/platform/module-validator";
import { recordAdminNotification } from "@/lib/platform/notifications";
import {
  appendAdminAuditLog,
  listAdminUsersDirectory,
  listAnnouncements,
  saveAnnouncements,
} from "@/lib/platform/store-server";
import type { PlatformAnnouncement } from "@/lib/platform/types";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export interface SystemCheckRun {
  id: string;
  triggeredBy: string;
  triggerType: "manual" | "scheduled" | "single_module";
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

type ClearRange = "all" | "7d" | "30d" | "90d";

function cutoffForRange(range: ClearRange): string | null {
  const now = Date.now();
  if (range === "7d") return new Date(now - 7 * 86400_000).toISOString();
  if (range === "30d") return new Date(now - 30 * 86400_000).toISOString();
  if (range === "90d") return new Date(now - 90 * 86400_000).toISOString();
  return null;
}

function paginateHistory(
  allHistory: SystemCheckRun[],
  params: URLSearchParams,
) {
  const page = Math.max(1, Number(params.get("historyPage") ?? 1) || 1);
  const rawSize = Number(params.get("historyPageSize") ?? 10);
  const pageSize = rawSize === 25 || rawSize === 50 ? rawSize : 10;
  const sort = params.get("historySort") === "oldest" ? "oldest" : "newest";
  const filter = params.get("historyFilter") ?? "all";

  let filtered = [...allHistory];
  if (filter === "has_failures") filtered = filtered.filter((r) => r.failCount > 0);
  else if (filter === "manual") filtered = filtered.filter((r) => r.triggerType === "manual");
  else if (filter === "scheduled") filtered = filtered.filter((r) => r.triggerType === "scheduled");

  if (sort === "oldest") {
    filtered.sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));
  } else {
    filtered.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
  }

  const total = filtered.length;
  const from = (page - 1) * pageSize;
  return {
    history: filtered.slice(from, from + pageSize),
    historyTotal: total,
    historyPage: page,
    historyPageSize: pageSize,
    latestRun: allHistory[0] ?? null,
  };
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req, "support");
    const [allHistory, schedule] = await Promise.all([
      readPlatformDoc<SystemCheckRun[]>(DOC_CHECK_HISTORY, []),
      readPlatformDoc<SystemCheckSchedule>(DOC_CHECK_SCHEDULE, {
        enabled: false,
        intervalMinutes: 60,
      }),
    ]);

    const paged = paginateHistory(allHistory, req.nextUrl.searchParams);
    return NextResponse.json(
      {
        ...paged,
        schedule,
        availableModules: MODULE_VALIDATORS.map((m) => ({
          id: m.id,
          name: m.name,
          category: m.category,
        })),
      },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?:
        | "run_now"
        | "run_module"
        | "update_schedule"
        | "preview_clear_history"
        | "clear_history";
      moduleId?: string;
      triggerType?: "manual" | "scheduled";
      enabled?: boolean;
      intervalMinutes?: number;
      range?: ClearRange;
      totpCode?: string;
    };

    if (body.action === "preview_clear_history") {
      await requireAdmin(req, "admin");
      const range: ClearRange =
        body.range === "7d" || body.range === "30d" || body.range === "90d" ? body.range : "all";
      const cutoff = cutoffForRange(range);
      const history = await readPlatformDoc<SystemCheckRun[]>(DOC_CHECK_HISTORY, []);
      const matching = history.filter((r) => (!cutoff ? true : r.finishedAt < cutoff));
      return NextResponse.json({ count: matching.length, range });
    }

    if (body.action === "clear_history") {
      const ctx = await requireAdmin(req, "admin", {
        requireReauth: true,
        inlineTotpCode: body.totpCode,
      });
      const range: ClearRange =
        body.range === "7d" || body.range === "30d" || body.range === "90d" ? body.range : "all";
      const cutoff = cutoffForRange(range);
      const history = await readPlatformDoc<SystemCheckRun[]>(DOC_CHECK_HISTORY, []);
      const remaining = history.filter((r) => (cutoff ? r.finishedAt >= cutoff : false));
      const removedCount = history.length - remaining.length;
      await writePlatformDoc(DOC_CHECK_HISTORY, "System Check Run History", remaining);

      await appendAdminAuditLog({
        actorId: ctx.admin.id,
        actorEmail: ctx.admin.email,
        actorRole: ctx.admin.role,
        action: "system_check_history_cleared",
        targetType: "system_check",
        targetId: range,
        details: { range, removedCount },
        req,
      });

      const schedule = await readPlatformDoc<SystemCheckSchedule>(DOC_CHECK_SCHEDULE, {
        enabled: false,
        intervalMinutes: 60,
      });
      return NextResponse.json({
        ok: true,
        removedCount,
        history: remaining.slice(0, 10),
        historyTotal: remaining.length,
        latestRun: remaining[0] ?? null,
        schedule,
      });
    }

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

    if (body.action === "run_module") {
      const moduleId = String(body.moduleId ?? "").trim();
      const startedAt = new Date().toISOString();
      const single = await runSingleModuleCheck(moduleId);
      if (!single) {
        return NextResponse.json({ error: "Unknown validation module ID." }, { status: 400 });
      }
      const history = await readPlatformDoc<SystemCheckRun[]>(DOC_CHECK_HISTORY, []);
      const latestExisting = history[0];
      const mergedItems: SystemCheckItem[] = latestExisting
        ? latestExisting.items.some((it) => it.id === single.id)
          ? latestExisting.items.map((it) => (it.id === single.id ? single : it))
          : [...latestExisting.items, single]
        : [single];

      const finishedAt = new Date().toISOString();
      const run: SystemCheckRun = {
        id: `chk_mod_${Date.now()}`,
        triggeredBy: user.email,
        triggerType: "single_module",
        startedAt,
        finishedAt,
        passCount: mergedItems.filter((i) => i.status === "pass").length,
        warningCount: mergedItems.filter((i) => i.status === "warning").length,
        failCount: mergedItems.filter((i) => i.status === "fail").length,
        items: mergedItems,
      };
      const nextHistory = [run, ...history].slice(0, 100);
      await writePlatformDoc(DOC_CHECK_HISTORY, "System Check Run History", nextHistory);

      if (single.status === "fail") {
        await recordAdminNotification({
          type: "system_check",
          severity: "high",
          title: `Module validation failed: ${single.name}`,
          message: single.detail,
          dedupKey: `module_fail_${single.id}`,
          targetTab: "health",
        });
      }

      await appendAdminAuditLog({
        actorId: user.ownerId,
        actorEmail: user.email,
        actorRole: meta.role,
        action: "module_validation_rerun",
        targetType: "system_check",
        targetId: single.id,
        details: { status: single.status, detail: single.detail },
        req,
      });

      const schedule = await readPlatformDoc<SystemCheckSchedule>(DOC_CHECK_SCHEDULE, {
        enabled: false,
        intervalMinutes: 60,
      });
      return NextResponse.json({
        item: single,
        run,
        latestRun: run,
        history: nextHistory.slice(0, 10),
        historyTotal: nextHistory.length,
        schedule,
      });
    }

    // Run full infrastructure + module validation suite
    const startedAt = new Date().toISOString();
    const items = await runAllModuleAndInfraChecks();
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
    const nextHistory = [run, ...history].slice(0, 100);
    await writePlatformDoc(DOC_CHECK_HISTORY, "System Check Run History", nextHistory);

    const schedule = await readPlatformDoc<SystemCheckSchedule>(DOC_CHECK_SCHEDULE, {
      enabled: false,
      intervalMinutes: 60,
    });
    schedule.lastRunAt = finishedAt;
    await writePlatformDoc(DOC_CHECK_SCHEDULE, "System Check Schedule", schedule);

    if (run.failCount > 0) {
      const failedNames = items
        .filter((i) => i.status === "fail")
        .map((i) => i.name)
        .join(", ");

      await recordAdminNotification({
        type: "system_check",
        severity: "high",
        title: `System Check Alert: ${run.failCount} module(s) failed`,
        message: `Failed: ${failedNames}. Review Check & Diagnostics to inspect or re-run modules.`,
        dedupKey: "system_check_failures",
        targetTab: "health",
      });

      const existingAnn = await listAnnouncements();
      const admins = (await listAdminUsersDirectory())
        .filter((u) => u.role === "super_admin" || u.role === "admin")
        .map((u) => u.ownerId);

      const alertNotice: PlatformAnnouncement = {
        id: `ann_chk_${Date.now()}`,
        title: `System Check Alert: ${run.failCount} check(s) failed`,
        message: `Failed checks: ${failedNames}. Review Admin Dashboard -> Check & Diagnostics.`,
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

    return NextResponse.json({
      run,
      latestRun: run,
      history: nextHistory.slice(0, 10),
      historyTotal: nextHistory.length,
      schedule,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
