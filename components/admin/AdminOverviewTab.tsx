"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, RefreshCw, Trash2 } from "lucide-react";
import type { AdminRole, PlatformAlert } from "@/lib/platform/types";
import { Badge, Banner, Card, Empty, Stat } from "../ui";
import { BrandLoader } from "../BrandLoader";
import { useToast } from "../Feedback";
import { AdminClientError, adminFetch } from "./admin-client";
import {
  AdminClearConfirmModal,
  AdminPaginationBar,
  type ClearRangeOption,
} from "./AdminPaginationBar";

export interface OverviewData {
  kpis: {
    totalUsers: number;
    newSignups: number;
    activeUsers: number;
    campaignsCreated: number;
    analysesRun: number;
    prospectsFound: number;
    totalAiRequests: number;
    totalEstimatedCostUsd: number | null;
  };
  chartSeries: { day: string; requests: number; signups: number; prospects: number }[];
  liveFeed: {
    id: string;
    ownerId: string;
    userEmail: string;
    action: string;
    entity: string;
    entityId: string;
    createdAt: string;
  }[];
  liveFeedTotal?: number;
  liveFeedPage?: number;
  liveFeedPageSize?: number;
  distinctActions?: string[];
  health: {
    errorRatePct: number;
    avgLatencyMs: number;
    failedJobsCount: number;
    providerStatus: {
      provider: string;
      label: string;
      enabled: boolean;
      hasKey: boolean;
      requests: number;
      errors: number;
      avgLatencyMs: number;
      status: "healthy" | "degraded" | "unconfigured";
    }[];
    alerts: PlatformAlert[];
  };
}

