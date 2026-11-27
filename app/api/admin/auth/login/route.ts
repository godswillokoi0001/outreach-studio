import QRCode from "qrcode";
import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { buildTotpUri } from "@/lib/key-vault";
import {
  checkAdminLoginLockout,
  clearAdminAuthFailures,
  findAdminAccountByEmail,
  getOrCreateAdminAccountTotpSecret,
  recordAdminAuthFailure,
  verifyAdminPassword,
} from "@/lib/platform/admin-credentials";
import { clearAdminCookies, setAdminChallengeCookie } from "@/lib/platform/admin-session";
import { appendAdminAuditLog, extractRequestMeta } from "@/lib/platform/store-server";

export const dynamic = "force-dynamic";

const GENERIC_AUTH_ERROR = "Invalid credentials.";
const GENERIC_LOCKOUT_ERROR = "Too many failed sign-in attempts. Please wait 15 minutes before trying again.";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      email?: string;
      password?: string;
    };

    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");

    if (!email || !password) {
      return NextResponse.json(
        { error: GENERIC_AUTH_ERROR },
        { status: 401, headers: { "Cache-Control": "private, no-store, max-age=0" } },
      );
    }

    const lockout = await checkAdminLoginLockout(email, req);
    if (lockout.locked) {
      return NextResponse.json(
        { error: GENERIC_LOCKOUT_ERROR, retryAfterSeconds: lockout.retryAfterSeconds },
        {
          status: 429,
          headers: {
            "Cache-Control": "private, no-store, max-age=0",
            "Retry-After": String(lockout.retryAfterSeconds),
          },
        },
      );
    }

    const account = await findAdminAccountByEmail(email);
    const validPassword =
      Boolean(account) &&
      account?.status === "active" &&
      verifyAdminPassword(password, account.passwordHash);

    if (!account || !validPassword) {
      const fail = await recordAdminAuthFailure({ email, stage: "password", req });
      if (fail.locked) {
        return NextResponse.json(
          { error: GENERIC_LOCKOUT_ERROR, retryAfterSeconds: fail.retryAfterSeconds },
          {
            status: 429,
            headers: {
              "Cache-Control": "private, no-store, max-age=0",
              "Retry-After": String(fail.retryAfterSeconds),
            },
          },
        );
      }
      return NextResponse.json(
        { error: GENERIC_AUTH_ERROR },
        { status: 401, headers: { "Cache-Control": "private, no-store, max-age=0" } },
      );
    }

    // Password step passed: issue temporary challenge cookie until 2FA TOTP/backup is verified.
    await clearAdminAuthFailures(account.email, req);
    const { ipAddress } = extractRequestMeta(req);
    const totpSecret = await getOrCreateAdminAccountTotpSecret(account);
    let setup: { secret: string; otpauthUri: string; qrDataUrl?: string } | undefined;
    if (!account.totpEnabled) {
      const otpauthUri = buildTotpUri(totpSecret, account.email, "Knowrevo Admin");
      const qrDataUrl = await QRCode.toDataURL(otpauthUri, { width: 220, margin: 1 }).catch(
        () => undefined,
      );
      setup = { secret: totpSecret, otpauthUri, qrDataUrl };
    }

    await appendAdminAuditLog({
      actorId: account.id,
      actorEmail: account.email,
      actorRole: account.role,
      action: "admin_password_verified_challenge_issued",
      targetType: "admin_session",
      targetId: account.id,
      details: { role: account.role, totpEnabled: account.totpEnabled, ipAddress },
      req,
    });

    const res = NextResponse.json(
      {
        ok: true,
        requires2fa: true,
        totpEnabled: account.totpEnabled,
        role: account.role,
        email: account.email,
        setup,
      },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
    clearAdminCookies(res);
    setAdminChallengeCookie(res, account);
    return res;
  } catch (err) {
    return handleApiError(err);
  }
}
