"use client";

import { useState } from "react";
import { ArrowLeft, Check, Copy, KeyRound, Lock, ShieldCheck } from "lucide-react";
import { BrandLoader } from "@/components/BrandLoader";
import { BrandLockup } from "@/components/BrandMark";
import { Banner, Card, Field } from "@/components/ui";
import type { AdminRole } from "@/lib/platform/types";

export interface AuthenticatedAdminSummary {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  reauthActive?: boolean;
}

export function AdminLoginScreen({
  initialChallenge,
  onSignedIn,
}: {
  initialChallenge?: {
    pending: boolean;
    totpEnabled?: boolean;
    setup?: { secret: string; otpauthUri: string };
  };
  onSignedIn: (admin: AuthenticatedAdminSummary) => void;
}) {
  const [step, setStep] = useState<"credentials" | "totp">(
    initialChallenge?.pending ? "totp" : "credentials",
  );
  const [setupInfo, setSetupInfo] = useState<{ secret: string; otpauthUri: string } | null>(
    initialChallenge?.setup ?? null,
  );

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedSecret, setCopiedSecret] = useState(false);

  const submitCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError("Invalid credentials.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ step: "password", email: email.trim(), password }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        step?: "verify_totp" | "setup_totp";
        setup?: { secret: string; otpauthUri: string };
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setError(data.error || "Invalid credentials.");
        return;
      }
      setPassword("");
      setSetupInfo(data.step === "setup_totp" && data.setup ? data.setup : null);
      setStep("totp");
    } catch {
      setError("Unable to verify credentials right now.");
    } finally {
      setBusy(false);
    }
  };

  const submitTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = totpCode.replace(/\s+/g, "").trim();
    if (!/^\d{6}$/.test(clean)) {
      setError("Enter a valid 6-digit verification code.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ step: "totp", code: clean }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        admin?: AuthenticatedAdminSummary;
        error?: string;
      };
      if (!res.ok || !data.ok || !data.admin) {
        setError(data.error || "Invalid verification code.");
        return;
      }
      setTotpCode("");
      onSignedIn({ ...data.admin, reauthActive: true });
    } catch {
      setError("Unable to verify 2FA right now.");
    } finally {
      setBusy(false);
    }
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
      <div style={{ width: "100%", maxWidth: 440 }} className="stack">
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 4 }}>
          <BrandLockup subtitle="Restricted Operations Console" />
        </div>

        <Card
          title={
            step === "credentials"
              ? "Administrator Sign In"
              : setupInfo
                ? "Set Up Two-Factor Authentication"
                : "Two-Factor Verification"
          }
          sub={
            step === "credentials"
              ? "Sign in with your dedicated administrator email and password."
              : setupInfo
                ? "Scan or copy this setup key into your authenticator app before continuing."
                : "Enter the 6-digit code from your authenticator app to open your session."
          }
        >
          {error && (
            <div style={{ marginBottom: 14 }}>
              <Banner tone="bad">{error}</Banner>
            </div>
          )}

          {step === "credentials" ? (
            <form onSubmit={submitCredentials} className="stack" style={{ gap: 14 }}>
              <Field label="Administrator Email">
                <input
                  className="input"
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@company.com"
                />
              </Field>

              <Field label="Password">
                <input
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                />
              </Field>

              <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
                {busy ? <BrandLoader size={16} /> : <Lock size={14} />}
                {busy ? "Verifying…" : "Continue"}
              </button>
            </form>
          ) : (
            <form onSubmit={submitTotp} className="stack" style={{ gap: 14 }}>
              {setupInfo && (
                <div
                  style={{
                    padding: 12,
                    borderRadius: 10,
                    border: "1px solid var(--line)",
                    background: "var(--surface-2)",
                  }}
                  className="stack"
                >
                  <div className="tiny">
                    Add this secret key to Google Authenticator, 1Password, or Authy:
                  </div>
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
                    <span>{setupInfo.secret}</span>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        void navigator.clipboard?.writeText(setupInfo.secret);
                        setCopiedSecret(true);
                        window.setTimeout(() => setCopiedSecret(false), 2000);
                      }}
                    >
                      {copiedSecret ? <Check size={12} /> : <Copy size={12} />}
                      {copiedSecret ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <a
                    href={setupInfo.otpauthUri}
                    className="tiny"
                    style={{ color: "var(--accent)", wordBreak: "break-all" }}
                  >
                    Open in Authenticator App
                  </a>
                </div>
              )}

              <Field label="6-Digit Authenticator Code" hint="Admin sessions expire automatically after 30 minutes of inactivity.">
                <input
                  className="input"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  autoFocus
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="000000"
                  style={{ fontSize: 20, letterSpacing: "0.28em", textAlign: "center", fontFamily: "var(--mono)" }}
                />
              </Field>

              <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setStep("credentials");
                    setTotpCode("");
                    setError(null);
                  }}
                >
                  <ArrowLeft size={13} /> Back
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={busy || totpCode.length !== 6}
                >
                  {busy ? <KeyRound size={14} /> : <ShieldCheck size={14} />}
                  {busy ? "Signing in…" : "Verify & Enter Console"}
                </button>
              </div>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
