import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { verifyFirebaseRequest } from "@/lib/firebase-server-auth";
import { TOKEN_COOKIE, openRecord, oauthConfigured, type RefreshRecord } from "@/lib/google-oauth";

export async function POST(req: NextRequest) {
  try {
    const user = await verifyFirebaseRequest(req);
    const configured = oauthConfigured();
    const record = configured ? await openRecord<RefreshRecord>(req.cookies.get(TOKEN_COOKIE)?.value) : null;
    const connected = Boolean(record && record.uid === user.uid);
    return NextResponse.json({
      configured,
      connected,
      email: connected ? record!.email : null,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

/** Disconnect: forget the refresh token for this browser. */
export async function DELETE(req: NextRequest) {
  try {
    await verifyFirebaseRequest(req);
    const res = NextResponse.json({ ok: true });
    res.cookies.set({ name: TOKEN_COOKIE, value: "", path: "/", maxAge: 0 });
    return res;
  } catch (err) {
    return handleApiError(err);
  }
}
