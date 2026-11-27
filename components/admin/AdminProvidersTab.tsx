"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  Cpu,
  KeyRound,
  Loader2,
  RotateCcw,
  Save,
  Sliders,
  TestTube2,
  Trash2,
} from "lucide-react";
import type { AiProviderId } from "@/lib/ai/types";
import {
  AI_FEATURE_LABELS,
  type AdminRole,
  type AiFeatureKey,
  type PlatformModelOption,
  type PlatformPolicyPublic,
  type PlatformProviderPublic,
  type PlatformQuotaConfig,
} from "@/lib/platform/types";
import { Badge, Banner, Card, Empty, Field, Modal } from "../ui";
import { BrandLoader } from "../BrandLoader";
import { useConfirm, useToast } from "../Feedback";
import { AdminClientError, adminFetch } from "./admin-client";

interface BreakdownPayload {
  byProvider: Record<string, { requests: number; tokens: number; costUsd: number; errors: number }>;
  byModel: Record<string, { requests: number; tokens: number; costUsd: number }>;
  byFeature: Record<string, { requests: number; tokens: number; costUsd: number }>;
  byUser: { ownerId: string; email: string; requests: number; costUsd: number }[];
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

  const [policy, setPolicy] = useState<PlatformPolicyPublic | null>(null);
  const [breakdown, setBreakdown] = useState<BreakdownPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Per-provider key replacement modal
  const [keyModalProvider, setKeyModalProvider] = useState<PlatformProviderPublic | null>(null);
  const [newKeyInput, setNewKeyInput] = useState("");
  const [newBaseUrl, setNewBaseUrl] = useState("");

  // Per-provider model toggles modal
  const [modelsModalProvider, setModelsModalProvider] = useState<PlatformProviderPublic | null>(null);
  const [editedModels, setEditedModels] = useState<PlatformModelOption[]>([]);

