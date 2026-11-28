"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { BrandLockup } from "@/components/BrandMark";

/**
 * The phone header: always one 56px row, never two.
 * Left = wordmark on Home or a truncated page title with a back button.
 * Right = at most two circular actions.
 */
export function MobileHeader({
  title,
  brand,
  backHref,
  end,
}: {
  title: string;
  brand?: boolean;
  backHref?: string;
  end?: ReactNode;
}) {
  return (
    <header className="m-header">
      <div className="m-header-slot m-header-slot-start">
        {backHref ? (
          <Link href={backHref} className="m-back" aria-label="Back" title="Back">
            <ArrowLeft size={20} />
          </Link>
        ) : null}
        {brand ? (
          <span className="m-header-title">
            <BrandLockup tone="brand" size={20} />
          </span>
        ) : (
          <span className="m-header-title" title={title}>
            {title}
          </span>
        )}
      </div>
      <div className="m-header-slot m-header-slot-end">{end}</div>
    </header>
  );
}
