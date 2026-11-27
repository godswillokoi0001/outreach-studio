import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { requireAdmin } from "@/lib/platform/admin-auth";
import {
  clearNotifications,
  getCriticalEmailAlertPrefs,
  listAdminNotificationsPaginated,
  markNotificationsRead,
  saveCriticalEmailAlertPrefs,
} from "@/lib/platform/notifications";
import { appendAdminAuditLog } from "@/lib/platform/store-server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req, "support");
    const params = req.nextUrl.searchParams;
    const page = Math.max(1, Number(params.get("page") ?? 1) || 1);
    const rawSize = Number(params.get("pageSize") ?? 25);
    const pageSize = rawSize === 10 || rawSize === 50 ? rawSize : 25;
    const readFilter =
      params.get("read") === "unread" || params.get("read") === "read"
        ? (params.get("read") as "unread" | "read")
        : "all";
    const typeFilter = params.get("type") ?? "all";

    const [listResult, emailPrefs] = await Promise.all([
      listAdminNotificationsPaginated({ page, pageSize, readFilter, typeFilter }),
      getCriticalEmailAlertPrefs(),
    ]);

    return NextResponse.json(
      { ...listResult, page, pageSize, emailPrefs },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin(req, "support");
    const body = (await req.json().catch(() => ({}))) as {
      action?: "mark_read" | "mark_all_read" | "clear" | "update_email_prefs";
      id?: string;
      range?: "all" | "read" | "7d" | "30d";
      enabled?: boolean;
      recipientEmail?: string;
    };

    if (body.action === "mark_read") {
      await requireAdmin(req, "support");
      if (!body.id) {
        return NextResponse.json({ error: "Notification id is required." }, { status: 400 });
      }
      const updated = await markNotificationsRead([body.id]);
      return NextResponse.json({ ok: true, updated });
    }

    if (body.action === "mark_all_read") {
      await requireAdmin(req, "support");
      const updated = await markNotificationsRead();
      return NextResponse.json({ ok: true, updated });
    }

    if (body.action === "clear") {
      const ctx = await requireAdmin(req, "admin");
      const range =
        body.range === "read" || body.range === "7d" || body.range === "30d" ? body.range : "all";
      const removed = await clearNotifications(range);
      await appendAdminAuditLog({
        actorId: ctx.admin.id,
        actorEmail: ctx.admin.email,
        actorRole: ctx.admin.role,
        action: "admin_notifications_cleared",
        targetType: "admin_notifications",
        targetId: range,
        details: { range, removed },
        req,
      });
      return NextResponse.json({ ok: true, removed });
    }

    if (body.action === "update_email_prefs") {
      const ctx = await requireAdmin(req, "admin");
      const saved = await saveCriticalEmailAlertPrefs({
        enabled: Boolean(body.enabled),
        recipientEmail: body.recipientEmail || ctx.admin.email,
      });
      return NextResponse.json({ ok: true, emailPrefs: saved });
    }

    return NextResponse.json({ error: "Unsupported notification action." }, { status: 400 });
  } catch (err) {
    return handleApiError(err);
  }
}
