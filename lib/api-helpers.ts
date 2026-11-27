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

export function handleApiError(err: unknown): NextResponse {
  if (err instanceof LLMGatewayError) {
    return NextResponse.json(
      {
        error: err.message,
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
        error: err.message,
        ...(extra.code ? { code: extra.code } : {}),
        ...(extra.canUseOwnKey ? { canUseOwnKey: true } : {}),
        ...(extra.canFallbackToPlatform ? { canFallbackToPlatform: true } : {}),
      },
      { status: err.status },
    );
  }
  if (err instanceof GeminiApiError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof AiProviderError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  const message = err instanceof Error ? err.message : "Server error.";
  if (message.includes("RESOURCE_EXHAUSTED") || message.includes('"code":429')) {
    const parsed = parseGeminiError(err);
    return NextResponse.json({ error: parsed.message }, { status: parsed.status });
  }
  return NextResponse.json({ error: message }, { status: 400 });
}
