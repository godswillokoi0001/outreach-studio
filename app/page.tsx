"use client";

import Link from "next/link";
import { useApi } from "@/lib/client";
import { Badge, Banner, Card, Empty, Progress, Stat } from "@/components/ui";
import { label, statusTone } from "@/lib/format";

interface Dashboard {
  leads: { total: number; byStatus: Record<string, number>; researched: number; qualified: number; disqualified: number };
  emails: { generated: number; pending: number; sent: number; failed: number };
  replies: { total: number; positive: number; byType: Record<string, number> };
  followupsDue: number;
  sends: { day: string; c: number }[];
  campaigns: { id: string; name: string; status: string; leads: number; sent: number; pending: number; replies: number }[];
  activity: { action: string; entity: string; created_at: string; detail: string | null }[];
  setup: {
    onboarding_needed: boolean;
    knowledge_empty: boolean;
    googleConfigured: boolean;
    googleConnected: boolean;
    geminiConfigured: boolean;
    geminiModel: string;
    senderName: string;
    is_platform_owner: boolean;
  };
}

export default function DashboardPage() {
  const { data, loading, error } = useApi<Dashboard>("/api/dashboard");

  const setup = data?.setup;
  const needsGoogle = setup && (!setup.googleConfigured || !setup.googleConnected);
  const needsGemini = setup && !setup.geminiConfigured;
  const needsKnowledge = setup && setup.knowledge_empty;
  const freshAccount = data && data.leads.total === 0 && data.campaigns.length === 0;

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-sub">
            Everything in one place: prospects researched, emails waiting for your approval, replies that need an
            answer, and the campaigns currently running.
          </p>
        </div>
      </div>

      {error && <Banner tone="bad">{error}</Banner>}
      {loading && !data && <Progress label="Loading your pipeline…" />}

      {(needsGoogle || needsGemini || needsKnowledge) && (
        <div className="stack" style={{ marginBottom: 16 }}>
          {freshAccount && (
            <Banner tone="info">
              <strong>Welcome. This workspace is empty.</strong> Three steps and it is ready: add your business knowledge,
              connect Google, then create a campaign. Nothing was pre-filled for anyone else.{" "}
              <Link href="/knowledge">Start with knowledge</Link>
            </Banner>
          )}
          {needsKnowledge && (
            <Banner tone="warn">
              <strong>No business knowledge yet.</strong> Add your master knowledge and sources so the AI writes as you,
              not as a generic template.{" "}
              <Link href="/knowledge">Open knowledge base</Link>
            </Banner>
          )}
          {needsGemini && (
            <Banner tone="warn">
              <strong>Gemini is not connected yet.</strong> Add a Google AI Studio API key in Integrations to switch
              on research, qualification and email writing.{" "}
              <Link href="/integrations">Open integrations</Link>
            </Banner>
          )}
          {needsGoogle && (
            <Banner tone="warn">
              <strong>{setup?.googleConfigured ? "Google is not connected." : "Google sign-in is not set up yet."}</strong>{" "}
              {setup?.googleConfigured
                ? "One click connects Google Sheets and Gmail."
                : setup?.is_platform_owner
                  ? "Add the Google OAuth client once, then every account connects with one click."
                  : "Ask the workspace owner to add the Google OAuth client, then connect with one click."}{" "}
              <Link href="/integrations">{setup?.googleConfigured ? "Connect Google" : "Review setup"}</Link>
            </Banner>
          )}
        </div>
      )}

      {data && (
        <div className="stack">
          <div className="grid grid-auto">
            <Stat label="Leads" value={data.leads.total} note={`${data.leads.byStatus.new ?? 0} unprocessed`} />
            <Stat label="Researched" value={data.leads.researched} note="Evidence stored" />
            <Stat label="Qualified" value={data.leads.qualified} accent note={`${data.leads.disqualified} disqualified`} />
            <Stat label="Emails waiting" value={data.emails.pending} note={`${data.emails.generated} generated`} />
            <Stat label="Sent" value={data.emails.sent} note={data.emails.failed ? `${data.emails.failed} failed` : "No failures"} />
            <Stat label="Replies" value={data.replies.total} note={`${data.replies.positive} positive`} />
            <Stat label="Follow-ups due" value={data.followupsDue} note="No reply yet" />
          </div>

          <div className="grid grid-2">
            <Card title="Next actions" sub="The shortest path through your pipeline today">
              <ol className="stack" style={{ listStyle: "none", padding: 0, gap: 10 }}>
                <Step
                  done={data.emails.pending > 0}
                  href="/review"
                  title={data.emails.pending ? `Review ${data.emails.pending} email${data.emails.pending === 1 ? "" : "s"}` : "Review generated emails"}
                  detail={data.emails.pending ? "Nothing sends without your approval." : "Emails appear here once a campaign composes them."}
                />
                <Step
                  done={data.replies.total > 0}
                  href="/conversations"
                  title={data.replies.total ? `Answer ${data.replies.total} repl${data.replies.total === 1 ? "y" : "ies"}` : "Conversations"}
                  detail={data.replies.positive ? `${data.replies.positive} interested prospects are waiting.` : "Classified replies and suggested answers."}
                />
                <Step
                  done={data.followupsDue > 0}
                  href="/followups"
                  title={data.followupsDue ? `${data.followupsDue} follow-up${data.followupsDue === 1 ? "" : "s"} due` : "Follow-ups"}
                  detail="Sequences stop automatically when someone replies."
                />
                <Step
                  done={data.leads.byStatus.queued_research > 0}
                  href="/research"
                  title="Research new prospects"
                  detail={`${data.leads.byStatus.queued_research ?? 0} waiting for research.`}
                />
              </ol>
            </Card>

            <Card
              title="Campaigns"
              sub="Live status of your outreach"
              actions={<Link className="btn btn-sm" href="/campaigns">Manage</Link>}
            >
              {data.campaigns.length === 0 ? (
                <Empty title="No campaigns yet">
                  Create one from the <Link href="/campaigns">campaigns page</Link> or start by importing a sheet.
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
                          <td><Badge tone={statusTone(campaign.status)}>{label(campaign.status)}</Badge></td>
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
            <Card title="Sending activity" sub="Confirmed Gmail sends, last 14 days">
              {data.sends.length === 0 ? (
                <Empty title="Nothing sent yet">Approved emails appear here once Gmail confirms delivery of the request.</Empty>
              ) : (
                <div className="stack" style={{ gap: 6 }}>
                  {data.sends.map((day) => {
                    const max = Math.max(...data.sends.map((d) => d.c));
                    return (
                      <div key={day.day} className="row" style={{ gap: 10 }}>
                        <span className="tiny nowrap" style={{ width: 76 }}>{day.day.slice(5)}</span>
                        <div style={{ flex: 1, background: "var(--surface-2)", borderRadius: 6, height: 16 }}>
                          <div
                            style={{
                              width: `${Math.max(6, (day.c / max) * 100)}%`,
                              background: "var(--accent)",
                              height: "100%",
                              borderRadius: 6,
                              opacity: 0.75,
                            }}
                          />
                        </div>
                        <span className="tiny num">{day.c}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            <Card title="Recent activity" sub="Audit trail of what the system did">
              {data.activity.length === 0 ? (
                <Empty title="No activity yet">Imports, research runs, approvals and sends are logged here.</Empty>
              ) : (
                <ul style={{ listStyle: "none", padding: 0, margin: 0 }} className="stack">
                  {data.activity.map((item, index) => (
                    <li key={index} className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                      <span className="tiny nowrap" style={{ width: 118 }}>
                        {new Date(item.created_at).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                      </span>
                      <span style={{ fontSize: 12.8 }}>{item.action.replace(/_/g, " ")}</span>
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

function Step({ href, title, detail, done }: { href: string; title: string; detail: string; done?: boolean }) {
  return (
    <li>
      <Link href={href} className="row" style={{ gap: 10, alignItems: "flex-start", textDecoration: "none", color: "inherit" }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 8,
            marginTop: 7,
            background: done ? "var(--accent)" : "var(--line)",
            flex: "0 0 8px",
          }}
        />
        <span>
          <span className="strong" style={{ display: "block" }}>{title}</span>
          <span className="tiny">{detail}</span>
        </span>
      </Link>
    </li>
  );
}
