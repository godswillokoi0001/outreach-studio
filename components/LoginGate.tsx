"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
  CheckCircle2,
  FileSpreadsheet,
  Mail,
  Search,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";

const PILLARS = [
  {
    icon: Users,
    title: "Every prospect, researched",
    body: "The app reads the company's website, records verified facts with sources, then scores the fit against what you actually sell.",
  },
  {
    icon: Sparkles,
    title: "Emails written from your knowledge",
    body: "Your master knowledge and sources are the only ground truth. No generic templates, no invented claims.",
  },
  {
    icon: Mail,
    title: "Sent from your own Gmail",
    body: "Nothing leaves without your approval. Replies and bounces are read back and classified automatically.",
  },
  {
    icon: FileSpreadsheet,
    title: "Google Sheets in and out",
    body: "Import a prospect list in one click and write campaign statuses back to the same sheet.",
  },
];

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
  const domainIssue =
    error && /unauthori[sz]ed domain|not authorised in Firebase|auth\/unauthorized-domain/i.test(error);

  return (
    <main className="login-wrap">
      <motion.div
        className="login-shell"
        initial={{ opacity: 0, y: 24, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 28 }}
      >
        <aside className="login-aside">
          <div className="login-brand" style={{ marginBottom: 0 }}>
            <div className="brand-mark">OS</div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 15.5, color: "#fff" }}>Outreach Studio</div>
              <div className="tiny" style={{ color: "rgba(234,243,238,0.65)" }}>
                Sales intelligence workspace
              </div>
            </div>
          </div>

          <div>
            <div className="hero-eyebrow" style={{ color: "rgba(234,243,238,0.55)" }}>
              Research → qualify → write → send
            </div>
            <h2>
              Stop guessing who to email,
              <br />
              and what to say.
            </h2>
            <p style={{ marginTop: 10 }}>
              One private workspace that turns a list of businesses into researched, personalised, approved outreach
              sent from your own inbox.
            </p>
          </div>

          <ul className="login-points">
            {PILLARS.map((pillar) => {
              const Icon = pillar.icon;
              return (
                <li key={pillar.title}>
                  <span className="login-point-icon">
                    <Icon size={14} strokeWidth={1.9} aria-hidden="true" />
                  </span>
                  <span>
                    <strong style={{ color: "#fff", fontWeight: 600 }}>{pillar.title}</strong>
                    <br />
                    <span style={{ color: "rgba(234,243,238,0.72)", fontSize: 12.6 }}>{pillar.body}</span>
                  </span>
                </li>
              );
            })}
          </ul>

          <div className="login-proof">
            <span>Firebase-secured</span>
            <span>Per-account isolation</span>
            <span>Approval before sending</span>
            <span>Unsubscribe-safe</span>
          </div>
        </aside>

        <section className="login-panel">
          <div className="tabs" role="tablist" aria-label="Authentication mode" style={{ marginBottom: 18 }}>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "signup"}
              className={`tab${mode === "signup" ? " active" : ""}`}
              onClick={() => setMode("signup")}
            >
              Create account
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

          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={mode}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
            >
              <h1>{mode === "signup" ? "Create your workspace" : "Welcome back"}</h1>
              <p className="tiny" style={{ marginBottom: 18, fontSize: 13 }}>
                {mode === "signup"
                  ? "One Google account creates your private workspace and connects Gmail and Google Sheets at the same time."
                  : "Sign in with the Google account you use for outreach. Your campaigns, research and replies come back exactly as you left them."}
              </p>
            </motion.div>
          </AnimatePresence>

          {error && (
            <div className="banner" data-tone="bad" style={{ marginBottom: 14 }}>
              <div>
                {error}
                {domainIssue && (
                  <>
                    <ol className="setup-steps">
                      <li>
                        Open{" "}
                        <a
                          href="https://console.firebase.google.com/project/gen-lang-client-0846151955/authentication/settings"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Firebase Console → Authentication → Settings
                        </a>
                        .
                      </li>
                      <li>
                        Under <strong>Authorized domains</strong>, press <strong>Add domain</strong> and add{" "}
                        <code>{typeof window !== "undefined" ? window.location.hostname : "localhost"}</code> (and{" "}
                        <code>localhost</code> if they differ). Save.
                      </li>
                      <li>Reload this page completely, then press Continue with Google again.</li>
                    </ol>
                    <span className="tiny" style={{ display: "block", marginTop: 8 }}>
                      This is a one-time step per Firebase project. It does not affect your data.
                    </span>
                  </>
                )}
              </div>
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
                <svg
                  version="1.1"
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 48 48"
                  style={{ display: "block", width: 20, height: 20 }}
                >
                  <path
                    fill="#EA4335"
                    d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                  />
                  <path
                    fill="#4285F4"
                    d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                  />
                  <path
                    fill="#34A853"
                    d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                  />
                </svg>
              </span>
              <span className="gsi-material-button-contents">
                {busy
                  ? "Connecting Google…"
                  : mode === "signup"
                    ? "Continue with Google"
                    : "Sign in with Google"}
              </span>
              {!busy && <ArrowRight size={15} style={{ marginLeft: 2 }} aria-hidden="true" />}
            </span>
          </button>

          <p className="tiny" style={{ marginTop: 12, lineHeight: 1.6 }}>
            You will be asked for Sheets and Gmail permissions. Access can be revoked at any time from your Google
            account, and nothing is ever sent without your explicit approval.
          </p>

          <div className="divider" style={{ margin: "18px 0 14px" }} />

          <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0, gap: 9, fontSize: 12.6 }}>
            <li className="row" style={{ gap: 8, flexWrap: "nowrap", alignItems: "flex-start" }}>
              <ShieldCheck size={15} style={{ flexShrink: 0, marginTop: 2, color: "var(--accent)" }} />
              <span>Each account is isolated in Cloud Firestore with row-level rules.</span>
            </li>
            <li className="row" style={{ gap: 8, flexWrap: "nowrap", alignItems: "flex-start" }}>
              <CheckCircle2 size={15} style={{ flexShrink: 0, marginTop: 2, color: "var(--accent)" }} />
              <span>New workspaces start completely empty — no sample data pretending to be yours.</span>
            </li>
            <li className="row" style={{ gap: 8, flexWrap: "nowrap", alignItems: "flex-start" }}>
              <Search size={15} style={{ flexShrink: 0, marginTop: 2, color: "var(--accent)" }} />
              <span>AI research and writing run on Gemini through a server route; your key stays server-side.</span>
            </li>
          </ul>
        </section>
      </motion.div>
    </main>
  );
}
