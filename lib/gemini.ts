import { ConfigError, getEnv } from "./env";
import { runtimeConfig, MODEL_FALLBACKS } from "./config";

export type SchemaType = "OBJECT" | "ARRAY" | "STRING" | "INTEGER" | "NUMBER" | "BOOLEAN";

export interface GeminiSchema {
  type: SchemaType;
  description?: string;
  properties?: Record<string, GeminiSchema>;
  required?: string[];
  items?: GeminiSchema;
  enum?: string[];
  nullable?: boolean;
}

interface GenerateOptions {
  /** The account whose configuration is used (its own key, or the platform key). */
  ownerSub: string;
  system: string;
  user: string;
  schema?: GeminiSchema;
  temperature?: number;
  maxTokens?: number;
  model?: string;
  /** Enables Google Search grounding. */
  search?: boolean;
  /** Skip responseMimeType so grounding can be combined with free text output. */
  looseJson?: boolean;
}

export async function geminiConfigured(ownerSub: string): Promise<boolean> {
  const config = await runtimeConfig(ownerSub);
  return Boolean(config.geminiKey);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Attempt {
  text?: string;
  status: number;
  error?: string;
  retryable: boolean;
  modelUnavailable: boolean;
}

async function callModel(model: string, apiKey: string, options: GenerateOptions): Promise<Attempt> {
  const env = await getEnv();
  const root = (env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
  const url = `${root}/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: options.system }] },
    contents: [{ role: "user", parts: [{ text: options.user }] }],
    generationConfig: {
      temperature: options.temperature ?? 0.4,
      maxOutputTokens: options.maxTokens ?? 2048,
      ...(options.schema && !options.looseJson
        ? { responseMimeType: "application/json", responseSchema: options.schema }
        : {}),
    },
    ...(options.search ? { tools: [{ google_search: {} }] } : {}),
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
      error?: { message?: string; status?: string };
    };
    if (!res.ok) {
      const message = data.error?.message ?? `HTTP ${res.status}`;
      const modelUnavailable =
        res.status === 404 || /no longer available|not found|not supported/i.test(message);
      return {
        status: res.status,
        error: message,
        retryable: res.status === 429 || res.status >= 500,
        modelUnavailable,
      };
    }
    if (data.promptFeedback?.blockReason) {
      return { status: 200, error: `Gemini blocked the request (${data.promptFeedback.blockReason}).`, retryable: false, modelUnavailable: false };
    }
    const candidate = data.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => p && p.thought !== true && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("")
      .trim();
    if (!text) {
      return {
        status: 200,
        error: `Gemini returned an empty response${candidate?.finishReason ? ` (${candidate.finishReason})` : ""}.`,
        retryable: true,
        modelUnavailable: false,
      };
    }
    return { status: 200, text, retryable: false, modelUnavailable: false };
  } catch (err) {
    return {
      status: 0,
      error: err instanceof Error ? err.message : "Gemini request failed.",
      retryable: true,
      modelUnavailable: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function geminiText(options: GenerateOptions): Promise<string> {
  const config = await runtimeConfig(options.ownerSub);
  if (!config.geminiKey) {
    throw new ConfigError(
      "No Gemini API key is configured yet. Open Integrations and paste a Google AI Studio key to enable research, qualification and email writing.",
    );
  }

  // Try the requested model first, then the configured one, then the fallback
  // chain. Retired models return 404, so the app keeps working when Google
  // retires a model id.
  const models = Array.from(
    new Set([options.model, config.geminiModel, ...MODEL_FALLBACKS].filter((m): m is string => Boolean(m))),
  );

  const problems: string[] = [];
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await callModel(model, config.geminiKey, options);
      if (result.text) return result.text;
      if (result.status === 400 && /api key/i.test(result.error ?? "")) {
        throw new ConfigError("Gemini rejected the API key. Paste a valid key from Google AI Studio in Integrations.");
      }
      problems.push(`${model}: ${result.error}`);
      if (result.modelUnavailable) break;
      if (!result.retryable) break;
      await sleep(1200 * (attempt + 1));
    }
  }

  throw new ConfigError(
    `Gemini could not complete the request. ${problems.slice(0, 3).join(" | ")}`,
  );
}

export async function geminiJSON<T>(options: GenerateOptions & { schema: GeminiSchema }): Promise<T> {
  const base = options.maxTokens ?? 2048;
  const text = await geminiText({ ...options, looseJson: false });
  try {
    return parseJson<T>(text);
  } catch {
    // A truncated or malformed reply is retried once with a larger budget:
    // reasoning tokens count against maxOutputTokens on newer models.
    const retryTokens = Math.min(base * 2 + 600, 8192);
    const retry = await geminiText({ ...options, looseJson: false, maxTokens: retryTokens });
    return parseJson<T>(retry);
  }
}

/** For grounded calls where a response schema cannot be combined with the search tool. */
export async function geminiLooseJSON<T>(options: GenerateOptions): Promise<T> {
  const text = await geminiText({ ...options, looseJson: true });
  return parseJson<T>(text);
}

function parseJson<T>(text: string): T {
  const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
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
    throw new ConfigError("Gemini returned a response that was not valid JSON. Try again.");
  }
}
