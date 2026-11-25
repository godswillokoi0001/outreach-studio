"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  FileSpreadsheet,
  Lock,
  MailCheck,
  MousePointerClick,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

const PROOF_POINTS = [
  {
    icon: Search,
    title: "Researched prospects",
    body: "Every business read, every claim sourced before it is used.",
  },
  {
    icon: BookOpen,
    title: "Written from your knowledge",
    body: "Your offers, prices, proof and tone. Nothing invented.",
  },
  {
    icon: MailCheck,
    title: "Gmail-native sending",
    body: "Real email from your address, approved by you, one at a time.",
  },
  {
    icon: MousePointerClick,
    title: "Opens and replies",
    body: "See who read it and who answered, the moment it happens.",
  },
];

const TRUST = [
  { icon: ShieldCheck, text: "Each account is isolated with Firestore row-level rules." },
  { icon: Lock, text: "Google tokens stay in memory, never in browser storage." },
  { icon: CheckCircle2, text: "Nothing sends until you approve it." },
];

export function LoginGate({
  onGoogleAuth,
  busy,
  error,
  initialMode = "signup",
  onBack,
}: {
  onGoogleAuth: () => Promise<boolean>;
  busy: boolean;
  error: string | null;
  initialMode?: "signup" | "signin";
  onBack?: () => void;
}) {
  const [mode, setMode] = useState<"signup" | "signin">(initialMode);
  const domainIssue =
    error && /unauthori[sz]ed domain|not authorised in Firebase|auth\/unauthorized-domain/i.test(error);
  const isSignup = mode === "signup";

  return (
    <main className="auth-shell">
      <div className="auth-aurora" aria-hidden="true" />

      <div className="auth-top">
        <div className="landing-brand">
          <img src="/brand/knowrevo-logo-t.png" alt="Knowrevo" className="landing-logo" />
        </div>
        {onBack && (
          <button type="button" className="btn btn-ghost auth-back" onClick={onBack}>
            <ArrowLeft size={14} />
            Back to site
          </button>
        )}
      </div>

      <motion.div
        className="auth-card"
        initial={{ opacity: 0, y: 22, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 240, damping: 26 }}
      >
        <aside className="auth-aside">
          <div className="auth-aside-glow" aria-hidden="true" />
          <div className="auth-aside-top">
            <span className="auth-eyebrow">Knowledge-powered outreach</span>
            <h2>
              Your knowledge.
              <br />
              Your next customer.
            </h2>
            <p>
              Research, personalised writing, approved sending and live open + reply signals — in one private
              workspace.
            </p>
          </div>

          <ul className="auth-proof">
            {PROOF_POINTS.map(({ icon: Icon, title, body }) => (
              <li key={title}>
                <span className="auth-proof-icon">
                  <Icon size={15} strokeWidth={1.9} />
                </span>
                <span>
                  <strong>{title}</strong>
                  <span>{body}</span>
                </span>
              </li>
            ))}
          </ul>

          <div className="auth-aside-foot">
            <span className="auth-live-dot" />
            <span>Opens &amp; replies surface in your dashboard in real time</span>
          </div>
        </aside>

        <section className="auth-panel">
          <div className="auth-mode" role="tablist" aria-label="Authentication mode">
            <span className="auth-mode-thumb" data-mode={mode} aria-hidden="true" />
            <button
              type="button"
              role="tab"
              aria-selected={isSignup}
              className={isSignup ? "active" : ""}
              onClick={() => setMode("signup")}
            >
              Create account
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={!isSignup}
              className={!isSignup ? "active" : ""}
              onClick={() => setMode("signin")}
            >
              Sign in
            </button>
          </div>

          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={mode}
              className="auth-heading"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
            >
              <span className="auth-heading-icon">
                <Sparkles size={16} />
              </span>
              <h1>{isSignup ? "Start your workspace" : "Welcome back"}</h1>
              <p>
                {isSignup
                  ? "One Google account creates a private workspace. Gmail and Google Sheets connect in a single extra click, whenever you are ready."
                  : "Sign in with the Google account you use for outreach. Everything returns exactly as you left it."}
              </p>
            </motion.div>
          </AnimatePresence>

          {error && (
            <div className="banner auth-error" data-tone="bad">
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
            className="gsi-material-button auth-google"
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
                  : isSignup
                    ? "Continue with Google"
                    : "Sign in with Google"}
              </span>
              {!busy && <ArrowRight size={15} style={{ marginLeft: 2 }} aria-hidden="true" />}
            </span>
          </button>

          <p className="auth-fineprint">
            Sign-in only reads your name, email and photo. Gmail and Sheets access is asked for separately and can be
            revoked any time from your Google account.
          </p>

          <ul className="auth-trust">
            {TRUST.map(({ icon: Icon, text }) => (
              <li key={text}>
                <Icon size={14} />
                <span>{text}</span>
              </li>
            ))}
          </ul>

          <div className="auth-switch">
            {isSignup ? "Already have a workspace?" : "New to Knowrevo?"}{" "}
            <button type="button" onClick={() => setMode(isSignup ? "signin" : "signup")}>
              {isSignup ? "Sign in" : "Create an account"}
            </button>
          </div>

          <div className="auth-panel-foot">
            <FileSpreadsheet size={13} />
            <span>Gmail + Google Sheets connect on demand from Integrations.</span>
          </div>
        </section>
      </motion.div>
    </main>
  );
}
