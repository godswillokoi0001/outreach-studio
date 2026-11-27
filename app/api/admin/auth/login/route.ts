import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import {
  checkAdminLoginLockout,
  clearAdminAuthFailures,
  findAdminAccountByEmail,
  recordAdminAuthFailure,
  saveAdminAccountRecord,
  verifyAdminPassword,
} from "@/lib/platform/admin-credentials";
import { clearAdminCookies, setAdminSessionCookies } from "@/lib/platform/admin-session";
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

    // Login is the only authentication step: issue the session immediately.
    await clearAdminAuthFailures(account.email, req);
    const { ipAddress } = extractRequestMeta(req);
    const nowIso = new Date().toISOString();
    await saveAdminAccountRecord({
      ...account,
      lastLoginAt: nowIso,
      lastLoginIp: ipAddress,
    });
    await appendAdminAuditLog({
      actorId: account.id,
      actorEmail: account.email,
      actorRole: account.role,
      action: "admin_login_success",
      targetType: "admin_session",
      targetId: account.id,
      details: { role: account.role },
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
