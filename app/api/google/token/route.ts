import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { verifyRequest } from "@/lib/server-auth";
import {
  TOKEN_COOKIE,
  openRecord,
  oauthConfigured,
  refreshAccessToken,
  type RefreshRecord,
} from "@/lib/google-oauth";

/** Hands the browser a short-lived access token from the stored refresh token. */
export async function POST(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    if (!oauthConfigured()) {
      return NextResponse.json({ connected: false, configured: false, email: null }, { status: 200 });
    }
    const sealed = req.cookies.get(TOKEN_COOKIE)?.value;
    const record = await openRecord<RefreshRecord>(sealed);
    if (!record || record.uid !== user.id) {
      return NextResponse.json(
        { connected: false, configured: true, email: null, reason: "not_connected" },
        { status: 200 },
      );
    }
    const { accessToken, expiresIn } = await refreshAccessToken(record.refreshToken);
    return NextResponse.json({
      connected: true,
      configured: true,
      email: record.email,
      accessToken,
      expiresIn,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
