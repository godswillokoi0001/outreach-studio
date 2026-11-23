import type { FunctionDeclaration, Schema } from "@google/genai";
import type { AgentContent, AgentFunctionCall } from "../agent-meta";
import { getProvider, pickRecommendedModel, providerBaseUrl } from "./registry";
import { AiProviderError, type AiConfig, type AiModelOption } from "./types";

const REQUEST_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 30_000;

interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

interface ChatTurn {
  text: string;
  calls: ToolCall[];
}

interface ChatOptions {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  /** Pre-built Anthropic block history for tool conversations. */
  rawMessages?: { role: "user" | "assistant"; content: unknown[] }[];
  model: string;
  tools?: FunctionDeclaration[];
  /** Ask for a JSON-object response. */
  json?: boolean;
  schema?: Schema;
  maxTokens?: number;
  timeoutMs?: number;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    const raw = await res.text();
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }

    if (!res.ok) {
      const obj = (parsed ?? {}) as { error?: { message?: unknown; type?: unknown }; message?: unknown };
      const detail =
        str(obj.error?.message) || str(obj.message) || raw.slice(0, 300) || `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) {
        throw new AiProviderError(
          `The API key was rejected by the provider (HTTP ${res.status}). Check that the key is active and belongs to this provider. ${detail}`.trim(),
          res.status,
        );
      }
      if (res.status === 404) {
        throw new AiProviderError(
          `The provider could not find that endpoint or model (HTTP 404). ${detail}`.trim(),
          404,
        );
      }
      if (res.status === 429) {
        throw new AiProviderError(
          `The provider is rate-limiting this key (HTTP 429). Wait a moment, pick a cheaper model, or add billing to the key. ${detail}`.trim(),
          429,
        );
      }
      throw new AiProviderError(detail, res.status);
    }

    if (!parsed) {
      throw new AiProviderError("The AI provider returned an empty or non-JSON response.", 502);
    }
    return parsed;
  } catch (err) {
    if (err instanceof AiProviderError) throw err;
    const name = err instanceof Error ? err.name : "";
    if (name === "AbortError") {
      throw new AiProviderError("The AI provider took too long to respond. Try again or pick a faster model.", 504);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new AiProviderError(`Could not reach the AI provider: ${msg}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url: string, headers: Record<string, string>, timeoutMs = 20_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal, cache: "no-store" });
    const raw = await res.text();
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const obj = (parsed ?? {}) as { error?: { message?: unknown }; message?: unknown };
      const detail = str(obj.error?.message) || str(obj.message) || raw.slice(0, 300) || `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) {
        throw new AiProviderError(
          `The API key was rejected by the provider (HTTP ${res.status}). Check that the key is active. ${detail}`.trim(),
          res.status,
        );
      }
      throw new AiProviderError(detail, res.status);
    }
    return parsed ?? {};
  } catch (err) {
    if (err instanceof AiProviderError) throw err;
    const name = err instanceof Error ? err.name : "";
    if (name === "AbortError") {
      throw new AiProviderError("Timed out while listing models from the provider.", 504);
    }
    throw new AiProviderError(`Could not reach the AI provider: ${err instanceof Error ? err.message : String(err)}`, 502);
  } finally {
    clearTimeout(timer);
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
    for (const [key, value] of Object.entries(schema.properties)) {
      props[key] = schemaToJsonSchema(value);
    }
    out.properties = props;
  }
  if (!out.type && out.properties) out.type = "object";
  return out;
}

function toolsToOpenAI(tools: FunctionDeclaration[] | undefined) {
  if (!tools || tools.length === 0) return undefined;
  return tools
    .filter((tool) => Boolean(tool.name))
    .map((tool) => ({
      type: "function" as const,
      function: {
        name: str(tool.name, "tool"),
        description: str(tool.description),
        parameters: schemaToJsonSchema(tool.parameters),
      },
    }));
}

function toolsToAnthropic(tools: FunctionDeclaration[] | undefined) {
  if (!tools || tools.length === 0) return undefined;
  return tools
    .filter((tool) => Boolean(tool.name))
    .map((tool) => ({
      name: str(tool.name, "tool"),
      description: str(tool.description),
      input_schema: schemaToJsonSchema(tool.parameters),
    }));
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return { value: raw };
    }
  }
  return {};
}

/**
 * Gemini-shaped history (used by the dashboard agent) -> OpenAI messages.
 * Tool-call ids are carried through so the next round's functionResponse
 * matches the assistant call that produced it.
 */
function contentsToOpenAI(contents: AgentContent[]): Record<string, unknown>[] {
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
          openCalls.push({ id, name: str(fc.name, "tool") });
          return {
            id,
            type: "function",
            function: {
              name: str(fc.name, "tool"),
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
      const explicit = str(fr.id);
      let id = explicit;
      if (!id) {
        const idx = openCalls.findIndex((c) => c.name === fr.name);
        id = idx >= 0 ? openCalls[idx].id : openCalls.length > 0 ? openCalls[openCalls.length - 1].id : "";
      }
      const matchIdx = openCalls.findIndex((c) => c.id === id);
      if (matchIdx >= 0) openCalls.splice(matchIdx, 1);
      messages.push({
        role: "tool",
        tool_call_id: id || `call_${autoId++}`,
        content: JSON.stringify(fr.response ?? {}),
      });
    }

    const text = parts
      .filter((p) => typeof p.text === "string" && !p.thought)
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    if (text) messages.push({ role: "user", content: text });
  }

  return messages;
}

/** Gemini-shaped history -> Anthropic messages (tool_use / tool_result blocks). */
function contentsToAnthropic(contents: AgentContent[]): { role: "user" | "assistant"; content: unknown[] }[] {
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
        openCalls.push({ id, name: str(fc.name, "tool") });
        blocks.push({ type: "tool_use", id, name: str(fc.name, "tool"), input: fc.args ?? {} });
      }
      push("assistant", blocks);
      continue;
    }

    const blocks: unknown[] = [];
    for (const fr of parts
      .map((p) => p.functionResponse)
      .filter((fr): fr is NonNullable<typeof fr> => Boolean(fr && fr.name))) {
      const explicit = str(fr.id);
      let id = explicit;
      if (!id) {
        const idx = openCalls.findIndex((c) => c.name === fr.name);
        id = idx >= 0 ? openCalls[idx].id : openCalls.length > 0 ? openCalls[openCalls.length - 1].id : "";
      }
      const matchIdx = openCalls.findIndex((c) => c.id === id);
      if (matchIdx >= 0) openCalls.splice(matchIdx, 1);
      blocks.push({
        type: "tool_result",
        tool_use_id: id || `toolu_${autoId++}`,
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

async function openAIChat(cfg: AiConfig, opts: ChatOptions, useJsonMode: boolean): Promise<ChatTurn> {
  const base = providerBaseUrl(cfg);
  const schemaHint = opts.schema
    ? `\n\nReturn ONLY a single valid JSON object that matches this JSON Schema. No prose, no markdown fences:\n${JSON.stringify(
        schemaToJsonSchema(opts.schema),
      )}`
    : "\n\nReturn ONLY a single valid JSON object. No prose, no markdown fences.";
  const system = useJsonMode ? `${opts.system}${schemaHint}` : opts.system;

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: [{ role: "system", content: system }, ...opts.messages],
    stream: false,
  };
  const tools = toolsToOpenAI(opts.tools);
  if (tools) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  if (useJsonMode) body.response_format = { type: "json_object" };

  const json = (await postJson(
    `${base}/chat/completions`,
    { Authorization: `Bearer ${cfg.apiKey}` },
    body,
    opts.timeoutMs,
  )) as {
    choices?: {
      message?: {
        content?: unknown;
        tool_calls?: { id?: unknown; function?: { name?: unknown; arguments?: unknown } }[];
      };
    }[];
  };

  const message = json.choices?.[0]?.message;
  let text = "";
  if (typeof message?.content === "string") {
    text = message.content;
  } else if (Array.isArray(message?.content)) {
    text = (message.content as { text?: unknown }[])
      .map((part) => str(part?.text))
      .join("");
  }

  const calls: ToolCall[] = Array.isArray(message?.tool_calls)
    ? message.tool_calls.map((call, idx) => ({
        id: str(call?.id) || `call_${idx}`,
        name: str(call?.function?.name, "tool"),
        args: parseJsonObject(call?.function?.arguments),
      }))
    : [];

  return { text: text.trim(), calls };
}

async function anthropicChat(cfg: AiConfig, opts: ChatOptions): Promise<ChatTurn> {
  const base = providerBaseUrl(cfg);
  const schemaHint = opts.schema
    ? `\n\nReturn ONLY a single valid JSON object that matches this JSON Schema. No prose, no markdown fences:\n${JSON.stringify(
        schemaToJsonSchema(opts.schema),
      )}`
    : "";
  const system = opts.json ? `${opts.system}${schemaHint}` : opts.system;

  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens && opts.maxTokens > 0 ? opts.maxTokens : 4096,
    system,
    messages:
      opts.rawMessages && opts.rawMessages.length > 0
        ? opts.rawMessages
        : opts.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  const tools = toolsToAnthropic(opts.tools);
  if (tools) {
    body.tools = tools;
    body.tool_choice = { type: "auto" };
  }

  const json = (await postJson(
    `${base}/v1/messages`,
    { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
    body,
    opts.timeoutMs,
  )) as {
    content?: { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown }[];
  };

  const blocks = Array.isArray(json.content) ? json.content : [];
  const text = blocks
    .filter((b) => str(b?.type) === "text")
    .map((b) => str(b?.text))
    .join("")
    .trim();
  const calls: ToolCall[] = blocks
    .filter((b) => str(b?.type) === "tool_use")
    .map((b, idx) => ({
      id: str(b?.id) || `toolu_${idx}`,
      name: str(b?.name, "tool"),
      args: parseJsonObject(b?.input),
    }));

  return { text, calls };
}

/** Gemini native REST call, used only for key probes/validation. */
async function geminiProbeChat(cfg: AiConfig, opts: ChatOptions): Promise<ChatTurn> {
  const base = providerBaseUrl(cfg);
  const url = `${base}/models/${encodeURIComponent(opts.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const json = (await postJson(
    url,
    {},
    {
      systemInstruction: { parts: [{ text: opts.system }] },
      contents: opts.messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
    },
    opts.timeoutMs,
  )) as { candidates?: { content?: { parts?: { text?: unknown }[] } }[] };

  const text = (json.candidates?.[0]?.content?.parts ?? [])
    .map((p) => str(p?.text))
    .join("")
    .trim();
  return { text, calls: [] };
}

export function parseJsonLoose<T>(text: string): T {
  const cleaned = text
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
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
    throw new AiProviderError("The AI model returned a response that was not valid JSON. Try again or pick a stronger model.", 502);
  }
}

