"use client";

/**
 * The Workspace access token is short-lived and must never touch storage.
 * A single in-memory cache is shared by every caller so the app refreshes it
 * once, not once per request.
 */

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cache: CachedToken | null = null;

export function readWorkspaceToken(): string | null {
  if (!cache) return null;
  if (Date.now() > cache.expiresAt) {
    cache = null;
    return null;
  }
  return cache.token;
}

export function writeWorkspaceToken(token: string | null | undefined, expiresIn = 3600): void {
  if (!token || typeof token !== "string" || !token.trim()) {
    cache = null;
    return;
  }
  cache = { token: token.trim(), expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1000 };
}

export function clearWorkspaceToken(): void {
  cache = null;
}

export function workspaceTokenPresent(): boolean {
  return readWorkspaceToken() !== null;
}
