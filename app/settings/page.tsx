"use client";

import { useEffect, useState } from "react";
import { api, errorMessage, useApi } from "@/lib/client";
import { Banner, Card, Empty, Field, Progress } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import type { Settings } from "@/lib/types";

export default function SettingsPage() {
  const settings = useApi<Settings>("/api/settings");
  const suppression = useApi<{ entries: { email: string; reason: string; created_at: string }[] }>("/api/suppression");
  const [form, setForm] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (settings.data) setForm(settings.data);
  }, [settings.data]);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  const save = async () => {
    if (!form) return;
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      await api.put("/api/settings", form);
      setNotice("Settings saved.");
      await settings.reload();
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const block = async () => {
    if (!email.trim()) return;
    try {
      await api.post("/api/suppression", { email, reason: reason || "Added manually" });
      setEmail("");
      setReason("");
      await suppression.reload();
      setNotice("Address suppressed. It will never be contacted.");
    } catch (err) {
      setFailure(errorMessage(err));
    }
  };

  const unblock = async (value: string) => {
    if (!window.confirm(`Allow contact with ${value} again?`)) return;
    try {
      await api.del(`/api/suppression?email=${encodeURIComponent(value)}`);
      await suppression.reload();
    } catch (err) {
      setFailure(errorMessage(err));
    }
  };

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">
            Sending identity, limits and compliance. These values are enforced by the server on every send, not just
            displayed in the interface.
          </p>
        </div>
      </div>

      <div className="stack">
        {settings.error && <Banner tone="bad">{settings.error}</Banner>}
        {failure && <Banner tone="bad">{failure}</Banner>}
        {notice && <Banner tone="ok">{notice}</Banner>}
        {settings.loading && !form && <Progress label="Loading settings…" />}

        {form && (
          <Card title="Sender identity" sub="Used in every email and in the signature.">
            <div className="grid grid-3">
              <Field label="Your name"><input className="input" value={form.sender_name} onChange={(e) => set("sender_name", e.target.value)} /></Field>
              <Field label="Role / positioning"><input className="input" value={form.sender_role} onChange={(e) => set("sender_role", e.target.value)} /></Field>
              <Field label="Company"><input className="input" value={form.sender_company} onChange={(e) => set("sender_company", e.target.value)} /></Field>
              <Field label="Reply-to address (optional)" hint="Defaults to the connected Gmail address.">
                <input className="input" value={form.sender_email} onChange={(e) => set("sender_email", e.target.value)} placeholder="you@gmail.com" />
              </Field>
              <Field label="Unsubscribe address (optional)" hint="Adds a List-Unsubscribe header for compliance.">
                <input className="input" value={form.unsubscribe_email} onChange={(e) => set("unsubscribe_email", e.target.value)} />
              </Field>
              <Field label="Model"><input className="input" value={form.model} onChange={(e) => set("model", e.target.value)} /></Field>
            </div>
            <Field label="Physical address (optional)" hint="Some jurisdictions require a postal address in cold email.">
              <input className="input" value={form.physical_address} onChange={(e) => set("physical_address", e.target.value)} />
            </Field>
          </Card>
        )}

        {form && (
          <Card title="Sending controls" sub="Conservatively enforced to stay inside Gmail limits and anti-spam expectations.">
            <div className="grid grid-3">
              <Field label="Daily send limit" hint="25/day is a safe ceiling for a regular Gmail account.">
                <input className="input" type="number" min={1} max={200} value={form.daily_limit} onChange={(e) => set("daily_limit", Number(e.target.value))} />
              </Field>
              <Field label="Campaign send limit">
                <input className="input" type="number" min={1} max={500} value={form.campaign_limit} onChange={(e) => set("campaign_limit", Number(e.target.value))} />
              </Field>
              <Field label="Seconds between emails">
                <input className="input" type="number" min={30} max={900} value={form.interval_seconds} onChange={(e) => set("interval_seconds", Number(e.target.value))} />
              </Field>
              <Field label="Sending starts (hour)">
                <input className="input" type="number" min={0} max={23} value={form.send_window_start} onChange={(e) => set("send_window_start", Number(e.target.value))} />
              </Field>
              <Field label="Sending ends (hour)">
                <input className="input" type="number" min={1} max={24} value={form.send_window_end} onChange={(e) => set("send_window_end", Number(e.target.value))} />
              </Field>
              <Field label="Sending days" hint="1 = Monday … 7 = Sunday">
                <input className="input" value={form.send_days} onChange={(e) => set("send_days", e.target.value)} />
              </Field>
              <Field label="Timezone offset (minutes from UTC)" hint="60 = UTC+1 (WAT).">
                <input className="input" type="number" min={-720} max={840} value={form.timezone_offset} onChange={(e) => set("timezone_offset", Number(e.target.value))} />
              </Field>
              <Field label="Default follow-up gap (days)">
                <input className="input" type="number" min={1} max={30} value={form.followup_days} onChange={(e) => set("followup_days", Number(e.target.value))} />
              </Field>
              <Field label="Default minimum score">
                <input className="input" type="number" min={0} max={100} value={form.min_score} onChange={(e) => set("min_score", Number(e.target.value))} />
              </Field>
            </div>
            <div className="row">
              <button className="btn btn-primary" onClick={save} disabled={busy} type="button">
                {busy ? "Saving…" : "Save settings"}
              </button>
              <span className="tiny">Sending outside these hours is refused by the server.</span>
            </div>
          </Card>
        )}

        <Card title="Suppression list" sub="Contacts who must never be emailed again, including automatic unsubscribes.">
          <div className="row" style={{ marginBottom: 12 }}>
            <input className="input" style={{ maxWidth: 280 }} placeholder="email@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <input className="input" style={{ maxWidth: 280 }} placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className="btn" onClick={block} type="button">Suppress address</button>
          </div>
          {(suppression.data?.entries.length ?? 0) === 0 ? (
            <Empty title="No suppressed addresses">Unsubscribes are added here automatically when replies are synced.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Email</th><th>Reason</th><th>Added</th><th /></tr>
                </thead>
                <tbody>
                  {suppression.data?.entries.map((entry) => (
                    <tr key={entry.email}>
                      <td className="strong">{entry.email}</td>
                      <td className="tiny">{entry.reason}</td>
                      <td className="tiny nowrap">{fmtDate(entry.created_at)}</td>
                      <td><button className="btn btn-sm btn-ghost" onClick={() => unblock(entry.email)} type="button">Allow again</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Data" sub="Your data lives in the project's D1 database.">
          <ul className="tiny" style={{ paddingLeft: 16 }}>
            <li>Delete a prospect and its emails from the Leads page; the deletion is recorded in the audit log.</li>
            <li>Disconnecting Google in Integrations deletes all stored OAuth tokens.</li>
            <li>Campaign history and audit entries remain available for your own records.</li>
          </ul>
        </Card>
      </div>
    </main>
  );
}
