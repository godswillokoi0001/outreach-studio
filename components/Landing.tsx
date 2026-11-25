"use client";

import {
  ArrowRight,
  Check,
  FileSpreadsheet,
  MailCheck,
  MousePointerClick,
  ShieldCheck,
} from "lucide-react";
import { BrandLockup, BrandMark } from "./BrandMark";

const CAPABILITIES = [
  {
    n: "01",
    title: "Prospect research",
    body: "Each prospect's website is read and reduced to sourced facts — what they sell, who they serve, how they present themselves. No assumptions are carried into the writing.",
    tag: "Evidence first",
  },
  {
    n: "02",
    title: "Your business knowledge",
    body: "Offers, prices, proof and tone live in one place. Every draft is grounded in that record, so the message sounds like your business and not a template.",
    tag: "Single source",
  },
  {
    n: "03",
    title: "Personalised writing",
    body: "Research and knowledge meet in each email: a relevant observation, a specific reason to reply, and a next step that respects the reader's time.",
    tag: "Written, not generated",
  },
  {
    n: "04",
    title: "Delivery and signal",
    body: "Sent from your own Gmail after your approval. Opens and replies return to the workspace, so follow-up decisions are based on what happened.",
    tag: "Measured",
  },
];

const STEPS = [
  {
    n: "01",
    title: "Connect Google",
    body: "One sign-in links Gmail and Sheets. Your workspace starts empty and stays private to your account.",
  },
  {
    n: "02",
    title: "Record what you know",
    body: "Add your services, pricing, proof and tone — or upload the documents you already sell with.",
  },
  {
    n: "03",
    title: "Review and send",
    body: "Research and drafting run in the background. You approve each message, then watch engagement arrive.",
  },
];

const PRINCIPLES = [
  { title: "No shared inboxes", body: "Conversations come from your address, in your name." },
  { title: "No bought lists", body: "Bring prospects you have a reason to contact." },
  { title: "No blind sending", body: "Nothing leaves the workspace without your approval." },
];

const SIGNALS = [
  { name: "Northline Dental", subject: "A note on your booking flow", status: "Opened", tone: "open", when: "12s ago" },
  { name: "Ridgeway Legal", subject: "Re: intake process", status: "Replied", tone: "reply", when: "4 min ago" },
  { name: "Bluepeak Fitness", subject: "Follow-up · second touch", status: "Opened 3×", tone: "open", when: "11 min ago" },
  { name: "Harbor & Co.", subject: "A thought on your new site", status: "Sent", tone: "quiet", when: "22 min ago" },
];

