import { NextRequest, NextResponse } from "next/server";
import {
  STATE_COOKIE,
  TOKEN_COOKIE,
  TOKEN_COOKIE_MAX_AGE,
  exchangeCode,
  openRecord,
  redirectUriFor,
  sealRecord,
} from "@/lib/google-oauth";

interface StateRecord {
  uid: string;
  email: string;
  nonce: string;
  redirectUri: string;
  at: number;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const back = new URL("/integrations", url.origin);
  const fail = (message: string) => {
    back.searchParams.set("google", "error");
    back.searchParams.set("reason", message);
    return NextResponse.redirect(back);
  };

  try {
    const error = url.searchParams.get("error");
    if (error) return fail(error === "access_denied" ? "Google access was declined." : error);

    const code = url.searchParams.get("code");
    const stateParam = url.searchParams.get("state");
    const nonce = req.cookies.get(STATE_COOKIE)?.value;
    if (!code || !stateParam) return fail("Google did not return an authorization code.");

    const state = await openRecord<StateRecord>(stateParam);
    if (!state || !nonce || state.nonce !== nonce) {
      return fail("The Google response could not be verified. Start the connection again.");
    }
    if (Date.now() - state.at > 10 * 60 * 1000) return fail("The connection request expired. Try again.");

    const result = await exchangeCode(code, state.redirectUri || redirectUriFor(req));
    const sealed = await sealRecord({
      uid: state.uid,
      email: result.email || state.email,
      refreshToken: result.refreshToken,
    });

    const res = NextResponse.redirect(new URL("/integrations?google=connected", url.origin));
    res.cookies.set({
      name: TOKEN_COOKIE,
      value: sealed,
      httpOnly: true,
      sameSite: "lax",
      secure: url.protocol === "https:",
      path: "/",
      maxAge: TOKEN_COOKIE_MAX_AGE,
    });
    res.cookies.set({ name: STATE_COOKIE, value: "", path: "/", maxAge: 0 });
    return res;
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Google connection failed.");
  }
}
