"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  BookOpen,
  Check,
  CheckCircle2,
  Edit3,
  FileUp,
  Globe,
  Loader2,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { BrandLoader } from "@/components/BrandLoader";
import { ImproveAnswerControl } from "@/components/ImproveAnswerControl";
import { Badge, Banner, Card, Field } from "@/components/ui";
import { useToast } from "@/components/Feedback";
import { authedPost, authedUpload, errorMessage } from "@/lib/client";
import {
  computeOnboardingCompleteness,
  DEFAULT_ONBOARDING_ANSWERS,
  normalizeUrlInput,
  prefillAnswersFromUser,
  validateUrlStrict,
  type KnowledgeSection,
  type MarketReach,
  type OnboardingAnswers,
  type OnboardingState,
  type PrimaryObjective,
  type StructuredKnowledgeBase,
  type WorkMode,
} from "@/lib/onboarding";
import type { WebsiteScanResult } from "@/lib/onboarding-server";
import {
  addKnowledgeSource,
  getOnboardingState,
  getSettings,
  getStructuredKnowledgeBase,
  saveGrowthProfile,
  saveOnboardingState,
  saveSettings,
  saveStructuredKnowledgeBase,
} from "@/lib/store";

const TOTAL_STEPS = 12;

const STEP_TITLES = [
  "Welcome",
  "About you",
  "Your business",
  "What you do",
  "Your offer",
  "Ideal customer",
  "Markets & locations",
  "Goals",
  "Marketing so far",
  "Brand & voice",
  "Online presence",
  "Review & generate",
];

const INDUSTRY_PRESETS = [
  "B2B Software / SaaS",
  "Digital Marketing & Web Agency",
  "Consulting & Professional Services",
  "Healthcare & Clinics",
  "Real Estate & Property",
  "Home & Local Services",
  "E-commerce & Retail",
  "Finance & Accounting",
  "Education & Training",
  "Manufacturing & Logistics",
];

const SERVICE_CHIPS = [
  "Website Design & Development",
  "SEO & Local Search",
  "Paid Ads Management",
  "B2B Lead Generation",
  "CRM & Automation Setup",
  "Software Engineering",
  "Branding & Creative",
  "Strategic Consulting",
  "Accounting / Fractional CFO",
  "Staffing & Recruiting",
];

const ICP_ROLE_CHIPS = [
  "Founder / Owner",
  "CEO / Managing Director",
  "VP / Head of Marketing",
  "Head of Sales / Growth",
  "Operations Director",
  "CTO / Head of Engineering",
  "Practice / Clinic Manager",
];

const TRIGGER_CHIPS = [
  "Hiring for growth roles",
  "Outdated or slow website",
  "Recent funding or expansion",
  "Launching a new product/location",
  "Low online reviews / visibility",
  "Switching agencies or tools",
];

const CHANNEL_CHIPS = [
  "Cold Email",
  "LinkedIn Outreach",
  "Referrals / Word of Mouth",
  "SEO & Content",
  "Google / Meta Ads",
  "Cold Calling",
  "Events & Conferences",
];

const TOOL_CHIPS = [
  "Google Workspace / Gmail",
  "HubSpot",
  "Salesforce",
  "Pipedrive",
  "Google Sheets",
  "Calendly",
  "Notion",
  "Slack",
];

const TONE_CHIPS = [
  "Calm & consultative",
  "Friendly & conversational",
  "Direct & concise",
  "Formal & executive",
  "Bold & confident",
  "Data-driven & analytical",
];

function toggleArrayItem(arr: string[], item: string): string[] {
  return arr.includes(item) ? arr.filter((x) => x !== item) : [...arr, item];
}