export function AdminOverviewTab({
  role,
  sessionToken,
  reauthToken,
  onNeedReauth,
}: {
  role: AdminRole;
  sessionToken: string;
  reauthToken?: string | null;
  onNeedReauth?: (label: string, retryFn: (freshToken: string) => Promise<void>) => void;
}) {
  const toast = useToast();
  const canClearFeed = role === "admin" || role === "super_admin";

  const [range, setRange] = useState<"24h" | "7d" | "30d" | "all">("30d");
  const [userFilter, setUserFilter] = useState("");
  const [actionFilter, setActionFilter] = useState("all");
  const [feedPage, setFeedPage] = useState(1);
  const [feedPageSize, setFeedPageSize] = useState(25);
  const [feedSort, setFeedSort] = useState<"newest" | "oldest">("newest");
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [clearModalOpen, setClearModalOpen] = useState(false);
  const [clearRange, setClearRange] = useState<ClearRangeOption>("30d");
  const [clearPreviewCount, setClearPreviewCount] = useState<number | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [clearingFeed, setClearingFeed] = useState(false);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        range,
        user: userFilter,
        action: actionFilter,
        feedPage: String(feedPage),
        feedPageSize: String(feedPageSize),
        feedSort,
      });
      const res = await adminFetch<OverviewData>(`/api/admin/overview?${qs.toString()}`, {
        sessionToken,
      });
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load overview.");
    } finally {
      setLoading(false);
    }
  }, [range, userFilter, actionFilter, feedPage, feedPageSize, feedSort, sessionToken]);

  const previewClearFeed = useCallback(
    async (nextRange: ClearRangeOption) => {
      if (!canClearFeed) return;
      setLoadingPreview(true);
      try {
        const res = await adminFetch<{ count: number }>("/api/admin/overview", {
          method: "POST",
          sessionToken,
          body: { action: "preview_clear_feed", range: nextRange },
        });
        setClearPreviewCount(res.count ?? 0);
      } catch (err) {
        toast.error("Could not preview count", err instanceof Error ? err.message : "Error");
      } finally {
        setLoadingPreview(false);
      }
    },
    [canClearFeed, sessionToken, toast],
  );

  const executeClearFeed = async (freshToken?: string) => {
    setClearingFeed(true);
    try {
      const res = await adminFetch<{ removedCount: number }>("/api/admin/overview", {
        method: "POST",
        sessionToken,
        reauthToken: freshToken ?? reauthToken ?? null,
        body: { action: "clear_feed", range: clearRange },
      });
      setClearModalOpen(false);
      toast.success("Activity feed cleared", `${res.removedCount} log entries removed.`);
      setFeedPage(1);
      await loadOverview();
    } catch (err) {
      if (err instanceof AdminClientError && err.code === "ADMIN_REAUTH_REQUIRED" && onNeedReauth) {
        onNeedReauth(`Clear ${clearPreviewCount ?? 0} Activity Feed items`, (t) =>
          executeClearFeed(t),
        );
        return;
      }
      toast.error("Could not clear activity feed", err instanceof Error ? err.message : "Error");
    } finally {
      setClearingFeed(false);
    }
  };

  useEffect(() => {
    const t = window.setTimeout(() => void loadOverview(), 0);
    return () => window.clearTimeout(t);
  }, [loadOverview]);

  if (loading && !data) return <BrandLoader />;

  const maxReq = Math.max(1, ...(data?.chartSeries.map((d) => d.requests) ?? [1]));
  const distinctActions =
    data?.distinctActions ?? Array.from(new Set(data?.liveFeed.map((f) => f.action) ?? []));
  const feedTotal = data?.liveFeedTotal ?? data?.liveFeed.length ?? 0;

  return (
    <div className="stack" style={{ gap: 16 }}>
      {error && (
        <Banner tone="bad">
          <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
            <span>{error}</span>
            <button type="button" className="btn btn-sm" onClick={() => void loadOverview()}>
              Retry
            </button>
          </div>
        </Banner>
      )}

      {/* Date Range Controls */}
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          {(["24h", "7d", "30d", "all"] as const).map((r) => (
            <button
              key={r}
              type="button"
              className={`btn btn-sm ${range === r ? "btn-primary" : ""}`}
              onClick={() => setRange(r)}
            >
              {r === "24h" ? "Last 24 hours" : r === "7d" ? "Last 7 days" : r === "30d" ? "Last 30 days" : "All time"}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => void loadOverview()}>
          <RefreshCw size={12} /> Refresh telemetry
        </button>
      </div>

      {data && (
        <>
          {/* Alerts */}
          {data.health.alerts.length > 0 && (
            <Card title="Unusual Activity & System Alerts" sub="Automated monitoring across usage spikes and failures">
              <div className="stack" style={{ gap: 8 }}>
                {data.health.alerts.map((al) => (
                  <Banner key={al.id} tone={al.severity === "high" ? "bad" : "warn"}>
                    <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                      <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 2 }} />
                      <div>
                        <div className="strong" style={{ fontSize: 13 }}>{al.title}</div>
                        <div className="tiny">{al.detail}</div>
                      </div>
                    </div>
                  </Banner>
                ))}
              </div>
            </Card>
          )}

          {/* KPIs */}
          <div className="grid grid-auto" style={{ gap: 12 }}>
            <Stat label="Total Users" value={data.kpis.totalUsers} note={`${data.kpis.newSignups} new sign-ups`} />
            <Stat label="Active Users" value={data.kpis.activeUsers} note="In selected window" />
            <Stat label="Campaigns Created" value={data.kpis.campaignsCreated} />
            <Stat label="Prospects Found" value={data.kpis.prospectsFound} />
            <Stat label="Analyses Run" value={data.kpis.analysesRun} />
            <Stat label="AI Requests" value={data.kpis.totalAiRequests} accent />
            {role !== "support" && data.kpis.totalEstimatedCostUsd !== null && (
              <Stat label="Est. AI Spend" value={`$${data.kpis.totalEstimatedCostUsd.toFixed(2)}`} />
            )}
          </div>

          <div className="grid grid-2" style={{ gap: 16 }}>
            {/* 14-day AI Activity Chart */}
            <Card title="Daily AI Requests (Last 14 Days)" sub="Platform + personal usage combined">
              <div className="wk-chart" style={{ height: 110 }}>
                {data.chartSeries.map((day) => (
                  <div
                    key={day.day}
                    className="wk-chart-col"
                    title={`${day.day}: ${day.requests} AI requests, ${day.signups} signups, ${day.prospects} prospects`}
                  >
                    <div
                      className="wk-chart-bar"
                      style={{ height: `${Math.max(4, (day.requests / maxReq) * 82)}px` }}
                    />
                    <span className="wk-chart-day">{day.day.slice(8)}</span>
                  </div>
                ))}
              </div>
            </Card>

            {/* System Health */}
            <Card title="System Health & Provider Status" sub="Measured response latency and API error rates">
              <div className="grid grid-3" style={{ gap: 10, marginBottom: 12 }}>
                <div style={{ padding: 10, borderRadius: 8, background: "var(--surface-2)", border: "1px solid var(--line-soft)" }}>
                  <div className="tiny muted">API Error Rate</div>
                  <div className="strong" style={{ fontSize: 18 }}>{data.health.errorRatePct}%</div>
                </div>
                <div style={{ padding: 10, borderRadius: 8, background: "var(--surface-2)", border: "1px solid var(--line-soft)" }}>
                  <div className="tiny muted">Avg Latency</div>
                  <div className="strong" style={{ fontSize: 18 }}>{data.health.avgLatencyMs}ms</div>
                </div>
                <div style={{ padding: 10, borderRadius: 8, background: "var(--surface-2)", border: "1px solid var(--line-soft)" }}>
                  <div className="tiny muted">Failed Jobs</div>
                  <div className="strong" style={{ fontSize: 18 }}>{data.health.failedJobsCount}</div>
                </div>
              </div>

              <div className="stack" style={{ gap: 6 }}>
                {data.health.providerStatus
                  .filter((p) => p.hasKey || p.requests > 0)
                  .map((p) => (
                    <div
                      key={p.provider}
                      className="row"
                      style={{
                        justifyContent: "space-between",
                        padding: "6px 10px",
                        borderRadius: 8,
                        border: "1px solid var(--line-soft)",
                        fontSize: 12.5,
                      }}
                    >
                      <div className="row" style={{ gap: 8 }}>
                        <CheckCircle2
                          size={13}
                          style={{ color: p.status === "healthy" ? "var(--ok)" : "var(--warn)" }}
                        />
                        <span className="strong">{p.label}</span>
                      </div>
                      <div className="row" style={{ gap: 8 }}>
                        <span className="tiny muted">
                          {p.requests} req · {p.errors} err · {p.avgLatencyMs}ms
                        </span>
                        <Badge tone={p.status === "healthy" ? "ok" : "warn"}>{p.status}</Badge>
                      </div>
                    </div>
                  ))}
              </div>
            </Card>
          </div>

          {/* Live Platform Activity Feed */}
          <Card
            title="Live Platform Activity Feed"
            sub="Filter, sort, paginate, or clear user activity feed display logs"
            actions={
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <input
                  className="input"
                  style={{ width: 170 }}
                  placeholder="Filter by email…"
                  value={userFilter}
                  onChange={(e) => {
                    setUserFilter(e.target.value);
                    setFeedPage(1);
                  }}
                />
                <select
                  className="input"
                  style={{ width: 155 }}
                  value={actionFilter}
                  onChange={(e) => {
                    setActionFilter(e.target.value);
                    setFeedPage(1);
                  }}
                >
                  <option value="all">All actions</option>
                  {distinctActions.map((act) => (
                    <option key={act} value={act}>
                      {act.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
                <select
                  className="input"
                  aria-label="Sort activity feed"
                  style={{ width: "auto" }}
                  value={feedSort}
                  onChange={(e) => {
                    setFeedSort(e.target.value === "oldest" ? "oldest" : "newest");
                    setFeedPage(1);
                  }}
                >
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                </select>
                {canClearFeed && (
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => {
                      setClearModalOpen(true);
                      void previewClearFeed(clearRange);
                    }}
                  >
                    <Trash2 size={12} />
                    <span>Clear Feed</span>
                  </button>
                )}
              </div>
            }
          >
            {data.liveFeed.length === 0 ? (
              <Empty title="No matching activity recorded" />
            ) : (
              <>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>User</th>
                        <th>Action</th>
                        <th>Target</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.liveFeed.map((item) => (
                        <tr key={item.id}>
                          <td className="tiny nowrap">
                            {new Date(item.createdAt).toLocaleString()}
                          </td>
                          <td className="tiny strong">{item.userEmail}</td>
                          <td>
                            <Badge>
                              <Activity size={10} style={{ marginRight: 4 }} />
                              {item.action.replace(/_/g, " ")}
                            </Badge>
                          </td>
                          <td className="tiny muted">
                            {item.entity} · {item.entityId}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <AdminPaginationBar
                  page={feedPage}
                  pageSize={feedPageSize}
                  totalCount={feedTotal}
                  onPageChange={setFeedPage}
                  onPageSizeChange={(next) => {
                    setFeedPageSize(next);
                    setFeedPage(1);
                  }}
                />
              </>
            )}
          </Card>

          <AdminClearConfirmModal
            open={clearModalOpen}
            title="Clear Platform Activity Feed"
            description="Clears historical user activity display rows in the feed log only. User leads, campaigns, Knowledge Base items, analyses, and Admin Audit Logs are untouched."
            range={clearRange}
            previewCount={clearPreviewCount}
            loadingPreview={loadingPreview}
            clearing={clearingFeed}
            onRangeChange={(nextRange) => {
              setClearRange(nextRange);
              void previewClearFeed(nextRange);
            }}
            onConfirm={() => void executeClearFeed()}
            onClose={() => setClearModalOpen(false)}
          />
        </>
      )}
    </div>
  );
}
