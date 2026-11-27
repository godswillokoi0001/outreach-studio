"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Copy,
  Download,
  KeyRound,
  Lock,
  LogOut,
  Plus,
  RefreshCw,
  Shield,
  ShieldCheck,
  UserCheck,
  UserX,
} from "lucide-react";
import { BrandLoader } from "@/components/BrandLoader";
import { Badge, Banner, Card, Field, Modal } from "@/components/ui";
import { useConfirm, useToast } from "@/components/Feedback";
import type { AdminRole } from "@/lib/platform/types";
import type { AuthenticatedAdminSummary } from "./AdminLoginScreen";
import { AdminClientError, adminFetch } from "./admin-client";

interface AdminAccountPublic {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  status: "active" | "suspended";
  totpEnabled: boolean;
  backupCodesRemaining: number;
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  createdBy: string | null;
  createdAt: string;
}

export function AdminSecurityTab({
  admin,
  reauthActive,
  sessionToken,
  onNeedReauth,
  onLogout,
}: {
  admin: AuthenticatedAdminSummary;
  reauthActive: boolean;
  sessionToken: string;
  onNeedReauth: (label: string, retryFn: (freshToken: string) => Promise<void>) => void;
  onLogout: () => Promise<void> | void;
}) {
  const isSuperAdmin = admin.role === "super_admin";
  const toast = useToast();
  const confirmDialog = useConfirm();

  const [backupCodesRemaining, setBackupCodesRemaining] = useState<number | null>(null);
  const [freshBackupCodes, setFreshBackupCodes] = useState<string[] | null>(null);
  const [copiedCodes, setCopiedCodes] = useState(false);

  // Rotate 2FA setup state
  const [rotateSetup, setRotateSetup] = useState<{
    secret: string;
    otpauthUri: string;
    qrDataUrl?: string;
    pendingSecretToken: string;
  } | null>(null);
  const [rotateCode, setRotateCode] = useState("");
  const [busy2fa, setBusy2fa] = useState(false);

  // Change own password state
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPw, setSavingPw] = useState(false);

  // Super Admin accounts manager
  const [accounts, setAccounts] = useState<AdminAccountPublic[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState<AdminRole>("admin");
  const [newAccPassword, setNewAccPassword] = useState("");
  const [savingAcc, setSavingAcc] = useState(false);

  const load2faStatus = useCallback(async () => {
    try {
      const res = await adminFetch<{ backupCodesRemaining?: number }>("/api/admin/2fa", {
        sessionToken,
      });
      if (typeof res.backupCodesRemaining === "number") {
        setBackupCodesRemaining(res.backupCodesRemaining);
      }
    } catch {
      /* ignore transient fetch failure */
    }
  }, [sessionToken]);

  const loadAccounts = useCallback(async () => {
    if (!isSuperAdmin) return;
    setLoadingAccounts(true);
    try {
      const res = await adminFetch<{ accounts: AdminAccountPublic[] }>("/api/admin/auth/accounts", {
        sessionToken,
      });
      setAccounts(res.accounts ?? []);
    } catch (err) {
      toast.error("Could not load admin accounts", err instanceof Error ? err.message : "Error");
    } finally {
      setLoadingAccounts(false);
    }
  }, [isSuperAdmin, sessionToken, toast]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void load2faStatus();
      if (isSuperAdmin) void loadAccounts();
    }, 0);
    return () => window.clearTimeout(t);
  }, [load2faStatus, loadAccounts, isSuperAdmin]);

  const regenerateBackupCodes = async (freshToken?: string) => {
    setBusy2fa(true);
    try {
      const res = await adminFetch<{ backupCodes: string[]; backupCodesRemaining: number }>(
        "/api/admin/2fa",
        {
          method: "POST",
          sessionToken,
          reauthToken: freshToken ?? (reauthActive ? "cookie" : null),
          body: { action: "regenerate_backup_codes" },
        },
      );
      setFreshBackupCodes(res.backupCodes);
      setBackupCodesRemaining(res.backupCodesRemaining);
      toast.success("Generated 10 new single-use backup codes");
    } catch (err) {
      if (err instanceof AdminClientError && err.code === "ADMIN_REAUTH_REQUIRED") {
        onNeedReauth("Regenerate Admin 2FA backup codes", (t) => regenerateBackupCodes(t));
        return;
      }
      toast.error("Failed to regenerate backup codes", err instanceof Error ? err.message : "Error");
    } finally {
      setBusy2fa(false);
    }
  };

  const startRotate2fa = async (freshToken?: string) => {
    setBusy2fa(true);
    try {
      const res = await adminFetch<{
        secret: string;
        otpauthUri: string;
        qrDataUrl?: string;
        pendingSecretToken: string;
      }>("/api/admin/2fa", {
        method: "POST",
        sessionToken,
        reauthToken: freshToken ?? (reauthActive ? "cookie" : null),
        body: { action: "start_setup_reset" },
      });
      setRotateSetup(res);
      setRotateCode("");
    } catch (err) {
      if (err instanceof AdminClientError && err.code === "ADMIN_REAUTH_REQUIRED") {
        onNeedReauth("Rotate Admin 2FA secret key", (t) => startRotate2fa(t));
        return;
      }
      toast.error("Failed to start 2FA reset", err instanceof Error ? err.message : "Error");
    } finally {
      setBusy2fa(false);
    }
  };

  const confirmRotate2fa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rotateSetup || !/^\d{6}$/.test(rotateCode.trim())) return;
    setBusy2fa(true);
    try {
      const res = await adminFetch<{ backupCodes: string[]; backupCodesRemaining: number }>(
        "/api/admin/2fa",
        {
          method: "POST",
          sessionToken,
          reauthToken: reauthActive ? "cookie" : null,
          body: {
            action: "confirm_setup_reset",
            pendingSecretToken: rotateSetup.pendingSecretToken,
            code: rotateCode.trim(),
          },
        },
      );
      setRotateSetup(null);
      setRotateCode("");
      setFreshBackupCodes(res.backupCodes);
      setBackupCodesRemaining(res.backupCodesRemaining);
      toast.success("Authenticator rotated cleanly");
    } catch (err) {
      toast.error("Verification failed", err instanceof Error ? err.message : "Error");
    } finally {
      setBusy2fa(false);
    }
  };

  const changeOwnPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 10) {
      toast.error("Password must be at least 10 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("Passwords do not match.");
      return;
    }
    setSavingPw(true);
    try {
      await adminFetch("/api/admin/auth/password", {
        method: "POST",
        sessionToken,
        body: { currentPassword, newPassword },
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success("Administrator password updated");
    } catch (err) {
      toast.error("Could not update password", err instanceof Error ? err.message : "Error");
    } finally {
      setSavingPw(false);
    }
  };

  const runAccountAction = async (
    label: string,
    payload: Record<string, unknown>,
    freshToken?: string,
  ) => {
    try {
      await adminFetch("/api/admin/auth/accounts", {
        method: "POST",
        sessionToken,
        reauthToken: freshToken ?? (reauthActive ? "cookie" : null),
        body: payload,
      });
      toast.success("Admin account updated");
      setCreateOpen(false);
      setNewEmail("");
      setNewName("");
      setNewAccPassword("");
      await loadAccounts();
    } catch (err) {
      if (err instanceof AdminClientError && err.code === "ADMIN_REAUTH_REQUIRED") {
        onNeedReauth(label, (t) => runAccountAction(label, payload, t));
        return;
      }
      toast.error("Action failed", err instanceof Error ? err.message : "Error");
    }
  };

  const downloadBackupCodes = (codes: string[]) => {
    const content = [
      "Knowrevo Admin Console — Single-Use Backup Codes",
      `Account: ${admin.email}`,
      `Generated: ${new Date().toISOString()}`,
      "",
      ...codes.map((c, idx) => `${idx + 1}. ${c}`),
    ].join("\n");
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "knowrevo-admin-backup-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      {/* Current Admin Session & Authentication Summary */}
      <Card
        title="Current Admin Session"
        sub="Isolated administrator session signed with TOTP 2FA verification (12-hour idle expiry)."
        actions={
          <div className="row" style={{ gap: 8 }}>
            <Badge tone="ok">
              <ShieldCheck size={11} style={{ marginRight: 4 }} />
              2FA Verified
            </Badge>
            <Badge tone={reauthActive ? "ok" : "warn"}>
              <Lock size={11} style={{ marginRight: 4 }} />
              {reauthActive ? "Elevated Re-Auth Active" : "Standard Session"}
            </Badge>
          </div>
        }
      >
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div className="stack" style={{ gap: 4 }}>
            <div className="strong">{admin.email}</div>
            <div className="tiny muted">
              Role: <strong>{admin.role.replace("_", " ").toUpperCase()}</strong>
              {backupCodesRemaining !== null
                ? ` · ${backupCodesRemaining} unused backup code${backupCodesRemaining === 1 ? "" : "s"} remaining`
                : ""}
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {!reauthActive && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => onNeedReauth("Verify fresh administrator identity", async () => {})}
              >
                <KeyRound size={13} /> Verify Re-Auth Now
              </button>
            )}
            <button type="button" className="btn btn-sm btn-danger" onClick={() => void onLogout()}>
              <LogOut size={13} /> Sign Out Admin Session
            </button>
          </div>
        </div>
      </Card>

      {/* Two-Factor Authentication & Backup Codes */}
      <div className="grid grid-2" style={{ gap: 16 }}>
        <Card
          title="Two-Factor Authentication & Backup Codes"
          sub="Manage your authenticator app QR pairing and single-use emergency backup codes."
        >
          <div className="stack" style={{ gap: 12 }}>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy2fa}
                onClick={() => void regenerateBackupCodes()}
              >
                <RefreshCw size={13} />
                Generate 10 New Backup Codes
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy2fa}
                onClick={() => void startRotate2fa()}
              >
                <KeyRound size={13} />
                Rotate Authenticator QR
              </button>
            </div>

            {freshBackupCodes && (
              <div
                style={{
                  padding: 12,
                  borderRadius: 10,
                  border: "1px solid var(--line)",
                  background: "var(--surface-2)",
                }}
                className="stack"
              >
                <div className="tiny strong">
                  New Backup Codes (shown once — old codes are now invalid)
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                    gap: 6,
                    fontFamily: "var(--mono)",
                    fontSize: 12.5,
                  }}
                >
                  {freshBackupCodes.map((c) => (
                    <div
                      key={c}
                      style={{
                        padding: "4px 8px",
                        borderRadius: 6,
                        background: "var(--surface)",
                        border: "1px solid var(--line)",
                        textAlign: "center",
                      }}
                    >
                      {c}
                    </div>
                  ))}
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      void navigator.clipboard?.writeText(freshBackupCodes.join("\n"));
                      setCopiedCodes(true);
                      setTimeout(() => setCopiedCodes(false), 2000);
                    }}
                  >
                    {copiedCodes ? <Check size={12} /> : <Copy size={12} />}
                    {copiedCodes ? "Copied" : "Copy all"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => downloadBackupCodes(freshBackupCodes)}
                  >
                    <Download size={12} />
                    Download .txt
                  </button>
                </div>
              </div>
            )}

            {rotateSetup && (
              <form
                onSubmit={confirmRotate2fa}
                style={{
                  padding: 12,
                  borderRadius: 10,
                  border: "1px solid var(--line)",
                  background: "var(--surface-2)",
                }}
                className="stack"
              >
                <div className="tiny strong">Scan New QR Code &amp; Confirm</div>
                {rotateSetup.qrDataUrl && (
                  <div style={{ display: "flex", justifyContent: "center" }}>
                    <div style={{ padding: 8, background: "#fff", borderRadius: 10, border: "1px solid var(--line)" }}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- local QR data URL */}
                      <img src={rotateSetup.qrDataUrl} alt="New 2FA QR Code" width={160} height={160} />
                    </div>
                  </div>
                )}
                <div className="tiny muted" style={{ fontFamily: "var(--mono)", wordBreak: "break-all" }}>
                  Secret: {rotateSetup.secret}
                </div>
                <Field label="Enter 6-digit code from new device">
                  <input
                    className="input"
                    inputMode="numeric"
                    maxLength={6}
                    value={rotateCode}
                    onChange={(e) => setRotateCode(e.target.value.replace(/\D/g, ""))}
                    placeholder="000000"
                  />
                </Field>
                <div className="row" style={{ gap: 8 }}>
                  <button type="submit" className="btn btn-sm btn-primary" disabled={busy2fa || rotateCode.length !== 6}>
                    Confirm Rotation
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRotateSetup(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        </Card>

        {/* Change Own Password */}
        <Card
          title="Administrator Password"
          sub="Passwords require at least 10 characters and are hashed with scrypt."
        >
          <form onSubmit={changeOwnPassword} className="stack" style={{ gap: 10 }}>
            <Field label="Current Password">
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
              />
            </Field>
            <Field label="New Password (min 10 chars)">
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
              />
            </Field>
            <Field label="Confirm New Password">
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
            </Field>
            <div>
              <button type="submit" className="btn btn-primary btn-sm" disabled={savingPw}>
                <KeyRound size={13} />
                {savingPw ? "Saving…" : "Update Password"}
              </button>
            </div>
          </form>
        </Card>
      </div>

      {/* Super Admin Accounts & Permissions */}
      {isSuperAdmin ? (
        <Card
          title="Administrator Accounts & Permissions"
          sub="Add, suspend, promote, or reset 2FA/passwords on dedicated admin accounts. Requires re-authentication."
          actions={
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
              <Plus size={13} /> Add Admin
            </button>
          }
        >
          {loadingAccounts ? (
            <BrandLoader />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Admin</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>2FA</th>
                    <th>Last Login</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((acc) => {
                    const isSelf = acc.id === admin.id;
                    return (
                      <tr key={acc.id}>
                        <td>
                          <div className="strong tiny">{acc.name}</div>
                          <div className="tiny muted">{acc.email}</div>
                        </td>
                        <td>
                          <select
                            className="input"
                            disabled={isSelf}
                            value={acc.role}
                            onChange={(e) =>
                              void runAccountAction(`Change role for ${acc.email}`, {
                                action: "update_role",
                                targetId: acc.id,
                                role: e.target.value,
                              })
                            }
                            style={{ maxWidth: 140, padding: "4px 8px", fontSize: 12 }}
                          >
                            <option value="super_admin">SUPER ADMIN</option>
                            <option value="admin">ADMIN</option>
                            <option value="support">SUPPORT</option>
                          </select>
                        </td>
                        <td>
                          <Badge tone={acc.status === "active" ? "ok" : "bad"}>{acc.status}</Badge>
                        </td>
                        <td>
                          <Badge tone={acc.totpEnabled ? "ok" : "warn"}>
                            {acc.totpEnabled ? `Enabled (${acc.backupCodesRemaining} codes)` : "Setup needed"}
                          </Badge>
                        </td>
                        <td className="tiny muted">
                          {acc.lastLoginAt ? new Date(acc.lastLoginAt).toLocaleString() : "Never"}
                          {acc.lastLoginIp ? ` (${acc.lastLoginIp})` : ""}
                        </td>
                        <td>
                          <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                            {!isSelf && (
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                onClick={() =>
                                  void runAccountAction(
                                    `${acc.status === "active" ? "Suspend" : "Reactivate"} ${acc.email}`,
                                    {
                                      action: acc.status === "active" ? "suspend" : "reactivate",
                                      targetId: acc.id,
                                    },
                                  )
                                }
                              >
                                {acc.status === "active" ? <UserX size={12} /> : <UserCheck size={12} />}
                                {acc.status === "active" ? "Suspend" : "Activate"}
                              </button>
                            )}
                            <button
                              type="button"
                              className="btn btn-sm btn-ghost"
                              onClick={async () => {
                                const ok = await confirmDialog({
                                  title: `Reset 2FA for ${acc.email}?`,
                                  message: "They will be required to scan a new authenticator QR code at next sign-in.",
                                  confirmLabel: "Reset 2FA",
                                  tone: "bad",
                                });
                                if (!ok) return;
                                await runAccountAction(`Reset 2FA for ${acc.email}`, {
                                  action: "reset_2fa",
                                  targetId: acc.id,
                                });
                              }}
                            >
                              <KeyRound size={12} /> Reset 2FA
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : (
        <Card title="Administrator Access Policy" sub="Role capabilities in Knowrevo Platform Administration">
          <Banner tone="info">
            <div className="row tiny" style={{ gap: 8 }}>
              <Shield size={14} />
              <span>
                You are signed in with role <strong>{admin.role.toUpperCase()}</strong>. Creating or
                suspending other admin accounts is reserved for Super Admins.
              </span>
            </div>
          </Banner>
        </Card>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Create Dedicated Admin Account">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setSavingAcc(true);
            try {
              await runAccountAction(`Create admin ${newEmail}`, {
                action: "create",
                email: newEmail,
                name: newName,
                role: newRole,
                password: newAccPassword,
              });
            } finally {
              setSavingAcc(false);
            }
          }}
          className="stack"
          style={{ gap: 12 }}
        >
          <Field label="Admin Email">
            <input
              className="input"
              type="email"
              required
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
            />
          </Field>
          <Field label="Full Name">
            <input
              className="input"
              required
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </Field>
          <Field label="Role">
            <select
              className="input"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as AdminRole)}
            >
              <option value="admin">Admin (full operational control)</option>
              <option value="support">Support (read-only + user support)</option>
              <option value="super_admin">Super Admin (full + admin creation)</option>
            </select>
          </Field>
          <Field label="Initial Password (min 10 chars)">
            <input
              className="input"
              type="password"
              required
              minLength={10}
              value={newAccPassword}
              onChange={(e) => setNewAccPassword(e.target.value)}
            />
          </Field>
          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="btn btn-ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={savingAcc}>
              {savingAcc ? "Creating…" : "Create Admin"}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
