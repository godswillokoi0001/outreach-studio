import type { FunctionDeclaration, Schema } from "@google/genai";
import type { AgentContent, AgentFunctionCall } from "../agent-meta";
import {
  getProviderMeta,
  isSlowMegaModel,
  normalizeGatewayProviderId,
  type GatewayModelConfig,
  type GatewayProviderId,
  type TaskSeat,
} from "./types";

const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000;
const GROUNDED_ATTEMPT_TIMEOUT_MS = 12_000;

export class GatewayProviderError extends Error {
  status: number;
  retryable: boolean;
  authFailed: boolean;
  rateLimited: boolean;
  dailyQuotaExhausted: boolean;
  creditsExhausted: boolean;
  modelNotFound: boolean;
  /** The model exists but cannot serve this request shape (tools, multi-turn, vision). */
  modelUnsupported: boolean;
  retryAfterMs?: number;

  constructor(
    message: string,
    opts: {
      status?: number;
      retryable?: boolean;
      authFailed?: boolean;
      rateLimited?: boolean;
      dailyQuotaExhausted?: boolean;
      creditsExhausted?: boolean;
      modelNotFound?: boolean;
      modelUnsupported?: boolean;
      retryAfterMs?: number;
    } = {},
  ) {
    super(message);
    this.name = "GatewayProviderError";
    this.status = opts.status ?? 500;
    this.retryable = opts.retryable ?? (this.status === 429 || this.status === 402 || this.status >= 500);
    this.authFailed = opts.authFailed ?? (this.status === 401 || this.status === 403);
    this.rateLimited = opts.rateLimited ?? this.status === 429;
    this.dailyQuotaExhausted = opts.dailyQuotaExhausted ?? false;
    this.creditsExhausted = opts.creditsExhausted ?? this.status === 402;
    this.modelNotFound = opts.modelNotFound ?? this.status === 404;
    this.modelUnsupported = opts.modelUnsupported ?? false;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export interface AdapterCallConfig {
  provider: GatewayProviderId;
  model: string;
  apiKey: string;
  accountId?: string | null;
  baseUrl?: string | null;
}

export interface AdapterImage {
  mimeType: string;
  dataBase64: string;
}

export interface AdapterMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
  images?: AdapterImage[];
  tool_call_id?: string;
  tool_calls?: unknown[];
}

export interface AdapterCallInput {
  cfg: AdapterCallConfig;
  systemPrompt?: string;
  messages: AdapterMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "text" | "json";
  schema?: Schema;
  tools?: FunctionDeclaration[];
  agentContents?: AgentContent[];
  useGrounding?: boolean;
  timeoutMs?: number;
}

export interface AdapterCallOutput {
  text: string;
  functionCalls: AgentFunctionCall[];
  modelContent?: AgentContent;
  groundingUrls: { uri: string; title: string }[];
  grounded: boolean;
}

// Remember per-key Z.ai console host preference (global api.z.ai vs bigmodel.cn)
const zaiHostCache = new Map<string, string>();
const ZAI_GLOBAL_URL = "https://api.z.ai/api/paas/v4";
const ZAI_DOMESTIC_URL = "https://open.bigmodel.cn/api/paas/v4";

function parseRetryAfterHeader(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const until = Date.parse(raw);
  if (!Number.isNaN(until)) return Math.max(0, until - Date.now());
  return undefined;
}

function classifyHttpFailure(
  res: Response,
  rawText: string,
  parsed: Record<string, unknown> | null,
): GatewayProviderError {
  const errObj = (parsed?.error ?? parsed) as Record<string, unknown> | undefined;
  const errorsArr = Array.isArray(parsed?.errors) ? (parsed?.errors as Record<string, unknown>[]) : [];
  const detail =
    (typeof errObj?.message === "string" && errObj.message) ||
    (typeof errorsArr[0]?.message === "string" && String(errorsArr[0].message)) ||
    rawText.slice(0, 260) ||
    `HTTP ${res.status}`;

  const retryAfterMs = parseRetryAfterHeader(res);
  const payloadTooLarge =
    res.status === 413 ||
    /request too large|context length|maximum context|exceeded.*context window|reduce your message size/i.test(
      detail,
    );
  // "Quota exceeded" alone is what Google and Groq also return for a plain
  // per-minute burst. Only per-day/monthly wording (or an explicit PerDay
  // detail) means the key is really out of quota for the rest of the cycle.
  const perMinuteBurst = /per.?minute|per second|\brpm\b|\btpm\b|requests per minute|tokens per minute|retry in \d/i.test(
    detail,
  );
  const dailySignal =
    !payloadTooLarge &&
    !perMinuteBurst &&
    (/per.?day|daily.*(?:quota|limit)|free allocation|\brpd\b|\btpd\b/i.test(detail) ||
      (Array.isArray(errObj?.details) &&
        errObj.details.some((d) => JSON.stringify(d).includes("PerDay"))));

  const authFailed = res.status === 401 || res.status === 403;
  const creditsExhausted =
    res.status === 402 ||
    /insufficient.*(?:credit|balance|quota|funds)|no resource package|resource package|billing|quota.*balance|top.?up|payment required/i.test(
      detail,
    );
  const rateLimited = res.status === 429 && !payloadTooLarge;
  const modelNotFound = res.status === 404 || /model.*not found|does not exist/i.test(detail);
  // Payload/context-size errors (400/413/422) or unsupported request shapes (tools, JSON mode)
  // are strictly per-model limitations: skip that model without benching the whole API key.
  const modelUnsupported =
    payloadTooLarge ||
    (!modelNotFound &&
      res.status < 500 &&
      res.status !== 401 &&
      res.status !== 403 &&
      res.status !== 429 &&
      res.status !== 402 &&
      (res.status === 400 ||
        res.status === 422 ||
        /not enabled|not supported|does not support|unsupported|not available for|invalid argument|only supports single/i.test(
          detail,
        )));

  return new GatewayProviderError(detail, {
    status: res.status,
    retryable:
      rateLimited ||
      authFailed ||
      creditsExhausted ||
      modelNotFound ||
      modelUnsupported ||
      res.status >= 500 ||
      res.status === 408,
    authFailed,
    rateLimited,
    dailyQuotaExhausted: dailySignal,
    creditsExhausted,
    modelNotFound,
    modelUnsupported,
    retryAfterMs,
  });
}

async function fetchWithDeadline(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ res: Response; raw: string; parsed: Record<string, unknown> | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    const raw = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    } catch {
      parsed = null;
    }
    return { res, raw, parsed };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "AbortError") {
      throw new GatewayProviderError("Request timed out waiting for upstream AI provider.", {
        status: 504,
        retryable: true,
      });
    }
    throw new GatewayProviderError(
      `Network error reaching AI provider: ${err instanceof Error ? err.message : String(err)}`,
      { status: 502, retryable: true },
    );
  } finally {
    clearTimeout(timer);
  }
}

