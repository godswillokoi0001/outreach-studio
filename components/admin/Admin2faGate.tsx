"use client";

import { useState } from "react";
import {
  Check,
  Copy,
  Download,
  KeyRound,
  Loader2,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import type { AdminRole } from "@/lib/platform/types";
import { Badge, Banner, Card, Field, Modal } from "../ui";
import { adminFetch } from "./admin-client";
import type { AuthenticatedAdminSummary } from "./AdminLoginScreen";

export interface TwoFaStatusPayload {
  role: AdminRole;
  email?: string;
  totpEnabled: boolean;
  sessionValid?: boolean;
  setup?: { secret: string; otpauthUri: string; qrDataUrl?: string };
}

export function Admin2faGate({
  status,
  onUnlocked,
  onResetToPassword,
}: {
  status: TwoFaStatusPayload;
  onUnlocked: (admin: AuthenticatedAdminSummary) => void;
  onResetToPassword?: () => void;
}) {
  const [code, setCode] = useState("");
  const [useBackupMode, setUseBackupMode] = useState(false);
  const [backupInput, setBackupInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedSecret, setCopiedSecret] = useState(false);

  const [generatedBackupCodes, setGeneratedBackupCodes] = useState<string[] | null>(null);
  const [pendingAdmin, setPendingAdmin] = useState<AuthenticatedAdminSummary | null>(null);
  const [copiedBackup, setCopiedBackup] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (useBackupMode) {
      if (backupInput.trim().length < 6) {
        setError("Enter a valid one-time backup code.");
        return;
      }
    } else if (!/^\d{6}$/.test(code.trim())) {
      setError("Enter a valid 6-digit authenticator code.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await adminFetch<{
        ok: boolean;
        admin?: AuthenticatedAdminSummary;
        backupCodes?: string[];
      }>("/api/admin/2fa", {
        method: "POST",
        body: useBackupMode
          ? { action: "verify_session", backupCode: backupInput.trim() }
          : { action: status.totpEnabled ? "verify_session" : "enable", code: code.trim() },
      });

      const signedAdmin: AuthenticatedAdminSummary = res.admin ?? {
        id: "admin",
        email: status.email || "admin",
        name: status.email || "Administrator",
        role: status.role,
        reauthActive: true,
      };

      if (res.backupCodes && res.backupCodes.length > 0) {
        setGeneratedBackupCodes(res.backupCodes);
        setPendingAdmin({ ...signedAdmin, reauthActive: true });
        return;
      }

      onUnlocked({ ...signedAdmin, reauthActive: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed.");
    } finally {
      setBusy(false);
    }
  };

  if (generatedBackupCodes && pendingAdmin) {
    const downloadCodes = () => {
      const content = [
        "Knowrevo Admin Console — Single-Use Backup Codes",
        `Account: ${pendingAdmin.email}`,
        `Generated: ${new Date().toISOString()}`,
        "",
        ...generatedBackupCodes.map((c, idx) => `${idx + 1}. ${c}`),
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
      <div
        style={{
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          padding: "24px 16px",
          background: "var(--canvas)",
        }}
      >
        <main style={{ width: "100%", maxWidth: 540 }}>
          <Card
            title="Save Your One-Time Backup Codes"
            sub="Each code works once if you ever lose access to your authenticator app. They will not be shown again."
            actions={<Badge tone="warn">Store Securely</Badge>}
          >
            <div className="stack" style={{ gap: 14 }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                  gap: 8,
                  padding: 14,
                  borderRadius: 10,
                  border: "1px solid var(--line)",
                  background: "var(--surface-2)",
                  fontFamily: "var(--mono)",
                  fontSize: 13.5,
                }}
              >
                {generatedBackupCodes.map((bCode) => (
                  <div
                    key={bCode}
                    style={{
                      padding: "6px 10px",
                      borderRadius: 6,
                      background: "var(--surface)",
                      border: "1px solid var(--line)",
                      textAlign: "center",
                      fontWeight: 600,
                    }}
                  >
                    {bCode}
                  </div>
                ))}
              </div>

              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(generatedBackupCodes.join("\n"));
                    setCopiedBackup(true);
                    setTimeout(() => setCopiedBackup(false), 2000);
                  }}
                >
                  {copiedBackup ? <Check size={13} /> : <Copy size={13} />}
                  <span>{copiedBackup ? "Copied all" : "Copy codes"}</span>
                </button>
                <button type="button" className="btn btn-sm" onClick={downloadCodes}>
                  <Download size={13} />
                  <span>Download .txt</span>
                </button>
              </div>

              <button
                type="button"
                className="btn btn-primary btn-block"
                onClick={() => onUnlocked(pendingAdmin)}
              >
                <ShieldCheck size={15} />
                <span>I saved my backup codes — Open Admin Console</span>
              </button>
            </div>
          </Card>
        </main>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: "24px 16px",
        background: "var(--canvas)",
      }}
    >
      <main style={{ width: "100%", maxWidth: 540 }}>
        <Card
          title={
            status.totpEnabled
              ? "Admin Two-Factor Verification"
              : "Set Up Admin Two-Factor Authentication"
          }
          sub={`${status.email ? `${status.email} · ` : ""}Role: ${status.role.replace("_", " ").toUpperCase()}`}
          actions={<Badge tone="info">2FA Required</Badge>}
        >
          <form onSubmit={handleSubmit} className="stack" style={{ gap: 14 }}>
            {error && <Banner tone="bad">{error}</Banner>}

            {!status.totpEnabled && status.setup && (
              <div
                style={{
                  padding: 14,
                  borderRadius: 10,
                  border: "1px solid var(--line)",
                  background: "var(--surface-2)",
                }}
                className="stack"
              >
                <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                  <ShieldAlert size={17} style={{ color: "var(--teal-deep)", flexShrink: 0, marginTop: 2 }} />
                  <div className="tiny">
                    Administrators must enable TOTP Two-Factor Authentication. Scan the QR code or
                    copy the setup key into <strong>Google Authenticator</strong>,{" "}
                    <strong>1Password</strong>, or <strong>Authy</strong>, then enter the 6-digit code.
                  </div>
                </div>

                {status.setup.qrDataUrl && (
                  <div style={{ display: "flex", justifyContent: "center", padding: "6px 0" }}>
                    <div
                      style={{
                        padding: 10,
                        borderRadius: 12,
                        background: "#ffffff",
                        border: "1px solid var(--line)",
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- local QR data URL */}
                      <img
                        src={status.setup.qrDataUrl}
                        alt="Two-factor authenticator QR code"
                        width={180}
                        height={180}
                        style={{ display: "block" }}
                      />
                    </div>
                  </div>
                )}

                <div
                  style={{
                    padding: 10,
                    borderRadius: 8,
                    background: "var(--surface)",
                    border: "1px solid var(--line)",
                    fontFamily: "var(--mono)",
                    fontSize: 12.5,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 8,
                    wordBreak: "break-all",
                  }}
                >
                  <span>{status.setup.secret}</span>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      void navigator.clipboard?.writeText(status.setup!.secret);
                      setCopiedSecret(true);
                      setTimeout(() => setCopiedSecret(false), 2000);
                    }}
                  >
                    {copiedSecret ? <Check size={12} /> : <Copy size={12} />}
                    {copiedSecret ? "Copied" : "Copy"}
                  </button>
                </div>

                <div className="tiny muted">
                  Authenticator URI:{" "}
                  <a
                    href={status.setup.otpauthUri}
                    style={{ color: "var(--teal-deep)", wordBreak: "break-all" }}
                  >
                    Open in Authenticator App
                  </a>
                </div>
              </div>
            )}

            {useBackupMode ? (
              <Field
                label="One-time backup code"
                hint="Enter an unused 8-character recovery code (e.g. ABCD-EF12)."
              >
                <input
                  className="input"
                  autoComplete="off"
                  autoFocus
                  value={backupInput}
                  onChange={(e) => setBackupInput(e.target.value.toUpperCase())}
                  placeholder="ABCD-EF12"
                  style={{
                    fontSize: 17,
                    letterSpacing: "0.14em",
                    textAlign: "center",
                    fontFamily: "var(--mono)",
                  }}
                />
              </Field>
            ) : (
              <Field
                label="6-digit Authenticator Code"
                hint="Admin sessions remain signed in for 12 hours; sensitive actions ask for fresh verification."
              >
                <input
                  className="input"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="000000"
                  style={{
                    fontSize: 18,
                    letterSpacing: "0.25em",
                    textAlign: "center",
                    fontFamily: "var(--mono)",
                  }}
                />
              </Field>
            )}

            <button
              type="submit"
              className="btn btn-primary btn-block"
              disabled={
                busy || (useBackupMode ? backupInput.trim().length < 6 : code.length !== 6)
              }
            >
              {busy ? <Loader2 size={14} className="spin" /> : <ShieldCheck size={14} />}
              {busy
                ? "Verifying…"
                : status.totpEnabled
                  ? "Unlock Admin Dashboard"
                  : "Verify & Enable 2FA"}
            </button>

            <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
              {status.totpEnabled ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setUseBackupMode((v) => !v);
                    setError(null);
                  }}
                >
                  {useBackupMode ? "Use 6-digit authenticator code" : "Use a one-time backup code"}
                </button>
              ) : (
                <span />
              )}
              {onResetToPassword && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={onResetToPassword}
                >
                  Sign in with another account
                </button>
              )}
            </div>
          </form>
        </Card>
      </main>
    </div>
  );
}

