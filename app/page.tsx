"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, ArrowUpRight, Check, RotateCcw, Trash2 } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { Badge, Banner, Card, Empty, Stat } from "@/components/ui";
import { BrandLoader } from "@/components/BrandLoader";
import { CountUp } from "@/components/motion/CountUp";
import { ClearActivityModal } from "@/components/ClearActivityModal";
import { errorMessage } from "@/lib/client";
import { loadDashboardBundle } from "@/lib/store";
import { label, statusTone } from "@/lib/format";

type DashboardData = Awaited<ReturnType<typeof loadDashboardBundle>>;

export default function DashboardPage() {
  const { user, workspaceToken, reconnectWorkspace } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clearActivityOpen, setClearActivityOpen] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const bundle = await loadDashboardBundle(user.uid);
      setData(bundle);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [user.uid]);

  useEffect(() => {
    let active = true;
    loadDashboardBundle(user.uid).then(
      (bundle) => {
        if (!active) return;
        setData(bundle);
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

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const firstName = (user.displayName || user.email || "there").split(/[\s@]/)[0];

  const derived = useMemo(() => {
    if (!data) return null;
    const pending = data.emails.pending;
    const queued = data.leads.byStatus.queued_research ?? 0;
    const replyRate = data.emails.sent
      ? Math.round((data.replies.total / data.emails.sent) * 1000) / 10
      : 0;
    const today = new Date().toISOString().slice(0, 10);
    const openedMessages = new Set(data.opens.map((event) => event.message_id)).size;
    const opensToday = data.opens.filter((event) => event.opened_at.slice(0, 10) === today).length;
    const openRate = data.emails.sent
      ? Math.round((openedMessages / data.emails.sent) * 1000) / 10
      : 0;
    const sendsMap = new Map(data.sends.map((entry) => [entry.day, entry.c]));
    const days = Array.from({ length: 14 }).map((_, index) => {
      const date = new Date();
      date.setDate(date.getDate() - (13 - index));
      const key = date.toISOString().slice(0, 10);
      return { key, short: key.slice(8), count: sendsMap.get(key) ?? 0 };
    });
    const maxSend = Math.max(1, ...days.map((day) => day.count));

    const funnel = [
      { label: "Prospects", value: data.leads.total, final: false },
      { label: "Researched", value: data.leads.researched, final: false },
      { label: "Qualified", value: data.leads.qualified, final: false },
      { label: "Drafted", value: data.emails.generated, final: false },
      { label: "Sent", value: data.emails.sent, final: false },
      { label: "Replied", value: data.replies.total, final: true },
    ];
    const funnelMax = Math.max(1, ...funnel.map((stage) => stage.value));

    const focus = pending
      ? { href: "/review", label: `Review ${pending} email${pending === 1 ? "" : "s"}` }
      : !workspaceToken
        ? null
        : data.knowledgeEmpty
          ? { href: "/knowledge", label: "Add your business knowledge" }
          : data.leads.total === 0
            ? { href: "/sheets", label: "Import your first prospects" }
            : data.followupsDue > 0
              ? { href: "/followups", label: `Prepare ${data.followupsDue} follow-up${data.followupsDue === 1 ? "" : "s"}` }
              : queued > 0
                ? { href: "/research", label: `Research ${queued} prospect${queued === 1 ? "" : "s"}` }
                : { href: "/campaigns", label: "Plan your next campaign" };

    const summary = data.leads.total === 0 && data.campaigns.length === 0
      ? "Your workspace is ready and empty. Add your business knowledge, then bring in your first prospects."
      : pending > 0
        ? `${pending} email${pending === 1 ? "" : "s"} waiting for your approval and ${data.followupsDue} follow-up${data.followupsDue === 1 ? "" : "s"} due.`
        : data.replies.positive > 0
          ? `${data.replies.positive} interested prospect${data.replies.positive === 1 ? "" : "s"} replied. That is the part of this job worth doing.`
          : `${data.leads.qualified} qualified prospect${data.leads.qualified === 1 ? "" : "s"} in play, ${data.emails.sent} email${data.emails.sent === 1 ? "" : "s"} sent.`;

    const setup = [
      {
        href: "/knowledge",
        title: "Business knowledge",
        hint: data.knowledgeEmpty ? "Tell Knowrevo who you are" : "In place",
        done: !data.knowledgeEmpty,
      },
      {
        href: "/sheets",
        title: "Prospects",
        hint: data.leads.total ? `${data.leads.total} imported` : "Import a sheet",
        done: data.leads.total > 0,
      },
      {
        href: "/campaigns",
        title: "Campaign",
        hint: data.campaigns.length ? `${data.campaigns.length} created` : "Plan your outreach",
        done: data.campaigns.length > 0,
      },
      {
        href: "/integrations",
        title: "Google connection",
        hint: workspaceToken ? "Gmail + Sheets linked" : "Grant access to send",
        done: Boolean(workspaceToken),
      },
    ];

    const needs = [
      {
        href: "/review",
        title: "Emails to review",
        hint: pending ? "Drafts are waiting for your approval." : "New drafts will appear here.",
        count: pending,
        tone: pending ? "warn" : "muted",
      },
      {
        href: "/conversations",
        title: "Replies",
        hint: data.replies.positive
          ? `${data.replies.positive} interested — answer while it is warm.`
          : "Synced from Gmail and classified.",
        count: data.replies.total,
        tone: data.replies.positive ? "active" : "muted",
      },
      {
        href: "/followups",
        title: "Follow-ups due",
        hint: "Sequences stop automatically when someone replies.",
        count: data.followupsDue,
        tone: data.followupsDue ? "warn" : "muted",
      },
      {
        href: "/research",
        title: "Waiting for research",
        hint: "Each prospect is checked against their real website.",
        count: queued,
        tone: queued ? "active" : "muted",
      },
    ];

    return {
      pending,
      queued,
      replyRate,
      openRate,
      opensToday,
      openedMessages,
      days,
      maxSend,
      funnel,
      funnelMax,
      focus,
      summary,
      setup,
      needs,
      freshAccount: data.leads.total === 0 && data.campaigns.length === 0,
      incompleteSetup: setup.some((step) => !step.done),
    };
  }, [data, workspaceToken]);

  const todayLabel = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <main className="page">
      {error && <Banner tone="bad">{error}</Banner>}

      {loading && !data && <BrandLoader fullScreen />}

      {data && derived && (
        <div className="wk">
          <header className="wk-head rise">
            <div>
              <div className="page-eyebrow">Workspace</div>
              <h1 className="wk-title">
                {greeting}, {firstName}.
              </h1>
              <p className="wk-summary">{derived.summary}</p>

              <div className="wk-actions">
                {!workspaceToken ? (
                  <button className="btn btn-primary" onClick={() => void reconnectWorkspace()} type="button">
                    Connect Google
                    <ArrowRight size={14} />
                  </button>
                ) : derived.focus ? (
                  <Link className="btn btn-primary" href={derived.focus.href}>
                    {derived.focus.label}
                    <ArrowRight size={14} />
                  </Link>
                ) : null}
                <Link className="btn" href="/campaigns">
                  New campaign
                </Link>
                <Link className="btn btn-ghost" href="/research">
                  Discover prospects
                </Link>
              </div>
            </div>

            <div className="wk-date">
              <strong>{todayLabel}</strong>
              {data.emails.sent} sent · {data.replies.total} replies all time
            </div>
          </header>

          <section className="wk-kpis rise rise-1" aria-label="Workspace overview">
            <div className="wk-kpi-group">
              <h2 className="wk-kpi-group-title">Pipeline</h2>
              <div className="wk-kpi-grid">
                <article className="wk-kpi">
                  <div className="wk-kpi-label">Prospects</div>
                  <div className="wk-kpi-value">
                    <CountUp value={data.leads.total} />
                  </div>
                  <div className="wk-kpi-note">{data.leads.byStatus.new ?? 0} unprocessed</div>
                </article>
                <article className="wk-kpi">
                  <div className="wk-kpi-label">Qualified</div>
                  <div className="wk-kpi-value">
                    <CountUp value={data.leads.qualified} />
                  </div>
                  <div className="wk-kpi-note">{data.leads.disqualified} disqualified</div>
                </article>
              </div>
            </div>

            <div className="wk-kpi-group">
              <h2 className="wk-kpi-group-title">Outreach</h2>
              <div className="wk-kpi-grid">
                <article className="wk-kpi" data-accent={derived.pending ? "true" : undefined}>
                  <div className="wk-kpi-label">Awaiting approval</div>
                  <div className="wk-kpi-value">
                    <CountUp value={data.emails.pending} />
                  </div>
                  <div className="wk-kpi-note">{data.emails.generated} drafted</div>
                </article>
                <article className="wk-kpi">
                  <div className="wk-kpi-label">Sent</div>
                  <div className="wk-kpi-value">
                    <CountUp value={data.emails.sent} />
                  </div>
                  <div className="wk-kpi-note">
                    {data.emails.failed ? `${data.emails.failed} failed` : "No failures"}
                  </div>
                </article>
              </div>
            </div>

            <div className="wk-kpi-group">
              <h2 className="wk-kpi-group-title">Performance</h2>
              <div className="wk-kpi-grid">
                <article className="wk-kpi">
                  <div className="wk-kpi-label">Opened</div>
                  <div className="wk-kpi-value">
                    <CountUp value={derived.openedMessages} />
                  </div>
                  <div className="wk-kpi-note">
                    {derived.opensToday > 0
                      ? `${derived.opensToday} open${derived.opensToday === 1 ? "" : "s"} today`
                      : `${derived.openRate}% of sends`}
                  </div>
                </article>
                <article className="wk-kpi">
                  <div className="wk-kpi-label">Reply rate</div>
                  <div className="wk-kpi-value">
                    <CountUp
                      value={derived.replyRate}
                      suffix="%"
                      decimals={derived.replyRate % 1 === 0 ? 0 : 1}
                    />
                  </div>
                  <div className="wk-kpi-note">
                    {data.replies.total} of {data.emails.sent} sent
                  </div>
                </article>
              </div>
            </div>
          </section>

          <div className="wk-split rise rise-1">
            <Card
              title="Needs your attention"
              sub="The next four decisions in the pipeline."
              actions={
                <Link className="btn btn-sm btn-ghost" href="/review">
                  Open review
                </Link>
              }
            >
              <div className="wk-rows">
                {derived.needs.map((need) => (
                  <Link key={need.href} className="wk-row" href={need.href}>
                    <div>
                      <div className="wk-row-title">
                        <span className="wk-dot" data-tone={need.tone} />
                        {need.title}
                      </div>
                      <div className="wk-row-hint">{need.hint}</div>
                    </div>
                    <div className="wk-row-end">
                      <span className="wk-count" data-zero={need.count ? undefined : "true"}>
                        {need.count || "—"}
                      </span>
                      <ArrowRight size={14} className="wk-arrow" aria-hidden="true" />
                    </div>
                  </Link>
                ))}
              </div>
            </Card>

            <Card
              title="Pipeline"
              sub="Where every prospect currently sits"
              actions={
                <Link className="btn btn-sm btn-ghost" href="/leads">
                  All leads
                </Link>
              }
            >
              <div className="wk-bars">
                {derived.funnel.map((stage) => (
                  <div key={stage.label} className="wk-bar-row">
                    <span className="wk-bar-label">{stage.label}</span>
                    <span className="wk-bar-track">
                      <span
                        className="wk-bar-fill"
                        data-final={stage.final ? "true" : undefined}
                        style={{ width: `${Math.max(2, (stage.value / derived.funnelMax) * 100)}%` }}
                      />
                    </span>
                    <span className="wk-bar-value">{stage.value}</span>
                  </div>
                ))}
              </div>
              <p className="wk-foot-note">
                {data.leads.total
                  ? `${Math.round((data.leads.researched / Math.max(1, data.leads.total)) * 100)}% of prospects have research evidence stored.`
                  : "Import prospects and the pipeline fills itself in."}
              </p>
            </Card>
          </div>

          {derived.incompleteSetup && (
            <Card
              title={derived.freshAccount ? "Get set up in four steps" : "Finish your setup"}
              sub="Each step is optional to look at, but the pipeline only runs when all four are done."
            >
              <div className="wk-setup">
                {derived.setup.map((step, index) => (
                  <Link key={step.href} href={step.href} className="wk-setup-step" data-done={step.done}>
                    <span className="wk-setup-n">{step.done ? <Check size={11} /> : index + 1}</span>
                    <span>
                      <span className="wk-setup-title">{step.title}</span>
                      <span className="wk-setup-hint">{step.hint}</span>
                    </span>
                  </Link>
                ))}
              </div>
            </Card>
          )}

          <Card
            title="Campaigns"
            sub="Live status of your outreach"
            actions={
              <Link className="btn btn-sm btn-ghost" href="/campaigns">
                Manage
              </Link>
            }
          >
            {data.campaigns.length === 0 ? (
              <Empty title="No campaigns yet">
                Plan one from the <Link href="/campaigns">campaigns page</Link>, or import a sheet to get prospects
                first.
              </Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Campaign</th>
                      <th>Status</th>
                      <th className="num">Leads</th>
                      <th className="num">Sent</th>
                      <th className="num">Waiting</th>
                      <th className="num">Replies</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.campaigns.map((campaign) => (
                      <tr key={campaign.id}>
                        <td className="strong">{campaign.name}</td>
                        <td>
                          <Badge tone={statusTone(campaign.status)}>{label(campaign.status)}</Badge>
                        </td>
                        <td className="num">{campaign.leads}</td>
                        <td className="num">{campaign.sent}</td>
                        <td className="num">{campaign.pending}</td>
                        <td className="num">{campaign.replies}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <div className="wk-split">
            <Card
              title="Sending activity"
              sub="Confirmed Gmail sends, last 14 days"
              actions={
                <Link className="btn btn-sm btn-ghost" href="/analytics">
                  Analytics
                  <ArrowUpRight size={12} />
                </Link>
              }
            >
              {data.sends.length === 0 ? (
                <Empty title="Nothing sent yet">
                  Approved emails appear here once Gmail confirms the send.
                </Empty>
              ) : (
                <>
                  <div className="wk-chart" aria-hidden="true">
                    {derived.days.map((day) => (
                      <div key={day.key} className="wk-chart-col" title={`${day.key}: ${day.count} sent`}>
                        <div
                          className="wk-chart-bar"
                          style={{ height: `${Math.max(4, (day.count / derived.maxSend) * 72)}px` }}
                        />
                        <span className="wk-chart-day">{day.short}</span>
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-3" style={{ marginTop: 16 }}>
                    <Stat
                      label="Sent"
                      value={data.emails.sent}
                      note={data.emails.failed ? `${data.emails.failed} failed` : "No failures"}
                    />
                    <Stat label="Replies" value={data.replies.total} note={`${data.replies.positive} positive`} />
                    <Stat label="Reply rate" value={`${derived.replyRate}%`} note="All time" accent />
                  </div>
                </>
              )}
            </Card>

            <Card
              title="Recent activity"
              sub="Audit trail of what the system did"
              actions={
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => setClearActivityOpen(true)}
                  title="Clear activity log entries"
                >
                  <Trash2 size={12} aria-hidden="true" />
                  Clear activity
                </button>
              }
            >
              {data.activity.length === 0 ? (
                <Empty title="No activity yet">
                  Imports, research runs, approvals and sends are logged here.
                </Empty>
              ) : (
                <ul className="wk-feed">
                  {data.activity.map((item, index) => (
                    <li key={`${item.created_at}-${index}`}>
                      <span className="wk-feed-time">
                        {new Date(item.created_at).toLocaleString(undefined, {
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      <span className="wk-feed-text">{item.action.replace(/_/g, " ")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <ClearActivityModal
            open={clearActivityOpen}
            onClose={() => setClearActivityOpen(false)}
            uid={user.uid}
            onCleared={loadData}
          />
        </div>
      )}

      {!loading && !data && (
        <div className="stack" style={{ marginTop: 18 }}>
          <Empty title="This screen could not load">
            The workspace data did not arrive. Check your connection and try again — nothing was changed.
            <div className="row" style={{ marginTop: 12, justifyContent: "center" }}>
              <button type="button" className="btn btn-sm" onClick={() => window.location.reload()}>
                <RotateCcw size={13} aria-hidden="true" />
                Try again
              </button>
            </div>
          </Empty>
        </div>
      )}
    </main>
  );
}
