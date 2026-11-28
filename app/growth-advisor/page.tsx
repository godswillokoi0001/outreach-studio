"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Globe,
  Play,
  RefreshCw,
  RotateCcw,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { formatApproxEta } from "@/components/BackgroundJobsBar";
import { BrandLoader } from "@/components/BrandLoader";
import { GrowthProfileForm } from "@/components/GrowthProfileForm";
import { Badge, Banner, Card, Empty } from "@/components/ui";
import { GrowthExecuteModal } from "@/components/GrowthExecuteModal";
import { NarratorControl } from "@/components/NarratorControl";
import { useToast } from "@/components/Feedback";
import {
  CATEGORY_LABELS,
  type GrowthRecommendation,
  type RecommendationCategory,
} from "@/lib/growth-advisor";
import { useGrowthAdvisor } from "@/lib/useGrowthAdvisor";
import { usePersistedPageState } from "@/lib/usePersistedPageState";

function GrowthAdvisorContent() {
  const { user } = useAuth();
  const toast = useToast();
  const searchParams = useSearchParams();
  const highlightId = searchParams.get("highlight");

  const {
    profile,
    setProfile,
    updateProfile,
    settings,
    knowledgeDigest,
    existingEmails,
    report,
    researchJob,
    syncSourceNote,
    completeness,
    loading,
    researching,
    savingProfile,
    error,
    runResearch,
  } = useGrowthAdvisor(user.uid, { autoResearch: true });

  const [categoryFilter, setCategoryFilter] = usePersistedPageState<"all" | RecommendationCategory>(
    "growth:category",
    "all",
  );
  const [profileExpandedOverride, setProfileExpanded] = useState<boolean | null>(null);
  const [executeRec, setExecuteRec] = useState<GrowthRecommendation | null>(null);
  const [executeOpen, setExecuteOpen] = useState(false);

  const profileExpanded = profileExpandedOverride ?? (!loading && !completeness.complete);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await updateProfile(profile, true);
      toast.success("Business profile saved", "Growth Advisor started a background internet research run.");
      setProfileExpanded(false);
    } catch {
      // error already exposed via hook
    }
  };

  const openExecute = (rec: GrowthRecommendation | null) => {
    setExecuteRec(rec);
    setExecuteOpen(true);
  };

  const filteredRecs =
    report?.recommendations.filter((r) => categoryFilter === "all" || r.category === categoryFilter) ?? [];

  if (loading) {
    return (
      <main className="page">
        <BrandLoader fullScreen />
      </main>
    );
  }

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">Personalized Market Intelligence</div>
          <h1 className="page-title">Growth Advisor</h1>
          <p className="page-sub">
            Live internet research tailored to your offer, price point, location, and campaign metrics — ready to turn
            into a high-intent campaign in one click.
          </p>
        </div>

        <div className="row-end" style={{ gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn"
            onClick={() => void runResearch({ force: true })}
            disabled={researching || !completeness.complete}
          >
            <RefreshCw size={13} className={researching ? "spin" : ""} />
            {researching ? "Researching web…" : "Refresh research"}
          </button>
          {report && (
            <button type="button" className="btn btn-primary" onClick={() => openExecute(null)}>
              <Play size={13} />
              Execute overall plan
            </button>
          )}
        </div>
      </div>

      <div className="stack" style={{ gap: 16 }}>
        {/* Profile completeness prompt / inline editor */}
        <Card
          title="Your Business Profile"
          sub={
            completeness.complete
              ? `${profile.industry || "Business profile"} · ${profile.priceRange || "Offer configured"} · ${profile.location || "Market set"}`
              : `Profile ${completeness.score}% complete — fill in missing details below to unlock personalised research`
          }
          actions={
            <div className="row" style={{ gap: 8 }}>
              <Badge tone={completeness.complete ? "ok" : "warn"}>
                {completeness.complete ? "Ready" : `Missing: ${completeness.missingFields.length}`}
              </Badge>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setProfileExpanded((v) => !v)}
              >
                {profileExpanded ? (
                  <>
                    Hide <ChevronUp size={13} />
                  </>
                ) : (
                  <>
                    Edit profile <ChevronDown size={13} />
                  </>
                )}
              </button>
            </div>
          }
        >
          {!completeness.complete && !profileExpanded && (
            <Banner tone="warn">
              <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <span>
                  Please complete: <strong>{completeness.missingFields.join(", ")}</strong> so Growth Advisor can research
                  real opportunities for your business.
                </span>
                <button type="button" className="btn btn-sm btn-primary" onClick={() => setProfileExpanded(true)}>
                  Complete profile now
                </button>
              </div>
            </Banner>
          )}

          {profileExpanded && (
            <GrowthProfileForm
              profile={profile}
              onChange={setProfile}
              onSave={handleSaveProfile}
              onCancel={() => setProfileExpanded(false)}
              saving={savingProfile}
              completenessScore={completeness.score}
              missingFields={completeness.missingFields}
              syncSourceNote={syncSourceNote}
            />
          )}
        </Card>

        {/* Live Background Research Progress & Errors */}
        {researching && (
          <Card
            title="Live Market Research in Progress"
            sub={
              researchJob
                ? `${researchJob.progressPct}% complete · ${formatApproxEta(researchJob.estimatedSecondsRemaining)}`
                : "Starting background research…"
            }
          >
            <div className="stack" style={{ gap: 12 }}>
              <div className="row" style={{ gap: 12, alignItems: "center" }}>
                <BrandLoader size={40} />
                <div style={{ flex: 1 }}>
                  <div className="strong tiny">
                    {researchJob?.currentStep || "Searching for businesses like yours"}
                  </div>
                  <div className="tiny muted">
                    You can continue working on other pages — this runs safely in the background and saves to your account.
                  </div>
                </div>
              </div>

              <div
                role="progressbar"
                aria-valuenow={researchJob?.progressPct ?? 12}
                aria-valuemin={0}
                aria-valuemax={100}
                style={{
                  height: 7,
                  borderRadius: 999,
                  background: "var(--surface-2)",
                  border: "1px solid var(--line-soft)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${researchJob?.progressPct ?? 12}%`,
                    background: "var(--teal-deep, #0f766e)",
                    transition: "width 0.35s ease",
                  }}
                />
              </div>

              {researchJob && researchJob.steps.length > 0 && (
                <div className="grid grid-2" style={{ gap: 8 }}>
                  {researchJob.steps.map((st) => (
                    <div
                      key={st.key}
                      className="row"
                      style={{
                        justifyContent: "space-between",
                        padding: "6px 10px",
                        borderRadius: 8,
                        border: "1px solid var(--line-soft)",
                        background: "var(--surface-2)",
                      }}
                    >
                      <span className="tiny">{st.label}</span>
                      <Badge
                        tone={
                          st.status === "done"
                            ? "ok"
                            : st.status === "in_progress"
                              ? "info"
                              : st.status === "failed"
                                ? "bad"
                                : undefined
                        }
                      >
                        {st.status === "in_progress"
                          ? "Working"
                          : st.status === "done"
                            ? "Done"
                            : st.status === "failed"
                              ? "Failed"
                              : "Queued"}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>
        )}

        {error && (
          <Banner tone="bad">
            <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
              <span>{error}</span>
              <button type="button" className="btn btn-sm" onClick={() => void runResearch({ force: true })}>
                <RotateCcw size={13} />
                Retry research
              </button>
            </div>
          </Banner>
        )}

        {/* Overall Strategy Banner */}
        {report && (
          <Card
            title="Strategic Growth Thesis"
            sub={`Researched ${new Date(report.generatedAt).toLocaleString()} · Powered by your Knowledge Base, live Supabase pipeline metrics & 2026 market search`}
            actions={
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <NarratorControl
                  text={`Overall Growth Strategy: ${report.overallStrategy}. Top recommendation: ${report.recommendations[0]?.title ?? ""}. ${report.recommendations[0]?.summary ?? ""}`}
                />
                <button type="button" className="btn btn-primary btn-sm" onClick={() => openExecute(null)}>
                  <Play size={12} />
                  Execute full strategy
                </button>
              </div>
            }
          >
            <p style={{ margin: "0 0 12px", fontSize: 13.8, lineHeight: 1.6 }}>{report.overallStrategy}</p>
            {report.sources.length > 0 && (
              <div className="row" style={{ flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <span className="tiny muted row" style={{ gap: 4 }}>
                  <Globe size={12} />
                  Live web sources:
                </span>
                {report.sources.slice(0, 6).map((src, i) => (
                  <a
                    key={i}
                    href={src.uri}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="tiny row"
                    style={{
                      gap: 4,
                      padding: "2px 8px",
                      borderRadius: 6,
                      border: "1px solid var(--line)",
                      color: "var(--teal-deep)",
                      background: "var(--surface-2)",
                      maxWidth: 220,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{src.title || src.uri}</span>
                    <ExternalLink size={10} style={{ flexShrink: 0 }} />
                  </a>
                ))}
              </div>
            )}
          </Card>
        )}

        {/* 1. Live Market Pulse + 2. Candid Pipeline Diagnosis */}
        {report && (report.marketPulse?.length || report.pipelineDiagnosis) && (
          <div className="grid grid-2" style={{ gap: 14 }}>
            {report.marketPulse && report.marketPulse.length > 0 && (
              <Card
                title="Live Market Pulse (Trending Now in Your Field)"
                sub="Verified 2026 signals shaping buyer urgency right now"
              >
                <div className="stack" style={{ gap: 10 }}>
                  {report.marketPulse.map((item, idx) => (
                    <div
                      key={idx}
                      style={{
                        padding: "9px 11px",
                        borderRadius: 8,
                        border: "1px solid var(--line-soft)",
                        background: "var(--surface-2)",
                      }}
                    >
                      <div className="strong" style={{ fontSize: 13, marginBottom: 4 }}>
                        {item.trend}
                      </div>
                      <p className="tiny muted" style={{ margin: "0 0 6px", lineHeight: 1.45 }}>
                        {item.whyNow}
                      </p>
                      {item.sourceUrl && (
                        <a
                          href={item.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="tiny row"
                          style={{ gap: 4, color: "var(--teal-deep)" }}
                        >
                          {item.sourceTitle || item.sourceUrl} <ExternalLink size={10} />
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {report.pipelineDiagnosis && (
              <Card
                title="Candid Pipeline & Positioning Diagnosis"
                sub="Grounded in your live workspace leads, replies & Knowledge Base"
                actions={
                  report.pipelineDiagnosis.untouchedLeadsCount > 0 ? (
                    <Badge tone="warn">
                      {report.pipelineDiagnosis.untouchedLeadsCount} untouched lead
                      {report.pipelineDiagnosis.untouchedLeadsCount === 1 ? "" : "s"}
                    </Badge>
                  ) : undefined
                }
              >
                <div className="stack" style={{ gap: 10 }}>
                  <p style={{ margin: 0, fontSize: 13.2, lineHeight: 1.55 }}>{report.pipelineDiagnosis.summary}</p>
                  {report.pipelineDiagnosis.strengths.length > 0 && (
                    <div>
                      <div className="label" style={{ marginBottom: 4 }}>What works in your positioning</div>
                      <ul className="tiny" style={{ paddingLeft: 16, margin: 0 }}>
                        {report.pipelineDiagnosis.strengths.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {report.pipelineDiagnosis.bottlenecks.length > 0 && (
                    <div>
                      <div className="label" style={{ marginBottom: 4 }}>Honest bottlenecks to fix</div>
                      <ul className="tiny muted" style={{ paddingLeft: 16, margin: 0 }}>
                        {report.pipelineDiagnosis.bottlenecks.map((b, i) => (
                          <li key={i}>{b}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {report.pipelineDiagnosis.quickWinAction && (
                    <Banner tone="info">
                      <strong>Fastest win right now:</strong> {report.pipelineDiagnosis.quickWinAction}
                    </Banner>
                  )}
                </div>
              </Card>
            )}
          </div>
        )}

        {/* 3. Top 3 Ranked Growth Plays */}
        {report?.topPlays && report.topPlays.length > 0 && (
          <Card
            title="Top 3 Ranked Growth Plays"
            sub="Micro-niche focus, wedge offers tailored to your Knowledge Base, and 1-click campaign execution"
          >
            <div className="grid grid-3" style={{ gap: 12 }}>
              {report.topPlays.map((play) => {
                const matchedRec =
                  report.recommendations.find((r) => r.id === play.linkedRecommendationId) ??
                  report.recommendations[Math.max(0, play.rank - 1)] ??
                  null;
                return (
                  <div
                    key={play.rank}
                    className="stack"
                    style={{
                      gap: 8,
                      padding: 12,
                      borderRadius: 10,
                      border: "1px solid var(--line)",
                      background: "var(--surface-2)",
                      justifyContent: "space-between",
                    }}
                  >
                    <div className="stack" style={{ gap: 6 }}>
                      <div className="row" style={{ justifyContent: "space-between", gap: 6 }}>
                        <Badge tone="ok">Play #{play.rank}</Badge>
                        <span className="tiny muted">{play.realisticWeeklyTarget}</span>
                      </div>
                      <div className="strong" style={{ fontSize: 13.6 }}>{play.title}</div>
                      <div className="tiny">
                        <span className="muted">Target:</span> <strong>{play.microNiche}</strong> · {play.geoFocus}
                      </div>
                      <div className="tiny muted"><strong>Why now:</strong> {play.whyNow}</div>
                      <div className="tiny"><strong>Wedge offer:</strong> {play.wedgeOffer}</div>
                      <div className="tiny muted"><strong>Hook:</strong> {play.openingHook}</div>
                      <div className="tiny muted"><strong>Channels + Referral:</strong> {play.channelSequence} {play.referralLoop ? `· ${play.referralLoop}` : ""}</div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => openExecute(matchedRec)}
                    >
                      <Play size={12} />
                      Launch Campaign From This Play
                    </button>
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        {/* Category Filter Tabs */}
        {report && report.recommendations.length > 0 && (
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className={`btn btn-sm ${categoryFilter === "all" ? "btn-primary" : ""}`}
              onClick={() => setCategoryFilter("all")}
            >
              All ({report.recommendations.length})
            </button>
            {(Object.keys(CATEGORY_LABELS) as RecommendationCategory[]).map((cat) => {
              const count = report.recommendations.filter((r) => r.category === cat).length;
              if (count === 0) return null;
              return (
                <button
                  key={cat}
                  type="button"
                  className={`btn btn-sm ${categoryFilter === cat ? "btn-primary" : ""}`}
                  onClick={() => setCategoryFilter(cat)}
                >
                  {CATEGORY_LABELS[cat]} ({count})
                </button>
              );
            })}
          </div>
        )}

        {/* Recommendations List */}
        {completeness.complete && !researching && (!report || report.recommendations.length === 0) && !error && (
          <Empty title="No recommendations generated yet">
            Click <strong>Refresh research</strong> to analyse current market trends and build your recommendations.
          </Empty>
        )}

        <div className="grid grid-2" style={{ gap: 14 }}>
          {filteredRecs.map((rec) => {
            const isHighlighted = highlightId === rec.id;
            return (
              <div
                key={rec.id}
                className={isHighlighted ? "analysis-highlight" : ""}
                style={{ display: "flex" }}
              >
                <Card
                  title={`#${rec.priorityOrder} · ${rec.title}`}
                  sub={CATEGORY_LABELS[rec.category]}
                  actions={
                    <div className="row" style={{ gap: 6 }}>
                      <Badge
                        tone={rec.impact === "high" ? "ok" : rec.impact === "medium" ? "warn" : undefined}
                      >
                        {rec.impact.toUpperCase()} IMPACT
                      </Badge>
                      <Badge>{rec.confidence}% confidence</Badge>
                    </div>
                  }
                >
                  <div className="stack" style={{ gap: 10 }}>
                    {rec.basedOnAnalytics && (
                      <div className="tiny row" style={{ gap: 5, color: "var(--teal-deep)", fontWeight: 600 }}>
                        <TrendingUp size={12} />
                        Informed by your campaign analytics
                      </div>
                    )}

                    <p style={{ margin: 0, fontSize: 13.4, lineHeight: 1.55 }}>{rec.summary}</p>

                    <div
                      style={{
                        padding: "9px 11px",
                        borderRadius: 8,
                        background: "var(--surface-2)",
                        border: "1px solid var(--line-soft)",
                        fontSize: 12.2,
                      }}
                    >
                      <div style={{ marginBottom: 4 }}>
                        <strong>Why it works:</strong> {rec.reason}
                      </div>
                      <div className="muted">
                        <strong>Evidence:</strong> {rec.evidence}
                      </div>
                      {rec.sourceUrl && (
                        <div style={{ marginTop: 6 }}>
                          <a
                            href={rec.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="tiny row"
                            style={{ gap: 4, color: "var(--teal-deep)" }}
                          >
                            Source: {rec.sourceTitle || rec.sourceUrl} <ExternalLink size={11} />
                          </a>
                        </div>
                      )}
                    </div>

                    {/* Action Blueprint Preview */}
                    <div
                      className="grid grid-2"
                      style={{
                        gap: 8,
                        fontSize: 11.8,
                        padding: "8px 10px",
                        borderRadius: 8,
                        border: "1px dashed var(--line)",
                      }}
                    >
                      <div>
                        <span className="muted">Target market:</span>{" "}
                        <strong>{rec.suggestedAction.targetLocation}</strong>
                      </div>
                      <div>
                        <span className="muted">Audience:</span>{" "}
                        <strong>{rec.suggestedAction.targetIndustry}</strong>
                      </div>
                      <div>
                        <span className="muted">Channel & timing:</span>{" "}
                        <strong>
                          {rec.suggestedAction.channel} ({rec.suggestedAction.timing})
                        </strong>
                      </div>
                      <div>
                        <span className="muted">Hook / Subject:</span>{" "}
                        <strong>{rec.suggestedAction.subjectLine || rec.suggestedAction.angle}</strong>
                      </div>
                    </div>

                    <div
                      className="row"
                      style={{
                        justifyContent: "space-between",
                        alignItems: "center",
                        flexWrap: "wrap",
                        gap: 8,
                        paddingTop: 6,
                      }}
                    >
                      <NarratorControl
                        text={`${rec.title}. ${rec.summary}. Reason: ${rec.reason}. Evidence: ${rec.evidence}.`}
                      />
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => openExecute(rec)}
                      >
                        <Sparkles size={12} />
                        Execute
                      </button>
                    </div>
                  </div>
                </Card>
              </div>
            );
          })}
        </div>
      </div>

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
    </main>
  );
}

export default function GrowthAdvisorPage() {
  return (
    <Suspense
      fallback={
        <main className="page">
          <BrandLoader fullScreen />
        </main>
      }
    >
      <GrowthAdvisorContent />
    </Suspense>
  );
}
