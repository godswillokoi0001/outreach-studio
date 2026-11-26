"use client";

import { getAccessToken } from "@/lib/auth";

export class AdminClientError extends Error {
  code?: string;
  status?: number;
  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function adminFetch<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: unknown;
    sessionToken?: string | null;
    reauthToken?: string | null;
  } = {},
): Promise<T> {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    throw new AdminClientError("Sign in with Google first.", "UNAUTHENTICATED", 401);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  if (options.sessionToken) headers["X-Admin-2FA"] = options.sessionToken;
  if (options.reauthToken) headers["X-Admin-Reauth"] = options.reauthToken;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(path, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });

  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) {
    throw new AdminClientError(
      data.error || `Admin request failed (HTTP ${res.status}).`,
      data.code,
      res.status,
    );
  }
  return data as T;
}
