"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BACKGROUND_JOB_EVENT } from "@/components/BackgroundJobsBar";
import type { BackgroundJobRecord } from "./background-jobs";
import { authedGet, authedPost, authedPut, errorMessage } from "./client";
import {
  computeProfileFingerprint,
  EMPTY_GROWTH_PROFILE,
  evaluateProfileCompleteness,
  hydrateGrowthProfileFromOnboarding,
  isReportStale,
  type GrowthAdvisorReport,
  type GrowthProfile,
} from "./growth-advisor";
import type { PerformanceInsight } from "./intelligence";
import type { OnboardingState } from "./onboarding";
import {
  clearGrowthAdvisorReport,
  formatKnowledgeDigest,
  getGrowthAdvisorReport,
  getGrowthProfile,
  getKnowledgeBundle,
  getOnboardingState,
  getSettings,
  listLeadIndex,
  loadAnalyticsBundle,
  saveGrowthAdvisorReport,
  saveGrowthProfile,
} from "./store";
import { DEFAULT_SETTINGS, type Settings } from "./types";

export function useGrowthAdvisor(
  uid: string,
  options?: {
    analyticsInsight?: PerformanceInsight | null;
    autoResearch?: boolean;
  },
) {
  const analyticsInsight = options?.analyticsInsight ?? null;
  const autoResearch = options?.autoResearch ?? true;

  const [profile, setProfile] = useState<GrowthProfile>(EMPTY_GROWTH_PROFILE);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [knowledgeDigest, setKnowledgeDigest] = useState("");
  const [metrics, setMetrics] = useState<Awaited<ReturnType<typeof loadAnalyticsBundle>> | null>(null);
  const [existingEmails, setExistingEmails] = useState<string[]>([]);
  const [report, setReport] = useState<GrowthAdvisorReport | null>(null);
  const [researchJob, setResearchJob] = useState<BackgroundJobRecord | null>(null);
  const [syncSourceNote, setSyncSourceNote] = useState("Synced with Knowledge Base & Onboarding");

  const [loading, setLoading] = useState(true);
  const [researching, setResearching] = useState(false);
  // Set by "New Analysis" so the automatic refresh loop does not immediately
  // rebuild the report the user just cleared.
  const [analysisCleared, setAnalysisCleared] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runningRef = useRef(false);
  const lastInsightKeyRef = useRef<string>("");

  const metricsSummary = useMemo(
    () => ({
      leads: metrics?.totals.leads ?? 0,
      campaigns: metrics?.totals.campaigns ?? 0,
      sent: metrics?.delivery.sent ?? 0,
      replies: metrics?.totals.replies ?? 0,
      positive: metrics?.totals.positive ?? 0,
    }),
    [metrics],
  );

  const fingerprint = useMemo(
    () =>
      computeProfileFingerprint({
        profile,
        knowledgeDigest,
        settings,
        metricsSummary,
      }),
    [profile, knowledgeDigest, settings, metricsSummary],
  );

  const completeness = useMemo(
    () => evaluateProfileCompleteness(profile, knowledgeDigest, settings),
    [profile, knowledgeDigest, settings],
  );

  const runResearch = useCallback(
    async (opts?: {
      profileOverride?: GrowthProfile;
      insightOverride?: PerformanceInsight | null;
      force?: boolean;
    }) => {
      if (runningRef.current) return;
      runningRef.current = true;
      setAnalysisCleared(false);
      setResearching(true);
      setError(null);
      try {
        const activeProfile = opts?.profileOverride ?? profile;
        const activeInsight = opts?.insightOverride !== undefined ? opts.insightOverride : analyticsInsight;
        const activeFp = computeProfileFingerprint({
          profile: activeProfile,
          knowledgeDigest,
          settings,
          metricsSummary,
        });

        const res = await authedPost<{ job: BackgroundJobRecord; reused?: boolean }>(
          "/api/ai/growth-advisor/jobs",
          {
            profile: activeProfile,
            knowledgeDigest,
            settings,
            metricsSummary: {
              totals: metrics?.totals,
              delivery: metrics?.delivery,
              industries: metrics?.industries,
              angles: metrics?.angles,
              campaigns: metrics?.campaigns?.slice(0, 8),
            },
            analyticsInsight: activeInsight,
            fingerprint: activeFp,
            model: settings.model,
            force: Boolean(opts?.force),
          },
        );

        setResearchJob(res.job);
        window.dispatchEvent(new CustomEvent(BACKGROUND_JOB_EVENT));

        if (res.job.status === "succeeded" && res.job.result?.report) {
          const rep = res.job.result.report as GrowthAdvisorReport;
          setReport(rep);
          await saveGrowthAdvisorReport(uid, rep);
          setResearching(false);
        } else if (res.job.status === "failed") {
          setError(res.job.errorMessage || "Research failed.");
          setResearching(false);
        }
      } catch (err) {
        setError(errorMessage(err));
        setResearching(false);
      } finally {
        runningRef.current = false;
      }
    },
    [uid, profile, knowledgeDigest, settings, metricsSummary, metrics, analyticsInsight],
  );

  // Initial load of profile, onboarding answers, knowledge, settings, metrics, report, and active background job
  useEffect(() => {
    let active = true;
    Promise.all([
      getGrowthProfile(uid),
      getOnboardingState(uid),
      getKnowledgeBundle(uid),
      getSettings(uid),
      loadAnalyticsBundle(uid),
      listLeadIndex(uid),
      getGrowthAdvisorReport(uid),
      authedGet<{ job: BackgroundJobRecord | null }>("/api/ai/growth-advisor/jobs").catch(() => ({
        job: null,
      })),
    ])
      .then(([prof, onbState, kBundle, sett, analyticsData, leads, cachedReport, jobRes]) => {
        if (!active) return;
        const digest = formatKnowledgeDigest(kBundle);
        const hydratedProfile = hydrateGrowthProfileFromOnboarding(prof, onbState.answers, sett);

        setProfile(hydratedProfile);
        setKnowledgeDigest(digest);
        setSettings(sett);
        setMetrics(analyticsData);
        setExistingEmails(leads.map((l) => l.email_norm || l.email || "").filter(Boolean));
        if (onbState.status === "completed") {
          setSyncSourceNote("Synced from Onboarding, Knowledge Base & Settings");
        }

        let effectiveReport = cachedReport;
        const latestJob = jobRes.job;
        if (latestJob) {
          setResearchJob(latestJob);
          if (latestJob.status === "queued" || latestJob.status === "running") {
            setResearching(true);
          } else if (latestJob.status === "succeeded" && latestJob.result?.report) {
            const jobRep = latestJob.result.report as GrowthAdvisorReport;
            if (!effectiveReport || jobRep.generatedAt > effectiveReport.generatedAt) {
              effectiveReport = jobRep;
            }
          } else if (latestJob.status === "failed" && !effectiveReport) {
            setError(latestJob.errorMessage || "Previous research job failed.");
          }
        }

        if (effectiveReport) setReport(effectiveReport);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        setError(errorMessage(err));
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [uid]);

  // Poll active persistent Growth Advisor job until completion or failure
  const isJobActive = Boolean(
    researchJob && (researchJob.status === "queued" || researchJob.status === "running"),
  );

  useEffect(() => {
    if (!isJobActive) return;
    let cancelled = false;
    const poll = () => {
      void authedGet<{ job: BackgroundJobRecord | null }>("/api/ai/growth-advisor/jobs")
        .then(async (res) => {
          if (cancelled || !res.job) return;
          setResearchJob(res.job);
          if (res.job.status === "succeeded") {
            setResearching(false);
            if (res.job.result?.report) {
              const rep = res.job.result.report as GrowthAdvisorReport;
              setReport(rep);
              await saveGrowthAdvisorReport(uid, rep);
            }
            window.dispatchEvent(new CustomEvent(BACKGROUND_JOB_EVENT));
          } else if (res.job.status === "failed") {
            setResearching(false);
            setError(res.job.errorMessage || "Research job failed.");
            window.dispatchEvent(new CustomEvent(BACKGROUND_JOB_EVENT));
          }
        })
        .catch(() => {
          /* continue polling quietly */
        });
    };
    const timer = window.setInterval(poll, 1800);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isJobActive, uid]);

  /** "New Analysis": clear the saved thesis and pause auto-refresh until asked. */
  const clearReport = useCallback(async () => {
    setReport(null);
    setResearchJob(null);
    setError(null);
    setAnalysisCleared(true);
    await clearGrowthAdvisorReport(uid);
  }, [uid]);

  // Automatic background refresh when profile/data changes or report expires
  useEffect(() => {
    if (loading || !autoResearch || researching || analysisCleared) return;
    if (!completeness.complete) return;
    if (researchJob?.status === "failed") return; // do not infinitely loop failed jobs automatically

    const insightKey = analyticsInsight ? analyticsInsight.headline : "";
    const insightChanged = Boolean(insightKey && insightKey !== lastInsightKeyRef.current);

    if (isReportStale(report, fingerprint) || insightChanged) {
      if (insightKey) lastInsightKeyRef.current = insightKey;
      void runResearch({ insightOverride: analyticsInsight });
    }
  }, [
    loading,
    autoResearch,
    researching,
    analysisCleared,
    completeness.complete,
    report,
    fingerprint,
    analyticsInsight,
    researchJob,
    runResearch,
  ]);

  // Periodic background check every 30 minutes while open
  useEffect(() => {
    if (!autoResearch || !completeness.complete || analysisCleared) return;
    const timer = window.setInterval(() => {
      if (isReportStale(report, fingerprint)) {
        void runResearch();
      }
    }, 30 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [autoResearch, completeness.complete, analysisCleared, report, fingerprint, runResearch]);

  const updateProfile = useCallback(
    async (next: GrowthProfile, triggerResearch = true) => {
      setSavingProfile(true);
      setError(null);
      try {
        const saved = await saveGrowthProfile(uid, next);
        setProfile(saved);

        // Bidirectional lightweight sync back to Onboarding answers
        void authedGet<{ state: OnboardingState }>("/api/onboarding/state")
          .then(({ state }) => {
            if (!state) return;
            return authedPut("/api/onboarding/state", {
              ...state,
              answers: {
                ...state.answers,
                businessName: saved.whoYouAre || state.answers.businessName,
                industry: saved.industry || state.answers.industry,
                businessDescription: saved.whatYouSell || state.answers.businessDescription,
                differentiators: saved.offer || state.answers.differentiators,
                priceRange: saved.priceRange || state.answers.priceRange,
                currentMarkets: saved.location || state.answers.currentMarkets,
                idealCustomerSummary: saved.idealCustomer || state.answers.idealCustomerSummary,
                website: saved.businessWebsite || state.answers.website,
                icpIndustries:
                  saved.targetIndustries && saved.targetIndustries.length > 0
                    ? saved.targetIndustries
                    : state.answers.icpIndustries,
                icpRoles:
                  saved.targetRoles && saved.targetRoles.length > 0
                    ? saved.targetRoles
                    : state.answers.icpRoles,
                icpCompanySize: saved.targetCompanySize || state.answers.icpCompanySize,
                icpBuyingTriggers:
                  saved.buyingTriggers && saved.buyingTriggers.length > 0
                    ? saved.buyingTriggers
                    : state.answers.icpBuyingTriggers,
                channelsUsed:
                  saved.preferredChannels && saved.preferredChannels.length > 0
                    ? saved.preferredChannels
                    : state.answers.channelsUsed,
                icpExclusions: saved.exclusions ?? state.answers.icpExclusions,
                brandTones:
                  saved.tonePreference && saved.tonePreference.length > 0
                    ? saved.tonePreference
                    : state.answers.brandTones,
              },
            });
          })
          .catch(() => {});

        const nextComp = evaluateProfileCompleteness(saved, knowledgeDigest, settings);
        if (triggerResearch && nextComp.complete) {
          void runResearch({ profileOverride: saved, force: true });
        }
        return saved;
      } catch (err) {
        setError(errorMessage(err));
        throw err;
      } finally {
        setSavingProfile(false);
      }
    },
    [uid, knowledgeDigest, settings, runResearch],
  );

  return {
    profile,
    setProfile,
    updateProfile,
    settings,
    knowledgeDigest,
    metrics,
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
    clearReport,
  };
}
