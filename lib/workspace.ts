"use client";

import { getFirebaseIdToken } from "./firebase";
import { clearWorkspaceToken, readWorkspaceToken, writeWorkspaceToken } from "./workspace-token";

export interface WorkspaceStatus {
  /** A server-side OAuth client is configured, so the connection can persist. */
  configured: boolean;
  /** The server holds a refresh token for this user. */
  connected: boolean;
  email: string | null;
}

const EMPTY_STATUS: WorkspaceStatus = { configured: false, connected: false, email: null };

async function post<T>(path: string, method: "POST" | "DELETE" = "POST"): Promise<T> {
  const idToken = await getFirebaseIdToken();
  if (!idToken) throw new Error("Sign in with Google first.");
  const res = await fetch(path, {
    method,
    headers: { "X-Firebase-Token": idToken, Authorization: `Bearer ${idToken}` },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status}).`);
  return data as T;
}

let inFlight: Promise<boolean> | null = null;

/**
 * Guarantees a usable Workspace token:
 *  1. reuse the in-memory token while it is valid;
 *  2. otherwise ask the server to exchange the stored refresh token;
 *  3. otherwise report that the user must connect once.
 */
export async function ensureWorkspaceToken(force = false): Promise<boolean> {
  if (!force && readWorkspaceToken()) return true;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const result = await post<{
        connected: boolean;
        configured: boolean;
        accessToken?: string;
        expiresIn?: number;
      }>("/api/google/token");
      if (result.connected && result.accessToken) {
        writeWorkspaceToken(result.accessToken, result.expiresIn ?? 3600);
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

export async function workspaceStatus(): Promise<WorkspaceStatus> {
  try {
    return await post<WorkspaceStatus>("/api/google/status");
  } catch {
    return { ...EMPTY_STATUS };
  }
}

/**
 * Full-page redirect into Google's consent screen through the app's own OAuth
 * client. Returns false when the server has no client configured, so the caller
 * can fall back to the Firebase popup instead.
 */
export async function startGoogleConnection(): Promise<boolean> {
  const idToken = await getFirebaseIdToken();
  if (!idToken) throw new Error("Sign in with Google first.");
  const res = await fetch("/api/google/connect", {
    method: "POST",
    headers: { "X-Firebase-Token": idToken, Authorization: `Bearer ${idToken}` },
    cache: "no-store",
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as {
    url?: string;
    configured?: boolean;
    error?: string;
  };
  if (!res.ok) {
    if (data.configured === false) return false;
    throw new Error(data.error ?? `Request failed (${res.status}).`);
  }
  if (!data.url) throw new Error("Google did not return a consent URL.");
  window.location.href = data.url;
  return true;
}

export async function disconnectWorkspace(): Promise<void> {
  clearWorkspaceToken();
  try {
    await post("/api/google/status", "DELETE");
  } catch {
    // browser copy cleared
  }
}

export { clearWorkspaceToken, readWorkspaceToken, writeWorkspaceToken } from "./workspace-token";
