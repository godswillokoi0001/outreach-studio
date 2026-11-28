"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePersistedPageState } from "@/lib/usePersistedPageState";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Flame,
  Loader2,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserCheck,
} from "lucide-react";
import { useAuth } from "./AuthProvider";
import { Badge, Banner, Field, Modal } from "./ui";
import { useToast } from "./Feedback";
import { authedPost, errorMessage } from "@/lib/client";
import type {
  ExecutedCampaignBlueprint,
  ExecutedProspect,
  GrowthExecuteStage,
  GrowthProfile,
  GrowthRecommendation,
} from "@/lib/growth-advisor";
import { commitExecutedCampaign } from "@/lib/store";
import type { Settings } from "@/lib/types";

interface GrowthExecuteModalProps {
  open: boolean;
  onClose: () => void;
  recommendation?: GrowthRecommendation | null;
  overallStrategy?: string;
  profile: GrowthProfile;
  knowledgeDigest: string;
  settings: Settings;
  existingEmails: string[];
  onCampaignCreated?: (campaignId: string) => void;
}

const PROGRESS_STEPS: { key: GrowthExecuteStage; label: string }[] = [
  { key: "strategy", label: "Offer fit, regional compliance & search queries" },
  { key: "discover", label: "Searching public web & local directories" },
  { key: "inspect", label: "Inspecting live websites & DNS MX records" },
  { key: "score_and_build", label: "Scoring buying intent & drafting first lines" },
];

