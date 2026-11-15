import { cookies } from "next/headers";
import { isSameOriginRequest } from "@freebuff/auth";
import { freebuff, freebuffConfigured } from "./freebuff";
import { getEnv } from "./env";
import { getMeta, setMeta } from "./db";
import { hmac, timingSafeEqual } from "./crypto";
import { HttpError } from "./http";

export interface AppUser {
  sub: string;
  email?: string;
  name?: string;
  via: "freebuff" | "password";
}

const COOKIE = "sm_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12;

export function authMode(env: { APP_PASSWORD?: string }): "freebuff" | "password" | "unconfigured" {
  if (freebuffConfigured) return "freebuff";
  if (env.APP_PASSWORD) return "password";
  return "unconfigured";
}

export async function createPasswordSession(secret: string): Promise<string> {
  const expires = Date.now() + SESSION_TTL_SECONDS * 1000;
  const payload = `owner.${expires}`;
  const sig = await hmac(secret, payload);
  return `${payload}.${sig}`;
}

async function verifyPasswordSession(token: string, secret: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [who, expires, sig] = parts;
  if (who !== "owner") return false;
  if (Number(expires) < Date.now()) return false;
  const expected = await hmac(secret, `${who}.${expires}`);
  return timingSafeEqual(expected, sig);
}

export function sessionCookieOptions() {
  return {
    name: COOKIE,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

export function clearSessionCookie() {
  return { ...sessionCookieOptions(), value: "", maxAge: 0 };
}

/**
 * Resolves the signed-in account. Everyone who signs in gets their own isolated
 * workspace; all business data is stored against user.sub.
 */
export async function currentUser(): Promise<AppUser | null> {
  const env = await getEnv();

  if (freebuffConfigured) {
    try {
      const fbUser = await freebuff!.getUser();
      if (fbUser?.sub) {
        return { sub: fbUser.sub, email: fbUser.email, name: fbUser.name, via: "freebuff" };
      }
    } catch (err) {
      console.error("[auth] freebuff session check failed", err instanceof Error ? err.message : "unknown");
    }
  }

  if (env.APP_PASSWORD) {
    const jar = await cookies();
    const token = jar.get(COOKIE)?.value;
    const secret = env.APP_SESSION_SECRET || env.APP_PASSWORD;
    if (token && (await verifyPasswordSession(token, secret))) {
      return { sub: "local-owner", name: "Owner", via: "password" };
    }
  }

  return null;
}

export async function requireUser(request?: Request): Promise<AppUser> {
  const user = await currentUser();
  if (!user) throw new HttpError(401, "Sign in required.");
  if (request && isMutation(request)) await assertSameOrigin(request);
  return user;
}

function isMutation(request: Request): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase());
}

/**
 * CSRF guard for state-changing requests. Browsers always send Origin on
 * cross-site POSTs; a mismatched Origin is rejected.
 */
export async function assertSameOrigin(request: Request): Promise<void> {
  const env = await getEnv();
  const expected = env.APP_ORIGIN;
  if (expected && freebuffConfigured) {
    if (!isSameOriginRequest(request, expected)) {
      throw new HttpError(403, "Cross-origin request rejected.");
    }
    return;
  }
  const origin = request.headers.get("origin");
  if (!origin) return; // Non-browser client (curl, server-to-server).
  const host = request.headers.get("host");
  try {
    const originHost = new URL(origin).host;
    if (!host || originHost !== host) throw new HttpError(403, "Cross-origin request rejected.");
  } catch {
    throw new HttpError(403, "Cross-origin request rejected.");
  }
}

export async function requirePasswordMatch(input: string): Promise<void> {
  const env = await getEnv();
  if (!env.APP_PASSWORD) throw new HttpError(400, "Password sign-in is not enabled.");
  const a = new TextEncoder().encode(input);
  const b = new TextEncoder().encode(env.APP_PASSWORD);
  if (a.length !== b.length) throw new HttpError(401, "Incorrect password.");
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  if (diff !== 0) throw new HttpError(401, "Incorrect password.");
}

/**
 * The platform owner is whoever signed in first. Only they can change
 * platform-wide settings such as the shared Google OAuth client.
 */
export async function isPlatformOwner(sub: string): Promise<boolean> {
  const owner = await getMeta("platform_owner_sub");
  if (!owner) {
    await setMeta("platform_owner_sub", sub);
    return true;
  }
  return owner === sub;
}