export function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

export function parseJsonWithRescue<T>(rawText: string): T {
  const cleaned = stripThinkTags(rawText)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (!cleaned) {
    throw new GatewayProviderError("Model returned empty JSON output.", {
      status: 502,
      retryable: true,
    });
  }
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const firstObj = cleaned.indexOf("{");
    const lastObj = cleaned.lastIndexOf("}");
    if (firstObj >= 0 && lastObj > firstObj) {
      try {
        return JSON.parse(cleaned.slice(firstObj, lastObj + 1)) as T;
      } catch {
        /* continue */
      }
    }
    const firstArr = cleaned.indexOf("[");
    const lastArr = cleaned.lastIndexOf("]");
    if (firstArr >= 0 && lastArr > firstArr) {
      try {
        return JSON.parse(cleaned.slice(firstArr, lastArr + 1)) as T;
      } catch {
        /* continue */
      }
    }
    throw new GatewayProviderError("Model output was not valid JSON.", {
      status: 502,
      retryable: true,
    });
  }
}

function schemaToJsonSchema(schema: Schema | undefined): Record<string, unknown> {
  if (!schema) return { type: "object", properties: {} };
  const out: Record<string, unknown> = {};
  if (schema.type) out.type = String(schema.type).toLowerCase();
  if (schema.description) out.description = schema.description;
  if (Array.isArray(schema.enum) && schema.enum.length) out.enum = schema.enum;
  if (Array.isArray(schema.required) && schema.required.length) out.required = schema.required;
  if (schema.items) out.items = schemaToJsonSchema(schema.items);
  if (schema.properties && typeof schema.properties === "object") {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      props[k] = schemaToJsonSchema(v);
    }
    out.properties = props;
  }
  if (!out.type && out.properties) out.type = "object";
  return out;
}

