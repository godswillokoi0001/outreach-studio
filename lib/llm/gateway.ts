import type { FunctionDeclaration, Schema } from "@google/genai";
import type { AgentContent, AgentFunctionCall } from "../agent-meta";
import { maskSecret, validateApiKeyInput } from "../key-vault";
import {
  dispatchProviderCall,
  fetchProviderCatalogModels,
  GatewayProviderError,
  parseJsonWithRescue,
  type AdapterMessage,
} from "./providers";
import {
  rankPoolCandidates,
  recordCandidateFailure,
  recordCandidateSuccess,
  recordKeyUsageHit,
} from "./router";
import {
  appendAiExecutionLog,
  decryptStoredGatewayKey,
  getAdminAiSettings,
  getUserAiSettings,
  listAdminAiKeys,
  listUserAiKeys,
} from "./store";
import {
  getProviderMeta,
  normalizeGatewayProviderId,
  type GatewayModelConfig,
  type GatewayProviderId,
  type GatewayReceipt,
  type TaskSeat,
} from "./types";

const MAX_AUTO_ATTEMPTS = 8;
const AUTO_WALL_BUDGET_MS = 40_000;

export class LLMGatewayError extends Error {
  status: number;
  code: string;
  receipt?: GatewayReceipt;
  canFallbackToSystemAuto?: boolean;

