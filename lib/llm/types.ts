export type GatewayProviderId =
  | "google"
  | "nvidia"
  | "zai"
  | "cloudflare"
  | "openrouter"
  | "groq"
  | "cerebras"
  | "anthropic"
  | "openai"
  | "custom";

export type SearchProviderId =
  | "tavily"
  | "exa"
  | "serper"
  | "firecrawl"
  | "jina"
  | "pagespeed"
  | "brave"
  | "bytemine"
  | "apollo"
  | "hunter"
  | "cufinder"
  | "snov"
  | "tomba"
  | "getprospect"
  | "cloudflare_browser"
  | "screenshotone";

export type SearchResetCycle = "monthly" | "daily" | "one_time" | "keyless";

export interface SearchProviderMeta {
  id: SearchProviderId;
  label: string;
  blurb: string;
  docsUrl: string;
  keyPrefixes: string[];
  defaultRpmLimit: number;
  defaultRpdLimit: number;
  defaultQuotaLimit: number;
  resetCycle: SearchResetCycle;
  kind: "search" | "enrichment" | "pagespeed" | "screenshot";
}

export const SEARCH_PROVIDER_CATALOG: SearchProviderMeta[] = [
  {
    id: "exa",
    label: "Exa Search",
    blurb: "Semantic web search + clean page text ($10 free credits / monthly tiers).",
    docsUrl: "https://dashboard.exa.ai/",
    keyPrefixes: [],
    defaultRpmLimit: 30,
    defaultRpdLimit: 1000,
    defaultQuotaLimit: 1000,
    resetCycle: "monthly",
    kind: "search",
  },
  {
    id: "tavily",
    label: "Tavily Search",
    blurb: "AI-ready live web search (1,000 free monthly credits, no card).",
    docsUrl: "https://app.tavily.com/",
    keyPrefixes: ["tvly-"],
    defaultRpmLimit: 30,
    defaultRpdLimit: 1000,
    defaultQuotaLimit: 1000,
    resetCycle: "monthly",
    kind: "search",
  },
  {
    id: "firecrawl",
    label: "Firecrawl",
    blurb: "Web search + JS-rendered page scraper (500 free monthly/starter credits).",
    docsUrl: "https://www.firecrawl.dev/",
    keyPrefixes: ["fc-"],
    defaultRpmLimit: 20,
    defaultRpdLimit: 500,
    defaultQuotaLimit: 500,
    resetCycle: "monthly",
    kind: "search",
  },
  {
    id: "serper",
    label: "Serper (Google SERP)",
    blurb: "Fast Google Search JSON API (2,500 one-time free queries reserve).",
    docsUrl: "https://serper.dev/",
    keyPrefixes: [],
    defaultRpmLimit: 30,
    defaultRpdLimit: 1000,
    defaultQuotaLimit: 2500,
    resetCycle: "one_time",
    kind: "search",
  },
  {
    id: "brave",
    label: "Brave Search",
    blurb: "Independent web index (free monthly tier).",
    docsUrl: "https://api.search.brave.com/",
    keyPrefixes: ["BSA"],
    defaultRpmLimit: 20,
    defaultRpdLimit: 1000,
    defaultQuotaLimit: 2000,
    resetCycle: "monthly",
    kind: "search",
  },
  {
    id: "jina",
    label: "Jina Reader",
    blurb: "Clean JS-rendered Markdown extractor (r.jina.ai works keyless at 20 RPM; key unlocks higher limits).",
    docsUrl: "https://jina.ai/reader/",
    keyPrefixes: ["jina_"],
    defaultRpmLimit: 60,
    defaultRpdLimit: 2000,
    defaultQuotaLimit: 5000,
    resetCycle: "daily",
    kind: "enrichment",
  },
  {
    id: "pagespeed",
    label: "PageSpeed Insights",
    blurb: "Real Google Lighthouse mobile performance & LCP scores (optional API key boosts daily quota).",
    docsUrl: "https://developers.google.com/speed/docs/insights/v5/get-started",
    keyPrefixes: ["AIza"],
    defaultRpmLimit: 60,
    defaultRpdLimit: 25000,
    defaultQuotaLimit: 25000,
    resetCycle: "daily",
    kind: "pagespeed",
  },
  {
    id: "bytemine",
    label: "Bytemine (100 free/mo)",
    blurb: "B2B decision-maker emails & direct dials (100 free monthly credits); runs only if $0 crawl finds nothing.",
    docsUrl: "https://bytemine.ai/",
    keyPrefixes: [],
    defaultRpmLimit: 20,
    defaultRpdLimit: 100,
    defaultQuotaLimit: 100,
    resetCycle: "monthly",
    kind: "enrichment",
  },
  {
    id: "apollo",
    label: "Apollo.io (75 free/mo)",
    blurb: "Decision-maker name, title, verified email & LinkedIn (75 free monthly credits); Layer 2 waterfall.",
    docsUrl: "https://developer.apollo.io/",
    keyPrefixes: [],
    defaultRpmLimit: 20,
    defaultRpdLimit: 75,
    defaultQuotaLimit: 75,
    resetCycle: "monthly",
    kind: "enrichment",
  },
  {
    id: "hunter",
    label: "Hunter.io (50 free/mo)",
    blurb: "Domain email finder & verification (50 free monthly credits); $0 sitemap + Exa People run first.",
    docsUrl: "https://hunter.io/api",
    keyPrefixes: [],
    defaultRpmLimit: 15,
    defaultRpdLimit: 50,
    defaultQuotaLimit: 50,
    resetCycle: "monthly",
    kind: "enrichment",
  },
  {
    id: "cufinder",
    label: "CUFinder (50 free/mo)",
    blurb: "Domain email & company contact enricher (50 free monthly credits); $0 sitemap crawler runs first.",
    docsUrl: "https://dashboard.cufinder.io/",
    keyPrefixes: [],
    defaultRpmLimit: 15,
    defaultRpdLimit: 50,
    defaultQuotaLimit: 50,
    resetCycle: "monthly",
    kind: "enrichment",
  },
  {
    id: "snov",
    label: "Snov.io (50 free/mo)",
    blurb: "Domain & decision-maker email lookup (enter clientId:clientSecret; 50 free monthly credits).",
    docsUrl: "https://snov.io/api",
    keyPrefixes: [],
    defaultRpmLimit: 15,
    defaultRpdLimit: 50,
    defaultQuotaLimit: 50,
    resetCycle: "monthly",
    kind: "enrichment",
  },
  {
    id: "tomba",
    label: "Tomba (25 free/mo)",
    blurb: "Verified domain emails & roles (enter apiKey:secretKey; 25 free monthly searches).",
    docsUrl: "https://tomba.io/api",
    keyPrefixes: [],
    defaultRpmLimit: 15,
    defaultRpdLimit: 25,
    defaultQuotaLimit: 25,
    resetCycle: "monthly",
    kind: "enrichment",
  },
  {
    id: "getprospect",
    label: "GetProspect (50 free/mo)",
    blurb: "Optional contact email finder (50 free monthly credits); runs only when Layer 1 misses.",
    docsUrl: "https://getprospect.com/",
    keyPrefixes: [],
    defaultRpmLimit: 15,
    defaultRpdLimit: 50,
    defaultQuotaLimit: 50,
    resetCycle: "monthly",
    kind: "enrichment",
  },
  {
    id: "cloudflare_browser",
    label: "Cloudflare Browser Rendering (Free)",
    blurb: "Headless Chromium mobile screenshots & rendered DOM (enter accountId:apiToken; 10 free min/day).",
    docsUrl: "https://developers.cloudflare.com/browser-rendering/",
    keyPrefixes: [],
    defaultRpmLimit: 15,
    defaultRpdLimit: 200,
    defaultQuotaLimit: 200,
    resetCycle: "daily",
    kind: "screenshot",
  },
  {
    id: "screenshotone",
    label: "ScreenshotOne (100 free/mo)",
    blurb: "Optional clean mobile webpage screenshot fallback (100 free/mo) when PageSpeed omits screenshot.",
    docsUrl: "https://screenshotone.com/",
    keyPrefixes: [],
    defaultRpmLimit: 20,
    defaultRpdLimit: 100,
    defaultQuotaLimit: 100,
    resetCycle: "monthly",
    kind: "screenshot",
  },
];

