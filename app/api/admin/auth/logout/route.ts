import { NextRequest, NextResponse } from "next/server";
import { clearAdminCookies, readAdminSessionFromRequest } from "@/lib/platform/admin-session";
import { appendAdminAuditLog } from "@/lib/platform/store-server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = readAdminSessionFromRequest(req);
  if (session) {
    await appendAdminAuditLog({
      actorId: session.adminId,
      actorEmail: session.email,
      actorRole: session.role,
      action: "admin_logout",
      targetType: "admin_session",
      targetId: session.adminId,
      req,
    }).catch(() => {});
  }

  const res = NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "private, no-store, max-age=0" } },
  );
  clearAdminCookies(res);
  return res;
}
