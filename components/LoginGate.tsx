"use client";

import { useState } from "react";
import { CheckCircle2, FileSpreadsheet, Mail, Sparkles } from "lucide-react";

export function LoginGate({
  onGoogleAuth,
  busy,
  error,
}: {
  onGoogleAuth: () => Promise<boolean>;
  busy: boolean;
  error: string | null;
}) {
  const [mode, setMode] = useState<"signup" | "signin">("signup");

  return (
    <main className="login-wrap">
      <div className="login-card" style={{ width: "min(470px, 100%)" }}>
        <div className="login-brand">
          <div className="brand-mark">OS</div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 16 }}>Outreach Studio</div>
            <div className="tiny">AI sales intelligence &amp; Google Workspace outreach</div>
          </div>
        </div>

        <div className="tabs" role="tablist" aria-label="Authentication mode" style={{ marginBottom: 18 }}>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "signup"}
            className={`tab${mode === "signup" ? " active" : ""}`}
            onClick={() => setMode("signup")}
          >
            Sign up
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "signin"}
            className={`tab${mode === "signin" ? " active" : ""}`}
            onClick={() => setMode("signin")}
          >
            Sign in
          </button>
        </div>

        <h1 style={{ fontFamily: "var(--serif)", fontSize: 24, marginBottom: 6 }}>
          {mode === "signup" ? "Create your workspace" : "Welcome back"}
        </h1>
        <p className="tiny" style={{ marginBottom: 18, fontSize: 13 }}>
          {mode === "signup"
            ? "Sign up with your Google account to create your private Firebase workspace and connect Gmail & Google Sheets in one step."
            : "Sign in with Google to restore your campaigns, prospect research, and Gmail / Google Sheets access."}
        </p>

        {error && (
          <div className="banner" data-tone="bad" style={{ marginBottom: 16 }}>
            <div>{error}</div>
          </div>
        )}

        <button
          className="gsi-material-button"
          type="button"
          disabled={busy}
          onClick={() => void onGoogleAuth()}
        >
          <span className="gsi-material-button-state" />
          <span className="gsi-material-button-content-wrapper">
            <span className="gsi-material-button-icon" aria-hidden="true">
              <svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" style={{ display: "block", width: 20, height: 20 }}>
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
              </svg>
            </span>
            <span className="gsi-material-button-contents">
              {busy
                ? "Connecting Google…"
                : mode === "signup"
                  ? "Sign up with Google"
                  : "Sign in with Google"}
            </span>
          </span>
        </button>

        <div className="divider" style={{ margin: "18px 0 14px" }} />

        <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0, gap: 9, fontSize: 12.6, color: "var(--ink-2)" }}>
          <li className="row" style={{ gap: 8, flexWrap: "nowrap", alignItems: "flex-start" }}>
            <FileSpreadsheet size={15} style={{ flexShrink: 0, marginTop: 2, color: "var(--accent)" }} />
            <span>Import prospect lists directly from Google Sheets and write campaign statuses back.</span>
          </li>
          <li className="row" style={{ gap: 8, flexWrap: "nowrap", alignItems: "flex-start" }}>
            <Mail size={15} style={{ flexShrink: 0, marginTop: 2, color: "var(--accent)" }} />
            <span>Send approved outreach and sync replies directly through your Gmail inbox.</span>
          </li>
          <li className="row" style={{ gap: 8, flexWrap: "nowrap", alignItems: "flex-start" }}>
            <Sparkles size={15} style={{ flexShrink: 0, marginTop: 2, color: "var(--accent)" }} />
            <span>AI research, qualification, email drafting, and reply classification ready immediately.</span>
          </li>
          <li className="row" style={{ gap: 8, flexWrap: "nowrap", alignItems: "flex-start" }}>
            <CheckCircle2 size={15} style={{ flexShrink: 0, marginTop: 2, color: "var(--accent)" }} />
            <span>Every account is isolated in Cloud Firestore; nothing sends without your approval.</span>
          </li>
        </ul>
      </div>
    </main>
  );
}
