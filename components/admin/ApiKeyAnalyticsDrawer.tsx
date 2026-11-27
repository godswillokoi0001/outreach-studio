"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Save,
  TestTube2,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import {
  getProviderMeta,
  type AdminAiKeyPublic,
  type AiExecutionLogRecord,
  type KeyAnalyticsSnapshot,
  type SearchKeyAnalyticsSnapshot,
  type SearchProviderState,
} from "@/lib/llm/types";
import { Badge, Banner, Empty, Field, Modal } from "../ui";
import { useConfirm } from "../Feedback";
import { AdminClientError, adminFetch } from "./admin-client";

export type DrawerTarget =
  | { kind: "llm"; providerLabel: string; key: AdminAiKeyPublic | null }
  | { kind: "search"; state: SearchProviderState };

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  paused: "Paused (Reserve)",
  not_configured: "Not Configured",
  cooldown: "Cooldown",
  exhausted: "Exhausted",
  near_limit: "Near Limit",
  invalid: "Invalid Key",
  keyless: "Keyless Always On",
};

function statusTone(status: string): string {
  if (status === "active") return "ok";
  if (status === "paused" || status === "near_limit") return "warn";
  if (status === "cooldown" || status === "exhausted" || status === "invalid") return "bad";
  if (status === "keyless") return "info";
  return "";
}

function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function healthTip(target: DrawerTarget, lastError: string | null): string | null {
  const err = lastError ?? "";
  if (/insufficient balance|no resource package|resource package|insufficient_quota/i.test(err)) {
    return "This account has no active credit or resource package. Pause this key so failover does not waste hops on it.";
  }
  if (/invalid|401|403|rejected/i.test(err)) {
    return "The provider rejected this key. Rotate it with a fresh key, or delete it to keep the pool clean.";
  }
  if (/429|rate limit|per day|daily/i.test(err)) {
    return "The upstream rate or daily limit was hit. It is benched for the current cycle; a second key in this category restores capacity.";
  }
  if (target.kind === "search" && target.state.status === "not_configured") {
    return `${target.state.freeTierNote}. ${target.state.requiresCard ? "A payment card is required at signup." : "No card required."}`;
  }
  return null;
}

