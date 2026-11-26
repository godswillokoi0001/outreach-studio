import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import {
  buildTotpUri,
  decryptSecret,
  issueAdmin2faToken,
  verifyAdmin2faToken,
  verifyTotpCode,
} from "@/lib/key-vault";
import {
  appendAdminAuditLog,
  getOrCreateAdminTotpPendingSecret,
  getUserGovernance,
  saveUserGovernance,
} from "@/lib/platform/store-server";
import { ROLE_RANK } from "@/lib/platform/types";
import { verifyRequest } from "@/lib/server-auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const meta = await getUserGovernance(user.ownerId, user.email, {
      name: user.name,
      avatarUrl: user.avatarUrl,
    });

    if (ROLE_RANK[meta.role] < ROLE_RANK.support) {
      return NextResponse.json({ error: "Admin access is restricted to administrators." }, { status: 403 });
    }

    const sessionToken = req.headers.get("x-admin-2fa");
    const sessionValid =
      meta.totpEnabled && verifyAdmin2faToken(sessionToken, user.id, "session");

    if (!meta.totpEnabled) {
      const secret = await getOrCreateAdminTotpPendingSecret(user.ownerId, user.email);
      const otpauthUri = buildTotpUri(secret, user.email, "Knowrevo Admin");
      return NextResponse.json(
        {
          role: meta.role,
          totpEnabled: false,
          sessionValid: false,
          setup: { secret, otpauthUri },
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    return NextResponse.json(
      {
        role: meta.role,
        totpEnabled: true,
        sessionValid,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const meta = await getUserGovernance(user.ownerId, user.email, {
      name: user.name,
      avatarUrl: user.avatarUrl,
    });

    if (ROLE_RANK[meta.role] < ROLE_RANK.support) {
      return NextResponse.json({ error: "Admin access denied." }, { status: 403 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      action?: "enable" | "verify_session" | "reauth";
      code?: string;
    };

    const secretEncrypted = meta.totpSecretEncrypted;
    if (!secretEncrypted) {
      return NextResponse.json({ error: "2FA setup has not been initialized." }, { status: 400 });
    }

    const secret = decryptSecret(secretEncrypted);
    const valid = verifyTotpCode(secret, String(body.code ?? ""));
    if (!valid) {
      return NextResponse.json({ error: "Invalid 6-digit authenticator code. Try again." }, { status: 401 });
    }

    if (body.action === "enable") {
      await saveUserGovernance({ ...meta, totpEnabled: true });
      await appendAdminAuditLog({
        actorId: user.ownerId,
        actorEmail: user.email,
        actorRole: meta.role,
        action: "admin_2fa_enabled",
        targetType: "admin_security",
        targetId: user.ownerId,
        req,
      });
      return NextResponse.json({
        ok: true,
        sessionToken: issueAdmin2faToken(user.id, "session", 12 * 3600),
        reauthToken: issueAdmin2faToken(user.id, "reauth", 5 * 60),
      });
    }

    if (body.action === "verify_session") {
      await appendAdminAuditLog({
        actorId: user.ownerId,
        actorEmail: user.email,
        actorRole: meta.role,
        action: "admin_session_unlocked",
        targetType: "admin_security",
        targetId: user.ownerId,
        req,
      });
      return NextResponse.json({
        ok: true,
        sessionToken: issueAdmin2faToken(user.id, "session", 12 * 3600),
      });
    }

    if (body.action === "reauth") {
      return NextResponse.json({
        ok: true,
        reauthToken: issueAdmin2faToken(user.id, "reauth", 5 * 60),
      });
    }

    return NextResponse.json({ error: "Unknown 2FA action." }, { status: 400 });
  } catch (err) {
    return handleApiError(err);
  }
}
