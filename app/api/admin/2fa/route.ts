import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { decryptSecret, verifyTotpCode } from "@/lib/key-vault";
import { requireAdmin } from "@/lib/platform/admin-auth";
import { setAdminReauthCookie } from "@/lib/platform/admin-session";
import { appendAdminAuditLog } from "@/lib/platform/store-server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireAdmin(req, "support");
    return NextResponse.json(
      {
        role: ctx.admin.role,
        totpEnabled: ctx.admin.totpEnabled,
        sessionValid: true,
        reauthActive: ctx.reauthenticated,
      },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireAdmin(req, "support");
    const body = (await req.json().catch(() => ({}))) as {
      action?: "reauth" | "verify_session";
      code?: string;
    };

    const code = String(body.code ?? "").replace(/\s+/g, "").trim();
    if (!ctx.admin.totpSecretEncrypted) {
      return NextResponse.json({ error: "2FA is not configured." }, { status: 400 });
    }
    const secret = decryptSecret(ctx.admin.totpSecretEncrypted);
    if (!verifyTotpCode(secret, code)) {
      return NextResponse.json({ error: "Invalid 6-digit authenticator code." }, { status: 401 });
    }

    await appendAdminAuditLog({
      actorId: ctx.admin.id,
      actorEmail: ctx.admin.email,
      actorRole: ctx.admin.role,
      action: "admin_reauth_verified",
      targetType: "admin_security",
      targetId: ctx.admin.id,
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
