"use client";

// The Google Workspace OAuth access token is held in memory only. It is
// deliberately never written to localStorage or sessionStorage, so a reload
// either reuses the server's stored refresh token or asks for consent again.
let workspaceToken: string | null = null;

export function readWorkspaceToken(): string | null {
  return workspaceToken;
}

export function writeWorkspaceToken(token: string | null | undefined): void {
  const next = typeof token === "string" ? token.trim() : "";
  workspaceToken = next.length > 0 ? next : null;
}

export function clearWorkspaceToken(): void {
  workspaceToken = null;
}