export default function OnboardingPage() {
  const router = useRouter();
  const { user } = useAuth();
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState(1);
  const [answers, setAnswers] = useState<OnboardingAnswers>(DEFAULT_ONBOARDING_ANSWERS);
  const [onboardingState, setOnboardingState] = useState<OnboardingState | null>(null);
  const [savingIndicator, setSavingIndicator] = useState<"idle" | "saving" | "saved">("idle");
  const [validationError, setValidationError] = useState<string | null>(null);

  // Website scanner states (Screen 3)
  const [scanningSite, setScanningSite] = useState(false);
  const [scanResult, setScanResult] = useState<WebsiteScanResult | null>(null);
  const [scanApply, setScanApply] = useState({
    businessName: true,
    description: true,
    industry: true,
    services: true,
    offer: true,
    location: true,
    socials: true,
  });

  // File / logo upload states (Screen 11)
  const [uploadingFile, setUploadingFile] = useState(false);

  // Screen 12 Generation & Preview states
  const [generatingKb, setGeneratingKb] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [previewSections, setPreviewSections] = useState<KnowledgeSection[] | null>(null);
  const [previewGaps, setPreviewGaps] = useState<string[]>([]);
  const [savingKb, setSavingKb] = useState(false);
  const [completedScreen, setCompletedScreen] = useState(false);

  const saveTimerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let active = true;
    getOnboardingState(user.uid, user)
      .then((state) => {
        if (!active) return;
        const hydrated = prefillAnswersFromUser(state.answers, user);
        setOnboardingState(state);
        setAnswers(hydrated);
        // Resume at saved screen if in progress
        if (state.status === "in_progress" && state.currentStep >= 1 && state.currentStep <= TOTAL_STEPS) {
          setStep(state.currentStep);
        } else {
          setStep(1);
        }
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setAnswers(prefillAnswersFromUser(DEFAULT_ONBOARDING_ANSWERS, user));
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [user]);

  const persistProgress = useCallback(
    async (nextStep: number, nextAnswers: OnboardingAnswers, statusOverride?: OnboardingState["status"]) => {
      setSavingIndicator("saving");
      try {
        const nextState: OnboardingState = {
          status: statusOverride ?? (onboardingState?.status === "completed" ? "completed" : "in_progress"),
          currentStep: nextStep,
          answers: nextAnswers,
          startedAt: onboardingState?.startedAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          completedAt: statusOverride === "completed" ? new Date().toISOString() : onboardingState?.completedAt,
        };
        const saved = await saveOnboardingState(user.uid, nextState);
        setOnboardingState(saved);
        setSavingIndicator("saved");
      } catch {
        setSavingIndicator("idle");
      }
    },
    [user.uid, onboardingState],
  );

  // Auto-save debounced when editing fields
  useEffect(() => {
    if (loading || completedScreen) return;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void persistProgress(step, answers);
    }, 900);
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, [answers, step, loading, completedScreen, persistProgress]);

  const setAnswer = <K extends keyof OnboardingAnswers>(key: K, value: OnboardingAnswers[K]) => {
    setValidationError(null);
    setAnswers((prev) => ({ ...prev, [key]: value }));
  };

  const validateCurrentStep = (targetStep: number): string | null => {
    if (targetStep === 2) {
      if (!answers.fullName.trim()) return "Please enter your full name (or click Skip for now).";
      if (!answers.email.trim()) return "Please enter your contact email.";
    }
    if (targetStep === 3) {
      if (!answers.businessName.trim()) return "Please enter your business name (or click Skip for now).";
      if (answers.website.trim() && !validateUrlStrict(answers.website)) {
        return "Please enter a valid website URL (e.g. https://yourcompany.com) or leave it blank.";
      }
    }
    if (targetStep === 4) {
      if (!answers.businessDescription.trim() && answers.mainServices.length === 0) {
        return "Describe what your business does or pick at least one service (or click Skip for now).";
      }
    }
    if (targetStep === 11) {
      const urls = [
        answers.linkedinUrl,
        answers.xUrl,
        answers.instagramUrl,
        answers.facebookUrl,
        answers.youtubeUrl,
        answers.tiktokUrl,
        answers.bookingOrPortfolioUrl,
      ];
      if (urls.some((u) => u.trim() && !validateUrlStrict(u))) {
        return "One of your social or portfolio links doesn't look like a valid URL (e.g. https://linkedin.com/...).";
      }
    }
    return null;
  };

  const goToStep = (nextStep: number, bypassValidation = false) => {
    if (!bypassValidation && nextStep > step) {
      const err = validateCurrentStep(step);
      if (err) {
        setValidationError(err);
        return;
      }
    }
    setValidationError(null);
    const bounded = Math.max(1, Math.min(TOTAL_STEPS, nextStep));
    setStep(bounded);
    void persistProgress(bounded, answers);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleScanWebsite = async () => {
    if (!validateUrlStrict(answers.website) || !answers.website.trim()) {
      setValidationError("Enter a valid website address (e.g. https://acme.com) before scanning.");
      return;
    }
    setScanningSite(true);
    setScanResult(null);
    setValidationError(null);
    try {
      const res = await authedPost<WebsiteScanResult>("/api/ai/onboarding-assist", {
        action: "scan_website",
        url: answers.website,
      });
      setScanResult(res);
    } catch (err) {
      setScanResult({
        found: false,
        note: errorMessage(err),
        businessName: "",
        description: "",
        industry: "",
        services: [],
        offer: "",
        location: "",
        socials: { linkedin: "", x: "", instagram: "", facebook: "", youtube: "", tiktok: "" },
      });
    } finally {
      setScanningSite(false);
    }
  };

  const handleApplyScanClean = () => {
    if (!scanResult || !scanResult.found) return;
    setAnswers((prev) => ({
      ...prev,
      businessName: scanApply.businessName && scanResult.businessName ? scanResult.businessName : prev.businessName,
      businessDescription:
        scanApply.description && scanResult.description ? scanResult.description : prev.businessDescription,
      industry: scanApply.industry && scanResult.industry ? scanResult.industry : prev.industry,
      mainServices:
        scanApply.services && scanResult.services.length > 0
          ? Array.from(new Set([...prev.mainServices, ...scanResult.services]))
          : prev.mainServices,
      differentiators: scanApply.offer && scanResult.offer ? scanResult.offer : prev.differentiators,
      businessLocation: scanApply.location && scanResult.location ? scanResult.location : prev.businessLocation,
      linkedinUrl: scanApply.socials && scanResult.socials.linkedin ? scanResult.socials.linkedin : prev.linkedinUrl,
      xUrl: scanApply.socials && scanResult.socials.x ? scanResult.socials.x : prev.xUrl,
      instagramUrl:
        scanApply.socials && scanResult.socials.instagram ? scanResult.socials.instagram : prev.instagramUrl,
      facebookUrl: scanApply.socials && scanResult.socials.facebook ? scanResult.socials.facebook : prev.facebookUrl,
      youtubeUrl: scanApply.socials && scanResult.socials.youtube ? scanResult.socials.youtube : prev.youtubeUrl,
      tiktokUrl: scanApply.socials && scanResult.socials.tiktok ? scanResult.socials.tiktok : prev.tiktokUrl,
    }));
    toast.success("Website details applied", "You can refine anything across the remaining steps.");
    setScanResult(null);
  };

  const handleFileUpload = async (files: FileList) => {
    setUploadingFile(true);
    try {
      for (const file of Array.from(files)) {
        if (file.type.startsWith("image/")) {
          const reader = new FileReader();
          reader.onload = () => {
            const url = String(reader.result ?? "");
            if (url.length < 300_000) {
              setAnswer("logoDataUrl", url);
              toast.success("Logo attached", file.name);
            }
          };
          reader.readAsDataURL(file);
        } else {
          const form = new FormData();
          form.append("file", file);
          const extracted = await authedUpload<{ label: string; text: string }>("/api/knowledge/extract", form);
          await addKnowledgeSource(user.uid, {
            label: extracted.label,
            kind: "document",
            content: extracted.text,
          });
          setAnswers((prev) => ({
            ...prev,
            uploadedSourceNames: Array.from(new Set([...prev.uploadedSourceNames, extracted.label])),
          }));
          toast.success("Document extracted", `${extracted.label} added to your Knowledge Base.`);
        }
      }
    } catch (err) {
      toast.error("File upload failed", errorMessage(err));
    } finally {
      setUploadingFile(false);
    }
  };

  const generateKnowledgePreview = async () => {
    setGeneratingKb(true);
    setGenError(null);
    try {
      const normalizedAnswers: OnboardingAnswers = {
        ...answers,
        website: normalizeUrlInput(answers.website),
        linkedinUrl: normalizeUrlInput(answers.linkedinUrl),
        xUrl: normalizeUrlInput(answers.xUrl),
        instagramUrl: normalizeUrlInput(answers.instagramUrl),
        facebookUrl: normalizeUrlInput(answers.facebookUrl),
        youtubeUrl: normalizeUrlInput(answers.youtubeUrl),
        tiktokUrl: normalizeUrlInput(answers.tiktokUrl),
        bookingOrPortfolioUrl: normalizeUrlInput(answers.bookingOrPortfolioUrl),
      };

      const res = await authedPost<{ sections: KnowledgeSection[]; missingGaps: string[] }>(
        "/api/ai/onboarding-assist",
        {
          action: "generate_kb",
          answers: normalizedAnswers,
        },
      );
      setPreviewSections(res.sections);
      setPreviewGaps(res.missingGaps ?? []);
    } catch (err) {
      setGenError(errorMessage(err));
    } finally {
      setGeneratingKb(false);
    }
  };

  const saveAndFinishOnboarding = async () => {
    if (!previewSections) return;
    setSavingKb(true);
    setGenError(null);
    try {
      const existingKb = await getStructuredKnowledgeBase(user.uid);
      const nowIso = new Date().toISOString();
      const nextKb: StructuredKnowledgeBase = {
        sections: previewSections,
        missingGaps: previewGaps,
        versions: existingKb?.versions ?? [],
        generatedAt: nowIso,
        updatedAt: nowIso,
      };

      await saveStructuredKnowledgeBase(user.uid, nextKb, "Generated from Onboarding Questionnaire");

      // Sync structured Growth Advisor profile & Settings automatically
      await saveGrowthProfile(user.uid, {
        whoYouAre: answers.businessName || answers.fullName,
        whatYouSell: answers.businessDescription || answers.mainServices.join(", "),
        industry: answers.industry,
        offer: answers.differentiators || answers.mainProblemSolved || answers.mainServices.join(", "),
        priceRange: answers.priceRange,
        location: answers.currentMarkets || answers.businessLocation,
        idealCustomer: answers.idealCustomerSummary || answers.icpRoles.join(", "),
      });

      const currentSettings = await getSettings(user.uid);
      await saveSettings(user.uid, {
        ...currentSettings,
        sender_name: answers.fullName || currentSettings.sender_name,
        sender_role: answers.roleTitle || currentSettings.sender_role,
        sender_company: answers.businessName || currentSettings.sender_company,
        sender_email: answers.email || currentSettings.sender_email,
        physical_address: answers.businessLocation || currentSettings.physical_address,
      });

      await persistProgress(TOTAL_STEPS, answers, "completed");
      setCompletedScreen(true);
      toast.success("Knowledge Base saved", "Your workspace is now personalized and ready.");
    } catch (err) {
      setGenError(errorMessage(err));
    } finally {
      setSavingKb(false);
    }
  };

  const completeness = useMemo(
    () => computeOnboardingCompleteness(answers),
    [answers],
  );

  if (loading) {
    return (
      <main className="page">
        <BrandLoader fullScreen />
      </main>
    );
  }

  if (completedScreen) {
    return (
      <main className="page" style={{ maxWidth: 820, margin: "0 auto" }}>
        <Card
          title="You're all set!"
          sub="Your personalized Knowledge Base is live across Growth Advisor, Analyse, Prospect Research, and Outreach."
        >
          <div className="stack" style={{ gap: 16 }}>
            <Banner tone="ok">
              <div className="row" style={{ gap: 10, alignItems: "center" }}>
                <CheckCircle2 size={20} style={{ color: "var(--teal-deep)", flexShrink: 0 }} />
                <div>
                  <div className="strong" style={{ fontSize: 14.5 }}>
                    Knowrevo now understands {answers.businessName || answers.fullName || "your business"}
                  </div>
                  <div className="tiny">
                    Profile completeness: <strong>{completeness.score}%</strong> · Generated{" "}
                    <strong>{previewSections?.length ?? 10} Knowledge Base sections</strong>.
                  </div>
                </div>
              </div>
            </Banner>

            <div className="grid grid-2" style={{ gap: 12 }}>
              <div style={{ padding: 12, borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface-2)" }}>
                <div className="tiny muted">Business & Industry</div>
                <div className="strong">{answers.businessName || "Not provided"}</div>
                <div className="tiny">{answers.industry || "Industry not specified"} · {answers.businessLocation || "Location not specified"}</div>
              </div>
              <div style={{ padding: 12, borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface-2)" }}>
                <div className="tiny muted">Core Offer & Price Range</div>
                <div className="strong">{answers.priceRange || "Not provided"}</div>
                <div className="tiny">{answers.mainServices.slice(0, 3).join(", ") || "See Business overview"}</div>
              </div>
              <div style={{ padding: 12, borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface-2)" }}>
                <div className="tiny muted">Ideal Customer & Markets</div>
                <div className="strong">{answers.icpRoles.slice(0, 2).join(", ") || answers.idealCustomerSummary || "Defined"}</div>
                <div className="tiny">{answers.currentMarkets || answers.marketReach.join(", ") || "Markets saved"}</div>
              </div>
              <div style={{ padding: 12, borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface-2)" }}>
                <div className="tiny muted">Brand Voice & Goal</div>
                <div className="strong">{answers.brandTones.join(", ") || "Professional"}</div>
                <div className="tiny">{answers.primaryObjective ? `Goal: ${answers.targetNumber} ${answers.targetMetricLabel}` : "Ready to launch"}</div>
              </div>
            </div>

            {previewGaps.length > 0 && (
              <Banner tone="warn">
                <div className="tiny">
                  <strong>Optional gaps noted:</strong> {previewGaps.slice(0, 4).join(" · ")}. You can fill these in
                  anytime from the Knowledge Base page.
                </div>
              </Banner>
            )}

            <div className="stack" style={{ gap: 10, paddingTop: 6 }}>
              <div className="strong" style={{ fontSize: 13 }}>Suggested next steps:</div>
              <div className="grid grid-2" style={{ gap: 10 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ justifyContent: "center" }}
                  onClick={() => router.push("/")}
                >
                  Go to Dashboard
                  <ArrowRight size={14} />
                </button>
                <Link href="/growth-advisor" className="btn" style={{ justifyContent: "center" }}>
                  <TrendingUp size={14} />
                  Open Growth Advisor
                </Link>
                <Link href="/analytics" className="btn" style={{ justifyContent: "center" }}>
                  <BarChart3 size={14} />
                  Run your first analysis
                </Link>
                <Link href="/knowledge" className="btn btn-ghost" style={{ justifyContent: "center" }}>
                  <BookOpen size={14} />
                  Review Knowledge Base
                </Link>
              </div>
            </div>
          </div>
        </Card>
      </main>
    );
  }

  return (
    <main className="page" style={{ maxWidth: 820, margin: "0 auto" }}>
      {/* Top Progress Header */}
      <div className="stack" style={{ gap: 10, marginBottom: 18 }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <Badge tone="info">Step {step} of {TOTAL_STEPS}</Badge>
            <span className="strong" style={{ fontSize: 14 }}>{STEP_TITLES[step - 1]}</span>
          </div>
          <div className="row" style={{ gap: 10, alignItems: "center" }}>
            <span className="tiny muted">
              {savingIndicator === "saving"
                ? "Auto-saving…"
                : savingIndicator === "saved"
                  ? "Progress saved"
                  : ""}
            </span>
            {onboardingState?.status === "completed" && (
              <Link href="/" className="btn btn-sm btn-ghost">
                Back to dashboard
              </Link>
            )}
          </div>
        </div>

        {/* Visual Progress Bar */}
        <div
          role="progressbar"
          aria-valuenow={step}
          aria-valuemin={1}
          aria-valuemax={TOTAL_STEPS}
          style={{
            height: 7,
            width: "100%",
            borderRadius: 999,
            background: "var(--surface-2)",
            overflow: "hidden",
            border: "1px solid var(--line-soft)",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${Math.round((step / TOTAL_STEPS) * 100)}%`,
              background: "var(--teal-deep, #0f766e)",
              transition: "width 0.25s ease",
            }}
          />
        </div>
      </div>

      {validationError && (
        <div style={{ marginBottom: 14 }}>
          <Banner tone="bad">{validationError}</Banner>
        </div>
      )}

      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, x: 14 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -14 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
        >
          {/* SCREEN 1: WELCOME */}
          {step === 1 && (
            <Card
              title="Welcome to Knowrevo"
              sub="Let's teach the system who you are and what you do in a few quick steps."
            >
              <div className="stack" style={{ gap: 14 }}>
                <div
                  className="row"
                  style={{
                    gap: 12,
                    padding: 14,
                    borderRadius: 12,
                    border: "1px solid var(--line)",
                    background: "var(--surface-2)",
                  }}
                >
                  {answers.photoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={answers.photoUrl}
                      alt={answers.fullName || "Google profile"}
                      style={{ width: 46, height: 46, borderRadius: "50%", objectFit: "cover" }}
                    />
                  ) : null}
                  <div>
                    <div className="strong" style={{ fontSize: 14.5 }}>
                      Hi {answers.fullName || "there"}!
                    </div>
                    <div className="tiny muted">Signed in via Google as {answers.email}</div>
                  </div>
                </div>

                <p style={{ margin: 0, fontSize: 13.8, lineHeight: 1.6 }}>
                  Over the next 11 short screens, we&apos;ll learn about your business, offer, ideal customers, target
                  markets, and voice. When you finish, Knowrevo automatically writes a structured{" "}
                  <strong>Knowledge Base</strong> that powers:
                </p>
                <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13.4, lineHeight: 1.65 }}>
                  <li><strong>Growth Advisor:</strong> Personalized internet research & winning outreach angles.</li>
                  <li><strong>Prospect Research & Qualification:</strong> Accurate scoring against your real criteria.</li>
                  <li><strong>Campaign Builder & Replies:</strong> Outreach written strictly in your voice, using only your real facts.</li>
                </ul>

                <Banner tone="info">
                  <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                    <ShieldCheck size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                    <span className="tiny">
                      <strong>Your data stays yours:</strong> Answers are auto-saved privately to your Supabase workspace
                      under your Google account. You can skip optional questions, edit anything later, or delete all data
                      anytime from Settings or Knowledge Base.
                    </span>
                  </div>
                </Banner>
              </div>
            </Card>
          )}

          {/* SCREEN 2: ABOUT YOU */}
          {step === 2 && (
            <Card title="About you" sub="We pre-filled your details from Google — adjust anything you'd like.">
              <div className="stack" style={{ gap: 14 }}>
                <div className="row" style={{ gap: 12, alignItems: "center" }}>
                  {answers.photoUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={answers.photoUrl}
                      alt="Profile avatar"
                      style={{ width: 52, height: 52, borderRadius: "50%", objectFit: "cover", border: "1px solid var(--line)" }}
                    />
                  )}
                  <div style={{ flex: 1 }}>
                    <Field label="Profile photo URL (optional)" hint="Pre-filled from your Google account">
                      <input
                        className="input"
                        value={answers.photoUrl}
                        onChange={(e) => setAnswer("photoUrl", e.target.value)}
                        placeholder="https://..."
                      />
                    </Field>
                  </div>
                </div>

                <div className="grid grid-2" style={{ gap: 12 }}>
                  <Field label="Full name *" hint="How you sign emails and appear on your workspace">
                    <input
                      className="input"
                      value={answers.fullName}
                      onChange={(e) => setAnswer("fullName", e.target.value)}
                      placeholder="e.g. Jordan Taylor"
                    />
                  </Field>
                  <Field label="Email address *" hint="Pre-filled from Google; editable for replies/sender display">
                    <input
                      className="input"
                      type="email"
                      value={answers.email}
                      onChange={(e) => setAnswer("email", e.target.value)}
                      placeholder="jordan@company.com"
                    />
                  </Field>
                </div>

                <Field label="Your role / job title" hint="e.g. Founder, Managing Partner, Head of Growth">
                  <input
                    className="input"
                    value={answers.roleTitle}
                    onChange={(e) => setAnswer("roleTitle", e.target.value)}
                    placeholder="e.g. Founder & Principal Consultant"
                  />
                </Field>

                <div>
                  <div className="label" style={{ marginBottom: 6 }}>How do you work?</div>
                  <div className="grid grid-3" style={{ gap: 10 }}>
                    {(
                      [
                        ["solo", "Solo operator", "Just me running outreach & sales"],
                        ["team", "In-house team", "Growing an internal company"],
                        ["agency", "At an agency", "Serving multiple client businesses"],
                      ] as [WorkMode, string, string][]
                    ).map(([mode, title, desc]) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setAnswer("workMode", mode)}
                        style={{
                          textAlign: "left",
                          padding: 12,
                          borderRadius: 10,
                          border: `1.5px solid ${answers.workMode === mode ? "var(--teal-deep, #0f766e)" : "var(--line)"}`,
                          background: answers.workMode === mode ? "var(--accent-soft, rgba(15,118,110,0.08))" : "var(--surface)",
                          cursor: "pointer",
                        }}
                      >
                        <div className="strong" style={{ fontSize: 13 }}>{title}</div>
                        <div className="tiny muted">{desc}</div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </Card>
          )}

          {/* SCREEN 3: YOUR BUSINESS + WEBSITE SCANNER */}
          {step === 3 && (
            <Card title="Your business" sub="Tell us about your company — or scan your website to pre-fill automatically.">
              <div className="stack" style={{ gap: 14 }}>
                <div className="grid grid-2" style={{ gap: 12 }}>
                  <Field label="Business name *" hint="The brand name prospects will recognize">
                    <input
                      className="input"
                      value={answers.businessName}
                      onChange={(e) => setAnswer("businessName", e.target.value)}
                      placeholder="e.g. Northstar Digital Studio"
                    />
                  </Field>
                  <Field label="Industry *" hint="Pick a category or type your own">
                    <input
                      className="input"
                      list="industry-presets"
                      value={answers.industry}
                      onChange={(e) => setAnswer("industry", e.target.value)}
                      placeholder="e.g. Digital Marketing & Web Agency"
                    />
                    <datalist id="industry-presets">
                      {INDUSTRY_PRESETS.map((ind) => (
                        <option key={ind} value={ind} />
                      ))}
                    </datalist>
                  </Field>
                </div>

                {/* Optional Website Prefill */}
                <div
                  style={{
                    padding: 12,
                    borderRadius: 10,
                    border: "1px solid var(--line)",
                    background: "var(--surface-2)",
                  }}
                >
                  <Field
                    label="Company website (optional)"
                    hint="Enter your URL and click Scan website to extract your description, services, and social links."
                  >
                    <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                      <input
                        className="input"
                        style={{ flex: 1, minWidth: 220 }}
                        value={answers.website}
                        onChange={(e) => setAnswer("website", e.target.value)}
                        placeholder="https://yourcompany.com"
                      />
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void handleScanWebsite()}
                        disabled={scanningSite || !answers.website.trim()}
                      >
                        {scanningSite ? <Loader2 size={13} className="spin" /> : <Globe size={13} />}
                        {scanningSite ? "Scanning…" : "Scan website"}
                      </button>
                    </div>
                  </Field>

                  {scanResult && (
                    <div style={{ marginTop: 10 }}>
                      {!scanResult.found ? (
                        <Banner tone="warn">{scanResult.note}</Banner>
                      ) : (
                        <div
                          style={{
                            padding: 12,
                            borderRadius: 10,
                            border: "1px solid var(--teal-deep)",
                            background: "var(--surface)",
                          }}
                        >
                          <div className="strong tiny" style={{ color: "var(--teal-deep)", marginBottom: 8 }}>
                            {scanResult.note}
                          </div>
                          <div className="stack" style={{ gap: 6, fontSize: 12.5 }}>
                            {scanResult.businessName && (
                              <label className="row" style={{ gap: 8 }}>
                                <input
                                  type="checkbox"
                                  checked={scanApply.businessName}
                                  onChange={(e) => setScanApply({ ...scanApply, businessName: e.target.checked })}
                                />
                                <span><strong>Business name:</strong> {scanResult.businessName}</span>
                              </label>
                            )}
                            {scanResult.industry && (
                              <label className="row" style={{ gap: 8 }}>
                                <input
                                  type="checkbox"
                                  checked={scanApply.industry}
                                  onChange={(e) => setScanApply({ ...scanApply, industry: e.target.checked })}
                                />
                                <span><strong>Industry:</strong> {scanResult.industry}</span>
                              </label>
                            )}
                            {scanResult.description && (
                              <label className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                                <input
                                  type="checkbox"
                                  checked={scanApply.description}
                                  onChange={(e) => setScanApply({ ...scanApply, description: e.target.checked })}
                                />
                                <span><strong>Description:</strong> {scanResult.description}</span>
                              </label>
                            )}
                            {scanResult.services.length > 0 && (
                              <label className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                                <input
                                  type="checkbox"
                                  checked={scanApply.services}
                                  onChange={(e) => setScanApply({ ...scanApply, services: e.target.checked })}
                                />
                                <span><strong>Services:</strong> {scanResult.services.join(", ")}</span>
                              </label>
                            )}
                            {Object.values(scanResult.socials).some(Boolean) && (
                              <label className="row" style={{ gap: 8 }}>
                                <input
                                  type="checkbox"
                                  checked={scanApply.socials}
                                  onChange={(e) => setScanApply({ ...scanApply, socials: e.target.checked })}
                                />
                                <span>
                                  <strong>Social links found:</strong>{" "}
                                  {Object.entries(scanResult.socials)
                                    .filter(([, u]) => Boolean(u))
                                    .map(([k]) => k)
                                    .join(", ")}
                                </span>
                              </label>
                            )}
                          </div>
                          <div className="row" style={{ gap: 8, marginTop: 10 }}>
                            <button type="button" className="btn btn-primary btn-sm" onClick={handleApplyScanClean}>
                              <Check size={12} />
                              Confirm & apply selected
                            </button>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setScanResult(null)}>
                              Dismiss
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="grid grid-3" style={{ gap: 12 }}>
                  <Field label="Year started" hint="Helps establish credibility">
                    <input
                      className="input"
                      type="number"
                      min={1900}
                      max={new Date().getFullYear()}
                      value={answers.yearStarted}
                      onChange={(e) => setAnswer("yearStarted", e.target.value)}
                      placeholder="e.g. 2021"
                    />
                  </Field>
                  <Field label="Company size" hint="Current headcount">
                    <select
                      className="input"
                      value={answers.companySize}
                      onChange={(e) => setAnswer("companySize", e.target.value)}
                    >
                      <option value="">Select size…</option>
                      <option value="Just me (1)">Just me (1)</option>
                      <option value="2–10 people">2–10 people</option>
                      <option value="11–50 people">11–50 people</option>
                      <option value="51–200 people">51–200 people</option>
                      <option value="200+ people">200+ people</option>
                    </select>
                  </Field>
                  <Field label="Business location" hint="City, State/Country (used in email compliance footer)">
                    <input
                      className="input"
                      value={answers.businessLocation}
                      onChange={(e) => setAnswer("businessLocation", e.target.value)}
                      placeholder="e.g. Austin, TX, USA"
                    />
                  </Field>
                </div>
              </div>
            </Card>
          )}

          {/* SCREEN 4: WHAT YOU DO */}
          {step === 4 && (
            <Card title="What you do" sub="Explain your work in plain English — no jargon needed.">
              <div className="stack" style={{ gap: 14 }}>
                <Field
                  label="Plain-language description of your business *"
                  hint="How would you describe what you do to a smart friend?"
                >
                  <textarea
                    className="input"
                    rows={4}
                    value={answers.businessDescription}
                    onChange={(e) => setAnswer("businessDescription", e.target.value)}
                    placeholder="e.g. We design fast, mobile-ready websites and automated booking funnels for local healthcare clinics so they turn Google searchers into booked patients."
                  />
                  <ImproveAnswerControl
                    questionTitle="Plain-language description of the business"
                    value={answers.businessDescription}
                    businessContext={`${answers.businessName} (${answers.industry})`}
                    onAccept={(improved) => setAnswer("businessDescription", improved)}
                  />
                </Field>

                <div>
                  <div className="label" style={{ marginBottom: 6 }}>Main products or services</div>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                    {SERVICE_CHIPS.map((svc) => {
                      const active = answers.mainServices.includes(svc);
                      return (
                        <button
                          key={svc}
                          type="button"
                          className={`btn btn-sm ${active ? "btn-primary" : ""}`}
                          onClick={() => setAnswer("mainServices", toggleArrayItem(answers.mainServices, svc))}
                        >
                          {svc}
                        </button>
                      );
                    })}
                  </div>
                  <div className="row" style={{ gap: 8 }}>
                    <input
                      className="input"
                      value={answers.customServiceInput}
                      onChange={(e) => setAnswer("customServiceInput", e.target.value)}
                      placeholder="Add another custom service or product and press Add"
                    />
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={!answers.customServiceInput.trim()}
                      onClick={() => {
                        const val = answers.customServiceInput.trim();
                        if (!val) return;
                        setAnswers((prev) => ({
                          ...prev,
                          mainServices: Array.from(new Set([...prev.mainServices, val])),
                          customServiceInput: "",
                        }));
                      }}
                    >
                      Add
                    </button>
                  </div>
                </div>

                <Field
                  label="What is the main problem you solve?"
                  hint="The urgent pain point that makes buyers pay you"
                >
                  <textarea
                    className="input"
                    rows={3}
                    value={answers.mainProblemSolved}
                    onChange={(e) => setAnswer("mainProblemSolved", e.target.value)}
                    placeholder="e.g. Clinics spend thousands on ads, but lose 40% of inquiries because their site is slow on phones and takes days to reply."
                  />
                  <ImproveAnswerControl
                    questionTitle="Main problem solved"
                    value={answers.mainProblemSolved}
                    businessContext={answers.businessDescription}
                    onAccept={(improved) => setAnswer("mainProblemSolved", improved)}
                  />
                </Field>
              </div>
            </Card>
          )}

          {/* SCREEN 5: YOUR OFFER */}
          {step === 5 && (
            <Card title="Your offer" sub="Pricing, proof, and what sets you apart from everyone else.">
              <div className="stack" style={{ gap: 14 }}>
                <Field
                  label="Pricing or typical price range"
                  hint="Helps Growth Advisor match prospects with realistic budgets"
                >
                  <input
                    className="input"
                    value={answers.priceRange}
                    onChange={(e) => setAnswer("priceRange", e.target.value)}
                    placeholder="e.g. $2,500–$6,000 one-time project, or $1,500/month retainer"
                  />
                </Field>

                <Field
                  label="What makes you different from competitors?"
                  hint="Why should a buyer pick you instead of a cheaper or bigger alternative?"
                >
                  <textarea
                    className="input"
                    rows={3}
                    value={answers.differentiators}
                    onChange={(e) => setAnswer("differentiators", e.target.value)}
                    placeholder="e.g. Delivered in 14 days instead of 3 months, fixed transparent pricing, and zero long-term lock-in."
                  />
                  <ImproveAnswerControl
                    questionTitle="Competitor differentiators"
                    value={answers.differentiators}
                    businessContext={answers.businessDescription}
                    onAccept={(improved) => setAnswer("differentiators", improved)}
                  />
                </Field>

                <Field
                  label="Proof (results, testimonials, case studies, awards)"
                  hint="Real verified outcomes only — leave blank if you're brand new"
                >
                  <textarea
                    className="input"
                    rows={3}
                    value={answers.proof}
                    onChange={(e) => setAnswer("proof", e.target.value)}
                    placeholder="e.g. Helped 18 clinics increase online bookings by an average of 32% within 60 days; 4.9-star rating on Google."
                  />
                  <ImproveAnswerControl
                    questionTitle="Proof and case studies"
                    value={answers.proof}
                    businessContext={answers.businessDescription}
                    onAccept={(improved) => setAnswer("proof", improved)}
                  />
                </Field>

                <div
                  style={{
                    padding: 12,
                    borderRadius: 10,
                    border: "1px solid var(--line)",
                    background: "var(--surface-2)",
                  }}
                >
                  <label className="row" style={{ gap: 8, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={answers.hasGuarantee}
                      onChange={(e) => setAnswer("hasGuarantee", e.target.checked)}
                    />
                    <span className="strong" style={{ fontSize: 13 }}>
                      We offer a risk-reversal or service guarantee
                    </span>
                  </label>
                  {answers.hasGuarantee && (
                    <div style={{ marginTop: 10 }}>
                      <Field label="Guarantee terms" hint="State clearly what you guarantee">
                        <input
                          className="input"
                          value={answers.guaranteeDetails}
                          onChange={(e) => setAnswer("guaranteeDetails", e.target.value)}
                          placeholder="e.g. If we miss our 14-day launch deadline, your final 50% milestone is free."
                        />
                      </Field>
                    </div>
                  )}
                </div>
              </div>
            </Card>
          )}

          {/* SCREEN 6: IDEAL CUSTOMER */}
          {step === 6 && (
            <Card title="Your ideal customer" sub="Who buys your best work — and who should we filter OUT?">
              <div className="stack" style={{ gap: 14 }}>
                <Field
                  label="Describe your ideal customer"
                  hint="The exact type of company that gets huge ROI from you and pays happily"
                >
                  <input
                    className="input"
                    value={answers.idealCustomerSummary}
                    onChange={(e) => setAnswer("idealCustomerSummary", e.target.value)}
                    placeholder="e.g. Established private dental & physio clinics with 2–15 staff looking to grow local bookings"
                  />
                </Field>

                <div>
                  <div className="label" style={{ marginBottom: 6 }}>Decision-maker roles who buy from you</div>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    {ICP_ROLE_CHIPS.map((role) => {
                      const active = answers.icpRoles.includes(role);
                      return (
                        <button
                          key={role}
                          type="button"
                          className={`btn btn-sm ${active ? "btn-primary" : ""}`}
                          onClick={() => setAnswer("icpRoles", toggleArrayItem(answers.icpRoles, role))}
                        >
                          {role}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="grid grid-2" style={{ gap: 12 }}>
                  <Field label="Target company size" hint="Ideal buyer headcount">
                    <select
                      className="input"
                      value={answers.icpCompanySize}
                      onChange={(e) => setAnswer("icpCompanySize", e.target.value)}
                    >
                      <option value="">Any size…</option>
                      <option value="Solo / 1–5 staff">Solo / 1–5 staff</option>
                      <option value="6–25 staff">6–25 staff</option>
                      <option value="26–100 staff">26–100 staff</option>
                      <option value="100–500 staff">100–500 staff</option>
                      <option value="500+ Enterprise">500+ Enterprise</option>
                    </select>
                  </Field>
                  <Field label="Target buyer location" hint="Where ideal buyers sit">
                    <input
                      className="input"
                      value={answers.icpLocation}
                      onChange={(e) => setAnswer("icpLocation", e.target.value)}
                      placeholder="e.g. Texas, Florida, or UK metro areas"
                    />
                  </Field>
                </div>

                <div>
                  <div className="label" style={{ marginBottom: 6 }}>Buying triggers (signals they are ready to buy)</div>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    {TRIGGER_CHIPS.map((trig) => {
                      const active = answers.icpBuyingTriggers.includes(trig);
                      return (
                        <button
                          key={trig}
                          type="button"
                          className={`btn btn-sm ${active ? "btn-primary" : ""}`}
                          onClick={() => setAnswer("icpBuyingTriggers", toggleArrayItem(answers.icpBuyingTriggers, trig))}
                        >
                          {trig}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <Field label="Their biggest pain points" hint="What frustrates them daily before meeting you?">
                  <textarea
                    className="input"
                    rows={3}
                    value={answers.icpPainPoints}
                    onChange={(e) => setAnswer("icpPainPoints", e.target.value)}
                    placeholder="e.g. Empty appointment slots mid-week, relying only on referrals, agency burnout."
                  />
                  <ImproveAnswerControl
                    questionTitle="Ideal customer pain points"
                    value={answers.icpPainPoints}
                    onAccept={(improved) => setAnswer("icpPainPoints", improved)}
                  />
                </Field>

                <Field
                  label="Who is NOT a good fit (Exclusions)"
                  hint="We strictly filter these businesses out during research & qualification"
                >
                  <textarea
                    className="input"
                    rows={2}
                    value={answers.icpExclusions}
                    onChange={(e) => setAnswer("icpExclusions", e.target.value)}
                    placeholder="e.g. Pre-revenue startups with zero budget, businesses wanting free spec work, or dropshippers."
                  />
                </Field>
              </div>
            </Card>
          )}

          {/* SCREEN 7: MARKETS & LOCATIONS */}
          {step === 7 && (
            <Card title="Markets and locations" sub="Where you currently win deals and where you want to expand next.">
              <div className="stack" style={{ gap: 14 }}>
                <div>
                  <div className="label" style={{ marginBottom: 6 }}>Client geographic scope (select all that apply)</div>
                  <div className="grid grid-3" style={{ gap: 10 }}>
                    {(
                      [
                        ["local", "Local", "City or metro area"],
                        ["national", "National", "Across your country"],
                        ["international", "International", "Cross-border / global"],
                      ] as [MarketReach, string, string][]
                    ).map(([reach, title, desc]) => {
                      const active = answers.marketReach.includes(reach);
                      return (
                        <button
                          key={reach}
                          type="button"
                          onClick={() =>
                            setAnswer(
                              "marketReach",
                              active
                                ? answers.marketReach.filter((x) => x !== reach)
                                : [...answers.marketReach, reach],
                            )
                          }
                          style={{
                            textAlign: "left",
                            padding: 12,
                            borderRadius: 10,
                            border: `1.5px solid ${active ? "var(--teal-deep, #0f766e)" : "var(--line)"}`,
                            background: active ? "var(--accent-soft, rgba(15,118,110,0.08))" : "var(--surface)",
                            cursor: "pointer",
                          }}
                        >
                          <div className="strong" style={{ fontSize: 13 }}>{title}</div>
                          <div className="tiny muted">{desc}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <Field label="Where you sell right now" hint="Cities, states, or countries with existing clients">
                  <input
                    className="input"
                    value={answers.currentMarkets}
                    onChange={(e) => setAnswer("currentMarkets", e.target.value)}
                    placeholder="e.g. Austin, Houston, and San Antonio"
                  />
                </Field>

                <Field label="Where you want to grow next" hint="Priority expansion markets for Growth Advisor to research">
                  <input
                    className="input"
                    value={answers.expansionMarkets}
                    onChange={(e) => setAnswer("expansionMarkets", e.target.value)}
                    placeholder="e.g. Dallas-Fort Worth, Phoenix, Denver"
                  />
                </Field>
              </div>
            </Card>
          )}

          {/* SCREEN 8: GOALS */}
          {step === 8 && (
            <Card title="Your goals" sub="What success looks like so we prioritise the right campaigns.">
              <div className="stack" style={{ gap: 14 }}>
                <div>
                  <div className="label" style={{ marginBottom: 6 }}>Main objective</div>
                  <div className="grid grid-2" style={{ gap: 10 }}>
                    {(
                      [
                        ["leads", "More qualified leads", "Build a warm pipeline of decision makers"],
                        ["bookings", "Booked meetings / calls", "Fill your calendar with discovery calls"],
                        ["sales", "Direct sales / closed deals", "Short-cycle deals and direct conversions"],
                        ["awareness", "Market presence & partnerships", "Strategic intros and brand reach"],
                      ] as [PrimaryObjective, string, string][]
                    ).map(([obj, title, desc]) => (
                      <button
                        key={obj}
                        type="button"
                        onClick={() => setAnswer("primaryObjective", obj)}
                        style={{
                          textAlign: "left",
                          padding: 12,
                          borderRadius: 10,
                          border: `1.5px solid ${answers.primaryObjective === obj ? "var(--teal-deep, #0f766e)" : "var(--line)"}`,
                          background: answers.primaryObjective === obj ? "var(--accent-soft, rgba(15,118,110,0.08))" : "var(--surface)",
                          cursor: "pointer",
                        }}
                      >
                        <div className="strong" style={{ fontSize: 13 }}>{title}</div>
                        <div className="tiny muted">{desc}</div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-2" style={{ gap: 12 }}>
                  <Field
                    label={`Monthly target: ${answers.targetNumber} ${answers.targetMetricLabel}`}
                    hint="Drag slider to match your realistic monthly target"
                  >
                    <input
                      type="range"
                      min={1}
                      max={200}
                      value={answers.targetNumber}
                      onChange={(e) => setAnswer("targetNumber", Number(e.target.value))}
                    />
                    <input
                      className="input"
                      style={{ marginTop: 6 }}
                      value={answers.targetMetricLabel}
                      onChange={(e) => setAnswer("targetMetricLabel", e.target.value)}
                      placeholder="e.g. booked discovery calls / month"
                    />
                  </Field>

                  <Field label="Target timeline" hint="Horizon for hitting this milestone">
                    <select
                      className="input"
                      value={answers.timeline}
                      onChange={(e) => setAnswer("timeline", e.target.value)}
                    >
                      <option value="30 days">Next 30 days</option>
                      <option value="90 days">Next 90 days</option>
                      <option value="6 months">Next 6 months</option>
                      <option value="12 months">Next 12 months</option>
                    </select>
                  </Field>
                </div>

                <Field
                  label={`Monthly growth & outreach budget: $${answers.monthlyBudget.toLocaleString()}/mo`}
                  hint="Helps recommendations avoid unaffordable paid channels"
                >
                  <input
                    type="range"
                    min={0}
                    max={25000}
                    step={250}
                    value={answers.monthlyBudget}
                    onChange={(e) => setAnswer("monthlyBudget", Number(e.target.value))}
                  />
                </Field>
              </div>
            </Card>
          )}

          {/* SCREEN 9: MARKETING SO FAR */}
          {step === 9 && (
            <Card title="Marketing so far" sub="What you have already tried so we double down on winners and skip duds.">
              <div className="stack" style={{ gap: 14 }}>
                <div>
                  <div className="label" style={{ marginBottom: 6 }}>Channels you have used</div>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    {CHANNEL_CHIPS.map((ch) => (
                      <button
                        key={ch}
                        type="button"
                        className={`btn btn-sm ${answers.channelsUsed.includes(ch) ? "btn-primary" : ""}`}
                        onClick={() => setAnswer("channelsUsed", toggleArrayItem(answers.channelsUsed, ch))}
                      >
                        {ch}
                      </button>
                    ))}
                  </div>
                </div>

                <Field label="What has worked best so far?" hint="Campaigns, messages, or referral sources that brought real revenue">
                  <textarea
                    className="input"
                    rows={3}
                    value={answers.whatWorked}
                    onChange={(e) => setAnswer("whatWorked", e.target.value)}
                    placeholder="e.g. Personalized cold emails pointing out a broken mobile page got a 14% reply rate."
                  />
                  <ImproveAnswerControl
                    questionTitle="What marketing has worked well"
                    value={answers.whatWorked}
                    onAccept={(improved) => setAnswer("whatWorked", improved)}
                  />
                </Field>

                <Field label="What hasn't worked?" hint="So Growth Advisor avoids recommending wasted effort">
                  <textarea
                    className="input"
                    rows={3}
                    value={answers.whatDidntWork}
                    onChange={(e) => setAnswer("whatDidntWork", e.target.value)}
                    placeholder="e.g. Broad LinkedIn ads burned $2k with zero qualified demos; generic newsletters got ignored."
                  />
                  <ImproveAnswerControl
                    questionTitle="What marketing hasn't worked"
                    value={answers.whatDidntWork}
                    onAccept={(improved) => setAnswer("whatDidntWork", improved)}
                  />
                </Field>

                <div>
                  <div className="label" style={{ marginBottom: 6 }}>Tools currently in use</div>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    {TOOL_CHIPS.map((tool) => (
                      <button
                        key={tool}
                        type="button"
                        className={`btn btn-sm ${answers.toolsInUse.includes(tool) ? "btn-primary" : ""}`}
                        onClick={() => setAnswer("toolsInUse", toggleArrayItem(answers.toolsInUse, tool))}
                      >
                        {tool}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </Card>
          )}

          {/* SCREEN 10: BRAND & VOICE */}
          {step === 10 && (
            <Card title="Brand and voice" sub="How your emails and AI drafts should sound when talking to buyers.">
              <div className="stack" style={{ gap: 14 }}>
                <div>
                  <div className="label" style={{ marginBottom: 6 }}>Preferred communication tone</div>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    {TONE_CHIPS.map((tone) => (
                      <button
                        key={tone}
                        type="button"
                        className={`btn btn-sm ${answers.brandTones.includes(tone) ? "btn-primary" : ""}`}
                        onClick={() => setAnswer("brandTones", toggleArrayItem(answers.brandTones, tone))}
                      >
                        {tone}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-2" style={{ gap: 12 }}>
                  <Field label="Words or phrases to USE" hint="Signature phrases or terms your buyers resonate with">
                    <input
                      className="input"
                      value={answers.wordsToUse}
                      onChange={(e) => setAnswer("wordsToUse", e.target.value)}
                      placeholder="e.g. patient retention, booked calendar, transparent scope"
                    />
                  </Field>
                  <Field label="Words or phrases to AVOID" hint="AI clichés or banned words">
                    <input
                      className="input"
                      value={answers.wordsToAvoid}
                      onChange={(e) => setAnswer("wordsToAvoid", e.target.value)}
                      placeholder='e.g. "revolutionary", "synergy", "hope this finds you well"'
                    />
                  </Field>
                </div>

                <Field label="Sample outreach message or style example (optional)" hint="Paste a past email or message you love so the AI matches your style">
                  <textarea
                    className="input"
                    rows={4}
                    value={answers.sampleMessages}
                    onChange={(e) => setAnswer("sampleMessages", e.target.value)}
                    placeholder={`Hi Dr. Lee,\n\nI noticed your clinic's booking page takes 6 clicks on mobile. We helped Harbor Dental fix the exact same drop-off in 2 weeks...\n\nWorth sending a 2-minute teardown?`}
                  />
                  <ImproveAnswerControl
                    questionTitle="Sample brand message"
                    value={answers.sampleMessages}
                    onAccept={(improved) => setAnswer("sampleMessages", improved)}
                  />
                </Field>
              </div>
            </Card>
          )}

          {/* SCREEN 11: ONLINE PRESENCE & FILES */}
          {step === 11 && (
            <Card title="Online presence & materials" sub="Links and optional docs or logo to ground your brand profile.">
              <div className="stack" style={{ gap: 14 }}>
                <div className="grid grid-2" style={{ gap: 12 }}>
                  <Field label="LinkedIn URL">
                    <input
                      className="input"
                      value={answers.linkedinUrl}
                      onChange={(e) => setAnswer("linkedinUrl", e.target.value)}
                      placeholder="https://linkedin.com/company/yourcompany"
                    />
                  </Field>
                  <Field label="X (Twitter) URL">
                    <input
                      className="input"
                      value={answers.xUrl}
                      onChange={(e) => setAnswer("xUrl", e.target.value)}
                      placeholder="https://x.com/yourhandle"
                    />
                  </Field>
                  <Field label="Instagram URL">
                    <input
                      className="input"
                      value={answers.instagramUrl}
                      onChange={(e) => setAnswer("instagramUrl", e.target.value)}
                      placeholder="https://instagram.com/yourhandle"
                    />
                  </Field>
                  <Field label="Booking / Portfolio / Case Studies URL">
                    <input
                      className="input"
                      value={answers.bookingOrPortfolioUrl}
                      onChange={(e) => setAnswer("bookingOrPortfolioUrl", e.target.value)}
                      placeholder="https://cal.com/yourname or portfolio link"
                    />
                  </Field>
                </div>

                <div
                  style={{
                    padding: 14,
                    borderRadius: 10,
                    border: "1px dashed var(--line)",
                    background: "var(--surface-2)",
                  }}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept=".pdf,.txt,.md,.csv,image/*"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      if (e.target.files?.length) void handleFileUpload(e.target.files);
                      e.target.value = "";
                    }}
                  />
                  <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
                    <div>
                      <div className="strong" style={{ fontSize: 13 }}>Optional logo or supporting docs (pitch deck, brochure, PDF)</div>
                      <div className="tiny muted">Uploaded documents are parsed and stored securely in your Knowledge Base.</div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={uploadingFile}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {uploadingFile ? <Loader2 size={13} className="spin" /> : <FileUp size={13} />}
                      {uploadingFile ? "Uploading…" : "Upload files / logo"}
                    </button>
                  </div>

                  {(answers.logoDataUrl || answers.uploadedSourceNames.length > 0) && (
                    <div className="row" style={{ gap: 10, marginTop: 10, flexWrap: "wrap" }}>
                      {answers.logoDataUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={answers.logoDataUrl}
                          alt="Uploaded logo"
                          style={{ height: 34, borderRadius: 6, border: "1px solid var(--line)" }}
                        />
                      )}
                      {answers.uploadedSourceNames.map((name) => (
                        <Badge key={name} tone="ok">{name}</Badge>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </Card>
          )}

          {/* SCREEN 12: REVIEW & GENERATE */}
          {step === 12 && (
            <Card
              title="Review & Generate Knowledge Base"
              sub="Confirm your answers below, generate a preview, and save your Knowledge Base."
            >
              <div className="stack" style={{ gap: 16 }}>
                {!previewSections ? (
                  <>
                    <div className="grid grid-2" style={{ gap: 10 }}>
                      {[
                        { s: 2, title: "About you", text: `${answers.fullName || "Not provided"} · ${answers.roleTitle || "Role skipped"} (${answers.workMode || "Solo/Team skipped"})` },
                        { s: 3, title: "Your business", text: `${answers.businessName || "Not provided"} · ${answers.industry || "Industry skipped"} · ${answers.businessLocation || "Location skipped"}` },
                        { s: 4, title: "What you do", text: answers.businessDescription || answers.mainServices.join(", ") || "Not provided" },
                        { s: 5, title: "Offer & pricing", text: `${answers.priceRange || "Pricing skipped"} · ${answers.differentiators || "Differentiators skipped"}` },
                        { s: 6, title: "Ideal customer", text: answers.idealCustomerSummary || answers.icpRoles.join(", ") || "Not provided" },
                        { s: 7, title: "Markets & locations", text: `${answers.marketReach.join(", ") || "Scope skipped"} · ${answers.currentMarkets || answers.expansionMarkets || "Locations skipped"}` },
                        { s: 8, title: "Goals & budget", text: `${answers.primaryObjective || "Objective skipped"} (${answers.targetNumber} ${answers.targetMetricLabel}) · $${answers.monthlyBudget}/mo` },
                        { s: 9, title: "Marketing history", text: answers.channelsUsed.join(", ") || answers.whatWorked || "Not provided" },
                        { s: 10, title: "Brand voice", text: answers.brandTones.join(", ") || "Not provided" },
                        { s: 11, title: "Online presence", text: answers.website || answers.linkedinUrl || "Not provided" },
                      ].map((item) => (
                        <div
                          key={item.s}
                          style={{
                            padding: 12,
                            borderRadius: 10,
                            border: "1px solid var(--line)",
                            background: "var(--surface-2)",
                          }}
                        >
                          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                            <span className="strong tiny">{item.title}</span>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              style={{ padding: "2px 6px", fontSize: 11 }}
                              onClick={() => goToStep(item.s, true)}
                            >
                              <Edit3 size={11} />
                              Edit
                            </button>
                          </div>
                          <div className="tiny muted" style={{ overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                            {item.text}
                          </div>
                        </div>
                      ))}
                    </div>

                    {genError && (
                      <Banner tone="bad">
                        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                          <span>{genError}</span>
                          <button type="button" className="btn btn-sm" onClick={() => void generateKnowledgePreview()}>
                            <RotateCcw size={12} />
                            Retry generation
                          </button>
                        </div>
                      </Banner>
                    )}

                    <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
                      <span className="tiny muted">
                        Missing details will be marked <strong>&ldquo;Not provided&rdquo;</strong> — nothing is ever invented.
                      </span>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => void generateKnowledgePreview()}
                        disabled={generatingKb}
                      >
                        {generatingKb ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
                        {generatingKb ? "Compiling Knowledge Base…" : "Generate Knowledge Base Preview"}
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="stack" style={{ gap: 14 }}>
                    <Banner tone="info">
                      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                        <span className="tiny">
                          <strong>Preview ready!</strong> Review the 10 generated sections below (you can edit any text before saving).
                        </span>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => setPreviewSections(null)}
                        >
                          Back to answers
                        </button>
                      </div>
                    </Banner>

                    {previewGaps.length > 0 && (
                      <Banner tone="warn">
                        <div className="tiny">
                          <AlertTriangle size={13} style={{ verticalAlign: "middle", marginRight: 5 }} />
                          <strong>Information marked &ldquo;Not provided&rdquo;:</strong> {previewGaps.join(" · ")}
                        </div>
                      </Banner>
                    )}

                    {genError && <Banner tone="bad">{genError}</Banner>}

                    <div className="stack" style={{ gap: 10, maxHeight: "52vh", overflowY: "auto", paddingRight: 4 }}>
                      {previewSections.map((sec, idx) => (
                        <div
                          key={sec.key}
                          style={{
                            padding: 12,
                            borderRadius: 10,
                            border: "1px solid var(--line)",
                            background: "var(--surface)",
                          }}
                        >
                          <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
                            <span className="strong" style={{ fontSize: 13 }}>{sec.title}</span>
                            <Badge>{sec.provenance === "user_edited" ? "Edited by you" : "AI-generated"}</Badge>
                          </div>
                          <textarea
                            className="input"
                            rows={3}
                            style={{ fontSize: 12.5, lineHeight: 1.5 }}
                            value={sec.content}
                            onChange={(e) => {
                              const nextVal = e.target.value;
                              setPreviewSections((prev) =>
                                prev
                                  ? prev.map((s, sIdx) =>
                                      sIdx === idx
                                        ? { ...s, content: nextVal, provenance: "user_edited" }
                                        : s,
                                    )
                                  : null,
                              );
                            }}
                          />
                        </div>
                      ))}
                    </div>

                    <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void generateKnowledgePreview()}
                        disabled={generatingKb || savingKb}
                      >
                        <RotateCcw size={13} />
                        Regenerate preview
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => void saveAndFinishOnboarding()}
                        disabled={savingKb}
                      >
                        {savingKb ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />}
                        {savingKb ? "Saving Knowledge Base…" : "Save Knowledge Base & Finish"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </Card>
          )}
        </motion.div>
      </AnimatePresence>

      {/* Bottom Wizard Navigation */}
      <div
        className="row"
        style={{
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: 18,
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <div>
          {step > 1 && (
            <button type="button" className="btn" onClick={() => goToStep(step - 1, true)}>
              <ArrowLeft size={14} />
              Back
            </button>
          )}
        </div>

        <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {step > 1 && step < TOTAL_STEPS && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => goToStep(step + 1, true)}
              title="Skip for now — more detail gives better AI results"
            >
              Skip for now
            </button>
          )}
          {step < TOTAL_STEPS && (
            <button type="button" className="btn btn-primary" onClick={() => goToStep(step + 1)}>
              {step === 1 ? "Get started" : "Next"}
              <ArrowRight size={14} />
            </button>
          )}
        </div>
      </div>

      {step > 1 && step < TOTAL_STEPS && (
        <p className="tiny muted" style={{ textAlign: "right", marginTop: 6 }}>
          You can skip questions anytime, though fuller answers make Growth Advisor & outreach noticeably sharper.
        </p>
      )}
    </main>
  );
}
