import type { AiExecutionLogRecord, KeyAnalyticsSnapshot } from "./types";

const DAY_MS = 24 * 60 * 60_000;

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Aggregates real execution receipts for one key (or one provider when keyId
 * is null). Everything is derived from the supplied logs — no estimates.
 */
export function summarizeKeyAnalytics(input: {
  logs: AiExecutionLogRecord[];
  keyId?: string | null;
  provider?: string | null;
  now?: number;
  recentLimit?: number;
}): KeyAnalyticsSnapshot {
  const now = input.now ?? Date.now();
  const keyId = input.keyId?.trim() || null;
  const provider = input.provider?.trim() || null;

  const rows = input.logs.filter((log) => {
    if (keyId) return log.actualKeyId === keyId;
    if (provider) return log.actualProvider === provider;
    return true;
  });

  const successful = rows.filter((r) => r.status === "success");
  const latencies = successful.map((r) => r.latencyMs).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const hops = successful.map((r) => r.fallbackHops).filter((n) => Number.isFinite(n));

  const featureCounts = new Map<string, number>();
  for (const row of rows) {
    const feature = row.feature?.trim() || row.taskType;
    featureCounts.set(feature, (featureCounts.get(feature) ?? 0) + 1);
  }

  const avg = (values: number[]): number | null =>
    values.length === 0 ? null : Math.round(values.reduce((sum, n) => sum + n, 0) / values.length);

  const succeeded = successful.length;
  const failed = rows.length - succeeded;

  return {
    keyId,
    provider,
    totalCalls: rows.length,
    calls24h: rows.filter((r) => now - Date.parse(r.createdAt) <= DAY_MS).length,
    calls7d: rows.filter((r) => now - Date.parse(r.createdAt) <= 7 * DAY_MS).length,
    successCount: succeeded,
    failedCount: failed,
    successRate: rows.length === 0 ? null : Math.round((succeeded / rows.length) * 1000) / 10,
    avgLatencyMs: avg(latencies),
    p95LatencyMs: percentile(latencies, 95),
    avgFallbackHops: hops.length === 0 ? null : Math.round((hops.reduce((s, n) => s + n, 0) / hops.length) * 10) / 10,
    topFeatures: [...featureCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([feature, count]) => ({ feature, count })),
    recentLogs: rows.slice(0, Math.min(40, Math.max(5, input.recentLimit ?? 20))),
  };
}
