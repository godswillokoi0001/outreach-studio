"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { Badge, Banner, Card, Empty, Field, Modal, Pager, Progress } from "@/components/ui";
import { confirmDialog } from "@/components/Feedback";
import { errorMessage } from "@/lib/client";
import {
  createLead,
  deleteLeadCascade,
  listCampaigns,
  listLeads,
  updateLeadFields,
} from "@/lib/store";
import { fmtDate, label, priorityTone, scoreClass, statusTone } from "@/lib/format";
import type { Campaign, Lead, LeadStatus } from "@/lib/types";

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

const PAGE_SIZE = 20;

export default function LeadsPage() {
  const { user } = useAuth();
  const [allLeads, setAllLeads] = useState<Lead[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Lead | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [newLead, setNewLead] = useState({
    business: "",
    contact_name: "",
    role: "",
    email: "",
    website: "",
    location: "",
    industry: "",
    notes: "",
    campaignId: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [leadsRes, campRes] = await Promise.all([listLeads(user.uid), listCampaigns(user.uid)]);
      setAllLeads(leadsRes);
      setCampaigns(campRes);
      setSelected((prev) => (prev ? leadsRes.find((l) => l.id === prev.id) ?? null : null));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [user.uid]);

  useEffect(() => {
    let active = true;
    Promise.all([listLeads(user.uid), listCampaigns(user.uid)]).then(
      ([leadsRes, campRes]) => {
        if (!active) return;
        setAllLeads(leadsRes);
        setCampaigns(campRes);
        setSelected((prev) => (prev ? leadsRes.find((l) => l.id === prev.id) ?? null : null));
        setLoading(false);
      },
      (err) => {
        if (!active) return;
        setError(errorMessage(err));
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [user.uid]);

  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const l of allLeads) {
      map[l.status] = (map[l.status] ?? 0) + 1;
    }
    return map;
  }, [allLeads]);

  const filtered = useMemo(() => {
    const allowedStatuses = status === "all" ? null : new Set(status.split(","));
    const q = query.trim().toLowerCase();
    return allLeads.filter((l) => {
      if (allowedStatuses && !allowedStatuses.has(l.status)) return false;
      if (!q) return true;
      const hay = `${l.business ?? ""} ${l.contact_name ?? ""} ${l.email ?? ""} ${l.industry ?? ""} ${l.location ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [allLeads, status, query]);

  const paged = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page],
  );

  const update = async (
    id: string,
    patch: { manual_research?: string | null; notes?: string | null; status?: LeadStatus; action?: "requeue" },
  ) => {
    setBusy(id);
    setNotice(null);
    try {
      await updateLeadFields(user.uid, id, patch);
      await load();
      setNotice("Saved.");
    } catch (err) {
      setNotice(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (lead: Lead) => {
    const proceed = await confirmDialog({
      title: `Delete ${lead.business ?? lead.email}?`,
      message: "Its messages and replies are deleted with it. This cannot be undone.",
      confirmLabel: "Delete prospect",
      tone: "bad",
    });
    if (!proceed) return;
    try {
      await deleteLeadCascade(user.uid, lead.id);
      setSelected(null);
      await load();
    } catch (err) {
      setNotice(errorMessage(err));
    }
  };

  const handleAddLead = async () => {
    if (!newLead.business.trim() && !newLead.email.trim()) {
      setNotice("Enter a business name or email address.");
      return;
    }
    setBusy("create");
    setNotice(null);
    try {
      const res = await createLead(user.uid, {
        ...newLead,
        campaignId: newLead.campaignId || null,
      });
      setAddOpen(false);
      setNewLead({
        business: "",
        contact_name: "",
        role: "",
        email: "",
        website: "",
        location: "",
        industry: "",
        notes: "",
        campaignId: "",
      });
      await load();
      setNotice(res.duplicate ? "That email already exists in your leads." : "Lead added.");
    } catch (err) {
      setNotice(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Leads</h1>
          <p className="page-sub">
            Every prospect in one place with its research, score and outreach history. Add manual notes or extra
            research to improve the copy Gemini writes.
          </p>
        </div>
        <div className="row-end">
          <button className="btn btn-primary btn-sm" onClick={() => setAddOpen(true)} type="button">
            <Plus size={14} />
            <span>Add lead</span>
          </button>
        </div>
      </div>

      <div className="stack">
        <Card tight>
          <div className="row" style={{ padding: "14px 16px", gap: 10 }}>
            <select
              className="select"
              style={{ width: 210 }}
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              {STATUS_OPTIONS.map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                  {value !== "all" ? ` (${counts[value.split(",")[0]] ?? 0})` : ""}
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
            <button
              className="btn"
              type="button"
              onClick={() => {
                setQuery(search);
                setPage(1);
              }}
            >
              Search
            </button>
            <div className="row-end">
              <span className="tiny">{filtered.length} leads</span>
            </div>
          </div>

          {notice && (
            <div style={{ padding: "0 16px 12px" }}>
              <Banner tone="info">{notice}</Banner>
            </div>
          )}
          {error && (
            <div style={{ padding: "0 16px 12px" }}>
              <Banner tone="bad">{error}</Banner>
            </div>
          )}

          {loading && allLeads.length === 0 ? (
            <div style={{ padding: 18 }}>
              <Progress label="Loading leads…" />
            </div>
          ) : paged.length === 0 ? (
            <div style={{ padding: 18 }}>
              <Empty title="No leads match this view">
                Import a Google Sheet or click &ldquo;Add lead&rdquo; to get started.
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
                  {paged.map((lead) => (
                    <tr key={lead.id} className="clickable" onClick={() => setSelected(lead)}>
                      <td>
                        <div className="strong">{lead.business ?? "—"}</div>
                        <div className="tiny">
                          {lead.email ?? "no email"} {lead.location ? `· ${lead.location}` : ""}
                        </div>
                      </td>
                      <td>
                        {lead.contact_name ?? "—"}
                        <div className="tiny">{lead.role ?? ""}</div>
                      </td>
                      <td>{lead.industry ?? "—"}</td>
                      <td className="num">
                        <span className={`score ${scoreClass(lead.score)}`}>{lead.score ?? "—"}</span>
                      </td>
                      <td>{lead.priority ? <Badge tone={priorityTone(lead.priority)}>{label(lead.priority)}</Badge> : "—"}</td>
                      <td>
                        <Badge tone={statusTone(lead.status)}>{label(lead.status)}</Badge>
                      </td>
                      <td className="tiny nowrap">{fmtDate(lead.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ padding: "0 16px 14px" }}>
            <Pager page={page} pageSize={PAGE_SIZE} total={filtered.length} onPage={setPage} />
          </div>
        </Card>
      </div>

      <LeadDetail
        key={selected?.id ?? "none"}
        lead={selected}
        busy={busy === selected?.id}
        onClose={() => setSelected(null)}
        onSave={async (patch) => {
          if (selected) await update(selected.id, patch);
        }}
        onDelete={() => selected && void remove(selected)}
      />

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add prospect manually">
        <div className="grid grid-2">
          <Field label="Business name">
            <input
              className="input"
              value={newLead.business}
              onChange={(e) => setNewLead((p) => ({ ...p, business: e.target.value }))}
            />
          </Field>
          <Field label="Email address">
            <input
              className="input"
              type="email"
              value={newLead.email}
              onChange={(e) => setNewLead((p) => ({ ...p, email: e.target.value }))}
            />
          </Field>
          <Field label="Contact name">
            <input
              className="input"
              value={newLead.contact_name}
              onChange={(e) => setNewLead((p) => ({ ...p, contact_name: e.target.value }))}
            />
          </Field>
          <Field label="Role">
            <input
              className="input"
              value={newLead.role}
              onChange={(e) => setNewLead((p) => ({ ...p, role: e.target.value }))}
            />
          </Field>
          <Field label="Website">
            <input
              className="input"
              value={newLead.website}
              onChange={(e) => setNewLead((p) => ({ ...p, website: e.target.value }))}
              placeholder="https://example.com"
            />
          </Field>
          <Field label="Industry">
            <input
              className="input"
              value={newLead.industry}
              onChange={(e) => setNewLead((p) => ({ ...p, industry: e.target.value }))}
            />
          </Field>
          <Field label="Location">
            <input
              className="input"
              value={newLead.location}
              onChange={(e) => setNewLead((p) => ({ ...p, location: e.target.value }))}
            />
          </Field>
          <Field label="Assign to campaign (optional)">
            <select
              className="select"
              value={newLead.campaignId}
              onChange={(e) => setNewLead((p) => ({ ...p, campaignId: e.target.value }))}
            >
              <option value="">Leave unassigned</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Notes">
          <textarea
            className="textarea"
            value={newLead.notes}
            onChange={(e) => setNewLead((p) => ({ ...p, notes: e.target.value }))}
          />
        </Field>
        <div className="row">
          <button className="btn btn-primary" disabled={busy === "create"} onClick={() => void handleAddLead()} type="button">
            {busy === "create" ? "Saving…" : "Create lead"}
          </button>
        </div>
      </Modal>
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
  onSave: (patch: { manual_research?: string | null; status?: LeadStatus; action?: "requeue" }) => Promise<void>;
  onDelete: () => void;
}) {
  const [manual, setManual] = useState(lead?.manual_research ?? "");

  if (!lead) return null;

  const research = lead.research;
  const qualification = lead.score_reason;

  return (
    <Modal open={Boolean(lead)} onClose={onClose} title={lead.business ?? "Prospect"} large>
      <div className="row" style={{ marginBottom: 12 }}>
        <Badge tone={statusTone(lead.status)}>{label(lead.status)}</Badge>
        {lead.priority && <Badge tone={priorityTone(lead.priority)}>{label(lead.priority)} priority</Badge>}
        {lead.score !== null && <Badge tone="info">Score {lead.score}</Badge>}
        <div className="row-end">
          <button className="btn btn-sm btn-danger" onClick={onDelete} type="button">
            Delete lead
          </button>
        </div>
      </div>

      <dl className="kv" style={{ marginBottom: 16 }}>
        <dt>Email</dt>
        <dd>{lead.email ?? "—"}</dd>
        <dt>Contact</dt>
        <dd>
          {lead.contact_name ?? "—"} {lead.role ? `· ${lead.role}` : ""}
        </dd>
        <dt>Website</dt>
        <dd>
          {lead.website ? (
            <a href={lead.website} target="_blank" rel="noreferrer">
              {lead.website}
            </a>
          ) : (
            "—"
          )}
        </dd>
        <dt>Location / industry</dt>
        <dd>
          {lead.location ?? "—"} · {lead.industry ?? "—"}
        </dd>
        <dt>Source</dt>
        <dd>
          {lead.source ?? "—"} {lead.sheet_row ? `· row ${lead.sheet_row}` : ""}
        </dd>
        <dt>Research date</dt>
        <dd>{lead.research_at ? fmtDate(lead.research_at) : "Not researched"}</dd>
      </dl>

      <div className="grid grid-2">
        <div className="stack">
          <div>
            <div className="label" style={{ marginBottom: 6 }}>
              Research
            </div>
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
            <div className="label" style={{ marginBottom: 6 }}>
              Qualification
            </div>
            {qualification ? (
              <>
                <p style={{ fontSize: 13 }}>{qualification.opportunity}</p>
                <ul className="tiny" style={{ paddingLeft: 16 }}>
                  {(qualification.reasons ?? []).map((reason, index) => (
                    <li key={index}>{reason}</li>
                  ))}
                </ul>
                {qualification.disqualify_reason && (
                  <p className="tiny">Why not qualified: {qualification.disqualify_reason}</p>
                )}
                <p className="tiny">
                  Recommended service: {qualification.recommended_service ?? "—"} · Value:{" "}
                  {qualification.value_tier ?? "—"}
                </p>
              </>
            ) : (
              <p className="tiny">Not qualified yet.</p>
            )}
          </div>
        </div>

        <div className="stack">
          <div>
            <div className="label" style={{ marginBottom: 6 }}>
              Your own research and instructions
            </div>
            <textarea
              className="textarea"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="Anything you know about this business: observations, conversations, site issues, extra instructions for the email."
            />
            <div className="row" style={{ marginTop: 8 }}>
              <button
                className="btn btn-sm"
                disabled={busy}
                type="button"
                onClick={() => void onSave({ manual_research: manual })}
              >
                {busy ? "Saving…" : "Save notes"}
              </button>
              <button
                className="btn btn-sm"
                disabled={busy}
                type="button"
                onClick={() => void onSave({ manual_research: manual, action: "requeue" })}
              >
                Save and re-research
              </button>
            </div>
            <p className="hint" style={{ marginTop: 6 }}>
              Saving notes and choosing re-research discards the stored research and puts this prospect back in the
              research queue, so Gemini can incorporate your notes.
            </p>
          </div>

          <Field label="Status">
            <select
              className="select"
              value={lead.status}
              onChange={(e) => void onSave({ status: e.target.value as LeadStatus })}
            >
              {[
                "new",
                "queued_research",
                "qualified",
                "disqualified",
                "needs_research",
                "converted",
                "email_generated",
                "approved",
              ].map((value) => (
                <option key={value} value={value}>
                  {label(value)}
                </option>
              ))}
            </select>
          </Field>

          {lead.extra && (
            <div>
              <div className="label" style={{ marginBottom: 4 }}>
                Extra sheet data
              </div>
              <p className="tiny">{lead.extra}</p>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
