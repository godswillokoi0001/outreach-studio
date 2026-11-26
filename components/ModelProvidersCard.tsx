"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  CircleSlash,
  Cpu,
  Eye,
  EyeOff,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  TestTube2,
  Trash2,
  Volume2,
} from "lucide-react";
import { AI_PROVIDERS, getProvider } from "@/lib/ai/registry";
import type { AiModelOption, AiProviderId } from "@/lib/ai/types";
import { aiConfigFromSettings, setActiveAiConfig } from "@/lib/ai-client";
import {
  guessCapabilities,
  newProviderDraft,
  providersFromSettings,
  providerFromSettings,
  providersPatchFor,
  readActiveProviderId,
  readProviders,
  seedFromSettings,
  setActiveProviderId,
  useActiveProviderId,
  settingsPatchFor,
  toAiConfig,
  writeProviders,
  type SavedProvider,
} from "@/lib/ai/providers";
import { authedPost, errorMessage } from "@/lib/client";
import { saveSettings } from "@/lib/store";
import type { Settings } from "@/lib/types";
import { Badge, Banner, Card, Field } from "./ui";
import { useConfirm, useToast } from "./Feedback";

interface DetectResponse {
  provider: AiProviderId;
  providerLabel: string;
  models: AiModelOption[];
  recommendedModel: string;
  probe: { model: string; ms: number; reply: string };
  warning?: string | null;
}

type Note = { tone: "ok" | "bad" | "info"; text: string } | null;

/**
 * Multi-provider model management: add, test, enable, disable, edit and delete
 * providers, and choose which one every AI feature (and the operator) uses.
 */
