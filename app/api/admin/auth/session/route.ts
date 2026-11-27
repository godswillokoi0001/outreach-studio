import { NextRequest, NextResponse } from "next/server";
import { buildTotpUri, decryptSecret } from "@/lib/key-vault";
import { findAdminAccountById } from "@/lib/platform/admin-credentials";
import {
  clearAdminCookies,
  readAdminChallengeFromRequest,
  readAdminReauthFromRequest,
  readAdminSessionFromRequest,
  setAdminSessionCookies,
} from "@/lib/platform/admin-session";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = readAdminSessionFromRequest(req);
  if (session) {
    const account = await findAdminAccountById(session.adminId);
    if (account && account.status === "active") {
      const reauthActive = readAdminReauthFromRequest(req, account.id);
      const res = NextResponse.json(
        {
          authenticated: true,
          admin: {
            id: account.id,
            email: account.email,
            name: account.name,
            role: account.role,
            reauthActive,
          },
        },
        { headers: { "Cache-Control": "private, no-store, max-age=0" } },
      );
      // Sliding 30-minute idle refresh while active
      setAdminSessionCookies(res, account);
      return res;
    }
  }

  const challenge = readAdminChallengeFromRequest(req);
  if (challenge) {
    const account = await findAdminAccountById(challenge.adminId);
    if (account && account.status === "active") {
      let setup: { secret: string; otpauthUri: string } | undefined;
      if (!account.totpEnabled && account.totpSecretEncrypted) {
        try {
          const secret = decryptSecret(account.totpSecretEncrypted);
          setup = { secret, otpauthUri: buildTotpUri(secret, account.email, "Knowrevo Admin") };
        } catch {
          setup = undefined;
        }
      }
      return NextResponse.json(
        {
          authenticated: false,
          challengePending: true,
          totpEnabled: account.totpEnabled,
          setup,
        },
        { headers: { "Cache-Control": "private, no-store, max-age=0" } },
      );
    }
  }

  const res = NextResponse.json(
    { authenticated: false, challengePending: false },
    { headers: { "Cache-Control": "private, no-store, max-age=0" } },
  );
  if (session) clearAdminCookies(res);
  return res;
}
