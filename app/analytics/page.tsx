"use client";

import { useState } from "react";
import { api, errorMessage, useApi } from "@/lib/client";
import { Badge, Banner, Card, Empty, Progress, Stat } from "@/components/ui";
import { label } from "@/lib/format";

interface Metrics {
  funnel: Record<string, number>;
  sendsByDay: { day: string; c: number }[];
  replyTypes: Record<string, number>;
  campaigns: { id: string; name: string; status: string; leads: number; sent: number; replies: number; positive: number }[];
  industries: { industry: string; leads: number; contacted: number; replied: number }[];
  angles: { angle: string; sent: number; replied: number }[];
  delivery: { sent: number; failed: number; pending: number };
  totals: { leads: number; campaigns: number; replies: number; replyRate: number; positive: number };
}

interface Insight {
  headline: string;
  observations: string[];
  recommendations: { title: string; detail: string; priority: string }[];
  data_limits: string;
}

const FUNNEL_STEPS: [string, string][] = [
  ["total", "Leads imported"],
  ["researched", "Researched"],
  ["qualified", "Qualified"],
  ["contacted", "Contacted"],
  ["replied", "Replied"],
  ["converted", "Converted"],
];

export default function AnalyticsPage() {
  const { data, loading, error } = useApi<Metrics>("/api/analytics");
  const [insight, setInsight] = useState<Insight | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const analyse = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await api.post<{ insight: Insight }>("/api/analytics", {});
      setInsight(result.insight);
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const funnelValue = (key: string): number => {
    if (!data) return 0;
    if (key === "total") return data.totals.leads;
    if (key === "contacted") return data.delivery.sent;
    if (key === "replied") return data.totals.replies;
    return data.funnel[key] ?? 0;
  };

  const maxFunnel = Math.max(1, ...FUNNEL_STEPS.map(([key]) => funnelValue(key)));

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Analytics</h1>
          <p className="page-sub">
            Only measured numbers are shown. “Sent” means Gmail accepted the message; replies come from the mailbox
            sync. Nothing here is estimated.
          </p>
        </div>
        <div className="row-end">
          <button className="btn btn-primary" onClick={analyse} disabled={busy} type="button">
            {busy ? "Analysing…" : "Analyse performance"}
          </button>
        </div>
      </div>

      <div className="stack">
        {error && <Banner tone="bad">{error}</Banner>}
        {failure && <Banner tone="bad">{failure}</Banner>}
        {loading && !data && <Progress label="Crunching numbers…" />}

        {data && (
          <>
            <div className="grid grid-auto">
              <Stat label="Leads" value={data.totals.leads} note={`${data.totals.campaigns} campaigns`} />
              <Stat label="Emails sent" value={data.delivery.sent} note={`${data.delivery.failed} failed`} />
              <Stat label="Replies" value={data.totals.replies} note={`${data.totals.replyRate}% of sends`} accent />
              <Stat label="Positive replies" value={data.totals.positive} note="Interested, info, pricing" />
              <Stat label="Awaiting approval" value={data.delivery.pending} />
            </div>

            <div className="grid grid-2">
              <Card title="Pipeline funnel" sub="Counting real records in each stage">
                <div className="stack" style={{ gap: 8 }}>
                  {FUNNEL_STEPS.map(([key, text]) => {
                    const value = funnelValue(key);
                    return (
                      <div key={key} className="row" style={{ gap: 10 }}>
                        <span className="tiny" style={{ width: 120 }}>{text}</span>
                        <div style={{ flex: 1, background: "var(--surface-2)", height: 16, borderRadius: 6 }}>
                          <div
                            style={{
                              width: `${Math.max(2, (value / maxFunnel) * 100)}%`,
                              height: "100%",
                              background: "var(--accent)",
                              borderRadius: 6,
                              opacity: 0.8,
                            }}
                          />
                        </div>
                        <span className="tiny num" style={{ width: 38, textAlign: "right" }}>{value}</span>
                      </div>
                    );
                  })}
                </div>
              </Card>

              <Card title="Replies by type" sub="Classified from the actual message text">
                {Object.keys(data.replyTypes).length === 0 ? (
                  <Empty title="No replies recorded" />
                ) : (
                  <ul style={{ listStyle: "none", padding: 0, margin: 0 }} className="stack">
                    {Object.entries(data.replyTypes).map(([type, count]) => (
                      <li key={type} className="row">
                        <Badge tone={["interested", "more_info", "pricing"].includes(type) ? "ok" : undefined}>{label(type)}</Badge>
                        <span className="num row-end">{count}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>

            <Card title="Campaign performance" sub="Per campaign, from recorded sends and replies">
              {data.campaigns.length === 0 ? (
                <Empty title="No campaigns yet" />
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Campaign</th>
                        <th>Status</th>
                        <th className="num">Leads</th>
                        <th className="num">Sent</th>
                        <th className="num">Replies</th>
                        <th className="num">Positive</th>
                        <th className="num">Reply rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.campaigns.map((campaign) => (
                        <tr key={campaign.id}>
                          <td className="strong">{campaign.name}</td>
                          <td><Badge>{label(campaign.status)}</Badge></td>
                          <td className="num">{campaign.leads}</td>
                          <td className="num">{campaign.sent}</td>
                          <td className="num">{campaign.replies}</td>
                          <td className="num">{campaign.positive}</td>
                          <td className="num">{campaign.sent ? `${Math.round((campaign.replies / campaign.sent) * 100)}%` : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <div className="grid grid-2">
              <Card title="By industry" sub="Contacted means at least one send attempt">
                {data.industries.length === 0 ? (
                  <Empty title="No industry data yet" />
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr><th>Industry</th><th className="num">Leads</th><th className="num">Contacted</th><th className="num">Replied</th></tr>
                      </thead>
                      <tbody>
                        {data.industries.map((row) => (
                          <tr key={row.industry}>
                            <td>{row.industry}</td>
                            <td className="num">{row.leads}</td>
                            <td className="num">{row.contacted}</td>
                            <td className="num">{row.replied}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>

              <Card title="By approach" sub="Which angles actually got answers">
                {data.angles.length === 0 ? (
                  <Empty title="No sent emails yet" />
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr><th>Angle</th><th className="num">Sent</th><th className="num">Replied</th></tr>
                      </thead>
                      <tbody>
                        {data.angles.map((row) => (
                          <tr key={row.angle}>
                            <td className="wrap">{row.angle}</td>
                            <td className="num">{row.sent}</td>
                            <td className="num">{row.replied}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>

            {insight && (
              <Card title="AI performance review" sub={insight.headline}>
                <ul style={{ fontSize: 13, paddingLeft: 16 }}>
                  {insight.observations.map((observation, index) => <li key={index} style={{ marginBottom: 4 }}>{observation}</li>)}
                </ul>
                <div className="stack" style={{ marginTop: 12 }}>
                  {insight.recommendations.map((recommendation, index) => (
                    <div key={index} className="banner">
                      <div>
                        <strong style={{ display: "block" }}>{recommendation.title}</strong>
                        <span className="tiny">{recommendation.detail}</span>
                      </div>
                      <div className="row-end"><Badge tone={recommendation.priority === "high" ? "bad" : recommendation.priority === "medium" ? "warn" : undefined}>{recommendation.priority}</Badge></div>
                    </div>
                  ))}
                </div>
                <p className="tiny" style={{ marginTop: 10 }}>{insight.data_limits}</p>
              </Card>
            )}
          </>
        )}
      </div>
    </main>
  );
}
