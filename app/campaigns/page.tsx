"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";
import { BatchRunner } from "@/components/Runner";
import { Badge, Banner, Card, Empty, Field, Progress } from "@/components/ui";
import { authedPost, errorMessage } from "@/lib/client";
import {
  assignLeadsToCampaign,
  createCampaign,
  getSettings,
  importSheetRows,
  listCampaigns,
  listLeads,
  listMessages,
  listReplies,
  updateCampaignAction,
} from "@/lib/firestore-store";
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

export default function CampaignsPage() {
  const { user, workspaceToken, reconnectWorkspace } = useAuth();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [replies, setReplies] = useState<Reply[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [instruction, setInstruction] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

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

  const enriched = useMemo(() => {
    return campaigns.map((c) => {
      const campLeads = leads.filter((l) => l.campaign_id === c.id);
      const campLeadIds = new Set(campLeads.map((l) => l.id));
      const campMsgs = messages.filter((m) => m.campaign_id === c.id);
      const campReplies = replies.filter((r) => r.lead_id && campLeadIds.has(r.lead_id));
      return {
        ...c,
        leads: campLeads.length,
        researched: campLeads.filter((l) => Boolean(l.research_at)).length,
        qualified: campLeads.filter((l) =>
          ["qualified", "email_generated", "approved", "sent", "replied", "converted", "followup_pending"].includes(
            l.status,
          ),
        ).length,
        sent: campMsgs.filter((m) => m.status === "sent").length,
        pending: campMsgs.filter((m) => m.status === "pending_approval").length,
        replies: campReplies.length,
        positive: campReplies.filter((r) => POSITIVE_CLASSES.has(r.classification)).length,
      };
    });
  }, [campaigns, leads, messages, replies]);

  const makePlan = async () => {
    if (instruction.trim().length < 8) return;
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
      const result = await authedPost<{ plan: Plan }>("/api/ai/plan", {
        instruction,
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
        instruction,
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
        `Campaign created${importedCount ? ` with ${importedCount} prospects assigned` : ""}. Review the plan, then approve it to enable sending.`,
      );
      setPlan(null);
      setInstruction("");
      await reload();
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const act = async (
    campaign: Campaign,
    action: "approve" | "pause" | "resume" | "archive" | "assign",
  ) => {
    const confirmations: Record<string, string> = {
      approve:
        "Approve this campaign? Emails will only send once you approve them individually (unless auto-approval is enabled).",
      pause: "Pause this campaign? Research and sending stop until you resume.",
      archive: "Archive this campaign?",
    };
    if (confirmations[action] && !window.confirm(confirmations[action])) return;
    setBusy(`${campaign.id}:${action}`);
    setFailure(null);
    setNotice(null);
    try {
      if (action === "assign") {
        const assigned = await assignLeadsToCampaign(user.uid, campaign.id, campaign.config);
        setNotice(
          assigned
            ? `Assigned ${assigned} unprocessed prospects to ${campaign.name}.`
            : "No matching unprocessed leads found.",
        );
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
            Describe the outcome in plain English. Gemini turns it into a campaign plan, shows you exactly what it
            intends to do, and waits for your approval before anything is sent.
          </p>
        </div>
      </div>

      <div className="stack">
        {failure && <Banner tone="bad">{failure}</Banner>}
        {notice && <Banner tone="ok">{notice}</Banner>}

        <Card
          title="Plan a campaign"
          sub="For example: “Use my sheet, research the first 30 clinics, and prepare emails about website redesign for the strongest opportunities.”"
        >
          <textarea
            className="textarea"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="Tell the system what you want to achieve…"
            rows={3}
          />
          <div className="row" style={{ marginTop: 10 }}>
            <button
              className="btn btn-primary"
              onClick={() => void makePlan()}
              disabled={busy !== null || instruction.trim().length < 8}
              type="button"
            >
              {busy === "plan" ? "Planning…" : "Plan campaign"}
            </button>
            {plan && (
              <button className="btn" onClick={() => void create()} disabled={busy !== null} type="button">
                {busy === "create" ? "Creating…" : "Create campaign"}
              </button>
            )}
            <span className="tiny">No email is ever sent without approval.</span>
          </div>

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
            </div>
          )}
        </Card>

        {loading && campaigns.length === 0 && <Progress label="Loading campaigns…" />}
        {error && <Banner tone="bad">{error}</Banner>}

        {!loading && enriched.length === 0 && (
          <Empty title="No campaigns yet">
            Plan one above, or import a sheet first and assign those prospects to a campaign.
          </Empty>
        )}

        {enriched.map((campaign) => (
          <Card key={campaign.id} tight>
            <div style={{ padding: "16px 18px" }}>
              <div className="row" style={{ marginBottom: 8 }}>
                <div>
                  <div className="card-title">{campaign.name}</div>
                  <div className="card-sub">
                    Created {fmtDate(campaign.created_at)}
                    {campaign.approved_at ? ` · approved ${fmtDate(campaign.approved_at)}` : " · not yet approved"}
                    {campaign.sheet_source ? " · linked to a worksheet" : ""}
                  </div>
                </div>
                <div className="row-end row">
                  <Badge tone={statusTone(campaign.status)}>{label(campaign.status)}</Badge>
                </div>
              </div>

              {campaign.instruction && (
                <p className="quote" style={{ marginBottom: 10 }}>
                  {campaign.instruction}
                </p>
              )}

              <div className="row" style={{ marginBottom: 12 }}>
                <Badge>Leads {campaign.leads}</Badge>
                <Badge>Researched {campaign.researched}</Badge>
                <Badge>Qualified {campaign.qualified}</Badge>
                <Badge tone="info">Awaiting approval {campaign.pending}</Badge>
                <Badge tone="ok">Sent {campaign.sent}</Badge>
                <Badge tone={campaign.positive ? "gold" : undefined}>Positive {campaign.positive}</Badge>
                <Badge>Service: {campaign.config.services?.join(", ") || "—"}</Badge>
                <Badge>Min score {campaign.config.min_score}</Badge>
              </div>

              <div className="row">
                {campaign.status !== "approved" && campaign.status !== "completed" && (
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => void act(campaign, "approve")}
                    disabled={busy !== null}
                    type="button"
                  >
                    Approve campaign
                  </button>
                )}
                <BatchRunner type="research" campaignId={campaign.id} label="Research" limit={2} onDone={reload} />
                <BatchRunner type="qualify" campaignId={campaign.id} label="Qualify" limit={3} onDone={reload} />
                <BatchRunner type="compose" campaignId={campaign.id} label="Write emails" limit={2} onDone={reload} />
                <BatchRunner
                  type="send"
                  campaignId={campaign.id}
                  label="Send approved"
                  confirmText="Send approved emails now from your connected Gmail account? They go to real prospects."
                  onDone={reload}
                />
                <Link className="btn btn-sm" href="/review">
                  Review emails
                </Link>
                <button
                  className="btn btn-sm"
                  onClick={() => void act(campaign, "assign")}
                  disabled={busy !== null}
                  type="button"
                >
                  Assign prospects
                </button>
                {campaign.status === "paused" ? (
                  <button
                    className="btn btn-sm"
                    onClick={() => void act(campaign, "resume")}
                    disabled={busy !== null}
                    type="button"
                  >
                    Resume
                  </button>
                ) : (
                  <button
                    className="btn btn-sm"
                    onClick={() => void act(campaign, "pause")}
                    disabled={busy !== null}
                    type="button"
                  >
                    Pause
                  </button>
                )}
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => void act(campaign, "archive")}
                  disabled={busy !== null}
                  type="button"
                >
                  Archive
                </button>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </main>
  );
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
        <input
          className="input"
          value={config.target_industry}
          onChange={(e) => set("target_industry", e.target.value)}
        />
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
