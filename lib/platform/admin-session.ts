import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import type { AdminRole } from "./types";

export const ADMIN_CHALLENGE_COOKIE = "os_admin_challenge";
export const ADMIN_SESSION_COOKIE = "os_admin_session";
export const ADMIN_REAUTH_COOKIE = "os_admin_reauth";

export const ADMIN_CHALLENGE_TTL_SECONDS = 10 * 60; // 10 minutes to finish TOTP
export const ADMIN_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days sliding session
export const ADMIN_REAUTH_TTL_SECONDS = 5 * 60; // 5 minutes for sensitive actions

export interface AdminCookiePayload {
  kind: "challenge" | "session" | "reauth";
  adminId: string;
  email: string;
  role: AdminRole;
  iat: number;
  exp: number;
}

function adminSigningKey(): Buffer {
  const raw =
    process.env.ADMIN_SESSION_SECRET?.trim() ||
    process.env.KEY_ENCRYPTION_SECRET?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    "knowrevo-dev-admin-session-secret";
  return createHash("sha256").update(`knowrevo-admin-cookie:${raw}`).digest();
}

export function signAdminCookieToken(input: {
  kind: AdminCookiePayload["kind"];
  adminId: string;
  email: string;
  role: AdminRole;
  ttlSeconds: number;
}): { token: string; exp: number } {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + input.ttlSeconds;
  const payload: AdminCookiePayload = {
    kind: input.kind,
    adminId: input.adminId,
    email: input.email.trim().toLowerCase(),
    role: input.role,
    iat: now,
    exp,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", adminSigningKey()).update(body).digest("base64url");
  return { token: `${body}.${sig}`, exp };
}

export function verifyAdminCookieToken(
  rawToken: string | null | undefined,
  expectedKind: AdminCookiePayload["kind"],
): AdminCookiePayload | null {
  if (!rawToken || !rawToken.includes(".")) return null;
  const [body, sig] = rawToken.split(".");
  if (!body || !sig) return null;

  const expectedSig = createHmac("sha256", adminSigningKey()).update(body).digest("base64url");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expectedSig, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<AdminCookiePayload>;
    if (
      parsed.kind !== expectedKind ||
      !parsed.adminId ||
      !parsed.email ||
      !parsed.role ||
      typeof parsed.exp !== "number"
    ) {
      return null;
    }
    if (parsed.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return parsed as AdminCookiePayload;
  } catch {
    return null;
  }
}

function cookieBaseOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/api/admin",
    maxAge,
  };
}

export function setAdminChallengeCookie(
  res: NextResponse,
  account: { id: string; email: string; role: AdminRole },
): void {
  const { token } = signAdminCookieToken({
    kind: "challenge",
    adminId: account.id,
    email: account.email,
    role: account.role,
    ttlSeconds: ADMIN_CHALLENGE_TTL_SECONDS,
  });
  res.cookies.set(ADMIN_CHALLENGE_COOKIE, token, cookieBaseOptions(ADMIN_CHALLENGE_TTL_SECONDS));
}

export function setAdminSessionCookies(
  res: NextResponse,
  account: { id: string; email: string; role: AdminRole },
  options?: { includeReauth?: boolean },
): { sessionExpiresAt: string } {
  const session = signAdminCookieToken({
    kind: "session",
    adminId: account.id,
    email: account.email,
    role: account.role,
    ttlSeconds: ADMIN_SESSION_TTL_SECONDS,
  });
  res.cookies.set(ADMIN_SESSION_COOKIE, session.token, cookieBaseOptions(ADMIN_SESSION_TTL_SECONDS));

  if (options?.includeReauth) {
    const reauth = signAdminCookieToken({
      kind: "reauth",
      adminId: account.id,
      email: account.email,
      role: account.role,
      ttlSeconds: ADMIN_REAUTH_TTL_SECONDS,
    });
    res.cookies.set(ADMIN_REAUTH_COOKIE, reauth.token, cookieBaseOptions(ADMIN_REAUTH_TTL_SECONDS));
  }

  return { sessionExpiresAt: new Date(session.exp * 1000).toISOString() };
}

export function setAdminReauthCookie(
  res: NextResponse,
  account: { id: string; email: string; role: AdminRole },
): void {
  const reauth = signAdminCookieToken({
    kind: "reauth",
    adminId: account.id,
    email: account.email,
    role: account.role,
    ttlSeconds: ADMIN_REAUTH_TTL_SECONDS,
  });
  res.cookies.set(ADMIN_REAUTH_COOKIE, reauth.token, cookieBaseOptions(ADMIN_REAUTH_TTL_SECONDS));
}

export function clearAdminCookies(res: NextResponse): void {
  res.cookies.set(ADMIN_CHALLENGE_COOKIE, "", cookieBaseOptions(0));
  res.cookies.set(ADMIN_SESSION_COOKIE, "", cookieBaseOptions(0));
  res.cookies.set(ADMIN_REAUTH_COOKIE, "", cookieBaseOptions(0));
}

export function readAdminSessionFromRequest(req: NextRequest): AdminCookiePayload | null {
  return verifyAdminCookieToken(req.cookies.get(ADMIN_SESSION_COOKIE)?.value, "session");
}

export function readAdminChallengeFromRequest(req: NextRequest): AdminCookiePayload | null {
  return verifyAdminCookieToken(req.cookies.get(ADMIN_CHALLENGE_COOKIE)?.value, "challenge");
}

export function readAdminReauthFromRequest(req: NextRequest, expectedAdminId: string): boolean {
  const payload = verifyAdminCookieToken(req.cookies.get(ADMIN_REAUTH_COOKIE)?.value, "reauth");
  return Boolean(payload && payload.adminId === expectedAdminId);
}
