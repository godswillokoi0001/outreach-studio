import { ConfigError } from "./env";
import { DatabaseUnavailableError } from "./db";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const NO_STORE = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
};

export function ok(data: unknown, init?: number | ResponseInit): Response {
  const opts = typeof init === "number" ? { status: init } : init;
  return Response.json(data, {
    ...opts,
    headers: { ...NO_STORE, ...(opts?.headers as Record<string, string> | undefined) },
  });
}

export function fail(status: number, message: string, extra?: Record<string, unknown>): Response {
  return ok({ error: message, ...extra }, status);
}

/** Wraps a route body: maps known errors to safe JSON responses. */
export async function route(fn: () => Promise<Response | unknown>): Promise<Response> {
  try {
    const result = await fn();
    if (result instanceof Response) return result;
    return ok(result);
  } catch (err) {
    if (err instanceof HttpError) return fail(err.status, err.message);
    if (err instanceof ConfigError) return fail(400, err.message);
    if (err instanceof DatabaseUnavailableError) return fail(503, err.message);
    const message = err instanceof Error ? err.message : "Unexpected error";
    console.error("[route]", message);
    return fail(500, message);
  }
}

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

export function num(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function bool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export function requireFields<T extends Record<string, unknown>>(body: T, fields: (keyof T)[]): void {
  for (const field of fields) {
    const value = body[field];
    if (value === undefined || value === null || value === "") {
      throw new HttpError(400, `Missing required field: ${String(field)}`);
    }
  }
}
