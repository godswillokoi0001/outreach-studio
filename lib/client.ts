"use client";

import { getAccessToken } from "./auth";
import { ensureWorkspaceToken, readWorkspaceToken } from "./workspace";
import { extractErrorMessageFromJson } from "./gemini-utils";
import { aiConfigHeader, ensureAiConfigLoaded, setActiveAiConfig } from "./ai-client";
import { toast } from "@/components/Feedback";

/**
 * Turn anything the API can return into a readable sentence.
 *
 * Supabase and provider errors arrive as objects (`{ message, code, details }`),
 * which used to reach the screen as the literal text "[object Object]".
 */
export function describeError(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const nested = extractErrorMessageFromJson(trimmed);
    if (nested?.message) return nested.message;
    if (trimmed === "[object Object]") return null;
    return trimmed;
  }
  if (value instanceof Error) return describeError(value.message);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["message", "error_description", "error", "details", "hint", "reason"]) {
      const nested = describeError(record[key]);
      if (nested) return nested;
    }
    try {
      const json = JSON.stringify(value);
      return json && json !== "{}" ? json : null;
    } catch {
      return null;
    }
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/**
 * Move to the next enabled provider after a quota, outage or network failure.
 * The vault is imported lazily so this module stays free of cycles.
 */
async function rotateAiProvider(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  try {
    const providers = await import("./ai/providers");
    const list = providers.enabledProviders(providers.readProviders());
    if (list.length < 2) return false;
    const currentId = providers.readActiveProviderId();
    const index = list.findIndex((provider) => provider.id === currentId);
    const next = list[(index + 1 + list.length) % list.length];
    if (!next || next.id === currentId) return false;
    providers.setActiveProviderId(next.id);
    setActiveAiConfig(providers.toAiConfig(next));
    return true;
  } catch {
    return false;
  }
}

export async function authedPost<T>(
  path: string,
  body?: unknown,
  options?: { requireWorkspace?: boolean; retryTransient?: boolean },
): Promise<T> {
  const sessionToken = await getAccessToken();
  if (!sessionToken) {
    throw new Error("Sign in with Google to continue.");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${sessionToken}`,
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
    headers["X-Google-Token"] = workspaceToken;
  }

  // AI routes are safe to replay, so they back off and retry instead of
  // failing the moment the provider is busy. Anything else (sending mail,
  // writing a sheet) only retries when a caller explicitly opts in.
  const isAiRoute = path.startsWith("/api/ai/");
  const maxAttempts = options?.retryTransient || isAiRoute ? 6 : 1;
  const backoffMs = (attempt: number) =>
    Math.min(8_000, 900 * 2 ** attempt) + Math.round(Math.random() * 400);
  const serialized = body === undefined ? undefined : JSON.stringify(body);

  let rotatedProvider = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(path, {
        method: "POST",
        headers,
        body: serialized,
        cache: "no-store",
        credentials: "same-origin",
      });
    } catch (err) {
      // A network failure on an AI call switches to the next saved model
      // instead of failing the whole feature.
      if (isAiRoute && !rotatedProvider && (await rotateAiProvider())) {
        rotatedProvider = true;
        headers["X-AI-Config"] = aiConfigHeader() ?? headers["X-AI-Config"];
        attempt = -1;
        continue;
      }
      throw err;
    }

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
      const isTransientStatus =
        res.status === 408 ||
        res.status === 425 ||
        res.status === 429 ||
        res.status === 500 ||
        res.status === 502 ||
        res.status === 503 ||
        res.status === 504;
      if (isTransientStatus && attempt < maxAttempts - 1) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt),
        );
        continue;
      }
      // The selected model is out of quota or down: try the next provider
      // before giving up on the request.
      if (isAiRoute && !rotatedProvider && (await rotateAiProvider())) {
        rotatedProvider = true;
        headers["X-AI-Config"] = aiConfigHeader() ?? headers["X-AI-Config"];
        attempt = -1;
        continue;
      }
      const rawError =
        data && typeof data === "object" && "error" in data
          ? (data as { error: unknown }).error
          : null;
      const message = describeError(rawError) ?? `Request failed (HTTP ${res.status}).`;
      const error = new Error(message) as Error & { status?: number };
      error.status = res.status;
      // The operator renders its own inline errors, so AI failures stay in the panel.
      if (!path.startsWith("/api/ai/")) {
        toast({ tone: "bad", title: "Something went wrong", message });
      }
      throw error;
    }

    if (data === null || typeof data !== "object") {
      if (attempt < maxAttempts - 1) {
        await sleep(backoffMs(attempt));
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
  const sessionToken = await getAccessToken();
  if (!sessionToken) throw new Error("Sign in with Google to continue.");
  const res = await fetch(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${sessionToken}`, Accept: "application/json" },
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
      describeError(
        data && typeof data === "object" && "error" in data ? (data as { error: unknown }).error : null,
      ) ?? `Upload failed (HTTP ${res.status}).`;
    toast({ tone: "bad", title: "Upload failed", message });
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
      const nestedError = describeError(parsed?.error);
      if (nestedError) return nestedError;
    } catch {
      // ignore non-JSON error message
    }
    return describeError(err.message) ?? err.message;
  }
  return describeError(err) ?? "Something went wrong.";
}

export function isQuotaError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();
  return msg.includes("429") || msg.includes("quota") || msg.includes("rate limit") || msg.includes("resource_exhausted");
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
