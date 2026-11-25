import Link from "next/link";
import { ArrowLeft, ArrowUpRight, ShieldCheck } from "lucide-react";

type LegalSection = {
  id: string;
  title: string;
  paragraphs: string[];
  bullets?: string[];
};

export function LegalPage({
  title,
  summary,
  sections,
}: {
  title: string;
  summary: string;
  sections: LegalSection[];
}) {
  return (
    <main className="legal-page">
      <header className="legal-topbar">
        <Link className="legal-brand" href="/">
          <span className="brand-mark" aria-hidden="true">
            <img src="/brand/knowrevo-icon-t.png" alt="" />
          </span>
          <span>Knowrevo</span>
        </Link>
        <Link className="legal-back" href="/">
          <ArrowLeft size={14} aria-hidden="true" />
          Back to home
        </Link>
      </header>

      <section className="legal-hero" aria-labelledby="legal-title">
        <span className="legal-eyebrow"><ShieldCheck size={14} aria-hidden="true" /> Policies &amp; terms</span>
        <h1 id="legal-title">{title}</h1>
        <p>{summary}</p>
        <span className="legal-updated">Last updated November 25, 2026</span>
      </section>

      <div className="legal-layout">
        <nav className="legal-toc" aria-label="On this page">
          <span>On this page</span>
          {sections.map((section) => (
            <a key={section.id} href={`#${section.id}`}>{section.title}</a>
          ))}
        </nav>
        <article className="legal-content">
          {sections.map((section, index) => (
            <section className="legal-section" id={section.id} key={section.id} aria-labelledby={`${section.id}-title`}>
              <div className="legal-section-number">{String(index + 1).padStart(2, "0")}</div>
              <div>
                <h2 id={`${section.id}-title`}>{section.title}</h2>
                {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                {section.bullets && (
                  <ul>
                    {section.bullets.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                )}
              </div>
            </section>
          ))}
          <aside className="legal-contact">
            <div>
              <strong>Questions about this document?</strong>
              <p>Contact us at <a href="mailto:hello@godswillokoi.site">hello@godswillokoi.site</a>.</p>
            </div>
            <a className="legal-contact-link" href="mailto:hello@godswillokoi.site" aria-label="Email Knowrevo">
              <ArrowUpRight size={16} aria-hidden="true" />
            </a>
          </aside>
        </article>
      </div>
      <footer className="legal-footer">
        <span>Knowrevo</span>
        <div><Link href="/privacy-policy">Privacy</Link><Link href="/terms">Terms</Link></div>
      </footer>
    </main>
  );
}
