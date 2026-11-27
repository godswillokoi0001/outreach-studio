import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { requireAdmin } from "@/lib/platform/admin-auth";
import {
  hashAdminPassword,
  saveAdminAccountRecord,
  verifyAdminPassword,
} from "@/lib/platform/admin-credentials";
import { appendAdminAuditLog } from "@/lib/platform/store-server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireAdmin(req, "support");
    const body = (await req.json().catch(() => ({}))) as {
      currentPassword?: string;
      newPassword?: string;
    };

    const currentPassword = String(body.currentPassword ?? "");
    const newPassword = String(body.newPassword ?? "");

    if (!verifyAdminPassword(currentPassword, ctx.admin.passwordHash)) {
      return NextResponse.json(
        { error: "Current administrator password is incorrect." },
        { status: 400 },
      );
    }

    if (newPassword.length < 10) {
      return NextResponse.json(
        { error: "New administrator password must be at least 10 characters." },
        { status: 400 },
      );
    }

    const passwordHash = hashAdminPassword(newPassword);
    await saveAdminAccountRecord({
      ...ctx.admin,
      passwordHash,
    });

    await appendAdminAuditLog({
      actorId: ctx.admin.id,
      actorEmail: ctx.admin.email,
      actorRole: ctx.admin.role,
      action: "admin_password_changed",
      targetType: "admin_security",
      targetId: ctx.admin.id,
      req,
    });

    return NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