function resolveEndpointUrl(cfg: AdapterCallConfig): { baseUrl: string; bearer: string } {
  const { provider, impliedBaseUrl } = normalizeGatewayProviderId(cfg.provider);
  const meta = getProviderMeta(provider);

  if (provider === "cloudflare") {
    let accountId = (cfg.accountId ?? "").trim();
    let token = cfg.apiKey.trim();
    if (!accountId && token.includes(":")) {
      const idx = token.indexOf(":");
      accountId = token.slice(0, idx).trim();
      token = token.slice(idx + 1).trim();
    }
    if (!accountId) {
      throw new GatewayProviderError(
        "Cloudflare Workers AI requires an Account ID alongside the API Token.",
        { status: 400, retryable: false, authFailed: true },
      );
    }
    return {
      baseUrl: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1`,
      bearer: token,
    };
  }

  if (provider === "zai") {
    const explicit = (cfg.baseUrl ?? "").trim().replace(/\/+$/, "");
    const cached = zaiHostCache.get(cfg.apiKey.trim());
    return {
      baseUrl: explicit || cached || ZAI_GLOBAL_URL,
      bearer: cfg.apiKey.trim(),
    };
  }

  const rawBase = (cfg.baseUrl ?? "").trim() || impliedBaseUrl || meta.baseUrl;
  return {
    baseUrl: rawBase.replace(/\/+$/, ""),
    bearer: cfg.apiKey.trim(),
  };
}

function usesMaxCompletionTokens(modelId: string): boolean {
  const leaf = modelId.trim().toLowerCase().split("/").pop() ?? "";
  return /^(?:gpt-5|o[134])(?:$|[-._:@])/.test(leaf);
}

function agentContentsToOpenAI(contents: AgentContent[]): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  const openCalls: { id: string; name: string }[] = [];
  let autoId = 0;

  for (const turn of contents) {
    const parts = Array.isArray(turn.parts) ? turn.parts : [];
    if (turn.role === "model") {
      const text = parts
        .filter((p) => typeof p.text === "string" && !p.thought)
        .map((p) => p.text ?? "")
        .join("")
        .trim();
      const calls = parts
        .map((p) => p.functionCall)
        .filter((fc): fc is AgentFunctionCall => Boolean(fc && fc.name));
      if (calls.length > 0) {
        const toolCalls = calls.map((fc) => {
          const id = fc.id || `call_${Date.now().toString(36)}_${autoId++}`;
          openCalls.push({ id, name: fc.name || "tool" });
          return {
            id,
            type: "function",
            function: {
              name: fc.name || "tool",
              arguments: JSON.stringify(fc.args ?? {}),
            },
          };
        });
        messages.push({ role: "assistant", content: text || null, tool_calls: toolCalls });
      } else if (text) {
        messages.push({ role: "assistant", content: text });
      }
      continue;
    }

    const responses = parts
      .map((p) => p.functionResponse)
      .filter((fr): fr is NonNullable<typeof fr> => Boolean(fr && fr.name));
    for (const fr of responses) {
      let id = typeof fr.id === "string" ? fr.id : "";
      if (!id) {
        const idx = openCalls.findIndex((c) => c.name === fr.name);
        id = idx >= 0 ? openCalls[idx].id : openCalls[openCalls.length - 1]?.id || "";
      }
      // Orphan tool results (no matching assistant tool_call) make providers
      // reject the whole payload with a generic 400, so never send them.
      const matchIdx = openCalls.findIndex((c) => c.id === id && id !== "");
      if (matchIdx < 0) continue;
      openCalls.splice(matchIdx, 1);
      messages.push({
        role: "tool",
        tool_call_id: id,
        content: JSON.stringify(fr.response ?? {}),
      });
    }

    const text = parts
      .filter((p) => typeof p.text === "string" && !p.thought)
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    const images = parts
      .map((p) => p.inlineData)
      .filter(
        (img): img is { mimeType: string; data: string } =>
          Boolean(img && img.data && img.mimeType.startsWith("image/")),
      );
    if (images.length > 0) {
      messages.push({
        role: "user",
        content: [
          ...(text ? [{ type: "text", text }] : []),
          ...images.map((img) => ({
            type: "image_url",
            image_url: { url: `data:${img.mimeType};base64,${img.data}` },
          })),
        ],
      });
    } else if (text) {
      messages.push({ role: "user", content: text });
    }
  }
  return messages;
}

function agentContentsToAnthropic(contents: AgentContent[]): { role: "user" | "assistant"; content: unknown[] }[] {
  const messages: { role: "user" | "assistant"; content: unknown[] }[] = [];
  const openCalls: { id: string; name: string }[] = [];
  let autoId = 0;

  const push = (role: "user" | "assistant", blocks: unknown[]) => {
    if (blocks.length === 0) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };

  for (const turn of contents) {
    const parts = Array.isArray(turn.parts) ? turn.parts : [];
    if (turn.role === "model") {
      const text = parts
        .filter((p) => typeof p.text === "string" && !p.thought)
        .map((p) => p.text ?? "")
        .join("")
        .trim();
      const blocks: unknown[] = [];
      if (text) blocks.push({ type: "text", text });
      for (const fc of parts.map((p) => p.functionCall).filter((fc): fc is AgentFunctionCall => Boolean(fc && fc.name))) {
        const id = fc.id || `toolu_${Date.now().toString(36)}_${autoId++}`;
        openCalls.push({ id, name: fc.name || "tool" });
        blocks.push({ type: "tool_use", id, name: fc.name || "tool", input: fc.args ?? {} });
      }
      push("assistant", blocks);
      continue;
    }

    const blocks: unknown[] = [];
    for (const fr of parts
      .map((p) => p.functionResponse)
      .filter((fr): fr is NonNullable<typeof fr> => Boolean(fr && fr.name))) {
      let id = typeof fr.id === "string" ? fr.id : "";
      if (!id) {
        const idx = openCalls.findIndex((c) => c.name === fr.name);
        id = idx >= 0 ? openCalls[idx].id : openCalls[openCalls.length - 1]?.id || "";
      }
      const matchIdx = openCalls.findIndex((c) => c.id === id && id !== "");
      if (matchIdx < 0) continue;
      openCalls.splice(matchIdx, 1);
      blocks.push({
        type: "tool_result",
        tool_use_id: id,
        content: JSON.stringify(fr.response ?? {}),
      });
    }
    const text = parts
      .filter((p) => typeof p.text === "string" && !p.thought)
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    if (text) blocks.push({ type: "text", text });
    push("user", blocks);
  }

  while (messages.length > 0 && messages[0].role !== "user") messages.shift();
  return messages;
}

// ---------------------------------------------------------------------------
// Google Adapter (Native Gemini REST v1beta)
// ---------------------------------------------------------------------------

async function callGoogleAdapter(input: AdapterCallInput): Promise<AdapterCallOutput> {
  const { cfg, timeoutMs } = input;
  const base = (cfg.baseUrl?.trim() || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const cleanModel = cfg.model.trim().replace(/^models\//i, "");
  const url = `${base}/models/${encodeURIComponent(cleanModel)}:generateContent?key=${encodeURIComponent(cfg.apiKey.trim())}`;

  const schemaAppendix =
    input.responseFormat === "json" && input.schema && input.useGrounding
      ? `\n\nReturn ONLY a valid JSON object matching:\n${JSON.stringify(schemaToJsonSchema(input.schema))}`
      : "";
  const sysText = [input.systemPrompt?.trim(), schemaAppendix].filter(Boolean).join("\n").trim();

  const contents =
    input.agentContents && input.agentContents.length > 0
      ? input.agentContents
      : input.messages
          .filter((m) => m.role !== "system")
          .map((m) => {
            const msgParts: Record<string, unknown>[] = [
              { text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) },
            ];
            for (const img of m.images ?? []) {
              if (img.dataBase64 && img.mimeType) {
                msgParts.push({
                  inlineData: {
                    mimeType: img.mimeType,
                    data: img.dataBase64,
                  },
                });
              }
            }
            return {
              role: m.role === "assistant" ? "model" : "user",
              parts: msgParts,
            };
          });

  const genConfig: Record<string, unknown> = {};
  if (typeof input.temperature === "number") genConfig.temperature = input.temperature;
  if (typeof input.maxTokens === "number" && input.maxTokens > 0) {
    genConfig.maxOutputTokens = input.maxTokens;
  }
  if (input.responseFormat === "json" && !input.useGrounding) {
    genConfig.responseMimeType = "application/json";
    if (input.schema) genConfig.responseSchema = input.schema;
  }

  const body: Record<string, unknown> = {
    contents,
    generationConfig: genConfig,
  };
  if (sysText) {
    body.systemInstruction = { parts: [{ text: sysText }] };
  }

  const toolsList: Record<string, unknown>[] = [];
  if (input.useGrounding) toolsList.push({ googleSearch: {} });
  if (input.tools && input.tools.length > 0) {
    toolsList.push({ functionDeclarations: input.tools });
  }
  if (toolsList.length > 0) body.tools = toolsList;

  const { res, raw, parsed } = await fetchWithDeadline(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    timeoutMs ?? (input.useGrounding ? GROUNDED_ATTEMPT_TIMEOUT_MS : DEFAULT_ATTEMPT_TIMEOUT_MS),
  );

  if (!res.ok) {
    throw classifyHttpFailure(res, raw, parsed);
  }

  const candidate = (Array.isArray(parsed?.candidates) ? parsed.candidates[0] : null) as
    | {
        content?: AgentContent;
        groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] };
      }
    | null;
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];

  const functionCalls: AgentFunctionCall[] = parts
    .map((p) => p.functionCall)
    .filter((fc): fc is AgentFunctionCall => Boolean(fc && fc.name));

  const text = parts
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text ?? "")
    .join("")
    .trim();

  if (!text && functionCalls.length === 0) {
    throw new GatewayProviderError("Google Gemini returned an empty response.", {
      status: 502,
      retryable: true,
    });
  }

  const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  const groundingUrls = chunks
    .map((c) => c.web)
    .filter((w): w is { uri: string; title?: string } => Boolean(w?.uri))
    .map((w) => ({ uri: w.uri, title: w.title ?? w.uri }));

  const modelContent: AgentContent =
    candidate?.content && parts.length > 0
      ? candidate.content
      : {
          role: "model",
          parts: [
            ...(text ? [{ text }] : []),
            ...functionCalls.map((fc) => ({ functionCall: fc })),
          ],
        };

  return {
    text,
    functionCalls,
    modelContent,
    groundingUrls,
    grounded: Boolean(input.useGrounding && groundingUrls.length > 0),
  };
}

// ---------------------------------------------------------------------------
// OpenAI-Compatible Adapter (NVIDIA NIM, Z.ai, Cloudflare, OpenRouter, Groq, Cerebras, OpenAI, Custom)
// ---------------------------------------------------------------------------

async function callOpenAICompatAdapter(
  input: AdapterCallInput,
  forceNoJsonFormat = false,
): Promise<AdapterCallOutput> {
  const { cfg } = input;
  const { baseUrl, bearer } = resolveEndpointUrl(cfg);
  const { provider } = normalizeGatewayProviderId(cfg.provider);
  const isCloudflare = provider === "cloudflare";

  const schemaAppendix =
    input.responseFormat === "json"
      ? input.schema
        ? `\n\nReturn ONLY one valid JSON object matching this schema (no markdown fences, no commentary):\n${JSON.stringify(
            schemaToJsonSchema(input.schema),
          )}`
        : "\n\nReturn ONLY one valid JSON object (no markdown fences, no commentary)."
      : "";
  const sysText = [input.systemPrompt?.trim(), schemaAppendix].filter(Boolean).join("\n").trim();

  const wireMessages: Record<string, unknown>[] = [];
  if (sysText) wireMessages.push({ role: "system", content: sysText });

  if (input.agentContents && input.agentContents.length > 0) {
    wireMessages.push(...agentContentsToOpenAI(input.agentContents));
  } else {
    for (const m of input.messages) {
      if (m.role === "system") continue;
      const textContent = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      const contentPayload =
        !isCloudflare && m.images && m.images.length > 0
          ? [
              { type: "text", text: textContent },
              ...m.images
                .filter((img) => img.dataBase64 && img.mimeType)
                .map((img) => ({
                  type: "image_url",
                  image_url: { url: `data:${img.mimeType};base64,${img.dataBase64}` },
                })),
            ]
          : isCloudflare && typeof m.content !== "string"
            ? JSON.stringify(m.content ?? "")
            : m.content;
      wireMessages.push({
        role: m.role,
        content: contentPayload,
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      });
    }
  }

  const body: Record<string, unknown> = {
    model: cfg.model.trim(),
    messages: wireMessages,
    stream: false,
  };
  if (typeof input.temperature === "number") body.temperature = input.temperature;
  if (typeof input.maxTokens === "number" && input.maxTokens > 0) {
    if (usesMaxCompletionTokens(cfg.model)) {
      body.max_completion_tokens = input.maxTokens;
    } else {
      body.max_tokens = input.maxTokens;
    }
  }
  if (input.responseFormat === "json" && !forceNoJsonFormat && !isCloudflare) {
    body.response_format = { type: "json_object" };
  }
  if (input.tools && input.tools.length > 0) {
    body.tools = input.tools
      .filter((t) => Boolean(t.name))
      .map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description ?? "",
          parameters: schemaToJsonSchema(t.parameters),
        },
      }));
    body.tool_choice = "auto";
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
  };
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = process.env.NEXT_PUBLIC_APP_URL || "https://knowrevo.app";
    headers["X-Title"] = "Knowrevo";
  }

  const url = `${baseUrl}/chat/completions`;
  let { res, raw, parsed } = await fetchWithDeadline(
    url,
    { method: "POST", headers, body: JSON.stringify(body) },
    input.timeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
  );

  // Z.ai dual-host fallback (global api.z.ai vs domestic open.bigmodel.cn)
  if (provider === "zai" && (res.status === 401 || res.status === 403) && !cfg.baseUrl?.trim()) {
    const altBase = baseUrl === ZAI_GLOBAL_URL ? ZAI_DOMESTIC_URL : ZAI_GLOBAL_URL;
    const alt = await fetchWithDeadline(
      `${altBase}/chat/completions`,
      { method: "POST", headers, body: JSON.stringify(body) },
      input.timeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
    );
    if (alt.res.ok) {
      zaiHostCache.set(bearer, altBase);
      res = alt.res;
      raw = alt.raw;
      parsed = alt.parsed;
    }
  }

  // Fallback retry without response_format if endpoint rejected json_object with 400
  if (
    !res.ok &&
    res.status === 400 &&
    !forceNoJsonFormat &&
    body.response_format &&
    /response_format|json_object|json mode/i.test(raw)
  ) {
    return callOpenAICompatAdapter(input, true);
  }

  // Fallback swap max_tokens -> max_completion_tokens if rejected on OpenAI/compat reasoning endpoint
  if (
    !res.ok &&
    res.status === 400 &&
    body.max_tokens &&
    /max_tokens.*max_completion_tokens|unsupported_parameter/i.test(raw)
  ) {
    const val = body.max_tokens;
    delete body.max_tokens;
    body.max_completion_tokens = val;
    const retried = await fetchWithDeadline(
      url,
      { method: "POST", headers, body: JSON.stringify(body) },
      input.timeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
    );
    res = retried.res;
    raw = retried.raw;
    parsed = retried.parsed;
  }

  if (!res.ok) {
    throw classifyHttpFailure(res, raw, parsed);
  }

  const choice = Array.isArray(parsed?.choices)
    ? (parsed.choices[0] as { message?: { content?: unknown; tool_calls?: unknown[] } } | undefined)
    : undefined;
  const msg = choice?.message;

  let text = "";
  if (typeof msg?.content === "string") {
    text = stripThinkTags(msg.content);
  } else if (Array.isArray(msg?.content)) {
    text = stripThinkTags(
      (msg.content as { text?: unknown }[]).map((p) => (typeof p?.text === "string" ? p.text : "")).join(""),
    );
  }

  const rawCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
  const functionCalls: AgentFunctionCall[] = rawCalls.map((c, idx) => {
    const rec = c as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    let args: Record<string, unknown> = {};
    if (typeof rec.function?.arguments === "string") {
      try {
        args = JSON.parse(rec.function.arguments) as Record<string, unknown>;
      } catch {
        args = { raw: rec.function.arguments };
      }
    } else if (rec.function?.arguments && typeof rec.function.arguments === "object") {
      args = rec.function.arguments as Record<string, unknown>;
    }
    return {
      id: typeof rec.id === "string" && rec.id ? rec.id : `call_${idx}`,
      name: typeof rec.function?.name === "string" ? rec.function.name : "tool",
      args,
    };
  });

  if (!text && functionCalls.length === 0) {
    throw new GatewayProviderError("Provider returned empty or reasoning-only completion.", {
      status: 502,
      retryable: true,
    });
  }

  const modelContent: AgentContent = {
    role: "model",
    parts: [
      ...(text ? [{ text }] : []),
      ...functionCalls.map((fc) => ({ functionCall: fc })),
    ],
  };

  return {
    text,
    functionCalls,
    modelContent,
    groundingUrls: [],
    grounded: false,
  };
}

// ---------------------------------------------------------------------------
// Anthropic Adapter
// ---------------------------------------------------------------------------

async function callAnthropicAdapter(input: AdapterCallInput): Promise<AdapterCallOutput> {
  const { cfg } = input;
  const base = (cfg.baseUrl?.trim() || "https://api.anthropic.com").replace(/\/+$/, "");

  const schemaAppendix =
    input.responseFormat === "json"
      ? input.schema
        ? `\n\nReturn ONLY one valid JSON object matching:\n${JSON.stringify(schemaToJsonSchema(input.schema))}`
        : "\n\nReturn ONLY one valid JSON object."
      : "";
  const system = [input.systemPrompt?.trim(), schemaAppendix].filter(Boolean).join("\n").trim();

  const wireMessages =
    input.agentContents && input.agentContents.length > 0
      ? agentContentsToAnthropic(input.agentContents)
      : input.messages
          .filter((m) => m.role !== "system")
          .map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
          }));

  const body: Record<string, unknown> = {
    model: cfg.model.trim(),
    max_tokens: input.maxTokens && input.maxTokens > 0 ? input.maxTokens : 4096,
    messages: wireMessages,
  };
  if (system) body.system = system;
  if (typeof input.temperature === "number") body.temperature = input.temperature;
  if (input.tools && input.tools.length > 0) {
    body.tools = input.tools
      .filter((t) => Boolean(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description ?? "",
        input_schema: schemaToJsonSchema(t.parameters),
      }));
    body.tool_choice = { type: "auto" };
  }

  const { res, raw, parsed } = await fetchWithDeadline(
    `${base}/v1/messages`,
    {
      method: "POST",
      headers: {
        "x-api-key": cfg.apiKey.trim(),
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    input.timeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
  );

  if (!res.ok) {
    throw classifyHttpFailure(res, raw, parsed);
  }

  const blocks = Array.isArray(parsed?.content) ? (parsed.content as Record<string, unknown>[]) : [];
  const text = blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => String(b.text))
    .join("")
    .trim();
  const functionCalls: AgentFunctionCall[] = blocks
    .filter((b) => b.type === "tool_use" && typeof b.name === "string")
    .map((b, idx) => ({
      id: typeof b.id === "string" ? b.id : `toolu_${idx}`,
      name: String(b.name),
      args: b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {},
    }));

  if (!text && functionCalls.length === 0) {
    throw new GatewayProviderError("Anthropic returned an empty completion.", {
      status: 502,
      retryable: true,
    });
  }

  const modelContent: AgentContent = {
    role: "model",
    parts: [
      ...(text ? [{ text }] : []),
      ...functionCalls.map((fc) => ({ functionCall: fc })),
    ],
  };

  return {
    text,
    functionCalls,
    modelContent,
    groundingUrls: [],
    grounded: false,
  };
}

export async function dispatchProviderCall(input: AdapterCallInput): Promise<AdapterCallOutput> {
  const { provider } = normalizeGatewayProviderId(input.cfg.provider);
  const meta = getProviderMeta(provider);
  if (meta.style === "google") {
    return callGoogleAdapter(input);
  }
  if (meta.style === "anthropic") {
    return callAnthropicAdapter(input);
  }
  return callOpenAICompatAdapter(input);
}

// ---------------------------------------------------------------------------
// Dynamic Model Discovery (/models) + Key Verification Probe
// ---------------------------------------------------------------------------

function inferSeatsFromModelId(id: string): TaskSeat[] {
  if (isSlowMegaModel(id)) return ["smart"];
  const lower = id.toLowerCase();
  if (/8b|7b|3b|mini|nano|instant|flash-lite|4-flash/.test(lower)) return ["fast", "balanced"];
  if (/r1|pro|70b|72b|120b|405b|opus|sonnet|v3|reasoner|glm4\.7|glm-4\.7/.test(lower)) {
    return ["smart", "balanced"];
  }
  return ["balanced", "smart", "fast"];
}

export async function fetchProviderCatalogModels(cfg: {
  provider: GatewayProviderId;
  apiKey: string;
  accountId?: string | null;
  baseUrl?: string | null;
  freeTierOnly?: boolean;
}): Promise<GatewayModelConfig[]> {
  const meta = getProviderMeta(cfg.provider);
  if (meta.style === "cloudflare") {
    return meta.defaultModels;
  }

  if (meta.style === "google") {
    const base = (cfg.baseUrl?.trim() || meta.baseUrl).replace(/\/+$/, "");
    const { res, raw, parsed } = await fetchWithDeadline(
      `${base}/models?key=${encodeURIComponent(cfg.apiKey.trim())}`,
      { headers: { Accept: "application/json" } },
      12_000,
    );
    if (!res.ok) throw classifyHttpFailure(res, raw, parsed);

    const nonChat = /embedding|imagen|veo|lyria|aqa|tts|whisper/i;
    const rawModels = Array.isArray(parsed?.models) ? (parsed.models as Record<string, unknown>[]) : [];
    const list: GatewayModelConfig[] = [];
    for (const m of rawModels) {
      const methods = Array.isArray(m.supportedGenerationMethods)
        ? m.supportedGenerationMethods.map(String)
        : [];
      if (methods.length > 0 && !methods.includes("generateContent")) continue;
      const id = String(m.name ?? "").replace(/^models\//i, "");
      if (!id || nonChat.test(id)) continue;
      list.push({
        id,
        displayName: String(m.displayName || id),
        enabled: true,
        seats: inferSeatsFromModelId(id),
        capabilities: {
          json: true,
          tools: !id.includes("gemma"),
          vision: true,
          reasoning: /2\.5|3\.|thinking/i.test(id),
          grounding: !id.includes("gemma"),
        },
        isFreeTier: true,
      });
    }
    return list.length > 0 ? list : meta.defaultModels;
  }

  if (meta.style === "anthropic") {
    const base = (cfg.baseUrl?.trim() || meta.baseUrl).replace(/\/+$/, "");
    const { res, raw, parsed } = await fetchWithDeadline(
      `${base}/v1/models?limit=100`,
      {
        headers: {
          "x-api-key": cfg.apiKey.trim(),
          "anthropic-version": "2023-06-01",
          Accept: "application/json",
        },
      },
      12_000,
    );
    if (!res.ok) throw classifyHttpFailure(res, raw, parsed);
    const items = Array.isArray(parsed?.data) ? (parsed.data as Record<string, unknown>[]) : [];
    const list: GatewayModelConfig[] = items
      .map((m) => {
        const id = String(m.id ?? "");
        return {
          id,
          displayName: String(m.display_name || id),
          enabled: true,
          seats: inferSeatsFromModelId(id),
          capabilities: { json: true, tools: true, vision: true, reasoning: /sonnet|opus/i.test(id) },
        };
      })
      .filter((m) => Boolean(m.id));
    return list.length > 0 ? list : meta.defaultModels;
  }

  // OpenAI-compatible & Z.ai
  const resolved = resolveEndpointUrl({
    provider: cfg.provider,
    model: "",
    apiKey: cfg.apiKey,
    accountId: cfg.accountId,
    baseUrl: cfg.baseUrl,
  });

  let { res, raw, parsed } = await fetchWithDeadline(
    `${resolved.baseUrl}/models`,
    { headers: { Authorization: `Bearer ${resolved.bearer}`, Accept: "application/json" } },
    12_000,
  );

  if (cfg.provider === "zai" && (res.status === 401 || res.status === 403) && !cfg.baseUrl?.trim()) {
    const altBase = resolved.baseUrl === ZAI_GLOBAL_URL ? ZAI_DOMESTIC_URL : ZAI_GLOBAL_URL;
    const alt = await fetchWithDeadline(
      `${altBase}/models`,
      { headers: { Authorization: `Bearer ${resolved.bearer}`, Accept: "application/json" } },
      12_000,
    );
    if (alt.res.ok) {
      zaiHostCache.set(resolved.bearer, altBase);
      res = alt.res;
      raw = alt.raw;
      parsed = alt.parsed;
    }
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw classifyHttpFailure(res, raw, parsed);
    }
    return meta.defaultModels;
  }

  const nonChat =
    /(embed|embedding|whisper|tts|dall-e|moderation|rerank|transcribe|audio|sora|image|flux|babbage|davinci|curie|ada\b|guard|safety)/i;
  const rows = Array.isArray(parsed?.data) ? (parsed.data as Record<string, unknown>[]) : [];
  let models: GatewayModelConfig[] = rows
    .map((r) => {
      const id = String(r.id ?? r.name ?? "").trim();
      const isFree = cfg.provider === "openrouter" ? id.endsWith(":free") : meta.freeTierDefault;
      return {
        id,
        displayName: String(r.name || id),
        enabled: true,
        seats: inferSeatsFromModelId(id),
        capabilities: {
          json: true,
          tools: !/deepseek-r1|qwq|reasoner/i.test(id),
          vision: /vision|vl\b|gemma-3|llama-4|gpt-4o|gpt-4\.1|claude/i.test(id),
          reasoning: /r1|reasoner|glm4\.7|glm-4\.7|qwq|think/i.test(id),
        },
        isFreeTier: isFree,
      };
    })
    .filter((m) => Boolean(m.id) && !nonChat.test(m.id) && !/nemotron-3-ultra-550b|550b/i.test(m.id));

  if (cfg.provider === "openrouter" && cfg.freeTierOnly) {
    const freeOnly = models.filter((m) => m.id.endsWith(":free"));
    if (freeOnly.length > 0) models = freeOnly;
  }

  models.sort((a, b) => a.id.localeCompare(b.id));
  return models.length > 0 ? models : meta.defaultModels;
}
