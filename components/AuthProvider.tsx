"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { User } from "firebase/auth";
import {
  logout,
  signInWithGoogle,
  subscribeAuthState,
  testFirestoreConnection,
} from "@/lib/firebase";
import { ensureUserWorkspace } from "@/lib/firestore-store";
import { LoginGate } from "./LoginGate";
import { Shell } from "./Shell";

interface AuthContextValue {
  user: User;
  workspaceToken: string | null;
  reconnectWorkspace: () => Promise<boolean>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider.");
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [workspaceToken, setWorkspaceToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    void testFirestoreConnection();
    const unsub = subscribeAuthState(async (nextUser, token) => {
      if (!nextUser) {
        setUser(null);
        setWorkspaceToken(null);
        setLoading(false);
        return;
      }
      if (!nextUser.email || !nextUser.emailVerified) {
        setAuthError("A verified Google account is required.");
        await logout();
        setUser(null);
        setWorkspaceToken(null);
        setLoading(false);
        return;
      }
      try {
        await ensureUserWorkspace(nextUser);
        setUser(nextUser);
        setWorkspaceToken(token);
        setAuthError(null);
      } catch (err) {
        setAuthError(err instanceof Error ? err.message : "Could not initialize workspace.");
      } finally {
        setLoading(false);
      }
    });
    return () => unsub();
  }, []);

  const handleGoogleAuth = async (): Promise<boolean> => {
    setSigningIn(true);
    setAuthError(null);
    try {
      const { user: signedInUser, accessToken } = await signInWithGoogle();
      await ensureUserWorkspace(signedInUser);
      setUser(signedInUser);
      setWorkspaceToken(accessToken);
      return true;
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Google sign-in failed.");
      return false;
    } finally {
      setSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    await logout();
    setUser(null);
    setWorkspaceToken(null);
  };

  if (loading) {
    return (
      <div className="login-wrap">
        <div className="login-card" style={{ textAlign: "center" }}>
          <div className="login-brand" style={{ justifyContent: "center" }}>
            <div className="brand-mark">OS</div>
            <div style={{ textAlign: "left" }}>
              <div style={{ fontWeight: 600, fontSize: 16 }}>Outreach Studio</div>
              <div className="tiny">Checking your workspace session…</div>
            </div>
          </div>
          <div className="progress" style={{ justifyContent: "center", marginTop: 12 }}>
            <span className="spinner" />
            <span>Loading workspace…</span>
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginGate onGoogleAuth={handleGoogleAuth} busy={signingIn} error={authError} />;
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        workspaceToken,
        reconnectWorkspace: handleGoogleAuth,
        signOut: handleSignOut,
      }}
    >
      <Shell>{children}</Shell>
    </AuthContext.Provider>
  );
}
