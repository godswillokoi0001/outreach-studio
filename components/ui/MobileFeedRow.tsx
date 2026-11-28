"use client";

import type { ReactNode } from "react";

/**
 * One clean, tappable Gmail/Facebook-style feed row:
 * title + right-hand score/time, a secondary line, optional compact metadata.
 */
export function MobileFeedRow({
  title,
  subtitle,
  meta,
  side,
  leading,
  status,
  statusTone,
  onClick,
  ariaLabel,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  side?: ReactNode;
  leading?: ReactNode;
  status?: string;
  statusTone?: "ok" | "warn" | "bad" | "info";
  onClick?: () => void;
  ariaLabel?: string;
}) {
  const content = (
    <>
      {leading ? <span className="m-row-leading">{leading}</span> : null}
      <span className="m-row-main">
        <span className="m-row-line">
          <span className="m-row-title">{title}</span>
          {side ? <span className="m-row-side">{side}</span> : null}
        </span>
        {subtitle ? <span className="m-row-sub">{subtitle}</span> : null}
        {status || meta ? (
          <span className="m-row-meta">
            {status ? (
              <span className="m-status-dot" data-tone={statusTone ?? "info"}>
                {status}
              </span>
            ) : null}
            {meta ? <span>{meta}</span> : null}
          </span>
        ) : null}
      </span>
    </>
  );

  if (onClick) {
    return (
      <button type="button" className="m-row" onClick={onClick} aria-label={ariaLabel}>
        {content}
      </button>
    );
  }

  return <div className="m-row">{content}</div>;
}