export function ApiKeyAnalyticsDrawer({
  open,
  target,
  sessionToken,
  isSuper,
  busy,
  onClose,
  onMutate,
  onRequestEdit,
}: {
  open: boolean;
  target: DrawerTarget | null;
  sessionToken: string;
  isSuper: boolean;
  busy: string | null;
  onClose: () => void;
  onMutate: (label: string, payload: Record<string, unknown>, busyKey: string) => Promise<boolean>;
  onRequestEdit: (key: AdminAiKeyPublic) => void;
}) {
  const [llmStats, setLlmStats] = useState<KeyAnalyticsSnapshot | null>(null);
  const [searchStats, setSearchStats] = useState<SearchKeyAnalyticsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedLog, setExpandedLog] = useState<string | null>(null);
  const [probe, setProbe] = useState<{ ok: boolean; text: string } | null>(null);
  const [probing, setProbing] = useState(false);
  const confirmDialog = useConfirm();

  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotateValue, setRotateValue] = useState("");
  const initialSearch = target?.kind === "search" ? target.state : null;
  const [searchLabelDraft, setSearchLabelDraft] = useState(initialSearch?.label ?? "");
  const [searchLimitDraft, setSearchLimitDraft] = useState(initialSearch?.quota.limit ?? 0);

  const llmKey = target?.kind === "llm" ? target.key : null;
  const searchState = target?.kind === "search" ? target.state : null;

  // The parent keys this component by target, so switching provider remounts
  // with clean state instead of resetting it synchronously in an effect.
  useEffect(() => {
    if (!open || !target) return;
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const query =
          target.kind === "llm"
            ? target.key
              ? `?action=key_analytics&keyId=${encodeURIComponent(target.key.id)}&provider=${encodeURIComponent(target.key.provider)}`
              : `?action=key_analytics&provider=${encodeURIComponent(target.providerLabel)}`
            : `?action=search_key_analytics&provider=${encodeURIComponent(target.state.provider)}`;
        const res = await adminFetch<{
          analytics: KeyAnalyticsSnapshot | SearchKeyAnalyticsSnapshot;
        }>(`/api/admin/gateway${query}`, { sessionToken });
        if (cancelled) return;
        if (target.kind === "llm") setLlmStats(res.analytics as KeyAnalyticsSnapshot);
        else setSearchStats(res.analytics as SearchKeyAnalyticsSnapshot);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof AdminClientError && err.code === "ADMIN_REAUTH_REQUIRED") {
          setError("Session needs re-authentication. Close this panel and retry the action.");
        } else {
          setError(err instanceof Error ? err.message : "Could not load key analytics.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [open, target, sessionToken]);

  const reload = useCallback(async () => {
    if (!target) return;
    const query =
      target.kind === "llm"
        ? target.key
          ? `?action=key_analytics&keyId=${encodeURIComponent(target.key.id)}&provider=${encodeURIComponent(target.key.provider)}`
          : `?action=key_analytics&provider=${encodeURIComponent(target.providerLabel)}`
        : `?action=search_key_analytics&provider=${encodeURIComponent(target.state.provider)}`;
    try {
      const res = await adminFetch<{ analytics: KeyAnalyticsSnapshot | SearchKeyAnalyticsSnapshot }>(
        `/api/admin/gateway${query}`,
        { sessionToken },
      );
      if (target.kind === "llm") setLlmStats(res.analytics as KeyAnalyticsSnapshot);
      else setSearchStats(res.analytics as SearchKeyAnalyticsSnapshot);
    } catch {
      /* the panel already shows the last good snapshot */
    }
  }, [target, sessionToken]);

  if (!target) return null;

  const isLlm = target.kind === "llm";
  const key = llmKey;
  const state = searchState;
  const status = isLlm
    ? key
      ? !key.enabled
        ? "paused"
        : key.healthStatus
      : "not_configured"
    : state?.status ?? "not_configured";
  const lastError = isLlm ? key?.lastError ?? null : state?.lastError ?? null;
  const tip = healthTip(target, lastError);

  const title = isLlm ? key?.label || `${target.providerLabel} (no key saved)` : state?.label ?? "Provider";
  const providerMeta = target.kind === "llm" ? getProviderMeta(target.providerLabel) : null;
  const docsUrl = isLlm ? providerMeta?.docsUrl ?? null : state?.docsUrl ?? null;
  const balanceStuck = /insufficient balance|no resource package|resource package|insufficient_quota/i.test(
    lastError ?? "",
  );

  const logs: AiExecutionLogRecord[] = isLlm ? llmStats?.recentLogs ?? [] : [];

  const runProbe = async () => {
    const probeKeyId = isLlm ? key?.id : state?.keyId;
    if (!probeKeyId) return;
    setProbing(true);
    setProbe(null);
    try {
      const res = await adminFetch<{ ok?: boolean; probe?: { model: string; ms: number }; error?: string }>(
        "/api/admin/gateway",
        {
          method: "POST",
          sessionToken,
          body: { action: isLlm ? "test_key" : "test_search_key", keyId: probeKeyId },
        },
      );
      setProbe({
        ok: true,
        text: `HTTP 200 · ${res.probe?.ms ?? "—"}ms · ${res.probe?.model ?? "probe passed"}`,
      });
      void reload();
    } catch (err) {
      setProbe({ ok: false, text: err instanceof Error ? err.message : "Probe failed." });
    } finally {
      setProbing(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Provider & Key Details · ${title}`} large>
      <div className="stack" style={{ gap: 14 }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
          <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <Badge>{isLlm ? "AI / LLM" : (state?.category ?? "search").replace("_", " ")}</Badge>
            {isLlm ? (
              key?.maskedKey ? <Badge>{key.maskedKey}</Badge> : <Badge>No key saved</Badge>
            ) : (
              state?.maskedKey && <Badge>{state.maskedKey}</Badge>
            )}
            <Badge tone={statusTone(status)}>{STATUS_LABEL[status] ?? status}</Badge>
            {isLlm && balanceStuck && <Badge tone="bad">No Balance — Pause Recommended</Badge>}
            {isLlm && key && (
              <Badge>{key.models.filter((m) => m.enabled).length} / {key.models.length} models</Badge>
            )}
          </div>
          {docsUrl && (
            <a className="btn btn-sm" href={docsUrl} target="_blank" rel="noreferrer noopener">
              {isLlm && !key ? "Get API Key" : "Open Provider Dashboard"}
              <ExternalLink size={12} />
            </a>
          )}
        </div>

        {error && <Banner tone="bad">{error}</Banner>}
        {probe && <Banner tone={probe.ok ? "ok" : "bad"}>{probe.text}</Banner>}

        {/* Instant action bar */}
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {isLlm && key && isSuper && (
            <>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy !== null}
                onClick={() =>
                  void onMutate(
                    `${key.enabled ? "Pause" : "Enable"} ${key.label}`,
                    { action: "toggle_key", keyId: key.id, enabled: !key.enabled },
                    `drawer_toggle_${key.id}`,
                  ).then(reload)
                }
              >
                {key.enabled ? <Pause size={12} /> : <Play size={12} />}
                {key.enabled ? "Pause (Reserve)" : "Activate"}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy !== null || probing}
                onClick={() => void runProbe()}
              >
                {probing ? <Loader2 size={12} className="spin" /> : <TestTube2 size={12} />}
                Test Connection
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy !== null}
                onClick={() =>
                  void onMutate(
                    `Reset ${key.label}`,
                    { action: "clear_cooldown", keyId: key.id },
                    `drawer_reset_${key.id}`,
                  ).then(reload)
                }
              >
                <RotateCcw size={12} />
                Reset Cooldown
              </button>
              <button type="button" className="btn btn-sm" onClick={() => onRequestEdit(key)}>
                <Save size={12} />
                Edit Label &amp; Limits
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setRotateOpen((v) => !v)}>
                <KeyRound size={12} />
                Rotate Key
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={busy !== null}
                onClick={async () => {
                  const confirmed = await confirmDialog({
                    title: `Remove ${key.label}?`,
                    message: "This pooled key will be permanently removed from the gateway.",
                    confirmLabel: "Delete key",
                    tone: "bad",
                  });
                  if (!confirmed) return;
                  const ok = await onMutate(
                    `Delete ${key.label}`,
                    { action: "delete_key", keyId: key.id },
                    `drawer_delete_${key.id}`,
                  );
                  if (ok) onClose();
                }}
              >
                <Trash2 size={12} />
                Delete
              </button>
            </>
          )}

          {!isLlm && state && state.keyId && isSuper && (
            <>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy !== null}
                onClick={() =>
                  void onMutate(
                    `${state.enabled ? "Pause" : "Enable"} ${state.label}`,
                    { action: "toggle_search_key", keyId: state.keyId, enabled: !state.enabled },
                    `drawer_stoggle_${state.keyId}`,
                  ).then(reload)
                }
              >
                {state.enabled ? <Pause size={12} /> : <Play size={12} />}
                {state.enabled ? "Pause (Reserve)" : "Activate"}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy !== null || probing}
                onClick={() => void runProbe()}
              >
                {probing ? <Loader2 size={12} className="spin" /> : <TestTube2 size={12} />}
                Test Connection
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy !== null}
                onClick={() =>
                  void onMutate(
                    `Reset ${state.label} usage counter`,
                    { action: "reset_search_quota", provider: state.provider },
                    `drawer_sreset_${state.keyId}`,
                  ).then(reload)
                }
              >
                <RotateCcw size={12} />
                Reset Counter
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setRotateOpen((v) => !v)}>
                <KeyRound size={12} />
                Update Key
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={busy !== null}
                onClick={async () => {
                  const confirmed = await confirmDialog({
                    title: `Remove ${state.label}?`,
                    message: "This search/enrichment key will be permanently removed.",
                    confirmLabel: "Delete key",
                    tone: "bad",
                  });
                  if (!confirmed) return;
                  const ok = await onMutate(
                    `Remove ${state.label}`,
                    { action: "delete_search_key", keyId: state.keyId },
                    `drawer_sdel_${state.keyId}`,
                  );
                  if (ok) onClose();
                }}
              >
                <Trash2 size={12} />
                Delete
              </button>
            </>
          )}
        </div>

        {rotateOpen && (
          <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ flex: "1 1 260px" }}>
              <Field label={isLlm ? "New API Key" : state?.dualField ? "New Key (both parts joined with :)" : "New API Key"}>
                <input
                  className="input"
                  type="password"
                  autoComplete="off"
                  value={rotateValue}
                  onChange={(e) => setRotateValue(e.target.value)}
                  placeholder={isLlm ? "Paste replacement key…" : "Paste replacement key…"}
                />
              </Field>
            </div>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!rotateValue.trim() || busy !== null}
              onClick={async () => {
                const ok = isLlm
                  ? await onMutate(
                      `Rotate ${key?.label ?? "key"}`,
                      { action: "update_key", keyId: key?.id, apiKey: rotateValue.trim() },
                      "drawer_rotate",
                    )
                  : await onMutate(
                      `Rotate ${state?.label ?? "key"}`,
                      { action: "update_search_key", keyId: state?.keyId, apiKey: rotateValue.trim() },
                      "drawer_srotate",
                    );
                if (ok) {
                  setRotateValue("");
                  setRotateOpen(false);
                  void reload();
                }
              }}
            >
              <Save size={12} />
              Save New Key
            </button>
          </div>
        )}

        {!isLlm && state && state.keyId && isSuper && (
          <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ flex: "1 1 200px" }}>
              <Field label="Key label">
                <input
                  className="input"
                  type="text"
                  value={searchLabelDraft}
                  onChange={(e) => setSearchLabelDraft(e.target.value)}
                />
              </Field>
            </div>
            <div style={{ flex: "0 1 170px" }}>
              <Field label="Custom quota limit" hint="Overrides the provider default.">
                <input
                  className="input"
                  type="number"
                  min={0}
                  value={searchLimitDraft}
                  onChange={(e) => setSearchLimitDraft(Number(e.target.value) || 0)}
                />
              </Field>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={async () => {
                if (searchLabelDraft.trim() && searchLabelDraft.trim() !== state.label) {
                  await onMutate(
                    `Relabel ${state.label}`,
                    { action: "update_search_key", keyId: state.keyId, label: searchLabelDraft.trim() },
                    "drawer_slabel",
                  );
                }
                if (searchLimitDraft !== state.quota.limit) {
                  await onMutate(
                    `Update ${state.label} quota`,
                    { action: "update_search_quota", provider: state.provider, quotaLimit: searchLimitDraft },
                    "drawer_squota",
                  );
                }
                void reload();
              }}
            >
              <Save size={12} />
              Save Label &amp; Limit
            </button>
          </div>
        )}

        {isLlm && !key && (
          <Banner tone="info">
            <div className="stack" style={{ gap: 6 }}>
              <span>
                <strong>{providerMeta?.label}</strong> has no saved key.{" "}
                {providerMeta?.freeTierDefault
                  ? "Free tier is available and needs no card for its free models."
                  : "This provider needs a paid or BYOK key."}
              </span>
              <span className="tiny muted">{providerMeta?.blurb}</span>
              {isSuper && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    const provider = target.kind === "llm" ? target.providerLabel : null;
                    onClose();
                    window.dispatchEvent(
                      new CustomEvent("admin:add-llm-key", { detail: { provider } }),
                    );
                  }}
                >
                  Add Key Now
                </button>
              )}
            </div>
          </Banner>
        )}

        {/* Usage analytics */}
        {loading && <div className="tiny muted row" style={{ gap: 6 }}><Loader2 size={13} className="spin" /> Loading live analytics…</div>}

        {isLlm && (
          <div className="grid grid-3" style={{ gap: 10 }}>
            <div className="card tight" style={{ padding: 12 }}>
              <div className="tiny muted">Calls (24h / 7d / all)</div>
              <div className="strong">
                {llmStats ? `${llmStats.calls24h} / ${llmStats.calls7d} / ${llmStats.totalCalls}` : "—"}
              </div>
            </div>
            <div className="card tight" style={{ padding: 12 }}>
              <div className="tiny muted">Success rate</div>
              <div className="strong">{llmStats?.successRate === null || !llmStats ? "—" : `${llmStats.successRate}%`}</div>
            </div>
            <div className="card tight" style={{ padding: 12 }}>
              <div className="tiny muted">Avg / P95 latency</div>
              <div className="strong">
                {llmStats ? `${formatMs(llmStats.avgLatencyMs)} / ${formatMs(llmStats.p95LatencyMs)}` : "—"}
              </div>
            </div>
            <div className="card tight" style={{ padding: 12 }}>
              <div className="tiny muted">Avg fallback hops</div>
              <div className="strong">{llmStats?.avgFallbackHops ?? "—"}</div>
            </div>
            <div className="card tight" style={{ padding: 12 }}>
              <div className="tiny muted">Models enabled</div>
              <div className="strong">{key ? `${key.models.filter((m) => m.enabled).length} / ${key.models.length}` : "—"}</div>
            </div>
            <div className="card tight" style={{ padding: 12 }}>
              <div className="tiny muted">Top feature</div>
              <div className="strong">{llmStats?.topFeatures[0]?.feature ?? "—"}</div>
            </div>
          </div>
        )}

        {isLlm && key && (
          <div className="grid grid-2" style={{ gap: 10 }}>
            {[
              { label: "RPM", used: key.rpmUsed ?? 0, limit: key.rpmLimit },
              { label: "RPD", used: key.rpdUsed ?? 0, limit: key.rpdLimit },
            ].map((bar) => {
              const pct = Math.min(100, Math.round((bar.used / Math.max(1, bar.limit)) * 100));
              return (
                <div key={bar.label}>
                  <div className="row tiny muted" style={{ justifyContent: "space-between" }}>
                    <span>{bar.label} window</span>
                    <span>{bar.used} / {bar.limit} ({pct}%)</span>
                  </div>
                  <div style={{ height: 6, borderRadius: 4, background: "var(--line)", overflow: "hidden", marginTop: 3 }}>
                    <div style={{ height: "100%", width: `${pct}%`, background: pct >= 85 ? "var(--warn)" : "var(--teal-deep)" }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {!isLlm && state && (
          <>
            <div className="grid grid-3" style={{ gap: 10 }}>
              <div className="card tight" style={{ padding: 12 }}>
                <div className="tiny muted">Quota used</div>
                <div className="strong">{state.quota.limit > 0 ? `${state.quota.used} / ${state.quota.limit}` : `${state.quota.used} free`}</div>
              </div>
              <div className="card tight" style={{ padding: 12 }}>
                <div className="tiny muted">Refill cycle</div>
                <div className="strong">
                  {state.quota.resetCycle === "monthly"
                    ? "Monthly (UTC 1st)"
                    : state.quota.resetCycle === "daily"
                      ? "Daily (UTC midnight)"
                      : state.quota.resetCycle === "one_time"
                        ? "One-time reserve"
                        : "Keyless"}
                </div>
              </div>
              <div className="card tight" style={{ padding: 12 }}>
                <div className="tiny muted">Next reset</div>
                <div className="strong">{state.quota.nextResetAt ? formatWhen(state.quota.nextResetAt) : "—"}</div>
              </div>
              <div className="card tight" style={{ padding: 12 }}>
                <div className="tiny muted">Cache hits served</div>
                <div className="strong">{searchStats?.cacheHitsSaved ?? state.quota.cacheHits}</div>
              </div>
              <div className="card tight" style={{ padding: 12 }}>
                <div className="tiny muted">Hit rate</div>
                <div className="strong">{searchStats?.hitRate === null || !searchStats ? "—" : `${searchStats.hitRate}%`}</div>
              </div>
              <div className="card tight" style={{ padding: 12 }}>
                <div className="tiny muted">Priority order</div>
                <div className="strong tiny">{state.blurb}</div>
              </div>
            </div>

            {state.quota.limit > 0 && (
              <div>
                <div className="row tiny muted" style={{ justifyContent: "space-between" }}>
                  <span>Quota consumed</span>
                  <span>{Math.min(100, Math.round((state.quota.used / state.quota.limit) * 100))}%</span>
                </div>
                <div style={{ height: 6, borderRadius: 4, background: "var(--line)", overflow: "hidden", marginTop: 3 }}>
                  <div
                    style={{
                      height: "100%",
                      width: `${Math.min(100, Math.round((state.quota.used / state.quota.limit) * 100))}%`,
                      background: state.status === "exhausted" ? "var(--bad)" : state.status === "near_limit" ? "var(--warn)" : "var(--teal-deep)",
                    }}
                  />
                </div>
              </div>
            )}

            {state.status === "not_configured" && isSuper && (
              <Banner tone="info">
                <div className="stack" style={{ gap: 6 }}>
                  <span>
                    <strong>{state.label}</strong> has no saved key. {state.freeTierNote}.
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      onClose();
                      window.dispatchEvent(
                        new CustomEvent("admin:add-search-key", { detail: { provider: state.provider } }),
                      );
                    }}
                  >
                    Add Key Now
                  </button>
                </div>
              </Banner>
            )}
          </>
        )}

        {tip && (
          <Banner tone={status === "active" ? "info" : "warn"}>
            <span className="row" style={{ gap: 6, alignItems: "flex-start" }}>
              <TriangleAlert size={14} />
              <span>{tip}</span>
            </span>
          </Banner>
        )}

        {isLlm && llmStats && llmStats.topFeatures.length > 0 && (
          <div>
            <div className="strong tiny" style={{ marginBottom: 6 }}>Top features served</div>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              {llmStats.topFeatures.map((f) => (
                <Badge key={f.feature}>{f.feature} · {f.count}</Badge>
              ))}
            </div>
          </div>
        )}

        {isLlm && (
          <div>
            <div className="strong tiny" style={{ marginBottom: 6 }}>
              Recent activity for this key ({logs.length})
            </div>
            {logs.length === 0 ? (
              <Empty title="No receipts for this key yet">
                <p className="tiny muted">Run any AI action or a Test Connection probe to populate this list.</p>
              </Empty>
            ) : (
              <div style={{ maxHeight: 300, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 8 }}>
                {logs.map((log) => (
                  <button
                    key={log.id}
                    type="button"
                    onClick={() => setExpandedLog((v) => (v === log.id ? null : log.id))}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "8px 10px",
                      border: "none",
                      borderBottom: "1px solid var(--line)",
                      background: "transparent",
                      cursor: "pointer",
                    }}
                  >
                    <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                      <span className="tiny muted">{formatWhen(log.createdAt)}</span>
                      <span className="tiny">{log.feature}</span>
                      <Badge tone={log.status === "success" ? "ok" : "bad"}>{log.status}</Badge>
                      <span className="tiny">{log.latencyMs}ms</span>
                      <span className="tiny muted">hops {log.fallbackHops}</span>
                    </div>
                    {expandedLog === log.id && (
                      <div className="tiny muted" style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>
                        Lesson: {log.taskType} seat · model {log.actualModel ?? "—"} · mode {log.requestedMode}
                        {log.grounded ? " · grounded" : ""}
                        {log.errorSummary ? `\nError: ${log.errorSummary}` : ""}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {isLlm && key && key.models.length > 0 && (
          <div>
            <div className="strong tiny" style={{ marginBottom: 6 }}>
              Model health · click a model to enable or disable it for every seat
            </div>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              {key.models.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`btn btn-sm${m.enabled ? " btn-primary" : ""}`}
                  disabled={busy !== null || !isSuper}
                  title={m.enabled ? "Disable this model" : "Enable this model"}
                  onClick={() =>
                    void onMutate(
                      `${m.enabled ? "Disable" : "Enable"} ${m.displayName || m.id}`,
                      {
                        action: "update_key",
                        keyId: key.id,
                        models: key.models.map((item) =>
                          item.id === m.id ? { ...item, enabled: !item.enabled } : item,
                        ),
                      },
                      `drawer_model_${m.id}`,
                    ).then(reload)
                  }
                >
                  {m.displayName || m.id}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <span className="tiny muted row" style={{ gap: 5 }}>
            <Activity size={12} /> Real Supabase receipts
            <CheckCircle2 size={12} />
          </span>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
