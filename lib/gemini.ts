import { GoogleGenAI, ThinkingLevel, type Schema } from "@google/genai";
import {
  DEFAULT_GEMINI_MODEL,
  FALLBACK_GEMINI_MODEL,
  GeminiApiError,
  parseGeminiError,
  resolveModel,
} from "./gemini-utils";

export { DEFAULT_GEMINI_MODEL, FALLBACK_GEMINI_MODEL, GeminiApiError, parseGeminiError, resolveModel };

function createClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new GeminiApiError(
      "GEMINI_API_KEY is not configured on the server. Add or select one in Settings > Secrets to enable AI features.",
      500,
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503 || status === 500;
}

async function runWithRetryAndFallback<T>(
  requestedModel: string | undefined,
  executor: (model: string) => Promise<T>,
): Promise<{ result: T; model: string }> {
  const primary = resolveModel(requestedModel, process.env.GEMINI_MODEL);
  const candidates = primary === FALLBACK_GEMINI_MODEL ? [primary] : [primary, FALLBACK_GEMINI_MODEL];
  let lastError: GeminiApiError | null = null;

  for (let mIdx = 0; mIdx < candidates.length; mIdx++) {
    const model = candidates[mIdx];
    const maxAttempts = mIdx === 0 ? 2 : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await executor(model);
        return { result, model };
      } catch (err) {
        const parsed = parseGeminiError(err);
        lastError = parsed;

        if (!isRetryableStatus(parsed.status) && parsed.status !== 404) {
          throw parsed;
        }

        // Brief exponential backoff before retrying transient rate limit / 503 on same model
        if (attempt < maxAttempts - 1 && isRetryableStatus(parsed.status)) {
          const backoff = parsed.retryAfterMs && parsed.retryAfterMs <= 4000 ? parsed.retryAfterMs : 900 * (attempt + 1);
          await pause(backoff);
          continue;
        }

        // Move to fallback model on 429 / 404 / 503 if available
        break;
      }
    }
  }

  throw lastError ?? new GeminiApiError("Gemini request failed.", 500);
}

function parseJsonResponse<T>(text: string): T {
  const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        // fall through
      }
    }
    throw new GeminiApiError("Gemini returned a response that was not valid JSON. Try again.", 502);
  }
}

export async function geminiJSON<T>(options: {
  system: string;
  user: string;
  schema: Schema;
  model?: string;
}): Promise<T> {
  const ai = createClient();
  const { result } = await runWithRetryAndFallback(options.model, async (model) => {
    const response = await ai.models.generateContent({
      model,
      contents: options.user,
      config: {
        systemInstruction: options.system,
        responseMimeType: "application/json",
        responseSchema: options.schema,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      },
    });
    const text = (response.text ?? "").trim();
    if (!text) {
      throw new GeminiApiError("Gemini returned an empty response.", 502);
    }
    return parseJsonResponse<T>(text);
  });
  return result;
}

export async function geminiGroundedJSON<T>(options: {
  system: string;
  user: string;
  model?: string;
}): Promise<{ data: T; groundingUrls: { uri: string; title: string }[] }> {
  const ai = createClient();
  const { result } = await runWithRetryAndFallback(options.model, async (model) => {
    const response = await ai.models.generateContent({
      model,
      contents: options.user,
      config: {
        systemInstruction: options.system,
        tools: [{ googleSearch: {} }],
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      },
    });
    const text = (response.text ?? "").trim();
    if (!text) {
      throw new GeminiApiError("Gemini returned an empty search response.", 502);
    }

    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const groundingUrls = chunks
      .map((c) => c.web)
      .filter((w): w is { uri: string; title?: string } => Boolean(w?.uri))
      .map((w) => ({ uri: w.uri, title: w.title ?? w.uri }));

    return {
      data: parseJsonResponse<T>(text),
      groundingUrls,
    };
  });
  return result;
}

export async function testGeminiConnection(model?: string): Promise<{ model: string; ms: number; reply: string }> {
  const ai = createClient();
  const started = Date.now();
  const { result, model: usedModel } = await runWithRetryAndFallback(model, async (activeModel) => {
    const response = await ai.models.generateContent({
      model: activeModel,
      contents: 'Reply with only the single word "OK".',
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      },
    });
    return (response.text ?? "").trim();
  });

  return {
    model: usedModel,
    ms: Date.now() - started,
    reply: result,
  };
}
