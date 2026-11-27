import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { requireAdmin } from "@/lib/platform/admin-auth";
import {
  executeSafeCleanup,
  getCleanupHistory,
  getCleanupSchedule,
  saveCleanupSchedule,
  scanSafeCleanupTargets,
  type CleanupCategoryId,
  type CleanupScheduleConfig,
} from "@/lib/platform/cleanup";
import { recordAdminNotification } from "@/lib/platform/notifications";
import { appendAdminAuditLog } from "@/lib/platform/store-server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req, "admin");
    const [schedule, history] = await Promise.all([
      getCleanupSchedule(),
      getCleanupHistory(),
    ]);
    return NextResponse.json(
      { schedule, history },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin(req, "admin");
    const body = (await req.json().catch(() => ({}))) as {
      action?: "scan" | "execute" | "update_schedule";
      retentionDays?: number;
      categories?: CleanupCategoryId[];
      schedule?: CleanupScheduleConfig;
      totpCode?: string;
    };

    if (body.action === "scan") {
      const scan = await scanSafeCleanupTargets(body.retentionDays ?? 30);
      return NextResponse.json(
        { scan },
        { headers: { "Cache-Control": "private, no-store, max-age=0" } },
      );
    }

    if (body.action === "update_schedule") {
      const ctx = await requireAdmin(req, "admin");
      if (!body.schedule) {
        return NextResponse.json({ error: "Schedule configuration is required." }, { status: 400 });
      }
      const saved = await saveCleanupSchedule(body.schedule);
      await appendAdminAuditLog({
        actorId: ctx.admin.id,
        actorEmail: ctx.admin.email,
        actorRole: ctx.admin.role,
        action: "cleanup_schedule_updated",
        targetType: "platform_cleanup",
        targetId: saved.enabled ? "enabled" : "disabled",
        details: { intervalDays: saved.intervalDays, retentionDays: saved.retentionDays },
        req,
      });
      return NextResponse.json({ schedule: saved });
    }

    if (body.action === "execute") {
      const ctx = await requireAdmin(req, "admin", {
        requireReauth: true,
        inlineTotpCode: body.totpCode,
      });
      const categories = Array.isArray(body.categories) ? body.categories : [];
      if (categories.length === 0) {
        return NextResponse.json(
          { error: "Select at least one safe cleanup category to remove." },
          { status: 400 },
        );
      }

      const report = await executeSafeCleanup({
        executedBy: ctx.admin.email,
        categories,
        retentionDays: body.retentionDays ?? 30,
      });

      await appendAdminAuditLog({
        actorId: ctx.admin.id,
        actorEmail: ctx.admin.email,
        actorRole: ctx.admin.role,
        action: "platform_cleanup_executed",
        targetType: "platform_cleanup",
        targetId: report.id,
        details: {
          removedCount: report.removedCount,
          estimatedBytesFreed: report.estimatedBytesFreed,
          snapshotId: report.snapshotId,
          retentionDays: report.retentionDays,
        },
        req,
      });

      const hasErrors = report.perCategory.some((c) => Boolean(c.error));
      await recordAdminNotification({
        type: "cleanup",
        severity: hasErrors ? "high" : "low",
        title: hasErrors
          ? "Database cleanup completed with partial errors"
          : `Database cleanup removed ${report.removedCount} stale item(s)`,
        message: `Freed ~${Math.max(1, Math.round(report.estimatedBytesFreed / 1024))} KB across ${report.perCategory.length} category(ies). Backup snapshot: ${report.snapshotId ?? "none"}.`,
        dedupKey: `cleanup_${report.id}`,
        targetTab: "cleanup",
      });

      const history = await getCleanupHistory();
      return NextResponse.json(
        { report, history },
        { headers: { "Cache-Control": "private, no-store, max-age=0" } },
      );
    }

    return NextResponse.json({ error: "Unsupported cleanup action." }, { status: 400 });
  } catch (err) {
    return handleApiError(err);
  }
}
