import type { NextRequest } from "next/server";
import { decryptSecret, verifyTotpCode } from "../key-vault";
import { AuthError } from "../server-auth";
import {
  consumeAdminBackupCode,
  findAdminAccountById,
  type AdminAccountRecord,
} from "./admin-credentials";
import { readAdminReauthFromRequest, readAdminSessionFromRequest } from "./admin-session";
import { ROLE_RANK, type AdminRole } from "./types";

export interface AdminContext {
  user: {
    id: string;
    ownerId: string;
    email: string;
    name: string;
    avatarUrl: string | null;
  };
  meta: {
    ownerId: string;
    email: string;
    name: string;
    role: AdminRole;
    status: "active" | "suspended";
    plan: string;
    lastActiveAt: string;
    totpEnabled: boolean;
    createdAt: string;
    updatedAt: string;
  };
  admin: AdminAccountRecord;
  reauthenticated: boolean;
}

/**
 * Completely isolated Admin authentication guard.
 * Reads ONLY the separate `os_admin_session` / `os_admin_reauth` HttpOnly cookies
 * backed by `admin_accounts` — never trusts regular Google/Supabase user tokens.
 */
export async function requireAdmin(
  req: NextRequest,
  minRole: AdminRole = "support",
  options?: { requireReauth?: boolean; inlineTotpCode?: string },
): Promise<AdminContext> {
  const session = readAdminSessionFromRequest(req);
  if (!session || !session.totpVerified) {
    throw new AuthError("Admin authentication required.", 401, "ADMIN_UNAUTHENTICATED");
  }

  const account = await findAdminAccountById(session.adminId);
  if (!account || account.status !== "active") {
    throw new AuthError("Admin session is no longer valid.", 401, "ADMIN_UNAUTHENTICATED");
  }

  if (ROLE_RANK[account.role] < ROLE_RANK[minRole]) {
    throw new AuthError("Insufficient administrator privileges.", 403, "ADMIN_FORBIDDEN");
  }

  let reauthenticated = readAdminReauthFromRequest(req, account.id);
  if (!reauthenticated && options?.inlineTotpCode) {
    const code = options.inlineTotpCode.replace(/\s+/g, "").trim();
    if (/^\d{6}$/.test(code) && account.totpSecretEncrypted) {
      try {
        const secret = decryptSecret(account.totpSecretEncrypted);
        reauthenticated = verifyTotpCode(secret, code);
      } catch {
        reauthenticated = false;
      }
    }
    if (!reauthenticated) {
      reauthenticated = await consumeAdminBackupCode(account, code);
    }
  }

  if (options?.requireReauth && !reauthenticated) {
    throw new AuthError(
      "Re-authentication required to perform this sensitive action.",
      403,
      "ADMIN_REAUTH_REQUIRED",
    );
  }

  const nowIso = new Date().toISOString();
  return {
    user: {
      id: account.id,
      ownerId: account.id,
      email: account.email,
      name: account.name,
      avatarUrl: null,
    },
    meta: {
      ownerId: account.id,
      email: account.email,
      name: account.name,
      role: account.role,
      status: account.status,
      plan: "platform_admin",
      lastActiveAt: account.lastLoginAt ?? nowIso,
      totpEnabled: account.totpEnabled,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    },
    admin: account,
    reauthenticated,
  };
}
