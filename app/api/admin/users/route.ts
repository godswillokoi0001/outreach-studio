import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { requireAdmin } from "@/lib/platform/admin-auth";
import {
  appendAdminAuditLog,
  getUserGovernance,
  listAdminUsersDirectory,
  listAnnouncements,
  saveAnnouncements,
  saveUserGovernance,
} from "@/lib/platform/store-server";
import type { AdminRole, PlatformAnnouncement } from "@/lib/platform/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { meta } = await requireAdmin(req, "support");
    const isSupport = meta.role === "support";

    const params = req.nextUrl.searchParams;
    const search = (params.get("search") ?? "").trim().toLowerCase();
    const status = params.get("status") ?? "all";
    const role = params.get("role") ?? "all";
    const onboarding = params.get("onboarding") ?? "all";
    const keySource = params.get("keySource") ?? "all";
    const sortBy = params.get("sortBy") ?? "createdAt";
    const sortDir = params.get("sortDir") === "asc" ? 1 : -1;
    const page = Math.max(1, Number(params.get("page") ?? 1));
    const pageSize = Math.min(100, Math.max(5, Number(params.get("pageSize") ?? 20)));

    let users = await listAdminUsersDirectory();

    if (search) {
      users = users.filter(
        (u) =>
          u.name.toLowerCase().includes(search) ||
          u.email.toLowerCase().includes(search) ||
          u.ownerId.toLowerCase().includes(search),
      );
    }
    if (status !== "all") users = users.filter((u) => u.status === status);
    if (role !== "all") users = users.filter((u) => u.role === role);
    if (onboarding === "completed") users = users.filter((u) => u.onboardingCompleted);
    if (onboarding === "incomplete") users = users.filter((u) => !u.onboardingCompleted);
    if (keySource !== "all") users = users.filter((u) => u.keySource === keySource);

    users.sort((a, b) => {
      if (sortBy === "name") return a.name.localeCompare(b.name) * sortDir;
      if (sortBy === "email") return a.email.localeCompare(b.email) * sortDir;
      if (sortBy === "lastActiveAt") return a.lastActiveAt.localeCompare(b.lastActiveAt) * sortDir;
      if (sortBy === "aiRequestsMonth") return (a.aiRequestsMonth - b.aiRequestsMonth) * sortDir;
      if (sortBy === "aiCostMonthUsd") return (a.aiCostMonthUsd - b.aiCostMonthUsd) * sortDir;
      return a.createdAt.localeCompare(b.createdAt) * sortDir;
    });

    const total = users.length;
    const paged = users.slice((page - 1) * pageSize, page * pageSize).map((u) =>
      isSupport
        ? {
            ...u,
            aiCostMonthUsd: 0,
            personalProviderHint: undefined,
          }
        : u,
    );

    return NextResponse.json({ users: paged, total, page, pageSize }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: "suspend" | "reactivate" | "export" | "message";
      userIds?: string[];
      title?: string;
      message?: string;
      tone?: "info" | "warn" | "ok";
      totpCode?: string;
    };

    const { user, meta } = await requireAdmin(req, "admin", {
      requireReauth: body.action === "suspend",
      inlineTotpCode: body.totpCode,
    });

    const targetIds = Array.isArray(body.userIds) ? body.userIds.filter(Boolean).slice(0, 100) : [];
    if (targetIds.length === 0) {
      return NextResponse.json({ error: "Select at least one user first." }, { status: 400 });
    }

    const directory = await listAdminUsersDirectory();
    const byId = new Map(directory.map((u) => [u.ownerId, u]));

    if (body.action === "suspend" || body.action === "reactivate") {
      let updated = 0;
      for (const targetId of targetIds) {
        if (targetId === user.ownerId) continue; // Cannot self-suspend
        const summary = byId.get(targetId);
        if (!summary) continue;
        if (summary.role === "super_admin" && meta.role !== "super_admin") continue;
        const targetMeta = await getUserGovernance(targetId, summary.email);
        await saveUserGovernance({
          ...targetMeta,
          status: body.action === "suspend" ? "suspended" : "active",
        });
        updated += 1;
      }

      await appendAdminAuditLog({
        actorId: user.ownerId,
        actorEmail: user.email,
        actorRole: meta.role as AdminRole,
        action: `bulk_user_${body.action}`,
        targetType: "users",
        targetId: targetIds.join(","),
        details: { updatedCount: updated },
        req,
      });

      return NextResponse.json({ ok: true, updated });
    }

    if (body.action === "export") {
      const exported = targetIds
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((u) => ({
          ...u,
          personalProviderHint: undefined,
        }));

      await appendAdminAuditLog({
        actorId: user.ownerId,
        actorEmail: user.email,
        actorRole: meta.role,
        action: "bulk_user_export",
        targetType: "users",
        targetId: `${exported.length}_users`,
        req,
      });

      return NextResponse.json({ ok: true, exported });
    }

    if (body.action === "message") {
      const title = String(body.title ?? "").trim() || "Notice from Administration";
      const message = String(body.message ?? "").trim();
      if (!message) {
        return NextResponse.json({ error: "Enter a message to send." }, { status: 400 });
      }
      const existing = await listAnnouncements();
      const notice: PlatformAnnouncement = {
        id: `ann_${Date.now()}`,
        title: title.slice(0, 120),
        message: message.slice(0, 1000),
        tone: body.tone === "warn" || body.tone === "ok" ? body.tone : "info",
        targetGroup: "selected",
        targetUserIds: targetIds,
        createdByEmail: user.email,
        createdAt: new Date().toISOString(),
        active: true,
      };
      await saveAnnouncements([notice, ...existing]);
      await appendAdminAuditLog({
        actorId: user.ownerId,
        actorEmail: user.email,
        actorRole: meta.role,
        action: "bulk_user_message",
        targetType: "announcement",
        targetId: notice.id,
        details: { targetCount: targetIds.length, title: notice.title },
        req,
      });
      return NextResponse.json({ ok: true, announcement: notice });
    }

    return NextResponse.json({ error: "Unknown bulk action." }, { status: 400 });
  } catch (err) {
    return handleApiError(err);
  }
}
