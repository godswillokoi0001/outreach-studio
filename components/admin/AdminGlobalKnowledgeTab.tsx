"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpenCheck, Brain, History, RefreshCw, RotateCcw, Save } from "lucide-react";
import { BrandLoader } from "@/components/BrandLoader";
import { Badge, Banner, Card } from "@/components/ui";
import { adminFetch } from "./admin-client";
import type { GlobalKnowledgeModule, GlobalKnowledgeModuleKey } from "@/lib/global-knowledge/types";
import type { AdminRole } from "@/lib/platform/types";

interface GlobalKnowledgeResponse {
  modules: GlobalKnowledgeModule[];
  source: "database" | "fallback_seed";
  cache: {
    cached: boolean;
    loadedAt: string | null;
    source: string | null;
    ttlMs: number;
    hits: number;
    misses: number;
    dbReads: number;
    fallbackReads: number;
  };
}

const KEY_LABELS: Record<GlobalKnowledgeModuleKey, string> = {
  module_1_prospecting_research_qualification: "Module 1 — Prospecting, Research & Qualification",
  module_2_copywriting_psychology_deliverability: "Module 2 — Copywriting, Psychology & Deliverability",
  module_3_routing_templates_cadence: "Module 3 — Routing, Templates & Multi-Channel Cadence",
  module_4_replies_objections_closing_compliance: "Module 4 — Replies, Objections, Closing & Compliance",
};

