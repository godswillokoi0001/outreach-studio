"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { User } from "firebase/auth";
import { logout, signInWithGoogle, subscribeAuthState, testFirestoreConnection } from "@/lib/firebase";
import { ensureUserWorkspace } from "@/lib/firestore-store";
import {
  ensureWorkspaceToken,
  readWorkspaceToken,
  startGoogleConnection,
  workspaceStatus,
} from "@/lib/workspace";
import { PreAuth } from "./PreAuth";
import { Shell } from "./Shell";

interface AuthContextValue {
  user: User;
  workspaceToken: string | null;
  workspaceEmail: string | null;
  /** True when the server has a stored refresh token, so Gmail/Sheets survive reloads. */
  workspacePersistent: boolean;
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
  if (raw.includes("auth/unauthorized-domain")) {
    return "This domain is not authorised in Firebase yet. In Firebase Console → Authentication → Settings → Authorized domains, add localhost (and 127.0.0.1), then try again.";
  }
  if (raw.includes("auth/popup-closed-by-user") || raw.includes("auth/cancelled-popup-request")) {
    return "Google sign-in was cancelled. Try again when you are ready.";
  }
  if (raw.includes("auth/popup-blocked")) {
    return "Your browser blocked the sign-in popup. Allow popups for localhost and try again.";
  }
  if (raw.includes("auth/operation-not-allowed")) {
    return "Google sign-in is disabled for this Firebase project. Enable the Google provider in Firebase Console → Authentication → Sign-in method.";
  }
  if (raw.includes("auth/invalid-api-key") || raw.includes("auth/configuration-not-found")) {
    return "The Firebase project configuration is not valid. Check firebase-applet-config.json and that the project still exists.";
  }
  if (raw.includes("permission-denied") || raw.includes("Missing or insufficient permissions")) {
    return "Firestore denied the request. Deploy firestore.rules to the Firebase project (or check that your account's email is verified).";
  }
  return raw;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [workspaceToken, setWorkspaceToken] = useState<string | null>(null);
  const [workspaceEmail, setWorkspaceEmail] = useState<string | null>(null);
  const [workspacePersistent, setWorkspacePersistent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const hydrateWorkspace = useCallback(async () => {
    const [ready, status] = await Promise.all([ensureWorkspaceToken(), workspaceStatus()]);
    setWorkspaceToken(ready ? readWorkspaceToken() : null);
    setWorkspaceEmail(status.email);
    setWorkspacePersistent(Boolean(status.configured && status.connected));
    return ready;
  }, []);

  useEffect(() => {
    void testFirestoreConnection();
    const unsubscribe = subscribeAuthState(async (nextUser) => {
      if (!nextUser) {
        setUser(null);
        setWorkspaceToken(null);
        setWorkspaceEmail(null);
        setLoading(false);
        return;
      }
      if (!nextUser.email || !nextUser.emailVerified) {
        setAuthError("A verified Google account is required. Verify your email, then sign in again.");
        await logout();
        setUser(null);
        setLoading(false);
        return;
      }
      try {
        await ensureUserWorkspace(nextUser);
        await hydrateWorkspace();
        setUser(nextUser);
        setAuthError(null);
      } catch (err) {
        setAuthError(friendlyAuthError(err));
      } finally {
        setLoading(false);
      }
    });
    return () => unsubscribe();
  }, [hydrateWorkspace]);

  const handleGoogleAuth = useCallback(async (): Promise<boolean> => {
    setSigningIn(true);
    setAuthError(null);
    try {
      const { user: signedInUser, accessToken } = await signInWithGoogle();
      await ensureUserWorkspace(signedInUser);
      setWorkspaceToken(accessToken);
      setUser(signedInUser);
      void hydrateWorkspace();
      return true;
    } catch (err) {
      setAuthError(friendlyAuthError(err));
      return false;
    } finally {
      setSigningIn(false);
    }
  }, [hydrateWorkspace]);

  const reconnectWorkspace = useCallback(async (): Promise<boolean> => {
    setAuthError(null);
    const status = await workspaceStatus();
    // With a persistent OAuth client configured, send the browser through
    // Google's consent screen so the connection survives reloads.
    if (status.configured) {
      await startGoogleConnection();
      return false;
    }
    const ready = await hydrateWorkspace();
    if (ready) return true;
    // No server OAuth client yet: fall back to the Firebase popup token.
    return handleGoogleAuth();
  }, [handleGoogleAuth, hydrateWorkspace]);

  const signOut = async () => {
    await logout();
    setUser(null);
    setWorkspaceToken(null);
    setWorkspaceEmail(null);
  };

  if (loading) {
    return (
      <div className="auth-shell">
        <div className="auth-aurora" aria-hidden="true" />
        <div className="auth-loading">
          <div className="login-brand" style={{ justifyContent: "center" }}>
            <div className="brand-mark">OS</div>
            <div style={{ textAlign: "left" }}>
              <div style={{ fontWeight: 600, fontSize: 16 }}>Outreach Studio</div>
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
