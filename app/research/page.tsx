"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Building2,
  ChevronDown,
  ExternalLink,
  Globe,
  Mail,
  MapPin,
  MessageCircle,
  Phone,
  ShieldQuestion,
} from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { BatchRunner } from "@/components/Runner";
import { BrandLoader } from "@/components/BrandLoader";
import { CriteriaForm } from "@/components/CriteriaForm";
import { LocationPicker } from "@/components/LocationPicker";
import { Badge, Banner, Card, Empty } from "@/components/ui";
import { DEFAULT_CRITERIA, criteriaToFocus, type ResearchCriteria } from "@/lib/criteria";
import { EMPTY_GEO, geoSummary, rememberLocation, type GeoSelection } from "@/lib/geo";
import { authedPost, errorMessage } from "@/lib/client";
import { buildLiveKnowledgeDigest } from "@/lib/pipeline-client";
import { createLead, getSettings, listCampaigns, listLeads } from "@/lib/store";
import { label, statusTone } from "@/lib/format";
import type { Campaign, Lead } from "@/lib/types";

interface Candidate {
  business: string;
  website: string;
  location: string;
  industry: string;
  why: string;
  source_url: string;
  contact: {
    decision_maker: string;
    role: string;
    email: string;
    phone: string;
    whatsapp: string;
    address: string;
    socials: { platform: string; url: string }[];
    sources: { field: string; url: string; confidence: "high" | "medium" | "low" }[];
  };
  issues: { area: string; problem: string; evidence: string; severity: "high" | "medium" | "low" }[];
  how_we_help: { issue: string; service: string; angle: string }[];
  selected?: boolean;
}

interface GroundingLink {
  uri: string;
  title: string;
}

const NOT_FOUND = "Not found";

function ContactRow({
  icon,
  label: fieldLabel,
  value,
  href,
  confidence,
  sourceUrl,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  href?: string;
  confidence?: string;
  sourceUrl?: string;
}) {
  return (
    <div className="prospect-contact-row" data-missing={value ? "false" : "true"}>
      <span className="prospect-contact-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="prospect-contact-label">{fieldLabel}</span>
      {value ? (
        href ? (
          <a className="prospect-contact-value" href={href} target="_blank" rel="noreferrer">
            {value}
          </a>
        ) : (
          <span className="prospect-contact-value">{value}</span>
        )
      ) : (
        <span className="prospect-contact-value muted">{NOT_FOUND}</span>
      )}
      {value && confidence ? (
        <span className="prospect-confidence" data-level={confidence}>
          {confidence}
        </span>
      ) : null}
      {value && sourceUrl ? (
        <a className="prospect-source-link" href={sourceUrl} target="_blank" rel="noreferrer" title="Open the source">
          <ExternalLink size={10} aria-hidden="true" />
          <span className="sr-only">Source for {fieldLabel}</span>
        </a>
      ) : null}
    </div>
  );
}