export function AdminReauthModal({
  open,
  actionLabel,
  onClose,
  onVerified,
}: {
  open: boolean;
  actionLabel: string;
  sessionToken?: string | null;
  onClose: () => void;
  onVerified: (reauthToken: string) => void;
}) {
  const [mode, setMode] = useState<"code" | "password">("code");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === "code" && !code.trim()) {
      setError("Enter your 6-digit authenticator or backup code.");
      return;
    }
    if (mode === "password" && !password) {
      setError("Enter your current administrator password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await adminFetch<{ ok: boolean }>("/api/admin/auth/reauth", {
        method: "POST",
        body: mode === "code" ? { code: code.trim() } : { password },
      });
      setCode("");
      setPassword("");
      onVerified("cookie");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Re-authentication failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Re-authenticate for Sensitive Action">
      <form onSubmit={handleSubmit} className="stack" style={{ gap: 12 }}>
        <Banner tone="warn">
          <div className="row tiny" style={{ gap: 8 }}>
            <KeyRound size={15} />
            <span>
              Confirm your identity to proceed with:{" "}
              <strong>{actionLabel || "Sensitive operation"}</strong>.
            </span>
          </div>
        </Banner>
        {error && <Banner tone="bad">{error}</Banner>}

        {mode === "code" ? (
          <Field label="Enter 2FA code or one-time backup code">
            <input
              className="input"
              autoComplete="one-time-code"
              maxLength={12}
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="000000"
              style={{
                fontSize: 18,
                letterSpacing: "0.2em",
                textAlign: "center",
                fontFamily: "var(--mono)",
              }}
            />
          </Field>
        ) : (
          <Field label="Current Administrator Password">
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
            />
          </Field>
        )}

        <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setMode((m) => (m === "code" ? "password" : "code"));
              setError(null);
            }}
          >
            {mode === "code" ? "Use current password instead" : "Use 2FA / backup code"}
          </button>

          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || (mode === "code" ? code.trim().length < 6 : !password)}
            >
              {busy ? "Verifying…" : "Confirm & Continue"}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