export function GrowthExecuteModal({
  open,
  onClose,
  recommendation,
  overallStrategy,
  profile,
  knowledgeDigest,
  settings,
  existingEmails,
  onCampaignCreated,
}: GrowthExecuteModalProps) {
  const { user } = useAuth();
  const toast = useToast();

  const [generating, setGenerating] = useState(false);
  const [activeStage, setActiveStage] = usePersistedPageState<GrowthExecuteStage>(
    "growth:execute_stage",
    "strategy",
  );
  const [completedStages, setCompletedStages] = usePersistedPageState<GrowthExecuteStage[]>(
    "growth:execute_completed",
    [],
  );
  const [stepSummaries, setStepSummaries] = useState<Partial<Record<GrowthExecuteStage, string>>>({});
  const [failedStage, setFailedStage] = useState<GrowthExecuteStage | null>(null);
  const [runId, setRunId] = usePersistedPageState<string | null>("growth:execute_run", null);
  const [error, setError] = useState<string | null>(null);
  const [blueprint, setBlueprint] = useState<ExecutedCampaignBlueprint | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedResult, setSavedResult] = useState<{
    campaignId: string;
    campaignName: string;
    leadsCreated: number;
    draftsCreated: number;
  } | null>(null);
  const [activeTab, setActiveTab] = useState<"prospects" | "plan">("prospects");

  const runPipeline = async (startFrom: GrowthExecuteStage = "strategy") => {
    setGenerating(true);
    setError(null);
    setFailedStage(null);
    if (startFrom === "strategy") {
      setBlueprint(null);
      setSavedResult(null);
      setCompletedStages([]);
      setStepSummaries({});
      setRunId(null);
    }

    const startIndex = Math.max(0, PROGRESS_STEPS.findIndex((s) => s.key === startFrom));
    let currentRunId = startFrom === "strategy" ? null : runId;

    try {
      for (let i = startIndex; i < PROGRESS_STEPS.length; i++) {
        const stage = PROGRESS_STEPS[i].key;
        setActiveStage(stage);

        const res = await authedPost<{
          runId: string;
          summary: string;
          blueprint?: ExecutedCampaignBlueprint;
        }>("/api/ai/growth-execute", {
          stage,
          runId: currentRunId ?? undefined,
          recommendation: recommendation ?? null,
          overallStrategy,
          profile,
          knowledgeDigest,
          settings,
          existingEmails,
        });

        currentRunId = res.runId || currentRunId;
        if (currentRunId) setRunId(currentRunId);

        setStepSummaries((prev) => ({ ...prev, [stage]: res.summary }));
        setCompletedStages((prev) => (prev.includes(stage) ? prev : [...prev, stage]));

        if (stage === "score_and_build" && res.blueprint) {
          setBlueprint(res.blueprint);
        }
      }
    } catch (err) {
      setFailedStage(PROGRESS_STEPS.find((s) => s.key === activeStage)?.key ?? startFrom);
      setError(errorMessage(err));
    } finally {
      setGenerating(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const t = window.setTimeout(() => {
      if (cancelled) return;
      if (open) {
        void runPipeline("strategy");
      } else {
        setBlueprint(null);
        setError(null);
        setSavedResult(null);
        setFailedStage(null);
        setRunId(null);
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, recommendation?.id]);

  const toggleProspect = (id: string) => {
    setBlueprint((prev) =>
      prev
        ? {
            ...prev,
            prospects: prev.prospects.map((p) => (p.id === id ? { ...p, selected: !p.selected } : p)),
          }
        : null,
    );
  };

  const removeProspect = (id: string) => {
    setBlueprint((prev) =>
      prev
        ? {
            ...prev,
            prospects: prev.prospects.filter((p) => p.id !== id),
          }
        : null,
    );
  };

  const updateProspectField = (id: string, field: keyof ExecutedProspect, value: string) => {
    setBlueprint((prev) =>
      prev
        ? {
            ...prev,
            prospects: prev.prospects.map((p) => (p.id === id ? { ...p, [field]: value } : p)),
          }
        : null,
    );
  };

  const handleApproveAndSave = async () => {
    if (!blueprint) return;
    setSaving(true);
    setError(null);
    try {
      const res = await commitExecutedCampaign(user.uid, blueprint);
      setSavedResult({
        campaignId: res.campaign.id,
        campaignName: res.campaign.name,
        leadsCreated: res.leadsCreated,
        draftsCreated: res.draftsCreated,
      });
      toast.success(
        "Campaign ready for review",
        `Created "${res.campaign.name}" with ${res.leadsCreated} prospects and ${res.draftsCreated} drafts awaiting approval.`,
      );
      onCampaignCreated?.(res.campaign.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const selectedCount = blueprint?.prospects.filter((p) => p.selected).length ?? 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={recommendation ? `Execute: ${recommendation.title}` : "Execute Growth Strategy"}
      large
    >
      <div className="stack" style={{ gap: 14 }}>
        {generating && (
          <div
            style={{
              padding: "24px 18px",
              borderRadius: 12,
              border: "1px solid var(--line)",
              background: "var(--surface-2)",
            }}
          >
            <div className="row" style={{ gap: 10, marginBottom: 14 }}>
              <Loader2 size={18} className="spin" style={{ color: "var(--teal-deep)" }} />
              <div>
                <div className="strong" style={{ fontSize: 14 }}>
                  Building your campaign & researching high-intent buyers…
                </div>
                <div className="tiny muted">
                  Using public, verified sources and prioritising prospects by buying intent.
                </div>
              </div>
            </div>
            <div className="stack" style={{ gap: 8 }}>
              {PROGRESS_STEPS.map((st, idx) => {
                const done = completedStages.includes(st.key);
                const active = !done && activeStage === st.key;
                const activeIdx = PROGRESS_STEPS.findIndex((x) => x.key === activeStage);
                const summary = stepSummaries[st.key];
                return (
                  <div
                    key={st.key}
                    className="row"
                    style={{
                      gap: 8,
                      fontSize: 12.5,
                      opacity: !done && idx > activeIdx ? 0.45 : 1,
                      color: active ? "var(--ink)" : "var(--muted)",
                      fontWeight: active ? 600 : 400,
                      justifyContent: "space-between",
                    }}
                  >
                    <div className="row" style={{ gap: 8 }}>
                      {done ? (
                        <CheckCircle2 size={14} style={{ color: "var(--teal-deep)", flexShrink: 0 }} />
                      ) : active ? (
                        <Loader2 size={14} className="spin" style={{ color: "var(--teal-deep)", flexShrink: 0 }} />
                      ) : (
                        <span style={{ width: 14, height: 14, borderRadius: "50%", border: "1px solid var(--line)" }} />
                      )}
                      <span>{summary || st.label}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {error && (
          <Banner tone="bad">
            <div className="stack" style={{ gap: 8 }}>
              <div>{error}</div>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                {failedStage && runId && (
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => void runPipeline(failedStage)}>
                    <RotateCcw size={13} />
                    Retry This Step
                  </button>
                )}
                <button type="button" className="btn btn-sm" onClick={() => void runPipeline("strategy")}>
                  <RotateCcw size={13} />
                  Start Over
                </button>
              </div>
            </div>
          </Banner>
        )}

        {savedResult && (
          <Banner tone="ok">
            <div className="stack" style={{ gap: 8 }}>
              <div className="strong">Campaign & prospects saved — nothing has been sent yet!</div>
              <div className="tiny">
                Created campaign <strong>{savedResult.campaignName}</strong> with{" "}
                <strong>{savedResult.leadsCreated}</strong> prioritised prospects and{" "}
                <strong>{savedResult.draftsCreated}</strong> email drafts awaiting your final review.
              </div>
              <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 4 }}>
                <Link href="/review" className="btn btn-primary btn-sm" onClick={onClose}>
                  Review & approve drafts
                </Link>
                <Link href="/campaigns" className="btn btn-sm" onClick={onClose}>
                  Open Campaigns
                </Link>
                <Link href="/leads" className="btn btn-ghost btn-sm" onClick={onClose}>
                  View Leads
                </Link>
              </div>
            </div>
          </Banner>
        )}

        {blueprint && !savedResult && (
          <>
            <Banner tone="info">
              <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                <ShieldCheck size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                <div className="tiny">
                  <strong>Review before launch:</strong> Edit the campaign plan or prospect details below. All emails go
                  into <strong>Email review</strong> as drafts so nothing is sent until you approve.
                </div>
              </div>
            </Banner>

            {/* Tab Switcher */}
            <div className="row" style={{ gap: 8, borderBottom: "1px solid var(--line)", paddingBottom: 10 }}>
              <button
                type="button"
                className={`btn btn-sm ${activeTab === "prospects" ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setActiveTab("prospects")}
              >
                <Flame size={13} />
                Prioritised Prospects ({selectedCount}/{blueprint.prospects.length})
              </button>
              <button
                type="button"
                className={`btn btn-sm ${activeTab === "plan" ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setActiveTab("plan")}
              >
                <Sparkles size={13} />
                Campaign Plan & Compliance
              </button>
            </div>

            {activeTab === "prospects" && (
              <div className="stack" style={{ gap: 10, maxHeight: "52vh", overflowY: "auto", paddingRight: 4 }}>
                {blueprint.prospects.length === 0 ? (
                  <Banner tone="warn">
                    No publicly verified prospects matched this exact search query. Try adjusting the target location or
                    industry in the Campaign Plan tab and click Retry, or add leads manually later.
                  </Banner>
                ) : (
                  blueprint.prospects.map((prospect) => (
                    <div
                      key={prospect.id}
                      style={{
                        border: `1px solid ${prospect.selected ? "var(--teal-deep, #0f766e)" : "var(--line)"}`,
                        borderRadius: 10,
                        padding: 12,
                        background: prospect.selected ? "var(--surface)" : "var(--surface-2)",
                        opacity: prospect.selected ? 1 : 0.72,
                      }}
                    >
                      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                        <label className="row" style={{ gap: 8, cursor: "pointer", flex: 1 }}>
                          <input
                            type="checkbox"
                            checked={prospect.selected}
                            onChange={() => toggleProspect(prospect.id)}
                          />
                          <div>
                            <div className="strong" style={{ fontSize: 13.5 }}>
                              {prospect.business}
                            </div>
                            <div className="tiny muted">
                              {prospect.industry} · {prospect.location}
                            </div>
                          </div>
                        </label>

                        <div className="row" style={{ gap: 6, flexShrink: 0, alignItems: "center", flexWrap: "wrap" }}>
                          {prospect.email && (
                            <Badge tone={prospect.mxVerified ? "ok" : "warn"}>
                              {prospect.emailType === "direct" ? "Direct" : "Role"}
                              {prospect.mxVerified ? " · MX OK" : ""}
                            </Badge>
                          )}
                          {prospect.phone && <Badge tone="info">{prospect.phone}</Badge>}
                          <Badge
                            tone={
                              prospect.buyingIntentLevel === "high"
                                ? "ok"
                                : prospect.buyingIntentLevel === "medium"
                                  ? "warn"
                                  : undefined
                            }
                          >
                            {prospect.buyingIntentScore}/100 {prospect.buyingIntentLevel.toUpperCase()} INTENT
                          </Badge>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => removeProspect(prospect.id)}
                            title="Remove prospect"
                            aria-label={`Remove ${prospect.business}`}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>

                      {/* Buying Intent Reasoning & Signals */}
                      <div
                        style={{
                          marginTop: 8,
                          padding: "8px 10px",
                          borderRadius: 8,
                          background: "var(--surface-2)",
                          fontSize: 12,
                        }}
                      >
                        <div className="strong" style={{ fontSize: 11.5, marginBottom: 3 }}>
                          Why they are likely to pay:
                        </div>
                        <div>{prospect.buyingIntentReasoning}</div>
                        {prospect.signals.length > 0 && (
                          <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                            {prospect.signals.map((sig, sIdx) => (
                              <span
                                key={sIdx}
                                className="tiny"
                                title={sig.evidence}
                                style={{
                                  padding: "2px 7px",
                                  borderRadius: 6,
                                  border: "1px solid var(--line)",
                                  background: "var(--surface)",
                                }}
                              >
                                {sig.strength === "strong" ? "●" : "○"} {sig.signal}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Editable Contact Info */}
                      <div className="grid grid-3" style={{ gap: 8, marginTop: 10 }}>
                        <Field label="Decision maker">
                          <input
                            value={prospect.contactName}
                            onChange={(e) => updateProspectField(prospect.id, "contactName", e.target.value)}
                            placeholder="Not found"
                          />
                        </Field>
                        <Field label="Role">
                          <input
                            value={prospect.role}
                            onChange={(e) => updateProspectField(prospect.id, "role", e.target.value)}
                            placeholder="e.g. Founder / CEO"
                          />
                        </Field>
                        <Field label="Public business email">
                          <input
                            value={prospect.email}
                            onChange={(e) => updateProspectField(prospect.id, "email", e.target.value)}
                            placeholder="Not found (no draft until added)"
                          />
                        </Field>
                      </div>

                      {/* Source & Compliance */}
                      <div
                        className="row"
                        style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginTop: 8 }}
                      >
                        <div className="row tiny muted" style={{ gap: 6, flexWrap: "wrap" }}>
                          <UserCheck size={12} />
                          <span>{prospect.complianceNote}</span>
                          {prospect.socials?.slice(0, 3).map((soc, idx) => (
                            <a
                              key={idx}
                              href={soc.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ color: "var(--teal-deep)", textDecoration: "underline" }}
                            >
                              {soc.platform}
                            </a>
                          ))}
                        </div>
                        {prospect.sourceUrl && (
                          <a
                            href={prospect.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="tiny row"
                            style={{ gap: 4, color: "var(--teal-deep)" }}
                          >
                            Source ({prospect.sourceDate}) <ExternalLink size={11} />
                          </a>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {activeTab === "plan" && (
              <div className="stack" style={{ gap: 10, maxHeight: "52vh", overflowY: "auto", paddingRight: 4 }}>
                <div className="grid grid-2" style={{ gap: 10 }}>
                  <Field label="Campaign name">
                    <input
                      value={blueprint.campaignName}
                      onChange={(e) => setBlueprint({ ...blueprint, campaignName: e.target.value })}
                    />
                  </Field>
                  <Field label="Channel & cadence">
                    <input
                      value={blueprint.channel}
                      onChange={(e) => setBlueprint({ ...blueprint, channel: e.target.value })}
                    />
                  </Field>
                </div>

                <div className="grid grid-2" style={{ gap: 10 }}>
                  <Field label="Target location">
                    <input
                      value={blueprint.targetLocation}
                      onChange={(e) => setBlueprint({ ...blueprint, targetLocation: e.target.value })}
                    />
                  </Field>
                  <Field label="Target niche / audience">
                    <input
                      value={blueprint.targetAudience}
                      onChange={(e) => setBlueprint({ ...blueprint, targetAudience: e.target.value })}
                    />
                  </Field>
                </div>

                <div className="grid grid-2" style={{ gap: 10 }}>
                  <Field label="Campaign goal">
                    <input
                      value={blueprint.goal}
                      onChange={(e) => setBlueprint({ ...blueprint, goal: e.target.value })}
                    />
                  </Field>
                  <Field label="Daily send limit">
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={blueprint.schedule.dailyLimit}
                      onChange={(e) =>
                        setBlueprint({
                          ...blueprint,
                          schedule: { ...blueprint.schedule, dailyLimit: Number(e.target.value) || 20 },
                        })
                      }
                    />
                  </Field>
                </div>

                <Field label="Messaging angle & hook">
                  <textarea
                    rows={2}
                    value={`${blueprint.messagingAngle}\nHook: ${blueprint.hook}`}
                    onChange={(e) => setBlueprint({ ...blueprint, messagingAngle: e.target.value })}
                  />
                </Field>

                <Field label="Email subject line">
                  <input
                    value={blueprint.subjectLine}
                    onChange={(e) => setBlueprint({ ...blueprint, subjectLine: e.target.value })}
                  />
                </Field>

                <Field label="Sample outreach message (uses your Knowledge-Brain voice)">
                  <textarea
                    rows={5}
                    value={blueprint.sampleEmailBody}
                    onChange={(e) => setBlueprint({ ...blueprint, sampleEmailBody: e.target.value })}
                  />
                </Field>

                <div
                  style={{
                    padding: 10,
                    borderRadius: 8,
                    border: "1px solid var(--line)",
                    background: "var(--surface-2)",
                  }}
                >
                  <div className="strong tiny" style={{ marginBottom: 4 }}>
                    <AlertTriangle size={12} style={{ verticalAlign: "middle", marginRight: 5 }} />
                    Privacy & Anti-Spam Compliance Checklist
                  </div>
                  <ul className="tiny muted" style={{ paddingLeft: 18, margin: 0 }}>
                    {blueprint.complianceChecklist.map((item, idx) => (
                      <li key={idx}>{item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginTop: 6 }}>
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
                Cancel
              </button>
              <div className="row" style={{ gap: 8 }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void runPipeline("strategy")}
                  disabled={saving || generating}
                >
                  <RotateCcw size={13} />
                  Regenerate
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void handleApproveAndSave()}
                  disabled={saving}
                >
                  {saving ? "Saving campaign…" : `Approve & Create Campaign (${selectedCount} prospects)`}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
