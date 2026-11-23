import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { verifyFirebaseRequest } from "@/lib/firebase-server-auth";
import {
  STATE_COOKIE,
  consentUrl,
  oauthClient,
  oauthConfigured,
  redirectUriFor,
  sealRecord,
} from "@/lib/google-oauth";
import { randomId } from "@/lib/crypto";

/**
 * Starts the persistent Google connection. Called with the Firebase session
 * already verified, so the OAuth state is bound to this exact account.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await verifyFirebaseRequest(req);
    if (!oauthConfigured()) {
      return NextResponse.json(
        {
          error:
            "Persistent Google connection is not configured yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the server environment.",
          configured: false,
        },
        { status: 400 },
      );
    }
    const client = oauthClient()!;
    const redirectUri = redirectUriFor(req);
    const nonce = randomId("oauth");
    const state = await sealRecord({ uid: user.uid, email: user.email, nonce, redirectUri, at: Date.now() });

    const res = NextResponse.json({ url: consentUrl(client, redirectUri, state), configured: true });
    res.cookies.set({
      name: STATE_COOKIE,
      value: nonce,
      httpOnly: true,
      sameSite: "lax",
      secure: new URL(req.url).protocol === "https:",
      path: "/",
      maxAge: 600,
    });
    return res;
  } catch (err) {
    return handleApiError(err);
  }
}