  // Routing & quotas local edits
  const [quotasDraft, setQuotasDraft] = useState<PlatformQuotaConfig | null>(null);
  const [defaultsDraft, setDefaultsDraft] = useState<Record<
    AiFeatureKey,
    { provider: AiProviderId; model: string }
  > | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminFetch<{ policy: PlatformPolicyPublic; breakdown: BreakdownPayload }>(
        "/api/admin/providers",
        { sessionToken },
      );
      setPolicy(res.policy);
      setBreakdown(res.breakdown);
      setQuotasDraft(res.policy.quotas);
      setDefaultsDraft(res.policy.featureDefaults);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load providers.");
    } finally {
      setLoading(false);
    }
  }, [sessionToken]);

  useEffect(() => {
    const t = window.setTimeout(() => void loadData(), 0);
    return () => window.clearTimeout(t);
  }, [loadData]);

  const mutateProvider = async (
    label: string,
    payload: Record<string, unknown>,
    busyKey: string,
    tokenOverride?: string,
  ): Promise<boolean> => {
    setBusy(busyKey);
    setError(null);
    try {
      const res = await adminFetch<{ policy: PlatformPolicyPublic; probe?: { model: string; ms: number } }>(
        "/api/admin/providers",
        {
          method: "POST",
          sessionToken,
          reauthToken: tokenOverride ?? reauthToken,
          body: payload,
        },
      );
      setPolicy(res.policy);
      setQuotasDraft(res.policy.quotas);
      setDefaultsDraft(res.policy.featureDefaults);
      toast.success(
        label,
        res.probe ? `Verified ${res.probe.model} (${res.probe.ms}ms)` : "Updated platform settings.",
      );
      return true;
    } catch (err) {
      if (err instanceof AdminClientError && err.code === "ADMIN_REAUTH_REQUIRED") {
        onNeedReauth(label, async (fresh) => {
          await mutateProvider(label, payload, busyKey, fresh);
        });
        return false;
      }
      const msg = err instanceof Error ? err.message : "Operation failed.";
      setError(msg);
      toast.error("Action failed", msg);
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (loading && !policy) return <BrandLoader />;

  const allEnabledModels: { provider: AiProviderId; label: string; model: string; displayName: string }[] = [];
  if (policy) {
    for (const p of policy.providers) {
      if (!p.enabled || !p.hasKey) continue;
      for (const m of p.models) {
        if (m.enabled) {
          allEnabledModels.push({
            provider: p.id,
            label: p.label,
            model: m.id,
            displayName: m.displayName || m.id,
          });
        }
      }
    }
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      {error && <Banner tone="bad">{error}</Banner>}

      {!isSuper && (
        <Banner tone="info">
          Only <strong>Super Admins</strong> can add, rotate, delete platform keys or modify routing/quotas. You have
          read access to usage and cost metrics.
        </Banner>
      )}

      {/* Platform API Keys Grid */}
      {policy && (
        <Card
          title="Platform API Keys & Providers"
          sub="Keys are AES-256-GCM encrypted at rest on the server and displayed masked only. Users automatically run on enabled models below."
        >
          <div className="grid grid-2" style={{ gap: 12 }}>
            {policy.providers.map((prov) => (
              <div
                key={prov.id}
                style={{
                  padding: 14,
                  borderRadius: 10,
                  border: `1px solid ${prov.enabled && prov.hasKey ? "var(--teal-deep)" : "var(--line)"}`,
                  background: "var(--surface)",
                }}
              >
                <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                  <div>
                    <div className="row" style={{ gap: 6, alignItems: "center" }}>
                      <span className="strong">{prov.label}</span>
                      {prov.hasKey ? (
                        <Badge tone="ok">{prov.maskedKey}</Badge>
                      ) : (
                        <Badge>No key</Badge>
                      )}
                      {prov.enabled && <Badge tone="info">Enabled</Badge>}
                    </div>
                    <div className="tiny muted" style={{ marginTop: 4 }}>
                      {prov.models.filter((m) => m.enabled).length} of {prov.models.length} models enabled
                      {prov.lastTestedAt && (
                        <> · Last test {prov.lastTestOk ? "passed" : "failed"}</>
                      )}
                    </div>
                    {prov.lastTestError && (
                      <div className="tiny" style={{ color: "var(--bad)", marginTop: 2 }}>
                        {prov.lastTestError}
                      </div>
                    )}
                  </div>

                  {isSuper && (
                    <label className="row tiny" style={{ gap: 5, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={prov.enabled}
                        disabled={!prov.hasKey || busy !== null}
                        onChange={(e) =>
                          void mutateProvider(
                            `${e.target.checked ? "Enable" : "Disable"} ${prov.label}`,
                            { action: "toggle_provider", provider: prov.id, enabled: e.target.checked },
                            `toggle_${prov.id}`,
                          )
                        }
                      />
                      Active
                    </label>
                  )}
                </div>

                {isSuper && (
                  <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 12 }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        setKeyModalProvider(prov);
                        setNewKeyInput("");
                        setNewBaseUrl(prov.baseUrl || "");
                      }}
                    >
                      <KeyRound size={12} />
                      {prov.hasKey ? "Rotate key" : "Add key"}
                    </button>

                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={!prov.hasKey || busy !== null}
                      onClick={() =>
                        void mutateProvider(
                          `Test ${prov.label} connection`,
                          { action: "test_connection", provider: prov.id },
                          `test_${prov.id}`,
                        )
                      }
                    >
                      {busy === `test_${prov.id}` ? (
                        <Loader2 size={12} className="spin" />
                      ) : (
                        <TestTube2 size={12} />
                      )}
                      Test connection
                    </button>

                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        setModelsModalProvider(prov);
                        setEditedModels(prov.models.map((m) => ({ ...m })));
                      }}
                    >
                      <Sliders size={12} />
                      Models
                    </button>

                    {prov.hasKey && !prov.maskedKey.startsWith("env-") && (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        style={{ color: "var(--bad)" }}
                        onClick={async () => {
                          const ok = await confirmDialog({
                            title: `Delete platform ${prov.label} key?`,
                            message: "Users relying on this shared provider will be routed to fallbacks.",
                            confirmLabel: "Delete key",
                            tone: "bad",
                          });
                          if (ok) {
                            await mutateProvider(
                              `Delete ${prov.label} key`,
                              { action: "delete_key", provider: prov.id },
                              `del_${prov.id}`,
                            );
                          }
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Feature Default Models & Quotas */}
      {policy && quotasDraft && defaultsDraft && (
        <div className="grid grid-2" style={{ gap: 16 }}>
          <Card
            title="Default Model Per Feature"
            sub="Used automatically when a user runs on platform shared keys"
          >
            <div className="stack" style={{ gap: 10 }}>
              {(Object.keys(AI_FEATURE_LABELS) as AiFeatureKey[]).map((feat) => {
                const cur = defaultsDraft[feat];
                const curKey = `${cur.provider}::${cur.model}`;
                return (
                  <Field key={feat} label={AI_FEATURE_LABELS[feat]}>
                    <select
                      className="input"
                      disabled={!isSuper}
                      value={curKey}
                      onChange={(e) => {
                        const [provider, model] = e.target.value.split("::") as [AiProviderId, string];
                        setDefaultsDraft((prev) =>
                          prev ? { ...prev, [feat]: { provider, model } } : prev,
                        );
                      }}
                    >
                      {!allEnabledModels.some((m) => `${m.provider}::${m.model}` === curKey) && (
                        <option value={curKey}>{cur.provider} — {cur.model} (Current)</option>
                      )}
                      {allEnabledModels.map((m) => (
                        <option key={`${m.provider}::${m.model}`} value={`${m.provider}::${m.model}`}>
                          {m.label} — {m.displayName}
                        </option>
                      ))}
                    </select>
                  </Field>
                );
              })}

              {isSuper && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busy !== null}
                  onClick={() =>
                    void mutateProvider(
                      "Save feature defaults & quotas",
                      {
                        action: "update_routing",
                        featureDefaults: defaultsDraft,
                        quotas: quotasDraft,
                      },
                      "save_routing",
                    )
                  }
                >
                  <Save size={13} /> Save feature routing
                </button>
              )}
            </div>
          </Card>

          <Card
            title="Quotas, Rate Limits & Spend Cap"
            sub="Applies to platform shared-key usage only; BYOK personal keys are never capped"
          >
            <div className="stack" style={{ gap: 10 }}>
              <div className="grid grid-2" style={{ gap: 10 }}>
                <Field label="Daily requests / user">
                  <input
                    className="input"
                    type="number"
                    disabled={!isSuper}
                    value={quotasDraft.dailyRequestsPerUser}
                    onChange={(e) =>
                      setQuotasDraft({ ...quotasDraft, dailyRequestsPerUser: Number(e.target.value) || 100 })
                    }
                  />
                </Field>
                <Field label="Monthly requests / user">
                  <input
                    className="input"
                    type="number"
                    disabled={!isSuper}
                    value={quotasDraft.monthlyRequestsPerUser}
                    onChange={(e) =>
                      setQuotasDraft({ ...quotasDraft, monthlyRequestsPerUser: Number(e.target.value) || 1500 })
                    }
                  />
                </Field>
                <Field label="Rate limit (req / min)">
                  <input
                    className="input"
                    type="number"
                    disabled={!isSuper}
                    value={quotasDraft.rateLimitPerMinute}
                    onChange={(e) =>
                      setQuotasDraft({ ...quotasDraft, rateLimitPerMinute: Number(e.target.value) || 25 })
                    }
                  />
                </Field>
                <Field label="Monthly Spend Cap ($ USD)">
                  <input
                    className="input"
                    type="number"
                    disabled={!isSuper}
                    value={quotasDraft.monthlySpendCapUsd}
                    onChange={(e) =>
                      setQuotasDraft({ ...quotasDraft, monthlySpendCapUsd: Number(e.target.value) || 250 })
                    }
                  />
                </Field>
              </div>
              <Field label={`Spend alert threshold (${quotasDraft.alertThresholdPct}%)`}>
                <input
                  type="range"
                  min={50}
                  max={100}
                  disabled={!isSuper}
                  value={quotasDraft.alertThresholdPct}
                  onChange={(e) =>
                    setQuotasDraft({ ...quotasDraft, alertThresholdPct: Number(e.target.value) })
                  }
                />
              </Field>

              {isSuper && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busy !== null}
                  onClick={() =>
                    void mutateProvider(
                      "Save platform quotas & spend cap",
                      {
                        action: "update_routing",
                        featureDefaults: defaultsDraft,
                        quotas: quotasDraft,
                      },
                      "save_quotas",
                    )
                  }
                >
                  <Save size={13} /> Save limits &amp; spend cap
                </button>
              )}
            </div>
          </Card>
        </div>
      )}

      {/* Usage & Cost Breakdown */}
      {breakdown && (
        <div className="grid grid-2" style={{ gap: 16 }}>
          <Card title="Usage & Cost by Provider & Feature" sub="Last 30 days">
            {Object.keys(breakdown.byProvider).length === 0 ? (
              <Empty title="No AI usage logged yet" />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Provider / Feature</th>
                      <th className="num">Requests</th>
                      <th className="num">Tokens</th>
                      <th className="num">Est. Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(breakdown.byProvider).map(([p, s]) => (
                      <tr key={p}>
                        <td className="strong">{p}</td>
                        <td className="num">{s.requests}</td>
                        <td className="num">{s.tokens.toLocaleString()}</td>
                        <td className="num">${s.costUsd.toFixed(4)}</td>
                      </tr>
                    ))}
                    {Object.entries(breakdown.byFeature).map(([f, s]) => (
                      <tr key={f}>
                        <td className="tiny muted">Feature: {f.replace(/_/g, " ")}</td>
                        <td className="num tiny">{s.requests}</td>
                        <td className="num tiny">{s.tokens.toLocaleString()}</td>
                        <td className="num tiny">${s.costUsd.toFixed(4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Top Platform-Key Consumers" sub="Users consuming shared platform quota">
            {breakdown.byUser.length === 0 ? (
              <Empty title="No platform usage recorded yet" />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>User</th>
                      <th className="num">Platform Requests</th>
                      <th className="num">Est. Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {breakdown.byUser.slice(0, 10).map((u) => (
                      <tr key={u.ownerId}>
                        <td className="tiny strong">{u.email}</td>
                        <td className="num">{u.requests}</td>
                        <td className="num">${u.costUsd.toFixed(4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Add / Rotate Key Modal */}
      <Modal
        open={Boolean(keyModalProvider)}
        onClose={() => setKeyModalProvider(null)}
        title={keyModalProvider ? `${keyModalProvider.hasKey ? "Rotate" : "Add"} ${keyModalProvider.label} Platform Key` : ""}
      >
        {keyModalProvider && (
          <div className="stack" style={{ gap: 12 }}>
            <Banner tone="info">
              This key is immediately AES-256-GCM encrypted on the server and will never be viewable again (shown only
              as masked hint).
            </Banner>
            <Field label="New API Key">
              <input
                className="input"
                type="password"
                autoComplete="off"
                value={newKeyInput}
                onChange={(e) => setNewKeyInput(e.target.value)}
                placeholder="Paste provider API key…"
              />
            </Field>
            {keyModalProvider.id === "custom" && (
              <Field label="Base URL">
                <input
                  className="input"
                  value={newBaseUrl}
                  onChange={(e) => setNewBaseUrl(e.target.value)}
                  placeholder="https://api.example.com/v1"
                />
              </Field>
            )}
            <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="btn btn-ghost" onClick={() => setKeyModalProvider(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!newKeyInput.trim() || busy !== null}
                onClick={async () => {
                  const ok = await mutateProvider(
                    `Save ${keyModalProvider.label} key`,
                    {
                      action: "upsert_key",
                      provider: keyModalProvider.id,
                      apiKey: newKeyInput.trim(),
                      baseUrl: newBaseUrl.trim() || undefined,
                    },
                    "save_modal_key",
                  );
                  if (ok) {
                    setNewKeyInput("");
                    setKeyModalProvider(null);
                  }
                }}
              >
                <CheckCircle2 size={13} /> Encrypt &amp; Save Key
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Enable/Disable & Rename Models Modal */}
      <Modal
        open={Boolean(modelsModalProvider)}
        onClose={() => setModelsModalProvider(null)}
        title={modelsModalProvider ? `${modelsModalProvider.label} Enabled Models` : ""}
        large
      >
        {modelsModalProvider && (
          <div className="stack" style={{ gap: 12 }}>
            <p className="tiny muted" style={{ margin: 0 }}>
              Toggle which models are available to users on platform keys and customize friendly display names. Click{" "}
              <strong>Test connection</strong> to discover live models from this provider first if needed.
            </p>
            <div className="stack" style={{ gap: 8, maxHeight: "48vh", overflowY: "auto" }}>
              {editedModels.map((mod, idx) => (
                <div
                  key={mod.id}
                  className="row"
                  style={{
                    gap: 10,
                    padding: 8,
                    borderRadius: 8,
                    border: "1px solid var(--line)",
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
                  <label className="row tiny" style={{ gap: 6, minWidth: 190 }}>
                    <input
                      type="checkbox"
                      checked={mod.enabled}
                      onChange={(e) =>
                        setEditedModels((prev) =>
                          prev.map((m, i) => (i === idx ? { ...m, enabled: e.target.checked } : m)),
                        )
                      }
                    />
                    <span className="strong" style={{ fontFamily: "var(--mono)", fontSize: 11.5 }}>
                      <Cpu size={11} style={{ verticalAlign: "middle", marginRight: 4 }} />
                      {mod.id}
                    </span>
                  </label>
                  <input
                    className="input"
                    style={{ flex: 1, minWidth: 160 }}
                    value={mod.displayName}
                    onChange={(e) =>
                      setEditedModels((prev) =>
                        prev.map((m, i) => (i === idx ? { ...m, displayName: e.target.value } : m)),
                      )
                    }
                    placeholder="Friendly display name"
                  />
                </div>
              ))}
            </div>
            <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() =>
                  setEditedModels((prev) => prev.map((m) => ({ ...m, enabled: true })))
                }
              >
                <RotateCcw size={12} /> Enable all
              </button>
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn btn-ghost" onClick={() => setModelsModalProvider(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={async () => {
                    const ok = await mutateProvider(
                      `Update ${modelsModalProvider.label} models`,
                      { action: "update_models", provider: modelsModalProvider.id, models: editedModels },
                      "save_models",
                    );
                    if (ok) setModelsModalProvider(null);
                  }}
                >
                  Save model list
                </button>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
