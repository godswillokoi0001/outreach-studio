"use client";

import { useState } from "react";
import { api, useApi, errorMessage } from "@/lib/client";
import { Badge, Banner, Card, Empty, Field, Modal, Pager, Progress } from "@/components/ui";
import { fmtDate, label, priorityTone, scoreClass, statusTone } from "@/lib/format";
import type { Lead, ResearchResult } from "@/lib/types";

interface LeadsResponse {
  leads: Lead[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<string, number>;
  industries: string[];
}

interface Qualification {
  reasons?: string[];
  opportunity?: string;
  value_tier?: string;
  recommended_service?: string;
  disqualify_reason?: string;
}

const STATUS_OPTIONS = [
  ["all", "All leads"],
  ["new", "Unprocessed"],
  ["queued_research", "Awaiting research"],
  ["researched", "Researched"],
  ["qualified", "Qualified"],
  ["email_generated", "Email drafted"],
  ["approved", "Approved"],
  ["sent", "Sent"],
  ["replied,converted", "Replied"],
  ["followup_pending", "Follow-up pending"],
  ["disqualified,needs_research", "Disqualified / needs research"],
  ["suppressed,unsubscribed,bounced", "Suppressed / bounced"],
] as const;

export default function LeadsPage() {
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Lead | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const params = new URLSearchParams({ status, q: query, page: String(page), pageSize: "20" });
  const { data, loading, error, reload } = useApi<LeadsResponse>(`/api/leads?${params.toString()}`, [status, query, page]);

  const update = async (id: string, body: Record<string, unknown>) => {
    setBusy(id);
    setNotice(null);
    try {
      await api.patch("/api/leads", { id, ...body });
      await reload();
      if (selected?.id === id) {
        const next = await api.get<LeadsResponse>(`/api/leads?status=all&q=${encodeURIComponent(selected.email ?? "")}&page=1&pageSize=5`);
        setSelected(next.leads.find((l) => l.id === id) ?? null);
      }
      setNotice("Saved.");
    } catch (err) {
      setNotice(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (lead: Lead) => {
    if (!window.confirm(`Delete ${lead.business ?? lead.email} and all its messages and replies? This cannot be undone.`)) return;
    try {
      await api.del(`/api/leads?id=${lead.id}`);
      setSelected(null);
      await reload();
    } catch (err) {
      setNotice(errorMessage(err));
    }
  };

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Leads</h1>
          <p className="page-sub">
            Every prospect in one place with its research, score and outreach history. Add manual notes or extra
            research to improve the copy the AI writes.
          </p>
        </div>
      </div>

      <div className="stack">
        <Card tight>
          <div className="row" style={{ padding: "14px 16px", gap: 10 }}>
            <select className="select" style={{ width: 210 }} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              {STATUS_OPTIONS.map(([value, text]) => (
                <option key={value} value={value}>
                  {text}{value !== "all" ? ` (${data?.counts[value.split(",")[0]] ?? 0})` : ""}
                </option>
              ))}
            </select>
            <input
              className="input"
              style={{ maxWidth: 320 }}
              placeholder="Search business, email, contact or industry"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setQuery(search);
                  setPage(1);
                }
              }}
            />
            <button className="btn" type="button" onClick={() => { setQuery(search); setPage(1); }}>
              Search
            </button>
            <div className="row-end">
              <span className="tiny">{data ? `${data.total} leads` : ""}</span>
            </div>
          </div>

          {notice && <div style={{ padding: "0 16px 12px" }}><Banner tone="info">{notice}</Banner></div>}
          {error && <div style={{ padding: "0 16px 12px" }}><Banner tone="bad">{error}</Banner></div>}

          {loading && !data ? (
            <div style={{ padding: 18 }}><Progress label="Loading leads…" /></div>
          ) : data && data.leads.length === 0 ? (
            <div style={{ padding: 18 }}>
              <Empty title="No leads match this view">
                Import a Google Sheet or add prospects manually to get started.
              </Empty>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Business</th>
                    <th>Contact</th>
                    <th>Industry</th>
                    <th className="num">Score</th>
                    <th>Priority</th>
                    <th>Status</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.leads.map((lead) => (
                    <tr key={lead.id} className="clickable" onClick={() => setSelected(lead)}>
                      <td>
                        <div className="strong">{lead.business ?? "—"}</div>
                        <div className="tiny">{lead.email ?? "no email"} {lead.location ? `· ${lead.location}` : ""}</div>
                      </td>
                      <td>{lead.contact_name ?? "—"}<div className="tiny">{lead.role ?? ""}</div></td>
                      <td>{lead.industry ?? "—"}</td>
                      <td className="num"><span className={`score ${scoreClass(lead.score)}`}>{lead.score ?? "—"}</span></td>
                      <td>{lead.priority ? <Badge tone={priorityTone(lead.priority)}>{label(lead.priority)}</Badge> : "—"}</td>
                      <td><Badge tone={statusTone(lead.status)}>{label(lead.status)}</Badge></td>
                      <td className="tiny nowrap">{fmtDate(lead.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data && (
            <div style={{ padding: "0 16px 14px" }}>
              <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
            </div>
          )}
        </Card>
      </div>

      <LeadDetail
        lead={selected}
        busy={busy === selected?.id}
        onClose={() => setSelected(null)}
        onSave={async (body) => {
          if (selected) await update(selected.id, body);
        }}
        onDelete={() => selected && remove(selected)}
      />
    </main>
  );
}

function LeadDetail({
  lead,
  busy,
  onClose,
  onSave,
  onDelete,
}: {
  lead: Lead | null;
  busy: boolean;
  onClose: () => void;
  onSave: (body: Record<string, unknown>) => Promise<void>;
  onDelete: () => void;
}) {
  const [manual, setManual] = useState("");
  const [loadedId, setLoadedId] = useState<string | null>(null);

  if (lead && loadedId !== lead.id) {
    setLoadedId(lead.id);
    setManual(lead.manual_research ?? "");
  }

  if (!lead) return null;

  let research: ResearchResult | null = null;
  try {
    research = lead.research ? (JSON.parse(lead.research) as ResearchResult) : null;
  } catch {
    research = null;
  }
  let qualification: Qualification | null = null;
  try {
    qualification = lead.score_reason ? (JSON.parse(lead.score_reason) as Qualification) : null;
  } catch {
    qualification = null;
  }

  return (
    <Modal open={Boolean(lead)} onClose={onClose} title={lead.business ?? "Prospect"} large>
      <div className="row" style={{ marginBottom: 12 }}>
        <Badge tone={statusTone(lead.status)}>{label(lead.status)}</Badge>
        {lead.priority && <Badge tone={priorityTone(lead.priority)}>{label(lead.priority)} priority</Badge>}
        {lead.score !== null && <Badge tone="info">Score {lead.score}</Badge>}
        <div className="row-end">
          <button className="btn btn-sm btn-danger" onClick={onDelete} type="button">Delete lead</button>
        </div>
      </div>

      <dl className="kv" style={{ marginBottom: 16 }}>
        <dt>Email</dt><dd>{lead.email ?? "—"}</dd>
        <dt>Contact</dt><dd>{lead.contact_name ?? "—"} {lead.role ? `· ${lead.role}` : ""}</dd>
        <dt>Website</dt>
        <dd>{lead.website ? <a href={lead.website} target="_blank" rel="noreferrer">{lead.website}</a> : "—"}</dd>
        <dt>Location / industry</dt><dd>{lead.location ?? "—"} · {lead.industry ?? "—"}</dd>
        <dt>Source</dt><dd>{lead.source ?? "—"} {lead.sheet_row ? `· row ${lead.sheet_row}` : ""}</dd>
        <dt>Research date</dt><dd>{lead.research_at ? fmtDate(lead.research_at) : "Not researched"}</dd>
      </dl>

      <div className="grid grid-2">
        <div className="stack">
          <div>
            <div className="label" style={{ marginBottom: 6 }}>Research</div>
            {research ? (
              <>
                <p style={{ fontSize: 13.2 }}>{research.summary}</p>
                <div className="row" style={{ gap: 6, marginBottom: 8 }}>
                  <Badge tone={research.insufficient_data ? "warn" : "ok"}>
                    Confidence {research.confidence}/100
                  </Badge>
                  <Badge>Website: {research.website_status.replace(/_/g, " ")}</Badge>
                </div>
                {research.findings.length > 0 && (
                  <ul style={{ fontSize: 12.8, paddingLeft: 16 }}>
                    {research.findings.map((finding, index) => (
                      <li key={index} style={{ marginBottom: 4 }}>
                        <span className="strong">{finding.area}</span> ({finding.severity}): {finding.observation}
                        {finding.evidence && <span className="tiny"> — evidence: {finding.evidence}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                {research.inferences.length > 0 && (
                  <p className="tiny">Inferences (unverified): {research.inferences.join("; ")}</p>
                )}
                <p className="tiny" style={{ marginTop: 6 }}>
                  <strong>Angle:</strong> {research.recommended_angle}
                </p>
              </>
            ) : (
              <p className="tiny">No research yet. Run research from the Prospect research page.</p>
            )}
          </div>

          <div>
            <div className="label" style={{ marginBottom: 6 }}>Qualification</div>
            {qualification ? (
              <>
                <p style={{ fontSize: 13 }}>{qualification.opportunity}</p>
                <ul className="tiny" style={{ paddingLeft: 16 }}>
                  {(qualification.reasons ?? []).map((reason, index) => <li key={index}>{reason}</li>)}
                </ul>
                {qualification.disqualify_reason && <p className="tiny">Why not qualified: {qualification.disqualify_reason}</p>}
                <p className="tiny">Recommended service: {qualification.recommended_service ?? "—"} · Value: {qualification.value_tier ?? "—"}</p>
              </>
            ) : (
              <p className="tiny">Not qualified yet.</p>
            )}
          </div>
        </div>

        <div className="stack">
          <div>
            <div className="label" style={{ marginBottom: 6 }}>Your own research and instructions</div>
            <textarea
              className="textarea"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="Anything you know about this business: observations, conversations, screenshots described in words, site issues, extra instructions for the email."
            />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn btn-sm" disabled={busy} type="button" onClick={() => onSave({ manual_research: manual })}>
                {busy ? "Saving…" : "Save notes"}
              </button>
              <button
                className="btn btn-sm"
                disabled={busy}
                type="button"
                onClick={() => onSave({ manual_research: manual, action: "requeue" })}
              >
                Save and re-research
              </button>
            </div>
            <p className="hint" style={{ marginTop: 6 }}>
              Saving notes and choosing re-research discards the stored research and puts this prospect back in the
              research queue, so the AI can incorporate your notes.
            </p>
          </div>

          <Field label="Status">
            <select
              className="select"
              value={lead.status}
              onChange={(e) => onSave({ status: e.target.value })}
            >
              {Object.keys(
                { new: 1, queued_research: 1, qualified: 1, disqualified: 1, needs_research: 1, converted: 1, email_generated: 1, approved: 1 },
              ).map((value) => (
                <option key={value} value={value}>{label(value)}</option>
              ))}
            </select>
          </Field>

          {lead.extra && (
            <div>
              <div className="label" style={{ marginBottom: 4 }}>Extra sheet data</div>
              <p className="tiny">{lead.extra}</p>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
