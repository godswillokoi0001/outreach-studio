"use client";

import {
  ArrowRight,
  BadgeCheck,
  BookOpen,
  CheckCircle2,
  Clock3,
  FileSpreadsheet,
  Mail,
  MailCheck,
  MousePointerClick,
  Search,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";

const FEATURES = [
  {
    icon: Search,
    title: "Research that cites itself",
    body: "Every prospect's website is read and reduced to verified facts with sources before a single line is written.",
    tag: "Signals, not guesses",
  },
  {
    icon: BookOpen,
    title: "Knowledge that actually writes",
    body: "Your offers, prices, proof and tone live in one place. Every draft is grounded there, never invented.",
    tag: "Your voice",
  },
  {
    icon: MailCheck,
    title: "Opens and replies, live",
    body: "See the moment a prospect opens your email, and get told the moment they answer. Both arrive in your workspace.",
    tag: "Real-time",
  },
  {
    icon: Mail,
    title: "Sent from your own Gmail",
    body: "Real conversations from your real address. No shared inboxes, no third-party sending domain to warm up.",
    tag: "Gmail-native",
  },
  {
    icon: FileSpreadsheet,
    title: "Your sheet, in and out",
    body: "Import a prospect list in one click and write statuses straight back to the same rows it came from.",
    tag: "Pipeline sync",
  },
  {
    icon: ShieldCheck,
    title: "Nothing sends without you",
    body: "Draft, review, approve. Suppression lists, unsubscribe lines and hard bounces are handled automatically.",
    tag: "Approval-first",
  },
];

const STEPS = [
  {
    n: "01",
    title: "Connect Google",
    body: "One sign-in links Gmail and Google Sheets. Your workspace starts empty and stays private to you.",
  },
  {
    n: "02",
    title: "Teach it your business",
    body: "Paste your knowledge or upload the PDFs you already sell with. That becomes the only source of truth.",
  },
  {
    n: "03",
    title: "Approve and send",
    body: "Research, qualification and drafts run in the background. You approve what goes out and watch opens land.",
  },
];

const PROOF = [
  { value: "4.2×", label: "more replies on researched prospects" },
  { value: "12s", label: "to know an email was opened" },
  { value: "0", label: "emails sent without approval" },
];

export function Landing({
  onSignIn,
  onSignUp,
}: {
  onSignIn: () => void;
  onSignUp: () => void;
}) {
  return (
    <div className="landing">
      <div className="landing-aurora" aria-hidden="true" />

      <header className="landing-nav">
        <div className="landing-brand">
          <img src="/brand/knowrevo-logo-t.png" alt="Knowrevo" className="landing-logo" />
        </div>
        <nav className="landing-links" aria-label="Sections">
          <a href="#product">Product</a>
          <a href="#signal">Intelligence</a>
          <a href="#how">How it works</a>
          <a href="#security">Security</a>
        </nav>
        <div className="landing-nav-actions">
          <button type="button" className="btn btn-ghost" onClick={onSignIn}>
            Sign in
          </button>
          <button type="button" className="btn landing-cta-sm" onClick={onSignUp}>
            Start free
            <ArrowRight size={14} />
          </button>
        </div>
      </header>

      <main>
        <section className="landing-hero">
          <div className="landing-hero-copy">
            <span className="landing-pill">
              <Sparkles size={13} />
              Knowledge-powered outreach
            </span>
            <h1>
              Your knowledge.
              <br />
              <em>Your next customer.</em>
            </h1>
            <p>
              Knowrevo researches prospects, learns from your business knowledge, creates personalized emails and tracks
              engagement and replies — all from one workspace.
            </p>
            <div className="landing-hero-actions">
              <button type="button" className="btn landing-cta" onClick={onSignUp}>
                Create your workspace
                <ArrowRight size={15} />
              </button>
              <button type="button" className="btn landing-cta-ghost" onClick={onSignIn}>
                I already have one
              </button>
            </div>
            <ul className="landing-assurances">
              <li>
                <CheckCircle2 size={14} /> Free to start
              </li>
              <li>
                <CheckCircle2 size={14} /> Uses your Gmail
              </li>
              <li>
                <CheckCircle2 size={14} /> Your data stays yours
              </li>
            </ul>
          </div>

          <div className="landing-visual" id="product">
            <div className="mock-window">
              <div className="mock-bar">
                <span className="mock-dot" />
                <span className="mock-dot" />
                <span className="mock-dot" />
                <span className="mock-url">knowrevo.app/dashboard</span>
              </div>
              <div className="mock-body">
                <div className="mock-side">
                  <span className="mock-brand">
                    <img src="/brand/knowrevo-icon-dark.png" alt="" aria-hidden="true" />
                  </span>
                  {["Dashboard", "Leads", "Campaigns", "Review", "Conversations", "Analytics"].map((item, index) => (
                    <span key={item} className={`mock-nav${index === 0 ? " active" : ""}`}>
                      {item}
                    </span>
                  ))}
                </div>
                <div className="mock-main">
                  <div className="mock-head">
                    <div>
                      <span className="mock-eyebrow">Workspace overview</span>
                      <strong>Good afternoon, Alex.</strong>
                    </div>
                    <span className="mock-chip">
                      <Zap size={11} /> 3 need you
                    </span>
                  </div>
                  <div className="mock-stats">
                    {[
                      ["Prospects", "184"],
                      ["Qualified", "96"],
                      ["Opened", "71"],
                      ["Replied", "23"],
                    ].map(([label, value]) => (
                      <div key={label} className="mock-stat">
                        <span>{label}</span>
                        <strong>{value}</strong>
                      </div>
                    ))}
                  </div>
                  <div className="mock-events">
                    <div className="mock-events-head">
                      <span>Live activity</span>
                      <span className="mock-live">
                        <i /> live
                      </span>
                    </div>
                    <div className="mock-event">
                      <span className="mock-event-icon open">
                        <MousePointerClick size={12} />
                      </span>
                      <span>
                        <strong>Northline Dental</strong> opened “A thought on your booking flow”
                      </span>
                      <span className="mock-time">12s</span>
                    </div>
                    <div className="mock-event">
                      <span className="mock-event-icon reply">
                        <MailCheck size={12} />
                      </span>
                      <span>
                        <strong>Ridgeway Legal</strong> replied · interested
                      </span>
                      <span className="mock-time">4m</span>
                    </div>
                    <div className="mock-event">
                      <span className="mock-event-icon open">
                        <MousePointerClick size={12} />
                      </span>
                      <span>
                        <strong>Bluepeak Fitness</strong> opened your follow-up
                      </span>
                      <span className="mock-time">11m</span>
                    </div>
                    <div className="mock-event">
                      <span className="mock-event-icon build">
                        <Sparkles size={12} />
                      </span>
                      <span>
                        Drafting 4 emails from <strong>your knowledge</strong>
                      </span>
                      <span className="mock-time">now</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="mock-float mock-float-open">
              <MousePointerClick size={14} />
              <div>
                <strong>Opened just now</strong>
                <span>Northline Dental · 2×</span>
              </div>
            </div>
            <div className="mock-float mock-float-reply">
              <MailCheck size={14} />
              <div>
                <strong>New reply</strong>
                <span>“Happy to talk this week.”</span>
              </div>
            </div>
          </div>
        </section>

        <section className="landing-strip" aria-label="Who it is for">
          <span>Built for agencies, studios, consultants and service businesses</span>
          <div className="landing-strip-items">
            <span>Web design</span>
            <span>Brand studios</span>
            <span>Growth agencies</span>
            <span>Consultants</span>
            <span>Local services</span>
          </div>
        </section>

        <section className="landing-section">
          <div className="landing-section-head">
            <span className="landing-kicker">Everything in one private workspace</span>
            <h2>The parts of outreach that actually decide the outcome.</h2>
            <p>
              Not another list scraper. A workspace that researches, writes, sends, and then tells you what happened
              after the send.
            </p>
          </div>
          <div className="landing-grid">
            {FEATURES.map(({ icon: Icon, title, body, tag }) => (
              <article key={title} className="landing-card">
                <span className="landing-card-icon">
                  <Icon size={18} strokeWidth={1.8} />
                </span>
                <span className="landing-card-tag">{tag}</span>
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="landing-signal" id="signal">
          <div className="landing-signal-copy">
            <span className="landing-kicker">After the send</span>
            <h2>Most tools stop at “sent”. This one keeps watching.</h2>
            <p>
              A one-pixel tracker confirms when your email is actually opened. Reply sync reads your Gmail on your
              schedule and classifies every answer, so you see interest, pricing questions and objections as they
              arrive — not a week later.
            </p>
            <ul className="landing-checks">
              <li>
                <MousePointerClick size={15} />
                <span>
                  <strong>Open signal</strong> — per email, with repeat opens counted.
                </span>
              </li>
              <li>
                <MailCheck size={15} />
                <span>
                  <strong>Reply alerts</strong> — classified interested, pricing, objection, unsubscribe or bounce.
                </span>
              </li>
              <li>
                <Clock3 size={15} />
                <span>
                  <strong>Follow-ups that stop</strong> the moment someone answers.
                </span>
              </li>
            </ul>
          </div>
          <div className="signal-board">
            <div className="signal-row">
              <span className="signal-badge open">
                <MousePointerClick size={12} /> OPENED
              </span>
              <div>
                <strong>Northline Dental</strong>
                <span>“A thought on your booking flow”</span>
              </div>
              <span className="signal-stamp">just now</span>
            </div>
            <div className="signal-row">
              <span className="signal-badge reply">
                <MailCheck size={12} /> REPLIED
              </span>
              <div>
                <strong>Ridgeway Legal</strong>
                <span>Interested · suggested next step ready</span>
              </div>
              <span className="signal-stamp">4 min ago</span>
            </div>
            <div className="signal-row">
              <span className="signal-badge open">
                <MousePointerClick size={12} /> OPENED
              </span>
              <div>
                <strong>Bluepeak Fitness</strong>
                <span>Follow-up #2 · opened 3×</span>
              </div>
              <span className="signal-stamp">11 min ago</span>
            </div>
            <div className="signal-row">
              <span className="signal-badge quiet">
                <BadgeCheck size={12} /> SENT
              </span>
              <div>
                <strong>Harbor &amp; Co.</strong>
                <span>Confirmed by Gmail · awaiting open</span>
              </div>
              <span className="signal-stamp">22 min ago</span>
            </div>
            <p className="signal-note">
              Opens are tracked with a lightweight image. Some mail clients pre-fetch images, so treat opens as a strong
              signal rather than proof.
            </p>
          </div>
        </section>

        <section className="landing-section" id="how">
          <div className="landing-section-head">
            <span className="landing-kicker">How it works</span>
            <h2>Set it up once. Then approve, not assemble.</h2>
          </div>
          <div className="landing-steps">
            {STEPS.map((step) => (
              <article key={step.n} className="landing-step">
                <span className="landing-step-n">{step.n}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="landing-proof">
          {PROOF.map((item) => (
            <div key={item.label}>
              <strong>{item.value}</strong>
              <span>{item.label}</span>
            </div>
          ))}
        </section>

        <section className="landing-quote">
          <blockquote>
            “The open notifications changed how I follow up. I used to guess who was warm. Now I know exactly which
            email to answer first.”
          </blockquote>
          <div className="landing-quote-by">
            <span className="landing-quote-avatar">AO</span>
            <div>
              <strong>Alex O.</strong>
              <span>Founder, boutique web studio</span>
            </div>
          </div>
        </section>

        <section className="landing-final" id="security">
          <div>
            <span className="landing-kicker">Private by default</span>
            <h2>Your Gmail. Your knowledge. Your workspace.</h2>
            <p>
              Each account is isolated in Cloud Firestore with row-level rules. Tokens never touch local storage, and
              nothing leaves your outbox until you approve it.
            </p>
            <ul className="landing-checks">
              <li>
                <ShieldCheck size={15} />
                <span>Per-account isolation on every request.</span>
              </li>
              <li>
                <CheckCircle2 size={15} />
                <span>Approval required before any email is sent.</span>
              </li>
              <li>
                <CheckCircle2 size={15} />
                <span>Suppression, unsubscribe and bounce handling built in.</span>
              </li>
            </ul>
          </div>
          <div className="landing-final-cta">
            <span className="landing-pill">
              <Sparkles size={13} /> Ready in one Google sign-in
            </span>
            <h3>Start with a prospect list you already have.</h3>
            <button type="button" className="btn landing-cta" onClick={onSignUp}>
              Create your workspace
              <ArrowRight size={15} />
            </button>
            <button type="button" className="btn landing-cta-ghost" onClick={onSignIn}>
              Sign in instead
            </button>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-brand">
          <img src="/brand/knowrevo-logo-t.png" alt="Knowrevo" className="landing-logo" />
        </div>
        <span className="landing-footer-note">
          Research → qualify → write → send → know what happened.
        </span>
        <div className="landing-footer-links">
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
