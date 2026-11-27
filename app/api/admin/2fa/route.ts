import QRCode from "qrcode";
import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import {
  buildTotpUri,
  decryptSecret,
  encryptSecret,
  generateTotpSecret,
  verifyTotpCode,
} from "@/lib/key-vault";
import { requireAdmin } from "@/lib/platform/admin-auth";
import {
  checkAdminLoginLockout,
  clearAdminAuthFailures,
  consumeAdminBackupCode,
  findAdminAccountById,
  generateAdminBackupCodes,
  recordAdminAuthFailure,
  saveAdminAccountRecord,
} from "@/lib/platform/admin-credentials";
import {
  clearAdminCookies,
  readAdminChallengeFromRequest,
  readAdminSessionFromRequest,
  setAdminReauthCookie,
  setAdminSessionCookies,
} from "@/lib/platform/admin-session";
import { appendAdminAuditLog, extractRequestMeta } from "@/lib/platform/store-server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const session = readAdminSessionFromRequest(req);
    if (session?.totpVerified) {
      const ctx = await requireAdmin(req, "support");
      return NextResponse.json(
        {
          role: ctx.admin.role,
          totpEnabled: ctx.admin.totpEnabled,
          backupCodesRemaining: Array.isArray(ctx.admin.backupCodesHashes)
            ? ctx.admin.backupCodesHashes.length
            : 0,
          sessionValid: true,
          reauthActive: ctx.reauthenticated,
        },
        { headers: { "Cache-Control": "private, no-store, max-age=0" } },
      );
    }

    const challenge = readAdminChallengeFromRequest(req);
    if (!challenge) {
      return NextResponse.json({ error: "Admin challenge missing or expired." }, { status: 401 });
    }
    const account = await findAdminAccountById(challenge.adminId);
    if (!account || account.status !== "active") {
      return NextResponse.json({ error: "Admin account not active." }, { status: 401 });
    }
    let setup: { secret: string; otpauthUri: string; qrDataUrl?: string } | undefined;
    if (!account.totpEnabled && account.totpSecretEncrypted) {
      const secret = decryptSecret(account.totpSecretEncrypted);
      const otpauthUri = buildTotpUri(secret, account.email, "Knowrevo Admin");
      const qrDataUrl = await QRCode.toDataURL(otpauthUri, { width: 220, margin: 1 }).catch(
        () => undefined,
      );
      setup = { secret, otpauthUri, qrDataUrl };
    }
    return NextResponse.json(
      {
        role: account.role,
        totpEnabled: account.totpEnabled,
        sessionValid: false,
        setup,
      },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?:
        | "enable"
        | "verify_session"
        | "reauth"
        | "regenerate_backup_codes"
        | "start_setup_reset"
        | "confirm_setup_reset";
      code?: string;
      backupCode?: string;
      pendingSecretToken?: string;
    };

    // 1) Authenticated session actions (Security settings + reauth)
    if (
      body.action === "reauth" ||
      body.action === "regenerate_backup_codes" ||
      body.action === "start_setup_reset" ||
      body.action === "confirm_setup_reset"
    ) {
      const needsReauth = body.action !== "reauth";
      const ctx = await requireAdmin(req, "support", {
        requireReauth: needsReauth,
        inlineTotpCode: body.code,
      });

      if (body.action === "reauth") {
        const rawCode = String(body.code ?? body.backupCode ?? "").trim();
        let valid = false;
        if (/^\d{6}$/.test(rawCode.replace(/\s+/g, "")) && ctx.admin.totpSecretEncrypted) {
          const secret = decryptSecret(ctx.admin.totpSecretEncrypted);
          valid = verifyTotpCode(secret, rawCode.replace(/\s+/g, ""));
        } else if (rawCode) {
          valid = await consumeAdminBackupCode(ctx.admin, rawCode);
        }
        if (!valid) {
          return NextResponse.json(
            { error: "Invalid 6-digit authenticator code or backup code." },
            { status: 401 },
          );
        }
        await appendAdminAuditLog({
          actorId: ctx.admin.id,
          actorEmail: ctx.admin.email,
          actorRole: ctx.admin.role,
          action: "admin_reauth_verified",
          targetType: "admin_security",
          targetId: ctx.admin.id,
          req,
        });
        const res = NextResponse.json(
          { ok: true },
          { headers: { "Cache-Control": "private, no-store, max-age=0" } },
        );
        setAdminReauthCookie(res, ctx.admin);
        return res;
      }

      if (body.action === "regenerate_backup_codes") {
        const { plaintextCodes, hashes } = generateAdminBackupCodes(10);
        await saveAdminAccountRecord({
          ...ctx.admin,
          backupCodesHashes: hashes,
        });
        await appendAdminAuditLog({
          actorId: ctx.admin.id,
          actorEmail: ctx.admin.email,
          actorRole: ctx.admin.role,
          action: "admin_backup_codes_regenerated",
          targetType: "admin_security",
          targetId: ctx.admin.id,
          req,
        });
        return NextResponse.json(
          { ok: true, backupCodes: plaintextCodes, backupCodesRemaining: hashes.length },
          { headers: { "Cache-Control": "private, no-store, max-age=0" } },
        );
      }

      if (body.action === "start_setup_reset") {
        const newSecret = generateTotpSecret();
        const otpauthUri = buildTotpUri(newSecret, ctx.admin.email, "Knowrevo Admin");
        const qrDataUrl = await QRCode.toDataURL(otpauthUri, { width: 220, margin: 1 }).catch(
          () => undefined,
        );
        const pendingSecretToken = encryptSecret(newSecret);
        return NextResponse.json(
          { ok: true, secret: newSecret, otpauthUri, qrDataUrl, pendingSecretToken },
          { headers: { "Cache-Control": "private, no-store, max-age=0" } },
        );
      }

      if (body.action === "confirm_setup_reset") {
        const cleanCode = String(body.code ?? "").replace(/\s+/g, "").trim();
        const token = String(body.pendingSecretToken ?? "").trim();
        if (!token || !/^\d{6}$/.test(cleanCode)) {
          return NextResponse.json(
            { error: "Enter the 6-digit code from your new authenticator setup." },
            { status: 400 },
          );
        }
        const decryptedSecret = decryptSecret(token);
        if (!verifyTotpCode(decryptedSecret, cleanCode)) {
          return NextResponse.json(
            { error: "That 6-digit code did not match the new authenticator setup." },
            { status: 401 },
          );
        }
        const { plaintextCodes, hashes } = generateAdminBackupCodes(10);
        await saveAdminAccountRecord({
          ...ctx.admin,
          totpEnabled: true,
          totpSecretEncrypted: encryptSecret(decryptedSecret),
          backupCodesHashes: hashes,
        });
        await appendAdminAuditLog({
          actorId: ctx.admin.id,
          actorEmail: ctx.admin.email,
          actorRole: ctx.admin.role,
          action: "admin_2fa_rotated",
          targetType: "admin_security",
          targetId: ctx.admin.id,
          req,
        });
        return NextResponse.json(
          { ok: true, backupCodes: plaintextCodes, backupCodesRemaining: hashes.length },
          { headers: { "Cache-Control": "private, no-store, max-age=0" } },
        );
      }
    }

    // 2) Two-factor login completion from temporary challenge cookie
    const challenge = readAdminChallengeFromRequest(req);
    if (!challenge) {
      return NextResponse.json(
        { error: "Your sign-in challenge expired. Sign in again with email and password." },
        { status: 401, headers: { "Cache-Control": "private, no-store, max-age=0" } },
      );
    }

    const lockout = await checkAdminLoginLockout(challenge.email, req);
    if (lockout.locked) {
      return NextResponse.json(
        {
          error: `Too many failed verification attempts. Try again in ${Math.max(1, Math.ceil(lockout.retryAfterSeconds / 60))} minute(s).`,
          retryAfterSeconds: lockout.retryAfterSeconds,
        },
        {
          status: 429,
          headers: {
            "Cache-Control": "private, no-store, max-age=0",
            "Retry-After": String(lockout.retryAfterSeconds),
          },
        },
      );
    }

    const account = await findAdminAccountById(challenge.adminId);
    if (!account || account.status !== "active") {
      return NextResponse.json({ error: "Admin account unavailable." }, { status: 401 });
    }

    const rawCode = String(body.backupCode ?? body.code ?? "").trim();
    const compactDigits = rawCode.replace(/\s+/g, "");
    const isSixDigit = /^\d{6}$/.test(compactDigits);

    let verified = false;
    let usedBackupCode = false;
    let newlyGeneratedBackupCodes: string[] | undefined;

    if (account.totpSecretEncrypted && isSixDigit) {
      try {
        const secret = decryptSecret(account.totpSecretEncrypted);
        verified = verifyTotpCode(secret, compactDigits);
      } catch {
        verified = false;
      }
    } else if (account.totpEnabled && rawCode) {
      verified = await consumeAdminBackupCode(account, rawCode);
      usedBackupCode = verified;
    }

    if (!verified) {
      const fail = await recordAdminAuthFailure({
        email: account.email,
        stage: "totp",
        req,
      });
      if (fail.locked) {
        return NextResponse.json(
          {
            error: "Too many failed 2FA attempts. Sign-in temporarily locked.",
            retryAfterSeconds: fail.retryAfterSeconds,
          },
          { status: 429, headers: { "Retry-After": String(fail.retryAfterSeconds) } },
        );
      }
      return NextResponse.json(
        { error: "Invalid verification code. Please check your authenticator app or backup code." },
        { status: 401, headers: { "Cache-Control": "private, no-store, max-age=0" } },
      );
    }

    await clearAdminAuthFailures(account.email, req);
    const { ipAddress } = extractRequestMeta(req);
    const nowIso = new Date().toISOString();

    let updatedHashes = account.backupCodesHashes ?? [];
    if (!account.totpEnabled || body.action === "enable") {
      const generated = generateAdminBackupCodes(10);
      newlyGeneratedBackupCodes = generated.plaintextCodes;
      updatedHashes = generated.hashes;
    } else if (usedBackupCode) {
      // Re-fetch to keep the remaining backup hashes saved by consumeAdminBackupCode
      const refreshed = await findAdminAccountById(account.id);
      updatedHashes = refreshed?.backupCodesHashes ?? updatedHashes;
    }

    await saveAdminAccountRecord({
      ...account,
      totpEnabled: true,
      backupCodesHashes: updatedHashes,
      lastLoginAt: nowIso,
      lastLoginIp: ipAddress,
    });

    await appendAdminAuditLog({
      actorId: account.id,
      actorEmail: account.email,
      actorRole: account.role,
      action: !account.totpEnabled ? "admin_2fa_enabled_and_login" : "admin_login_success",
      targetType: "admin_session",
      targetId: account.id,
      details: { role: account.role, usedBackupCode, ipAddress },
      req,
    });

    const res = NextResponse.json(
      {
        ok: true,
        usedBackupCode,
        ...(newlyGeneratedBackupCodes ? { backupCodes: newlyGeneratedBackupCodes } : {}),
        admin: {
          id: account.id,
          email: account.email,
          name: account.name,
          role: account.role,
        },
      },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
    clearAdminCookies(res);
    setAdminSessionCookies(res, account, { totpVerified: true, includeReauth: true });
    return res;
  } catch (err) {
    return handleApiError(err);
  }
}
