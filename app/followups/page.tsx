"use client";

import { BrandLoader } from "@/components/BrandLoader";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";
import { BatchRunner } from "@/components/Runner";
import { Badge, Banner, Card, Empty, Stat } from "@/components/ui";
import { MobileFeedRow } from "@/components/ui/MobileFeedRow";
import { errorMessage } from "@/lib/client";
import { loadFollowupsBundle } from "@/lib/store";
import { fmtDate, label, statusTone } from "@/lib/format";

type FollowupsData = Awaited<ReturnType<typeof loadFollowupsBundle>>;

export default function FollowupsPage() {
  const { user } = useAuth();
  const [data, setData] = useState<FollowupsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await loadFollowupsBundle(user.uid));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [user.uid]);

  // Keep the due list fresh after the background reply sync or a send.
  useEffect(() => {
    const onRefresh = () => void reload();
    window.addEventListener("os:data-refreshed", onRefresh);
    return () => window.removeEventListener("os:data-refreshed", onRefresh);
  }, [reload]);

  useEffect(() => {
    let active = true;
    loadFollowupsBundle(user.uid).then(
      (res) => {
        if (!active) return;
        setData(res);
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

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Follow-ups</h1>
          <p className="page-sub">
            Follow-ups are only generated when the campaign schedule says they are due, the prospect has not replied,
            and they have not opted out. Each one adds a new reason to respond instead of repeating the first email.
          </p>
        </div>
      </div>

      <div className="stack">
        {error && <Banner tone="bad">{error}</Banner>}

        <div className="grid grid-auto">
          <Stat label="Due now" value={data?.due.length ?? 0} accent note="No reply yet" />
          <Stat label="Awaiting approval" value={data?.drafted.length ?? 0} note="Review before sending" />
          <Stat label="Follow-ups sent" value={data?.followupsSent ?? 0} />
        </div>

        <Card title="Generate follow-ups" sub="Writes the next scheduled message for each due prospect.">
          <div className="row">
            <BatchRunner type="followup" label="Prepare due follow-ups" limit={2} variant="primary" onDone={reload} />
            <BatchRunner
              type="send"
              label="Send approved emails"
              limit={2}
              confirmText="Send every approved email now, including follow-ups, from your connected Gmail account? They go to real prospects."
              onDone={reload}
            />
            <Link className="btn btn-sm" href="/review">
              Review drafted follow-ups
            </Link>
          </div>
          <p className="hint" style={{ marginTop: 8 }}>
            Campaign approval is required. Adjust follow-up gaps in the campaign settings.
          </p>
        </Card>

        <Card title="Due prospects" sub="Eligible for the next message right now">
          {loading && !data ? (
            <BrandLoader />
          ) : (data?.due.length ?? 0) === 0 ? (
            <Empty title="Nothing due">
              Prospects become eligible after the first follow-up gap in the campaign (for example 4 days with no
              reply).
            </Empty>
          ) : (
            <>
            <div className="m-feed mobile-only">
              {data?.due.map((item) => (
                <MobileFeedRow
                  key={`${item.leadId}-${item.step}`}
                  title={item.business ?? item.email ?? "Untitled prospect"}
                  subtitle={item.campaignName}
                  meta={`${item.daysSince}d since contact · ${fmtDate(item.lastContactedAt)}`}
                  status={`Step ${item.step}`}
                  statusTone="info"
                />
              ))}
            </div>
            <div className="table-wrap desktop-only">
              <table>
                <thead>
                  <tr>
                    <th>Prospect</th>
                    <th>Campaign</th>
                    <th className="num">Next step</th>
                    <th className="num">Days since contact</th>
                    <th>Last contacted</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.due.map((item) => (
                    <tr key={`${item.leadId}-${item.step}`}>
                      <td>
                        <div className="strong">{item.business ?? item.email ?? "—"}</div>
                        <div className="tiny">
                          {item.email} {item.industry ? `· ${item.industry}` : ""}
                        </div>
                      </td>
                      <td>{item.campaignName}</td>
                      <td className="num">{item.step}</td>
                      <td className="num">{item.daysSince}</td>
                      <td className="tiny nowrap">{fmtDate(item.lastContactedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
        </Card>

        <Card title="Drafted follow-ups" sub="Waiting in the review queue">
          {(data?.drafted.length ?? 0) === 0 ? (
            <Empty title="No drafted follow-ups yet" />
          ) : (
            <>
            <div className="m-feed mobile-only">
              {data?.drafted.map((message) => (
                <MobileFeedRow
                  key={message.id}
                  title={message.business ?? message.lead_email ?? "Untitled prospect"}
                  subtitle={message.subject ?? "No subject"}
                  meta={`Step ${message.step} · ${fmtDate(message.created_at)}`}
                  status={label(message.status)}
                  statusTone={message.status === "approved" ? "ok" : "info"}
                />
              ))}
            </div>
            <div className="table-wrap desktop-only">
              <table>
                <thead>
                  <tr>
                    <th>Prospect</th>
                    <th>Subject</th>
                    <th className="num">Step</th>
                    <th>Status</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.drafted.map((message) => (
                    <tr key={message.id}>
                      <td className="strong">{message.business ?? message.lead_email}</td>
                      <td>{message.subject}</td>
                      <td className="num">{message.step}</td>
                      <td>
                        <Badge tone={statusTone(message.status)}>{label(message.status)}</Badge>
                      </td>
                      <td className="tiny nowrap">{fmtDate(message.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
        </Card>
      </div>
    </main>
  );
}
