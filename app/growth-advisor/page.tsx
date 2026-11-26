"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Globe,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { BrandLoader } from "@/components/BrandLoader";
import { Badge, Banner, Card, Empty, Field } from "@/components/ui";
import { GrowthExecuteModal } from "@/components/GrowthExecuteModal";
import { NarratorControl } from "@/components/NarratorControl";
import { useToast } from "@/components/Feedback";
import {
  CATEGORY_LABELS,
  type GrowthProfile,
  type GrowthRecommendation,
  type RecommendationCategory,
} from "@/lib/growth-advisor";
import { useGrowthAdvisor } from "@/lib/useGrowthAdvisor";

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
    completeness,
    loading,
    researching,
    savingProfile,
    error,
    runResearch,
  } = useGrowthAdvisor(user.uid, { autoResearch: true });

  const [categoryFilter, setCategoryFilter] = useState<"all" | RecommendationCategory>("all");
  const [profileExpanded, setProfileExpanded] = useState(false);
  const [executeRec, setExecuteRec] = useState<GrowthRecommendation | null>(null);
  const [executeOpen, setExecuteOpen] = useState(false);

  // Auto-open profile editor when required details are missing
  useEffect(() => {
    if (!loading && !completeness.complete) {
      setProfileExpanded(true);
    }
  }, [loading, completeness.complete]);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await updateProfile(profile, true);
      toast.success("Business profile saved", "Growth Advisor is refreshing live internet research for your business.");
      setProfileExpanded(false);
    } catch {
      // error already exposed via hook
    }
  };

  const setField = <K extends keyof GrowthProfile>(key: K, value: GrowthProfile[K]) => {
    setProfile((prev) => ({ ...prev, [key]: value }));
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
            <form onSubmit={handleSaveProfile} className="stack" style={{ gap: 12 }}>
              {!completeness.complete && (
                <Banner tone="info">
                  Fill out what you sell, your industry, offer, price range, and target location. You can also enrich
                  your long-form offer docs in <Link href="/knowledge">Knowledge base</Link> and sender settings in{" "}
                  <Link href="/settings">Settings</Link>.
                </Banner>
              )}

              <div className="grid grid-2" style={{ gap: 12 }}>
                <Field label="Who you are / Company name" hint="Your brand, agency, or founder identity">
                  <input
                    value={profile.whoYouAre}
                    onChange={(e) => setField("whoYouAre", e.target.value)}
                    placeholder="e.g. Brightline Digital Studio"
                  />
                </Field>
                <Field label="Industry / Category" hint="What space do you operate in?">
                  <input
                    value={profile.industry}
                    onChange={(e) => setField("industry", e.target.value)}
                    placeholder="e.g. B2B Web Design, SaaS Consulting, HVAC Services"
                  />
                </Field>
              </div>

              <div className="grid grid-2" style={{ gap: 12 }}>
                <Field label="What you sell or do" hint="Core service or product">
                  <input
                    value={profile.whatYouSell}
                    onChange={(e) => setField("whatYouSell", e.target.value)}
                    placeholder="e.g. Custom high-converting websites and local SEO for dental clinics"
                  />
                </Field>
                <Field label="Core offer / Hook" hint="Specific outcome or deliverable">
                  <input
                    value={profile.offer}
                    onChange={(e) => setField("offer", e.target.value)}
                    placeholder="e.g. 14-day patient-booking website rebuild with conversion guarantee"
                  />
                </Field>
              </div>

              <div className="grid grid-3" style={{ gap: 12 }}>
                <Field label="Price range" hint="Helps match buyers who can afford you">
                  <input
                    value={profile.priceRange}
                    onChange={(e) => setField("priceRange", e.target.value)}
                    placeholder="e.g. $2,500 - $6,000 / project"
                  />
                </Field>
                <Field label="Target or base location" hint="Cities, states, or countries">
                  <input
                    value={profile.location}
                    onChange={(e) => setField("location", e.target.value)}
                    placeholder="e.g. Austin TX, Dallas, or United Kingdom"
                  />
                </Field>
                <Field label="Ideal customer" hint="Decision maker & company size">
                  <input
                    value={profile.idealCustomer}
                    onChange={(e) => setField("idealCustomer", e.target.value)}
                    placeholder="e.g. Independent clinic owners with 3-20 staff"
                  />
                </Field>
              </div>

              <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
                <span className="tiny muted">
                  Also synced with {knowledgeDigest ? "Knowledge base" : "Settings"}{" "}
                  {settings.sender_company ? `(${settings.sender_company})` : ""}.
                </span>
                <div className="row" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setProfileExpanded(false)}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={savingProfile}>
                    {savingProfile ? "Saving & researching…" : "Save profile & run research"}
                  </button>
                </div>
              </div>
            </form>
          )}
        </Card>

        {/* Live Research Status & Errors */}
        {researching && (
          <Banner tone="info">
            <div className="row" style={{ gap: 10 }}>
              <Loader2 size={16} className="spin" />
              <div>
                <strong>Running background internet research…</strong>
                <div className="tiny">
                  Searching live market trends, high-demand locations, winning hooks, and buyer benchmarks for your
                  business.
                </div>
              </div>
            </div>
          </Banner>
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
            sub={`Researched ${new Date(report.generatedAt).toLocaleString()} · Automatically updates when your profile or results change`}
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
                {report.sources.slice(0, 5).map((src, i) => (
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
