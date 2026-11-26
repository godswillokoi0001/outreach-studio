"use client";

import { useState } from "react";
import { ChevronDown, ListFilter, SlidersHorizontal, Zap } from "lucide-react";
import { authedPost, errorMessage } from "@/lib/client";
import { buildLiveKnowledgeDigest } from "@/lib/pipeline-client";
import {
  BUDGET_OPTIONS,
  BUSINESS_SIZE_OPTIONS,
  INDUSTRY_OPTIONS,
  ONLINE_PRESENCE_OPTIONS,
  RATING_OPTIONS,
  SERVICE_OPTIONS,
  criteriaSummary,
  type ResearchCriteria,
} from "@/lib/criteria";
import { BrandLoader } from "./BrandLoader";
import { Field } from "./ui";

/**
 * Predefined filters instead of free typing: six essential fields, with the
 * rest behind "Advanced filters". Auto mode asks the AI (with the knowledge
 * base) to fill the form and then shows what it picked, editable.
 */
export function CriteriaForm({
  value,
  onChange,
  uid,
  busy,
  disabled,
  onAutoResult,
}: {
  value: ResearchCriteria;
  onChange: (value: ResearchCriteria) => void;
  /** Read the knowledge base on demand when Auto runs. */
  uid?: string;
  busy?: boolean;
  disabled?: boolean;
  onAutoResult?: (criteria: ResearchCriteria) => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [autoBusy, setAutoBusy] = useState<"auto" | "instruction" | null>(null);
  const [autoError, setAutoError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");

  const set = <K extends keyof ResearchCriteria>(key: K, next: ResearchCriteria[K]) =>
    onChange({ ...value, [key]: next });

  const toggleService = (service: string) => {
    const services = value.services.includes(service)
      ? value.services.filter((item) => item !== service)
      : [...value.services, service].slice(0, 4);
    set("services", services);
  };

  const runAuto = async (mode: "auto" | "instruction") => {
    setAutoBusy(mode);
    setAutoError(null);
    try {
      const knowledge = uid ? await buildLiveKnowledgeDigest(uid).catch(() => "") : "";
      const res = await authedPost<{ criteria: ResearchCriteria }>("/api/ai/criteria", {
        mode,
        instruction: mode === "instruction" ? instruction : "",
        knowledge,
        current: value,
      });
      onChange(res.criteria);
      onAutoResult?.(res.criteria);
    } catch (err) {
      setAutoError(errorMessage(err));
    } finally {
      setAutoBusy(null);
    }
  };

  const chips = criteriaSummary(value);

  return (
    <div className="criteria">
      <div className="criteria-head">
        <div>
          <div className="criteria-title">
            <ListFilter size={14} aria-hidden="true" />
            Who to find
          </div>
          <p className="criteria-sub">
            Pick from fixed options so the research brief is unambiguous. Auto fills it from your knowledge base.
          </p>
        </div>
        <button
          type="button"
          className="criteria-auto"
          data-on={value.auto ? "true" : "false"}
          aria-pressed={value.auto}
          onClick={() => {
            if (value.auto) {
              onChange({ ...value, auto: false });
              return;
            }
            void runAuto("auto");
          }}
          disabled={autoBusy !== null || busy || disabled}
          title="Let the AI choose the filters from your knowledge base"
        >
          {autoBusy === "auto" ? <BrandLoader size={13} /> : <Zap size={13} aria-hidden="true" />}
          <span>{value.auto ? "Auto is on" : "Auto"}</span>
        </button>
      </div>

      {autoError ? (
        <p className="criteria-error" role="alert">
          {autoError}
        </p>
      ) : null}

      {value.auto ? (
        <div className="criteria-auto-note">
          <strong>AI picked:</strong> {(chips.length ? chips : ["defaults"]).join(" · ")}
          {value.autoRationale ? <span> — {value.autoRationale}</span> : null}
          <span className="tiny"> Edit any field below; your changes are kept.</span>
        </div>
      ) : null}

      <div className="criteria-nl">
        <input
          className="input"
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (instruction.trim()) void runAuto("instruction");
            }
          }}
          placeholder="Or describe it: find private schools in Lekki with no website"
          aria-label="Describe the prospects you want"
          disabled={disabled || busy}
        />
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void runAuto("instruction")}
          disabled={!instruction.trim() || autoBusy !== null || busy || disabled}
        >
          {autoBusy === "instruction" ? <BrandLoader size={13} /> : <SlidersHorizontal size={13} />}
          <span>Fill form</span>
        </button>
      </div>

      <div className="grid grid-3">
        <Field label="Industry / segment">
          <select
            className="select"
            value={value.industry}
            onChange={(event) => set("industry", event.target.value)}
            disabled={disabled}
          >
            <option value="">Any segment</option>
            {INDUSTRY_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Business size">
          <select
            className="select"
            value={value.businessSize}
            onChange={(event) => set("businessSize", event.target.value)}
            disabled={disabled}
          >
            {BUSINESS_SIZE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Online presence">
          <select
            className="select"
            value={value.onlinePresence}
            onChange={(event) => set("onlinePresence", event.target.value)}
            disabled={disabled}
          >
            {ONLINE_PRESENCE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Review rating">
          <select
            className="select"
            value={value.rating}
            onChange={(event) => set("rating", event.target.value)}
            disabled={disabled}
          >
            {RATING_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </Field>

      </div>

      <div className="criteria-lower">
        <Field label="How many prospects" hint="Between 3 and 20 per run.">
          <input
            className="input"
            type="number"
            min={3}
            max={20}
            value={value.count}
            onChange={(event) => set("count", Math.max(3, Math.min(20, Number(event.target.value) || 8)))}
            disabled={disabled}
          />
        </Field>

        <Field label="Services to pitch" hint="Up to four, from your knowledge base.">
          <div className="criteria-services">
            {SERVICE_OPTIONS.map((service) => (
              <button
                key={service}
                type="button"
                className="criteria-chip"
                data-on={value.services.includes(service) ? "true" : "false"}
                aria-pressed={value.services.includes(service)}
                onClick={() => toggleService(service)}
                disabled={disabled}
              >
                {service}
              </button>
            ))}
          </div>
        </Field>
      </div>

      <button
        type="button"
        className="btn btn-sm btn-ghost criteria-advanced-toggle"
        onClick={() => setAdvanced((open) => !open)}
        aria-expanded={advanced}
      >
        <ChevronDown size={13} style={{ transform: advanced ? "rotate(180deg)" : "none" }} aria-hidden="true" />
        <span>{advanced ? "Hide advanced filters" : "Advanced filters"}</span>
      </button>

      {advanced ? (
        <div className="grid grid-3 criteria-advanced">
          <Field label="Budget range">
            <select
              className="select"
              value={value.budget}
              onChange={(event) => set("budget", event.target.value)}
              disabled={disabled}
            >
              {BUDGET_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Minimum lead score" hint="Prospects below this are not queued for outreach.">
            <input
              className="input"
              type="number"
              min={0}
              max={100}
              value={value.minScore}
              onChange={(event) => set("minScore", Math.max(0, Math.min(100, Number(event.target.value) || 55)))}
              disabled={disabled}
            />
          </Field>
          <Field label="Extra notes">
            <input
              className="input"
              value={value.focus}
              onChange={(event) => set("focus", event.target.value)}
              placeholder="e.g. only businesses with a Facebook page and no site"
              disabled={disabled}
            />
          </Field>
        </div>
      ) : null}
    </div>
  );
}
