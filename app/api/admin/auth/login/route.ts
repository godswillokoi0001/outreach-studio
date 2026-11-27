import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { buildTotpUri, decryptSecret, verifyTotpCode } from "@/lib/key-vault";
import {
  checkAdminLoginLockout,
  clearAdminAuthFailures,
  findAdminAccountByEmail,
  findAdminAccountById,
  getOrCreateAdminAccountTotpSecret,
  recordAdminAuthFailure,
  saveAdminAccountRecord,
  verifyAdminPassword,
} from "@/lib/platform/admin-credentials";
import {
  clearAdminCookies,
  readAdminChallengeFromRequest,
  setAdminChallengeCookie,
  setAdminSessionCookies,
} from "@/lib/platform/admin-session";
import { appendAdminAuditLog, extractRequestMeta } from "@/lib/platform/store-server";

export const dynamic = "force-dynamic";

const GENERIC_AUTH_ERROR = "Invalid credentials.";
const GENERIC_LOCKOUT_ERROR = "Too many failed sign-in attempts. Please wait 15 minutes before trying again.";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      step?: "password" | "totp";
      email?: string;
      password?: string;
      code?: string;
    };

    const step = body.step === "totp" ? "totp" : "password";

    if (step === "password") {
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

      const secret = await getOrCreateAdminAccountTotpSecret(account);
      const payload: Record<string, unknown> = {
        ok: true,
        step: account.totpEnabled ? "verify_totp" : "setup_totp",
      };
      if (!account.totpEnabled) {
        payload.setup = {
          secret,
          otpauthUri: buildTotpUri(secret, account.email, "Knowrevo Admin"),
        };
      }

      const res = NextResponse.json(payload, {
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      });
      setAdminChallengeCookie(res, account);
      return res;
    }

    // Step 2: Mandatory TOTP verification following password check
    const challenge = readAdminChallengeFromRequest(req);
    if (!challenge) {
      return NextResponse.json(
        { error: "Your sign-in challenge expired. Enter your email and password again." },
        { status: 401, headers: { "Cache-Control": "private, no-store, max-age=0" } },
      );
    }

    const lockout = await checkAdminLoginLockout(challenge.email, req);
    if (lockout.locked) {
      const res = NextResponse.json(
        { error: GENERIC_LOCKOUT_ERROR, retryAfterSeconds: lockout.retryAfterSeconds },
        {
          status: 429,
          headers: {
            "Cache-Control": "private, no-store, max-age=0",
            "Retry-After": String(lockout.retryAfterSeconds),
          },
        },
      );
      clearAdminCookies(res);
      return res;
    }

    const account = await findAdminAccountById(challenge.adminId);
    if (!account || account.status !== "active" || !account.totpSecretEncrypted) {
      return NextResponse.json(
        { error: GENERIC_AUTH_ERROR },
        { status: 401, headers: { "Cache-Control": "private, no-store, max-age=0" } },
      );
    }

    const code = String(body.code ?? "").replace(/\s+/g, "").trim();
    let validTotp = false;
    try {
      const secret = decryptSecret(account.totpSecretEncrypted);
      validTotp = verifyTotpCode(secret, code);
    } catch {
      validTotp = false;
    }

    if (!validTotp) {
      const fail = await recordAdminAuthFailure({ email: account.email, stage: "totp", req });
      if (fail.locked) {
        const res = NextResponse.json(
          { error: GENERIC_LOCKOUT_ERROR, retryAfterSeconds: fail.retryAfterSeconds },
          {
            status: 429,
            headers: {
              "Cache-Control": "private, no-store, max-age=0",
              "Retry-After": String(fail.retryAfterSeconds),
            },
          },
        );
        clearAdminCookies(res);
        return res;
      }
      return NextResponse.json(
        { error: "Invalid verification code." },
        { status: 401, headers: { "Cache-Control": "private, no-store, max-age=0" } },
      );
    }

    await clearAdminAuthFailures(account.email, req);
    const { ipAddress } = extractRequestMeta(req);
    const nowIso = new Date().toISOString();
    const firstTimeTotp = !account.totpEnabled;

    await saveAdminAccountRecord({
      ...account,
      totpEnabled: true,
      lastLoginAt: nowIso,
      lastLoginIp: ipAddress,
    });

    await appendAdminAuditLog({
      actorId: account.id,
      actorEmail: account.email,
      actorRole: account.role,
      action: firstTimeTotp ? "admin_2fa_enabled_and_signed_in" : "admin_login_success",
      targetType: "admin_session",
      targetId: account.id,
      details: { role: account.role, firstTimeTotp },
      req,
    });

    const res = NextResponse.json(
      {
        ok: true,
        admin: {
          id: account.id,
          email: account.email,
          name: account.name,
          role: account.role,
        },
      },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
    clearAdminCookies(res);
    setAdminSessionCookies(res, account, { includeReauth: true });
    return res;
  } catch (err) {
    return handleApiError(err);
  }
}
