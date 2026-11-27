"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  CheckCircle2,
  Cpu,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Sliders,
  TestTube2,
  Trash2,
  Globe,
  Zap,
} from "lucide-react";
import {
  getProviderMeta,
  getSearchProviderMeta,
  type AdminAiKeyPublic,
  type AdminAiSettings,
  type AdminSearchKeyPublic,
  type AiExecutionLogRecord,
  type GatewayModelConfig,
  type GatewayProviderId,
  type ProviderCatalogMeta,
  type RoutingStrategy,
  type SearchProviderId,
  type SearchProviderMeta,
  type TaskSeat,
} from "@/lib/llm/types";
import type { AdminRole } from "@/lib/platform/types";
import { Badge, Banner, Card, Empty, Field, Modal } from "../ui";
import { BrandLoader } from "../BrandLoader";
import { useConfirm, useToast } from "../Feedback";
import { AdminClientError, adminFetch } from "./admin-client";

interface GatewayAdminPayload {
  settings: AdminAiSettings;
  keys: AdminAiKeyPublic[];
  catalog: ProviderCatalogMeta[];
  searchKeys?: AdminSearchKeyPublic[];
  searchCatalog?: SearchProviderMeta[];
  builtInSearchStatus?: string;
  executionLogs: AiExecutionLogRecord[];
}

const STRATEGY_DESCRIPTIONS: Record<RoutingStrategy, { label: string; desc: string }> = {
  balanced: {
    label: "Balanced (Default)",
    desc: "Balances quality, speed, and free-tier headroom across healthy keys before any rate limit hits.",
  },
  smartest: {
    label: "Smartest Quality",
    desc: "Prioritizes reasoning-capable models (Gemini Pro, DeepSeek V3/R1, Anthropic, OpenAI) for deeper outputs.",
  },
  fastest: {
    label: "Fastest Latency",
    desc: "Prioritizes Groq, Cerebras, Cloudflare edge, and Gemini Flash keys for lowest response times.",
  },
  reliable: {
    label: "Most Reliable",
    desc: "Prioritizes Google AI Studio, OpenAI, Anthropic, and NVIDIA keys with strict error avoidance.",
  },
};

const SEATS: TaskSeat[] = ["smart", "balanced", "fast"];

function formatCooldownRemaining(cooldownUntil?: string | null): string | null {
  if (!cooldownUntil) return null;
  const diffMs = new Date(cooldownUntil).getTime() - Date.now();
  if (diffMs <= 0) return null;
  const mins = Math.ceil(diffMs / 60_000);
  if (mins >= 60) return `${Math.ceil(mins / 60)}h left`;
  return `${mins}m left`;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}

