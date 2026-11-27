import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { decryptSecret, verifyTotpCode } from "@/lib/key-vault";
import { requireAdmin } from "@/lib/platform/admin-auth";
import { verifyAdminPassword } from "@/lib/platform/admin-credentials";
import { setAdminReauthCookie } from "@/lib/platform/admin-session";
import { appendAdminAuditLog } from "@/lib/platform/store-server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireAdmin(req, "support");
    const body = (await req.json().catch(() => ({}))) as {
      code?: string;
      password?: string;
    };

    const code = String(body.code ?? "").replace(/\s+/g, "").trim();
    const password = String(body.password ?? "");

    let verified = false;
    let method = "totp";
    if (/^\d{6}$/.test(code) && ctx.admin.totpSecretEncrypted) {
      try {
        const secret = decryptSecret(ctx.admin.totpSecretEncrypted);
        verified = verifyTotpCode(secret, code);
      } catch {
        verified = false;
      }
    } else if (password) {
      method = "password";
      verified = verifyAdminPassword(password, ctx.admin.passwordHash);
    }

    if (!verified) {
      await appendAdminAuditLog({
        actorId: ctx.admin.id,
        actorEmail: ctx.admin.email,
        actorRole: ctx.admin.role,
        action: "admin_reauth_failed",
        targetType: "admin_security",
        targetId: ctx.admin.id,
        details: { method },
        req,
      });
      return NextResponse.json(
        { error: "Verification failed. Enter a valid 6-digit authenticator code or password." },
        { status: 401, headers: { "Cache-Control": "private, no-store, max-age=0" } },
      );
    }

    await appendAdminAuditLog({
      actorId: ctx.admin.id,
      actorEmail: ctx.admin.email,
      actorRole: ctx.admin.role,
      action: "admin_reauth_verified",
      targetType: "admin_security",
      targetId: ctx.admin.id,
      details: { method },
      req,
    });

    const res = NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
    setAdminReauthCookie(res, ctx.admin);
    return res;
  } catch (err) {
    return handleApiError(err);
  }
}
