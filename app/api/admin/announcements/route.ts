import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { requireAdmin } from "@/lib/platform/admin-auth";
import {
  appendAdminAuditLog,
  listAnnouncements,
  saveAnnouncements,
} from "@/lib/platform/store-server";
import type { PlatformAnnouncement } from "@/lib/platform/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req, "support");
    const announcements = await listAnnouncements();
    return NextResponse.json({ announcements }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { user, meta } = await requireAdmin(req, "admin");
    const body = (await req.json().catch(() => ({}))) as {
      title?: string;
      message?: string;
      tone?: "info" | "warn" | "ok";
      targetGroup?: PlatformAnnouncement["targetGroup"];
      targetUserIds?: string[];
    };

    const title = String(body.title ?? "").trim();
    const message = String(body.message ?? "").trim();
    if (!title || !message) {
      return NextResponse.json({ error: "Both title and message are required." }, { status: 400 });
    }

    const notice: PlatformAnnouncement = {
      id: `ann_${Date.now()}`,
      title: title.slice(0, 120),
      message: message.slice(0, 1000),
      tone: body.tone === "warn" || body.tone === "ok" ? body.tone : "info",
      targetGroup: body.targetGroup ?? "all",
      targetUserIds: Array.isArray(body.targetUserIds) ? body.targetUserIds : undefined,
      createdByEmail: user.email,
      createdAt: new Date().toISOString(),
      active: true,
    };

    const existing = await listAnnouncements();
    await saveAnnouncements([notice, ...existing]);
    await appendAdminAuditLog({
      actorId: user.ownerId,
      actorEmail: user.email,
      actorRole: meta.role,
      action: "announcement_published",
      targetType: "announcement",
      targetId: notice.id,
      details: { title: notice.title, targetGroup: notice.targetGroup },
      req,
    });

    return NextResponse.json({ announcement: notice });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { user, meta } = await requireAdmin(req, "admin");
    const id = req.nextUrl.searchParams.get("id")?.trim();
    if (!id) return NextResponse.json({ error: "Announcement id required." }, { status: 400 });

    const existing = await listAnnouncements();
    const updated = existing.map((a) => (a.id === id ? { ...a, active: false } : a));
    await saveAnnouncements(updated);

    await appendAdminAuditLog({
      actorId: user.ownerId,
      actorEmail: user.email,
      actorRole: meta.role,
      action: "announcement_deactivated",
      targetType: "announcement",
      targetId: id,
      req,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