export function ModelProvidersCard({
  uid,
  settings,
  onSaved,
}: {
  uid: string;
  settings: Settings;
  onSaved: (settings: Settings) => void;
}) {
  const [overrides, setOverrides] = useState<SavedProvider[] | null>(null);
  const [editing, setEditing] = useState<SavedProvider | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Note>(null);
  const confirmDialog = useConfirm();
  const toast = useToast();

  // The database is the source of truth. localStorage is only a fast cache, so
  // a provider added here is still there after a refresh or on another device.
  const seeded = useMemo(() => {
    const stored = providersFromSettings(settings);
    return seedFromSettings(stored.length > 0 ? stored : readProviders(), settings);
  }, [settings]);
  const providers = overrides ?? seeded;
  const listRef = useRef<SavedProvider[]>(providers);
  useEffect(() => {
    listRef.current = providers;
  }, [providers]);
  // The active provider is shared with the operator. Reading it reactively means
  // a switch made in the operator is reflected here without a reload.
  const storedActive = useActiveProviderId();
  const activeId =
    (storedActive && providers.some((provider) => provider.id === storedActive) ? storedActive : "") ||
    providerFromSettings(providers, settings)?.id ||
    providers.find((provider) => provider.enabled)?.id ||
    "";

  const activeIdRef = useRef(activeId);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const persist = useCallback(
    (updater: SavedProvider[] | ((current: SavedProvider[]) => SavedProvider[])) => {
      const next = typeof updater === "function" ? updater(listRef.current) : updater;
      // Update the ref immediately so a follow-up call in the same handler
      // (save, then test) builds on the list that was just written instead of
      // overwriting it with the previous render's copy.
      listRef.current = next;
      setOverrides(next);
      writeProviders(next);
      // Pass the provider this card shows as active, so editing its model also
      // updates the top-level settings that every AI request actually reads.
      void saveSettings(uid, providersPatchFor(next, activeIdRef.current || readActiveProviderId())).catch((err) => {
        toast.error("Provider saved on this browser only", errorMessage(err));
      });
    },
    [toast, uid],
  );

  useEffect(() => {
    if (seeded.length > 0) writeProviders(seeded);
  }, [seeded]);

  const active = providers.find((provider) => provider.id === activeId) ?? null;

  const applyProvider = async (provider: SavedProvider) => {
    setActiveProviderId(provider.id);
    setActiveAiConfig({
      provider: provider.provider,
      model: provider.model,
      apiKey: provider.apiKey,
      ...(provider.baseUrl.trim() ? { baseUrl: provider.baseUrl.trim() } : {}),
    });
    try {
      const saved = await saveSettings(uid, settingsPatchFor(provider));
      onSaved(saved);
      setNote({
        tone: "ok",
        text: `${provider.name || provider.model} is now used by the operator, research, campaigns and every other AI feature.`,
      });
    } catch (err) {
      const message = errorMessage(err);
      setNote({ tone: "info", text: `Active for this browser session, but the settings save failed: ${message}` });
      toast.error("Could not save the active model", message);
    }
  };

  const testProvider = useCallback(
    async (provider: SavedProvider) => {
      setBusy(`test:${provider.id}`);
      setNote(null);
      try {
        const res = await authedPost<DetectResponse>("/api/ai/provider", {
          provider: provider.provider,
          apiKey: provider.apiKey,
          baseUrl: provider.baseUrl,
          model: provider.model,
        });
        const models = res.models.length ? res.models : provider.models;
        // Never replace a model the user chose. The catalogue can be paginated
        // or omit ids that still work, and "recommended" used to quietly rewrite
        // a selected Pro/other model back to the default Flash model.
        const model = provider.model.trim() || res.recommendedModel || models[0]?.id || "";
        const next: SavedProvider = {
          ...provider,
          provider: res.provider,
          models,
          model,
          verifiedAt: new Date().toISOString(),
          lastError: "",
        };
        persist((current) => current.map((item) => (item.id === provider.id ? next : item)));
        setEditing((draft) => (draft && draft.id === provider.id ? next : draft));
        setNote({
          tone: "ok",
          text: `${res.providerLabel} replied “${res.probe.reply}” in ${res.probe.ms} ms using ${model}. ${
            models.length
          } model${models.length === 1 ? "" : "s"} available.${res.warning ? ` ${res.warning}` : ""}`,
        });
        if (provider.id === activeId) {
          setActiveProviderId(next.id);
          setActiveAiConfig(toAiConfig(next));
        }
      } catch (err) {
        const message = errorMessage(err);
        persist((current) =>
          current.map((item) =>
            item.id === provider.id ? { ...item, lastError: message, verifiedAt: "" } : item,
          ),
        );
        setNote({ tone: "bad", text: message });
        toast.error("Provider test failed", message);
      } finally {
        setBusy(null);
      }
    },
    [activeId, persist, toast],
  );

  const saveDraft = async () => {
    if (!editing) return;
    if (!editing.apiKey.trim()) {
      setNote({ tone: "bad", text: "Add the provider's API key before saving." });
      return;
    }
    const meta = getProvider(editing.provider);
    if (meta?.requiresBaseUrl && !editing.baseUrl.trim()) {
      setNote({ tone: "bad", text: "A custom provider needs its OpenAI-compatible base URL, for example https://your-host/v1." });
      return;
    }
    const caps = guessCapabilities(editing.provider, editing.model);
    const draft: SavedProvider = {
      ...editing,
      name: editing.name.trim() || meta?.label || "Provider",
      baseUrl: editing.baseUrl.trim(),
      apiKey: editing.apiKey.trim(),
      model: editing.model.trim() || meta?.defaultModel || "",
      vision: editing.vision ?? caps.vision,
      audio: editing.audio ?? caps.audio,
      tools: editing.tools ?? caps.tools,
    };
    const exists = listRef.current.some((provider) => provider.id === draft.id);
    const next = exists
      ? listRef.current.map((provider) => (provider.id === draft.id ? draft : provider))
      : [...listRef.current, draft];
    persist(next);
    setEditing(null);
    await testProvider(draft);
    if (next.length === 1) await applyProvider(draft);
  };

  const remove = async (provider: SavedProvider) => {
    const ok = await confirmDialog({
      title: `Delete ${provider.name || provider.model}?`,
      message: "Its key is removed from your saved providers. This cannot be undone.",
      confirmLabel: "Delete provider",
      tone: "bad",
    });
    if (!ok) return;
    const next = listRef.current.filter((item) => item.id !== provider.id);
    persist(next);
    if (provider.id === activeId) {
      const fallback = next.find((item) => item.enabled) ?? null;
      if (fallback) void applyProvider(fallback);
      else {
        setActiveProviderId("");
        setActiveAiConfig(aiConfigFromSettings(settings));
      }
    }
    setNote({ tone: "info", text: "Provider removed." });
  };

  const toggle = (provider: SavedProvider) => {
    const next = listRef.current.map((item) =>
      item.id === provider.id ? { ...item, enabled: !item.enabled } : item,
    );
    persist(next);
    if (provider.enabled && provider.id === activeId) {
      const fallback = next.find((item) => item.enabled && item.id !== provider.id) ?? null;
      if (fallback) void applyProvider(fallback);
    }
  };

  const draftMeta = editing ? getProvider(editing.provider) : null;
  const activeMeta = active ? getProvider(active.provider) : null;

  return (
    <Card
      title="Model providers"
      sub="Add each provider once, test it, then switch models from the operator. The active provider powers every AI feature."
      actions={
        active ? (
          <Badge tone="ok">
            Active: {active.name || activeMeta?.label}
            {active.model &&
            !(active.name || "").toLowerCase().includes(active.model.toLowerCase()) ? (
              <> · {active.model}</>
            ) : null}
          </Badge>
        ) : (
          <Badge tone="warn">Server default</Badge>
        )
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        {note && <Banner tone={note.tone}>{note.text}</Banner>}

        {providers.length === 0 ? (
          <p className="tiny">
            No providers saved yet. Add one to use your own key across the operator, research, campaign writing and
            replies.
          </p>
        ) : (
          <ul className="provider-list">
            {providers.map((provider) => {
              const meta = getProvider(provider.provider);
              const isActive = provider.id === activeId;
              return (
                <li key={provider.id} className="provider-row" data-active={isActive ? "true" : "false"}>
                  <div className="provider-main">
                    <div className="provider-name">
                      <Cpu size={14} aria-hidden="true" />
                      <strong>{provider.name || meta?.label || "Provider"}</strong>
                      {isActive ? <Badge tone="ok">In use</Badge> : null}
                      {!provider.enabled ? <Badge tone="warn">Disabled</Badge> : null}
                      {provider.lastError ? <Badge tone="bad">Last test failed</Badge> : null}
                    </div>
                    <div className="provider-meta">
                      <span>{meta?.label ?? provider.provider}</span>
                      <span className="provider-model">{provider.model || "no model set"}</span>
                      {provider.verifiedAt ? (
                        <span className="tiny">verified {new Date(provider.verifiedAt).toLocaleString()}</span>
                      ) : (
                        <span className="tiny muted">not tested yet</span>
                      )}
                      <span className="provider-caps">
                        {provider.vision ? (
                          <span className="provider-cap" title="Vision (images)">
                            <Eye size={11} aria-hidden="true" /> vision
                          </span>
                        ) : null}
                        {provider.audio ? (
                          <span className="provider-cap" title="Audio">
                            <Volume2 size={11} aria-hidden="true" /> audio
                          </span>
                        ) : null}
                        {provider.tools ? (
                          <span className="provider-cap" title="Tool calling (operator actions)">
                            <CheckCircle2 size={11} aria-hidden="true" /> tools
                          </span>
                        ) : null}
                      </span>
                    </div>
                    {provider.lastError ? <p className="provider-error">{provider.lastError}</p> : null}
                  </div>

                  <div className="provider-actions">
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={() => void applyProvider(provider)}
                      disabled={isActive || !provider.enabled || busy !== null}
                    >
                      Use
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void testProvider(provider)}
                      disabled={busy !== null}
                    >
                      <TestTube2 size={12} />
                      <span>Test connection</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        setEditing(provider);
                        setShowKey(false);
                      }}
                      title="Edit provider"
                      aria-label={`Edit ${provider.name}`}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => toggle(provider)}
                      title={provider.enabled ? "Disable provider" : "Enable provider"}
                      aria-label={provider.enabled ? `Disable ${provider.name}` : `Enable ${provider.name}`}
                    >
                      <CircleSlash size={12} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => void remove(provider)}
                      title="Delete provider"
                      aria-label={`Delete ${provider.name}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {editing ? (
          <div className="provider-editor">
            <div className="grid grid-2">
              <Field label="Name" hint="How it appears in the operator's model switcher.">
                <input
                  className="input"
                  value={editing.name}
                  onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                  placeholder={draftMeta?.label ?? "My model"}
                />
              </Field>
              <Field label="Provider type">
                <select
                  className="select"
                  value={editing.provider}
                  onChange={(event) => {
                    const provider = event.target.value as AiProviderId;
                    const meta = getProvider(provider);
                    setEditing({
                      ...editing,
                      provider,
                      model: meta?.defaultModel || "",
                      models: [],
                      ...guessCapabilities(provider, meta?.defaultModel || ""),
                    });
                  }}
                >
                  {AI_PROVIDERS.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Base URL" hint={draftMeta?.requiresBaseUrl ? "Required for custom providers." : "Optional override."}>
                <input
                  className="input"
                  value={editing.baseUrl}
                  onChange={(event) => setEditing({ ...editing, baseUrl: event.target.value })}
                  placeholder={draftMeta?.baseUrl || "https://api.example.com/v1"}
                  spellCheck={false}
                />
              </Field>
              <Field label="API key" hint="Stored in this browser only; sent to the provider you choose.">
                <div className="row" style={{ gap: 8 }}>
                  <input
                    className="input"
                    type={showKey ? "text" : "password"}
                    value={editing.apiKey}
                    onChange={(event) => setEditing({ ...editing, apiKey: event.target.value })}
                    placeholder="sk-… or AIza…"
                    autoComplete="off"
                    spellCheck={false}
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => setShowKey((value) => !value)}
                    aria-label={showKey ? "Hide API key" : "Show API key"}
                  >
                    {showKey ? <EyeOff size={13} /> : <KeyRound size={13} />}
                  </button>
                </div>
              </Field>
              <Field label="Model ID" hint="Pick from the live catalogue after a test, or type it.">
                <div className="row" style={{ gap: 8 }}>
                  <input
                    className="input"
                    value={editing.model}
                    onChange={(event) => setEditing({ ...editing, model: event.target.value })}
                    list={`models-${editing.id}`}
                    placeholder="gpt-4o-mini"
                    spellCheck={false}
                    style={{ flex: 1 }}
                  />
                  <datalist id={`models-${editing.id}`}>
                    {editing.models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label}
                      </option>
                    ))}
                  </datalist>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void testProvider(editing)}
                    disabled={busy !== null || !editing.apiKey.trim()}
                    title="Verify the key and load this provider's models"
                  >
                    <RefreshCw size={12} />
                    <span>Fetch models</span>
                  </button>
                </div>
              </Field>
            </div>

            <div className="provider-flags">
              {(
                [
                  { key: "vision", label: "Vision (images)" },
                  { key: "audio", label: "Audio / voice" },
                  { key: "tools", label: "Tool calling" },
                ] as const
              ).map((flag) => (
                <label key={flag.key} className="provider-flag">
                  <input
                    type="checkbox"
                    checked={editing[flag.key]}
                    onChange={(event) => setEditing({ ...editing, [flag.key]: event.target.checked })}
                  />
                  <span>{flag.label}</span>
                </label>
              ))}
              <span className="tiny muted">Capabilities control what the operator will offer this model.</span>
            </div>

            {editing.models.length > 0 ? (
              <Field label="Models on this key">
                <select
                  className="select"
                  value={editing.model}
                  onChange={(event) => setEditing({ ...editing, model: event.target.value })}
                >
                  {editing.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label === model.id ? model.id : `${model.label} · ${model.id}`}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}

            <div className="row">
              <button type="button" className="btn btn-sm btn-primary" onClick={() => void saveDraft()} disabled={busy !== null}>
                <span>Save &amp; test</span>
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <span className="tiny">Saving tests the connection so a bad key is caught immediately.</span>
            </div>
          </div>
        ) : (
          <div className="row">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing(newProviderDraft())}>
              <Plus size={13} />
              <span>Add provider</span>
            </button>
            <span className="tiny">
              Keys stay in this browser and are only sent to the provider you choose. The active provider is also saved to
              your private settings record.
            </span>
          </div>
        )}
      </div>
    </Card>
  );
}
