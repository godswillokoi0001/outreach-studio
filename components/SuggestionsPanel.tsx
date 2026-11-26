"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowRight,
  ExternalLink,
  Loader2,
  Play,
  RefreshCw,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { Badge, Banner, Card } from "./ui";
import { GrowthExecuteModal } from "./GrowthExecuteModal";
import { CATEGORY_LABELS, type GrowthRecommendation } from "@/lib/growth-advisor";
import type { PerformanceInsight } from "@/lib/intelligence";
import { useGrowthAdvisor } from "@/lib/useGrowthAdvisor";

export function SuggestionsPanel({
  uid,
  insight,
}: {
  uid: string;
  insight: PerformanceInsight | null;
}) {
  const {
    profile,
    settings,
    knowledgeDigest,
    existingEmails,
    report,
    completeness,
    loading,
    researching,
    error,
    runResearch,
  } = useGrowthAdvisor(uid, { analyticsInsight: insight, autoResearch: true });

  const [executeRec, setExecuteRec] = useState<GrowthRecommendation | null>(null);
  const [executeOpen, setExecuteOpen] = useState(false);

  const openExecute = (rec: GrowthRecommendation | null) => {
    setExecuteRec(rec);
    setExecuteOpen(true);
  };

  const topRecs = report?.recommendations.slice(0, 3) ?? [];

  return (
    <>
      <Card
        title={insight ? "Suggestions based on your results" : "Growth Advisor suggestions"}
        sub={
          insight
            ? "Tailored from your measured campaign results and live market research"
            : "Predicted highest-impact plays based on your business profile before you run analysis"
        }
        actions={
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void runResearch({ force: true })}
              disabled={researching || !completeness.complete}
              title="Refresh live web research"
            >
              <RefreshCw size={12} className={researching ? "spin" : ""} />
              {researching ? "Researching…" : "Refresh"}
            </button>
            <Link href="/growth-advisor" className="btn btn-sm">
              Full Growth Advisor
              <ArrowRight size={12} />
            </Link>
          </div>
        }
      >
        <div className="stack" style={{ gap: 12 }}>
          {!completeness.complete && !loading && (
            <Banner tone="warn">
              <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <span className="tiny">
                  Complete your business profile ({completeness.missingFields.slice(0, 3).join(", ")}) to unlock live
                  personalised recommendations.
                </span>
                <Link href="/growth-advisor" className="btn btn-sm btn-primary">
                  Complete profile
                </Link>
              </div>
            </Banner>
          )}

          {error && (
            <Banner tone="bad">
              <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <span className="tiny">{error}</span>
                <button type="button" className="btn btn-sm" onClick={() => void runResearch({ force: true })}>
                  Retry
                </button>
              </div>
            </Banner>
          )}

          {researching && topRecs.length === 0 && (
            <div className="row tiny muted" style={{ gap: 8, padding: "12px 0" }}>
              <Loader2 size={14} className="spin" />
              <span>Searching the web for winning plays tailored to your business…</span>
            </div>
          )}

          {insight && report?.postAnalysisInsights && (
            <div
              className="grid grid-3"
              style={{
                gap: 10,
                padding: 12,
                borderRadius: 10,
                border: "1px solid var(--line)",
                background: "var(--surface-2)",
              }}
            >
              <div>
                <div className="strong tiny" style={{ color: "var(--teal-deep)", marginBottom: 4 }}>
                  What worked
                </div>
                <ul className="tiny" style={{ margin: 0, paddingLeft: 16 }}>
                  {report.postAnalysisInsights.whatWorked.slice(0, 3).map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="strong tiny" style={{ color: "var(--warn, #b45309)", marginBottom: 4 }}>
                  What didn&apos;t work
                </div>
                <ul className="tiny" style={{ margin: 0, paddingLeft: 16 }}>
                  {report.postAnalysisInsights.whatDidnt.slice(0, 3).map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="strong tiny" style={{ marginBottom: 4 }}>
                  What to change next
                </div>
                <ul className="tiny" style={{ margin: 0, paddingLeft: 16 }}>
                  {report.postAnalysisInsights.nextMoves.slice(0, 3).map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {topRecs.length > 0 && (
            <div className="grid grid-3" style={{ gap: 12 }}>
              {topRecs.map((rec) => (
                <div
                  key={rec.id}
                  style={{
                    border: "1px solid var(--line)",
                    borderRadius: 10,
                    padding: 14,
                    background: "var(--surface)",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                    gap: 10,
                  }}
                >
                  <div className="stack" style={{ gap: 6 }}>
                    <div className="row" style={{ justifyContent: "space-between", gap: 6, flexWrap: "wrap" }}>
                      <Badge>{CATEGORY_LABELS[rec.category]}</Badge>
                      <Badge tone={rec.impact === "high" ? "ok" : rec.impact === "medium" ? "warn" : undefined}>
                        {rec.impact.toUpperCase()} · {rec.confidence}%
                      </Badge>
                    </div>
                    <Link
                      href={`/growth-advisor?highlight=${encodeURIComponent(rec.id)}`}
                      className="strong"
                      style={{ fontSize: 13.5, textDecoration: "none", color: "var(--ink)" }}
                    >
                      {rec.title}
                    </Link>
                    <p className="tiny" style={{ margin: 0, lineHeight: 1.45 }}>
                      {rec.summary}
                    </p>
                    <div className="tiny muted" style={{ lineHeight: 1.4 }}>
                      <strong>Why:</strong> {rec.reason}
                    </div>
                  </div>

                  <div
                    className="row"
                    style={{
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 8,
                      paddingTop: 8,
                      borderTop: "1px solid var(--line-soft)",
                    }}
                  >
                    {rec.sourceUrl ? (
                      <a
                        href={rec.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="tiny row"
                        style={{ gap: 4, color: "var(--teal-deep)" }}
                      >
                        Evidence <ExternalLink size={11} />
                      </a>
                    ) : (
                      <Link href="/growth-advisor" className="tiny muted">
                        View details
                      </Link>
                    )}
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => openExecute(rec)}
                    >
                      <Play size={11} />
                      Execute
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {report && (
            <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <Link
                href="/growth-advisor"
                className="tiny row"
                style={{ gap: 5, color: "var(--teal-deep)", fontWeight: 500 }}
              >
                <TrendingUp size={13} />
                Explore all {report.recommendations.length} recommendations on Growth Advisor →
              </Link>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => openExecute(null)}
              >
                <Sparkles size={12} />
                Execute overall strategy
              </button>
            </div>
          )}
        </div>
      </Card>

      <GrowthExecuteModal
        open={executeOpen}
        onClose={() => setExecuteOpen(false)}
        recommendation={executeRec}
        overallStrategy={report?.overallStrategy}
        profile={profile}
        knowledgeDigest={knowledgeDigest}
        settings={settings}
        existingEmails={existingEmails}
      />
    </>
  );
}
