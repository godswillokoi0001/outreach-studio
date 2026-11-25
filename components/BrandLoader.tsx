"use client";

import { useEffect, useState } from "react";

/**
 * The one loader in the app.
 *
 * Built from the real Knowrevo mark: a slow breathe plus a soft light sweep
 * masked to the logo. GPU-friendly (transform/opacity only) and static when
 * the visitor asks for reduced motion.
 */

export type BrandLoaderVariant = "page" | "inline" | "button" | "skeleton" | "thinking";

const DEFAULT_SIZE: Record<BrandLoaderVariant, number> = {
  page: 56,
  inline: 20,
  button: 14,
  skeleton: 22,
  thinking: 24,
};

export function BrandLoader({
  variant = "inline",
  size,
  label,
  className,
}: {
  variant?: BrandLoaderVariant;
  size?: number;
  label?: string;
  className?: string;
}) {
  const dimension = size ?? DEFAULT_SIZE[variant];
  const isPage = variant === "page";

  return (
    <span
      className={`brand-loader brand-loader-${variant}${className ? ` ${className}` : ""}`}
      role={isPage ? "status" : undefined}
      aria-live={isPage ? "polite" : undefined}
      aria-label={isPage ? (label ?? "Loading") : undefined}
      data-variant={variant}
    >
      <span className="brand-loader-art" style={{ height: dimension }} aria-hidden="true">
        <img src="/brand/knowrevo-mark.png" alt="" decoding="async" />
        <span className="brand-loader-sweep" />
      </span>
      {label && variant !== "button" ? <span className="brand-loader-label">{label}</span> : null}
      {isPage && !label ? <span className="brand-loader-label">Loading</span> : null}
    </span>
  );
}

/** Full-screen-ish panel used while a page's first data arrives. */
export function BrandLoadingPanel({
  label,
  hint,
  steps,
  compact = false,
}: {
  label: string;
  hint?: string;
  steps?: { label: string; ms: number }[];
  compact?: boolean;
}) {
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    if (!steps?.length) return undefined;
    let cancelled = false;
    let index = 0;
    let timer: number;
    const advance = () => {
      if (cancelled) return;
      timer = window.setTimeout(() => {
        index = Math.min(index + 1, steps.length - 1);
        setStepIndex(index);
        if (index < steps.length - 1) advance();
      }, steps[index].ms);
    };
    advance();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [steps]);

  return (
    <div className={`load-panel brand-load-panel${compact ? " compact" : ""}`} role="status" aria-live="polite">
      <div className="load-head">
        <BrandLoader variant="page" size={compact ? 34 : 46} />
        <div className="load-copy">
          <div className="load-title">{label}</div>
          {hint ? <div className="load-hint">{hint}</div> : null}
        </div>
      </div>
      {steps && steps.length > 0 && !compact ? (
        <ul className="load-steps">
          {steps.map((step, index) => (
            <li
              key={`${step.label}-${index}`}
              className="load-step"
              data-state={index < stepIndex ? "done" : index === stepIndex ? "active" : "waiting"}
            >
              <span className="load-dot" aria-hidden="true" />
              <span className="load-step-label">{step.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
