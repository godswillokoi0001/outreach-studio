export type AiProviderId =
  | "gemini"
  | "openai"
  | "anthropic"
  | "openrouter"
  | "groq"
  | "deepseek"
  | "mistral"
  | "xai"
  | "together"
  | "fireworks"
  | "perplexity"
  | "custom";

export type AiApiStyle = "gemini" | "openai" | "anthropic";

export interface AiConfig {
  provider: AiProviderId;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export interface AiModelOption {
  id: string;
  label: string;
}

export interface AiProviderMeta {
  id: AiProviderId;
  label: string;
  blurb: string;
  style: AiApiStyle;
  baseUrl: string;
  modelsPath: string;
  keyPrefixes: string[];
  docsUrl: string;
  docsLabel: string;
  defaultModel: string;
  requiresBaseUrl?: boolean;
  staticModels?: AiModelOption[];
}

export class AiProviderError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "AiProviderError";
    this.status = status;
  }
}
