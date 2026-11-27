import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { BrandLockup } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";

/**
 * Branded 404. Rendered outside the workspace shell, so it only relies on the
 * shared tokens and the two controls a lost visitor needs: a way back and the
 * theme switch.
 */
export default function NotFound() {
  return (
    <main className="not-found">
      <header className="not-found-top">
        <Link href="/" className="not-found-brand" aria-label="Knowrevo home">
          <BrandLockup size={24} />
        </Link>
        <ThemeToggle compact />
      </header>

      <section className="not-found-body">
        <span className="page-eyebrow">Page not found</span>
        <h1 className="page-title">This page does not exist</h1>
        <p className="page-sub">
          The address may be incomplete or the page may have moved. Your workspace and data are unchanged.
        </p>
        <div className="row" style={{ marginTop: 22 }}>
          <Link className="btn btn-primary" href="/">
            <ArrowLeft size={14} aria-hidden="true" />
            Back to the workspace
          </Link>
          <Link className="btn" href="/settings">
            Open settings
          </Link>
        </div>
      </section>
    </main>
  );
}
