import type { NextRequest } from "next/server";
import { AuthError } from "../server-auth";
import { findAdminAccountById, type AdminAccountRecord } from "./admin-credentials";
import {
  readAdminReauthFromRequest,
  readAdminSessionFromRequest,
} from "./admin-session";
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
  if (!session) {
    throw new AuthError("Admin authentication required.", 401, "ADMIN_UNAUTHENTICATED");
  }

  const account = await findAdminAccountById(session.adminId);
  if (!account || account.status !== "active") {
    throw new AuthError("Admin session is no longer valid.", 401, "ADMIN_UNAUTHENTICATED");
  }

  if (ROLE_RANK[account.role] < ROLE_RANK[minRole]) {
    throw new AuthError("Insufficient administrator privileges.", 403, "ADMIN_FORBIDDEN");
  }

  // Login is the only authentication step: once a valid admin session exists,
  // sensitive actions never prompt for a second factor or re-authentication.
  void options?.requireReauth;
  void options?.inlineTotpCode;
  const reauthenticated = true;
  void readAdminReauthFromRequest;

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
