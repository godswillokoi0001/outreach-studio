"use client";

import { useState } from "react";
import { api, errorMessage } from "@/lib/client";

export function LoginGate({ mode }: { mode: "freebuff" | "password" | "unconfigured" }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/session", { password });
      window.location.href = "/";
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-brand">
          <div className="brand-mark" style={{ background: "linear-gradient(150deg,#2f7a63,#1a3f34)" }}>
            OS
          </div>
          <div>
            <div className="brand-name" style={{ color: "var(--ink)" }}>Outreach Studio</div>
            <div className="brand-sub" style={{ color: "var(--muted)" }}>Sales intelligence</div>
          </div>
        </div>

        <h1 style={{ fontFamily: "var(--serif)", fontSize: 23, marginBottom: 4 }}>Sign in</h1>
        <p className="tiny" style={{ marginBottom: 18 }}>
          Prospect research, personalised outreach and follow-up management in one workspace.
        </p>

        {mode === "freebuff" && (
          <a className="btn btn-primary btn-block" href="/auth/freebuff/signin?returnTo=/">
            Sign in with Freebuff
          </a>
        )}

        {mode === "password" && (
          <form onSubmit={submit}>
            <div className="field">
              <span className="label">Password</span>
              <input
                className="input"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                autoFocus
                required
              />
            </div>
            {error && (
              <div className="banner" data-tone="bad" style={{ marginBottom: 12 }}>
                <div>{error}</div>
              </div>
            )}
            <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        )}

        {mode === "unconfigured" && (
          <div className="banner" data-tone="warn">
            <div>
              <strong style={{ display: "block", marginBottom: 4 }}>Sign-in is not configured yet.</strong>
              Set <span className="mono">APP_PASSWORD</span> (and <span className="mono">APP_SESSION_SECRET</span>) as a
              secret to use password sign-in, or deploy through Sites where Sign in with Freebuff is configured
              automatically.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
