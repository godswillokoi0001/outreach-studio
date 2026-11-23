"use client";

import { getFirebaseIdToken } from "./firebase";
import { ensureWorkspaceToken, readWorkspaceToken } from "./workspace";
import { extractErrorMessageFromJson } from "./gemini-utils";
import { aiConfigHeader, ensureAiConfigLoaded } from "./ai-client";

export async function authedPost<T>(
  path: string,
  body?: unknown,
  options?: { requireWorkspace?: boolean; retryTransient?: boolean },
): Promise<T> {
  const firebaseToken = await getFirebaseIdToken();
  if (!firebaseToken) {
    throw new Error("Sign in with Google to continue.");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Firebase-Token": firebaseToken,
  };

  // AI routes run against whichever provider/model the user connected in
  // Settings. The key never leaves this request.
  if (path.startsWith("/api/ai/")) {
    await ensureAiConfigLoaded();
    const aiHeader = aiConfigHeader();
    if (aiHeader) headers["X-AI-Config"] = aiHeader;
  }

  if (options?.requireWorkspace) {
    const ready = await ensureWorkspaceToken();
    const workspaceToken = ready ? readWorkspaceToken() : null;
    if (!workspaceToken) {
      throw new Error(
        "Google Workspace is not connected. Click 'Connect Google' in the top bar to grant Sheets and Gmail access.",
      );
    }
    headers.Authorization = `Bearer ${workspaceToken}`;
  } else {
    headers.Authorization = `Bearer ${firebaseToken}`;
  }

  const maxAttempts = options?.retryTransient ? 2 : 1;
  const serialized = body === undefined ? undefined : JSON.stringify(body);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(path, {
      method: "POST",
      headers,
      body: serialized,
      cache: "no-store",
      credentials: "same-origin",
    });

    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();
    let data: unknown = null;
    let parseFailed = false;
    if (text.trim().length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
        parseFailed = true;
      }
    }

    if (!res.ok) {
      const isTransientStatus = res.status === 502 || res.status === 503 || res.status === 504;
      if (isTransientStatus && attempt < maxAttempts - 1) {
        await sleep(700);
        continue;
      }
      const message =
        data && typeof data === "object" && "error" in data && (data as { error: unknown }).error
          ? String((data as { error: unknown }).error)
          : `Request failed (HTTP ${res.status}).`;
      throw new Error(message);
    }

    if (data === null || typeof data !== "object") {
      if (attempt < maxAttempts - 1) {
        await sleep(700);
        continue;
      }
      const looksHtml =
        contentType.includes("text/html") ||
        text.trimStart().startsWith("<!") ||
        text.trimStart().startsWith("<html");
      if (looksHtml || res.redirected) {
        throw new Error(
          "The server returned an HTML page instead of JSON. Your preview session may have refreshed — reload the page and try again.",
        );
      }
      if (parseFailed) {
        throw new Error("The server returned an incomplete response. Please try again.");
      }
      throw new Error("The server returned an empty response. Please try again.");
    }

    return data as T;
  }

  throw new Error("Request failed after retrying. Please try again.");
}

export async function authedUpload<T>(path: string, form: FormData): Promise<T> {
  const firebaseToken = await getFirebaseIdToken();
  if (!firebaseToken) throw new Error("Sign in with Google to continue.");
  const res = await fetch(path, {
    method: "POST",
    headers: { "X-Firebase-Token": firebaseToken, Accept: "application/json" },
    body: form,
    cache: "no-store",
    credentials: "same-origin",
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
        : `Upload failed (HTTP ${res.status}).`;
    throw new Error(message);
  }
  return data as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const nested = extractErrorMessageFromJson(err.message);
    if (nested?.code === 429 || nested?.status === "RESOURCE_EXHAUSTED") {
      return "AI quota or rate limit exceeded (429) for the selected provider. Wait briefly, pick a lighter model, or connect a billing-enabled key in Settings > AI engine.";
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
