import { NextRequest, NextResponse } from "next/server";
import { AuthError } from "./firebase-server-auth";
import { GeminiApiError, parseGeminiError } from "./gemini-utils";

export function extractWorkspaceToken(req: NextRequest): string {
  const auth = req.headers.get("Authorization")?.trim() ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const fbToken = req.headers.get("X-Firebase-Token")?.trim() ?? "";
  if (!token || (fbToken && token === fbToken)) {
    throw new AuthError(
      "Google Workspace access token missing. Click 'Reconnect Gmail & Sheets' in the top bar.",
      401,
    );
  }
  return token;
}

export function handleApiError(err: unknown): NextResponse {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof GeminiApiError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  const message = err instanceof Error ? err.message : "Server error.";
  if (message.includes("RESOURCE_EXHAUSTED") || message.includes('"code":429')) {
    const parsed = parseGeminiError(err);
    return NextResponse.json({ error: parsed.message }, { status: parsed.status });
  }
  return NextResponse.json({ error: message }, { status: 400 });
}
