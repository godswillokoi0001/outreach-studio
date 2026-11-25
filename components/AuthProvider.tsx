"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import {
  fetchCurrentUser,
  signInWithGoogle,
  signOut as signOutSupabase,
  subscribeAuthState,
  supabaseBrowser,
  type AppUser,
} from "@/lib/auth";
import {
  ensureWorkspaceToken,
  readWorkspaceToken,
  startGoogleConnection,
  workspaceStatus,
} from "@/lib/workspace";
import { clearWorkspaceToken, writeWorkspaceToken } from "@/lib/workspace-token";
import { PreAuth } from "./PreAuth";
import { Shell } from "./Shell";

export interface WorkspaceIssue {
  /** "verification" means Google itself blocked the Gmail/Sheets consent screen. */
  kind: "verification" | "other";
  message: string;
}

interface AuthContextValue {
  user: AppUser;
  workspaceToken: string | null;
  workspaceEmail: string | null;
  /** True when the server has a stored refresh token, so Gmail/Sheets survive reloads. */
  workspacePersistent: boolean;
  /** Set when connecting Google failed, so the UI can explain how to fix it. */
  workspaceIssue: WorkspaceIssue | null;
  clearWorkspaceIssue: () => void;
  reconnectWorkspace: () => Promise<boolean>;
  refreshWorkspace: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider.");
  return ctx;
}

function friendlyAuthError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/redirect_uri_mismatch|invalid redirect|redirect.*not allowed/i.test(raw)) {
    return "Google sign-in returned to an address Supabase has not authorised. In Supabase → Authentication → URL Configuration, set the Site URL to this app's URL and add it to the redirect allow list, then try again.";
  }
  if (/provider is not enabled|unsupported provider/i.test(raw)) {
    return "Google sign-in is disabled for this Supabase project. Enable the Google provider in Supabase → Authentication → Providers.";
  }
  if (/invalid or expired session|jwt|unauthorized/i.test(raw)) {
    return "Your session expired. Sign in with Google again.";
  }
  if (/missing supabase|not configured/i.test(raw)) {
    return "Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to the environment.";
  }
  if (/has not completed the Google verification|Access blocked|access_denied/i.test(raw)) {
    return "Google blocked this request because the app is not verified. Sign-in works without it; Gmail and Sheets need your Google account added as a test user in Google Cloud Console → OAuth consent screen → Test users, until the app is verified.";
  }
  return raw;
}

/** Separates Google's verification block from ordinary failures. */
function classifyWorkspaceError(err: unknown): WorkspaceIssue {
  const raw = err instanceof Error ? err.message : String(err);
  const kind = /has not completed the Google verification|Access blocked|access_denied|verification process|unverified/i.test(
    raw,
  )
    ? "verification"
    : "other";
  return { kind, message: friendlyAuthError(err) };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isPublicLegalPage = pathname === "/privacy-policy" || pathname === "/terms";
  const [user, setUser] = useState<AppUser | null>(null);
  const [workspaceToken, setWorkspaceToken] = useState<string | null>(null);
  const [workspaceEmail, setWorkspaceEmail] = useState<string | null>(null);
  const [workspacePersistent, setWorkspacePersistent] = useState(false);
  const [workspaceIssue, setWorkspaceIssue] = useState<WorkspaceIssue | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const hydrateWorkspace = useCallback(async () => {
    const [ready, status] = await Promise.all([ensureWorkspaceToken(), workspaceStatus()]);
    setWorkspaceToken(ready ? readWorkspaceToken() : null);
    setWorkspaceEmail(status.email);
    setWorkspacePersistent(Boolean(status.configured && status.connected));
    if (ready) setWorkspaceIssue(null);
    return ready;
  }, []);

  useEffect(() => {
    let active = true;

    const applySession = async (session: Session | null) => {
      if (!active) return;

      if (!session?.access_token) {
        clearWorkspaceToken();
        setUser(null);
        setWorkspaceToken(null);
        setWorkspaceEmail(null);
        setWorkspacePersistent(false);
        setLoading(false);
        return;
      }

      try {
        const current = await fetchCurrentUser();
        if (!active) return;
        if (!current) {
          setUser(null);
          setLoading(false);
          return;
        }
        // A fresh Google consent can hand back a Workspace token; keep it in memory only.
        if (session.provider_token) writeWorkspaceToken(session.provider_token, 3600);
        await hydrateWorkspace();
        if (!active) return;
        setUser(current);
        setAuthError(null);
      } catch (err) {
        if (!active) return;
        setAuthError(friendlyAuthError(err));
        setUser(null);
      } finally {
        if (active) setLoading(false);
      }
    };

    void (async () => {
      const { data } = await supabaseBrowser.auth.getSession();
      await applySession(data.session);
    })();

    const unsubscribe = subscribeAuthState((session) => {
      void applySession(session);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [hydrateWorkspace]);

  const handleGoogleAuth = useCallback(async (): Promise<boolean> => {
    setSigningIn(true);
    setAuthError(null);
    try {
      // Redirects the browser to Google; the /auth/callback route completes it.
      await signInWithGoogle();
      return true;
    } catch (err) {
      setAuthError(friendlyAuthError(err));
      setSigningIn(false);
      return false;
    }
  }, []);

  const reconnectWorkspace = useCallback(async (): Promise<boolean> => {
    setWorkspaceIssue(null);
    const ready = await hydrateWorkspace();
    if (ready) return true;

    // The server-side client stores a refresh token, so the connection survives
    // reloads; there is no session-only popup fallback any more.
    let redirecting: boolean;
    try {
      redirecting = await startGoogleConnection();
    } catch (err) {
      setWorkspaceIssue(classifyWorkspaceError(err));
      return false;
    }
    if (redirecting) return false; // the browser is navigating to Google

    setWorkspaceIssue({
      kind: "other",
      message:
        "Persistent Google connection is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the server environment, then try again.",
    });
    return false;
  }, [hydrateWorkspace]);

  const signOut = async () => {
    await signOutSupabase();
    clearWorkspaceToken();
    setUser(null);
    setWorkspaceToken(null);
    setWorkspaceEmail(null);
    setWorkspaceIssue(null);
  };

  if (isPublicLegalPage) return <>{children}</>;

  if (loading) {
    return (
      <div className="auth-shell">
        <div className="auth-aurora" aria-hidden="true" />
        <div className="auth-loading">
          <div className="login-brand" style={{ justifyContent: "center" }}>
            <div className="brand-mark">
              <img src="/brand/knowrevo-icon-t.png" alt="" aria-hidden="true" />
            </div>
            <div style={{ textAlign: "left" }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>Knowrevo</div>
              <div className="tiny">Checking your workspace session…</div>
            </div>
          </div>
          <div className="progress" style={{ justifyContent: "center", marginTop: 14 }}>
            <span className="spinner" />
            <span>Loading workspace…</span>
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    return <PreAuth onGoogleAuth={handleGoogleAuth} busy={signingIn} error={authError} />;
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        workspaceToken,
        workspaceEmail,
        workspacePersistent,
        workspaceIssue,
        clearWorkspaceIssue: () => setWorkspaceIssue(null),
        reconnectWorkspace,
        refreshWorkspace: async () => {
          await hydrateWorkspace();
        },
        signOut,
      }}
    >
      <Shell>{children}</Shell>
    </AuthContext.Provider>
  );
}
