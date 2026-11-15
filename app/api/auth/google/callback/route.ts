import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireUser } from "@/lib/auth";
import { exchangeCode, redirectUri } from "@/lib/google";
import { audit } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const back = new URL("/integrations", url.origin);
  try {
    const user = await requireUser();
    const jar = await cookies();
    const expectedState = jar.get("sm_oauth_state")?.value;
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    if (error) {
      back.searchParams.set("error", error === "access_denied" ? "Google access was declined." : error);
      return NextResponse.redirect(back);
    }
    if (!expectedState || !state || expectedState !== state) {
      back.searchParams.set("error", "The Google authorization response could not be verified. Try connecting again.");
      return NextResponse.redirect(back);
    }
    const code = url.searchParams.get("code");
    if (!code) {
      back.searchParams.set("error", "Google did not return an authorization code.");
      return NextResponse.redirect(back);
    }
    const profile = await exchangeCode(user.sub, code, await redirectUri(request));
    await audit(user.sub, "google_connected", "google_account", user.sub, { email: profile.email });
    const res = NextResponse.redirect(`${back.toString()}?connected=1`);
    res.cookies.set({ name: "sm_oauth_state", value: "", path: "/", maxAge: 0 });
    return res;
  } catch (err) {
    back.searchParams.set("error", err instanceof Error ? err.message : "Google connection failed.");
    return NextResponse.redirect(back);
  }
}