export const ALL_SEARCH_PROVIDER_IDS: SearchProviderId[] = [
  "exa",
  "tavily",
  "firecrawl",
  "serper",
  "brave",
  "jina",
  "pagespeed",
  "bytemine",
  "apollo",
  "hunter",
  "cufinder",
  "snov",
  "tomba",
  "getprospect",
  "cloudflare_browser",
  "screenshotone",
];

export function isSearchProviderId(raw: unknown): raw is SearchProviderId {
  const clean = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (ALL_SEARCH_PROVIDER_IDS as string[]).includes(clean);
}

export function getSearchProviderMeta(id: SearchProviderId): SearchProviderMeta {
  return SEARCH_PROVIDER_CATALOG.find((p) => p.id === id) ?? SEARCH_PROVIDER_CATALOG[0];
}

export function isSlowMegaModel(modelId: string): boolean {
  return /(?:550b|480b|405b|397b|235b|nemotron-3-ultra|ernie-5\.5|ernie-.*preview|step-3|trinity-large|deep-research|thinking-pro)/i.test(
    modelId.trim(),
  );
}

export function isTinyModelId(modelId: string): boolean {
  return /(?:^|[-/:_])(?:[1-9]b|8b|7b|4b|3b|2b|1b|e4b|gemma-2b|gemma-3-4b)(?:$|[-/:_.])/i.test(
    modelId.trim().toLowerCase(),
  );
}

