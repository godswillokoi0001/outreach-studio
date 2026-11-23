import type { AiConfig, AiModelOption, AiProviderId, AiProviderMeta } from "./types";

export const AI_PROVIDERS: AiProviderMeta[] = [
  {
    id: "gemini",
    label: "Google Gemini",
    blurb: "Gemini Flash and Pro models from Google AI Studio, including Google Search grounding.",
    style: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    modelsPath: "/models",
    keyPrefixes: ["AIza"],
    docsUrl: "https://aistudio.google.com/apikey",
    docsLabel: "Google AI Studio",
    defaultModel: "gemini-3.5-flash",
  },
  {
    id: "openai",
    label: "OpenAI",
    blurb: "GPT models from platform.openai.com, including the mini and reasoning families.",
    style: "openai",
    baseUrl: "https://api.openai.com/v1",
    modelsPath: "/models",
    keyPrefixes: ["sk-proj-", "sk-"],
    docsUrl: "https://platform.openai.com/api-keys",
    docsLabel: "OpenAI dashboard",
    defaultModel: "gpt-4o-mini",
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    blurb: "Claude Sonnet, Opus and Haiku models from console.anthropic.com.",
    style: "anthropic",
    baseUrl: "https://api.anthropic.com",
    modelsPath: "/v1/models",
    keyPrefixes: ["sk-ant-"],
    docsUrl: "https://console.anthropic.com/settings/keys",
    docsLabel: "Anthropic console",
    defaultModel: "claude-sonnet-4-5",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    blurb: "One key for hundreds of models across every major provider.",
    style: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    modelsPath: "/models",
    keyPrefixes: ["sk-or-"],
    docsUrl: "https://openrouter.ai/keys",
    docsLabel: "OpenRouter keys",
    defaultModel: "openai/gpt-4o-mini",
  },
  {
    id: "groq",
    label: "Groq",
    blurb: "Very fast Llama, Qwen and Kimi inference on GroqCloud.",
    style: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    modelsPath: "/models",
    keyPrefixes: ["gsk_"],
    docsUrl: "https://console.groq.com/keys",
    docsLabel: "GroqCloud console",
    defaultModel: "llama-3.3-70b-versatile",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    blurb: "DeepSeek chat and reasoning models with an OpenAI-compatible API.",
    style: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    modelsPath: "/models",
    keyPrefixes: ["sk-"],
    docsUrl: "https://platform.deepseek.com/api_keys",
    docsLabel: "DeepSeek platform",
    defaultModel: "deepseek-chat",
  },
  {
    id: "mistral",
    label: "Mistral AI",
    blurb: "Mistral and Codestral models from the Mistral La Plateforme console.",
    style: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    modelsPath: "/models",
    keyPrefixes: [],
    docsUrl: "https://console.mistral.ai/api-keys",
    docsLabel: "Mistral console",
    defaultModel: "mistral-small-latest",
  },
  {
    id: "xai",
    label: "xAI Grok",
    blurb: "Grok models from the xAI console.",
    style: "openai",
    baseUrl: "https://api.x.ai/v1",
    modelsPath: "/models",
    keyPrefixes: ["xai-"],
    docsUrl: "https://console.x.ai",
    docsLabel: "xAI console",
    defaultModel: "grok-4",
  },
  {
    id: "together",
    label: "Together AI",
    blurb: "Open-weight models hosted on Together AI.",
    style: "openai",
    baseUrl: "https://api.together.xyz/v1",
    modelsPath: "/models",
    keyPrefixes: [],
    docsUrl: "https://api.together.ai/settings/api-keys",
    docsLabel: "Together AI keys",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    blurb: "Fast open-weight inference from Fireworks AI.",
    style: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    modelsPath: "/models",
    keyPrefixes: ["fw_"],
    docsUrl: "https://fireworks.ai/account/api-keys",
    docsLabel: "Fireworks account",
    defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
  },
  {
    id: "perplexity",
    label: "Perplexity",
    blurb: "Sonar models with built-in live web search.",
    style: "openai",
    baseUrl: "https://api.perplexity.ai",
    modelsPath: "",
    keyPrefixes: ["pplx-"],
    docsUrl: "https://www.perplexity.ai/settings/api",
    docsLabel: "Perplexity API settings",
    defaultModel: "sonar-pro",
    staticModels: [
      { id: "sonar-pro", label: "Sonar Pro" },
      { id: "sonar", label: "Sonar" },
      { id: "sonar-reasoning-pro", label: "Sonar Reasoning Pro" },
      { id: "sonar-reasoning", label: "Sonar Reasoning" },
    ],
  },
  {
    id: "numes",
    label: "Numes",
    blurb: "OpenAI-compatible access to Numes model catalogue.",
    style: "openai",
    baseUrl: "https://api.numes.ai/v1",
    modelsPath: "/models",
    keyPrefixes: ["sk-numes-v1-"],
    docsUrl: "https://api.numes.ai",
    docsLabel: "Numes API",
    defaultModel: "",
  },
  {
    id: "custom",
    label: "Custom / self-hosted",
    blurb: "Any OpenAI-compatible endpoint: Azure-compatible gateways, Ollama, vLLM, LiteLLM and more.",
    style: "openai",
    baseUrl: "",
    modelsPath: "/models",
    keyPrefixes: [],
    docsUrl: "",
    docsLabel: "OpenAI-compatible API",
    defaultModel: "",
    requiresBaseUrl: true,
  },
];