export function AdminGlobalKnowledgeTab({
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
  const [data, setData] = useState<GlobalKnowledgeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<GlobalKnowledgeModuleKey>(
    "module_1_prospecting_research_qualification",
  );
  const [editedTitle, setEditedTitle] = useState<string | null>(null);
  const [editedContent, setEditedContent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const canEdit = role === "super_admin" || role === "admin";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminFetch<GlobalKnowledgeResponse>("/api/admin/global-knowledge", {
        sessionToken,
      });
      setData(res);
      setEditedTitle(null);
      setEditedContent(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load global brain.");
    } finally {
      setLoading(false);
    }
  }, [sessionToken]);

  useEffect(() => {
    const t = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(t);
  }, [load]);

  const versionsForSelected = useMemo(() => {
    return (data?.modules ?? [])
      .filter((m) => m.module_key === selectedKey)
      .sort((a, b) => b.version - a.version);
  }, [data, selectedKey]);

  const activeModule = useMemo(
    () => versionsForSelected.find((m) => m.is_active) ?? versionsForSelected[0] ?? null,
    [versionsForSelected],
  );

  const draftTitle = editedTitle ?? activeModule?.title ?? "";
  const draftContent = editedContent ?? activeModule?.content ?? "";

  const publishVersion = async (freshReauth?: string) => {
    const tok = freshReauth ?? reauthToken;
    if (!tok) {
      onNeedReauth("Publish new Global Brain module version", (t) => publishVersion(t));
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await adminFetch<{ module: GlobalKnowledgeModule }>(`/api/admin/global-knowledge/${selectedKey}/versions`, {
        method: "POST",
        sessionToken,
        reauthToken: tok,
        body: { title: draftTitle, content: draftContent },
      });
      setNotice(`Published v${res.module.version} for ${selectedKey} and invalidated server RAM cache.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to publish module version.");
    } finally {
      setSaving(false);
    }
  };

  const rollbackVersion = async (version: number, freshReauth?: string) => {
    const tok = freshReauth ?? reauthToken;
    if (!tok) {
      onNeedReauth(`Rollback ${selectedKey} to v${version}`, (t) => rollbackVersion(version, t));
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await adminFetch<{ module: GlobalKnowledgeModule }>(
        `/api/admin/global-knowledge/${selectedKey}/rollback/${version}`,
        {
          method: "POST",
          sessionToken,
          reauthToken: tok,
        },
      );
      setNotice(`Rolled back to v${res.module.version} and invalidated server RAM cache.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rollback failed.");
    } finally {
      setSaving(false);
    }
  };

  if (loading && !data) {
    return (
      <Card title="Global AI Knowledge Brain" sub="Loading shared intelligence modules…">
        <BrandLoader />
      </Card>
    );
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      {error && <Banner tone="bad">{error}</Banner>}
      {notice && <Banner tone="ok">{notice}</Banner>}

      <Card
        title="Global Brain Architecture & Cache Telemetry"
        sub="Shared once globally across all workspaces (server-only IP; 20-minute RAM cache with instant invalidation)"
        actions={
          <button type="button" className="btn btn-sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={13} /> Refresh
          </button>
        }
      >
        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          <Badge tone={data?.source === "database" ? "ok" : "warn"}>
            Storage: {data?.source === "database" ? "PostgreSQL Active" : "Local Seed Fallback"}
          </Badge>
          <Badge tone={data?.cache.cached ? "info" : "neutral"}>
            RAM Cache: {data?.cache.cached ? "Warm" : "Cold"}
          </Badge>
          <Badge tone="neutral">Cache Hits: {data?.cache.hits ?? 0}</Badge>
          <Badge tone="neutral">DB Reads: {data?.cache.dbReads ?? 0}</Badge>
          <Badge tone="neutral">TTL: {Math.round((data?.cache.ttlMs ?? 1_200_000) / 60_000)}m</Badge>
        </div>
      </Card>

      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {(Object.keys(KEY_LABELS) as GlobalKnowledgeModuleKey[]).map((key) => {
          const mod = (data?.modules ?? []).find((m) => m.module_key === key && m.is_active);
          return (
            <button
              key={key}
              type="button"
              className={`btn btn-sm ${selectedKey === key ? "btn-primary" : ""}`}
              onClick={() => {
                setSelectedKey(key);
                setEditedTitle(null);
                setEditedContent(null);
              }}
            >
              <Brain size={13} />
              <span>{key.replace(/^module_(\d+)_.*/, "Module $1")}</span>
              {mod && <Badge tone="info">v{mod.version}</Badge>}
            </button>
          );
        })}
      </div>

      <Card
        title={KEY_LABELS[selectedKey]}
        sub={
          activeModule
            ? `Active: v${activeModule.version} · Updated ${new Date(activeModule.updated_at).toLocaleString()}${activeModule.updated_by ? ` · By ${activeModule.updated_by}` : ""}`
            : "Unversioned seed fallback"
        }
      >
        <div className="stack" style={{ gap: 12 }}>
          <div>
            <label className="field-label" htmlFor="gb-title">Module Title</label>
            <input
              id="gb-title"
              className="input"
              value={draftTitle}
              disabled={!canEdit}
              onChange={(e) => setEditedTitle(e.target.value)}
            />
          </div>

          <div>
            <label className="field-label" htmlFor="gb-content">
              Full Markdown Intelligence ({draftContent.length.toLocaleString()} chars)
            </label>
            <textarea
              id="gb-content"
              className="textarea"
              rows={16}
              disabled={!canEdit}
              style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12.5 }}
              value={draftContent}
              onChange={(e) => setEditedContent(e.target.value)}
            />
          </div>

          {canEdit && (
            <div className="row-end" style={{ gap: 8 }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={saving}
                onClick={() => void publishVersion()}
              >
                <Save size={14} /> {saving ? "Publishing…" : "Publish New Version & Invalidate Cache"}
              </button>
            </div>
          )}
        </div>
      </Card>

      <Card
        title="Immutable Version History & Instant Rollback"
        sub="Publishing always preserves previous versions for instant one-click rollback"
      >
        {versionsForSelected.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>No persisted database versions yet.</div>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            {versionsForSelected.map((ver) => (
              <div
                key={`${ver.module_key}-${ver.version}`}
                className="row-between"
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: ver.is_active ? "var(--surface-2)" : "transparent",
                }}
              >
                <div className="row" style={{ gap: 10 }}>
                  <History size={14} />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                      v{ver.version} — {ver.title}
                    </div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {new Date(ver.updated_at).toLocaleString()} · {ver.content.length.toLocaleString()} chars
                      {ver.updated_by ? ` · ${ver.updated_by}` : ""}
                    </div>
                  </div>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  {ver.is_active ? (
                    <Badge tone="ok">
                      <BookOpenCheck size={11} style={{ marginRight: 4 }} /> Active
                    </Badge>
                  ) : (
                    canEdit && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={saving}
                        onClick={() => void rollbackVersion(ver.version)}
                      >
                        <RotateCcw size={12} /> Rollback to v{ver.version}
                      </button>
                    )
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
