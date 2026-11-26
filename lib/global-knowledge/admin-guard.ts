import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { requireAdmin } from "../platform/admin-auth";
import type { AdminRole } from "../platform/types";
import { AuthError } from "../server-auth";

export interface GlobalKnowledgeAdminCaller {
  actorId: string;
  actorEmail: string;
  actorRole: AdminRole;
  viaApiKey: boolean;
}

function timingSafeMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Guards Global Knowledge Admin endpoints via EITHER:
 * 1) `x-admin-api-key` header matching server env `ADMIN_API_KEY`, OR
 * 2) Verified platform admin session (+ TOTP re-auth when mutating).
 * Never accessible to standard users.
 */
export async function requireGlobalKnowledgeAdmin(
  req: NextRequest,
  options?: { requireReauth?: boolean },
): Promise<GlobalKnowledgeAdminCaller> {
  const envKey = (process.env.ADMIN_API_KEY ?? "").trim();
  const headerKey = (req.headers.get("x-admin-api-key") ?? "").trim();

  if (envKey && headerKey) {
    if (!timingSafeMatch(headerKey, envKey)) {
      throw new AuthError("Invalid admin API key.", 403);
    }
    return {
      actorId: "admin_api_key",
      actorEmail: "admin-api-key@system",
      actorRole: "super_admin",
      viaApiKey: true,
    };
  }

  const ctx = await requireAdmin(req, options?.requireReauth ? "admin" : "support", {
    requireReauth: options?.requireReauth,
  });
  return {
    actorId: ctx.user.ownerId,
    actorEmail: ctx.user.email,
    actorRole: ctx.meta.role,
    viaApiKey: false,
  };
}
