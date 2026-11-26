"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  KeyRound,
  Loader2,
  ShieldCheck,
  Sparkles,
  TestTube2,
  Trash2,
} from "lucide-react";
import { AI_PROVIDERS, guessProviderId } from "@/lib/ai/registry";
import type { AiProviderId } from "@/lib/ai/types";
import { authedPost, errorMessage } from "@/lib/client";
import { getAccessToken } from "@/lib/auth";
import type { UserByokPublicState } from "@/lib/platform/types";
import { Badge, Banner, Card, Field } from "./ui";
import { useConfirm, useToast } from "./Feedback";

export function AiProviderSettingsCard() {
  const confirmDialog = useConfirm();
  const toast = useToast();

  const [state, setState] = useState<UserByokPublicState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Add / rotate personal key form (plaintext exists only in local component state before submit, cleared immediately!)
  const [provider, setProvider] = useState<AiProviderId | "auto">("auto");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [testedModels, setTestedModels] = useState<{ id: string; label: string }[]>([]);
  const [detectedProvider, setDetectedProvider] = useState<AiProviderId | null>(null);
  const [selectedModelInput, setSelectedModelInput] = useState("");
  const [testNote, setTestNote] = useState<string | null>(null);

  const loadState = useCallback(async () => {
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) return;
      const res = await fetch("/api/account/ai-provider", {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        cache: "no-store",
      });
      const json = (await res.json()) as { state?: UserByokPublicState; error?: string };
      if (!res.ok) throw new Error(json.error || "Failed to load AI provider state.");
      if (json.state) setState(json.state);
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

  const postAction = async (payload: Record<string, unknown>, busyKey: string, successTitle?: string) => {
    setBusy(busyKey);
    setError(null);
    try {
      const res = await authedPost<{ state: UserByokPublicState }>("/api/account/ai-provider", payload);
      setState(res.state);
      if (successTitle) toast.success(successTitle);
      return res.state;
    } catch (err) {
      const msg = errorMessage(err);
      setError(msg);
      toast.error("Update failed", msg);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const handleTestPersonalKey = async () => {
    if (!apiKeyInput.trim()) return;
    setBusy("test_key");
    setError(null);
    setTestNote(null);
    try {
      const res = await authedPost<{
        provider: AiProviderId;
        providerLabel: string;
        models: { id: string; label: string }[];
        recommendedModel: string;
        probe: { model: string; ms: number };
      }>("/api/ai/provider", {
        provider: provider === "auto" ? undefined : provider,
        apiKey: apiKeyInput.trim(),
        baseUrl: baseUrlInput.trim() || undefined,
      });
      setDetectedProvider(res.provider);
      setProvider(res.provider);
      setTestedModels(res.models);
      setSelectedModelInput(res.recommendedModel || res.models[0]?.id || "");
      setTestNote(`Verified ${res.providerLabel} key (${res.models.length} models · ${res.probe.ms}ms). Click Save key below.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const handleSavePersonalKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKeyInput.trim()) return;
    const guessed = provider === "auto" ? guessProviderId(apiKeyInput.trim()) : provider;
    const finalProvider = detectedProvider || guessed;
    if (!finalProvider) {
      setError("Could not detect provider from key format. Please select the provider from the dropdown.");
      return;
    }

    const saved = await postAction(
      {
        action: "save_personal_key",
        provider: finalProvider,
        apiKey: apiKeyInput.trim(),
        baseUrl: baseUrlInput.trim() || undefined,
        model: selectedModelInput || testedModels[0]?.id,
        models: testedModels,
      },
      "save_key",
      "Personal API key encrypted & saved",
    );

    if (saved) {
      // Clear raw key from browser memory immediately after saving
      setApiKeyInput("");
      setBaseUrlInput("");
      setTestNote(null);
      setTestedModels([]);
    }
  };

  const handleDeletePersonalKey = async (id: string, label: string) => {
    const ok = await confirmDialog({
      title: `Permanently delete your ${label} key?`,
      message: "Your key will be deleted permanently from the encrypted server vault and new requests will switch back to platform models.",
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
      const json = (await res.json()) as { state?: UserByokPublicState; error?: string };
      if (!res.ok) throw new Error(json.error || "Could not remove key.");
      if (json.state) setState(json.state);
      toast.success("Personal key deleted", "Switched back to platform shared models.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <Card title="AI Provider" sub="Loading key & model configuration…">
        <div className="row tiny muted" style={{ gap: 8 }}>
          <Loader2 size={14} className="spin" /> Loading AI provider status…
        </div>
      </Card>
    );
  }

  const activeMode = state?.mode ?? "platform";
  const activePersonal = state?.activePersonalProvider ?? null;

  return (
    <Card
      title="AI Provider"
      sub="Choose between platform-managed shared models or your own encrypted API key."
      actions={
        <Badge tone={activeMode === "personal" ? "ok" : "info"}>
          {activeMode === "personal" && activePersonal
            ? `Using your ${activePersonal.label} key (${activePersonal.maskedKey})`
            : "Using platform key"}
        </Badge>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        {error && <Banner tone="bad">{error}</Banner>}

        {/* Active Mode Switcher */}
        <div className="grid grid-2" style={{ gap: 10 }}>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void postAction({ action: "set_mode", mode: "platform" }, "mode_platform", "Switched to platform models")}
            style={{
              textAlign: "left",
              padding: 14,
              borderRadius: 10,
              border: `1.5px solid ${activeMode === "platform" ? "var(--teal-deep, #0f766e)" : "var(--line)"}`,
              background: activeMode === "platform" ? "var(--accent-soft, rgba(15,118,110,0.08))" : "var(--surface)",
              cursor: "pointer",
            }}
          >
            <div className="row" style={{ gap: 8, marginBottom: 4 }}>
              <Cpu size={15} style={{ color: "var(--teal-deep)" }} />
              <span className="strong" style={{ fontSize: 13.5 }}>Use platform models</span>
              {activeMode === "platform" && <Badge tone="ok">Active</Badge>}
            </div>
            <div className="tiny muted">
              Zero setup. Runs on admin-managed shared keys and enabled models within your workspace quota.
            </div>
          </button>

          <button
            type="button"
            disabled={busy !== null || !state || state.personalProviders.length === 0}
            onClick={() => void postAction({ action: "set_mode", mode: "personal" }, "mode_personal", "Switched to your personal API key")}
            style={{
              textAlign: "left",
              padding: 14,
              borderRadius: 10,
              border: `1.5px solid ${activeMode === "personal" ? "var(--teal-deep, #0f766e)" : "var(--line)"}`,
              background: activeMode === "personal" ? "var(--accent-soft, rgba(15,118,110,0.08))" : "var(--surface)",
              cursor: state && state.personalProviders.length > 0 ? "pointer" : "not-allowed",
              opacity: state && state.personalProviders.length === 0 ? 0.72 : 1,
            }}
          >
            <div className="row" style={{ gap: 8, marginBottom: 4 }}>
              <KeyRound size={15} style={{ color: "var(--teal-deep)" }} />
              <span className="strong" style={{ fontSize: 13.5 }}>Use my own API key</span>
              {activeMode === "personal" && <Badge tone="ok">Active</Badge>}
            </div>
            <div className="tiny muted">
              Bring your own key (Anthropic, OpenAI, Gemini, OpenRouter, etc.). Does not count against platform quotas.
            </div>
          </button>
        </div>

        {/* Platform Mode Section */}
        {activeMode === "platform" && state && (
          <div
            style={{
              padding: 12,
              borderRadius: 10,
              border: "1px solid var(--line)",
              background: "var(--surface-2)",
            }}
          >
            <div className="stack" style={{ gap: 10 }}>
              <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <div>
                  <div className="strong" style={{ fontSize: 13 }}>Enabled platform models</div>
                  <div className="tiny muted">Only models enabled by your administrator are selectable here.</div>
                </div>
                <div className="tiny">
                  Platform quota:{" "}
                  <strong>
                    {state.usageStats.platformRequestsToday}/{state.usageStats.platformDailyLimit}
                  </strong>{" "}
                  today ·{" "}
                  <strong>
                    {state.usageStats.platformRequestsMonth}/{state.usageStats.platformMonthlyLimit}
                  </strong>{" "}
                  this month
                </div>
              </div>

              {state.platformModels.length === 0 ? (
                <Banner tone="warn">
                  No platform models are currently enabled. Ask an administrator to add a platform key in the Admin
                  Dashboard, or add your own API key below.
                </Banner>
              ) : (
                <Field label="Preferred platform model (when overriding feature defaults)">
                  <select
                    className="input"
                    value={
                      state.selectedPlatformModel
                        ? `${state.selectedPlatformModel.provider}::${state.selectedPlatformModel.model}`
                        : ""
                    }
                    onChange={(e) => {
                      const val = e.target.value;
                      if (!val) return;
                      const [prov, mod] = val.split("::");
                      void postAction(
                        { action: "select_platform_model", provider: prov, model: mod },
                        "plat_model",
                        "Platform model preference updated",
                      );
                    }}
                  >
                    <option value="">Use admin feature defaults automatically</option>
                    {state.platformModels.map((m) => (
                      <option key={`${m.provider}::${m.model}`} value={`${m.provider}::${m.model}`}>
                        {m.providerLabel} — {m.displayName}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
          </div>
        )}

        {/* Saved Personal Keys List */}
        {state && state.personalProviders.length > 0 && (
          <div className="stack" style={{ gap: 8 }}>
            <div className="strong" style={{ fontSize: 13 }}>Your saved personal keys (encrypted at rest)</div>
            {state.personalProviders.map((prov) => {
              const isCurrent = state.activePersonalProviderId === prov.id;
              return (
                <div
                  key={prov.id}
                  style={{
                    padding: 12,
                    borderRadius: 10,
                    border: `1px solid ${isCurrent && activeMode === "personal" ? "var(--teal-deep)" : "var(--line)"}`,
                    background: "var(--surface)",
                  }}
                >
                  <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                    <div>
                      <div className="row" style={{ gap: 8 }}>
                        <span className="strong">{prov.label}</span>
                        <Badge>{prov.maskedKey}</Badge>
                        {isCurrent && activeMode === "personal" && <Badge tone="ok">Selected</Badge>}
                      </div>
                      <div className="tiny muted" style={{ marginTop: 2 }}>
                        Model: <strong>{prov.model}</strong>
                        {prov.verifiedAt ? ` · Saved ${new Date(prov.verifiedAt).toLocaleDateString()}` : ""}
                      </div>
                    </div>

                    <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                      {prov.models.length > 0 && (
                        <select
                          className="input"
                          style={{ width: "auto", minWidth: 160 }}
                          value={prov.model}
                          onChange={(e) =>
                            void postAction(
                              { action: "select_personal_model", id: prov.id, model: e.target.value },
                              `model_${prov.id}`,
                              "Personal model updated",
                            )
                          }
                        >
                          {prov.models.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.label || m.id}
                            </option>
                          ))}
                        </select>
                      )}
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => void handleDeletePersonalKey(prov.id, prov.label)}
                        disabled={busy === `delete:${prov.id}`}
                        title="Delete personal key permanently"
                      >
                        <Trash2 size={13} />
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Personal Key Failure Fallback Permission */}
            <label className="row tiny" style={{ gap: 8, cursor: "pointer", paddingTop: 4 }}>
              <input
                type="checkbox"
                checked={state.allowFallbackOnError}
                onChange={(e) =>
                  void postAction(
                    { action: "set_fallback_permission", allowFallbackOnError: e.target.checked },
                    "fallback_perm",
                    e.target.checked
                      ? "Automatic fallback to platform key enabled"
                      : "Automatic fallback disabled",
                  )
                }
              />
              <span>
                Allow automatic fallback to platform shared keys if my personal key fails or runs out of credit (if
                unchecked, you&apos;ll be asked before any switch).
              </span>
            </label>

            {/* Personal Usage Telemetry */}
            <div
              className="row tiny muted"
              style={{
                justifyContent: "space-between",
                padding: "8px 12px",
                borderRadius: 8,
                background: "var(--surface-2)",
              }}
            >
              <span>
                Your personal key usage this month:{" "}
                <strong>{state.usageStats.personalRequestsMonth}</strong> requests ·{" "}
                <strong>{state.usageStats.personalTokensMonth.toLocaleString()}</strong> tokens
              </span>
              <span>Est. cost: ${state.usageStats.personalCostMonthUsd.toFixed(4)}</span>
            </div>
          </div>
        )}

        {/* Add or Replace Personal Key Form */}
        <form
          onSubmit={handleSavePersonalKey}
          style={{
            padding: 14,
            borderRadius: 10,
            border: "1px dashed var(--line)",
            background: "var(--surface-2)",
          }}
        >
          <div className="strong" style={{ fontSize: 13, marginBottom: 8 }}>
            {state && state.personalProviders.length > 0 ? "Add or replace a personal API key" : "Add your own API key"}
          </div>

          <div className="grid grid-2" style={{ gap: 10, marginBottom: 10 }}>
            <Field label="Provider">
              <select
                className="input"
                value={provider}
                onChange={(e) => setProvider(e.target.value as AiProviderId | "auto")}
              >
                <option value="auto">Auto-detect from key</option>
                {AI_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="API Key" hint="Stored AES-256-GCM encrypted on our server; shown masked after saving.">
              <input
                className="input"
                type="password"
                autoComplete="off"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder="Paste sk-..., AIza..., sk-ant-..."
              />
            </Field>
          </div>

          {provider === "custom" && (
            <div style={{ marginBottom: 10 }}>
              <Field label="Custom OpenAI-compatible Base URL">
                <input
                  className="input"
                  value={baseUrlInput}
                  onChange={(e) => setBaseUrlInput(e.target.value)}
                  placeholder="https://your-endpoint.example/v1"
                />
              </Field>
            </div>
          )}

          {testedModels.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <Field label="Model to use">
                <select
                  className="input"
                  value={selectedModelInput}
                  onChange={(e) => setSelectedModelInput(e.target.value)}
                >
                  {testedModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label || m.id}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}

          {testNote && (
            <div className="tiny" style={{ color: "var(--teal-deep)", marginBottom: 8 }}>
              <CheckCircle2 size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />
              {testNote}
            </div>
          )}

          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!apiKeyInput.trim() || busy !== null}
              onClick={() => void handleTestPersonalKey()}
            >
              {busy === "test_key" ? <Loader2 size={12} className="spin" /> : <TestTube2 size={12} />}
              {busy === "test_key" ? "Testing…" : "Test key"}
            </button>
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={!apiKeyInput.trim() || busy !== null}
            >
              {busy === "save_key" ? <Loader2 size={12} className="spin" /> : <Sparkles size={12} />}
              {busy === "save_key" ? "Encrypting & saving…" : "Save encrypted key"}
            </button>
          </div>
        </form>

        <div className="row tiny muted" style={{ gap: 6, alignItems: "flex-start" }}>
          <ShieldCheck size={14} style={{ flexShrink: 0, marginTop: 2, color: "var(--teal-deep)" }} />
          <span>
            <strong>Zero browser key exposure:</strong> API keys are encrypted at rest on the server, never sent back to
            your browser or stored in localStorage, and all AI calls execute strictly server-side. Administrators cannot
            read your personal key, and regular users cannot view platform keys.
          </span>
        </div>
        {activeMode === "platform" && state && state.usageStats.platformRequestsToday >= state.usageStats.platformDailyLimit && (
          <Banner tone="warn">
            <div className="row tiny" style={{ gap: 8 }}>
              <AlertTriangle size={14} />
              <span>You have reached your daily platform quota. Add your own key above to continue immediately.</span>
            </div>
          </Banner>
        )}
      </div>
    </Card>
  );
}
