"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  KeyRound,
  Loader2,
  ShieldCheck,
  TestTube2,
  Trash2,
  Zap,
} from "lucide-react";
import { getAccessToken } from "@/lib/auth";
import { authedPost, errorMessage } from "@/lib/client";
import {
  getProviderMeta,
  type AiExecutionLogRecord,
  type GatewayModelConfig,
  type GatewayProviderId,
  type GatewayReceipt,
  type ProviderCatalogMeta,
  type UserAiKeyPublic,
  type UserAiSettings,
} from "@/lib/llm/types";
import { Badge, Banner, Card, Field } from "./ui";
import { useConfirm, useToast } from "./Feedback";

interface UserGatewayStatePayload {
  settings: UserAiSettings;
  keys: UserAiKeyPublic[];
  catalog: ProviderCatalogMeta[];
  recentLogs: AiExecutionLogRecord[];
}

interface VerifiedModelResult {
  provider: GatewayProviderId;
  providerLabel: string;
  models: { id: string; label: string; isFreeTier?: boolean }[];
  recommendedModel: string;
  probe: { model: string; ms: number };
  warning?: string;
}

export function AiProviderSettingsCard() {
  const confirmDialog = useConfirm();
  const toast = useToast();

  const [state, setState] = useState<UserGatewayStatePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Add personal key form
  const [provider, setProvider] = useState<GatewayProviderId | "auto">("auto");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [accountIdInput, setAccountIdInput] = useState("");
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [freeTierOnly, setFreeTierOnly] = useState(true);
  const [testedModels, setTestedModels] = useState<GatewayModelConfig[]>([]);
  const [detectedProvider, setDetectedProvider] = useState<GatewayProviderId | null>(null);
  const [selectedModelInput, setSelectedModelInput] = useState("");
  const [customModelInput, setCustomModelInput] = useState("");
  const [verifyBanner, setVerifyBanner] = useState<string | null>(null);

  // Live Proof Receipt from "Test Active Model"
  const [activeProof, setActiveProof] = useState<{
    providerLabel: string;
    receipt: GatewayReceipt;
    reply: string;
  } | null>(null);

  const loadState = useCallback(async () => {
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) return;
      const res = await fetch("/api/account/ai-provider", {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        cache: "no-store",
      });
      const json = (await res.json()) as UserGatewayStatePayload & { error?: string };
      if (!res.ok) throw new Error(json.error || "Failed to load AI provider settings.");
      setState(json);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => void loadState(), 0);
    return () => window.clearTimeout(t);
  }, [loadState]);

  const postAction = async (
    payload: Record<string, unknown>,
    busyKey: string,
    successTitle?: string,
  ): Promise<UserGatewayStatePayload | null> => {
    setBusy(busyKey);
    setError(null);
    try {
      const res = await authedPost<UserGatewayStatePayload>("/api/account/ai-provider", payload);
      setState(res);
      setActiveProof(null);
      if (successTitle) toast.success(successTitle);
      return res;
    } catch (err) {
      const msg = errorMessage(err);
      setError(msg);
      toast.error("Update failed", msg);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const handleVerifyAndLoadModels = async () => {
    if (!apiKeyInput.trim()) return;
    setBusy("verify_key");
    setError(null);
    setVerifyBanner(null);
    try {
      const res = await authedPost<VerifiedModelResult>("/api/ai/provider", {
        provider: provider === "auto" ? undefined : provider,
        apiKey: apiKeyInput.trim(),
        accountId: accountIdInput.trim() || undefined,
        baseUrl: baseUrlInput.trim() || undefined,
        freeTierOnly,
      });

      const meta = getProviderMeta(res.provider);
      const mappedModels: GatewayModelConfig[] =
        res.models.length > 0
          ? res.models.map((m) => ({
              id: m.id,
              displayName: m.label || m.id,
              enabled: true,
              seats: ["smart", "balanced", "fast"],
              capabilities: { json: true, tools: true, vision: false, reasoning: true },
              isFreeTier: m.isFreeTier,
            }))
          : meta.defaultModels;

      setDetectedProvider(res.provider);
      setProvider(res.provider);
      setTestedModels(mappedModels);
      setSelectedModelInput(res.recommendedModel || mappedModels[0]?.id || "");
      setVerifyBanner(
        `Verified ${res.providerLabel} key (${mappedModels.length} models · ${res.probe.ms}ms). Pick your exact model and click Save Key.${res.warning ? ` Note: ${res.warning}` : ""}`,
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const handleSavePersonalKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKeyInput.trim()) return;
    const chosenProvider = provider === "auto" ? detectedProvider || "google" : provider;
    const meta = getProviderMeta(chosenProvider);
    const chosenModel = customModelInput.trim() || selectedModelInput || testedModels[0]?.id || meta.defaultModels[0]?.id;

    const updated = await postAction(
      {
        action: "save_key",
        provider: chosenProvider,
        apiKey: apiKeyInput.trim(),
        accountId: accountIdInput.trim() || undefined,
        baseUrl: baseUrlInput.trim() || undefined,
        model: chosenModel,
        models: testedModels.length > 0 ? testedModels : meta.defaultModels,
      },
      "save_key",
      "Personal API key encrypted & activated",
    );

    if (updated) {
      setApiKeyInput("");
      setAccountIdInput("");
      setBaseUrlInput("");
      setCustomModelInput("");
      setTestedModels([]);
      setVerifyBanner(null);
    }
  };

  const handleDeletePersonalKey = async (id: string, label: string) => {
    const ok = await confirmDialog({
      title: `Delete your ${label} key?`,
      message: "Your encrypted key will be permanently deleted from the server vault. If no other key remains, your account returns to Managed Free Engine.",
      confirmLabel: "Delete key permanently",
      tone: "bad",
    });
    if (!ok) return;

    setBusy(`delete:${id}`);
    try {
      const token = await getAccessToken();
      const res = await fetch(`/api/account/ai-provider?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = (await res.json()) as UserGatewayStatePayload & { error?: string };
      if (!res.ok) throw new Error(json.error || "Could not delete API key.");
      setState(json);
      setActiveProof(null);
      toast.success("Key deleted permanently");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const handleTestActiveModel = async () => {
    setBusy("test_active");
    setError(null);
    setActiveProof(null);
    try {
      const res = await authedPost<{
        verified: boolean;
        providerLabel: string;
        receipt: GatewayReceipt;
        reply: string;
      }>("/api/account/ai-provider", { action: "test_active" });
      setActiveProof({
        providerLabel: res.providerLabel,
        receipt: res.receipt,
        reply: res.reply,
      });
      toast.success("Active model verified", `${res.providerLabel} · ${res.receipt.actualModel} (${res.receipt.latencyMs}ms)`);
      void loadState();
    } catch (err) {
      const msg = errorMessage(err);
      setError(msg);
      toast.error("Active model check failed", msg);
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <Card title="AI Engine & Model Routing" sub="Loading active mode and keys…">
        <div className="row tiny muted" style={{ gap: 8 }}>
          <Loader2 size={14} className="spin" /> Loading AI engine settings…
        </div>
      </Card>
    );
  }

  const settings = state?.settings;
  const mode = settings?.mode ?? "system_auto";
  const keys = state?.keys ?? [];
  const catalog = state?.catalog ?? [];
  const activeKey = keys.find((k) => k.id === settings?.activeKeyId) ?? keys[0] ?? null;
  const activeProviderMeta =
    provider !== "auto" ? getProviderMeta(provider) : getProviderMeta("google");
  const modelChoices =
    testedModels.length > 0
      ? testedModels
      : provider !== "auto"
        ? activeProviderMeta.defaultModels
        : [];

  return (
    <Card
      title="AI Engine & API Key Mode"
      sub="Switch cleanly between Managed Free Engine auto-routing or your own strict Bring-Your-Own-Key (BYOK) configuration."
      actions={
        <Badge tone={mode === "byok" && activeKey ? "ok" : "info"}>
          {mode === "byok" && activeKey
            ? `BYOK: ${getProviderMeta(activeKey.provider).label} · ${settings?.activeModel || activeKey.models[0]?.id}`
            : "Managed Free Engine (Auto)"}
        </Badge>
      }
    >
      <div className="stack" style={{ gap: 16 }}>
        {error && <Banner tone="bad">{error}</Banner>}

        {/* Strict 2-Option Mode Switcher */}
        <div className="grid grid-2" style={{ gap: 10 }}>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() =>
              void postAction({ action: "set_mode", mode: "system_auto" }, "mode_auto", "Switched to Managed Free Engine (Auto)")
            }
            style={{
              textAlign: "left",
              padding: 14,
              borderRadius: 10,
              border: `1.5px solid ${mode === "system_auto" ? "var(--teal-deep, #0f766e)" : "var(--line)"}`,
              background: mode === "system_auto" ? "var(--accent-soft, rgba(15,118,110,0.08))" : "var(--surface)",
              cursor: "pointer",
            }}
          >
            <div className="row" style={{ gap: 8, marginBottom: 4 }}>
              <Zap size={15} style={{ color: "var(--teal-deep)" }} />
              <span className="strong" style={{ fontSize: 13.5 }}>Auto (Managed Free Engine)</span>
              {mode === "system_auto" && <Badge tone="ok">Active</Badge>}
            </div>
            <div className="tiny muted">
              Zero setup. Routes automatically across healthy free-tier keys with silent rate-limit failover.
            </div>
          </button>

          <button
            type="button"
            disabled={busy !== null || keys.length === 0}
            onClick={() =>
              void postAction({ action: "set_mode", mode: "byok" }, "mode_byok", "Switched to your personal API key (BYOK)")
            }
            style={{
              textAlign: "left",
              padding: 14,
              borderRadius: 10,
              border: `1.5px solid ${mode === "byok" ? "var(--teal-deep, #0f766e)" : "var(--line)"}`,
              background: mode === "byok" ? "var(--accent-soft, rgba(15,118,110,0.08))" : "var(--surface)",
              cursor: keys.length === 0 ? "not-allowed" : "pointer",
              opacity: keys.length === 0 ? 0.65 : 1,
            }}
          >
            <div className="row" style={{ gap: 8, marginBottom: 4 }}>
              <KeyRound size={15} />
              <span className="strong" style={{ fontSize: 13.5 }}>Use My Own API Key (BYOK)</span>
              {mode === "byok" && <Badge tone="ok">Active</Badge>}
            </div>
            <div className="tiny muted">
              {keys.length > 0
                ? "Strict isolation: every AI call executes only on your chosen saved key and exact model."
                : "Save an API key below to unlock Bring-Your-Own-Key mode."}
            </div>
          </button>
        </div>

        {/* Mandatory "Test Active Model" Live Verification Proof */}
        <div
          style={{
            padding: 12,
            borderRadius: 10,
            border: "1px solid var(--line)",
            background: "var(--surface)",
          }}
        >
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div>
              <div className="strong" style={{ fontSize: 13 }}>Verify Active AI Execution</div>
              <div className="tiny muted">
                Runs a real server-side probe through the unified gateway and shows the exact provider and model that answered.
              </div>
            </div>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy !== null}
              onClick={() => void handleTestActiveModel()}
            >
              {busy === "test_active" ? <Loader2 size={13} className="spin" /> : <TestTube2 size={13} />}
              Test Active Model
            </button>
          </div>

          {activeProof && (
            <div style={{ marginTop: 10 }}>
              <Banner tone="ok">
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  <CheckCircle2 size={14} />
                  <strong>
                    Verified: Answered by {activeProof.providerLabel} / {activeProof.receipt.actualModel} in {activeProof.receipt.latencyMs}ms
                  </strong>
                  <span className="tiny">
                    (Mode: {activeProof.receipt.requestedMode} · Fallback hops: {activeProof.receipt.fallbackHops} · Reply: &ldquo;{activeProof.reply}&rdquo;)
                  </span>
                </div>
              </Banner>
            </div>
          )}
        </div>

        {/* Saved Personal Keys & Exact Model Selector */}
        {keys.length > 0 && (
          <div className="stack" style={{ gap: 10 }}>
            <div className="strong" style={{ fontSize: 13 }}>Saved Personal Keys &amp; Exact Model</div>
            {keys.map((k) => {
              const meta = getProviderMeta(k.provider);
              const isSelected = mode === "byok" && activeKey?.id === k.id;
              const currentModelForKey =
                isSelected && settings?.activeModel
                  ? settings.activeModel
                  : k.models[0]?.id || meta.defaultModels[0]?.id || "";
              const availableModels = k.models.length > 0 ? k.models : meta.defaultModels;

              return (
                <div
                  key={k.id}
                  style={{
                    padding: 12,
                    borderRadius: 10,
                    border: `1px solid ${isSelected ? "var(--teal-deep)" : "var(--line)"}`,
                    background: "var(--surface)",
                  }}
                >
                  <div className="row" style={{ justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                    <div>
                      <div className="row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        <span className="strong">{k.label || meta.label}</span>
                        <Badge>{meta.label}</Badge>
                        <Badge>{k.maskedKey}</Badge>
                        {isSelected && <Badge tone="ok">Active</Badge>}
                      </div>
                      {k.lastError && (
                        <div className="tiny" style={{ color: "#b91c1c", marginTop: 3 }}>
                          Last error: {k.lastError}
                        </div>
                      )}
                    </div>

                    <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                      <select
                        className="select"
                        aria-label={`Model for ${meta.label}`}
                        value={currentModelForKey}
                        disabled={busy !== null}
                        onChange={(e) =>
                          void postAction(
                            {
                              action: "select_key_and_model",
                              keyId: k.id,
                              model: e.target.value,
                            },
                            `select_${k.id}`,
                            `Active model switched to ${e.target.value}`,
                          )
                        }
                      >
                        {!availableModels.some((m) => m.id === currentModelForKey) && currentModelForKey && (
                          <option value={currentModelForKey}>{currentModelForKey}</option>
                        )}
                        {availableModels.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.displayName || m.id}
                          </option>
                        ))}
                      </select>

                      {!isSelected && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy !== null}
                          onClick={() =>
                            void postAction(
                              {
                                action: "select_key_and_model",
                                keyId: k.id,
                                model: currentModelForKey,
                              },
                              `activate_${k.id}`,
                              `Activated ${meta.label}`,
                            )
                          }
                        >
                          Use This Key
                        </button>
                      )}

                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        disabled={busy !== null}
                        onClick={() => void handleDeletePersonalKey(k.id, meta.label)}
                        title="Delete personal key"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Explicit Fallback Warning Checkbox (OFF by default) */}
            <div
              style={{
                padding: 12,
                borderRadius: 10,
                border: "1px solid var(--line)",
                background: "var(--surface)",
              }}
            >
              <label className="row" style={{ gap: 8, cursor: "pointer", alignItems: "flex-start" }}>
                <input
                  type="checkbox"
                  checked={Boolean(settings?.fallbackToSystemAuto)}
                  disabled={busy !== null}
                  onChange={(e) =>
                    void postAction(
                      { action: "set_fallback", fallbackToSystemAuto: e.target.checked },
                      "toggle_fallback",
                      e.target.checked
                        ? "Fallback to Managed Free Engine enabled"
                        : "Strict BYOK isolation restored",
                    )
                  }
                  style={{ marginTop: 3 }}
                />
                <div>
                  <div className="strong" style={{ fontSize: 13 }}>
                    Fall back to Managed Free Engine if my personal key fails or hits rate limits
                  </div>
                  <div className="tiny muted row" style={{ gap: 4, marginTop: 2 }}>
                    <AlertTriangle size={12} />
                    <span>
                      Off by default so your chosen BYOK model never silently switches unless you opt in.
                    </span>
                  </div>
                </div>
              </label>
            </div>
          </div>
        )}

        {/* Add / Connect New Personal Key Form */}
        <form
          onSubmit={(e) => void handleSavePersonalKey(e)}
          className="stack"
          style={{
            gap: 10,
            padding: 14,
            borderRadius: 10,
            border: "1px solid var(--line)",
            background: "var(--surface)",
          }}
        >
          <div className="row" style={{ gap: 6, alignItems: "center" }}>
            <KeyRound size={14} />
            <span className="strong" style={{ fontSize: 13.5 }}>Connect New API Key (BYOK)</span>
          </div>

          <div className="grid grid-2" style={{ gap: 10 }}>
            <Field label="AI Provider">
              <select
                className="select"
                value={provider}
                onChange={(e) => {
                  const val = e.target.value as GatewayProviderId | "auto";
                  setProvider(val);
                  setDetectedProvider(val === "auto" ? null : val);
                  setTestedModels([]);
                  setVerifyBanner(null);
                  if (val !== "auto") {
                    const meta = getProviderMeta(val);
                    setBaseUrlInput(meta.baseUrl || "");
                    setSelectedModelInput(meta.defaultModels[0]?.id || "");
                  } else {
                    setBaseUrlInput("");
                    setSelectedModelInput("");
                  }
                }}
              >
                <option value="auto">Auto-detect from key prefix</option>
                {catalog.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="API Key" hint="Encrypted on server with AES-256-GCM. Never exposed back to the browser.">
              <input
                className="input"
                type="password"
                autoComplete="off"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder="Paste your API key (AIza..., nvapi-..., gsk_..., sk-...)..."
              />
            </Field>
          </div>

          {provider === "cloudflare" && (
            <Field label="Cloudflare Account ID" hint="Required by Cloudflare Workers AI.">
              <input
                className="input"
                type="text"
                value={accountIdInput}
                onChange={(e) => setAccountIdInput(e.target.value)}
                placeholder="32-character Cloudflare Account ID"
              />
            </Field>
          )}

          {(provider === "custom" || provider === "zai") && (
            <Field label="API Base URL" hint="Public https:// endpoint URL.">
              <input
                className="input"
                type="url"
                value={baseUrlInput}
                onChange={(e) => setBaseUrlInput(e.target.value)}
                placeholder="https://api.example.com/v1"
              />
            </Field>
          )}

          {provider === "openrouter" && (
            <label className="row tiny" style={{ gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={freeTierOnly}
                onChange={(e) => setFreeTierOnly(e.target.checked)}
              />
              <span>Show free-tier `:free` OpenRouter models only</span>
            </label>
          )}

          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!apiKeyInput.trim() || busy !== null}
              onClick={() => void handleVerifyAndLoadModels()}
            >
              {busy === "verify_key" ? <Loader2 size={12} className="spin" /> : <Cpu size={12} />}
              Verify &amp; Load Models
            </button>

            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={!apiKeyInput.trim() || busy !== null}
            >
              {busy === "save_key" ? <Loader2 size={12} className="spin" /> : <ShieldCheck size={12} />}
              Save Key &amp; Switch to BYOK
            </button>
          </div>

          {verifyBanner && <Banner tone="ok">{verifyBanner}</Banner>}

          {(modelChoices.length > 0 || customModelInput) && (
            <div className="grid grid-2" style={{ gap: 10 }}>
              <Field label="Exact Model">
                <select
                  className="select"
                  value={selectedModelInput}
                  onChange={(e) => setSelectedModelInput(e.target.value)}
                >
                  {modelChoices.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName || m.id}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Or Custom Model ID (optional)">
                <input
                  className="input"
                  type="text"
                  value={customModelInput}
                  onChange={(e) => setCustomModelInput(e.target.value)}
                  placeholder="Overrides dropdown if filled"
                />
              </Field>
            </div>
          )}
        </form>

        {/* Recent User Execution Receipts */}
        {state && state.recentLogs.length > 0 && (
          <div className="stack" style={{ gap: 6 }}>
            <div className="strong tiny muted">Recent AI Execution Receipts (Account)</div>
            <div style={{ overflowX: "auto" }}>
              <table className="table" style={{ width: "100%", fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>Feature</th>
                    <th>Seat</th>
                    <th>Provider &amp; Model</th>
                    <th>Hops</th>
                    <th>Latency</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {state.recentLogs.slice(0, 6).map((log) => (
                    <tr key={log.id}>
                      <td>{log.feature}</td>
                      <td>{log.taskType}</td>
                      <td>
                        <strong>{log.actualProvider || "—"}</strong> {log.actualModel || ""}
                      </td>
                      <td>{log.fallbackHops}</td>
                      <td>{log.latencyMs}ms</td>
                      <td>
                        <Badge tone={log.status === "success" ? "ok" : "bad"}>{log.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
