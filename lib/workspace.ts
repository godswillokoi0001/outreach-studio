"use client";

import { clearWorkspaceToken, readWorkspaceToken, writeWorkspaceToken } from "./workspace-token";

export interface WorkspaceStatus {
  /** A server-side OAuth client is configured, so the connection can persist. */
  configured: boolean;
  /** The server holds a refresh token for this user. */
  connected: boolean;
  email: string | null;
}

const EMPTY_STATUS: WorkspaceStatus = { configured: false, connected: false, email: null };

export { readWorkspaceToken };

/**
 * True when a Workspace access token is available in this browser session.
 * Falls back to asking the server for one when a persistent connection exists.
 */
export async function ensureWorkspaceToken(): Promise<boolean> {
  if (readWorkspaceToken()) return true;
  try {
    const res = await fetch("/api/google/token", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { accessToken?: string | null };
    if (!data.accessToken) return false;
    writeWorkspaceToken(data.accessToken);
    return true;
  } catch {
    return false;
  }
}

export async function workspaceStatus(): Promise<WorkspaceStatus> {
  try {
    const res = await fetch("/api/google/status", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!res.ok) return { ...EMPTY_STATUS };
    const data = (await res.json()) as Partial<WorkspaceStatus>;
    return {
      configured: Boolean(data.configured),
      connected: Boolean(data.connected),
      email: typeof data.email === "string" && data.email ? data.email : null,
    };
  } catch {
    return { ...EMPTY_STATUS };
  }
}

export async function startGoogleConnection(): Promise<void> {
  if (typeof window === "undefined") return;
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.location.href = `/api/google/start?return=${encodeURIComponent(returnTo)}`;
}

export async function disconnectWorkspace(): Promise<void> {
  clearWorkspaceToken();
  try {
    await fetch("/api/google/disconnect", {
      method: "POST",
      credentials: "same-origin",
    });
  } catch {
    // The browser copy is already cleared; a server-side failure is not fatal.
  }
}
