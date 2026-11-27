import { NextRequest, NextResponse } from "next/server";
import { AuthError } from "./server-auth";
import { GeminiApiError, parseGeminiError } from "./gemini-utils";
import { AiProviderError } from "./ai/types";
import { LLMGatewayError } from "./llm/gateway";

/**
 * The session travels in `Authorization` (Supabase access token); the Google
 * Workspace access token travels in `X-Google-Token`, so the two never collide.
 */
export function extractWorkspaceToken(req: NextRequest): string {
  const token = req.headers.get("X-Google-Token")?.trim() ?? "";
  if (!token) {
    throw new AuthError(
      "Google Workspace access token missing. Click 'Reconnect Gmail & Sheets' in the top bar.",
      401,
    );
  }
  return token;
}

const FALLBACK_MESSAGE = "Something went wrong on the server. Please try again.";

/**
 * Reduce anything thrown by a route (Error, string, Supabase/PostgREST object,
 * fetch Response, unknown) to a readable sentence. Supabase errors are plain
 * objects, which is how the literal text "[object Object]" used to reach the UI.
 */
export function extractErrorMessage(err: unknown, fallback = FALLBACK_MESSAGE): string {
  if (err === null || err === undefined) return fallback;

  if (typeof err === "string") {
    const trimmed = err.trim();
    if (!trimmed || trimmed === "[object Object]") return fallback;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return extractErrorMessage(JSON.parse(trimmed), fallback);
      } catch {
        /* plain sentence, fall through */
      }
    }
    return trimmed;
  }

  if (err instanceof Error) {
    const msg = err.message?.trim();
    if (msg && msg !== "[object Object]") {
      // Wrap-and-rethrow patterns sometimes hide a JSON payload in message.
      if (msg.startsWith("{")) {
        try {
          return extractErrorMessage(JSON.parse(msg), msg);
        } catch {
          /* keep the message */
        }
      }
      return msg;
    }
    return fallback;
  }

  if (typeof err === "object") {
    const rec = err as Record<string, unknown>;
    for (const key of ["message", "error_description", "error", "details", "hint", "reason"]) {
      const nested = rec[key];
      if (typeof nested === "string" && nested.trim()) return extractErrorMessage(nested, fallback);
      if (nested && typeof nested === "object") {
        const deep = extractErrorMessage(nested, "");
        if (deep) return deep;
      }
    }
    try {
      const json = JSON.stringify(err);
      if (json && json !== "{}" && json !== "[]") return json;
    } catch {
      /* unserializable */
    }
    return fallback;
  }

  if (typeof err === "number" || typeof err === "boolean") return String(err);
  return fallback;
}

/** Stable machine-readable code for the client, defaulting per status. */
export function extractErrorCode(err: unknown, fallback = "INTERNAL_ERROR"): string {
  if (err && typeof err === "object") {
    const rec = err as Record<string, unknown>;
    for (const key of ["code", "errorCode", "error_code", "statusCode"]) {
      const value = rec[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return fallback;
}

function defaultStatusFor(err: unknown): number {
  if (err && typeof err === "object") {
    const rec = err as Record<string, unknown>;
    const status = Number(rec.status ?? rec.statusCode ?? 0);
    if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
    // Supabase/PostgREST errors are server-side failures, never client faults.
    if (typeof rec.code === "string" && /^\d{5}$/.test(rec.code)) return 500;
  }
  // Plain Error/string messages in this codebase are user-facing validation text.
  if (err instanceof Error || typeof err === "string") return 400;
  return 500;
}

/**
 * Every route funnels failures through here so a handler can never fall back to
 * Vercel's raw crash page and the UI always receives `{ error: string, code }`.
 */
export function handleApiError(err: unknown, route?: string, ownerId?: string): NextResponse {
  const message = extractErrorMessage(err);

  if (err instanceof LLMGatewayError) {
    return NextResponse.json(
      {
        error: message,
        code: err.code,
        ...(err.receipt ? { receipt: err.receipt } : {}),
        ...(err.canFallbackToSystemAuto ? { canFallbackToSystemAuto: true } : {}),
      },
      { status: err.status },
    );
  }
  if (err instanceof AuthError) {
    const extra = err as AuthError & {
      code?: string;
      canUseOwnKey?: boolean;
      canFallbackToPlatform?: boolean;
    };
    return NextResponse.json(
      {
        error: message,
        code: extra.code ?? (err.status === 403 ? "FORBIDDEN" : "UNAUTHENTICATED"),
        ...(extra.canUseOwnKey ? { canUseOwnKey: true } : {}),
        ...(extra.canFallbackToPlatform ? { canFallbackToPlatform: true } : {}),
      },
      { status: err.status },
    );
  }
  if (err instanceof GeminiApiError) {
    return NextResponse.json(
      { error: message, code: "AI_PROVIDER_ERROR" },
      { status: err.status },
    );
  }
  if (err instanceof AiProviderError) {
    return NextResponse.json(
      { error: message, code: "AI_PROVIDER_ERROR" },
      { status: err.status },
    );
  }

  if (message.includes("RESOURCE_EXHAUSTED") || message.includes('"code":429')) {
    const parsed = parseGeminiError(err);
    return NextResponse.json(
      { error: parsed.message, code: "AI_RATE_LIMITED" },
      { status: parsed.status },
    );
  }

  const status = defaultStatusFor(err);
  // Always leave a server-side trail with the route and account that failed.
  console.error(
    `[api${route ? ` ${route}` : ""}] request failed${ownerId ? ` for owner ${ownerId}` : ""}:`,
    message,
    err instanceof Error ? err.stack : err,
  );

  return NextResponse.json(
    { error: message, code: extractErrorCode(err, status >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST") },
    { status },
  );
}
