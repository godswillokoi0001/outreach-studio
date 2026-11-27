"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { BrandLoader } from "@/components/BrandLoader";
import { Badge, Banner, Card } from "@/components/ui";
import type { AdminRole, PlatformAlert } from "@/lib/platform/types";
import { adminFetch } from "./admin-client";

interface HealthOverviewPayload {
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

export function AdminHealthTab({ role }: { role: AdminRole }) {
  const [data, setData] = useState<HealthOverviewPayload["health"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadHealth = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminFetch<HealthOverviewPayload>("/api/admin/overview?range=24h");
      setData(res.health);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load system health.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => void loadHealth(), 0);
    return () => window.clearTimeout(t);
  }, [loadHealth, role]);

  if (loading && !data) return <BrandLoader />;

  return (
    <div className="stack" style={{ gap: 16 }}>
      {error && <Banner tone="bad">{error}</Banner>}

      <div className="grid grid-3" style={{ gap: 12 }}>
        <div className="stat">
          <div className="stat-label">API Error Rate (24h)</div>
          <div className="stat-value">{data?.errorRatePct ?? 0}%</div>
          <div className="stat-note">Failed AI requests relative to total traffic</div>
        </div>
        <div className="stat">
          <div className="stat-label">Avg AI Latency</div>
          <div className="stat-value">{data?.avgLatencyMs ?? 0}ms</div>
          <div className="stat-note">Mean model round-trip time</div>
        </div>
        <div className="stat">
          <div className="stat-label">Recent Failed Requests</div>
          <div className="stat-value">{data?.failedJobsCount ?? 0}</div>
          <div className="stat-note">Provider / timeout / fallback events</div>
        </div>
      </div>

      <Card
        title="Provider Health Status"
        sub="Live connectivity and recent failure rate across configured platform AI providers."
        actions={
          <button type="button" className="btn btn-sm" onClick={() => void loadHealth()} disabled={loading}>
            <RefreshCw size={12} /> Refresh
          </button>
        }
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Key Configured</th>
                <th>Status</th>
                <th>Requests (24h)</th>
                <th>Failures</th>
                <th>Avg Latency</th>
              </tr>
            </thead>
            <tbody>
              {(data?.providerStatus ?? []).map((p) => (
                <tr key={p.provider}>
                  <td className="strong">{p.label}</td>
                  <td>
                    <Badge tone={p.hasKey ? "ok" : undefined}>{p.hasKey ? "Yes" : "No"}</Badge>
                  </td>
                  <td>
                    <Badge
                      tone={
                        p.status === "healthy" ? "ok" : p.status === "degraded" ? "bad" : undefined
                      }
                    >
                      {p.status}
                    </Badge>
                  </td>
                  <td className="num">{p.requests}</td>
                  <td className="num">{p.errors}</td>
                  <td className="num">{p.avgLatencyMs}ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Recent Failures & Alerts" sub="Threshold spikes, lockouts, and provider degradations">
        {!data?.alerts || data.alerts.length === 0 ? (
          <div className="row tiny muted" style={{ gap: 8 }}>
            <CheckCircle2 size={15} style={{ color: "var(--ok)" }} />
            <span>No active health alerts. All monitored services are operating normally.</span>
          </div>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            {data.alerts.map((a) => (
              <Banner key={a.id} tone={a.severity === "high" ? "bad" : a.severity === "medium" ? "warn" : "info"}>
                <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                  <AlertTriangle size={15} style={{ marginTop: 2, flexShrink: 0 }} />
                  <div>
                    <strong className="tiny">{a.title}</strong>
                    <div className="tiny muted">{a.detail}</div>
                  </div>
                </div>
              </Banner>
            ))}
          </div>
        )}
      </Card>

      <div className="tiny muted row" style={{ gap: 6 }}>
        <Activity size={13} />
        <span>Automated platform diagnostics can be run anytime under Advanced → System Diagnostics.</span>
      </div>
    </div>
  );
}
