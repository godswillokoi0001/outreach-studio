"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Plug,
  RefreshCw,
  Trash2,
  Zap,
} from "lucide-react";
import { AI_PROVIDERS, getProvider, guessProviderId } from "@/lib/ai/registry";
import type { AiModelOption, AiProviderId } from "@/lib/ai/types";
import { aiConfigFromSettings, setActiveAiConfig } from "@/lib/ai-client";
import { authedPost, errorMessage } from "@/lib/client";
import { saveSettings } from "@/lib/firestore-store";
import type { Settings } from "@/lib/types";
import { Badge, Banner, Card, Field } from "./ui";

interface DetectResponse {
  provider: AiProviderId;
  providerLabel: string;
  models: AiModelOption[];
  recommendedModel: string;
  keyValid: boolean;
  probe: { model: string; ms: number; reply: string };
  warning?: string | null;
  baseUrl: string;
}

interface TestResponse {
  model: string;
  ms: number;
  reply: string;
  provider?: string;
}

type Note = { tone: "ok" | "bad" | "info"; text: string };

function maskKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 8) return "••••";
  return `••••${trimmed.slice(-4)}`;
}

export function AiEngineCard({
  uid,
  settings,
  onChange,
  onSaved,
}: {
  uid: string;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onSaved: (settings: Settings) => void;
}) {
  const [providerChoice, setProviderChoice] = useState<string>(
    guessProviderId(settings.ai_api_key) ? "auto" : settings.ai_provider || "gemini",
  );
  const [keyInput, setKeyInput] = useState<string>(settings.ai_api_key || "");
  const [baseUrl, setBaseUrl] = useState<string>(settings.ai_base_url || "");
  const [showKey, setShowKey] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [models, setModels] = useState<AiModelOption[]>([]);
  const [busy, setBusy] = useState<"detect" | "test" | null>(null);
  const [note, setNote] = useState<Note | null>(null);

  const detectRef = useRef<((silent?: boolean) => Promise<void>) | null>(null);
  const autoRan = useRef(false);

  const activeMeta = getProvider(settings.ai_provider) ?? getProvider("gemini");
  const connected = Boolean(settings.ai_api_key);
  const needsBaseUrl = providerChoice === "custom";

  const persist = useCallback(
    async (patch: Partial<Settings>): Promise<Settings | null> => {
      onChange(patch);
      try {
        const saved = await saveSettings(uid, patch);
        onSaved(saved);
        setActiveAiConfig(aiConfigFromSettings(saved));
        return saved;
      } catch (err) {
        // The key is verified and usable for this session even if the settings
        // write is blocked.
        const fallbackSettings = { ...settings, ...patch };
        setActiveAiConfig({
          provider: (patch.ai_provider ?? settings.ai_provider ?? "gemini") as AiProviderId,
          model: patch.model ?? settings.model,
          apiKey: (patch.ai_api_key ?? settings.ai_api_key ?? "").trim(),
          ...(patch.ai_base_url ? { baseUrl: patch.ai_base_url } : {}),
        });
        onSaved(fallbackSettings);
        setNote({
          tone: "info",
          text: `The key works and is active for this session, but saving it failed: ${errorMessage(err)}`,
        });
        return fallbackSettings;
      }
    },
    [onChange, onSaved, settings, uid],
  );

  const runDetect = useCallback(
    async (silent = false) => {
      const apiKey = keyInput.trim();
      if (!apiKey) {
        setNote({ tone: "bad", text: "Paste an API key first." });
        return;
      }
      setBusy("detect");
      if (!silent) setNote(null);
      try {
        const res = await authedPost<DetectResponse>("/api/ai/provider", {
          provider: providerChoice === "auto" ? "" : providerChoice,
          apiKey,
          baseUrl: baseUrl.trim(),
        });

        setModels(res.models);
        setProviderChoice(res.provider);

        const preferred = res.models.some((m) => m.id === settings.model)
          ? settings.model
          : res.recommendedModel || res.models[0]?.id || settings.model;

        const patch: Partial<Settings> = {
          ai_provider: res.provider,
          ai_api_key: apiKey,
          ai_base_url: res.provider === "custom" ? baseUrl.trim() : "",
          ai_verified_at: new Date().toISOString(),
          ai_key_hint: maskKey(apiKey),
          model: preferred,
        };

        const unchanged =
          res.provider === settings.ai_provider &&
          preferred === settings.model &&
          apiKey === settings.ai_api_key &&
          (res.provider === "custom" ? baseUrl.trim() : "") === (settings.ai_base_url ?? "");

        if (silent && unchanged) {
          setActiveAiConfig(aiConfigFromSettings(settings));
          return;
        }

        const saved = await persist(patch);
        if (saved) {
          setNote({
            tone: res.warning ? "info" : "ok",
            text: res.warning
              ? `${res.providerLabel} connected. ${res.warning}`
              : `${res.providerLabel} connected — key verified in ${res.probe.ms} ms. ${res.models.length} model${
                  res.models.length === 1 ? "" : "s"
                } detected. Now pick the model you want to use.`,
          });
        }
      } catch (err) {
        setNote({ tone: "bad", text: errorMessage(err) });
      } finally {
        setBusy(null);
      }
    },
    [baseUrl, keyInput, persist, providerChoice, settings],
  );

  useEffect(() => {
    detectRef.current = runDetect;
  }, [runDetect]);

  useEffect(() => {
    if (autoRan.current) return;
    if (!settings.ai_api_key) return;
    autoRan.current = true;
    void detectRef.current?.(true);
  }, [settings.ai_api_key]);

  const chooseModel = async (model: string) => {
    setNote(null);
    const saved = await persist({ model });
    if (saved) {
      const meta = getProvider(saved.ai_provider);
      setNote({ tone: "ok", text: `Model saved. All AI features now use ${meta?.label ?? saved.ai_provider} · ${model}.` });
    }
  };

  const test = async () => {
    setBusy("test");
    setNote(null);
    try {
      const res = await authedPost<TestResponse>("/api/ai/test", { model: settings.model });
      const meta = getProvider(res.provider ?? settings.ai_provider);
      setNote({
        tone: "ok",
        text: `${meta?.label ?? "AI"} replied "${res.reply}" using ${res.model} in ${res.ms} ms.`,
      });
    } catch (err) {
      setNote({ tone: "bad", text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const removeKey = async () => {
    if (!window.confirm("Remove this API key? AI features will fall back to the server's Gemini key if one is configured.")) {
      return;
    }
    setModels([]);
    setNote(null);
    const saved = await persist({
      ai_provider: "gemini",
      ai_api_key: "",
      ai_base_url: "",
      ai_verified_at: "",
      ai_key_hint: "",
      model: "gemini-3.5-flash",
    });
    setKeyInput("");
    setBaseUrl("");
    setProviderChoice("gemini");
    if (saved) setNote({ tone: "info", text: "Key removed. The server default key is used again." });
  };

  const modelOptions =
    models.length > 0
      ? models
      : settings.model
        ? [{ id: settings.model, label: settings.model }]
        : [];

  return (
    <Card
      title="AI engine"
      sub="Connect any provider. Paste a key and the app detects which AI it is, verifies it live, and loads its models."
      actions={
        connected ? (
          <Badge tone="ok">{activeMeta?.label ?? settings.ai_provider}</Badge>
        ) : (
          <Badge tone="warn">Server default</Badge>
        )
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        {note && <Banner tone={note.tone}>{note.text}</Banner>}

        <div className="grid grid-2">
          <Field label="Provider" hint="Leave on Auto-detect and the key's shape decides the provider.">
            <select
              className="select"
              value={providerChoice}
              onChange={(e) => {
                setProviderChoice(e.target.value);
                if (e.target.value === "custom") setAdvanced(true);
                setModels([]);
                if (keyInput.trim().length > 8) {
                  window.setTimeout(() => void detectRef.current?.(true), 300);
                }
              }}
            >
              <option value="auto">Auto-detect from key</option>
              {AI_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="API key"
            hint={
              connected && settings.ai_key_hint
                ? `Saved key ${settings.ai_key_hint} · verified ${settings.ai_verified_at ? new Date(settings.ai_verified_at).toLocaleString() : "recently"}`
                : "Stored in your private Firebase record and sent only to the provider you choose."
            }
          >
            <div className="row" style={{ gap: 8 }}>
              <input
                className="input"
                type={showKey ? "text" : "password"}
                value={keyInput}
                onChange={(e) => {
                  setKeyInput(e.target.value);
                  setProviderChoice("auto");
                  setModels([]);
                }}
                onPaste={() => {
                  // A pasted key is verified automatically once it lands in state.
                  window.setTimeout(() => void detectRef.current?.(true), 400);
                }}
                onBlur={() => {
                  if (keyInput.trim() && keyInput.trim() !== settings.ai_api_key) void runDetect(true);
                }}
                placeholder="sk-… or AIza…"
                autoComplete="off"
                spellCheck={false}
                style={{ flex: 1 }}
              />
              <button
                className="btn btn-sm btn-ghost"
                type="button"
                onClick={() => setShowKey((v) => !v)}
                title={showKey ? "Hide key" : "Show key"}
                aria-label={showKey ? "Hide API key" : "Show API key"}
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </Field>
        </div>

        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          <button
            className="btn btn-primary btn-sm"
            type="button"
            onClick={() => void runDetect(false)}
            disabled={busy !== null || !keyInput.trim()}
          >
            {busy === "detect" ? <Loader2 size={13} className="spin-icon" /> : <Plug size={13} />}
            <span>{busy === "detect" ? "Detecting provider & models…" : connected ? "Re-detect & refresh models" : "Connect & detect"}</span>
          </button>
          <button className="btn btn-sm" type="button" onClick={() => void test()} disabled={busy !== null || !connected}>
            <Zap size={13} />
            <span>{busy === "test" ? "Testing…" : "Test connection"}</span>
          </button>
          {connected && (
            <button className="btn btn-sm btn-ghost" type="button" onClick={() => void removeKey()} disabled={busy !== null}>
              <Trash2 size={13} />
              <span>Remove key</span>
            </button>
          )}
        </div>

        {connected && (
          <div className="grid grid-2">
            <Field
              label="Model"
              hint={
                models.length > 0
                  ? `${models.length} live models available. Changing this applies everywhere instantly.`
                  : "Re-detect to load the provider's model list."
              }
            >
              <div className="row" style={{ gap: 8 }}>
                <select
                  className="select"
                  value={settings.model}
                  onChange={(e) => void chooseModel(e.target.value)}
                  disabled={busy !== null || modelOptions.length === 0}
                  style={{ flex: 1 }}
                >
                  {modelOptions.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label === m.id ? m.id : `${m.label} · ${m.id}`}
                    </option>
                  ))}
                  {!modelOptions.some((m) => m.id === settings.model) && (
                    <option value={settings.model}>{settings.model}</option>
                  )}
                </select>
                <button
                  className="btn btn-sm btn-ghost"
                  type="button"
                  onClick={() => void runDetect(true)}
                  disabled={busy !== null}
                  title="Refresh model list"
                  aria-label="Refresh model list"
                >
                  <RefreshCw size={13} className={busy === "detect" ? "spin-icon" : undefined} />
                </button>
              </div>
            </Field>

            <div className="stack" style={{ gap: 8 }}>
              <div className="tiny" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <CheckCircle2 size={13} style={{ color: "var(--accent)" }} />
                <span>
                  Every AI feature (operator, research, qualification, writing, replies, analytics) uses{" "}
                  <strong>{activeMeta?.label ?? settings.ai_provider}</strong> with <strong>{settings.model}</strong>.
                </span>
              </div>
              <button
                className="btn btn-sm btn-ghost"
                type="button"
                onClick={() => setAdvanced((v) => !v)}
                aria-expanded={advanced}
                style={{ alignSelf: "flex-start" }}
              >
                <ChevronDown size={13} style={{ transform: advanced ? "rotate(180deg)" : "none" }} />
                <span>{advanced ? "Hide advanced" : "Advanced: custom base URL"}</span>
              </button>
            </div>
          </div>
        )}

        {(advanced || needsBaseUrl) && (
          <Field
            label="Base URL"
            hint={
              needsBaseUrl
                ? "Required for custom providers. Must be an OpenAI-compatible public https endpoint ending in /v1."
                : "Optional override. Leave blank to use the provider's official endpoint."
            }
          >
            <input
              className="input"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={needsBaseUrl ? "https://your-gateway.example.com/v1" : activeMeta?.baseUrl || "https://api.example.com/v1"}
              spellCheck={false}
            />
          </Field>
        )}

        <div className="row" style={{ gap: 8 }}>
          <KeyRound size={14} style={{ color: "var(--accent)" }} />
          <span className="tiny">
            {activeMeta?.docsUrl ? (
              <>
                Get a key from{" "}
                <a href={activeMeta.docsUrl} target="_blank" rel="noreferrer">
                  {activeMeta.docsLabel || activeMeta.docsUrl}
                </a>
                .{" "}
              </>
            ) : null}
            {activeMeta?.blurb}
          </span>
        </div>
      </div>
    </Card>
  );
}
