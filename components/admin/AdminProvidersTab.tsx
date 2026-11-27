"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  Cpu,
  ExternalLink,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Sliders,
  TestTube2,
  Zap,
} from "lucide-react";
import {
  getProviderMeta,
  getSearchProviderMeta,
  PROVIDER_CATEGORY_LABELS,
  PROVIDER_CATEGORY_ORDER,
  type AdminAiKeyPublic,
  type AdminAiSettings,
  type AdminSearchKeyPublic,
  type AiExecutionLogRecord,
  type GatewayModelConfig,
  type GatewayProviderId,
  type ProviderCatalogMeta,
  type ProviderCategory,
  type RoutingStrategy,
  type SearchProviderId,
  type SearchProviderMeta,
  type SearchProviderState,
  type TaskSeat,
} from "@/lib/llm/types";
import type { AdminRole } from "@/lib/platform/types";
import type { SearchQuotaRecord } from "@/lib/search/quotaAndCache";
import { Badge, Banner, Card, Empty, Field, Modal } from "../ui";
import { BrandLoader } from "../BrandLoader";
import { useToast } from "../Feedback";
import { AdminClientError, adminFetch } from "./admin-client";
import { ApiKeyAnalyticsDrawer, type DrawerTarget } from "./ApiKeyAnalyticsDrawer";

interface GatewayAdminPayload {
  settings: AdminAiSettings;
  keys: AdminAiKeyPublic[];
  catalog: ProviderCatalogMeta[];
  searchKeys?: AdminSearchKeyPublic[];
  searchCatalog?: SearchProviderMeta[];
  searchQuotas?: SearchQuotaRecord[];
  searchProviderStates?: SearchProviderState[];
  totalCacheHitsSaved?: number;
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
type CategoryTab = "all" | ProviderCategory;

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

function llmKeyStatus(k: AdminAiKeyPublic): "active" | "paused" | "cooldown" | "invalid" {
  if (!k.enabled) return "paused";
  if (k.healthStatus === "invalid") return "invalid";
  if (k.healthStatus === "cooldown") return "cooldown";
  return "active";
}

const STATUS_BADGE: Record<string, { tone?: string; label: string }> = {
  active: { tone: "ok", label: "Active" },
  paused: { tone: "warn", label: "Paused (Reserve)" },
  cooldown: { tone: "warn", label: "Cooldown" },
  invalid: { tone: "bad", label: "Invalid Key" },
  not_configured: { label: "Not Configured" },
  exhausted: { tone: "bad", label: "Exhausted" },
  near_limit: { tone: "warn", label: "Near Limit" },
  keyless: { tone: "info", label: "Keyless Always On" },
};

function ProviderCard({
  title,
  badges,
  sub,
  status,
  onClick,
}: {
  title: string;
  badges: string[];
  sub: string;
  status: string;
  onClick: () => void;
}) {
  const badge = STATUS_BADGE[status] ?? { label: status };
  return (
    <button type="button" className="provider-card" onClick={onClick}>
      <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <span className="strong">{title}</span>
        {badges.filter(Boolean).map((b) => (
          <Badge key={b}>{b}</Badge>
        ))}
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      <div className="tiny muted provider-card-sub">{sub}</div>
      <span className="provider-card-cta">Inspect Details →</span>
    </button>
  );
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
  const toast = useToast();
  const isSuper = role === "super_admin";

  const [data, setData] = useState<GatewayAdminPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<CategoryTab>("all");
  const [drawer, setDrawer] = useState<DrawerTarget | null>(null);

  // Settings draft
  const [masterModeDraft, setMasterModeDraft] = useState<"auto" | "manual">("auto");
  const [strategyDraft, setStrategyDraft] = useState<RoutingStrategy>("balanced");

  // LLM Add Key Modal
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

  // Search / contact / audit Add Key Modal
  const [addSearchOpen, setAddSearchOpen] = useState(false);
  const [searchCategory, setSearchCategory] = useState<Exclude<ProviderCategory, "ai_llm">>("web_search");
  const [searchProviderInput, setSearchProviderInput] = useState<SearchProviderId>("tavily");
  const [searchKeyFirst, setSearchKeyFirst] = useState("");
  const [searchKeySecond, setSearchKeySecond] = useState("");
  const [searchLabelInput, setSearchLabelInput] = useState("");

  // Edit Key / Models & Limits Modal state
  const [editingKey, setEditingKey] = useState<AdminAiKeyPublic | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editRpmLimit, setEditRpmLimit] = useState(15);
  const [editRpdLimit, setEditRpdLimit] = useState(1500);
  const [editModels, setEditModels] = useState<GatewayModelConfig[]>([]);

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
          : "Updated the API command center.",
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

