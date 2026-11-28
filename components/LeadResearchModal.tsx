"use client";

import type { Lead } from "@/lib/types";

/**
 * Read-only "View Research & Contact" panel.
 *
 * Rendered above the review drawer (z-index 80) with fixed positioning, so the
 * drawer and every unsaved edit underneath stay mounted and untouched. Closing
 * this modal returns to the exact email being reviewed.
 */

function hostOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  const value = url.trim();
  if (/^(?:https?:\/\/|mailto:|tel:)/i.test(value)) return value;
  if (/^[\w.-]+\.[a-z]{2,}/i.test(value)) return `https://${value}`;
  return null;
}

function LinkRow({ label, href, text }: { label: string; href: string | null; text: string }) {
  return (
    <div className="tiny" style={{ display: "flex", gap: 6 }}>
      <span className="strong" style={{ minWidth: 74 }}>{label}</span>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" style={{ wordBreak: "break-all" }}>
          {text}
        </a>
      ) : (
        <span style={{ wordBreak: "break-all" }}>{text}</span>
      )}
    </div>
  );
}

export function LeadResearchModal({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const research = lead.research;
  const score = research?.score ?? lead.score;
  const tier = research?.tier ?? lead.score_reason?.tier;
  const emailType = research?.email_type;
  const socials = research?.socials ?? [];
  const evidence = research?.audit_evidence ?? [];
  const issues = research?.verified_site_issues ?? [];
  const sources = research?.contact_source_urls ?? [];
  const websiteHref = safeHref(lead.website);
  const phoneHref = lead.phone ? `tel:${lead.phone.replace(/[^\d+]/g, "")}` : null;

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(9, 16, 20, 0.55)",
        zIndex: 80,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Lead research and contact"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(720px, 100%)",
          maxHeight: "90vh",
          overflowY: "auto",
          background: "var(--surface)",
          border: "1px solid var(--line)",
          borderRadius: 14,
          padding: "18px 20px 24px",
          boxShadow: "0 24px 60px rgba(0,0,0,0.28)",
        }}
      >
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div>
            <div className="strong" style={{ fontSize: 17 }}>
              {lead.business || lead.contact_name || lead.email || "Prospect"}
            </div>
            <div className="tiny">
              {[lead.contact_name, lead.role, lead.industry, lead.location].filter(Boolean).join(" · ") ||
                "Research & contact details"}
            </div>
          </div>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close research details">
            Close
          </button>
        </div>

        <div className="card" style={{ marginTop: 14, padding: 12 }}>
          <div className="strong" style={{ marginBottom: 8 }}>Contact</div>
          <div className="stack" style={{ gap: 4 }}>
            <LinkRow label="Name" href={null} text={lead.contact_name || "—"} />
            <LinkRow label="Role" href={null} text={lead.role || "—"} />
            <LinkRow
              label="Email"
              href={lead.email ? `mailto:${lead.email}` : null}
              text={lead.email || "No verified email"}
            />
            <div className="tiny" style={{ marginLeft: 80, display: "flex", gap: 6, flexWrap: "wrap" }}>
              {emailType === "direct" && <span className="badge badge-ok">Direct</span>}
              {emailType === "role_inbox" && <span className="badge badge-warn">Role inbox</span>}
              {research?.mx_verified && <span className="badge badge-ok">MX verified</span>}
              {research?.contact_verification_status && (
                <span className="badge">{research.contact_verification_status}</span>
              )}
            </div>
            <LinkRow label="Phone" href={phoneHref} text={lead.phone || "—"} />
            <LinkRow label="Website" href={websiteHref} text={lead.website ? hostOf(lead.website) : "—"} />
            <LinkRow label="Location" href={null} text={lead.location || "—"} />
            {socials.map((social) => (
              <LinkRow
                key={`${social.platform}-${social.url}`}
                label={social.platform || "Social"}
                href={safeHref(social.url)}
                text={social.url}
              />
            ))}
          </div>
        </div>

        <div className="card" style={{ marginTop: 12, padding: 12 }}>
          <div className="strong" style={{ marginBottom: 8 }}>Website audit proof</div>
          <div className="stack" style={{ gap: 6 }}>
            <div className="tiny">
              Website status: <strong>{research?.website_status ?? "not checked"}</strong>
              {typeof score === "number" ? ` · Qualification score: ${score}` : ""}
              {tier ? ` · Tier ${tier}` : ""}
            </div>
            {issues.length > 0 ? (
              <ul className="tiny" style={{ margin: 0, paddingLeft: 18 }}>
                {issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            ) : (
              <div className="tiny">No verified site issues recorded.</div>
            )}
            {evidence.length > 0 && (
              <div className="stack" style={{ gap: 4, marginTop: 4 }}>
                {evidence.map((item, index) => (
                  <div key={`${item.issue}-${index}`} className="tiny">
                    <strong>{item.issue}</strong>{" "}
                    <span className="badge">{item.evidence_type.replace(/_/g, " ")}</span>
                    <div style={{ opacity: 0.85 }}>{item.proof}</div>
                  </div>
                ))}
              </div>
            )}
            {research?.website_facts?.length ? (
              <div className="tiny">
                <strong>Observed on site:</strong> {research.website_facts.slice(0, 6).join(" · ")}
              </div>
            ) : null}
            {research?.mobile_screenshot_url ? (
              <div>
                {/* Audit capture stored by the research worker. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={research.mobile_screenshot_url}
                  alt="Captured mobile view of the prospect site"
                  loading="lazy"
                  style={{ width: "100%", maxWidth: 260, border: "1px solid var(--line)", borderRadius: 8 }}
                />
              </div>
            ) : null}
          </div>
        </div>

        <div className="card" style={{ marginTop: 12, padding: 12 }}>
          <div className="strong" style={{ marginBottom: 8 }}>Research summary</div>
          <div className="stack" style={{ gap: 6 }}>
            <div className="tiny">{research?.summary || lead.manual_research || "No research summary recorded."}</div>
            {lead.score_reason?.reasons?.length ? (
              <ul className="tiny" style={{ margin: 0, paddingLeft: 18 }}>
                {lead.score_reason.reasons.slice(0, 6).map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : null}
            {research?.personalized_hook_candidates?.length ? (
              <div className="tiny">
                <strong>Hooks:</strong> {research.personalized_hook_candidates.slice(0, 3).join(" · ")}
              </div>
            ) : null}
            {research?.recommended_angle ? (
              <div className="tiny"><strong>Angle:</strong> {research.recommended_angle}</div>
            ) : null}
            {sources.length > 0 && (
              <div className="tiny stack" style={{ gap: 2 }}>
                <strong>Contact proof sources</strong>
                {sources.map((source) => (
                  <div key={`${source.channel}-${source.value}`}>
                    {source.channel}: {source.value} —{" "}
                    <a href={source.sourceUrl} target="_blank" rel="noopener noreferrer">
                      {hostOf(source.sourceUrl)}
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
