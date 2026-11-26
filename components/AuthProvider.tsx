"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import {
  fetchCurrentUser,
  getSupabaseBrowser,
  signInWithGoogle,
  supabaseConfigured,
  signOut as signOutSupabase,
  subscribeAuthState,
  type AppUser,
} from "@/lib/auth";
import {
  ensureWorkspaceToken,
  readWorkspaceToken,
  startGoogleConnection,
  workspaceStatus,
} from "@/lib/workspace";
import { clearWorkspaceToken, writeWorkspaceToken } from "@/lib/workspace-token";
import { invalidateDataCache } from "@/lib/db-client";
import { BrandLoader } from "./BrandLoader";
import { BrandLockup } from "./BrandMark";
import { PreAuth } from "./PreAuth";
import { Shell } from "./Shell";

export interface WorkspaceIssue {
  /** "verification" means Google itself blocked the Gmail/Sheets consent screen. */
  kind: "verification" | "other";
  message: string;
}

interface AuthContextValue {
  user: AppUser;
  /** False until the first Google-connection check finishes after a load. */
  workspaceReady: boolean;
  workspaceToken: string | null;
  workspaceEmail: string | null;
  /** True when the server has a stored refresh token, so Gmail/Sheets survive reloads. */
  workspacePersistent: boolean;
  /** Set when connecting Google failed, so the UI can explain how to fix it. */
  workspaceIssue: WorkspaceIssue | null;
  clearWorkspaceIssue: () => void;
  reconnectWorkspace: () => Promise<boolean>;
  /** Clears the stored Google access immediately, without a page reload. */
  disconnectWorkspace: () => Promise<void>;
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
  if (/exchange external code|invalid_grant|code verifier|code challenge/i.test(raw)) {
    return "That Google sign-in link had already been used or had expired, so it could not be completed. Click Continue with Google to start again.";
  }
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

/**
 * Reads a failed sign-in from the address bar and removes it, so a refresh
 * cannot replay an authorization code that has already been spent.
 */
function consumeAuthErrorFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const flagged = url.searchParams.get("auth") === "error";
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  const hashError = hash.get("error_description") ?? hash.get("error");
  if (!flagged && !hashError) return null;

  const reason = url.searchParams.get("reason") ?? hashError ?? "";
  url.searchParams.delete("auth");
  url.searchParams.delete("reason");
  url.hash = "";
  window.history.replaceState({}, "", `${url.pathname}${url.search}`);
  return friendlyAuthError(new Error(reason || "Google sign-in did not complete."));
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
  const [workspaceReady, setWorkspaceReady] = useState(false);
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
        setWorkspaceReady(false);
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
        setUser(current);
        setAuthError(null);
        // Paint the workspace now and check the Google connection afterwards:
        // waiting for the token exchange used to hold every screen hostage on reload.
        setLoading(false);
        void hydrateWorkspace().finally(() => {
          if (active) setWorkspaceReady(true);
        });
      } catch (err) {
        if (!active) return;
        setAuthError(friendlyAuthError(err));
        setUser(null);
      } finally {
        if (active) setLoading(false);
      }
    };

    const client = getSupabaseBrowser();
    void (async () => {
      if (!client) {
        consumeAuthErrorFromUrl();
        setLoading(false);
        return;
      }

      // A failed callback leaves ?auth=error&reason=… in the address bar. Show
      // the reason once, then clean the URL so a refresh cannot replay a code
      // that was already spent.
      const notice = consumeAuthErrorFromUrl();
      const { data } = await client.auth.getSession();
      if (notice && !data.session) setAuthError(notice);
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

  const disconnectWorkspace = useCallback(async (): Promise<void> => {
    // Clear local state first so every connected badge flips immediately.
    clearWorkspaceToken();
    setWorkspaceToken(null);
    setWorkspaceEmail(null);
    setWorkspacePersistent(false);
    setWorkspaceIssue(null);
    try {
      const { disconnectWorkspace: clearOnServer } = await import("@/lib/workspace");
      await clearOnServer();
    } catch {
      // The browser copy is already gone; the server copy is best-effort.
    }
  }, []);

  const signOut = async () => {
    await signOutSupabase();
    clearWorkspaceToken();
    // Nothing from this account may survive into the next sign-in.
    invalidateDataCache();
    setUser(null);
    setWorkspaceToken(null);
    setWorkspaceEmail(null);
    setWorkspaceIssue(null);
  };

  if (isPublicLegalPage) return <>{children}</>;

  if (loading) {
    return (
      <div className="auth-shell">
        <div className="auth-loading">
          <BrandLockup subtitle="Checking your workspace session…" />
          <div className="progress" style={{ justifyContent: "center", marginTop: 14 }}>
            <BrandLoader variant="thinking" size={20} />
            <span>Loading workspace…</span>
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    const configurationError = supabaseConfigured
      ? null
      : "Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to the environment.";
    return (
      <PreAuth
        onGoogleAuth={handleGoogleAuth}
        busy={signingIn}
        error={authError ?? configurationError}
      />
    );
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        workspaceReady,
        workspaceToken,
        workspaceEmail,
        workspacePersistent,
        workspaceIssue,
        clearWorkspaceIssue: () => setWorkspaceIssue(null),
        reconnectWorkspace,
        disconnectWorkspace,
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