  constructor(
    message: string,
    opts: {
      status?: number;
      code?: string;
      receipt?: GatewayReceipt;
      canFallbackToSystemAuto?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "LLMGatewayError";
    this.status = opts.status ?? 500;
    this.code = opts.code ?? "LLM_GATEWAY_ERROR";
    this.receipt = opts.receipt;
    this.canFallbackToSystemAuto = opts.canFallbackToSystemAuto;
  }
}

export interface GatewayRequest {
  ownerId: string;
  taskType: TaskSeat;
  feature?: string;
  systemPrompt?: string;
  messages: AdapterMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "text" | "json";
  schema?: Schema;
  tools?: FunctionDeclaration[];
  agentContents?: AgentContent[];
  useGrounding?: boolean;
  requiresVision?: boolean;
}

export interface GatewayTextResult {
  text: string;
  receipt: GatewayReceipt;
}

export interface GatewayJsonResult<T> {
  data: T;
  receipt: GatewayReceipt;
}

export interface GatewayGroundedJsonResult<T> {
  data: T;
  groundingUrls: { uri: string; title: string }[];
  receipt: GatewayReceipt;
}

export interface GatewayAgentTurnResult {
  text: string;
  functionCalls: AgentFunctionCall[];
  modelContent: AgentContent;
  modelUsed: string;
  receipt: GatewayReceipt;
}

async function runPooledAutoFailover<T>(input: {
  req: GatewayRequest;
  startedAt: number;
  requestedMode: "system_auto" | "byok";
  requestedModel: string | null;
  fallbackUsedFromByok: boolean;
  initialHops: number;
  parseResult: (raw: Awaited<ReturnType<typeof dispatchProviderCall>>) => T;
}): Promise<{ parsed: T; raw: Awaited<ReturnType<typeof dispatchProviderCall>>; receipt: GatewayReceipt }> {
  const [adminSettings, adminKeys] = await Promise.all([
    getAdminAiSettings(),
    listAdminAiKeys(),
  ]);

  const ranked = rankPoolCandidates({
    keys: adminKeys,
    settings: adminSettings,
    taskType: input.req.taskType,
    requiresTools: Boolean(input.req.tools && input.req.tools.length > 0),
    requiresVision: input.req.requiresVision,
    requiresGrounding: input.req.useGrounding,
  });

  if (ranked.length === 0) {
    const errMsg =
      adminKeys.length === 0
        ? "No platform AI provider keys are configured yet. Ask an administrator to add free-tier or paid keys in Admin → AI Engine, or add your own key in Settings."
        : "All pooled AI provider keys are currently cooling down or at capacity limits. Try again shortly or use your own API key in Settings.";

    const failReceipt: GatewayReceipt = {
      ownerId: input.req.ownerId,
      taskType: input.req.taskType,
      feature: input.req.feature || input.req.taskType,
      requestedMode: input.requestedMode,
      requestedModel: input.requestedModel,
      actualProvider: "google",
      actualKeyId: "none",
      actualModel: "none",
      fallbackHops: input.initialHops,
      fallbackUsed: input.fallbackUsedFromByok,
      grounded: false,
      latencyMs: Date.now() - input.startedAt,
      status: "failed",
      errorSummary: errMsg,
    };
    void appendAiExecutionLog(failReceipt).catch(() => {});
    throw new LLMGatewayError(errMsg, {
      status: adminKeys.length === 0 ? 503 : 429,
      code: adminKeys.length === 0 ? "NO_PLATFORM_KEYS" : "ALL_KEYS_EXHAUSTED",
      receipt: failReceipt,
    });
  }

  let lastErr: unknown = null;
  // Attempts and skips are counted separately: skipping a benched or cooling
  // candidate must never consume the failover budget.
  let attempts = 0;
  const triedKeys = new Set<string>();
  // Failure count per key: one key with several unusable models must not eat
  // every attempt while other healthy keys go untried.
  const keyFailures = new Map<string, number>();
  const hasMultipleKeys = new Set(ranked.map((c) => c.key.id)).size > 1;
  const MAX_FAILURES_PER_KEY = 3;

  for (let i = 0; i < ranked.length && attempts < MAX_AUTO_ATTEMPTS; i++) {
    const elapsed = Date.now() - input.startedAt;
    if (attempts >= 2 && elapsed >= AUTO_WALL_BUDGET_MS) {
      break;
    }

    const candidate = ranked[i];
    if (hasMultipleKeys && (keyFailures.get(candidate.key.id) ?? 0) >= MAX_FAILURES_PER_KEY) {
      continue;
    }
    const trySig = `${candidate.key.id}:${candidate.model.id}`;
    if (triedKeys.has(trySig)) continue;
    triedKeys.add(trySig);
    attempts += 1;

    let decryptedKey = "";
    try {
      decryptedKey = decryptStoredGatewayKey(candidate.key.encryptedKey);
    } catch (decErr) {
      lastErr = decErr;
      continue;
    }
    if (!decryptedKey) continue;

    recordKeyUsageHit(candidate.key.id);

    const remainingMs = Math.max(8_000, AUTO_WALL_BUDGET_MS - elapsed);
    const attemptTimeout = Math.min(remainingMs, input.req.useGrounding && candidate.key.provider === "google" ? 20_000 : 12_000);

    // Non-Google providers cannot run Google Search grounding natively; degrade safely
    const isGoogleGrounding =
      Boolean(input.req.useGrounding) &&
      candidate.key.provider === "google" &&
      Boolean(candidate.model.capabilities.grounding);

    const degradedSystemPrompt =
      input.req.useGrounding && !isGoogleGrounding
        ? `${input.req.systemPrompt ?? ""}\n\nNote: Live web search grounding is unavailable on this model. Rely strictly on verified user/context facts supplied below and mark lower confidence where real-time search was unavailable. Never fabricate URLs.`
        : input.req.systemPrompt;

    try {
      const raw = await dispatchProviderCall({
        cfg: {
          provider: candidate.key.provider,
          model: candidate.model.id,
          apiKey: decryptedKey,
          accountId: candidate.key.accountId,
          baseUrl: candidate.key.baseUrl,
        },
        systemPrompt: degradedSystemPrompt,
        messages: input.req.messages,
        temperature: input.req.temperature,
        maxTokens: input.req.maxTokens,
        responseFormat: input.req.responseFormat,
        schema: input.req.schema,
        tools: input.req.tools,
        agentContents: input.req.agentContents,
        useGrounding: isGoogleGrounding,
        timeoutMs: attemptTimeout,
      });

      const parsed = input.parseResult(raw);
      recordCandidateSuccess(candidate.key, candidate.model.id);

      const receipt: GatewayReceipt = {
        ownerId: input.req.ownerId,
        taskType: input.req.taskType,
        feature: input.req.feature || input.req.taskType,
        requestedMode: input.requestedMode,
        requestedModel: input.requestedModel,
        actualProvider: candidate.key.provider,
        actualKeyId: candidate.key.id,
        actualModel: candidate.model.id,
        fallbackHops: input.initialHops + i,
        fallbackUsed: input.fallbackUsedFromByok || i > 0,
        grounded: raw.grounded,
        latencyMs: Date.now() - input.startedAt,
        status: "success",
      };
      void appendAiExecutionLog(receipt).catch(() => {});
      return { parsed, raw, receipt };
    } catch (err) {
      lastErr = err;
      const gErr =
        err instanceof GatewayProviderError
          ? err
          : new GatewayProviderError(err instanceof Error ? err.message : String(err), {
              status: 502,
              retryable: true,
            });
      recordCandidateFailure(candidate.key, candidate.model.id, gErr);
      keyFailures.set(candidate.key.id, (keyFailures.get(candidate.key.id) ?? 0) + 1);

      // A model that refuses this request shape (tools, multi-turn, vision) is a
      // per-model limitation: bench it and let the next healthy key answer.
      if (gErr.modelUnsupported) continue;

      // Only a genuinely model-independent client error stops the loop.
      if (
        !gErr.retryable &&
        gErr.status === 400 &&
        !gErr.authFailed &&
        !gErr.modelNotFound &&
        /invalid (?:argument|request|prompt)|request too large|context length|contents are required/i.test(
          gErr.message,
        )
      ) {
        break;
      }
    }
  }

  const finalErrMsg =
    lastErr instanceof Error ? lastErr.message : "All pooled AI providers failed to answer in time.";
  const failReceipt: GatewayReceipt = {
    ownerId: input.req.ownerId,
    taskType: input.req.taskType,
    feature: input.req.feature || input.req.taskType,
    requestedMode: input.requestedMode,
    requestedModel: input.requestedModel,
    actualProvider: "google",
    actualKeyId: "exhausted",
    actualModel: "exhausted",
    fallbackHops: input.initialHops + triedKeys.size,
    fallbackUsed: input.fallbackUsedFromByok || triedKeys.size > 1,
    grounded: false,
    latencyMs: Date.now() - input.startedAt,
    status: "failed",
    errorSummary: finalErrMsg,
  };
  void appendAiExecutionLog(failReceipt).catch(() => {});

  throw new LLMGatewayError(finalErrMsg, {
    status: lastErr instanceof GatewayProviderError ? lastErr.status : 502,
    code: "POOL_FAILOVER_EXHAUSTED",
    receipt: failReceipt,
  });
}

async function executeGatewayCore<T>(
  req: GatewayRequest,
  parseResult: (raw: Awaited<ReturnType<typeof dispatchProviderCall>>) => T,
): Promise<{ parsed: T; raw: Awaited<ReturnType<typeof dispatchProviderCall>>; receipt: GatewayReceipt }> {
  const startedAt = Date.now();
  const userSettings = await getUserAiSettings(req.ownerId);

  // Strict Precedence Path 1: User BYOK mode
  if (userSettings.mode === "byok") {
    const userKeys = await listUserAiKeys(req.ownerId);
    const chosenKey =
      (userSettings.activeKeyId
        ? userKeys.find((k) => k.id === userSettings.activeKeyId)
        : undefined) ??
      (userSettings.activeProvider
        ? userKeys.find((k) => k.provider === userSettings.activeProvider)
        : undefined) ??
      userKeys[0];

    const provider = chosenKey?.provider ?? userSettings.activeProvider ?? null;
    const meta = provider ? getProviderMeta(provider) : null;
    // The saved model may belong to a previously selected key/provider. Never
    // call this key with a model it does not own.
    const preferredModel = (userSettings.activeModel ?? "").trim();
    const model =
      (preferredModel && chosenKey?.models.some((m) => m.id === preferredModel)
        ? preferredModel
        : "") ||
      chosenKey?.models.find((m) => m.enabled)?.id ||
      meta?.defaultModels[0]?.id ||
      "";

    if (!chosenKey || !provider || !model) {
      if (userSettings.fallbackToSystemAuto) {
        return runPooledAutoFailover({
          req,
          startedAt,
          requestedMode: "byok",
          requestedModel: userSettings.activeModel ?? null,
          fallbackUsedFromByok: true,
          initialHops: 1,
          parseResult,
        });
      }
      throw new LLMGatewayError(
        "Your AI mode is set to 'Use my own API key (BYOK)', but no active key & model are configured. Save a personal key or switch to Managed Auto in Settings.",
        { status: 400, code: "BYOK_KEY_MISSING", canFallbackToSystemAuto: true },
      );
    }

    const decryptedKey = decryptStoredGatewayKey(chosenKey.encryptedKey);
    const useGoogleGrounding = Boolean(req.useGrounding && provider === "google");
    const safeSystemPrompt =
      req.useGrounding && !useGoogleGrounding
        ? `${req.systemPrompt ?? ""}\n\nNote: Live web search grounding is unavailable on ${meta?.label ?? provider}. Answer strictly from known verifiable facts and supplied context without fabricating URLs.`
        : req.systemPrompt;

    try {
      const raw = await dispatchProviderCall({
        cfg: {
          provider,
          model,
          apiKey: decryptedKey,
          accountId: chosenKey.accountId,
          baseUrl: chosenKey.baseUrl,
        },
        systemPrompt: safeSystemPrompt,
        messages: req.messages,
        temperature: req.temperature,
        maxTokens: req.maxTokens,
        responseFormat: req.responseFormat,
        schema: req.schema,
        tools: req.tools,
        agentContents: req.agentContents,
        useGrounding: useGoogleGrounding,
        timeoutMs: useGoogleGrounding ? 26_000 : 22_000,
      });

      const parsed = parseResult(raw);
      const receipt: GatewayReceipt = {
        ownerId: req.ownerId,
        taskType: req.taskType,
        feature: req.feature || req.taskType,
        requestedMode: "byok",
        requestedModel: `${provider}:${model}`,
        actualProvider: provider,
        actualKeyId: chosenKey.id,
        actualModel: model,
        fallbackHops: 0,
        fallbackUsed: false,
        grounded: raw.grounded,
        latencyMs: Date.now() - startedAt,
        status: "success",
      };
      void appendAiExecutionLog(receipt).catch(() => {});
      return { parsed, raw, receipt };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (userSettings.fallbackToSystemAuto) {
        return runPooledAutoFailover({
          req,
          startedAt,
          requestedMode: "byok",
          requestedModel: `${provider}:${model}`,
          fallbackUsedFromByok: true,
          initialHops: 1,
          parseResult,
        });
      }

      const failReceipt: GatewayReceipt = {
        ownerId: req.ownerId,
        taskType: req.taskType,
        feature: req.feature || req.taskType,
        requestedMode: "byok",
        requestedModel: `${provider}:${model}`,
        actualProvider: provider,
        actualKeyId: chosenKey.id,
        actualModel: model,
        fallbackHops: 0,
        fallbackUsed: false,
        grounded: false,
        latencyMs: Date.now() - startedAt,
        status: "failed",
        errorSummary: errMsg,
      };
      void appendAiExecutionLog(failReceipt).catch(() => {});

      const unsupported = err instanceof GatewayProviderError && err.modelUnsupported;
      throw new LLMGatewayError(
        unsupported
          ? `Your ${meta?.label ?? provider} model "${model}" cannot handle this request (${errMsg}). Pick a different model in Settings → AI Engine, or switch to Managed Auto.`
          : `Your selected ${meta?.label ?? provider} (${model}) key failed: ${errMsg}`,
        {
          status: err instanceof GatewayProviderError ? err.status : 502,
          code: unsupported ? "BYOK_MODEL_UNSUPPORTED" : "BYOK_CALL_FAILED",
          receipt: failReceipt,
          canFallbackToSystemAuto: true,
        },
      );
    }
  }

  // Strict Precedence Path 2: Managed Admin Auto Pool
  return runPooledAutoFailover({
    req,
    startedAt,
    requestedMode: "system_auto",
    requestedModel: `auto:${req.taskType}`,
    fallbackUsedFromByok: false,
    initialHops: 0,
    parseResult,
  });
}

export const LLMGateway = {
  async complete(req: GatewayRequest): Promise<GatewayTextResult> {
    const res = await executeGatewayCore(
      { ...req, responseFormat: req.responseFormat ?? "text" },
      (raw) => raw.text,
    );
    return { text: res.parsed, receipt: res.receipt };
  },

  async completeJSON<T>(req: GatewayRequest): Promise<GatewayJsonResult<T>> {
    const res = await executeGatewayCore(
      { ...req, responseFormat: "json" },
      (raw) => parseJsonWithRescue<T>(raw.text),
    );
    return { data: res.parsed, receipt: res.receipt };
  },

  async completeGroundedJSON<T>(req: GatewayRequest): Promise<GatewayGroundedJsonResult<T>> {
    const res = await executeGatewayCore(
      { ...req, responseFormat: "json", useGrounding: true },
      (raw) => parseJsonWithRescue<T>(raw.text),
    );
    return {
      data: res.parsed,
      groundingUrls: res.raw.groundingUrls,
      receipt: res.receipt,
    };
  },

  async agentTurn(req: GatewayRequest): Promise<GatewayAgentTurnResult> {
    const res = await executeGatewayCore(req, (raw) => raw);
    const modelContent: AgentContent = res.raw.modelContent ?? {
      role: "model",
      parts: [
        ...(res.raw.text ? [{ text: res.raw.text }] : []),
        ...res.raw.functionCalls.map((fc) => ({ functionCall: fc })),
      ],
    };
    return {
      text: res.raw.text,
      functionCalls: res.raw.functionCalls,
      modelContent,
      modelUsed: res.receipt.actualModel,
      receipt: res.receipt,
    };
  },

  /**
   * A real JSON completion through the exact path features use, so a passing
   * receipt means research/compose/chat will work too - not just a text ping.
   */
  async testActiveModel(ownerId: string): Promise<GatewayTextResult> {
    const res = await LLMGateway.completeJSON<{ status?: string }>({
      ownerId,
      taskType: "fast",
      feature: "model_test",
      systemPrompt: 'Return only the JSON object {"status":"ok"} with no commentary.',
      messages: [{ role: "user", content: "Send the JSON status object now." }],
      maxTokens: 48,
      temperature: 0,
    });
    return {
      text: JSON.stringify(res.data ?? { status: "ok" }),
      receipt: res.receipt,
    };
  },

  async transcribeAudio(input: {
    ownerId: string;
    mimeType: string;
    base64Data: string;
  }): Promise<{ transcript: string; provider: string; model: string }> {
    const startedAt = Date.now();
    const userSettings = await getUserAiSettings(input.ownerId);

    // Resolve speech-capable key (Google native audio inlineData or OpenAI/Groq Whisper)
    const candidates: {
      provider: GatewayProviderId;
      keyId: string;
      apiKey: string;
      model: string;
      baseUrl?: string | null;
    }[] = [];

    if (userSettings.mode === "byok") {
      const userKeys = await listUserAiKeys(input.ownerId);
      const chosen =
        userKeys.find((k) => k.id === userSettings.activeKeyId) ?? userKeys[0];
      if (chosen) {
        const apiKey = decryptStoredGatewayKey(chosen.encryptedKey);
        if (chosen.provider === "google") {
          candidates.push({
            provider: "google",
            keyId: chosen.id,
            apiKey,
            model: userSettings.activeModel || chosen.models[0]?.id || "gemini-2.5-flash",
            baseUrl: chosen.baseUrl,
          });
        } else if (chosen.provider === "openai" || chosen.provider === "groq") {
          candidates.push({
            provider: chosen.provider,
            keyId: chosen.id,
            apiKey,
            model: chosen.provider === "groq" ? "whisper-large-v3" : "whisper-1",
            baseUrl: chosen.baseUrl,
          });
        }
      }
    }

    if (userSettings.mode === "system_auto" || (candidates.length === 0 && userSettings.fallbackToSystemAuto)) {
      const adminKeys = await listAdminAiKeys();
      for (const k of adminKeys) {
        if (!k.enabled || k.healthStatus === "invalid") continue;
        if (k.provider === "google" || k.provider === "groq" || k.provider === "openai") {
          try {
            const apiKey = decryptStoredGatewayKey(k.encryptedKey);
            if (!apiKey) continue;
            candidates.push({
              provider: k.provider,
              keyId: k.id,
              apiKey,
              model:
                k.provider === "google"
                  ? k.models.find((m) => m.enabled)?.id || "gemini-2.5-flash"
                  : k.provider === "groq"
                    ? "whisper-large-v3"
                    : "whisper-1",
              baseUrl: k.baseUrl,
            });
          } catch {
            /* skip invalid cipher */
          }
        }
      }
    }

    if (candidates.length === 0) {
      throw new LLMGatewayError(
        "No speech-capable AI provider (Google Gemini, Groq, or OpenAI) is active for audio transcription.",
        { status: 400, code: "AUDIO_PROVIDER_UNAVAILABLE" },
      );
    }

    let lastErr: Error | null = null;
    for (const c of candidates) {
      try {
        if (c.provider === "google") {
          const base = (c.baseUrl?.trim() || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
          const res = await fetch(
            `${base}/models/${encodeURIComponent(c.model)}:generateContent?key=${encodeURIComponent(c.apiKey)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [
                  {
                    role: "user",
                    parts: [
                      {
                        text: "Transcribe this voice note word for word. Return only the transcript, no commentary.",
                      },
                      { inlineData: { mimeType: input.mimeType, data: input.base64Data } },
                    ],
                  },
                ],
              }),
            },
          );
          const json = (await res.json().catch(() => ({}))) as {
            candidates?: { content?: { parts?: { text?: string }[] } }[];
            error?: { message?: string };
          };
          if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
          const transcript = (json.candidates?.[0]?.content?.parts ?? [])
            .map((p) => p.text ?? "")
            .join("")
            .trim();
          void appendAiExecutionLog({
            ownerId: input.ownerId,
            taskType: "fast",
            feature: "transcribe",
            requestedMode: userSettings.mode,
            requestedModel: userSettings.activeModel ?? null,
            actualProvider: "google",
            actualKeyId: c.keyId,
            actualModel: c.model,
            fallbackHops: 0,
            fallbackUsed: false,
            grounded: false,
            latencyMs: Date.now() - startedAt,
            status: "success",
          }).catch(() => {});
          return { transcript, provider: "google", model: c.model };
        }

        const base =
          (c.baseUrl?.trim() ||
            (c.provider === "groq" ? "https://api.groq.com/openai/v1" : "https://api.openai.com/v1")).replace(/\/+$/, "");
        const form = new FormData();
        const bytes = Buffer.from(input.base64Data, "base64");
        const ext = input.mimeType.includes("mp4") || input.mimeType.includes("m4a") ? "m4a" : input.mimeType.includes("ogg") ? "ogg" : "webm";
        form.append("file", new Blob([bytes], { type: input.mimeType }), `voice.${ext}`);
        form.append("model", c.model);
        const res = await fetch(`${base}/audio/transcriptions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${c.apiKey}` },
          body: form,
        });
        const json = (await res.json().catch(() => ({}))) as { text?: string; error?: { message?: string } };
        if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
        const transcript = (json.text ?? "").trim();
        void appendAiExecutionLog({
          ownerId: input.ownerId,
          taskType: "fast",
          feature: "transcribe",
          requestedMode: userSettings.mode,
          requestedModel: userSettings.activeModel ?? null,
          actualProvider: c.provider,
          actualKeyId: c.keyId,
          actualModel: c.model,
          fallbackHops: 0,
          fallbackUsed: false,
          grounded: false,
          latencyMs: Date.now() - startedAt,
          status: "success",
        }).catch(() => {});
        return { transcript, provider: c.provider, model: c.model };
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw new LLMGatewayError(lastErr?.message || "Transcription failed.", { status: 502 });
  },

  async verifyAndFetchModels(input: {
    provider: string;
    apiKey: string;
    accountId?: string | null;
    baseUrl?: string | null;
    preferredModel?: string;
    freeTierOnly?: boolean;
  }): Promise<{
    provider: GatewayProviderId;
    providerLabel: string;
    maskedKey: string;
    baseUrl: string;
    models: GatewayModelConfig[];
    recommendedModel: string;
    probe: { model: string; ms: number; reply: string };
    warning?: string;
  }> {
    const check = validateApiKeyInput(input.apiKey);
    if (!check.ok) {
      throw new LLMGatewayError(check.error || "Invalid API key.", { status: 400 });
    }
    const { provider, impliedBaseUrl } = normalizeGatewayProviderId(input.provider);
    const meta = getProviderMeta(provider);
    const baseUrl = (input.baseUrl ?? "").trim() || impliedBaseUrl || meta.baseUrl;

    const models = await fetchProviderCatalogModels({
      provider,
      apiKey: check.value,
      accountId: input.accountId,
      baseUrl,
      freeTierOnly: input.freeTierOnly ?? meta.freeTierDefault,
    });

    const candidates = Array.from(
      new Set(
        [
          input.preferredModel?.trim(),
          models[0]?.id,
          meta.defaultModels[0]?.id,
        ].filter((x): x is string => Boolean(x)),
      ),
    ).slice(0, 4);

    let lastErr: Error | null = null;
    for (const model of candidates) {
      const started = Date.now();
      try {
        const out = await dispatchProviderCall({
          cfg: {
            provider,
            model,
            apiKey: check.value,
            accountId: input.accountId,
            baseUrl,
          },
          systemPrompt: 'Connectivity probe. Reply with only "OK".',
          messages: [{ role: "user", content: "OK" }],
          maxTokens: 24,
          timeoutMs: 12_000,
        });
        return {
          provider,
          providerLabel: meta.label,
          maskedKey: maskSecret(check.value),
          baseUrl,
          models,
          recommendedModel: model,
          probe: { model, ms: Date.now() - started, reply: out.text.slice(0, 80) },
        };
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (err instanceof GatewayProviderError && err.authFailed) {
          throw new LLMGatewayError(lastErr.message, { status: err.status });
        }
      }
    }

    // Catalog succeeded even if sample model was busy
    return {
      provider,
      providerLabel: meta.label,
      maskedKey: maskSecret(check.value),
      baseUrl,
      models,
      recommendedModel: candidates[0] || meta.defaultModels[0]?.id || "auto",
      probe: { model: candidates[0] || "none", ms: 0, reply: "(catalog fetched)" },
      warning: lastErr ? `Key accepted, but probe failed (${lastErr.message}). Pick a model below and test again.` : undefined,
    };
  },
};