export function getModelContextWindow(provider: GatewayProviderId, modelId: string): number {
  const clean = modelId.trim().toLowerCase();
  if (provider === "cloudflare" || clean.startsWith("@cf/")) return 24_000;
  if (provider === "google") {
    if (clean.includes("gemma")) return 32_000;
    return 1_000_000;
  }
  if (provider === "anthropic") return 200_000;
  if (provider === "cerebras") {
    if (clean.includes("8b")) return 32_000;
    return 128_000;
  }
  if (provider === "groq" || provider === "nvidia" || provider === "zai" || provider === "openai" || provider === "openrouter") {
    return 128_000;
  }
  return 64_000;
}

export type TaskSeat = "smart" | "balanced" | "fast";
export type RoutingStrategy = "balanced" | "smartest" | "fastest" | "reliable";
export type KeyHealthStatus = "healthy" | "cooldown" | "invalid";

export interface ModelCapabilities {
  json: boolean;
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  grounding?: boolean;
}

export interface GatewayModelConfig {
  id: string;
  displayName: string;
  enabled: boolean;
  seats: TaskSeat[];
  capabilities: ModelCapabilities;
  isFreeTier?: boolean;
  contextWindow?: number;
}

export interface ProviderCatalogMeta {
  id: GatewayProviderId;
  label: string;
  blurb: string;
  style: "google" | "openai_compat" | "zai" | "cloudflare" | "anthropic";
  baseUrl: string;
  modelsPath: string;
  keyPrefixes: string[];
  docsUrl: string;
  docsLabel: string;
  freeTierDefault: boolean;
  requiresAccountId?: boolean;
  requiresBaseUrl?: boolean;
  defaultRpmLimit: number;
  defaultRpdLimit: number;
  defaultModels: GatewayModelConfig[];
}

