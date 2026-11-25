"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  CheckSquare,
  Clock,
  MessageSquare,
  Search,
  Sparkles,
} from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { Badge, Banner, Card, Empty, Stat } from "@/components/ui";
import { LoadingPanel } from "@/components/Loading";
import { CountUp } from "@/components/motion/CountUp";
import { errorMessage } from "@/lib/client";
import { loadDashboardBundle } from "@/lib/firestore-store";
import { label, statusTone } from "@/lib/format";

type DashboardData = Awaited<ReturnType<typeof loadDashboardBundle>>;

const LOAD_STEPS = [
  { label: "Opening your Knowrevo workspace", ms: 700 },
  { label: "Loading prospects and campaigns", ms: 900 },
  { label: "Tallying emails, replies and activity", ms: 700 },
];

export default function DashboardPage() {
  const { user, workspaceToken, reconnectWorkspace } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      { label: "Prospects", value: data.leads.total, soft: false },
      { label: "Researched", value: data.leads.researched, soft: false },
      { label: "Qualified", value: data.leads.qualified, soft: false },
      { label: "Emails drafted", value: data.emails.generated, soft: true },
      { label: "Sent", value: data.emails.sent, soft: false },
      { label: "Replied", value: data.replies.total, soft: false },
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
        hint: data.knowledgeEmpty ? "Tell the AI who you are" : "In place",
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
      freshAccount: data.leads.total === 0 && data.campaigns.length === 0,
      incompleteSetup: setup.some((step) => !step.done),
    };
  }, [data, workspaceToken]);

  return (
    <main className="page">
      {error && <Banner tone="bad">{error}</Banner>}

      {loading && !data && (
        <div className="stack">
          <LoadingPanel
            label="Preparing your workspace"
            estimateMs={2300}
            steps={LOAD_STEPS}
          />
          <div className="skel" style={{ height: 190, borderRadius: 18 }} />
          <div className="grid grid-auto">
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="skel" style={{ height: 84 }} />
            ))}
          </div>
          <div className="grid grid-2">
            <div className="skel" style={{ height: 250 }} />
            <div className="skel" style={{ height: 250 }} />
          </div>
          <div className="grid grid-2">
            <div className="skel" style={{ height: 200 }} />
            <div className="skel" style={{ height: 200 }} />
          </div>
        </div>
      )}

      {data && derived && (
        <div className="stack">
          <section className="hero dash-hero rise" aria-label="Workspace overview">
            <div className="hero-eyebrow">Workspace overview</div>
            <h1>
              {greeting}, {firstName}.
            </h1>
            <p>{derived.summary}</p>

            <div className="dash-actions">
              {!workspaceToken ? (
                <button
                  className="btn dash-cta"
                  onClick={() => void reconnectWorkspace()}
                  type="button"
                >
                  Connect Google
                  <ArrowRight size={14} />
                </button>
              ) : derived.focus ? (
                <Link className="btn dash-cta" href={derived.focus.href}>
                  {derived.focus.label}
                  <ArrowRight size={14} />
                </Link>
              ) : null}
              <Link className="btn dash-cta-ghost" href="/campaigns">
                <Sparkles size={14} />
                New campaign
              </Link>
              <Link className="btn dash-cta-ghost" href="/research">
                <Search size={14} />
                Discover prospects
              </Link>
            </div>

            <div className="hero-grid">
              <div className="hero-chip">
                <div className="hero-chip-label">Prospects</div>
                <div className="hero-chip-value">
                  <CountUp value={data.leads.total} />
                </div>
                <div className="hero-chip-note">{data.leads.byStatus.new ?? 0} unprocessed</div>
              </div>
              <div className="hero-chip">
                <div className="hero-chip-label">Qualified</div>
                <div className="hero-chip-value">
                  <CountUp value={data.leads.qualified} />
                </div>
                <div className="hero-chip-note">{data.leads.disqualified} disqualified</div>
              </div>
              <div className="hero-chip">
                <div className="hero-chip-label">Awaiting approval</div>
                <div className="hero-chip-value">
                  <CountUp value={data.emails.pending} />
                </div>
                <div className="hero-chip-note">{data.emails.generated} drafted</div>
              </div>
              <div className="hero-chip">
                <div className="hero-chip-label">Emails opened</div>
                <div className="hero-chip-value">
                  <CountUp value={derived.openedMessages} />
                </div>
                <div className="hero-chip-note">
                  {derived.opensToday > 0
                    ? `${derived.opensToday} open${derived.opensToday === 1 ? "" : "s"} today`
                    : `${derived.openRate}% of sends`}
                </div>
              </div>
              <div className="hero-chip">
                <div className="hero-chip-label">Reply rate</div>
                <div className="hero-chip-value">
                  <CountUp
                    value={derived.replyRate}
                    suffix="%"
                    decimals={derived.replyRate % 1 === 0 ? 0 : 1}
                  />
                </div>
                <div className="hero-chip-note">
                  {data.replies.total} of {data.emails.sent} sent
                </div>
              </div>
            </div>
          </section>

          {derived.incompleteSetup && (
            <Card
              title={derived.freshAccount ? "Get set up in four steps" : "Finish your setup"}
              sub="Each step is optional to look at, but the pipeline only runs when all four are done."
            >
              <div className="setup-path">
                {derived.setup.map((step, index) => (
                  <Link key={step.href} href={step.href} className="setup-step" data-done={step.done}>
                    <span className="setup-num">{step.done ? "✓" : index + 1}</span>
                    <span>
                      <span className="setup-title" style={{ display: "block" }}>
                        {step.title}
                      </span>
                      <span className="setup-hint">{step.hint}</span>
                    </span>
                  </Link>
                ))}
              </div>
            </Card>
          )}

          <div className="quick-grid rise rise-1">
            <QuickCard
              href="/review"
              icon={<CheckSquare size={17} strokeWidth={1.8} />}
              title="Emails to review"
              count={data.emails.pending}
              hint={
                data.emails.pending
                  ? "Nothing sends without your approval."
                  : "New drafts will appear here."
              }
              tone={data.emails.pending ? "warn" : "idle"}
            />
            <QuickCard
              href="/conversations"
              icon={<MessageSquare size={17} strokeWidth={1.8} />}
              title="Replies"
              count={data.replies.total}
              hint={
                data.replies.positive
                  ? `${data.replies.positive} interested — answer while it is warm.`
                  : "Synced from Gmail and classified."
              }
              tone={data.replies.positive ? undefined : "idle"}
            />
            <QuickCard
              href="/followups"
              icon={<Clock size={17} strokeWidth={1.8} />}
              title="Follow-ups due"
              count={data.followupsDue}
              hint="Sequences stop automatically on reply."
              tone={data.followupsDue ? "warn" : "idle"}
            />
            <QuickCard
              href="/research"
              icon={<Search size={17} strokeWidth={1.8} />}
              title="Waiting for research"
              count={derived.queued}
              hint="Each prospect is checked against their real website."
              tone={derived.queued ? undefined : "idle"}
            />
          </div>

          <div className="grid grid-2 rise rise-2">
            <Card
              title="Pipeline"
              sub="Where every prospect currently sits"
              actions={
                <Link className="btn btn-sm" href="/leads">
                  All leads
                </Link>
              }
            >
              <div className="funnel">
                {derived.funnel.map((stage) => (
                  <div key={stage.label} className="funnel-row">
                    <span className="funnel-label">{stage.label}</span>
                    <span className="funnel-track">
                      <span
                        className={`funnel-fill${stage.soft ? " soft" : ""}`}
                        style={{ width: `${Math.max(2, (stage.value / derived.funnelMax) * 100)}%` }}
                      />
                    </span>
                    <span className="funnel-value">{stage.value}</span>
                  </div>
                ))}
              </div>
              <p className="funnel-note">
                {data.leads.total
                  ? `${Math.round((data.leads.researched / Math.max(1, data.leads.total)) * 100)}% of your prospects have research evidence stored.`
                  : "Import prospects and the funnel fills itself in."}
              </p>
            </Card>

            <Card
              title="Campaigns"
              sub="Live status of your outreach"
              actions={
                <Link className="btn btn-sm" href="/campaigns">
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
          </div>

          <div className="grid grid-2">
            <Card
              title="Sending activity"
              sub="Confirmed Gmail sends, last 14 days"
              actions={
                <Link className="btn btn-sm" href="/analytics">
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
                  <div className="spark" aria-hidden="true">
                    {derived.days.map((day) => (
                      <div key={day.key} className="spark-col" title={`${day.key}: ${day.count} sent`}>
                        <div
                          className="spark-bar"
                          style={{ height: `${Math.max(4, (day.count / derived.maxSend) * 84)}px` }}
                        />
                        <span className="spark-day">{day.short}</span>
                      </div>
                    ))}
                  </div>
                  <div className="row" style={{ marginTop: 14 }}>
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

            <Card title="Recent activity" sub="Audit trail of what the system did">
              {data.activity.length === 0 ? (
                <Empty title="No activity yet">
                  Imports, research runs, approvals and sends are logged here.
                </Empty>
              ) : (
                <ul className="feed">
                  {data.activity.map((item, index) => (
                    <li key={`${item.created_at}-${index}`}>
                      <span className="feed-time">
                        {new Date(item.created_at).toLocaleString(undefined, {
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      <span className="feed-text">{item.action.replace(/_/g, " ")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}
    </main>
  );
}

function QuickCard({
  href,
  icon,
  title,
  count,
  hint,
  tone,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  count: number;
  hint: string;
  tone?: string | null;
}) {
  return (
    <Link className="quick-card" href={href} data-tone={tone ?? undefined}>
      <span className="quick-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="quick-body">
        <span className="quick-title" style={{ display: "block" }}>
          {title}
        </span>
        <span className="quick-hint">{hint}</span>
      </span>
      <span className={`quick-count${count ? "" : " null"}`}>{count || "—"}</span>
    </Link>
  );
}
