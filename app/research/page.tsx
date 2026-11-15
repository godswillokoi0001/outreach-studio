"use client";

import { useState } from "react";
import Link from "next/link";
import { api, errorMessage, useApi } from "@/lib/client";
import { Badge, Banner, Card, Empty, Field } from "@/components/ui";
import { BatchRunner } from "@/components/Runner";
import { label, statusTone } from "@/lib/format";

interface CampaignRow {
  id: string;
  name: string;
  status: string;
  leads: number;
  researched: number;
  qualified: number;
  pending: number;
  config: { target_industry?: string; min_score?: number; services?: string[] };
}

interface Candidate {
  business: string;
  website: string;
  location: string;
  industry: string;
  why: string;
  source_url: string;
  selected?: boolean;
}

export default function ResearchPage() {
  const campaigns = useApi<{ campaigns: CampaignRow[] }>("/api/campaigns");
  const [campaignId, setCampaignId] = useState("");
  const active = campaigns.data?.campaigns.find((c) => c.id === campaignId);

  const [industry, setIndustry] = useState("");
  const [location, setLocation] = useState("Nigeria");
  const [count, setCount] = useState(8);
  const [focus, setFocus] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [notes, setNotes] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const discover = async () => {
    setBusy("discover");
    setError(null);
    setNotice(null);
    try {
      const result = await api.post<{ candidates: Candidate[]; notes: string }>("/api/discovery", {
        industry,
        location,
        count,
        focus,
      });
      setCandidates(result.candidates ?? []);
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
      const result = await api.post<{ created: number; duplicates: number }>("/api/discovery", {
        action: "save",
        candidates: selected.map((c) => ({ ...c, notes: `Discovery note: ${c.why} (source: ${c.source_url})` })),
      });
      setNotice(`Saved ${result.created} new prospects${result.duplicates ? `, ${result.duplicates} already existed` : ""}.`);
      setCandidates((prev) => prev.filter((c) => !c.selected));
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
            The app fetches each prospect's website, records what it can actually verify, separates facts from
            inferences, then scores the opportunity. Nothing is invented: if the evidence is thin it says so.
          </p>
        </div>
      </div>

      <div className="stack">
        {error && <Banner tone="bad">{error}</Banner>}
        {notice && <Banner tone="ok">{notice}</Banner>}

        <Card title="Research queue" sub="Runs in small, resumable batches so nothing is lost if you close the tab.">
          <div className="row" style={{ marginBottom: 14 }}>
            <select className="select" style={{ maxWidth: 380 }} value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
              <option value="">Select a campaign…</option>
              {(campaigns.data?.campaigns ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <Link className="btn btn-sm" href="/campaigns">New campaign</Link>
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
                <Badge>Leads: {active?.leads ?? 0}</Badge>
                <Badge>Researched: {active?.researched ?? 0}</Badge>
                <Badge>Qualified: {active?.qualified ?? 0}</Badge>
                <Badge>Min score: {active?.config.min_score ?? "—"}</Badge>
              </div>
              <div className="row">
                <BatchRunner
                  type="research"
                  campaignId={campaignId}
                  label="Run research"
                  limit={2}
                  variant="primary"
                  onDone={() => void campaigns.reload()}
                />
                <BatchRunner
                  type="qualify"
                  campaignId={campaignId}
                  label="Run qualification"
                  limit={3}
                  onDone={() => void campaigns.reload()}
                />
                <BatchRunner
                  type="compose"
                  campaignId={campaignId}
                  label="Generate emails"
                  limit={2}
                  onDone={() => void campaigns.reload()}
                />
                <Link className="btn btn-sm" href="/review">Open email review</Link>
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
          sub="Uses Gemini with Google Search grounding. Candidates are real businesses found in search results - verify before contacting."
        >
          <div className="grid grid-3" style={{ marginBottom: 10 }}>
            <Field label="Segment or industry">
              <input className="input" value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="e.g. microfinance banks, private schools" />
            </Field>
            <Field label="Location">
              <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} />
            </Field>
            <Field label="How many">
              <input className="input" type="number" min={3} max={20} value={count} onChange={(e) => setCount(Number(e.target.value))} />
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
            <button className="btn btn-primary" onClick={discover} disabled={busy !== null} type="button">
              {busy === "discover" ? "Searching…" : "Discover prospects"}
            </button>
            {candidates.length > 0 && (
              <button className="btn" onClick={saveSelected} disabled={busy !== null} type="button">
                Save selected ({candidates.filter((c) => c.selected).length})
              </button>
            )}
          </div>
          {notes && <p className="tiny" style={{ marginTop: 10 }}>{notes}</p>}

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
                      <td className="strong">{candidate.business}<div className="tiny">{candidate.location}</div></td>
                      <td className="tiny">
                        {candidate.website ? (
                          <a href={candidate.website} target="_blank" rel="noreferrer">{candidate.website.replace(/^https?:\/\//, "")}</a>
                        ) : "not verified"}
                      </td>
                      <td>{candidate.industry}</td>
                      <td className="tiny wrap">{candidate.why}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </main>
  );
}