export const PROVIDER_CATALOG: ProviderCatalogMeta[] = [
  {
    id: "google",
    label: "Google AI Studio",
    blurb: "Free-tier Gemini Flash/Pro & Gemma models with native Google Search grounding.",
    style: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    modelsPath: "/models",
    keyPrefixes: ["AIza", "AQ."],
    docsUrl: "https://aistudio.google.com/apikey",
    docsLabel: "Google AI Studio",
    freeTierDefault: true,
    defaultRpmLimit: 15,
    defaultRpdLimit: 1500,
    defaultModels: [
      {
        id: "gemini-2.5-flash",
        displayName: "Gemini 2.5 Flash",
        enabled: true,
        seats: ["balanced", "fast", "smart"],
        capabilities: { json: true, tools: true, vision: true, reasoning: true, grounding: true },
        isFreeTier: true,
      },
      {
        id: "gemini-2.5-pro",
        displayName: "Gemini 2.5 Pro",
        enabled: true,
        seats: ["smart"],
        capabilities: { json: true, tools: true, vision: true, reasoning: true, grounding: true },
        isFreeTier: true,
      },
      {
        id: "gemini-2.0-flash",
        displayName: "Gemini 2.0 Flash",
        enabled: true,
        seats: ["fast", "balanced"],
        capabilities: { json: true, tools: true, vision: true, reasoning: false, grounding: true },
        isFreeTier: true,
      },
      {
        id: "gemma-3-27b-it",
        displayName: "Gemma 3 27B IT",
        enabled: true,
        seats: ["fast", "balanced"],
        capabilities: { json: true, tools: false, vision: true, reasoning: false, grounding: false },
        isFreeTier: true,
      },
    ],
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    blurb: "Free NVIDIA inference for DeepSeek R1/V3, GLM, Llama 3.3 70B & Qwen with live /models catalog.",
    style: "openai_compat",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    modelsPath: "/models",
    keyPrefixes: ["nvapi-"],
    docsUrl: "https://build.nvidia.com/",
    docsLabel: "NVIDIA Build",
    freeTierDefault: true,
    defaultRpmLimit: 40,
    defaultRpdLimit: 2000,
    defaultModels: [
      {
        id: "deepseek-ai/deepseek-v3.2",
        displayName: "DeepSeek V3.2 (NIM)",
        enabled: true,
        seats: ["smart", "balanced"],
        capabilities: { json: true, tools: true, vision: false, reasoning: true },
        isFreeTier: true,
      },
      {
        id: "meta/llama-3.3-70b-instruct",
        displayName: "Llama 3.3 70B Instruct (NIM)",
        enabled: true,
        seats: ["balanced", "smart"],
        capabilities: { json: true, tools: true, vision: false, reasoning: false },
        isFreeTier: true,
      },
      {
        id: "qwen/qwen2.5-72b-instruct",
        displayName: "Qwen 2.5 72B Instruct (NIM)",
        enabled: true,
        seats: ["smart", "balanced"],
        capabilities: { json: true, tools: true, vision: false, reasoning: false },
        isFreeTier: true,
      },
      {
        id: "z-ai/glm4.7",
        displayName: "GLM 4.7 (NIM)",
        enabled: true,
        seats: ["smart", "balanced"],
        capabilities: { json: true, tools: true, vision: false, reasoning: true },
        isFreeTier: true,
      },
    ],
  },
  {
    id: "zai",
    label: "Z.ai / Zhipu",
    blurb: "Free GLM-4.7-Flash & GLM-4-Flash across global (api.z.ai) and Zhipu endpoints.",
    style: "zai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    modelsPath: "/models",
    keyPrefixes: [],
    docsUrl: "https://z.ai/manage-apikey/apikey-list",
    docsLabel: "Z.ai Console",
    freeTierDefault: true,
    defaultRpmLimit: 20,
    defaultRpdLimit: 1000,
    defaultModels: [
      {
        id: "glm-4.5-flash",
        displayName: "GLM 4.5 Flash (Free)",
        enabled: true,
        seats: ["balanced", "fast", "smart"],
        capabilities: { json: true, tools: true, vision: false, reasoning: true },
        isFreeTier: true,
      },
      {
        id: "glm-4-flash",
        displayName: "GLM 4 Flash (Free)",
        enabled: true,
        seats: ["fast", "balanced"],
        capabilities: { json: true, tools: true, vision: false, reasoning: false },
        isFreeTier: true,
      },
    ],
  },
  {
    id: "cloudflare",
    label: "Cloudflare Workers AI",
    blurb: "10,000 free daily neurons using Account ID + API Token across fast open-weight models.",
    style: "cloudflare",
    baseUrl: "https://api.cloudflare.com/client/v4",
    modelsPath: "",
    keyPrefixes: [],
    docsUrl: "https://dash.cloudflare.com/",
    docsLabel: "Cloudflare Workers AI",
    freeTierDefault: true,
    requiresAccountId: true,
    defaultRpmLimit: 30,
    defaultRpdLimit: 800,
    defaultModels: [
      {
        id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        displayName: "Llama 3.3 70B FP8 Fast (CF)",
        enabled: true,
        seats: ["balanced", "smart"],
        capabilities: { json: true, tools: true, vision: false, reasoning: false },
        isFreeTier: true,
      },
      {
        id: "@cf/zai-org/glm-4.7-flash",
        displayName: "GLM 4.7 Flash (CF)",
        enabled: true,
        seats: ["smart", "balanced"],
        capabilities: { json: true, tools: true, vision: false, reasoning: true },
        isFreeTier: true,
      },
      {
        id: "@cf/meta/llama-3.1-8b-instruct-fast",
        displayName: "Llama 3.1 8B Fast (CF)",
        enabled: true,
        seats: ["fast"],
        capabilities: { json: true, tools: false, vision: false, reasoning: false },
        isFreeTier: true,
      },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    blurb: "Unified access to dozens of `:free` tier models (DeepSeek, Llama, Qwen, Gemma).",
    style: "openai_compat",
    baseUrl: "https://openrouter.ai/api/v1",
    modelsPath: "/models",
    keyPrefixes: ["sk-or-"],
    docsUrl: "https://openrouter.ai/keys",
    docsLabel: "OpenRouter Keys",
    freeTierDefault: true,
    defaultRpmLimit: 20,
    defaultRpdLimit: 1000,
    defaultModels: [
      {
        id: "meta-llama/llama-3.3-70b-instruct:free",
        displayName: "Llama 3.3 70B (:free)",
        enabled: true,
        seats: ["smart", "balanced"],
        capabilities: { json: true, tools: true, vision: false, reasoning: false },
        isFreeTier: true,
      },
      {
        id: "deepseek/deepseek-chat-v3-0324:free",
        displayName: "DeepSeek V3 (:free)",
        enabled: true,
        seats: ["smart", "balanced"],
        capabilities: { json: true, tools: true, vision: false, reasoning: false },
        isFreeTier: true,
      },
      {
        id: "qwen/qwen-2.5-72b-instruct:free",
        displayName: "Qwen 2.5 72B (:free)",
        enabled: true,
        seats: ["smart", "balanced"],
        capabilities: { json: true, tools: true, vision: false, reasoning: false },
        isFreeTier: true,
      },
      {
        id: "google/gemma-3-27b-it:free",
        displayName: "Gemma 3 27B (:free)",
        enabled: true,
        seats: ["fast", "balanced"],
        capabilities: { json: true, tools: false, vision: true, reasoning: false },
        isFreeTier: true,
      },
    ],
  },
  {
    id: "groq",
    label: "Groq",
    blurb: "Ultra-fast LPU inference on free developer tier for Llama 3.3, Qwen & instant checks.",
    style: "openai_compat",
    baseUrl: "https://api.groq.com/openai/v1",
    modelsPath: "/models",
    keyPrefixes: ["gsk_"],
    docsUrl: "https://console.groq.com/keys",
    docsLabel: "GroqCloud Console",
    freeTierDefault: true,
    defaultRpmLimit: 30,
    defaultRpdLimit: 1000,
    defaultModels: [
      {
        id: "llama-3.3-70b-versatile",
        displayName: "Llama 3.3 70B Versatile",
        enabled: true,
        seats: ["balanced", "smart"],
        capabilities: { json: true, tools: true, vision: false, reasoning: false },
        isFreeTier: true,
      },
      {
        id: "llama-3.1-8b-instant",
        displayName: "Llama 3.1 8B Instant",
        enabled: true,
        seats: ["fast"],
        capabilities: { json: true, tools: true, vision: false, reasoning: false },
        isFreeTier: true,
      },
    ],
  },
  {
    id: "cerebras",
    label: "Cerebras",
    blurb: "Sub-second wafer-scale inference free tier for rapid JSON, triage & drafting.",
    style: "openai_compat",
    baseUrl: "https://api.cerebras.ai/v1",
    modelsPath: "/models",
    keyPrefixes: ["csk-"],
    docsUrl: "https://cloud.cerebras.ai/",
    docsLabel: "Cerebras Cloud",
    freeTierDefault: true,
    defaultRpmLimit: 30,
    defaultRpdLimit: 1000,
    defaultModels: [
      {
        id: "llama-3.3-70b",
        displayName: "Llama 3.3 70B (Cerebras)",
        enabled: true,
        seats: ["balanced", "smart", "fast"],
        capabilities: { json: true, tools: true, vision: false, reasoning: false },
        isFreeTier: true,
      },
      {
        id: "llama3.1-8b",
        displayName: "Llama 3.1 8B (Cerebras)",
        enabled: true,
        seats: ["fast"],
        capabilities: { json: true, tools: true, vision: false, reasoning: false },
        isFreeTier: true,
      },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    blurb: "Claude Sonnet & Haiku models (BYOK or paid platform key).",
    style: "anthropic",
    baseUrl: "https://api.anthropic.com",
    modelsPath: "/v1/models",
    keyPrefixes: ["sk-ant-"],
    docsUrl: "https://console.anthropic.com/settings/keys",
    docsLabel: "Anthropic Console",
    freeTierDefault: false,
    defaultRpmLimit: 50,
    defaultRpdLimit: 10000,
    defaultModels: [
      {
        id: "claude-sonnet-4-5",
        displayName: "Claude Sonnet 4.5",
        enabled: true,
        seats: ["smart", "balanced"],
        capabilities: { json: true, tools: true, vision: true, reasoning: true },
      },
      {
        id: "claude-haiku-4-5",
        displayName: "Claude Haiku 4.5",
        enabled: true,
        seats: ["fast", "balanced"],
        capabilities: { json: true, tools: true, vision: true, reasoning: false },
      },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    blurb: "GPT-4o / GPT-4.1 / GPT-5 series (BYOK or paid platform key).",
    style: "openai_compat",
    baseUrl: "https://api.openai.com/v1",
    modelsPath: "/models",
    keyPrefixes: ["sk-proj-", "sk-"],
    docsUrl: "https://platform.openai.com/api-keys",
    docsLabel: "OpenAI Platform",
    freeTierDefault: false,
    defaultRpmLimit: 60,
    defaultRpdLimit: 10000,
    defaultModels: [
      {
        id: "gpt-4o-mini",
        displayName: "GPT-4o Mini",
        enabled: true,
        seats: ["fast", "balanced"],
        capabilities: { json: true, tools: true, vision: true, reasoning: false },
      },
      {
        id: "gpt-4o",
        displayName: "GPT-4o",
        enabled: true,
        seats: ["smart", "balanced"],
        capabilities: { json: true, tools: true, vision: true, reasoning: false },
      },
    ],
  },
  {
    id: "custom",
    label: "Custom OpenAI Endpoint",
    blurb: "Any OpenAI-compatible URL (FreeLLMAPI instance, Ollama, vLLM, LiteLLM, DeepSeek, Mistral).",
    style: "openai_compat",
    baseUrl: "",
    modelsPath: "/models",
    keyPrefixes: [],
    docsUrl: "",
    docsLabel: "Custom Gateway / Endpoint",
    freeTierDefault: false,
    requiresBaseUrl: true,
    defaultRpmLimit: 60,
    defaultRpdLimit: 5000,
    defaultModels: [
      {
        id: "auto",
        displayName: "Auto (Remote Router)",
        enabled: true,
        seats: ["smart", "balanced", "fast"],
        capabilities: { json: true, tools: true, vision: false, reasoning: false },
      },
    ],
  },
];

const PROVIDER_BY_ID = new Map<GatewayProviderId, ProviderCatalogMeta>(
  PROVIDER_CATALOG.map((p) => [p.id, p]),
);

const LEGACY_BASE_URLS: Record<string, string> = {
  deepseek: "https://api.deepseek.com/v1",
  mistral: "https://api.mistral.ai/v1",
  xai: "https://api.x.ai/v1",
  together: "https://api.together.xyz/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  perplexity: "https://api.perplexity.ai",
  numes: "https://api.numes.ai/api/v1",
};

export function normalizeGatewayProviderId(raw: unknown): {
  provider: GatewayProviderId;
  impliedBaseUrl?: string;
} {
  const clean = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (clean === "gemini") return { provider: "google" };
  if (clean === "zhipu" || clean === "z.ai" || clean === "z-ai") return { provider: "zai" };
  if (PROVIDER_BY_ID.has(clean as GatewayProviderId)) {
    return { provider: clean as GatewayProviderId };
  }
  if (LEGACY_BASE_URLS[clean]) {
    return { provider: "custom", impliedBaseUrl: LEGACY_BASE_URLS[clean] };
  }
  return { provider: "google" };
}

export function getProviderMeta(id: GatewayProviderId | string): ProviderCatalogMeta {
  const { provider } = normalizeGatewayProviderId(id);
  return PROVIDER_BY_ID.get(provider) ?? PROVIDER_CATALOG[0];
}

export function guessGatewayProvider(rawKey: string): GatewayProviderId | null {
  const k = rawKey.trim();
  if (!k) return null;
  if (k.startsWith("AIza") || k.startsWith("AQ.")) return "google";
  if (k.startsWith("nvapi-")) return "nvidia";
  if (k.startsWith("gsk_")) return "groq";
  if (k.startsWith("csk-")) return "cerebras";
  if (k.startsWith("sk-or-")) return "openrouter";
  if (k.startsWith("sk-ant-")) return "anthropic";
  if (k.startsWith("sk-proj-") || k.startsWith("sk-")) return "openai";
  return null;
}

export interface AdminAiSettings {
  id: "default";
  masterMode: "auto" | "manual";
  strategy: RoutingStrategy;
  fallbackChain: { provider: GatewayProviderId; model: string }[];
  updatedAt: string;
}

export interface AdminAiKeyRecord {
  id: string;
  provider: GatewayProviderId;
  label: string;
  encryptedKey: string;
  maskedKey: string;
  accountId?: string | null;
  baseUrl?: string | null;
  enabled: boolean;
  models: GatewayModelConfig[];
  rpmLimit: number;
  rpdLimit: number;
  healthStatus: KeyHealthStatus;
  cooldownUntil?: string | null;
  cooldownStep: number;
  lastError?: string | null;
  lastCheckedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminAiKeyPublic extends Omit<AdminAiKeyRecord, "encryptedKey"> {
  hasKey: boolean;
  rpmUsed?: number;
  rpdUsed?: number;
}

export interface UserAiSettings {
  ownerId: string;
  mode: "system_auto" | "byok";
  activeKeyId?: string | null;
  activeProvider?: GatewayProviderId | null;
  activeModel?: string | null;
  fallbackToSystemAuto: boolean;
  updatedAt: string;
}

export interface UserAiKeyRecord {
  id: string;
  ownerId: string;
  provider: GatewayProviderId;
  label: string;
  encryptedKey: string;
  maskedKey: string;
  accountId?: string | null;
  baseUrl?: string | null;
  models: GatewayModelConfig[];
  lastVerifiedAt?: string | null;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type UserAiKeyPublic = Omit<UserAiKeyRecord, "encryptedKey">;

export interface AdminSearchKeyPublic {
  id: string;
  provider: SearchProviderId;
  label: string;
  maskedKey: string;
  enabled: boolean;
  healthStatus: KeyHealthStatus;
  lastError?: string | null;
  lastCheckedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GatewayReceipt {
  ownerId: string;
  taskType: TaskSeat;
  feature: string;
  requestedMode: "system_auto" | "byok";
  requestedModel?: string | null;
  actualProvider: GatewayProviderId;
  actualKeyId: string;
  actualModel: string;
  fallbackHops: number;
  fallbackUsed: boolean;
  grounded: boolean;
  groundingSource?: "google_search" | "web_search" | null;
  latencyMs: number;
  status: "success" | "failed";
  errorSummary?: string;
}

export interface AiExecutionLogRecord {
  id: string;
  ownerId: string;
  taskType: TaskSeat;
  feature: string;
  requestedMode: "system_auto" | "byok";
  requestedModel?: string | null;
  actualProvider?: string | null;
  actualKeyId?: string | null;
  actualModel?: string | null;
  fallbackHops: number;
  fallbackUsed: boolean;
  grounded: boolean;
  latencyMs: number;
  status: "success" | "failed";
  errorSummary?: string | null;
  createdAt: string;
}