/** Live model catalogue for the configured provider. */
export async function listProviderModels(cfg: AiConfig): Promise<AiModelOption[]> {
  const meta = getProvider(cfg.provider);
  if (!meta) throw new AiProviderError("Unknown AI provider.", 400);
  if (meta.staticModels && meta.staticModels.length > 0) return meta.staticModels;

  const base = providerBaseUrl(cfg);
  const path = meta.modelsPath || "/models";

  if (meta.style === "gemini") {
    const json = (await getJson(`${base}${path}?key=${encodeURIComponent(cfg.apiKey)}&pageSize=200`, {})) as {
      models?: { name?: unknown; displayName?: unknown; supportedGenerationMethods?: unknown }[];
    };
    const nonChat =
      /(embedding|aqa|deep-research|image|imagen|veo|tts|transcribe|learnlm|computer-use|robotics|nano-banana|antigravity)/i;
    const models = (json.models ?? [])
      .filter((m) => {
        const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods.map(String) : [];
        return methods.length === 0 || methods.includes("generateContent");
      })
      .map((m) => {
        const id = str(m.name).replace(/^models\//i, "");
        const label = str(m.displayName) || id;
        return { id, label };
      })
      .filter((m) => m.id && !nonChat.test(m.id));
    return models.sort((a, b) => a.id.localeCompare(b.id));
  }

  if (meta.style === "anthropic") {
    const json = (await getJson(`${base}${path}?limit=100`, {
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    })) as { data?: { id?: unknown; display_name?: unknown }[] };
    return (json.data ?? [])
      .map((m) => ({ id: str(m.id), label: str(m.display_name) || str(m.id) }))
      .filter((m) => m.id);
  }

  const json = (await getJson(`${base}${path}`, { Authorization: `Bearer ${cfg.apiKey}` })) as {
    data?: { id?: unknown; name?: unknown }[];
  };
  const blocked =
    /(embed|embedding|whisper|tts|dall-e|dall·e|moderation|rerank|transcribe|audio|sora|image|stable-diffusion|flux|babbage|davinci|curie|ada\b|guard|safety)/i;
  return (json.data ?? [])
    .map((m) => ({ id: str(m.id) || str(m.name), label: str(m.id) || str(m.name) }))
    .filter((m) => m.id && !blocked.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Sends a tiny real completion, proving the key works and the model answers. */
export async function probeProvider(
  cfg: AiConfig,
  model: string,
): Promise<{ model: string; ms: number; reply: string }> {
  const started = Date.now();
  const opts: ChatOptions = {
    system: "You are a connectivity probe. Answer in as few tokens as possible.",
    messages: [{ role: "user", content: 'Reply with only the single word "OK".' }],
    model,
    maxTokens: 32,
    timeoutMs: PROBE_TIMEOUT_MS,
  };

  const meta = getProvider(cfg.provider);
  const style = meta?.style ?? "openai";
  const turn =
    style === "anthropic" ? await anthropicChat(cfg, opts) : style === "gemini" ? await geminiProbeChat(cfg, opts) : await openAICompatChat(cfg, opts);

  const reply = turn.text.trim();
  if (!reply && turn.calls.length === 0) {
    throw new AiProviderError("The provider accepted the key but returned no text. Try another model.", 502);
  }
  return { model, ms: Date.now() - started, reply: reply.slice(0, 120) || "(tool call)" };
}

async function openAICompatChat(cfg: AiConfig, opts: ChatOptions): Promise<ChatTurn> {
  try {
    return await openAIChat(cfg, opts, Boolean(opts.json));
  } catch (err) {
    if (
      opts.json &&
      err instanceof AiProviderError &&
      err.status === 400 &&
      /response_format|json_object|json mode|structured output/i.test(err.message)
    ) {
      return openAIChat(cfg, opts, false);
    }
    throw err;
  }
}

/**
 * Lists models and proves the key works in one call. Used the moment a key is
 * pasted, so the user only has to choose a model afterwards.
 */
export async function detectProvider(
  cfg: AiConfig,
): Promise<{
  models: AiModelOption[];
  recommendedModel: string;
  probe: { model: string; ms: number; reply: string };
  warning?: string;
}> {
  const meta = getProvider(cfg.provider);
  if (!meta) throw new AiProviderError("Unknown or unsupported AI provider.", 400);

  let models: AiModelOption[] = [];
  let listError: AiProviderError | null = null;
  try {
    models = await listProviderModels(cfg);
  } catch (err) {
    listError = err instanceof AiProviderError ? err : new AiProviderError("Could not list models.", 502);
    if (listError.status === 401 || listError.status === 403) throw listError;
  }

  if (models.length === 0) {
    models = meta.staticModels ?? [];
  }

  const preferred = [cfg.model, pickRecommendedModel(meta, models), meta.defaultModel].filter(
    (m): m is string => Boolean(m && m.trim()),
  );
  const safeExtra = models
    .map((m) => m.id)
    .filter((id) => /(flash|mini|sonnet|haiku|llama|mistral|grok|qwen|deepseek|chat|small|pro)/i.test(id))
    .filter((id) => !preferred.includes(id))
    .slice(0, 2);
  const unique = Array.from(new Set([...preferred, ...safeExtra])).slice(0, 5);

  let lastError: AiProviderError | null = null;
  const unavailable = new Set<string>();

  for (const model of unique) {
    try {
      const probe = await probeProvider(cfg, model);
      const resolvedModels = models.length > 0 ? models : [{ id: model, label: model }];
      return { models: resolvedModels, recommendedModel: model, probe };
    } catch (err) {
      lastError = err instanceof AiProviderError ? err : new AiProviderError("The key could not be verified.", 502);
      // An invalid key fails for every model, so stop immediately.
      if (lastError.status === 401 || lastError.status === 403) throw lastError;
      if (lastError.status === 404 || /no longer available|not found|does not exist/i.test(lastError.message)) {
        unavailable.add(model);
      }
    }
  }

  // A successful model listing (or a static catalogue) already proves the key is
  // accepted. Trial calls can still be rate-limited or point at retired models,
  // so report the key as connected with a warning instead of calling it invalid.
  const liveModels = models.filter((m) => !unavailable.has(m.id));
  const catalogue = liveModels.length > 0 || Boolean(meta.staticModels?.length);
  if (catalogue && lastError) {
    const fallbackModel = unique.find((m) => !unavailable.has(m)) ?? liveModels[0]?.id ?? meta.defaultModel;
    return {
      models: liveModels.length > 0 ? liveModels : meta.staticModels ?? [],
      recommendedModel: fallbackModel,
      probe: { model: fallbackModel, ms: 0, reply: "(not run)" },
      warning: `${meta.label} accepted the key and returned a model catalogue, but the trial call did not complete: ${lastError.message} Pick a different model below, then use Test connection.`,
    };
  }

  if (lastError) throw lastError;
  if (listError) throw listError;
  throw new AiProviderError("The provider key could not be verified.", 502);
}

export async function providerJSON<T>(cfg: AiConfig, options: {
  system: string;
  user: string;
  schema?: Schema;
  model?: string;
}): Promise<T> {
  const meta = getProvider(cfg.provider);
  if (!meta) throw new AiProviderError("Unknown AI provider.", 400);
  // The saved provider model wins over a stale id carried in a request body.
  const model = (cfg.model && cfg.model.trim()) || (options.model && options.model.trim()) || meta.defaultModel;
  const opts: ChatOptions = {
    system: options.system,
    messages: [{ role: "user", content: options.user }],
    model,
    json: true,
    schema: options.schema,
  };

  const turn =
    meta.style === "anthropic"
      ? await anthropicChat(cfg, opts)
      : await openAICompatChat(cfg, opts);

  const text = turn.text.trim();
  if (!text) throw new AiProviderError("The AI provider returned an empty response. Try another model.", 502);
  return parseJsonLoose<T>(text);
}

export async function providerAgentTurn(
  cfg: AiConfig,
  options: { system: string; contents: AgentContent[]; tools: FunctionDeclaration[]; model?: string },
): Promise<{ text: string; functionCalls: AgentFunctionCall[]; modelContent: AgentContent; modelUsed: string }> {
  const meta = getProvider(cfg.provider);
  if (!meta) throw new AiProviderError("Unknown AI provider.", 400);

  // The provider's own selected model wins: the client may still hold a model id
  // from a different provider right after switching keys.
  const model = cfg.model && cfg.model.trim() ? cfg.model : options.model || meta.defaultModel;

  let turn: ChatTurn;
  if (meta.style === "anthropic") {
    turn = await anthropicChat(cfg, {
      system: options.system,
      messages: [],
      rawMessages: contentsToAnthropic(options.contents),
      model,
      tools: options.tools,
    });
  } else {
    turn = await openAICompatChat(cfg, {
      system: options.system,
      messages: contentsToOpenAI(options.contents) as unknown as ChatOptions["messages"],
      model,
      tools: options.tools,
    });
  }

  const functionCalls: AgentFunctionCall[] = turn.calls.map((call) => ({
    id: call.id,
    name: call.name,
    args: call.args,
  }));

  const modelContent: AgentContent = {
    role: "model",
    parts: [
      ...(turn.text ? [{ text: turn.text }] : []),
      ...functionCalls.map((fc) => ({ functionCall: fc })),
    ],
  };

  if (modelContent.parts.length === 0) {
    throw new AiProviderError("The AI provider returned an empty turn. Try again or pick another model.", 502);
  }

  return { text: turn.text, functionCalls, modelContent, modelUsed: model };
}
