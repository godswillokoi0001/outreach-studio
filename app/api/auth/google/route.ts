import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { buildAuthUrl, redirectUri } from "@/lib/google";
import { randomId } from "@/lib/crypto";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await requireUser();
  const uri = await redirectUri(request);
  const state = randomId("state");
  const url = await buildAuthUrl(user.sub, uri, state);
  const res = NextResponse.redirect(url);
  res.cookies.set({
    name: "sm_oauth_state",
    value: state,
    httpOnly: true,
    sameSite: "lax",
    secure: new URL(request.url).protocol === "https:",
    path: "/",
    maxAge: 600,
  });
  return res;
}
