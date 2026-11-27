"use client";

import { useState } from "react";
import { Check, ChevronRight, SkipForward } from "lucide-react";
import { Badge, Banner, Field } from "@/components/ui";
import type { GrowthProfile } from "@/lib/growth-advisor";

const BUSINESS_STAGES = [
  { id: "idea_pre_revenue", label: "Early / Pre-revenue", desc: "Validating offer and finding first clients" },
  { id: "early_stage", label: "Growing solo / Early", desc: "Consistent clients, scaling outbound" },
  { id: "growing_team", label: "Established SMB team", desc: "Active team looking for repeatable pipeline" },
  { id: "established_agency", label: "Agency / Consultancy", desc: "Serving B2B clients across niches" },
  { id: "other", label: "Other", desc: "Specify your own stage" },
];

const TEAM_STRUCTURES = [
  { id: "solo", label: "Solo operator" },
  { id: "small_team", label: "Small team (2–10)" },
  { id: "agency", label: "Agency (10+)" },
  { id: "sales_team", label: "Dedicated sales team" },
  { id: "other", label: "Other" },
];

const BUSINESS_MODELS = [
  { id: "b2b_services", label: "B2B Agency / Services" },
  { id: "b2b_saas", label: "B2B Software / SaaS" },
  { id: "consulting_coaching", label: "Consulting / Advisory" },
  { id: "local_services", label: "Local / Commercial Services" },
  { id: "ecommerce", label: "E-commerce / Wholesale" },
  { id: "other", label: "Other" },
];

const PRICING_STRUCTURES = [
  { id: "monthly_retainer", label: "Monthly Retainer" },
  { id: "one_time", label: "One-Time Project" },
  { id: "usage_subscription", label: "SaaS Subscription" },
  { id: "tiered_packages", label: "Tiered Packages" },
  { id: "custom_quote", label: "Custom Quote" },
  { id: "other", label: "Other" },
];

const INDUSTRY_CHIPS = [
  "SaaS & Technology",
  "Healthcare & Dental",
  "Legal & Accounting",
  "Real Estate & Property",
  "Home & Local Services",
  "E-commerce & Retail",
  "Manufacturing & Logistics",
  "Marketing & Creative",
  "Other",
];

const ROLE_CHIPS = [
  "Founder / Owner",
  "CEO / Managing Director",
  "VP / Head of Marketing",
  "Head of Sales / Growth",
  "Operations Director",
  "Clinic / Practice Manager",
  "Other",
];

const TRIGGER_CHIPS = [
  "Hiring for growth roles",
  "Outdated or slow website",
  "Recent funding or expansion",
  "Launching a new location",
  "Low online reviews / visibility",
  "Switching agencies or tools",
  "Other",
];

const SCOPE_OPTIONS = [
  { id: "local", label: "Local city" },
  { id: "regional", label: "Regional / State" },
  { id: "national", label: "Nationwide" },
  { id: "international", label: "International" },
];

const LANGUAGE_CHIPS = ["English", "Spanish", "French", "German", "Portuguese", "Other"];

const SALES_CYCLES = [
  { id: "under_1_week", label: "Under 1 week" },
  { id: "1_to_4_weeks", label: "1–4 weeks" },
  { id: "1_to_3_months", label: "1–3 months" },
  { id: "3_plus_months", label: "3+ months" },
];

const CHANNEL_CHIPS = [
  "Cold Email",
  "LinkedIn",
  "Warm / Cold Call",
  "Referrals & Partnerships",
  "Content & SEO",
  "Paid Ads",
  "Other",
];

const CTA_STYLES = [
  { id: "free_audit", label: "Free tailored audit" },
  { id: "15_min_call", label: "Quick 15-min intro call" },
  { id: "case_study_video", label: "Short 2-min walkthrough" },
  { id: "pilot_trial", label: "Low-risk starter pilot" },
  { id: "other", label: "Other" },
];

const PRIMARY_GOALS = [
  { id: "booked_calls", label: "Book discovery calls" },
  { id: "qualified_leads", label: "Generate qualified leads" },
  { id: "direct_sales", label: "Close direct sales" },
  { id: "partnerships", label: "Build strategic partnerships" },
  { id: "other", label: "Other" },
];

const PROOF_CHIPS = [
  "Client case studies",
  "Before & after results",
  "Client logos / testimonials",
  "Clear guarantee / SLA",
  "Free sample / audit",
  "Still building proof",
  "Other",
];

const TONE_CHIPS = [
  "Direct & concise",
  "Consultative & calm",
  "Warm & friendly",
  "Data-driven",
  "Bold & confident",
];

