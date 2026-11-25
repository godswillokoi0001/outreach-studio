"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";
import { BatchRunner } from "@/components/Runner";
import { LoadingPanel } from "@/components/Loading";
import { Badge, Banner, Card, Empty, Field } from "@/components/ui";
import { authedPost, errorMessage } from "@/lib/client";
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
  selected?: boolean;
}

interface GroundingLink {
  uri: string;
  title: string;
}

export default function ResearchPage() {
  const { user } = useAuth();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [campaignId, setCampaignId] = useState("");

  const [industry, setIndustry] = useState("");
  const [location, setLocation] = useState("Nigeria");
  const [count, setCount] = useState(8);
  const [focus, setFocus] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [groundingUrls, setGroundingUrls] = useState<GroundingLink[]>([]);
  const [notes, setNotes] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
      const result = await authedPost<{
        candidates: Candidate[];
        notes: string;
        groundingUrls?: GroundingLink[];
      }>("/api/ai/discover", {
        industry,
        location,
        count,
        focus,
        model: settings.model,
      });
      setCandidates(result.candidates ?? []);
      setGroundingUrls(result.groundingUrls ?? []);
      setNotes(result.notes ?? null);
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
        const res = await createLead(user.uid, {
          business: c.business,
          website: c.website,
          location: c.location,
          industry: c.industry,
          notes: `Discovery note: ${c.why} (source: ${c.source_url})`,
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

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Prospect research</h1>
          <p className="page-sub">
            The app fetches each prospect&apos;s website, records what it can actually verify, separates facts from
            inferences, then scores the opportunity. Nothing is invented: if the evidence is thin it says so.
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
                <BatchRunner
                  type="qualify"
                  campaignId={campaignId}
                  label="2 · Qualify"
                  limit={3}
                  onDone={reload}
                />
                <BatchRunner
                  type="compose"
                  campaignId={campaignId}
                  label="3 · Write emails"
                  limit={2}
                  onDone={reload}
                />
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
          sub="Uses Gemini with Google Search grounding. Candidates are real businesses found in search results — verify before contacting."
        >
          <div className="grid grid-3" style={{ marginBottom: 10 }}>
            <Field label="Segment or industry">
              <input
                className="input"
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                placeholder="e.g. microfinance banks, private schools"
              />
            </Field>
            <Field label="Location">
              <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} />
            </Field>
            <Field label="How many">
              <input
                className="input"
                type="number"
                min={3}
                max={20}
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
              />
            </Field>
          </div>
          <Field label="Extra focus (optional)">
            <input
              className="input"
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              placeholder="e.g. businesses whose site is not mobile friendly, or that only have a Facebook page"
            />
          </Field>
          <div className="row">
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
                Save selected ({candidates.filter((c) => c.selected).length})
              </button>
            )}
          </div>
          {busy === "discover" && (
            <div style={{ marginTop: 12 }}>
              <LoadingPanel
                label="Searching for real businesses"
                hint="Gemini searches the web, then checks each candidate before showing it."
                estimateMs={32_000}
                steps={[
                  { label: "Building the search queries", ms: 4_000 },
                  { label: "Reading search results", ms: 14_000 },
                  { label: "Checking candidate websites", ms: 9_000 },
                  { label: "Ranking by fit", ms: 5_000 },
                ]}
              />
            </div>
          )}
          {notes && (
            <p className="tiny" style={{ marginTop: 10 }}>
              {notes}
            </p>
          )}

          {candidates.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 14 }}>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 34 }} />
                    <th>Business</th>
                    <th>Website</th>
                    <th>Industry</th>
                    <th>Why it may fit</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((candidate, index) => (
                    <tr key={`${candidate.business}-${index}`}>
                      <td>
                        <input
                          type="checkbox"
                          checked={Boolean(candidate.selected)}
                          onChange={(e) =>
                            setCandidates((prev) =>
                              prev.map((item, i) => (i === index ? { ...item, selected: e.target.checked } : item)),
                            )
                          }
                        />
                      </td>
                      <td className="strong">
                        {candidate.business}
                        <div className="tiny">{candidate.location}</div>
                      </td>
                      <td className="tiny">
                        {candidate.website ? (
                          <a href={candidate.website} target="_blank" rel="noreferrer">
                            {candidate.website.replace(/^https?:\/\//, "")}
                          </a>
                        ) : (
                          "not verified"
                        )}
                      </td>
                      <td>{candidate.industry}</td>
                      <td className="tiny wrap">{candidate.why}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
