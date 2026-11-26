"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, MoreHorizontal, Plus, UserPlus } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { BatchRunner } from "@/components/Runner";
import { CriteriaForm } from "@/components/CriteriaForm";
import { LocationPicker } from "@/components/LocationPicker";
import { LoadingPanel, Skeleton } from "@/components/Loading";
import { DEFAULT_CRITERIA, INDUSTRY_OPTIONS, criteriaToFocus, type ResearchCriteria } from "@/lib/criteria";
import { EMPTY_GEO, geoSummary, rememberLocation, type GeoSelection } from "@/lib/geo";
import { Badge, Banner, Card, Empty, Field } from "@/components/ui";
import { confirmDialog } from "@/components/Feedback";
import { authedPost, errorMessage } from "@/lib/client";
import {
  addLeadsToCampaign,
  assignLeadsToCampaign,
  createCampaign,
  deleteCampaign,
  getSettings,
  importSheetRows,
  listCampaigns,
  listLeads,
  listMessages,
  listReplies,
  updateCampaignAction,
} from "@/lib/store";
import { fmtDate, label, statusTone } from "@/lib/format";
import { buildLiveKnowledgeDigest } from "@/lib/pipeline-client";
import type { Campaign, CampaignConfig, Lead, Message, Reply } from "@/lib/types";

interface Plan {
  name: string;
  summary: string;
  sheet_url: string;
  config: CampaignConfig;
  warnings: string[];
}

const POSITIVE_CLASSES = new Set(["interested", "more_info", "pricing"]);

type NextStep =
  | { kind: "approve"; title: string; hint: string; cta: string }
  | { kind: "resume"; title: string; hint: string; cta: string }
  | { kind: "link"; href: string; title: string; hint: string; cta: string }
  | { kind: "research"; title: string; hint: string; cta: string; count: number }
  | { kind: "qualify"; title: string; hint: string; cta: string; count: number }
  | { kind: "compose"; title: string; hint: string; cta: string; count: number }
  | { kind: "send"; title: string; hint: string; cta: string; count: number; confirmText: string };

type Enriched = Campaign & {
  leads: number;
  researched: number;
  qualified: number;
  queued: number;
  toQualify: number;
  toCompose: number;
  drafted: number;
  sent: number;
  pending: number;
  approvedReady: number;
  replies: number;
  positive: number;
  next: NextStep;
};