function ProspectCard({
  candidate,
  onToggle,
}: {
  candidate: Candidate;
  onToggle: (selected: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const sourcesFor = (field: string) => candidate.contact.sources.find((source) => source.field.toLowerCase() === field.toLowerCase());

  return (
    <article className="prospect" data-selected={candidate.selected ? "true" : "false"}>
      <div className="prospect-head">
        <label className="prospect-check">
          <input
            type="checkbox"
            checked={Boolean(candidate.selected)}
            onChange={(event) => onToggle(event.target.checked)}
            aria-label={`Select ${candidate.business}`}
          />
        </label>
        <div className="prospect-title">
          <h3>{candidate.business || "Unnamed business"}</h3>
          <div className="prospect-meta">
            {candidate.industry ? <Badge>{candidate.industry}</Badge> : null}
            {candidate.location ? (
              <span className="tiny">
                <MapPin size={11} aria-hidden="true" /> {candidate.location}
              </span>
            ) : null}
            {candidate.website ? (
              <a className="tiny" href={candidate.website} target="_blank" rel="noreferrer">
                <Globe size={11} aria-hidden="true" /> {candidate.website.replace(/^https?:\/\//, "")}
              </a>
            ) : (
              <span className="tiny muted">No website found</span>
            )}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <ChevronDown size={13} style={{ transform: open ? "rotate(180deg)" : "none" }} aria-hidden="true" />
          <span>{open ? "Hide detail" : "Full detail"}</span>
        </button>
      </div>

      {candidate.why ? <p className="prospect-why">{candidate.why}</p> : null}

      {candidate.issues.length > 0 ? (
        <div className="prospect-issues">
          {candidate.issues.slice(0, open ? candidate.issues.length : 2).map((issue, index) => (
            <div key={`${issue.area}-${index}`} className="prospect-issue" data-severity={issue.severity}>
              <span className="prospect-issue-area">{issue.area || "Issue"}</span>
              <span className="prospect-issue-problem">{issue.problem}</span>
              {issue.evidence ? <span className="prospect-issue-evidence">{issue.evidence}</span> : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="tiny muted">No verifiable weaknesses were found in the search results.</p>
      )}

      {open ? (
        <div className="prospect-detail">
          <div className="prospect-section">
            <div className="prospect-section-title">Contact details</div>
            <div className="prospect-contacts">
              <ContactRow
                icon={<Building2 size={12} />}
                label="Decision-maker"
                value={
                  candidate.contact.decision_maker
                    ? `${candidate.contact.decision_maker}${candidate.contact.role ? ` · ${candidate.contact.role}` : ""}`
                    : ""
                }
                confidence={sourcesFor("decision_maker")?.confidence}
                sourceUrl={sourcesFor("decision_maker")?.url}
              />
              <ContactRow
                icon={<Mail size={12} />}
                label="Email"
                value={candidate.contact.email}
                href={candidate.contact.email ? `mailto:${candidate.contact.email}` : undefined}
                confidence={sourcesFor("email")?.confidence}
                sourceUrl={sourcesFor("email")?.url}
              />
              <ContactRow
                icon={<Phone size={12} />}
                label="Phone"
                value={candidate.contact.phone}
                href={candidate.contact.phone ? `tel:${candidate.contact.phone}` : undefined}
                confidence={sourcesFor("phone")?.confidence}
                sourceUrl={sourcesFor("phone")?.url}
              />
              <ContactRow
                icon={<MessageCircle size={12} />}
                label="WhatsApp"
                value={candidate.contact.whatsapp}
                confidence={sourcesFor("whatsapp")?.confidence}
                sourceUrl={sourcesFor("whatsapp")?.url}
              />
              <ContactRow
                icon={<MapPin size={12} />}
                label="Address"
                value={candidate.contact.address}
                confidence={sourcesFor("address")?.confidence}
                sourceUrl={sourcesFor("address")?.url}
              />
              <ContactRow
                icon={<Globe size={12} />}
                label="Website"
                value={candidate.website}
                href={candidate.website || undefined}
                confidence={sourcesFor("website")?.confidence}
                sourceUrl={sourcesFor("website")?.url}
              />
            </div>
            {candidate.contact.socials.length > 0 ? (
              <div className="prospect-socials">
                {candidate.contact.socials.map((social) => (
                  <a key={social.url} className="tiny" href={social.url} target="_blank" rel="noreferrer">
                    <ExternalLink size={11} aria-hidden="true" /> {social.platform || "Profile"}
                  </a>
                ))}
              </div>
            ) : (
              <p className="tiny muted">No social profiles found.</p>
            )}
            {candidate.contact.sources.length > 0 ? (
              <details className="prospect-sources">
                <summary className="tiny">Where these details came from ({candidate.contact.sources.length})</summary>
                <ul>
                  {candidate.contact.sources.map((source, index) => (
                    <li key={`${source.field}-${index}`} className="tiny">
                      <strong>{source.field || "detail"}</strong> · {source.confidence} confidence ·{" "}
                      <a href={source.url} target="_blank" rel="noreferrer">
                        source
                      </a>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>

          <div className="prospect-section">
            <div className="prospect-section-title">How we can help</div>
            {candidate.how_we_help.length === 0 ? (
              <p className="tiny muted">No service match yet — the knowledge base has no services to map these issues to.</p>
            ) : (
              <ul className="prospect-help">
                {candidate.how_we_help.map((help, index) => (
                  <li key={`${help.service}-${index}`}>
                    <span className="prospect-help-service">{help.service}</span>
                    {help.issue ? <span className="prospect-help-issue">fixes: {help.issue}</span> : null}
                    {help.angle ? <span className="prospect-help-angle">{help.angle}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {candidate.source_url ? (
            <p className="tiny muted">
              <ShieldQuestion size={11} aria-hidden="true" /> Found via{" "}
              <a href={candidate.source_url} target="_blank" rel="noreferrer">
                {candidate.source_url.replace(/^https?:\/\//, "").slice(0, 70)}
              </a>
            </p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export default function ResearchPage() {
  const { user } = useAuth();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [campaignId, setCampaignId] = useState("");

  const [criteria, setCriteria] = useState<ResearchCriteria>(DEFAULT_CRITERIA);
  const [geo, setGeo] = useState<GeoSelection>(EMPTY_GEO);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [groundingUrls, setGroundingUrls] = useState<GroundingLink[]>([]);
  const [notes, setNotes] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastBrief, setLastBrief] = useState<string[]>([]);

  const reload = useCallback(async () => {
    try {
      const [c, l] = await Promise.all([listCampaigns(user.uid), listLeads(user.uid)]);
      setCampaigns(c);
      setLeads(l);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [user.uid]);

  useEffect(() => {
    let active = true;
    Promise.all([listCampaigns(user.uid), listLeads(user.uid)]).then(
      ([c, l]) => {
        if (!active) return;
        setCampaigns(c);
        setLeads(l);
      },
      (err) => {
        if (!active) return;
        setError(errorMessage(err));
      },
    );
    return () => {
      active = false;
    };
  }, [user.uid]);

  const active = campaigns.find((c) => c.id === campaignId);
  const activeCounts = useMemo(() => {
    const campLeads = leads.filter((l) => l.campaign_id === campaignId);
    return {
      leads: campLeads.length,
      researched: campLeads.filter((l) => Boolean(l.research_at)).length,
      qualified: campLeads.filter((l) =>
        ["qualified", "email_generated", "approved", "sent", "replied", "converted", "followup_pending"].includes(
          l.status,
        ),
      ).length,
    };
  }, [leads, campaignId]);

  const discover = async () => {
    setBusy("discover");
    setError(null);
    setNotice(null);
    try {
      const settings = await getSettings(user.uid);
      const knowledge = await buildLiveKnowledgeDigest(user.uid).catch(() => "");
      const focus = criteriaToFocus(criteria);
      const result = await authedPost<{
        candidates: Candidate[];
        notes: string;
        groundingUrls?: GroundingLink[];
      }>("/api/ai/discover", {
        industry: criteria.industry,
        location: geoSummary(geo),
        count: criteria.count,
        focus,
        knowledge,
        model: settings.model,
      });
      setCandidates(result.candidates ?? []);
      setGroundingUrls(result.groundingUrls ?? []);
      setNotes(result.notes ?? null);
      setLastBrief([
        criteria.industry || "Any segment",
        geoSummary(geo) || "Any location",
        criteria.onlinePresence,
        ...criteria.services,
      ].filter((item) => item && item !== "Any presence"));
      rememberLocation(geo);
      if ((result.candidates ?? []).length === 0) {
        setNotice("No prospects came back for that brief. Widen the filters or the location and try again.");
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const saveSelected = async () => {
    const selected = candidates.filter((c) => c.selected);
    if (!selected.length) {
      setError("Select at least one candidate to save.");
      return;
    }
    setBusy("save");
    setError(null);
    try {
      let created = 0;
      let duplicates = 0;
      for (const c of selected) {
        const detail = [
          c.why ? `Discovery note: ${c.why}` : "",
          c.contact.decision_maker ? `Decision-maker: ${c.contact.decision_maker} (${c.contact.role || "role unknown"})` : "",
          c.contact.address ? `Address: ${c.contact.address}` : "",
          c.contact.whatsapp ? `WhatsApp: ${c.contact.whatsapp}` : "",
          c.contact.socials.length ? `Socials: ${c.contact.socials.map((s) => s.url).join(", ")}` : "",
          c.issues.length ? `Issues: ${c.issues.map((i) => `${i.area}: ${i.problem}`).join(" | ")}` : "",
          c.how_we_help.length ? `How we help: ${c.how_we_help.map((h) => h.service).join(", ")}` : "",
          c.source_url ? `Source: ${c.source_url}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        const res = await createLead(user.uid, {
          business: c.business,
          contact_name: c.contact.decision_maker,
          role: c.contact.role,
          email: c.contact.email,
          phone: c.contact.phone || c.contact.whatsapp,
          website: c.website,
          location: c.location || geoSummary(geo),
          industry: c.industry || criteria.industry,
          notes: detail,
          source: "gemini_search",
          campaignId: campaignId || null,
        });
        if (res.duplicate) duplicates += 1;
        else created += 1;
      }
      setNotice(
        `Saved ${created} new prospects${duplicates ? `, ${duplicates} already existed` : ""}${campaignId ? " and queued for the selected campaign" : ""}.`,
      );
      setCandidates((prev) => prev.filter((c) => !c.selected));
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const selectedCount = candidates.filter((c) => c.selected).length;

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Prospect research</h1>
          <p className="page-sub">
            Search real businesses, then audit what is actually verifiable: contact details with sources, what is weak,
            and which of your services fixes it. Anything the search could not confirm is marked “Not found” instead of
            invented.
          </p>
        </div>
      </div>

      <div className="stack">
        {error && <Banner tone="bad">{error}</Banner>}
        {notice && <Banner tone="ok">{notice}</Banner>}

        <Card title="Research queue" sub="Runs in small, resumable batches so nothing is lost if you close the tab.">
          <div className="row" style={{ marginBottom: 14 }}>
            <select
              className="select"
              style={{ maxWidth: 380 }}
              value={campaignId}
              onChange={(e) => setCampaignId(e.target.value)}
              aria-label="Campaign"
            >
              <option value="">Select a campaign…</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <Link className="btn btn-sm" href="/campaigns">
              New campaign
            </Link>
          </div>

          {!campaignId ? (
            <Empty title="Select a campaign">
              Research is scoped to a campaign so results stay grouped and every prospect can be traced back to the
              outreach it belongs to.
            </Empty>
          ) : (
            <>
              <div className="row" style={{ marginBottom: 14 }}>
                <Badge tone={statusTone(active?.status ?? "")}>{label(active?.status ?? "")}</Badge>
                <Badge>Leads: {activeCounts.leads}</Badge>
                <Badge>Researched: {activeCounts.researched}</Badge>
                <Badge>Qualified: {activeCounts.qualified}</Badge>
                <Badge>Min score: {active?.config.min_score ?? "—"}</Badge>
              </div>
              <p className="hint" style={{ marginBottom: 10 }}>
                Do these in order. Each run saves as it goes, so you can stop at any point and continue later.
              </p>
              <div className="row">
                <BatchRunner
                  type="research"
                  campaignId={campaignId}
                  label="1 · Research"
                  limit={2}
                  variant="primary"
                  onDone={reload}
                />
                <BatchRunner type="qualify" campaignId={campaignId} label="2 · Qualify" limit={3} onDone={reload} />
                <BatchRunner type="compose" campaignId={campaignId} label="3 · Write emails" limit={2} onDone={reload} />
                <Link className="btn btn-sm" href="/review">
                  4 · Review and send
                </Link>
              </div>
              <p className="hint" style={{ marginTop: 10 }}>
                Research uses the stored website URL. When no website is known it stays honest and marks the record as
                needing more information instead of inventing problems.
              </p>
            </>
          )}
        </Card>

        <Card
          title="Find new prospects"
          sub="Live Google Search plus your knowledge base. Every contact detail carries its source and confidence."
        >
          <div className="discover-inputs">
            <LocationPicker value={geo} onChange={setGeo} title="Target location" />
            <CriteriaForm
              value={criteria}
              onChange={setCriteria}
              uid={user.uid}
              busy={busy !== null}
              onAutoResult={(next) => setCriteria(next)}
            />
          </div>

          <div className="row" style={{ marginTop: 14 }}>
            <button
              className="btn btn-primary"
              onClick={() => void discover()}
              disabled={busy !== null}
              type="button"
            >
              {busy === "discover" ? "Searching…" : "Discover prospects"}
            </button>
            {candidates.length > 0 && (
              <button className="btn" onClick={() => void saveSelected()} disabled={busy !== null} type="button">
                Save selected ({selectedCount})
              </button>
            )}
            {candidates.length > 0 && (
              <button
                className="btn btn-sm btn-ghost"
                type="button"
                onClick={() =>
                  setCandidates((prev) =>
                    prev.map((item) => ({ ...item, selected: selectedCount !== prev.length })),
                  )
                }
              >
                {selectedCount === candidates.length ? "Deselect all" : "Select all"}
              </button>
            )}
          </div>

          {busy === "discover" && (
            <div style={{ marginTop: 12, display: "grid", placeItems: "center", padding: "12px 0" }}>
              <BrandLoader />
            </div>
          )}

          {notes && (
            <p className="tiny" style={{ marginTop: 10 }}>
              {notes}
            </p>
          )}

          {candidates.length > 0 && lastBrief.length > 0 && (
            <div className="row" style={{ marginTop: 12, gap: 6 }}>
              <span className="tiny strong">Brief:</span>
              {lastBrief.map((item) => (
                <Badge key={item}>{item}</Badge>
              ))}
            </div>
          )}

          {candidates.length > 0 && (
            <div className="prospect-list">
              {candidates.map((candidate, index) => (
                <ProspectCard
                  key={`${candidate.business}-${index}`}
                  candidate={candidate}
                  onToggle={(selected) =>
                    setCandidates((prev) => prev.map((item, i) => (i === index ? { ...item, selected } : item)))
                  }
                />
              ))}
            </div>
          )}

          {groundingUrls.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="tiny strong" style={{ marginBottom: 4 }}>
                Google Search sources
              </div>
              <div className="row" style={{ gap: 8 }}>
                {groundingUrls.slice(0, 8).map((src, idx) => (
                  <a key={idx} className="tiny" href={src.uri} target="_blank" rel="noreferrer">
                    {src.title || src.uri}
                  </a>
                ))}
              </div>
            </div>
          )}
        </Card>
      </div>
    </main>
  );
}