export function AdminProvidersTab({
  role,
  sessionToken,
  reauthToken,
  onNeedReauth,
}: {
  role: AdminRole;
  sessionToken: string;
  reauthToken: string | null;
  onNeedReauth: (label: string, retryFn: (freshToken: string) => Promise<void>) => void;
}) {
  const confirmDialog = useConfirm();
  const toast = useToast();
  const isSuper = role === "super_admin";

  const [data, setData] = useState<GatewayAdminPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Settings draft
  const [masterModeDraft, setMasterModeDraft] = useState<"auto" | "manual">("auto");
  const [strategyDraft, setStrategyDraft] = useState<RoutingStrategy>("balanced");

  // Add Key Modal state
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [newProvider, setNewProvider] = useState<GatewayProviderId>("google");
  const [newLabel, setNewLabel] = useState("");
  const [newApiKey, setNewApiKey] = useState("");
  const [newAccountId, setNewAccountId] = useState("");
  const [newBaseUrl, setNewBaseUrl] = useState("");
  const [newRpmLimit, setNewRpmLimit] = useState(15);
  const [newRpdLimit, setNewRpdLimit] = useState(1500);
  const [newFreeOnly, setNewFreeOnly] = useState(true);
  const [fetchedAddModels, setFetchedAddModels] = useState<GatewayModelConfig[]>([]);
  const [addProbeNote, setAddProbeNote] = useState<string | null>(null);

  // Edit Key / Models & Limits Modal state
  const [editingKey, setEditingKey] = useState<AdminAiKeyPublic | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editRpmLimit, setEditRpmLimit] = useState(15);
  const [editRpdLimit, setEditRpdLimit] = useState(1500);
  const [editModels, setEditModels] = useState<GatewayModelConfig[]>([]);

  // Web Search Key quick-add state
  const [searchProviderInput, setSearchProviderInput] = useState<SearchProviderId>("tavily");
  const [searchApiKeyInput, setSearchApiKeyInput] = useState("");
  const [searchLabelInput, setSearchLabelInput] = useState("");

  const applyPayload = useCallback((payload: GatewayAdminPayload) => {
    setData(payload);
    setMasterModeDraft(payload.settings.masterMode);
    setStrategyDraft(payload.settings.strategy);
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminFetch<GatewayAdminPayload>("/api/admin/gateway", { sessionToken });
      applyPayload(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load AI gateway configuration.");
    } finally {
      setLoading(false);
    }
  }, [sessionToken, applyPayload]);

  useEffect(() => {
    const t = window.setTimeout(() => void loadData(), 0);
    return () => window.clearTimeout(t);
  }, [loadData]);

  const mutateGateway = async (
    label: string,
    payload: Record<string, unknown>,
    busyKey: string,
    tokenOverride?: string,
  ): Promise<boolean> => {
    setBusy(busyKey);
    setError(null);
    try {
      const res = await adminFetch<
        GatewayAdminPayload & {
          ok?: boolean;
          probe?: { model: string; ms: number };
          models?: GatewayModelConfig[];
          payload?: GatewayAdminPayload;
          warning?: string;
        }
      >("/api/admin/gateway", {
        method: "POST",
        sessionToken,
        reauthToken: tokenOverride ?? reauthToken,
        body: payload,
      });

      const nextPayload = res.payload ?? (res.settings && res.keys ? res : null);
      if (nextPayload) applyPayload(nextPayload);

      toast.success(
        label,
        res.probe
          ? `Verified ${res.probe.model} (${res.probe.ms}ms)${res.warning ? ` — ${res.warning}` : ""}`
          : "Updated AI gateway pool.",
      );
      return true;
    } catch (err) {
      if (err instanceof AdminClientError && err.code === "ADMIN_REAUTH_REQUIRED") {
        onNeedReauth(label, async (fresh) => {
          await mutateGateway(label, payload, busyKey, fresh);
        });
        return false;
      }
      const msg = err instanceof Error ? err.message : "Gateway action failed.";
      setError(msg);
      toast.error("Action failed", msg);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const openAddModalForProvider = (providerId: GatewayProviderId) => {
    const meta = getProviderMeta(providerId);
    setNewProvider(providerId);
    setNewLabel("");
    setNewApiKey("");
    setNewAccountId("");
    setNewBaseUrl(meta.baseUrl || "");
    setNewRpmLimit(meta.defaultRpmLimit);
    setNewRpdLimit(meta.defaultRpdLimit);
    setNewFreeOnly(meta.freeTierDefault);
    setFetchedAddModels(meta.defaultModels);
    setAddProbeNote(null);
    setAddModalOpen(true);
  };

  const handleTestNewKey = async () => {
    if (!newApiKey.trim()) return;
    setBusy("add_test");
    setError(null);
    setAddProbeNote(null);
    try {
      const res = await adminFetch<{
        ok: boolean;
        probe?: { model: string; ms: number; reply?: string };
        models?: { id: string; label: string; isFreeTier?: boolean }[];
        warning?: string;
      }>("/api/admin/gateway", {
        method: "POST",
        sessionToken,
        body: {
          action: "test_key",
          provider: newProvider,
          apiKey: newApiKey.trim(),
          accountId: newAccountId.trim() || undefined,
          baseUrl: newBaseUrl.trim() || undefined,
        },
      });
      setAddProbeNote(
        res.probe
          ? `Probe passed on ${res.probe.model} in ${res.probe.ms}ms.${res.warning ? ` (${res.warning})` : ""}`
          : "Key verified.",
      );
      toast.success("Key verified", res.probe ? `${res.probe.model} (${res.probe.ms}ms)` : undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Key probe failed.";
      setError(msg);
      toast.error("Key probe failed", msg);
    } finally {
      setBusy(null);
    }
  };

  const handleFetchNewModels = async () => {
    if (!newApiKey.trim()) return;
    setBusy("add_fetch");
    setError(null);
    try {
      const res = await adminFetch<{ models: GatewayModelConfig[] }>("/api/admin/gateway", {
        method: "POST",
        sessionToken,
        body: {
          action: "fetch_models",
          provider: newProvider,
          apiKey: newApiKey.trim(),
          accountId: newAccountId.trim() || undefined,
          baseUrl: newBaseUrl.trim() || undefined,
          freeTierOnly: newFreeOnly,
        },
      });
      if (Array.isArray(res.models) && res.models.length > 0) {
        setFetchedAddModels(res.models);
        setAddProbeNote(`Fetched ${res.models.length} models from ${getProviderMeta(newProvider).label}.`);
      } else {
        setAddProbeNote("Endpoint responded but returned 0 filtered models; default models kept.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to fetch models.";
      setError(msg);
      toast.error("Model fetch failed", msg);
    } finally {
      setBusy(null);
    }
  };

  const handleAddKeySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newApiKey.trim()) return;
    const ok = await mutateGateway(
      `Add ${getProviderMeta(newProvider).label} key`,
      {
        action: "add_key",
        provider: newProvider,
        label: newLabel.trim() || undefined,
        apiKey: newApiKey.trim(),
        accountId: newAccountId.trim() || undefined,
        baseUrl: newBaseUrl.trim() || undefined,
        rpmLimit: Number(newRpmLimit) || 15,
        rpdLimit: Number(newRpdLimit) || 1500,
        models: fetchedAddModels,
      },
      "add_key",
    );
    if (ok) {
      setNewApiKey("");
      setAddModalOpen(false);
    }
  };

  const openEditModal = (k: AdminAiKeyPublic) => {
    setEditingKey(k);
    setEditLabel(k.label);
    setEditRpmLimit(k.rpmLimit);
    setEditRpdLimit(k.rpdLimit);
    setEditModels(k.models.map((m) => ({ ...m, seats: [...m.seats] })));
  };

  const toggleEditModelSeat = (modelId: string, seat: TaskSeat) => {
    setEditModels((prev) =>
      prev.map((m) => {
        if (m.id !== modelId) return m;
        const has = m.seats.includes(seat);
        const nextSeats = has ? m.seats.filter((s) => s !== seat) : [...m.seats, seat];
        return { ...m, seats: nextSeats.length > 0 ? nextSeats : [seat] };
      }),
    );
  };

  if (loading && !data) return <BrandLoader />;

  const keys = data?.keys ?? [];
  const catalog = data?.catalog ?? [];
  const executionLogs = data?.executionLogs ?? [];
  const healthyCount = keys.filter((k) => k.enabled && k.healthStatus === "healthy").length;
  const cooldownCount = keys.filter((k) => k.healthStatus === "cooldown").length;
  const invalidCount = keys.filter((k) => k.healthStatus === "invalid").length;
  const selectedProviderMeta = getProviderMeta(newProvider);

  return (
    <div className="stack" style={{ gap: 16 }}>
      {error && <Banner tone="bad">{error}</Banner>}

      {!isSuper && (
        <Banner tone="info">
          Only <strong>Super Admins</strong> can add, rotate, delete pooled keys or alter routing mode. Admins can inspect
          key health, run connection probes, and monitor execution receipts.
        </Banner>
      )}

      {/* Master Routing & Auto-Failover Mode */}
      <Card
        title="Unified LLM Gateway & Auto Routing"
        sub="Control how free-tier & pooled keys execute across all features. Healthy keys are steered at 85% RPM/RPD before 429s hit."
        actions={
          <div className="row" style={{ gap: 6 }}>
            <Badge tone={healthyCount > 0 ? "ok" : "bad"}>{healthyCount} Healthy</Badge>
            {cooldownCount > 0 && <Badge tone="warn">{cooldownCount} Cooldown</Badge>}
            {invalidCount > 0 && <Badge tone="bad">{invalidCount} Invalid</Badge>}
            <button type="button" className="btn btn-sm" onClick={() => void loadData()} disabled={busy !== null}>
              <RefreshCw size={12} />
              Refresh
            </button>
          </div>
        }
      >
        <div className="grid grid-2" style={{ gap: 12, marginBottom: 14 }}>
          <button
            type="button"
            disabled={!isSuper || busy !== null}
            onClick={() => setMasterModeDraft("auto")}
            style={{
              textAlign: "left",
              padding: 14,
              borderRadius: 10,
              border: `1.5px solid ${masterModeDraft === "auto" ? "var(--teal-deep, #0f766e)" : "var(--line)"}`,
              background: masterModeDraft === "auto" ? "var(--accent-soft, rgba(15,118,110,0.08))" : "var(--surface)",
              cursor: isSuper ? "pointer" : "default",
            }}
          >
            <div className="row" style={{ gap: 8, marginBottom: 4 }}>
              <Zap size={15} style={{ color: "var(--teal-deep)" }} />
              <span className="strong">AUTO (Smart Multi-Key Failover)</span>
              {masterModeDraft === "auto" && <Badge tone="ok">Selected</Badge>}
            </div>
            <div className="tiny muted">
              Automatically scores all healthy keys by seat capability, routing strategy, headroom (&lt;85% RPM/RPD), and fails over silently on errors.
            </div>
          </button>

          <button
            type="button"
            disabled={!isSuper || busy !== null}
            onClick={() => setMasterModeDraft("manual")}
            style={{
              textAlign: "left",
              padding: 14,
              borderRadius: 10,
              border: `1.5px solid ${masterModeDraft === "manual" ? "var(--teal-deep, #0f766e)" : "var(--line)"}`,
              background: masterModeDraft === "manual" ? "var(--accent-soft, rgba(15,118,110,0.08))" : "var(--surface)",
              cursor: isSuper ? "pointer" : "default",
            }}
          >
            <div className="row" style={{ gap: 8, marginBottom: 4 }}>
              <Sliders size={15} />
              <span className="strong">Manual Fallback Order</span>
              {masterModeDraft === "manual" && <Badge tone="info">Selected</Badge>}
            </div>
            <div className="tiny muted">
              Strictly walks configured keys and fallback sequence in explicit priority order while still honoring cooldowns.
            </div>
          </button>
        </div>

        <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ flex: "1 1 280px" }}>
            <Field
              label="Routing Strategy"
              hint={STRATEGY_DESCRIPTIONS[strategyDraft].desc}
            >
              <select
                className="select"
                value={strategyDraft}
                disabled={!isSuper || busy !== null}
                onChange={(e) => setStrategyDraft(e.target.value as RoutingStrategy)}
              >
                {(Object.keys(STRATEGY_DESCRIPTIONS) as RoutingStrategy[]).map((s) => (
                  <option key={s} value={s}>
                    {STRATEGY_DESCRIPTIONS[s].label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {isSuper && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy !== null}
              onClick={() =>
                void mutateGateway(
                  "Save gateway routing settings",
                  {
                    action: "update_settings",
                    masterMode: masterModeDraft,
                    strategy: strategyDraft,
                  },
                  "save_settings",
                )
              }
            >
              {busy === "save_settings" ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
              Save Gateway Settings
            </button>
          )}
        </div>
      </Card>

      {/* Quick-Add Free-Tier & Custom Provider Buttons */}
      {isSuper && (
        <Card
          title="Quick-Add Free-Tier or Custom Key"
          sub="Add multiple keys per provider (or mix Google AI Studio, NVIDIA NIM, Z.ai, Cloudflare, OpenRouter :free, Groq, Cerebras) to multiply free-tier capacity."
          actions={
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => openAddModalForProvider("google")}
            >
              <Plus size={13} />
              Add API Key
            </button>
          }
        >
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {catalog.map((meta) => (
              <button
                key={meta.id}
                type="button"
                className="btn btn-sm"
                onClick={() => openAddModalForProvider(meta.id)}
              >
                <Plus size={12} />
                {meta.label}
              </button>
            ))}
          </div>
        </Card>
      )}

      {/* Pooled Keys List */}
      <Card
        title="Pooled API Keys"
        sub="Keys are encrypted at rest with AES-256-GCM. Cooldown state persists across serverless cold starts."
      >
        {keys.length === 0 ? (
          <Empty title="No pooled keys configured yet">
            <p className="tiny muted">Add at least one provider key above so the unified gateway can serve users automatically.</p>
          </Empty>
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            {keys.map((k) => {
              const meta = getProviderMeta(k.provider);
              const cooldownLeft = k.healthStatus === "cooldown" ? formatCooldownRemaining(k.cooldownUntil) : null;
              const rpmPct = Math.min(100, Math.round(((k.rpmUsed ?? 0) / Math.max(1, k.rpmLimit)) * 100));
              const rpdPct = Math.min(100, Math.round(((k.rpdUsed ?? 0) / Math.max(1, k.rpdLimit)) * 100));
              const enabledModels = k.models.filter((m) => m.enabled).length;

              return (
                <div
                  key={k.id}
                  style={{
                    padding: 14,
                    borderRadius: 10,
                    border: `1px solid ${
                      !k.enabled
                        ? "var(--line)"
                        : k.healthStatus === "invalid"
                          ? "var(--bad)"
                          : k.healthStatus === "cooldown"
                            ? "var(--warn)"
                            : "var(--teal-deep)"
                    }`,
                    background: "var(--surface)",
                  }}
                >
                  <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
                    <div style={{ minWidth: 240, flex: 1 }}>
                      <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                        <span className="strong">{k.label || meta.label}</span>
                        <Badge>{meta.label}</Badge>
                        <Badge>{k.maskedKey}</Badge>
                        {k.healthStatus === "healthy" ? (
                          <Badge tone="ok">Healthy</Badge>
                        ) : k.healthStatus === "cooldown" ? (
                          <Badge tone="warn">Cooldown{cooldownLeft ? ` (${cooldownLeft})` : ""}</Badge>
                        ) : (
                          <Badge tone="bad">Invalid Key</Badge>
                        )}
                        {!k.enabled && <Badge>Paused</Badge>}
                      </div>

                      <div className="tiny muted" style={{ marginTop: 4 }}>
                        {enabledModels} / {k.models.length} models enabled
                        {k.baseUrl ? ` · ${k.baseUrl}` : ""}
                        {k.lastCheckedAt ? ` · Checked ${formatTime(k.lastCheckedAt)}` : ""}
                      </div>

                      {k.lastError && (
                        <div className="tiny" style={{ color: "var(--bad)", marginTop: 4 }}>
                          Last error: {k.lastError}
                        </div>
                      )}

                      {/* Live RPM / RPD Headroom Bars */}
                      <div className="grid grid-2" style={{ gap: 10, marginTop: 8, maxWidth: 460 }}>
                        <div>
                          <div className="row tiny muted" style={{ justifyContent: "space-between" }}>
                            <span>RPM Window</span>
                            <span>{k.rpmUsed ?? 0} / {k.rpmLimit} ({rpmPct}%)</span>
                          </div>
                          <div style={{ height: 5, borderRadius: 4, background: "var(--line)", overflow: "hidden", marginTop: 3 }}>
                            <div
                              style={{
                                height: "100%",
                                width: `${rpmPct}%`,
                                background: rpmPct >= 85 ? "var(--warn)" : "var(--teal-deep, #0f766e)",
                              }}
                            />
                          </div>
                        </div>
                        <div>
                          <div className="row tiny muted" style={{ justifyContent: "space-between" }}>
                            <span>RPD Window</span>
                            <span>{k.rpdUsed ?? 0} / {k.rpdLimit} ({rpdPct}%)</span>
                          </div>
                          <div style={{ height: 5, borderRadius: 4, background: "var(--line)", overflow: "hidden", marginTop: 3 }}>
                            <div
                              style={{
                                height: "100%",
                                width: `${rpdPct}%`,
                                background: rpdPct >= 85 ? "var(--warn)" : "var(--teal-deep, #0f766e)",
                              }}
                            />
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                      {isSuper && (
                        <label className="row tiny" style={{ gap: 5, cursor: "pointer", marginRight: 4 }}>
                          <input
                            type="checkbox"
                            checked={k.enabled}
                            disabled={busy !== null}
                            onChange={(e) =>
                              void mutateGateway(
                                `${e.target.checked ? "Enable" : "Pause"} ${k.label}`,
                                { action: "toggle_key", keyId: k.id, enabled: e.target.checked },
                                `toggle_${k.id}`,
                              )
                            }
                          />
                          Enabled
                        </label>
                      )}

                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy !== null}
                        onClick={() =>
                          void mutateGateway(
                            `Test ${k.label}`,
                            { action: "test_key", keyId: k.id },
                            `test_${k.id}`,
                          )
                        }
                      >
                        {busy === `test_${k.id}` ? <Loader2 size={12} className="spin" /> : <TestTube2 size={12} />}
                        Test Key
                      </button>

                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy !== null}
                        onClick={() =>
                          void mutateGateway(
                            `Fetch live models for ${k.label}`,
                            { action: "fetch_models", keyId: k.id },
                            `fetch_${k.id}`,
                          )
                        }
                      >
                        {busy === `fetch_${k.id}` ? <Loader2 size={12} className="spin" /> : <Cpu size={12} />}
                        Fetch Models
                      </button>

                      {isSuper && (
                        <>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busy !== null}
                            onClick={() => openEditModal(k)}
                          >
                            <Sliders size={12} />
                            Models &amp; Limits
                          </button>

                          {k.healthStatus !== "healthy" && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={busy !== null}
                              onClick={() =>
                                void mutateGateway(
                                  `Clear cooldown for ${k.label}`,
                                  { action: "clear_cooldown", keyId: k.id },
                                  `clear_${k.id}`,
                                )
                              }
                            >
                              <RotateCcw size={12} />
                              Reset Cooldown
                            </button>
                          )}

                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            disabled={busy !== null}
                            onClick={async () => {
                              const ok = await confirmDialog({
                                title: `Remove ${k.label}?`,
                                message: "This pooled key will be permanently removed from the gateway.",
                                confirmLabel: "Delete key",
                                tone: "bad",
                              });
                              if (ok) {
                                void mutateGateway(
                                  `Delete ${k.label}`,
                                  { action: "delete_key", keyId: k.id },
                                  `delete_${k.id}`,
                                );
                              }
                            }}
                          >
                            <Trash2 size={12} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Web Search (Discovery & Research) */}
      <Card
        title="Web Search (Prospect Discovery & Live Research)"
        sub="Decoupled from paid Gemini grounding so discovery & research run across EVERY LLM provider at $0."
        actions={
          <Badge tone="ok">
            {data?.builtInSearchStatus || "Built-in Keyless Fallback: Ready ($0 Forever)"}
          </Badge>
        }
      >
        <div className="stack" style={{ gap: 12 }}>
          <Banner tone="info">
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <Globe size={14} />
              <span>
                <strong>Built-in Keyless Fallback is always active</strong> (DuckDuckGo Search + OpenStreetMap Overpass local business lookup + parallel live site inspection). Optionally add a free{" "}
                <strong>Tavily</strong> (1,000/mo free, no card), <strong>Brave</strong>, or <strong>Serper</strong> key for faster &amp; richer SERP snippets.
              </span>
            </div>
          </Banner>

          {(data?.searchKeys ?? []).length > 0 && (
            <div className="stack" style={{ gap: 8 }}>
              {(data?.searchKeys ?? []).map((sk) => {
                const smeta = getSearchProviderMeta(sk.provider);
                return (
                  <div
                    key={sk.id}
                    className="row"
                    style={{
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: 10,
                      borderRadius: 8,
                      border: `1px solid ${sk.enabled ? "var(--teal-deep)" : "var(--line)"}`,
                      background: "var(--surface)",
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <div className="row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <span className="strong">{sk.label || smeta.label}</span>
                      <Badge>{smeta.label}</Badge>
                      <Badge>{sk.maskedKey}</Badge>
                      <Badge tone={sk.enabled ? "ok" : undefined}>{sk.enabled ? "Active" : "Paused"}</Badge>
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy !== null}
                        onClick={() =>
                          void mutateGateway(
                            `Test ${smeta.label}`,
                            { action: "test_search_key", keyId: sk.id },
                            `test_search_${sk.id}`,
                          )
                        }
                      >
                        {busy === `test_search_${sk.id}` ? <Loader2 size={12} className="spin" /> : <TestTube2 size={12} />}
                        Test Search
                      </button>
                      {isSuper && !sk.id.startsWith("srch_env_") && (
                        <>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busy !== null}
                            onClick={() =>
                              void mutateGateway(
                                `${sk.enabled ? "Pause" : "Enable"} ${sk.label}`,
                                { action: "toggle_search_key", keyId: sk.id, enabled: !sk.enabled },
                                `toggle_search_${sk.id}`,
                              )
                            }
                          >
                            {sk.enabled ? "Pause" : "Enable"}
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            disabled={busy !== null}
                            onClick={() =>
                              void mutateGateway(
                                `Remove ${sk.label}`,
                                { action: "delete_search_key", keyId: sk.id },
                                `del_search_${sk.id}`,
                              )
                            }
                          >
                            <Trash2 size={12} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {isSuper && (
            <form
              className="row"
              style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}
              onSubmit={async (e) => {
                e.preventDefault();
                if (!searchApiKeyInput.trim()) return;
                const ok = await mutateGateway(
                  `Add ${getSearchProviderMeta(searchProviderInput).label} key`,
                  {
                    action: "add_search_key",
                    provider: searchProviderInput,
                    apiKey: searchApiKeyInput.trim(),
                    label: searchLabelInput.trim() || undefined,
                  },
                  "add_search_key",
                );
                if (ok) {
                  setSearchApiKeyInput("");
                  setSearchLabelInput("");
                }
              }}
            >
              <div style={{ flex: "0 1 180px" }}>
                <Field label="Search Provider">
                  <select
                    className="select"
                    value={searchProviderInput}
                    onChange={(e) => setSearchProviderInput(e.target.value as SearchProviderId)}
                  >
                    {(data?.searchCatalog ?? []).map((sc) => (
                      <option key={sc.id} value={sc.id}>
                        {sc.label}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <div style={{ flex: "1 1 220px" }}>
                <Field label="Optional Label">
                  <input
                    className="input"
                    type="text"
                    value={searchLabelInput}
                    onChange={(e) => setSearchLabelInput(e.target.value)}
                    placeholder="e.g. Tavily Free Key"
                  />
                </Field>
              </div>
              <div style={{ flex: "1 1 240px" }}>
                <Field label="Search API Key">
                  <input
                    className="input"
                    type="password"
                    autoComplete="off"
                    value={searchApiKeyInput}
                    onChange={(e) => setSearchApiKeyInput(e.target.value)}
                    placeholder="tvly-... / BSA... / Serper key"
                  />
                </Field>
              </div>
              <button
                type="submit"
                className="btn btn-primary btn-sm"
                disabled={!searchApiKeyInput.trim() || busy !== null}
              >
                {busy === "add_search_key" ? <Loader2 size={12} className="spin" /> : <Plus size={12} />}
                Save Search Key
              </button>
            </form>
          )}
        </div>
      </Card>

      {/* Live Execution Receipts Log */}
      <Card
        title="Live AI Execution Receipts"
        sub="Every server-side LLM request logs requested mode, actual provider & model served, fallback hops, and latency."
        actions={
          <span className="tiny muted row" style={{ gap: 5 }}>
            <Activity size={13} />
            Latest {executionLogs.length} calls
          </span>
        }
      >
        {executionLogs.length === 0 ? (
          <Empty title="No execution receipts recorded yet">
            <p className="tiny muted">Run any AI action or test probe to see live execution proof here.</p>
          </Empty>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table" style={{ width: "100%", fontSize: 12.5 }}>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Seat</th>
                  <th>Feature</th>
                  <th>Mode</th>
                  <th>Actual Provider &amp; Model</th>
                  <th>Hops</th>
                  <th>Latency</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {executionLogs.map((log) => (
                  <tr key={log.id}>
                    <td className="tiny muted">{formatTime(log.createdAt)}</td>
                    <td>
                      <Badge>{log.taskType}</Badge>
                    </td>
                    <td>{log.feature}</td>
                    <td className="tiny">{log.requestedMode}</td>
                    <td>
                      <span className="strong">{log.actualProvider || "—"}</span>{" "}
                      <span className="tiny muted">{log.actualModel || ""}</span>
                      {log.grounded && (
                        <>
                          {" "}
                          <Badge tone="info">Grounded</Badge>
                        </>
                      )}
                    </td>
                    <td>{log.fallbackHops}</td>
                    <td>{log.latencyMs}ms</td>
                    <td>
                      <Badge tone={log.status === "success" ? "ok" : "bad"}>{log.status}</Badge>
                      {log.errorSummary && (
                        <div className="tiny muted" style={{ maxWidth: 260, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={log.errorSummary}>
                          {log.errorSummary}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Add Key Modal */}
      <Modal
        open={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        title={`Add Pooled Key · ${selectedProviderMeta.label}`}
        large
      >
        <form className="stack" style={{ gap: 12 }} onSubmit={(e) => void handleAddKeySubmit(e)}>
          <div className="grid grid-2" style={{ gap: 10 }}>
            <Field label="Provider">
              <select
                className="select"
                value={newProvider}
                onChange={(e) => {
                  const pid = e.target.value as GatewayProviderId;
                  const meta = getProviderMeta(pid);
                  setNewProvider(pid);
                  setNewBaseUrl(meta.baseUrl || "");
                  setNewRpmLimit(meta.defaultRpmLimit);
                  setNewRpdLimit(meta.defaultRpdLimit);
                  setNewFreeOnly(meta.freeTierDefault);
                  setFetchedAddModels(meta.defaultModels);
                  setAddProbeNote(null);
                }}
              >
                {catalog.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Key Label (optional)" hint="e.g. Google Key #2 or NVIDIA NIM Free">
              <input
                className="input"
                type="text"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder={`${selectedProviderMeta.label} Pool Key`}
              />
            </Field>
          </div>

          <Field
            label="API Key"
            hint={`Encrypted with AES-256-GCM before storage. Get a key at ${selectedProviderMeta.docsLabel}.`}
          >
            <input
              className="input"
              type="password"
              required
              autoComplete="off"
              value={newApiKey}
              onChange={(e) => setNewApiKey(e.target.value)}
              placeholder="Paste API key..."
            />
          </Field>

          {selectedProviderMeta.requiresAccountId && (
            <Field label="Cloudflare Account ID" hint="Required for Workers AI (/accounts/<id>/ai/v1).">
              <input
                className="input"
                type="text"
                required
                value={newAccountId}
                onChange={(e) => setNewAccountId(e.target.value)}
                placeholder="32-character Cloudflare Account ID"
              />
            </Field>
          )}

          {(selectedProviderMeta.requiresBaseUrl || newProvider === "zai" || newProvider === "custom") && (
            <Field label="API Base URL" hint="Public https:// endpoint URL.">
              <input
                className="input"
                type="url"
                required={Boolean(selectedProviderMeta.requiresBaseUrl)}
                value={newBaseUrl}
                onChange={(e) => setNewBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1"
              />
            </Field>
          )}

          <div className="grid grid-2" style={{ gap: 10 }}>
            <Field label="RPM Limit (Requests / Min)" hint="Router steers away proactively at 85%.">
              <input
                className="input"
                type="number"
                min={1}
                max={10000}
                value={newRpmLimit}
                onChange={(e) => setNewRpmLimit(Number(e.target.value) || 15)}
              />
            </Field>
            <Field label="RPD Limit (Requests / Day)">
              <input
                className="input"
                type="number"
                min={1}
                max={1000000}
                value={newRpdLimit}
                onChange={(e) => setNewRpdLimit(Number(e.target.value) || 1500)}
              />
            </Field>
          </div>

          {newProvider === "openrouter" && (
            <label className="row tiny" style={{ gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={newFreeOnly}
                onChange={(e) => setNewFreeOnly(e.target.checked)}
              />
              <span>Free-tier models only (`:free` suffix)</span>
            </label>
          )}

          {addProbeNote && (
            <Banner tone="ok">
              <span className="row" style={{ gap: 6 }}>
                <CheckCircle2 size={14} /> {addProbeNote}
              </span>
            </Banner>
          )}

          <div className="tiny muted">
            Models to attach: <strong>{fetchedAddModels.length}</strong> ({fetchedAddModels.slice(0, 4).map((m) => m.id).join(", ")}
            {fetchedAddModels.length > 4 ? ` +${fetchedAddModels.length - 4} more` : ""})
          </div>

          <div className="row" style={{ gap: 8, justifyContent: "space-between", flexWrap: "wrap", marginTop: 4 }}>
            <div className="row" style={{ gap: 8 }}>
              <button
                type="button"
                className="btn btn-sm"
                disabled={!newApiKey.trim() || busy !== null}
                onClick={() => void handleTestNewKey()}
              >
                {busy === "add_test" ? <Loader2 size={12} className="spin" /> : <TestTube2 size={12} />}
                Test Key
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={!newApiKey.trim() || busy !== null}
                onClick={() => void handleFetchNewModels()}
              >
                {busy === "add_fetch" ? <Loader2 size={12} className="spin" /> : <Cpu size={12} />}
                Fetch Models
              </button>
            </div>

            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="btn btn-sm" onClick={() => setAddModalOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={!newApiKey.trim() || busy !== null}>
                {busy === "add_key" ? <Loader2 size={12} className="spin" /> : <KeyRound size={12} />}
                Save Key to Pool
              </button>
            </div>
          </div>
        </form>
      </Modal>

      {/* Edit Key Models & Limits Modal */}
      <Modal
        open={Boolean(editingKey)}
        onClose={() => setEditingKey(null)}
        title={`Configure Key · ${editingKey?.label ?? ""}`}
        large
      >
        {editingKey && (
          <div className="stack" style={{ gap: 12 }}>
            <div className="grid grid-2" style={{ gap: 10 }}>
              <Field label="Label">
                <input
                  className="input"
                  type="text"
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                />
              </Field>
              <div className="grid grid-2" style={{ gap: 8 }}>
                <Field label="RPM Limit">
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={10000}
                    value={editRpmLimit}
                    onChange={(e) => setEditRpmLimit(Number(e.target.value) || 15)}
                  />
                </Field>
                <Field label="RPD Limit">
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={1000000}
                    value={editRpdLimit}
                    onChange={(e) => setEditRpdLimit(Number(e.target.value) || 1500)}
                  />
                </Field>
              </div>
            </div>

            <div>
              <div className="strong tiny" style={{ marginBottom: 6 }}>
                Enabled Models &amp; Task Seats ({editModels.filter((m) => m.enabled).length} / {editModels.length} active)
              </div>
              <div style={{ maxHeight: 320, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 8, padding: 8 }} className="stack">
                {editModels.map((m) => (
                  <div
                    key={m.id}
                    className="row"
                    style={{
                      justifyContent: "space-between",
                      padding: "6px 8px",
                      borderRadius: 6,
                      borderBottom: "1px solid var(--line)",
                      gap: 8,
                    }}
                  >
                    <label className="row" style={{ gap: 8, cursor: "pointer", flex: 1 }}>
                      <input
                        type="checkbox"
                        checked={m.enabled}
                        onChange={(e) =>
                          setEditModels((prev) =>
                            prev.map((item) => (item.id === m.id ? { ...item, enabled: e.target.checked } : item)),
                          )
                        }
                      />
                      <div>
                        <div className="strong tiny">{m.displayName || m.id}</div>
                        <div className="tiny muted">{m.id}</div>
                      </div>
                    </label>

                    <div className="row" style={{ gap: 6 }}>
                      {SEATS.map((seat) => {
                        const active = m.seats.includes(seat);
                        return (
                          <button
                            key={seat}
                            type="button"
                            className="btn btn-sm"
                            style={{
                              padding: "2px 8px",
                              fontSize: 11,
                              opacity: active ? 1 : 0.45,
                              borderColor: active ? "var(--teal-deep)" : undefined,
                            }}
                            onClick={() => toggleEditModelSeat(m.id, seat)}
                          >
                            {seat}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="btn btn-sm" onClick={() => setEditingKey(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy !== null}
                onClick={async () => {
                  const ok = await mutateGateway(
                    `Update ${editingKey.label}`,
                    {
                      action: "update_key",
                      keyId: editingKey.id,
                      label: editLabel.trim(),
                      rpmLimit: editRpmLimit,
                      rpdLimit: editRpdLimit,
                      models: editModels,
                    },
                    `save_${editingKey.id}`,
                  );
                  if (ok) setEditingKey(null);
                }}
              >
                {busy === `save_${editingKey.id}` ? <Loader2 size={12} className="spin" /> : <Save size={12} />}
                Save Key Settings
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
