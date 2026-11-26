import type { NextRequest } from "next/server";
import { verifyAdmin2faToken, verifyTotpCode, decryptSecret } from "../key-vault";
import { AuthError, verifyRequest, type AuthUser } from "../server-auth";
import { getUserGovernance, type UserGovernanceMeta } from "./store-server";
import { ROLE_RANK, type AdminRole } from "./types";

export class AdminAuthError extends AuthError {
  code: string;
  constructor(message: string, code: string, status = 403) {
    super(message, status);
    this.code = code;
  }
}

export async function requireAdmin(
  req: NextRequest,
  minRole: Exclude<AdminRole, "user"> = "support",
  options?: { requireReauth?: boolean; inlineTotpCode?: string },
): Promise<{ user: AuthUser; meta: UserGovernanceMeta }> {
  const user = await verifyRequest(req);
  const meta = await getUserGovernance(user.ownerId, user.email, {
    name: user.name,
    avatarUrl: user.avatarUrl,
  });

  if (meta.status === "suspended") {
    throw new AuthError("Your account has been suspended. Contact support.", 403);
  }

  if (ROLE_RANK[meta.role] < ROLE_RANK[minRole]) {
    throw new AdminAuthError(
      `This action requires ${minRole.replace("_", " ")} permissions.`,
      "ADMIN_FORBIDDEN",
      403,
    );
  }

  if (!meta.totpEnabled || !meta.totpSecretEncrypted) {
    throw new AdminAuthError(
      "Two-factor authentication must be enabled before accessing the Admin Dashboard.",
      "ADMIN_2FA_SETUP_REQUIRED",
      403,
    );
  }

  const sessionToken = req.headers.get("x-admin-2fa");
  if (!verifyAdmin2faToken(sessionToken, user.id, "session")) {
    throw new AdminAuthError(
      "Enter your 6-digit authenticator code to unlock this Admin session.",
      "ADMIN_2FA_REQUIRED",
      403,
    );
  }

  if (options?.requireReauth) {
    const reauthToken = req.headers.get("x-admin-reauth");
    const hasValidReauthToken = verifyAdmin2faToken(reauthToken, user.id, "reauth");
    let hasValidInlineCode = false;
    if (!hasValidReauthToken && options.inlineTotpCode) {
      const secret = decryptSecret(meta.totpSecretEncrypted);
      hasValidInlineCode = verifyTotpCode(secret, options.inlineTotpCode);
    }

    if (!hasValidReauthToken && !hasValidInlineCode) {
      throw new AdminAuthError(
        "Re-authentication with your 2FA code is required for this sensitive action.",
        "ADMIN_REAUTH_REQUIRED",
        403,
      );
    }
  }

  return { user, meta };
}