function toggleItem(list: string[] | undefined, value: string): string[] {
  const arr = list ?? [];
  return arr.includes(value) ? arr.filter((x) => x !== value) : [...arr, value];
}

function ChipGroup({
  options,
  selected,
  onToggle,
}: {
  options: string[];
  selected: string[] | undefined;
  onToggle: (item: string) => void;
}) {
  const active = selected ?? [];
  return (
    <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
      {options.map((opt) => {
        const isSelected = active.includes(opt);
        return (
          <button
            key={opt}
            type="button"
            className={`btn btn-sm ${isSelected ? "btn-primary" : ""}`}
            onClick={() => onToggle(opt)}
            style={{ borderRadius: 999 }}
          >
            {isSelected && <Check size={12} />}
            {opt}
          </button>
        );
      })}
    </div>
  );
}

const SECTIONS = [
  { id: "identity", label: "1. Business & Role", optional: false },
  { id: "offer", label: "2. Offer & Pricing", optional: false },
  { id: "icp", label: "3. Ideal Customer", optional: false },
  { id: "geo", label: "4. Geography & Language", optional: true },
  { id: "channels", label: "5. Sales Cycle & Channels", optional: true },
  { id: "goals", label: "6. Goals & Capacity", optional: true },
  { id: "proof", label: "7. Proof & Constraints", optional: true },
] as const;

