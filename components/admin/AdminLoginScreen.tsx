"use client";

import { useState } from "react";
import { Lock } from "lucide-react";
import { BrandLoader } from "@/components/BrandLoader";
import { BrandLockup } from "@/components/BrandMark";
import { Banner, Card, Field } from "@/components/ui";
import type { AdminRole } from "@/lib/platform/types";
import { Admin2faGate, type TwoFaStatusPayload } from "./Admin2faGate";

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
    role?: AdminRole;
    email?: string;
    setup?: { secret: string; otpauthUri: string; qrDataUrl?: string };
  };
  onSignedIn: (admin: AuthenticatedAdminSummary) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [twoFaChallenge, setTwoFaChallenge] = useState<TwoFaStatusPayload | null>(() =>
    initialChallenge?.pending
      ? {
          role: initialChallenge.role ?? "admin",
          email: initialChallenge.email,
          totpEnabled: Boolean(initialChallenge.totpEnabled),
          setup: initialChallenge.setup,
        }
      : null,
  );

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
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        requires2fa?: boolean;
        totpEnabled?: boolean;
        role?: AdminRole;
        email?: string;
        setup?: { secret: string; otpauthUri: string; qrDataUrl?: string };
        admin?: AuthenticatedAdminSummary;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setError(data.error || "Invalid credentials.");
        return;
      }

      setPassword("");
      if (data.requires2fa) {
        setTwoFaChallenge({
          role: data.role ?? "admin",
          email: data.email ?? email.trim(),
          totpEnabled: Boolean(data.totpEnabled),
          setup: data.setup,
        });
        return;
      }

      if (data.admin) {
        onSignedIn({ ...data.admin, reauthActive: true });
      }
    } catch {
      setError("Unable to verify credentials right now.");
    } finally {
      setBusy(false);
    }
  };

  if (twoFaChallenge) {
    return (
      <Admin2faGate
        status={twoFaChallenge}
        onUnlocked={onSignedIn}
        onResetToPassword={() => {
          void fetch("/api/admin/auth/logout", {
            method: "POST",
            credentials: "same-origin",
          }).catch(() => {});
          setTwoFaChallenge(null);
        }}
      />
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
      <div style={{ width: "100%", maxWidth: 440 }} className="stack">
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 4 }}>
          <BrandLockup subtitle="Restricted Operations Console" />
        </div>

        <Card
          title="Administrator Sign In"
          sub="Sign in with your dedicated administrator email and password, then verify 2FA."
        >
          {error && (
            <div style={{ marginBottom: 14 }}>
              <Banner tone="bad">{error}</Banner>
            </div>
          )}

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
              {busy ? "Verifying…" : "Continue to 2FA Verification"}
            </button>
          </form>
        </Card>
      </div>
    </div>
  );
}