  const openSearchModal = useCallback(
    (category: Exclude<ProviderCategory, "ai_llm">, provider?: SearchProviderId) => {
      const candidates = (data?.searchCatalog ?? []).filter((m) => m.category === category);
      const chosen = provider ?? candidates[0]?.id ?? "tavily";
      setSearchCategory(category);
      setSearchProviderInput(chosen);
      setSearchKeyFirst("");
      setSearchKeySecond("");
      setSearchLabelInput("");
      setAddSearchOpen(true);
    },
    [data?.searchCatalog],
  );

  useEffect(() => {
    const onAdd = (event: Event) => {
      const detail = (event as CustomEvent<{ provider?: SearchProviderId }>).detail;
      const provider = detail?.provider;
      const meta = provider ? getSearchProviderMeta(provider) : null;
      if (meta) openSearchModal(meta.category, provider);
    };
    window.addEventListener("admin:add-search-key", onAdd);
    return () => window.removeEventListener("admin:add-search-key", onAdd);
  }, [openSearchModal]);

  const handleTestNewKey = async () => {
    if (!newApiKey.trim()) return;
    setBusy("add_test");
    setError(null);
    setAddProbeNote(null);
    try {
      const res = await adminFetch<{
        ok: boolean;
        probe?: { model: string; ms: number; reply?: string };
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

  const states = useMemo(() => data?.searchProviderStates ?? [], [data?.searchProviderStates]);
  const keys = useMemo(() => data?.keys ?? [], [data?.keys]);
  const catalog = useMemo(() => data?.catalog ?? [], [data?.catalog]);
  const executionLogs = useMemo(() => data?.executionLogs ?? [], [data?.executionLogs]);

  const summary = useMemo(() => {
    const llmActive = keys.filter((k) => llmKeyStatus(k) === "active").length;
    const llmPaused = keys.filter((k) => llmKeyStatus(k) === "paused").length;
    const keyedSearch = states.filter((s) => s.kind !== "keyless");
    const searchActive = keyedSearch.filter((s) => s.status === "active" || s.status === "near_limit").length;
    const searchPaused = keyedSearch.filter((s) => s.status === "paused").length;
    const cooldown =
      keys.filter((k) => k.healthStatus === "cooldown").length +
      keyedSearch.filter((s) => s.status === "cooldown" || s.status === "exhausted").length;
    const notConfigured = keyedSearch.filter((s) => s.status === "not_configured").length;
    return {
      active: llmActive + searchActive,
      paused: llmPaused + searchPaused,
      cooldown,
      notConfigured,
      cacheHits: data?.totalCacheHitsSaved ?? 0,
    };
  }, [keys, states, data?.totalCacheHitsSaved]);

  const categoryCounts = useCallback(
    (category: ProviderCategory) => {
      if (category === "ai_llm") {
        const active = keys.filter((k) => llmKeyStatus(k) === "active").length;
        const paused = keys.filter((k) => llmKeyStatus(k) === "paused").length;
        const configuredProviders = new Set(keys.map((k) => k.provider));
        const notConfigured = catalog.filter((c) => !configuredProviders.has(c.id)).length;
        return { active, paused, notConfigured };
      }
      const rows = states.filter((s) => s.category === category && s.kind !== "keyless");
      return {
        active: rows.filter((s) => s.status === "active" || s.status === "near_limit").length,
        paused: rows.filter((s) => s.status === "paused").length,
        notConfigured: rows.filter((s) => s.status === "not_configured").length,
      };
    },
    [keys, catalog, states],
  );

  const searchModalCatalog = (data?.searchCatalog ?? []).filter((m) => m.category === searchCategory);
  const selectedSearchMeta = getSearchProviderMeta(searchProviderInput);
  const selectedProviderMeta = getProviderMeta(newProvider);
  const visibleCategories: ProviderCategory[] =
    activeCategory === "all" ? PROVIDER_CATEGORY_ORDER : [activeCategory];

  if (loading && !data) return <BrandLoader />;

  return (
    <div className="stack" style={{ gap: 16 }}>
      {error && <Banner tone="bad">{error}</Banner>}

      {!isSuper && (
        <Banner tone="info">
          Only <strong>Super Admins</strong> can add, rotate, delete pooled keys or alter routing mode. Admins can inspect
          key health, run connection probes, and monitor execution receipts.
        </Banner>
      )}

      {/* API Command Center summary */}
      <Card
        title="API Command Center"
        sub="Every key in its functional category. Add reserve keys, keep 2–3 active, and pause the rest in one click."
        actions={
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className="btn btn-sm" onClick={() => void loadData()} disabled={busy !== null}>
              <RefreshCw size={12} />
              Refresh
            </button>
          </div>
        }
      >
        <div className="summary-pills">
          <span className="pill pill-ok">{summary.active} Active</span>
          <span className="pill pill-warn">{summary.paused} Paused</span>
          <span className="pill pill-bad">{summary.cooldown} Cooldown</span>
          <span className="pill">{summary.notConfigured} Not Configured</span>
          <span className="pill pill-info">{summary.cacheHits} Cache Hits Saved</span>
        </div>

        <div className="category-tabs" role="tablist" aria-label="Provider categories">
          <button
            type="button"
            role="tab"
            aria-selected={activeCategory === "all"}
            className={`category-tab${activeCategory === "all" ? " is-active" : ""}`}
            onClick={() => setActiveCategory("all")}
          >
            All Categories
          </button>
          {PROVIDER_CATEGORY_ORDER.map((category) => {
            const counts = categoryCounts(category);
            return (
              <button
                key={category}
                type="button"
                role="tab"
                aria-selected={activeCategory === category}
                className={`category-tab${activeCategory === category ? " is-active" : ""}`}
                onClick={() => setActiveCategory(category)}
              >
                {PROVIDER_CATEGORY_LABELS[category]}
                <em>
                  {counts.active} active · {counts.paused} paused · {counts.notConfigured} not set
                </em>
              </button>
            );
          })}
        </div>
      </Card>

      {/* Routing (AI category only) */}
      {(activeCategory === "all" || activeCategory === "ai_llm") && (
        <Card
          title="Unified LLM Gateway & Auto Routing"
          sub="Control how free-tier & pooled keys execute across all features. Healthy keys are steered at 85% RPM/RPD before 429s hit."
          actions={
            <div className="row" style={{ gap: 6 }}>
              <Badge tone={summary.active > 0 ? "ok" : "bad"}>{summary.active} Active</Badge>
              {summary.cooldown > 0 && <Badge tone="warn">{summary.cooldown} Cooldown</Badge>}
              {isSuper && summary.cooldown > 0 && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    void mutateGateway("Reset all cooldowns", { action: "clear_all_cooldowns" }, "clear_all_cooldowns")
                  }
                  disabled={busy !== null}
                >
                  <RotateCcw size={12} />
                  Reset All Cooldowns
                </button>
              )}
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
                Strictly walks configured keys and fallback sequence in explicit priority order while still honoring
                cooldowns.
              </div>
            </button>
          </div>

          <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ flex: "1 1 280px" }}>
              <Field label="Routing Strategy" hint={STRATEGY_DESCRIPTIONS[strategyDraft].desc}>
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
                    { action: "update_settings", masterMode: masterModeDraft, strategy: strategyDraft },
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
      )}

      {/* One section per visible category */}
      {visibleCategories.map((category) => {
        const counts = categoryCounts(category);
        const isLlm = category === "ai_llm";
        const rows = states.filter((s) => s.category === category);
        const configuredProviders = new Set(keys.map((k) => k.provider));
        const missingLlmProviders = catalog.filter((c) => !configuredProviders.has(c.id));

        return (
          <Card
            key={category}
            title={PROVIDER_CATEGORY_LABELS[category]}
            sub={`${counts.active} active · ${counts.paused} paused · ${counts.notConfigured} not configured`}
            actions={
              isSuper ? (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    if (isLlm) openAddModalForProvider("google");
                    else openSearchModal(category as Exclude<ProviderCategory, "ai_llm">);
                  }}
                >
                  <Plus size={12} />
                  Add Key to {isLlm ? "AI / LLM" : PROVIDER_CATEGORY_LABELS[category].split(" ")[0]}
                </button>
              ) : undefined
            }
          >
            <div className="stack" style={{ gap: 10 }}>
              {isLlm &&
                keys.map((k) => {
                  const meta = getProviderMeta(k.provider);
                  const status = llmKeyStatus(k);
                  const cooldownLeft = status === "cooldown" ? formatCooldownRemaining(k.cooldownUntil) : null;
                  return (
                    <ProviderCard
                      key={k.id}
                      title={k.label || meta.label}
                      badges={[meta.label, k.maskedKey]}
                      status={status}
                      sub={`${k.models.filter((m) => m.enabled).length} / ${k.models.length} models · RPM ${k.rpmUsed ?? 0}/${k.rpmLimit} · RPD ${k.rpdUsed ?? 0}/${k.rpdLimit}${
                        cooldownLeft ? ` · ${cooldownLeft}` : ""
                      }`}
                      onClick={() => setDrawer({ kind: "llm", providerLabel: k.provider, key: k })}
                    />
                  );
                })}

              {isLlm &&
                missingLlmProviders.map((meta) => (
                  <ProviderCard
                    key={`missing_${meta.id}`}
                    title={meta.label}
                    badges={[meta.freeTierDefault ? "Free tier" : "Paid / BYOK"]}
                    status="not_configured"
                    sub={meta.blurb}
                    onClick={() => setDrawer({ kind: "llm", providerLabel: meta.id, key: null })}
                  />
                ))}

              {!isLlm &&
                rows
                  .filter((s) => s.kind !== "keyless")
                  .map((s) => {
                    const smeta = getSearchProviderMeta(s.provider as SearchProviderId);
                    return (
                      <ProviderCard
                        key={s.provider}
                        title={s.hasKey && s.maskedKey ? `${s.label} · ${s.maskedKey}` : s.label}
                        badges={[smeta.label !== s.label ? smeta.label : ""].filter(Boolean)}
                        status={s.status}
                        sub={
                          s.quota.limit > 0
                            ? `${s.quota.used} / ${s.quota.limit} used · ${s.quota.resetCycle} reset${
                                s.status === "not_configured" ? ` · ${s.freeTierNote}` : ""
                              }`
                            : s.blurb
                        }
                        onClick={() => setDrawer({ kind: "search", state: s })}
                      />
                    );
                  })}

              {/* Keyless built-ins */}
              <div>
                <div className="tiny muted" style={{ marginBottom: 6 }}>Built-in keyless (always on)</div>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  {rows
                    .filter((s) => s.kind === "keyless")
                    .map((s) => (
                      <button
                        key={s.provider}
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setDrawer({ kind: "search", state: s })}
                      >
                        <CheckCircle2 size={12} />
                        {s.label}
                      </button>
                    ))}
                  {rows.filter((s) => s.kind === "keyless").length === 0 && (
                    <span className="tiny muted">Keyless fallbacks are listed in their own categories.</span>
                  )}
                </div>
              </div>

              {isLlm && keys.length === 0 && missingLlmProviders.length === 0 && (
                <Empty title="No pooled keys configured yet">
                  <p className="tiny muted">Add at least one provider key above so the unified gateway can serve users automatically.</p>
                </Empty>
              )}
            </div>
          </Card>
        );
      })}

      {/* Live Execution Receipts Log */}
      {(activeCategory === "all" || activeCategory === "ai_llm") && (
        <Card
          title="Live AI Execution Receipts"
          sub="Every server-side LLM request logs requested mode, actual provider & model served, fallback hops, and latency. Click a row for full detail."
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
            <ReceiptsTable
              logs={executionLogs}
              onOpenKey={(log) => {
                const match = keys.find((k) => k.id === log.actualKeyId);
                if (match) setDrawer({ kind: "llm", providerLabel: match.provider, key: match });
                else if (log.actualProvider)
                  setDrawer({ kind: "llm", providerLabel: log.actualProvider, key: null });
              }}
            />
          )}
        </Card>
      )}

      {/* Add LLM Key Modal */}
      <Modal
        open={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        title={`Add Pooled Key · ${selectedProviderMeta.label}`}
        large
      >
        <form className="stack" style={{ gap: 12 }} onSubmit={(e) => void handleAddKeySubmit(e)}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="tiny muted">Encrypted with AES-256-GCM. Free-tier defaults are pre-filled.</span>
            <a className="btn btn-sm" href={selectedProviderMeta.docsUrl} target="_blank" rel="noreferrer noopener">
              Get API Key
              <ExternalLink size={12} />
            </a>
          </div>

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

          <Field label="API Key" hint={`Get a key at ${selectedProviderMeta.docsLabel}.`}>
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

          {(selectedProviderMeta.requiresBaseUrl || newProvider === "custom") && (
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
              <input type="checkbox" checked={newFreeOnly} onChange={(e) => setNewFreeOnly(e.target.checked)} />
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

      {/* Add Search / Contact / Audit Key Modal */}
      <Modal
        open={addSearchOpen}
        onClose={() => setAddSearchOpen(false)}
        title={`Add Key · ${PROVIDER_CATEGORY_LABELS[searchCategory]}`}
        large
      >
        <form
          className="stack"
          style={{ gap: 12 }}
          onSubmit={async (e) => {
            e.preventDefault();
            const apiKey = selectedSearchMeta.dualField
              ? [searchKeyFirst.trim(), searchKeySecond.trim()].filter(Boolean).join(":")
              : searchKeyFirst.trim();
            if (!apiKey) return;
            const ok = await mutateGateway(
              `Add ${selectedSearchMeta.label} key`,
              {
                action: "add_search_key",
                provider: searchProviderInput,
                apiKey,
                label: searchLabelInput.trim() || undefined,
              },
              "add_search_key",
            );
            if (ok) {
              setAddSearchOpen(false);
              setSearchKeyFirst("");
              setSearchKeySecond("");
            }
          }}
        >
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="tiny muted">{selectedSearchMeta.blurb}</span>
            <a className="btn btn-sm" href={selectedSearchMeta.docsUrl} target="_blank" rel="noreferrer noopener">
              Get API Key
              <ExternalLink size={12} />
            </a>
          </div>

          <div className="grid grid-2" style={{ gap: 10 }}>
            <Field label="Provider" hint={`${selectedSearchMeta.freeTierNote}${selectedSearchMeta.requiresCard ? " · card required" : " · no card required"}`}>
              <select
                className="select"
                value={searchProviderInput}
                onChange={(e) => setSearchProviderInput(e.target.value as SearchProviderId)}
              >
                {searchModalCatalog.map((sc) => (
                  <option key={sc.id} value={sc.id}>
                    {sc.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Key Label (optional)">
              <input
                className="input"
                type="text"
                value={searchLabelInput}
                onChange={(e) => setSearchLabelInput(e.target.value)}
                placeholder={`${selectedSearchMeta.label} Reserve Key`}
              />
            </Field>
          </div>

          {selectedSearchMeta.dualField ? (
            <div className="grid grid-2" style={{ gap: 10 }}>
              <Field
                label={selectedSearchMeta.dualField === "accountId:apiToken" ? "Account ID" : "Key part 1"}
                hint={
                  selectedSearchMeta.dualField === "clientId:clientSecret"
                    ? "clientId from Snov.io"
                    : selectedSearchMeta.dualField === "apiKey:secretKey"
                      ? "apiKey from Tomba"
                      : "Cloudflare Account ID"
                }
              >
                <input
                  className="input"
                  type="password"
                  autoComplete="off"
                  required
                  value={searchKeyFirst}
                  onChange={(e) => setSearchKeyFirst(e.target.value)}
                />
              </Field>
              <Field
                label={selectedSearchMeta.dualField === "accountId:apiToken" ? "API Token" : "Key part 2"}
                hint={
                  selectedSearchMeta.dualField === "clientId:clientSecret"
                    ? "clientSecret from Snov.io"
                    : selectedSearchMeta.dualField === "apiKey:secretKey"
                      ? "secretKey from Tomba"
                      : "Cloudflare API token"
                }
              >
                <input
                  className="input"
                  type="password"
                  autoComplete="off"
                  required
                  value={searchKeySecond}
                  onChange={(e) => setSearchKeySecond(e.target.value)}
                />
              </Field>
            </div>
          ) : (
            <Field label="API Key" hint={`Encrypted at rest. ${selectedSearchMeta.freeTierNote}.`}>
              <input
                className="input"
                type="password"
                autoComplete="off"
                required
                value={searchKeyFirst}
                onChange={(e) => setSearchKeyFirst(e.target.value)}
                placeholder="Paste API key..."
              />
            </Field>
          )}

          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="btn btn-sm" onClick={() => setAddSearchOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy !== null}>
              {busy === "add_search_key" ? <Loader2 size={12} className="spin" /> : <KeyRound size={12} />}
              Save Key
            </button>
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

      <ApiKeyAnalyticsDrawer
        key={
          drawer
            ? drawer.kind === "llm"
              ? `llm:${drawer.key?.id ?? drawer.providerLabel}`
              : `search:${drawer.state.provider}`
            : "closed"
        }
        open={drawer !== null}
        target={drawer}
        sessionToken={sessionToken}
        isSuper={isSuper}
        busy={busy}
        onClose={() => setDrawer(null)}
        onMutate={mutateGateway}
        onRequestEdit={(key) => {
          setDrawer(null);
          openEditModal(key);
        }}
      />
    </div>
  );
}

function ReceiptsTable({
  logs,
  onOpenKey,
}: {
  logs: AiExecutionLogRecord[];
  onOpenKey: (log: AiExecutionLogRecord) => void;
}) {
  const [filter, setFilter] = useState<"all" | "success" | "failed">("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const rows = logs.filter((l) => filter === "all" || l.status === filter);

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 6 }}>
        {(["all", "success", "failed"] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={`btn btn-sm${filter === f ? " btn-primary" : ""}`}
            onClick={() => setFilter(f)}
          >
            {f === "all" ? "All" : f === "success" ? "Success" : "Failed"}
          </button>
        ))}
      </div>
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
            {rows.map((log) => (
              <Fragment key={log.id}>
                <tr
                  style={{ cursor: "pointer" }}
                  onClick={() => setExpanded((v) => (v === log.id ? null : log.id))}
                >
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
                  </td>
                </tr>
                {expanded === log.id && (
                  <tr>
                    <td colSpan={8} className="tiny muted" style={{ whiteSpace: "pre-wrap" }}>
                      {`Requested: ${log.requestedModel ?? "auto"} · Provider: ${log.actualProvider ?? "—"} · Model: ${log.actualModel ?? "—"} · Hops: ${log.fallbackHops}\n${
                        log.errorSummary ? `Error: ${log.errorSummary}` : "No error recorded."
                      }`}
                      {log.actualKeyId && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          style={{ marginLeft: 8 }}
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpenKey(log);
                          }}
                        >
                          Inspect key
                        </button>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
