import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getEnv } from "@/lib/env";
import { currentUser, authMode, createPasswordSession, requirePasswordMatch, sessionCookieOptions, clearSessionCookie } from "@/lib/auth";
import { route, readJson, ok, HttpError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  return route(async () => {
    const env = await getEnv();
    const user = await currentUser();
    return ok({
      authed: Boolean(user),
      mode: authMode(env),
      user: user ? { name: user.name ?? "", email: user.email ?? "", via: user.via } : null,
    });
  });
}

const attempts = new Map<string, { count: number; resetAt: number }>();

export async function POST(request: Request) {
  return route(async () => {
    const env = await getEnv();
    if (authMode(env) !== "password") {
      throw new HttpError(400, "Password sign-in is not enabled on this deployment.");
    }
    const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "local";
    const record = attempts.get(ip);
    const nowMs = Date.now();
    if (record && record.resetAt > nowMs && record.count >= 5) {
      throw new HttpError(429, "Too many attempts. Try again in a few minutes.");
    }

    const body = await readJson<{ password?: string }>(request);
    try {
      await requirePasswordMatch(String(body.password ?? ""));
    } catch (err) {
      const active = record && record.resetAt > nowMs ? record : { count: 0, resetAt: nowMs + 10 * 60_000 };
      attempts.set(ip, { count: active.count + 1, resetAt: active.resetAt });
      throw err;
    }
    attempts.delete(ip);

    const secret = env.APP_SESSION_SECRET || env.APP_PASSWORD!;
    const token = await createPasswordSession(secret);
    const res = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
    const opts = sessionCookieOptions();
    res.cookies.set({ ...opts, value: token });
    return res;
  });
}

export async function DELETE() {
  const jar = await cookies();
  const opts = clearSessionCookie();
  jar.set(opts);
  return ok({ ok: true });
}
