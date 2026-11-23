"use client";

import { getFirebaseIdToken, getWorkspaceAccessToken } from "./firebase";
import { extractErrorMessageFromJson } from "./gemini-utils";

export async function authedPost<T>(
  path: string,
  body?: unknown,
  options?: { requireWorkspace?: boolean },
): Promise<T> {
  const firebaseToken = await getFirebaseIdToken();
  if (!firebaseToken) {
    throw new Error("Sign in with Google to continue.");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Firebase-Token": firebaseToken,
  };

  if (options?.requireWorkspace) {
    const workspaceToken = getWorkspaceAccessToken();
    if (!workspaceToken) {
      throw new Error(
        "Google Workspace session needs a fresh sign-in. Click 'Reconnect Gmail & Sheets' in the top bar.",
      );
    }
    headers.Authorization = `Bearer ${workspaceToken}`;
  } else {
    headers.Authorization = `Bearer ${firebaseToken}`;
  }

  const res = await fetch(path, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `Request failed (${res.status}).`;
    throw new Error(message);
  }
  return data as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const nested = extractErrorMessageFromJson(err.message);
    if (nested?.code === 429 || nested?.status === "RESOURCE_EXHAUSTED") {
      return "Gemini API quota or rate limit exceeded (429). Wait briefly, switch the model to Gemini 3.1 Flash Lite in Settings, or select a billing-enabled API key in Settings > Secrets.";
    }
    if (nested?.message) return nested.message;
    try {
      const parsed = JSON.parse(err.message) as { error?: unknown };
      if (parsed && typeof parsed.error === "string") return parsed.error;
    } catch {
      // ignore non-JSON error message
    }
    return err.message;
  }
  return "Something went wrong.";
}

export function isQuotaError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();
  return msg.includes("429") || msg.includes("quota") || msg.includes("rate limit") || msg.includes("resource_exhausted");
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
