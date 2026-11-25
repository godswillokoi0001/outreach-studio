"use client";

import { useEffect } from "react";
import Link from "next/link";
import { RotateCcw } from "lucide-react";
import { BrandMark } from "@/components/BrandMark";

/**
 * Route-level error boundary: a failed render shows the real message and a way
 * back, instead of a blank dashboard.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app] route error:", error.message, error.digest ?? "");
  }, [error]);

  return (
    <main className="page">
      <div className="stack" style={{ maxWidth: 620, margin: "48px auto" }}>
        <div className="card" style={{ padding: 24 }}>
          <div className="row" style={{ gap: 10, marginBottom: 12 }}>
            <BrandMark size={28} />
            <h1 className="page-title" style={{ fontSize: 20 }}>
              Something went wrong on this screen
            </h1>
          </div>
          <p style={{ color: "var(--ink-2)", fontSize: 13.5, lineHeight: 1.6 }}>
            The page failed to render. Your data was not changed. Try again, and if it keeps happening open the
            operator in Developer mode so it can diagnose the exact cause.
          </p>
          <p className="tiny" style={{ marginTop: 10, fontFamily: "var(--mono)" }}>
            {error.message}
            {error.digest ? ` · ${error.digest}` : ""}
          </p>
          <div className="row" style={{ marginTop: 16 }}>
            <button type="button" className="btn btn-primary" onClick={reset}>
              <RotateCcw size={13} />
              <span>Try again</span>
            </button>
            <Link className="btn" href="/">
              Back to overview
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
