export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";
export const FALLBACK_GEMINI_MODEL = "gemini-3.6-flash";

/**
 * Only ids verified against the live `v1` API belong in this list. Probed on
 * 2026-11-23: 3.5 and 3.6 answer, 3.8 is rate-limited (503), and
 * `gemini-flash-latest` / 2.5 / 2.5-pro are not served on v1.
 */
export const SUPPORTED_GEMINI_MODELS = [
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash (recommended — best balance)" },
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash (newer, used as fallback)" },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash (newest — may be busy)" },
] as const;

const DEPRECATED_MODELS = new Set([
  "gemini-1.5-flash",
  "gemini-1.5-pro",
  "gemini-pro",
  "gemini-2.0-flash",
  "gemini-2.0-pro",
  "gemini-2.0-flash-thinking",
]);

/**
 * Model ids that were written into saved settings by an earlier build but do
 * not exist on the public API. They are mapped instead of being sent to the
 * server, so an old workspace heals itself on the next call.
 */
const LEGACY_ALIASES: Record<string, string> = {
  "gemini-4-hydrogen": DEFAULT_GEMINI_MODEL,
  "gemini-3.1-flash-lite": FALLBACK_GEMINI_MODEL,
  "gemini-flash-latest": DEFAULT_GEMINI_MODEL,
  "gemini-3.5-flash-preview": DEFAULT_GEMINI_MODEL,
};

export function resolveModel(requested?: string, envModel?: string): string {
  const raw = (requested || envModel || DEFAULT_GEMINI_MODEL).trim().replace(/^models\//i, "");
  if (!raw) return DEFAULT_GEMINI_MODEL;
  const lower = raw.toLowerCase();
  if (LEGACY_ALIASES[lower]) return LEGACY_ALIASES[lower];
  if (DEPRECATED_MODELS.has(lower)) return DEFAULT_GEMINI_MODEL;
  return raw;
}

export class GeminiApiError extends Error {
  status: number;
  retryAfterMs?: number;

  constructor(message: string, status = 500, retryAfterMs?: number) {
    super(message);
    this.name = "GeminiApiError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function extractErrorMessageFromJson(raw: string): {
  code?: number;
  status?: string;
  message?: string;
  retryAfterMs?: number;
} | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: {
        code?: number;
        status?: string;
        message?: string;
        details?: Array<{ retryDelay?: string }>;
      };
      message?: string;
      code?: number;
    };
    const errObj = parsed.error ?? parsed;
    const details = parsed.error?.details;
    let retryAfterMs: number | undefined;
    if (Array.isArray(details)) {
      for (const item of details) {
        if (typeof item?.retryDelay === "string") {
          const match = item.retryDelay.match(/^(\d+(?:\.\d+)?)s$/);
          if (match) retryAfterMs = Math.round(Number(match[1]) * 1000);
        }
      }
    }
    return {
      code: typeof errObj.code === "number" ? errObj.code : undefined,
      status: typeof parsed.error?.status === "string" ? parsed.error.status : undefined,
      message: typeof errObj.message === "string" ? errObj.message : undefined,
      retryAfterMs,
    };
  } catch {
    return null;
  }
}

export function parseGeminiError(err: unknown): GeminiApiError {
  if (err instanceof GeminiApiError) return err;

  const rawMsg = err instanceof Error ? err.message : String(err ?? "Gemini request failed.");
  const statusFromErr =
    typeof err === "object" && err !== null && "status" in err && typeof (err as { status: unknown }).status === "number"
      ? (err as { status: number }).status
      : undefined;

  const jsonInfo = extractErrorMessageFromJson(rawMsg);
  const code = statusFromErr ?? jsonInfo?.code ?? (rawMsg.includes("429") || rawMsg.includes("RESOURCE_EXHAUSTED") ? 429 : 500);
  const innerMsg = jsonInfo?.message ?? rawMsg;
  const lower = `${innerMsg} ${jsonInfo?.status ?? ""}`.toLowerCase();

  if (code === 429 || lower.includes("resource_exhausted") || lower.includes("exceeded your current quota")) {
    return new GeminiApiError(
      "Gemini API quota or rate limit exceeded (429). Wait briefly, switch the model to Gemini 3.1 Flash Lite in Settings, or select a billing-enabled API key in Settings > Secrets.",
      429,
      jsonInfo?.retryAfterMs,
    );
  }

  if (code === 403 || lower.includes("permission_denied") || lower.includes("api_key_invalid") || lower.includes("api key not valid")) {
    return new GeminiApiError(
      "Gemini API key is invalid or lacks permission. Please verify or select an active API key in Settings > Secrets.",
      403,
    );
  }

  if (code === 404 || lower.includes("not_found") || lower.includes("not found for api version")) {
    return new GeminiApiError(
      "The selected Gemini model is unavailable. Switch to Gemini 4 Hydrogen or Gemini 3.1 Flash Lite in Settings.",
      404,
    );
  }

  if (code === 503 || code === 500 || lower.includes("unavailable") || lower.includes("overloaded")) {
    return new GeminiApiError(
      "Gemini AI service is temporarily busy. Please try again in a few seconds.",
      503,
    );
  }

  return new GeminiApiError(innerMsg || "Gemini request failed.", code >= 400 && code < 600 ? code : 400);
}
