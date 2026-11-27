import type { Content, FunctionCall, FunctionDeclaration, Schema } from "@google/genai";
import type { AgentContent } from "./agent-meta";
import { getActiveOwnerAiContext } from "./ai/context";
import {
  DEFAULT_GEMINI_MODEL,
  FALLBACK_GEMINI_MODEL,
  GeminiApiError,
  parseGeminiError,
  resolveModel,
} from "./gemini-utils";
import { LLMGateway } from "./llm/gateway";

export { DEFAULT_GEMINI_MODEL, FALLBACK_GEMINI_MODEL, GeminiApiError, parseGeminiError, resolveModel };

/**
 * Legacy compatibility shim: zero direct SDK clients or hardcoded model routing.
 * 100% of calls route strictly through the unified LLMGateway.
 */
function activeOwnerId(explicitOwnerId?: string | null): string {
  return explicitOwnerId || getActiveOwnerAiContext()?.ownerId || "anonymous";
}

export async function geminiJSON<T>(options: {
  system: string;
  user: string;
  schema: Schema;
  model?: string;
  ownerId?: string | null;
  feature?: string;
}): Promise<T> {
  const res = await LLMGateway.completeJSON<T>({
    ownerId: activeOwnerId(options.ownerId),
    taskType: "balanced",
    feature: options.feature || getActiveOwnerAiContext()?.feature || "legacy_json",
    systemPrompt: options.system,
    messages: [{ role: "user", content: options.user }],
    schema: options.schema,
  });
  return res.data;
}

export async function geminiGroundedJSON<T>(options: {
  system: string;
  user: string;
  model?: string;
  ownerId?: string | null;
  feature?: string;
}): Promise<{ data: T; groundingUrls: { uri: string; title: string }[] }> {
  const res = await LLMGateway.completeGroundedJSON<T>({
    ownerId: activeOwnerId(options.ownerId),
    taskType: "smart",
    feature: options.feature || getActiveOwnerAiContext()?.feature || "legacy_grounded",
    systemPrompt: options.system,
    messages: [{ role: "user", content: options.user }],
  });
  return { data: res.data, groundingUrls: res.groundingUrls };
}

export async function geminiAgentTurn(options: {
  system: string;
  contents: Content[];
  tools: FunctionDeclaration[];
  model?: string;
  ownerId?: string | null;
}): Promise<{
  text: string;
  functionCalls: FunctionCall[];
  modelContent: Content;
  modelUsed: string;
}> {
  const res = await LLMGateway.agentTurn({
    ownerId: activeOwnerId(options.ownerId),
    taskType: "balanced",
    feature: "operator_chat",
    systemPrompt: options.system,
    messages: [],
    agentContents: options.contents as unknown as AgentContent[],
    tools: options.tools,
  });
  return {
    text: res.text,
    functionCalls: res.functionCalls as unknown as FunctionCall[],
    modelContent: res.modelContent as unknown as Content,
    modelUsed: res.modelUsed,
  };
}

export async function testGeminiConnection(
  _model?: string,
  ownerId?: string | null,
): Promise<{ model: string; ms: number; reply: string; provider: string }> {
  void _model;
  const res = await LLMGateway.testActiveModel(activeOwnerId(ownerId));
  return {
    model: res.receipt.actualModel,
    ms: res.receipt.latencyMs,
    reply: res.text,
    provider: res.receipt.actualProvider,
  };
}