export function GrowthProfileForm({
  profile,
  onChange,
  onSave,
  onCancel,
  saving,
  completenessScore,
  missingFields,
  syncSourceNote,
}: {
  profile: GrowthProfile;
  onChange: (updater: (prev: GrowthProfile) => GrowthProfile) => void;
  onSave: (e: React.FormEvent) => void;
  onCancel: () => void;
  saving: boolean;
  completenessScore: number;
  missingFields: string[];
  syncSourceNote: string;
}) {
  const [activeSection, setActiveSection] = useState<(typeof SECTIONS)[number]["id"]>("identity");

  const setField = <K extends keyof GrowthProfile>(key: K, value: GrowthProfile[K]) => {
    onChange((prev) => ({ ...prev, [key]: value }));
  };

  const skipSection = (sectionId: string) => {
    onChange((prev) => ({
      ...prev,
      skippedSections: Array.from(new Set([...(prev.skippedSections ?? []), sectionId])),
    }));
    const idx = SECTIONS.findIndex((s) => s.id === sectionId);
    if (idx >= 0 && idx < SECTIONS.length - 1) {
      setActiveSection(SECTIONS[idx + 1].id);
    }
  };

  const currentIdx = SECTIONS.findIndex((s) => s.id === activeSection);
  const currentMeta = SECTIONS[currentIdx];

  return (
    <form onSubmit={onSave} className="stack" style={{ gap: 16 }}>
      <Banner tone={missingFields.length === 0 ? "ok" : "info"}>
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <span className="tiny">
            <strong>{completenessScore}% profile detail</strong>
            {missingFields.length > 0
              ? ` · Recommended next: ${missingFields.join(", ")}`
              : " · Ready for precision internet research."}
          </span>
          <span className="tiny muted">{syncSourceNote}</span>
        </div>
      </Banner>

      {/* Clean section pill selector */}
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        {SECTIONS.map((sec) => {
          const isSkipped = (profile.skippedSections ?? []).includes(sec.id);
          return (
            <button
              key={sec.id}
              type="button"
              className={`btn btn-sm ${activeSection === sec.id ? "btn-primary" : ""}`}
              onClick={() => setActiveSection(sec.id)}
            >
              {sec.label}
              {isSkipped && <Badge>Skipped</Badge>}
            </button>
          );
        })}
      </div>

      {/* Section 1: Business & Role */}
      {activeSection === "identity" && (
        <div className="stack" style={{ gap: 12 }}>
          <div className="grid grid-2" style={{ gap: 12 }}>
            <Field label="Company or brand name" hint="Example: Brightline Digital Studio">
              <input
                className="input"
                value={profile.whoYouAre}
                onChange={(e) => setField("whoYouAre", e.target.value)}
                placeholder="e.g. Brightline Digital Studio"
              />
            </Field>
            <Field label="Primary industry" hint="Example: B2B SaaS, Dental Marketing, Logistics">
              <input
                className="input"
                value={profile.industry}
                onChange={(e) => setField("industry", e.target.value)}
                placeholder="e.g. B2B Web Design & Conversion"
              />
            </Field>
          </div>

          <Field label="Business stage">
            <div className="grid grid-2" style={{ gap: 8 }}>
              {BUSINESS_STAGES.map((st) => {
                const selected = profile.businessStage === st.id;
                return (
                  <button
                    key={st.id}
                    type="button"
                    onClick={() => setField("businessStage", st.id)}
                    style={{
                      textAlign: "left",
                      padding: 10,
                      borderRadius: 10,
                      border: selected ? "2px solid var(--teal-deep, #0f766e)" : "1px solid var(--line)",
                      background: selected ? "var(--surface-2)" : "var(--surface)",
                      cursor: "pointer",
                    }}
                  >
                    <div className="strong tiny">{st.label}</div>
                    <div className="tiny muted">{st.desc}</div>
                  </button>
                );
              })}
            </div>
            {profile.businessStage === "other" && (
              <input
                className="input"
                style={{ marginTop: 8 }}
                value={profile.businessStageOther ?? ""}
                onChange={(e) => setField("businessStageOther", e.target.value)}
                placeholder="Please specify your business stage…"
              />
            )}
          </Field>

          <div className="grid grid-2" style={{ gap: 12 }}>
            <Field label="Team structure">
              <select
                className="input"
                value={profile.teamStructure ?? ""}
                onChange={(e) => setField("teamStructure", e.target.value)}
              >
                <option value="">Select team structure…</option>
                {TEAM_STRUCTURES.map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Website URL (optional)" hint="Helps Grounded Search match your positioning">
              <input
                className="input"
                value={profile.businessWebsite ?? ""}
                onChange={(e) => setField("businessWebsite", e.target.value)}
                placeholder="https://yourcompany.com"
              />
            </Field>
          </div>
        </div>
      )}

      {/* Section 2: Offer & Pricing */}
      {activeSection === "offer" && (
        <div className="stack" style={{ gap: 12 }}>
          <div className="grid grid-2" style={{ gap: 12 }}>
            <Field label="Business model">
              <select
                className="input"
                value={profile.businessModel ?? ""}
                onChange={(e) => setField("businessModel", e.target.value)}
              >
                <option value="">Select business model…</option>
                {BUSINESS_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
              {profile.businessModel === "other" && (
                <input
                  className="input"
                  style={{ marginTop: 6 }}
                  value={profile.businessModelOther ?? ""}
                  onChange={(e) => setField("businessModelOther", e.target.value)}
                  placeholder="Specify your business model…"
                />
              )}
            </Field>

            <Field label="Pricing structure">
              <select
                className="input"
                value={profile.pricingStructure ?? ""}
                onChange={(e) => setField("pricingStructure", e.target.value)}
              >
                <option value="">Select pricing structure…</option>
                {PRICING_STRUCTURES.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
              {profile.pricingStructure === "other" && (
                <input
                  className="input"
                  style={{ marginTop: 6 }}
                  value={profile.pricingStructureOther ?? ""}
                  onChange={(e) => setField("pricingStructureOther", e.target.value)}
                  placeholder="Specify your pricing structure…"
                />
              )}
            </Field>
          </div>

          <Field
            label={`Typical deal size / client value: $${(profile.averageDealValue ?? 2500).toLocaleString()}`}
            hint="Drag to match your average engagement or annual contract value"
          >
            <input
              type="range"
              min={250}
              max={50000}
              step={250}
              value={profile.averageDealValue ?? 2500}
              onChange={(e) => {
                const val = Number(e.target.value);
                onChange((prev) => ({
                  ...prev,
                  averageDealValue: val,
                  priceRange: prev.priceRange || `$${val.toLocaleString()} typical value`,
                }));
              }}
              style={{ width: "100%" }}
            />
          </Field>

          <div className="grid grid-2" style={{ gap: 12 }}>
            <Field label="What you sell" hint="Example: High-converting websites & local SEO for private dental practices">
              <input
                className="input"
                value={profile.whatYouSell}
                onChange={(e) => setField("whatYouSell", e.target.value)}
                placeholder="Describe your product or core service"
              />
            </Field>
            <Field label="Price range label" hint="Example: $2,500 - $6,000 per project">
              <input
                className="input"
                value={profile.priceRange}
                onChange={(e) => setField("priceRange", e.target.value)}
                placeholder="e.g. $2,500 - $6,000 / project"
              />
            </Field>
          </div>

          <Field label="Core offer & main promise" hint="Example: 14-day website overhaul designed to lift booked appointments">
            <input
              className="input"
              value={profile.offer}
              onChange={(e) => setField("offer", e.target.value)}
              placeholder="What specific outcome makes buyers say yes?"
            />
          </Field>
        </div>
      )}

      {/* Section 3: Ideal Customer */}
      {activeSection === "icp" && (
        <div className="stack" style={{ gap: 12 }}>
          <Field label="Ideal customer summary" hint="Example: Independent clinic owners with 3–25 staff expanding locations">
            <input
              className="input"
              value={profile.idealCustomer}
              onChange={(e) => setField("idealCustomer", e.target.value)}
              placeholder="Who gets the best results from your work?"
            />
          </Field>

          <Field label="Target buyer industries">
            <ChipGroup
              options={INDUSTRY_CHIPS}
              selected={profile.targetIndustries}
              onToggle={(item) => setField("targetIndustries", toggleItem(profile.targetIndustries, item))}
            />
            {(profile.targetIndustries ?? []).includes("Other") && (
              <input
                className="input"
                style={{ marginTop: 8 }}
                value={profile.targetIndustriesOther ?? ""}
                onChange={(e) => setField("targetIndustriesOther", e.target.value)}
                placeholder="Please specify other industries…"
              />
            )}
          </Field>

          <Field label="Decision-maker roles">
            <ChipGroup
              options={ROLE_CHIPS}
              selected={profile.targetRoles}
              onToggle={(item) => setField("targetRoles", toggleItem(profile.targetRoles, item))}
            />
            {(profile.targetRoles ?? []).includes("Other") && (
              <input
                className="input"
                style={{ marginTop: 8 }}
                value={profile.targetRolesOther ?? ""}
                onChange={(e) => setField("targetRolesOther", e.target.value)}
                placeholder="Please specify other job titles…"
              />
            )}
          </Field>

          <div className="grid grid-2" style={{ gap: 12 }}>
            <Field label="Preferred company size">
              <select
                className="input"
                value={profile.targetCompanySize ?? ""}
                onChange={(e) => setField("targetCompanySize", e.target.value)}
              >
                <option value="">Any company size</option>
                <option value="1-10">1–10 employees (Micro / Solo)</option>
                <option value="11-50">11–50 employees (Small business)</option>
                <option value="51-200">51–200 employees (Mid-market)</option>
                <option value="201+">201+ employees (Enterprise)</option>
              </select>
            </Field>
            <Field label="Buying signals / triggers">
              <ChipGroup
                options={TRIGGER_CHIPS}
                selected={profile.buyingTriggers}
                onToggle={(item) => setField("buyingTriggers", toggleItem(profile.buyingTriggers, item))}
              />
            </Field>
          </div>
        </div>
      )}

      {/* Section 4: Geography & Language */}
      {activeSection === "geo" && (
        <div className="stack" style={{ gap: 12 }}>
          <Field label="Market reach">
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              {SCOPE_OPTIONS.map((opt) => {
                const active = (profile.marketScope ?? []).includes(opt.id);
                return (
                  <button
                    key={opt.id}
                    type="button"
                    className={`btn btn-sm ${active ? "btn-primary" : ""}`}
                    onClick={() => setField("marketScope", toggleItem(profile.marketScope, opt.id))}
                  >
                    {active && <Check size={12} />}
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label="Cities, states, or countries you target" hint="Example: Austin TX, London UK, or English-speaking SaaS worldwide">
            <input
              className="input"
              value={profile.location}
              onChange={(e) => setField("location", e.target.value)}
              placeholder="e.g. Texas & Florida, or United Kingdom"
            />
          </Field>

          <Field label="Outreach languages">
            <ChipGroup
              options={LANGUAGE_CHIPS}
              selected={profile.outreachLanguages}
              onToggle={(item) => setField("outreachLanguages", toggleItem(profile.outreachLanguages, item))}
            />
            {(profile.outreachLanguages ?? []).includes("Other") && (
              <input
                className="input"
                style={{ marginTop: 8 }}
                value={profile.outreachLanguagesOther ?? ""}
                onChange={(e) => setField("outreachLanguagesOther", e.target.value)}
                placeholder="Specify additional outreach language…"
              />
            )}
          </Field>
        </div>
      )}

      {/* Section 5: Sales Cycle & Channels */}
      {activeSection === "channels" && (
        <div className="stack" style={{ gap: 12 }}>
          <Field label="Typical sales cycle length">
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              {SALES_CYCLES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`btn btn-sm ${profile.salesCycleLength === c.id ? "btn-primary" : ""}`}
                  onClick={() => setField("salesCycleLength", c.id)}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Preferred outreach channels">
            <ChipGroup
              options={CHANNEL_CHIPS}
              selected={profile.preferredChannels}
              onToggle={(item) => setField("preferredChannels", toggleItem(profile.preferredChannels, item))}
            />
            {(profile.preferredChannels ?? []).includes("Other") && (
              <input
                className="input"
                style={{ marginTop: 8 }}
                value={profile.preferredChannelsOther ?? ""}
                onChange={(e) => setField("preferredChannelsOther", e.target.value)}
                placeholder="Specify other channel…"
              />
            )}
          </Field>

          <Field label="Preferred first call-to-action (CTA)">
            <select
              className="input"
              value={profile.offerCtaStyle ?? ""}
              onChange={(e) => setField("offerCtaStyle", e.target.value)}
            >
              <option value="">Let AI recommend best CTA…</option>
              {CTA_STYLES.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
            {profile.offerCtaStyle === "other" && (
              <input
                className="input"
                style={{ marginTop: 6 }}
                value={profile.offerCtaStyleOther ?? ""}
                onChange={(e) => setField("offerCtaStyleOther", e.target.value)}
                placeholder="Specify preferred CTA…"
              />
            )}
          </Field>
        </div>
      )}

      {/* Section 6: Goals & Capacity */}
      {activeSection === "goals" && (
        <div className="stack" style={{ gap: 12 }}>
          <Field label="Primary 90-day goal">
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              {PRIMARY_GOALS.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className={`btn btn-sm ${profile.primaryGoal === g.id ? "btn-primary" : ""}`}
                  onClick={() => setField("primaryGoal", g.id)}
                >
                  {g.label}
                </button>
              ))}
            </div>
            {profile.primaryGoal === "other" && (
              <input
                className="input"
                style={{ marginTop: 8 }}
                value={profile.primaryGoalOther ?? ""}
                onChange={(e) => setField("primaryGoalOther", e.target.value)}
                placeholder="Specify your goal…"
              />
            )}
          </Field>

          <div className="grid grid-2" style={{ gap: 12 }}>
            <Field label={`Monthly qualified leads target: ${profile.monthlyTargetLeads ?? 50}`}>
              <input
                type="range"
                min={5}
                max={300}
                step={5}
                value={profile.monthlyTargetLeads ?? 50}
                onChange={(e) => setField("monthlyTargetLeads", Number(e.target.value))}
                style={{ width: "100%" }}
              />
            </Field>
            <Field label={`Weekly outreach capacity: ${profile.weeklyOutreachCapacity ?? 150} prospects/wk`}>
              <input
                type="range"
                min={25}
                max={1000}
                step={25}
                value={profile.weeklyOutreachCapacity ?? 150}
                onChange={(e) => setField("weeklyOutreachCapacity", Number(e.target.value))}
                style={{ width: "100%" }}
              />
            </Field>
          </div>
        </div>
      )}

      {/* Section 7: Proof, Voice & Exclusions */}
      {activeSection === "proof" && (
        <div className="stack" style={{ gap: 12 }}>
          <Field label="Credibility & proof assets available">
            <ChipGroup
              options={PROOF_CHIPS}
              selected={profile.proofAssets}
              onToggle={(item) => setField("proofAssets", toggleItem(profile.proofAssets, item))}
            />
          </Field>

          <Field label="Preferred brand tone">
            <ChipGroup
              options={TONE_CHIPS}
              selected={profile.tonePreference}
              onToggle={(item) => setField("tonePreference", toggleItem(profile.tonePreference, item))}
            />
          </Field>

          <Field label="Industries or audiences to exclude" hint="Example: Non-profits, solo freelancers, crypto, or businesses under 5 staff">
            <input
              className="input"
              value={profile.exclusions ?? ""}
              onChange={(e) => setField("exclusions", e.target.value)}
              placeholder="Who should Growth Advisor filter out?"
            />
          </Field>

          <label className="check">
            <input
              type="checkbox"
              checked={profile.allowComplianceSafeClaims !== false}
              onChange={(e) => setField("allowComplianceSafeClaims", e.target.checked)}
            />
            <span>Strictly prevent unverified ROI claims or hype in recommendations</span>
          </label>
        </div>
      )}

      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 10, paddingTop: 6, borderTop: "1px solid var(--line-soft)" }}>
        <div className="row" style={{ gap: 6 }}>
          {currentMeta?.optional && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => skipSection(currentMeta.id)}
            >
              <SkipForward size={12} /> Skip section
            </button>
          )}
          {currentIdx < SECTIONS.length - 1 && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setActiveSection(SECTIONS[currentIdx + 1].id)}
            >
              Next section <ChevronRight size={12} />
            </button>
          )}
        </div>

        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? "Saving & starting research…" : "Save profile & run research"}
          </button>
        </div>
      </div>
    </form>
  );
}
