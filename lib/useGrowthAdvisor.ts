"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authedPost, errorMessage } from "./client";
import {
  computeProfileFingerprint,
  EMPTY_GROWTH_PROFILE,
  evaluateProfileCompleteness,
  isReportStale,
  type GrowthAdvisorReport,
  type GrowthProfile,
} from "./growth-advisor";
import type { PerformanceInsight } from "./intelligence";
import {
  formatKnowledgeDigest,
  getGrowthAdvisorReport,
  getGrowthProfile,
  getKnowledgeBundle,
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

  const [loading, setLoading] = useState(true);
  const [researching, setResearching] = useState(false);
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

        const res = await authedPost<{ report: GrowthAdvisorReport }>("/api/ai/growth-advisor", {
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
        });

        setReport(res.report);
        await saveGrowthAdvisorReport(uid, res.report);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        runningRef.current = false;
        setResearching(false);
      }
    },
    [uid, profile, knowledgeDigest, settings, metricsSummary, metrics, analyticsInsight],
  );

  // Initial load of profile, knowledge, settings, metrics, and cached report
  useEffect(() => {
    let active = true;
    Promise.all([
      getGrowthProfile(uid),
      getKnowledgeBundle(uid),
      getSettings(uid),
      loadAnalyticsBundle(uid),
      listLeadIndex(uid),
      getGrowthAdvisorReport(uid),
    ])
      .then(([prof, kBundle, sett, analyticsData, leads, cachedReport]) => {
        if (!active) return;
        const digest = formatKnowledgeDigest(kBundle);
        // Helpful prefill from settings if profile has empty identity/location
        const hydratedProfile: GrowthProfile = {
          ...prof,
          whoYouAre: prof.whoYouAre || sett.sender_company || sett.sender_name || "",
          location: prof.location || sett.physical_address || "",
        };
        setProfile(hydratedProfile);
        setKnowledgeDigest(digest);
        setSettings(sett);
        setMetrics(analyticsData);
        setExistingEmails(leads.map((l) => l.email_norm || l.email || "").filter(Boolean));
        if (cachedReport) setReport(cachedReport);
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

  // Automatic background refresh when profile/data changes or report expires
  useEffect(() => {
    if (loading || !autoResearch) return;
    if (!completeness.complete) return;

    const insightKey = analyticsInsight ? analyticsInsight.headline : "";
    const insightChanged = Boolean(insightKey && insightKey !== lastInsightKeyRef.current);

    if (isReportStale(report, fingerprint) || insightChanged) {
      if (insightKey) lastInsightKeyRef.current = insightKey;
      void runResearch({ insightOverride: analyticsInsight });
    }
  }, [loading, autoResearch, completeness.complete, report, fingerprint, analyticsInsight, runResearch]);

  // Periodic background check every 30 minutes while open
  useEffect(() => {
    if (!autoResearch || !completeness.complete) return;
    const timer = window.setInterval(() => {
      if (isReportStale(report, fingerprint)) {
        void runResearch();
      }
    }, 30 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [autoResearch, completeness.complete, report, fingerprint, runResearch]);

  const updateProfile = useCallback(
    async (next: GrowthProfile, triggerResearch = true) => {
      setSavingProfile(true);
      setError(null);
      try {
        const saved = await saveGrowthProfile(uid, next);
        setProfile(saved);
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
    completeness,
    loading,
    researching,
    savingProfile,
    error,
    runResearch,
  };
}
