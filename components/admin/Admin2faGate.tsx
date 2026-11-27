"use client";

import { useState } from "react";
import { Copy, Check, KeyRound, Loader2, ShieldAlert, ShieldCheck } from "lucide-react";
import type { AdminRole } from "@/lib/platform/types";
import { Badge, Banner, Card, Field, Modal } from "../ui";
import { adminFetch } from "./admin-client";

export interface TwoFaStatusPayload {
  role: AdminRole;
  totpEnabled: boolean;
  sessionValid: boolean;
  setup?: { secret: string; otpauthUri: string };
}

export function Admin2faGate({
  status,
  onUnlocked,
}: {
  status: TwoFaStatusPayload;
  onUnlocked: (sessionToken: string, reauthToken?: string) => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedSecret, setCopiedSecret] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) {
      setError("Enter a valid 6-digit authenticator code.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await adminFetch<{ ok: boolean; sessionToken: string; reauthToken?: string }>(
        "/api/admin/2fa",
        {
          method: "POST",
          body: {
            action: status.totpEnabled ? "verify_session" : "enable",
            code: code.trim(),
          },
        },
      );
      onUnlocked(res.sessionToken, res.reauthToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page" style={{ maxWidth: 540, margin: "24px auto" }}>
      <Card
        title={status.totpEnabled ? "Admin Two-Factor Verification" : "Set Up Admin Two-Factor Authentication"}
        sub={`Signed in with role: ${status.role.replace("_", " ").toUpperCase()}`}
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
                  Administrators must enable TOTP Two-Factor Authentication. Add this setup key to{" "}
                  <strong>Google Authenticator</strong>, <strong>1Password</strong>, or <strong>Authy</strong>, then
                  enter the 6-digit code below.
                </div>
              </div>

              <div
                style={{
                  padding: 10,
                  borderRadius: 8,
                  background: "var(--surface)",
                  border: "1px solid var(--line)",
                  fontFamily: "var(--mono)",
                  fontSize: 13,
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
                Authenticator URI (manual/app open):{" "}
                <a href={status.setup.otpauthUri} style={{ color: "var(--teal-deep)", wordBreak: "break-all" }}>
                  Open in Authenticator App
                </a>
              </div>
            </div>
          )}

          <Field
            label="6-digit Authenticator Code"
            hint="Session stays unlocked for 12 hours; sensitive key or user deletion actions ask to re-confirm."
          >
            <input
              className="input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              placeholder="000000"
              style={{ fontSize: 18, letterSpacing: "0.25em", textAlign: "center", fontFamily: "var(--mono)" }}
            />
          </Field>

          <button type="submit" className="btn btn-primary" disabled={busy || code.length !== 6}>
            {busy ? <Loader2 size={14} className="spin" /> : <ShieldCheck size={14} />}
            {busy ? "Verifying…" : status.totpEnabled ? "Unlock Admin Dashboard" : "Verify & Enable 2FA"}
          </button>
        </form>
      </Card>
    </main>
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
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) {
      setError("Enter your 6-digit authenticator code.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await adminFetch<{ ok: boolean }>("/api/admin/auth/reauth", {
        method: "POST",
        body: { code: code.trim() },
      });
      setCode("");
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
              Confirm your identity to proceed with: <strong>{actionLabel || "Sensitive operation"}</strong>.
            </span>
          </div>
        </Banner>
        {error && <Banner tone="bad">{error}</Banner>}
        <Field label="Enter current 6-digit 2FA code">
          <input
            className="input"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="000000"
            style={{ fontSize: 18, letterSpacing: "0.25em", textAlign: "center", fontFamily: "var(--mono)" }}
          />
        </Field>
        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || code.length !== 6}>
            {busy ? "Verifying…" : "Confirm & Continue"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
