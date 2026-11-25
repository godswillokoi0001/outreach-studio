"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Session } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabaseBrowser = createBrowserClient(supabaseUrl, supabaseAnonKey);

/** Gmail + Sheets are requested separately from sign-in, through the app's own OAuth client. */
export const WORKSPACE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
] as const;

/**
 * The signed-in user as the app sees it.
 *
 * `uid` is the owner id the database rows belong to (resolved on the server from
 * `account_links`), so every existing `user.uid` call site keeps working after
 * the migration from Firebase.
 */
export interface AppUser {
  uid: string;
  ownerId: string;
  email: string;
  displayName: string;
  photoURL: string | null;
  emailVerified: boolean;
}

function authCallbackUrl(): string {
  return `${window.location.origin}/auth/callback`;
}

/** Identity-only Google sign-in through Supabase Auth. Redirects the browser. */
export async function signInWithGoogle(): Promise<void> {
  const { error } = await supabaseBrowser.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: authCallbackUrl(),
      queryParams: { prompt: "select_account" },
    },
  });
  if (error) throw new Error(error.message);
}

export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabaseBrowser.auth.getSession();
  if (data.session?.access_token) return data.session.access_token;
  const refreshed = await supabaseBrowser.auth.refreshSession();
  return refreshed.data.session?.access_token ?? null;
}

export async function getProviderToken(): Promise<string | null> {
  const { data } = await supabaseBrowser.auth.getSession();
  return data.session?.provider_token ?? null;
}

export function subscribeAuthState(onChange: (session: Session | null) => void): () => void {
  const { data } = supabaseBrowser.auth.onAuthStateChange((_event, session) => {
    onChange(session);
  });
  return () => data.subscription.unsubscribe();
}

export async function signOut(): Promise<void> {
  await supabaseBrowser.auth.signOut();
}

/** Loads the app user (and its data owner id) from the authenticated account route. */
export async function fetchCurrentUser(): Promise<AppUser | null> {
  const token = await getAccessToken();
  if (!token) return null;

  const res = await fetch("/api/account/me", {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
    credentials: "same-origin",
  });

  const text = await res.text().catch(() => "");
  const data = text ? (JSON.parse(text) as { user?: AppUser; error?: string }) : null;

  if (!res.ok) {
    throw new Error(data?.error ?? `Could not load your workspace (HTTP ${res.status}).`);
  }
  return data?.user ?? null;
}