export function Landing({
  onSignIn,
  onSignUp,
}: {
  onSignIn: () => void;
  onSignUp: () => void;
}) {
  return (
    <div className="site">
      <header className="site-nav">
        <a className="site-brand" href="#top" aria-label="Knowrevo home">
          <BrandLockup />
        </a>
        <nav className="site-links" aria-label="Sections">
          <a href="#product">Product</a>
          <a href="#signal">Signal</a>
          <a href="#how">How it works</a>
          <a href="#security">Security</a>
        </nav>
        <div className="site-nav-actions">
          <button type="button" className="btn btn-ghost" onClick={onSignIn}>
            Sign in
          </button>
          <button type="button" className="btn btn-primary site-nav-cta" onClick={onSignUp}>
            Start free
          </button>
        </div>
      </header>

      <main id="top">
        <section className="site-hero">
          <div className="site-hero-copy">
            <span className="site-eyebrow">Knowledge-powered outreach</span>
            <h1>
              Your knowledge.
              <br />
              Your next customer.
            </h1>
            <p className="site-lede">
              Knowrevo researches each prospect, writes from what your business actually offers, sends from your Gmail,
              and tells you the moment a message is opened or answered.
            </p>
            <div className="site-actions">
              <button type="button" className="btn btn-primary site-cta" onClick={onSignUp}>
                Create your workspace
                <ArrowRight size={15} />
              </button>
              <a className="btn site-cta-ghost" href="#product">
                See the workspace
              </a>
            </div>
            <ul className="site-assurances">
              <li>
                <Check size={13} /> Free to start
              </li>
              <li>
                <Check size={13} /> Uses your Gmail
              </li>
              <li>
                <Check size={13} /> Your data stays yours
              </li>
            </ul>
          </div>

          <div className="site-preview" id="product">
            <div className="pv-frame">
              <div className="pv-bar">
                <BrandMark size={18} />
                <span className="pv-bar-name">Knowrevo</span>
                <span className="pv-bar-sep">/</span>
                <span className="pv-bar-page">Workspace</span>
                <span className="pv-bar-live">
                  <i /> Live
                </span>
              </div>
              <div className="pv-body">
                <aside className="pv-side" aria-hidden="true">
                  {["Dashboard", "Prospects", "Campaigns", "Review", "Conversations", "Analytics"].map((item, index) => (
                    <span key={item} className={`pv-side-item${index === 0 ? " is-active" : ""}`}>
                      {item}
                    </span>
                  ))}
                </aside>
                <div className="pv-main">
                  <div className="pv-head">
                    <div>
                      <span className="pv-eyebrow">Wednesday · workspace overview</span>
                      <strong>Good afternoon, Alex.</strong>
                    </div>
                    <span className="pv-pill">3 need you</span>
                  </div>

                  <div className="pv-metrics">
                    {[
                      ["Prospects", "184", "+12 this week"],
                      ["Qualified", "96", "52% of list"],
                      ["Opened", "71", "38% of sends"],
                      ["Replied", "23", "12% reply rate"],
                    ].map(([label, value, note]) => (
                      <div key={label} className="pv-metric">
                        <span>{label}</span>
                        <strong>{value}</strong>
                        <em>{note}</em>
                      </div>
                    ))}
                  </div>

                  <div className="pv-list">
                    <div className="pv-list-head">
                      <span>Needs your attention</span>
                      <span className="pv-list-meta">4 items</span>
                    </div>
                    {[
                      ["Emails to review", "3 drafts ready for approval", "3"],
                      ["Replies to read", "2 interested, 1 pricing question", "2"],
                      ["Follow-ups due", "Sequences pause on reply", "1"],
                    ].map(([title, hint, count]) => (
                      <div key={title} className="pv-row">
                        <div>
                          <strong>{title}</strong>
                          <span>{hint}</span>
                        </div>
                        <b>{count}</b>
                      </div>
                    ))}
                  </div>

                  <div className="pv-note">
                    <ShieldCheck size={13} />
                    Nothing sends until you approve it.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="site-strip-wrap" aria-label="Who it is for">
          <div className="site-strip">
            <span>Built for teams that sell on expertise</span>
            <div className="site-strip-items">
              <span>Agencies</span>
              <span>Design studios</span>
              <span>Consultants</span>
              <span>Professional services</span>
              <span>Local businesses</span>
            </div>
          </div>
        </section>

        <section className="site-section" id="product-detail">
          <div className="site-section-head">
            <span className="site-kicker">The product</span>
            <h2>Outreach that understands your business before speaking for it.</h2>
            <p>
              Not a list scraper with a writing box attached. Four connected parts, each one responsible for the quality
              of the next.
            </p>
          </div>

          <div className="site-ledger">
            {CAPABILITIES.map((item) => (
              <article key={item.n} className="site-ledger-row">
                <span className="site-ledger-n">{item.n}</span>
                <div className="site-ledger-body">
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </div>
                <span className="site-ledger-tag">{item.tag}</span>
              </article>
            ))}
          </div>
        </section>

        <section className="site-signal" id="signal">
          <div className="site-signal-copy">
            <span className="site-kicker">After the send</span>
            <h2>Most tools stop at “sent”. This one keeps watching.</h2>
            <p>
              A lightweight tracker confirms when an email is opened. Reply sync reads your inbox on your schedule and
              classifies each answer, so interest and objections reach you while they are still relevant.
            </p>
            <ul className="site-checks">
              <li>
                <MousePointerClick size={15} />
                <span>
                  <strong>Open signal</strong> — per email, with repeat opens counted.
                </span>
              </li>
              <li>
                <MailCheck size={15} />
                <span>
                  <strong>Reply classification</strong> — interested, pricing, objection, unsubscribe or bounce.
                </span>
              </li>
              <li>
                <FileSpreadsheet size={15} />
                <span>
                  <strong>Sheet sync</strong> — statuses written back to the rows they came from.
                </span>
              </li>
            </ul>
          </div>

          <div className="site-board">
            <div className="site-board-head">
              <span>Activity</span>
              <span className="site-board-meta">Last 30 minutes</span>
            </div>
            <table className="site-board-table">
              <thead>
                <tr>
                  <th>Prospect</th>
                  <th>Status</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {SIGNALS.map((signal) => (
                  <tr key={signal.name}>
                    <td>
                      <strong>{signal.name}</strong>
                      <span>{signal.subject}</span>
                    </td>
                    <td>
                      <span className={`site-status site-status-${signal.tone}`}>{signal.status}</span>
                    </td>
                    <td className="site-when">{signal.when}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="site-board-note">
              Opens are a strong signal, not proof — some mail clients pre-fetch images. Replies are always read
              directly from Gmail.
            </p>
          </div>
        </section>

        <section className="site-section" id="how">
          <div className="site-section-head">
            <span className="site-kicker">How it works</span>
            <h2>Set it up once. Then review, not assemble.</h2>
          </div>
          <div className="site-steps">
            {STEPS.map((step) => (
              <article key={step.n} className="site-step">
                <span className="site-step-n">{step.n}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="site-principles" aria-label="Principles">
          {PRINCIPLES.map((item) => (
            <div key={item.title}>
              <strong>{item.title}</strong>
              <span>{item.body}</span>
            </div>
          ))}
        </section>

        <section className="site-quote">
          <blockquote>
            “The open notifications changed how I follow up. I used to guess who was warm. Now I know which email to
            answer first.”
          </blockquote>
          <div className="site-quote-by">
            <span className="site-quote-avatar">AO</span>
            <div>
              <strong>Alex O.</strong>
              <span>Founder, boutique web studio</span>
            </div>
          </div>
        </section>

        <section className="site-final" id="security">
          <div className="site-final-copy">
            <span className="site-kicker site-kicker-light">Private by default</span>
            <h2>Your Gmail. Your knowledge. Your workspace.</h2>
            <p>
              Each account is isolated on the server — only you can see your data. Tokens never touch local storage, and
              nothing leaves your outbox until you approve it.
            </p>
            <ul className="site-checks site-checks-light">
              <li>
                <ShieldCheck size={15} />
                <span>Per-account isolation on every request.</span>
              </li>
              <li>
                <Check size={15} />
                <span>Approval required before any email is sent.</span>
              </li>
              <li>
                <Check size={15} />
                <span>Suppression, unsubscribe and bounce handling built in.</span>
              </li>
            </ul>
          </div>
          <div className="site-final-cta">
            <h3>Start with a prospect list you already have.</h3>
            <p>Bring the list. Knowrevo handles the research, the writing and the follow-through.</p>
            <button type="button" className="btn site-cta site-cta-light" onClick={onSignUp}>
              Create your workspace
              <ArrowRight size={15} />
            </button>
            <button type="button" className="btn site-cta-ghost site-cta-ghost-light" onClick={onSignIn}>
              Sign in instead
            </button>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="site-brand">
          <BrandLockup subtitle="Your knowledge. Your next customer." />
        </div>
        <span className="site-footer-note">Research → understand → reach → measure.</span>
        <div className="site-footer-links">
          <a href="/privacy-policy">Privacy</a>
          <a href="/terms">Terms</a>
          <button type="button" onClick={onSignIn}>
            Sign in
          </button>
          <button type="button" onClick={onSignUp}>
            Get started
          </button>
        </div>
      </footer>
    </div>
  );
}
