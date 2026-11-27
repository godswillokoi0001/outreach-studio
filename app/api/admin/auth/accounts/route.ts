import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { encryptSecret, generateTotpSecret } from "@/lib/key-vault";
import { requireAdmin } from "@/lib/platform/admin-auth";
import {
  createAdminAccount,
  findAdminAccountById,
  hashAdminPassword,
  listAdminAccountsPublic,
  saveAdminAccountRecord,
  toPublicAdminAccount,
} from "@/lib/platform/admin-credentials";
import { appendAdminAuditLog } from "@/lib/platform/store-server";
import type { AdminRole } from "@/lib/platform/types";

export const dynamic = "force-dynamic";

const ALLOWED_ROLES: AdminRole[] = ["super_admin", "admin", "support"];

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req, "super_admin");
    const accounts = await listAdminAccountsPublic();
    return NextResponse.json(
      { accounts },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: "create" | "update_role" | "suspend" | "reactivate" | "reset_2fa" | "reset_password";
      targetId?: string;
      email?: string;
      name?: string;
      role?: AdminRole;
      password?: string;
      totpCode?: string;
    };

    const ctx = await requireAdmin(req, "super_admin", {
      requireReauth: true,
      inlineTotpCode: body.totpCode,
    });

    if (body.action === "create") {
      const role = ALLOWED_ROLES.includes(body.role as AdminRole) ? (body.role as AdminRole) : "admin";
      const created = await createAdminAccount({
        email: String(body.email ?? ""),
        name: String(body.name ?? ""),
        role,
        password: String(body.password ?? ""),
        actorId: ctx.admin.id,
        actorEmail: ctx.admin.email,
        req,
      });
      return NextResponse.json({ account: created }, { status: 201 });
    }

    const targetId = String(body.targetId ?? "").trim();
    if (!targetId) {
      return NextResponse.json({ error: "Target admin account ID is required." }, { status: 400 });
    }
    const target = await findAdminAccountById(targetId);
    if (!target) {
      return NextResponse.json({ error: "Admin account not found." }, { status: 404 });
    }

    if (target.id === ctx.admin.id && (body.action === "suspend" || body.action === "update_role")) {
      return NextResponse.json(
        { error: "You cannot suspend or change your own Super Admin account." },
        { status: 400 },
      );
    }

    if (body.action === "update_role") {
      if (!ALLOWED_ROLES.includes(body.role as AdminRole)) {
        return NextResponse.json({ error: "Invalid admin role." }, { status: 400 });
      }
      const next = { ...target, role: body.role as AdminRole };
      await saveAdminAccountRecord(next);
      await appendAdminAuditLog({
        actorId: ctx.admin.id,
        actorEmail: ctx.admin.email,
        actorRole: ctx.admin.role,
        action: "admin_account_role_updated",
        targetType: "admin_account",
        targetId: target.id,
        details: { targetEmail: target.email, previousRole: target.role, newRole: next.role },
        req,
      });
      return NextResponse.json({ account: toPublicAdminAccount(next) });
    }

    if (body.action === "suspend" || body.action === "reactivate") {
      const status: "active" | "suspended" = body.action === "suspend" ? "suspended" : "active";
      const next = { ...target, status };
      await saveAdminAccountRecord(next);
      await appendAdminAuditLog({
        actorId: ctx.admin.id,
        actorEmail: ctx.admin.email,
        actorRole: ctx.admin.role,
        action: body.action === "suspend" ? "admin_account_suspended" : "admin_account_reactivated",
        targetType: "admin_account",
        targetId: target.id,
        details: { targetEmail: target.email },
        req,
      });
      return NextResponse.json({ account: toPublicAdminAccount(next) });
    }

    if (body.action === "reset_2fa") {
      const next = {
        ...target,
        totpEnabled: false,
        totpSecretEncrypted: encryptSecret(generateTotpSecret()),
      };
      await saveAdminAccountRecord(next);
      await appendAdminAuditLog({
        actorId: ctx.admin.id,
        actorEmail: ctx.admin.email,
        actorRole: ctx.admin.role,
        action: "admin_account_2fa_reset",
        targetType: "admin_account",
        targetId: target.id,
        details: { targetEmail: target.email },
        req,
      });
      return NextResponse.json({ account: toPublicAdminAccount(next) });
    }

    if (body.action === "reset_password") {
      const next = {
        ...target,
        passwordHash: hashAdminPassword(String(body.password ?? "")),
      };
      await saveAdminAccountRecord(next);
      await appendAdminAuditLog({
        actorId: ctx.admin.id,
        actorEmail: ctx.admin.email,
        actorRole: ctx.admin.role,
        action: "admin_account_password_reset",
        targetType: "admin_account",
        targetId: target.id,
        details: { targetEmail: target.email },
        req,
      });
      return NextResponse.json({ account: toPublicAdminAccount(next) });
    }

    return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
  } catch (err) {
    return handleApiError(err);
  }
}