export default function CampaignsPage() {
  const { user, workspaceToken, reconnectWorkspace } = useAuth();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [replies, setReplies] = useState<Reply[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [instruction, setInstruction] = useState("");
  const [criteria, setCriteria] = useState<ResearchCriteria>(DEFAULT_CRITERIA);
  const [geo, setGeo] = useState<GeoSelection>(EMPTY_GEO);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const fullInstructionRef = useRef("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, l, m, r] = await Promise.all([
        listCampaigns(user.uid),
        listLeads(user.uid),
        listMessages(user.uid),
        listReplies(user.uid),
      ]);
      setCampaigns(c);
      setLeads(l);
      setMessages(m);
      setReplies(r);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [user.uid]);

  useEffect(() => {
    let active = true;
    Promise.all([
      listCampaigns(user.uid),
      listLeads(user.uid),
      listMessages(user.uid),
      listReplies(user.uid),
    ]).then(
      ([c, l, m, r]) => {
        if (!active) return;
        setCampaigns(c);
        setLeads(l);
        setMessages(m);
        setReplies(r);
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

  const enriched = useMemo<Enriched[]>(() => {
    return campaigns.map((c) => {
      const campLeads = leads.filter((l) => l.campaign_id === c.id);
      const campLeadIds = new Set(campLeads.map((l) => l.id));
      const campMsgs = messages.filter((m) => m.campaign_id === c.id);
      const campReplies = replies.filter((r) => r.lead_id && campLeadIds.has(r.lead_id));
      const base = {
        ...c,
        leads: campLeads.length,
        researched: campLeads.filter((l) => Boolean(l.research_at)).length,
        qualified: campLeads.filter((l) =>
          ["qualified", "email_generated", "approved", "sent", "replied", "converted", "followup_pending"].includes(
            l.status,
          ),
        ).length,
        queued: campLeads.filter((l) => l.status === "queued_research").length,
        toQualify: campLeads.filter((l) => l.status === "researched").length,
        toCompose: campLeads.filter((l) => l.status === "qualified").length,
        drafted: campMsgs.filter((m) => m.kind === "initial" && m.status !== "cancelled").length,
        sent: campMsgs.filter((m) => m.status === "sent").length,
        pending: campMsgs.filter((m) => m.status === "pending_approval").length,
        approvedReady: campMsgs.filter((m) => m.status === "approved").length,
        replies: campReplies.length,
        positive: campReplies.filter((r) => POSITIVE_CLASSES.has(r.classification)).length,
      };
      return { ...base, next: nextStepFor(base) };
    });
  }, [campaigns, leads, messages, replies]);

  const selected = enriched.find((c) => c.id === selectedId) ?? enriched[0] ?? null;

  const makePlan = async () => {
    if (instruction.trim().length < 8 && !criteria.industry) return;
    setBusy("plan");
    setFailure(null);
    setNotice(null);
    try {
      const [settings, knowledge] = await Promise.all([
        getSettings(user.uid),
        buildLiveKnowledgeDigest(user.uid),
      ]);
      const byStatus: Record<string, number> = {};
      const industrySet = new Set<string>();
      for (const l of leads) {
        byStatus[l.status] = (byStatus[l.status] ?? 0) + 1;
        if (l.industry?.trim()) industrySet.add(l.industry.trim());
      }
      const brief = criteriaToFocus(criteria);
      const locationBrief = geoSummary(geo);
      const fullInstruction = [
        instruction.trim() || `Build the strongest campaign for ${criteria.industry || "my best-fit prospects"}.`,
        brief ? `STRUCTURED BRIEF\n${brief}` : "",
        locationBrief ? `Target location: ${locationBrief}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      fullInstructionRef.current = fullInstruction;
      const result = await authedPost<{ plan: Plan }>("/api/ai/plan", {
        instruction: fullInstruction,
        settings,
        knowledge,
        availableLeads: {
          total: leads.length,
          byStatus,
          industries: Array.from(industrySet),
        },
        recentCampaigns: campaigns.slice(0, 8).map((c) => ({ name: c.name, status: c.status })),
        model: settings.model,
      });
      rememberLocation(geo);
      setPlan(result.plan);
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    if (!plan) return;
    setBusy("create");
    setFailure(null);
    try {
      let importedCount = 0;
      const campaign = await createCampaign(user.uid, {
        name: plan.name,
        instruction: fullInstructionRef.current || instruction,
        config: {
          ...plan.config,
          summary: plan.summary,
          warnings: plan.warnings,
        },
        sheetSource: plan.sheet_url || null,
      });

      if (plan.sheet_url) {
        if (!workspaceToken) {
          await reconnectWorkspace();
        }
        try {
          const tabsRes = await authedPost<{ spreadsheetId: string; tabs: { title: string }[] }>(
            "/api/workspace/sheets",
            { action: "tabs", url: plan.sheet_url },
            { requireWorkspace: true },
          );
          const firstTab = tabsRes.tabs[0]?.title;
          if (firstTab) {
            const valuesRes = await authedPost<{ spreadsheetId: string; tab: string; values: string[][] }>(
              "/api/workspace/sheets",
              { action: "values", url: plan.sheet_url, tab: firstTab },
              { requireWorkspace: true },
            );
            const imp = await importSheetRows(user.uid, {
              spreadsheetId: valuesRes.spreadsheetId,
              tab: valuesRes.tab,
              rows: valuesRes.values,
              limit: plan.config.lead_count,
              campaignId: campaign.id,
            });
            importedCount = imp.created;
          }
        } catch (sheetErr) {
          setFailure(
            `Campaign created, but sheet import hit an issue: ${errorMessage(sheetErr)}. You can import via the Google Sheets page.`,
          );
        }
      } else {
        importedCount = await assignLeadsToCampaign(user.uid, campaign.id, plan.config);
      }

      setNotice(
        `Campaign created${importedCount ? ` with ${importedCount} prospects assigned` : ""}. Open it on the left, then take the next step it shows.`,
      );
      setSelectedId(campaign.id);
      setPlannerOpen(false);
      setPlan(null);
      setInstruction("");
      await reload();
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const addProspects = async (campaignId: string, leadIds: string[]) => {
    if (leadIds.length === 0) return;
    setBusy(`${campaignId}:add`);
    setFailure(null);
    setNotice(null);
    try {
      const moved = await addLeadsToCampaign(user.uid, campaignId, leadIds);
      setNotice(
        moved
          ? `Added ${moved} prospect${moved === 1 ? "" : "s"} to this campaign. New ones are queued, so research can run now.`
          : "Those prospects are already in this campaign.",
      );
      await reload();
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const act = async (
    campaign: Campaign,
    action: "approve" | "pause" | "resume" | "unarchive" | "archive" | "complete" | "delete" | "assign",
  ) => {
    const confirmations: Record<string, string> = {
      approve:
        "Approve this campaign? Research, writing and sending become available. Each email still needs your approval before it leaves.",
      pause: "Pause this campaign? Nothing is researched or sent until you resume.",
      unarchive: "Unarchive this campaign? It returns to your active list.",
      archive: "Archive this campaign? It stops appearing in your active list.",
    };
    if (confirmations[action]) {
      const proceed = await confirmDialog({
        title: "Confirm this campaign action",
        message: confirmations[action],
        confirmLabel: "Continue",
        tone: action === "archive" ? "bad" : "info",
      });
      if (!proceed) return;
    }
    setBusy(`${campaign.id}:${action}`);
    setFailure(null);
    setNotice(null);
    try {
      if (action === "assign") {
        const assigned = await assignLeadsToCampaign(user.uid, campaign.id, campaign.config);
        setNotice(
          assigned
            ? `Added ${assigned} unprocessed prospect${assigned === 1 ? "" : "s"} to ${campaign.name}.`
            : "No matching unprocessed prospects were found.",
        );
      } else if (action === "delete") {
        await deleteCampaign(user.uid, campaign.id);
        setNotice(`Campaign "${campaign.name}" deleted.`);
      } else {
        await updateCampaignAction(user.uid, campaign.id, action);
      }
      await reload();
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Campaigns</h1>
          <p className="page-sub">
            One campaign at a time. Pick one on the left and the panel tells you the single next thing to do; every
            other control lives in the ⋯ menu.
          </p>
        </div>
        <div className="row-end">
          <button
            className="btn btn-sm btn-primary"
            onClick={() => setPlannerOpen((open) => !open)}
            type="button"
          >
            <Plus size={13} />
            {plannerOpen ? "Hide planner" : "Plan a campaign"}
          </button>
        </div>
      </div>

      <div className="stack">
        {failure && <Banner tone="bad">{failure}</Banner>}
        {notice && <Banner tone="ok">{notice}</Banner>}
        {error && <Banner tone="bad">{error}</Banner>}

        {plannerOpen && (
          <Card
            title="Describe the outcome"
            sub="Pick the brief with fixed options, or say it in plain English. Either way you edit the plan before anything runs."
          >
            <div className="discover-inputs">
              <LocationPicker value={geo} onChange={setGeo} title="Target location" />
              <CriteriaForm
                value={criteria}
                onChange={setCriteria}
                uid={user.uid}
                busy={busy !== null}
              />
            </div>
            <div style={{ marginTop: 12 }}>
              <textarea
                className="textarea"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="Optional extra context — e.g. use my sheet, only churches with a Facebook page and no website."
                rows={3}
                aria-label="Campaign instruction"
              />
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button
                className="btn btn-primary"
                onClick={() => void makePlan()}
                disabled={busy !== null || (instruction.trim().length < 8 && !criteria.industry)}
                type="button"
              >
                {busy === "plan" ? "Planning…" : "Build my plan"}
              </button>
              <span className="tiny">Nothing is sent until you approve an email individually.</span>
            </div>

            {busy === "plan" && (
              <div style={{ marginTop: 14 }}>
                <LoadingPanel
                  label="Drafting your campaign plan"
                  hint="Reading your knowledge base and available prospects…"
                  estimateMs={22_000}
                  steps={[
                    { label: "Reading your knowledge base", ms: 5_000 },
                    { label: "Checking available prospects", ms: 9_000 },
                    { label: "Writing the plan and warnings", ms: 8_000 },
                  ]}
                />
              </div>
            )}

            {plan && (
              <div className="stack" style={{ marginTop: 16 }}>
                <Banner tone="info">
                  <strong style={{ display: "block", marginBottom: 4 }}>{plan.name}</strong>
                  {plan.summary}
                </Banner>
                {plan.warnings?.length > 0 && (
                  <Banner tone="warn">
                    <ul style={{ margin: 0, paddingLeft: 16 }}>
                      {plan.warnings.map((warning, index) => (
                        <li key={index}>{warning}</li>
                      ))}
                    </ul>
                  </Banner>
                )}
                <ConfigEditor config={plan.config} onChange={(config) => setPlan({ ...plan, config })} />
                {plan.sheet_url && <p className="tiny">Prospects will be imported from: {plan.sheet_url}</p>}
                <div className="row">
                  <button className="btn btn-primary" onClick={() => void create()} disabled={busy !== null} type="button">
                    {busy === "create" ? "Creating…" : "Create campaign"}
                  </button>
                  <span className="tiny">You can approve it afterwards from the campaign panel.</span>
                </div>
              </div>
            )}
          </Card>
        )}

        {loading && enriched.length === 0 && (
          <div className="camp-layout">
            <div className="stack" style={{ gap: 6 }}>
              {[0, 1, 2].map((index) => (
                <Skeleton key={index} height={78} radius={12} />
              ))}
            </div>
            <Skeleton height={320} radius={14} />
          </div>
        )}

        {!loading && enriched.length === 0 && (
          <Card>
            <Empty title="No campaigns yet">
              Press <strong>Plan a campaign</strong> above and describe what you want to achieve, or{" "}
              <Link href="/sheets">import prospects</Link> first. A campaign is simply a group of prospects with one
              goal.
            </Empty>
          </Card>
        )}

        {enriched.length > 0 && (
          <div className="camp-layout">
            <aside className="camp-list" aria-label="Your campaigns">
              <div className="camp-list-head">
                {enriched.length} campaign{enriched.length === 1 ? "" : "s"}
              </div>
              {enriched.map((campaign) => (
                <button
                  key={campaign.id}
                  className="camp-row"
                  data-active={selected?.id === campaign.id}
                  onClick={() => setSelectedId(campaign.id)}
                  type="button"
                >
                  <span className="camp-row-top">
                    <span className="camp-row-name">{campaign.name}</span>
                    <span className="camp-row-status">{label(campaign.status)}</span>
                  </span>
                  <span className="camp-row-next">{campaign.next.title}</span>
                  <span className="camp-row-meta">
                    {campaign.leads} prospects · {campaign.sent} sent · {campaign.replies} replies
                  </span>
                  <span className="camp-row-bar">
                    <span
                      style={{
                        width: `${campaign.leads ? Math.min(100, Math.round((campaign.researched / campaign.leads) * 100)) : 0}%`,
                      }}
                    />
                  </span>
                </button>
              ))}
            </aside>

            {selected && (
              <section aria-label={`${selected.name} workspace`}>
                <CampaignDetail
                  campaign={selected}
                  busy={busy}
                  prospects={leads.filter((lead) => lead.campaign_id === selected.id)}
                  allLeads={leads}
                  onAct={act}
                  onAddLeads={addProspects}
                  onDone={reload}
                />
              </section>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

function CampaignDetail({
  campaign,
  prospects,
  allLeads,
  busy,
  onAct,
  onAddLeads,
  onDone,
}: {
  campaign: Enriched;
  prospects: Lead[];
  allLeads: Lead[];
  busy: string | null;
  onAct: (campaign: Campaign, action: "approve" | "pause" | "resume" | "unarchive" | "archive" | "complete" | "delete" | "assign") => Promise<void>;
  onAddLeads: (campaignId: string, leadIds: string[]) => Promise<void>;
  onDone: () => void | Promise<void>;
}) {
  const c = campaign;
  const next = c.next;

  const [picking, setPicking] = useState(false);
  const [pickQuery, setPickQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);

  const candidates = useMemo(() => {
    const q = pickQuery.trim().toLowerCase();
    return allLeads
      .filter((lead) => lead.campaign_id !== c.id)
      .filter((lead) => {
        if (!q) return true;
        const hay = `${lead.business ?? ""} ${lead.contact_name ?? ""} ${lead.email ?? ""} ${lead.industry ?? ""} ${lead.location ?? ""}`;
        return hay.toLowerCase().includes(q);
      })
      .sort((a, b) =>
        (a.business || a.email || "").localeCompare(b.business || b.email || ""),
      );
  }, [allLeads, c.id, pickQuery]);

  const stages = [
    {
      label: "Prospects",
      value: c.leads,
      note: c.leads ? "in campaign" : "none yet",
      state: c.leads ? "done" : "idle",
    },
    {
      label: "Researched",
      value: c.researched,
      note: c.queued ? `${c.queued} waiting` : c.researched ? "evidence stored" : "not started",
      state: c.queued ? "active" : c.researched ? "done" : "idle",
    },
    {
      label: "Qualified",
      value: c.qualified,
      note: c.toQualify ? `${c.toQualify} to score` : c.qualified ? "scored" : "none scored",
      state: c.toQualify ? "active" : c.qualified ? "done" : "idle",
    },
    {
      label: "Drafted",
      value: c.drafted,
      note: c.toCompose ? `${c.toCompose} to write` : c.pending ? `${c.pending} to review` : c.drafted ? "ready" : "no drafts",
      state: c.toCompose ? "active" : c.drafted ? "done" : "idle",
    },
    {
      label: "Sent",
      value: c.sent,
      note: c.approvedReady ? `${c.approvedReady} approved` : `${c.replies} repl${c.replies === 1 ? "y" : "ies"}`,
      state: c.approvedReady ? "active" : c.sent ? "done" : "idle",
    },
  ];

  const eta = estimateFor(next);

  return (
    <div className="card detail-card">
      <header className="detail-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="detail-title">{c.name}</div>
          <div className="detail-meta">
            Created {fmtDate(c.created_at)}
            {c.sheet_source ? " · linked to a worksheet" : ""}
            {c.config.services?.length ? ` · ${c.config.services.join(", ")}` : ""}
            {` · minimum score ${c.config.min_score}`}
            {c.config.require_approval ? " · approval required" : " · auto-send when approved"}
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Badge tone={statusTone(c.status)}>{label(c.status)}</Badge>
          <details className="kebab">
            <summary aria-label="All campaign actions" title="All campaign actions">
              <MoreHorizontal size={16} />
            </summary>
            <div className="kebab-menu">
              <Link href="/review">Email review</Link>
              <Link href="/conversations">Conversations</Link>
              <Link href="/leads">All prospects</Link>
              <div className="kebab-sep" />
              {c.status !== "approved" && c.status !== "completed" && (
                <button onClick={() => void onAct(c, "approve")} disabled={busy !== null} type="button">
                  Approve campaign
                </button>
              )}
              <button onClick={() => void onAct(c, "assign")} disabled={busy !== null} type="button">
                Add unassigned prospects
              </button>
              {c.status === "paused" ? (
                <button onClick={() => void onAct(c, "resume")} disabled={busy !== null} type="button">
                  Resume campaign
                </button>
              ) : (
                <button onClick={() => void onAct(c, "pause")} disabled={busy !== null} type="button">
                  Pause campaign
                </button>
              )}
              {c.status === "archived" ? (
                <button onClick={() => void onAct(c, "unarchive")} disabled={busy !== null} type="button">
                  Unarchive campaign
                </button>
              ) : null}
              {c.status !== "approved" && c.status !== "completed" && c.status !== "archived" && (
                <button onClick={() => void onAct(c, "approve")} disabled={busy !== null} type="button">
                  Approve campaign
                </button>
              )}
              <div className="kebab-sep" />
              {c.status === "paused" ? (
                <button onClick={() => void onAct(c, "resume")} disabled={busy !== null} type="button">
                  Resume campaign
                </button>
              ) : (
                <button onClick={() => void onAct(c, "pause")} disabled={busy !== null} type="button">
                  Pause campaign
                </button>
              )}
              {c.status === "archived" ? (
                <button className="danger"
                  onClick={() => void onAct(c, "delete")}
                  disabled={busy !== null}
                  type="button"
                >
                  Delete campaign
                </button>
              ) : null}
              <div className="kebab-sep" />
              <button
                className="danger"
                onClick={() => void onAct(c, "archive")}
                disabled={busy !== null}
                type="button"
              >
                Archive campaign
              </button>
            </div>
          </details>
        </div>
      </header>

      {c.instruction && <p className="quote detail-instruction">{c.instruction}</p>}

      <div className="pipeline">
        {stages.map((stage) => (
          <div key={stage.label} className="pipe-step" data-state={stage.state}>
            <span className="pipe-bar" aria-hidden="true" />
            <span className="pipe-label">{stage.label}</span>
            <span className="pipe-value">{stage.value}</span>
            <span className="pipe-note">{stage.note}</span>
          </div>
        ))}
      </div>

      <div className="next-card">
        <div className="next-main">
          <div className="next-eyebrow">Do this next</div>
          <div className="next-title">{next.title}</div>
          <div className="next-hint">{next.hint}</div>
        </div>
        <div className="next-side">
          <NextAction next={next} campaignId={c.id} busy={busy} onAct={onAct} campaign={c} onDone={onDone} />
          {eta && <span className="next-eta">{eta} · you can stop any time</span>}
        </div>
      </div>

      <div className="add-prospects">
        <div className="add-prospects-head">
          <div>
            <div className="detail-sub">Add prospects to this campaign</div>
            <div className="tiny">
              Pick any lead by hand, including prospects parked in another campaign. New ones join the research
              queue; contacted ones keep their stage so nobody is emailed twice.
            </div>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setPicking((open) => !open)}
            disabled={busy !== null}
          >
            <UserPlus size={13} />
            <span>{picking ? "Close picker" : "Choose prospects"}</span>
          </button>
        </div>

        {picking && (
          <div className="add-prospects-body">
            <input
              className="input"
              placeholder="Search business, email, contact, industry or location"
              value={pickQuery}
              onChange={(e) => setPickQuery(e.target.value)}
            />
            <div className="pick-list">
              {candidates.length === 0 ? (
                <div className="tiny" style={{ padding: "10px 12px" }}>
                  Every prospect is already in this campaign.
                </div>
              ) : (
                candidates.slice(0, 60).map((lead) => {
                  const checked = picked.includes(lead.id);
                  return (
                    <label key={lead.id} className="pick-row" data-checked={checked}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setPicked((prev) =>
                            prev.includes(lead.id)
                              ? prev.filter((id) => id !== lead.id)
                              : [...prev, lead.id],
                          )
                        }
                      />
                      <span className="pick-main">
                        <span className="pick-name">
                          {lead.business || lead.email || lead.website || "Unnamed prospect"}
                        </span>
                        <span className="pick-meta">
                          {[
                            lead.email,
                            lead.industry,
                            label(lead.status),
                            lead.campaign_id ? "in another campaign" : "unassigned",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                    </label>
                  );
                })
              )}
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={picked.length === 0 || busy !== null}
                onClick={() =>
                  void onAddLeads(c.id, picked).then(() => {
                    setPicked([]);
                    setPicking(false);
                  })
                }
              >
                Add {picked.length || ""} to campaign
              </button>
              {picked.length > 0 && (
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPicked([])}>
                  Clear
                </button>
              )}
              <span className="tiny row-end">
                {candidates.length} available{candidates.length > 60 ? " · showing first 60" : ""}
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="detail-links">
        <Link href="/review">
          Email review{c.pending ? ` · ${c.pending} waiting` : ""}
        </Link>
        <Link href="/conversations">
          Conversations{c.replies ? ` · ${c.replies}` : ""}
        </Link>
        <Link href="/followups">Follow-ups</Link>
        <Link href="/leads">All prospects</Link>
        <Link href="/sheets">Sheet sync</Link>
        {prospects.length > 0 && (
          <div className="detail-prospects">
            <div className="detail-sub">
              Prospects in this campaign
              <Link href="/leads" className="detail-sub-link">
                View all {campaign.leads}
              </Link>
            </div>
            <ul className="mini-rows">
              {prospects.slice(0, 6).map((lead) => (
                <li key={lead.id}>
                  <span className="mini-name">{lead.business || lead.email || lead.website || "Unnamed prospect"}</span>
                  <span className="mini-meta">{lead.industry || "—"}</span>
                  <span className="mini-badge" data-tone={statusTone(lead.status)}>
                    {label(lead.status)}
                  </span>
                  <span className="mini-score">{typeof lead.score === "number" ? lead.score : "—"}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <details className="detail-more">
          <summary>Campaign settings</summary>
          <div className="detail-settings">
            <span>Target: {c.config.target_industry || "any industry"}</span>
            <span>Objective: {c.config.objective}</span>
            <span>Tone: {c.config.tone}</span>
            <span>Send limit: {c.config.send_limit}</span>
            <span>Gap between emails: {c.config.interval_seconds}s</span>
            <span>Follow-up days: {c.config.followup_days.join(", ") || "none"}</span>
            <span>Writes as: {c.config.identity === "personal" ? "you personally" : "the business"}</span>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <BatchRunner type="research" campaignId={c.id} label="Research a batch" limit={2} onDone={onDone} />
            <BatchRunner type="qualify" campaignId={c.id} label="Qualify a batch" limit={3} onDone={onDone} />
            <BatchRunner type="compose" campaignId={c.id} label="Write a batch" limit={2} onDone={onDone} />
            <BatchRunner
              type="send"
              campaignId={c.id}
              label="Send approved"
              confirmText="Send approved emails now from your connected Gmail account? They go to real prospects."
              onDone={onDone}
            />
          </div>
        </details>
      </div>
    </div>
  );
}

function NextAction({
  next,
  campaignId,
  campaign,
  busy,
  onAct,
  onDone,
}: {
  next: NextStep;
  campaignId: string;
  campaign: Campaign;
  busy: string | null;
  onAct: (campaign: Campaign, action: "approve" | "pause" | "resume" | "unarchive" | "archive" | "complete" | "delete" | "assign") => Promise<void>;
  onDone: () => void | Promise<void>;
}) {
  if (next.kind === "approve" || next.kind === "resume") {
    return (
      <button
        className="btn btn-primary"
        onClick={() => void onAct(campaign, next.kind === "resume" ? "resume" : "approve")}
        disabled={busy !== null}
        type="button"
      >
        {next.cta}
        <ArrowRight size={14} />
      </button>
    );
  }
  if (next.kind === "link") {
    return (
      <Link className="btn btn-primary" href={next.href}>
        {next.cta}
        <ArrowRight size={14} />
      </Link>
    );
  }
  return (
    <BatchRunner
      type={next.kind}
      campaignId={campaignId}
      label={next.cta}
      variant="primary"
      limit={next.kind === "qualify" ? 3 : 2}
      confirmText={next.kind === "send" ? next.confirmText : undefined}
      onDone={onDone}
    />
  );
}

function nextStepFor(campaign: {
  status: Campaign["status"];
  queued: number;
  toQualify: number;
  toCompose: number;
  pending: number;
  approvedReady: number;
  replies: number;
}): NextStep {
  if (campaign.status === "paused") {
    return {
      kind: "resume",
      title: "This campaign is paused",
      hint: "Nothing is researched or sent while it is paused. Resume to continue exactly where you stopped.",
      cta: "Resume campaign",
    };
  }
  if (campaign.status !== "approved" && campaign.status !== "completed") {
    return {
      kind: "approve",
      title: "Approve this campaign to switch it on",
      hint: "Approving unlocks research, writing and sending. Nothing leaves your inbox until you approve each email.",
      cta: "Approve campaign",
    };
  }
  if (campaign.queued > 0) {
    return {
      kind: "research",
      title: `Research ${campaign.queued} prospect${campaign.queued === 1 ? "" : "s"}`,
      hint: "Each website is opened and what it can verify is stored, so no email is ever written from guesswork.",
      cta: "Start research",
      count: campaign.queued,
    };
  }
  if (campaign.toQualify > 0) {
    return {
      kind: "qualify",
      title: `Score ${campaign.toQualify} researched prospect${campaign.toQualify === 1 ? "" : "s"}`,
      hint: "Each one is compared with what you sell. Only strong fits move on to an email.",
      cta: "Score them",
      count: campaign.toQualify,
    };
  }
  if (campaign.toCompose > 0) {
    return {
      kind: "compose",
      title: `Write ${campaign.toCompose} email${campaign.toCompose === 1 ? "" : "s"} in your voice`,
      hint: "Drafts come from your knowledge base and land in Email review, where nothing is sent without you.",
      cta: "Write emails",
      count: campaign.toCompose,
    };
  }
  if (campaign.pending > 0) {
    return {
      kind: "link",
      href: "/review",
      title: `Review ${campaign.pending} draft${campaign.pending === 1 ? "" : "s"}`,
      hint: "Read it, edit it, approve it. Only approved emails can ever be sent.",
      cta: "Open review",
    };
  }
  if (campaign.approvedReady > 0) {
    return {
      kind: "send",
      title: `Send ${campaign.approvedReady} approved email${campaign.approvedReady === 1 ? "" : "s"}`,
      hint: "Sent from your connected Gmail, spaced out to protect your domain reputation.",
      cta: "Send now",
      count: campaign.approvedReady,
      confirmText: "Send the approved emails now from your connected Gmail account? They go to real prospects.",
    };
  }
  if (campaign.replies > 0) {
    return {
      kind: "link",
      href: "/conversations",
      title: `${campaign.replies} repl${campaign.replies === 1 ? "y" : "ies"} waiting for you`,
      hint: "Each reply is classified with a suggested answer, so you only write the parts that matter.",
      cta: "Open conversations",
    };
  }
  return {
    kind: "link",
    href: "/leads",
    title: "Nothing is waiting on this campaign",
    hint: "Every prospect here has been handled. Add more prospects, or plan the next campaign above.",
    cta: "Add prospects",
  };
}

function estimateFor(next: NextStep): string | null {
  const perItem: Partial<Record<NextStep["kind"], number>> = {
    research: 12,
    qualify: 8,
    compose: 12,
    send: 6,
  };
  const kind = next.kind;
  const rate = perItem[kind];
  if (!rate || !("count" in next)) return null;
  const capped = next.count > 160;
  const seconds = Math.max(5, Math.min(next.count, 160) * rate);
  if (seconds < 60) return `≈ ${Math.round(seconds / 5) * 5}s`;
  const minutes = Math.round(seconds / 60);
  return `≈ ${minutes} min${capped ? " · 160 per run" : ""}`;
}

function ConfigEditor({
  config,
  onChange,
}: {
  config: CampaignConfig;
  onChange: (config: CampaignConfig) => void;
}) {
  const set = <K extends keyof CampaignConfig>(key: K, value: CampaignConfig[K]) =>
    onChange({ ...config, [key]: value });
  return (
    <div className="grid grid-3">
      <Field label="Campaign objective">
        <input className="input" value={config.objective} onChange={(e) => set("objective", e.target.value)} />
      </Field>
      <Field label="Target industry">
        <select
          className="select"
          value={config.target_industry}
          onChange={(e) => set("target_industry", e.target.value)}
        >
          <option value="">Any industry</option>
          {INDUSTRY_OPTIONS.map((industry) => (
            <option key={industry} value={industry}>
              {industry}
            </option>
          ))}
          {config.target_industry && !INDUSTRY_OPTIONS.includes(config.target_industry) ? (
            <option value={config.target_industry}>{config.target_industry}</option>
          ) : null}
        </select>
      </Field>
      <Field label="Services (comma separated)">
        <input
          className="input"
          value={config.services.join(", ")}
          onChange={(e) =>
            set(
              "services",
              e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
        />
      </Field>
      <Field label="Prospects to process">
        <input
          className="input"
          type="number"
          min={1}
          max={200}
          value={config.lead_count}
          onChange={(e) => set("lead_count", Number(e.target.value))}
        />
      </Field>
      <Field label="Campaign send limit">
        <input
          className="input"
          type="number"
          min={1}
          max={500}
          value={config.send_limit}
          onChange={(e) => set("send_limit", Number(e.target.value))}
        />
      </Field>
      <Field label="Seconds between emails">
        <input
          className="input"
          type="number"
          min={30}
          max={600}
          value={config.interval_seconds}
          onChange={(e) => set("interval_seconds", Number(e.target.value))}
        />
      </Field>
      <Field label="Minimum qualification score">
        <input
          className="input"
          type="number"
          min={0}
          max={100}
          value={config.min_score}
          onChange={(e) => set("min_score", Number(e.target.value))}
        />
      </Field>
      <Field label="Follow-up gaps (days, comma separated)">
        <input
          className="input"
          value={config.followup_days.join(", ")}
          onChange={(e) =>
            set(
              "followup_days",
              e.target.value
                .split(",")
                .map((d) => Number(d.trim()))
                .filter((d) => d > 0),
            )
          }
        />
      </Field>
      <Field label="Writes as">
        <select
          className="select"
          value={config.identity}
          onChange={(e) => set("identity", e.target.value as CampaignConfig["identity"])}
        >
          <option value="company">The business (&ldquo;we&rdquo;, &ldquo;our team&rdquo;)</option>
          <option value="personal">Me personally (&ldquo;I&rdquo;, &ldquo;my work&rdquo;)</option>
        </select>
      </Field>
      <Field label="Tone">
        <input className="input" value={config.tone} onChange={(e) => set("tone", e.target.value)} />
      </Field>
      <Field label="Extra instructions for the copywriter">
        <input
          className="input"
          value={config.extra_instructions}
          onChange={(e) => set("extra_instructions", e.target.value)}
        />
      </Field>
      <div className="stack" style={{ gap: 8, paddingTop: 22 }}>
        <label className="check">
          <input
            type="checkbox"
            checked={config.require_approval}
            onChange={(e) => set("require_approval", e.target.checked)}
          />
          <span>Require my approval before sending</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={config.auto_approve_followups}
            onChange={(e) => set("auto_approve_followups", e.target.checked)}
            disabled={config.require_approval}
          />
          <span>Auto-approve follow-ups</span>
        </label>
      </div>
    </div>
  );
}