const BY_ID = new Map<AiProviderId, AiProviderMeta>(AI_PROVIDERS.map((p) => [p.id, p]));

export function getProvider(id: string | undefined): AiProviderMeta | null {
  if (!id) return null;
  return BY_ID.get(id.trim().toLowerCase() as AiProviderId) ?? null;
}

export function isProviderId(value: unknown): value is AiProviderId {
  return typeof value === "string" && BY_ID.has(value.trim().toLowerCase() as AiProviderId);
}

export function providerBaseUrl(cfg: AiConfig): string {
  const meta = getProvider(cfg.provider);
  const raw = (cfg.baseUrl && cfg.baseUrl.trim()) || meta?.baseUrl || "";
  return raw.replace(/\/+$/, "");
}

/**
 * Reads the provider from a key's shape so a pasted key needs no manual setup.
 * Returns the full provider id when the pattern is unambiguous.
 */
export function guessProviderId(rawKey: string): AiProviderId | null {
  const key = rawKey.trim();
  if (!key) return null;
  if (/^AIza[0-9A-Za-z_-]{20,}$/.test(key)) return "gemini";
  if (key.startsWith("sk-ant-")) return "anthropic";
  if (key.startsWith("sk-or-")) return "openrouter";
  if (key.startsWith("gsk_")) return "groq";
  if (key.startsWith("xai-")) return "xai";
  if (key.startsWith("pplx-")) return "perplexity";
  if (key.startsWith("fw_")) return "fireworks";
  if (key.startsWith("sk-numes-v1-")) return "numes";
  if (key.startsWith("sk-proj-")) return "openai";
  if (key.startsWith("sk-")) return "openai";
  return null;
}

/**
 * Chooses a sensible default model for a provider from the ids it actually
 * served, so "auto-detect" lands on something that works instead of the first
 * alphabetically sorted id.
 */
export function pickRecommendedModel(meta: AiProviderMeta, models: AiModelOption[]): string {
  if (models.length === 0) return meta.defaultModel;
  const ids = models.map((m) => m.id);
  const preferred: Record<string, string[]> = {
    gemini: ["gemini-3.5-flash", "gemini-3.6-flash", "gemini-2.5-flash", "gemini-flash", "gemini"],
    openai: ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4o", "gpt-4.1", "gpt-5"],
    anthropic: ["claude-sonnet-4-5", "claude-sonnet-4", "claude-3-7-sonnet", "claude-3-5-sonnet", "claude"],
    openrouter: ["openai/gpt-4o-mini", "anthropic/claude-sonnet-4", "google/gemini", "meta-llama/llama-3.3-70b"],
    groq: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "llama"],
    deepseek: ["deepseek-chat", "deepseek-reasoner"],
    mistral: ["mistral-small-latest", "mistral-large-latest", "mistral"],
    xai: ["grok-4", "grok-3", "grok"],
    together: ["llama-3.3-70b", "llama"],
    fireworks: ["llama-v3p3-70b", "llama"],
    perplexity: ["sonar-pro", "sonar"],
    numes: ["gpt-4o-mini", "gpt-4.1-mini", "claude", "gemini", "llama", "qwen", "deepseek", "chat"],
    custom: [],
  };
  for (const needle of preferred[meta.id] ?? []) {
    const found = ids.find((id) => id.toLowerCase().includes(needle.toLowerCase()));
    if (found) return found;
  }
  return ids[0];
}

export function publicProviderList() {
  return AI_PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    blurb: p.blurb,
    baseUrl: p.baseUrl,
    requiresBaseUrl: Boolean(p.requiresBaseUrl),
    docsUrl: p.docsUrl,
    docsLabel: p.docsLabel,
    defaultModel: p.defaultModel,
    keyPrefixes: p.keyPrefixes,
  }));
}
