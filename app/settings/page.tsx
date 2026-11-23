"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { Banner, Card, Empty, Field, Progress } from "@/components/ui";
import { errorMessage } from "@/lib/client";
import {
  addSuppression,
  getSettings,
  listSuppressions,
  removeSuppression,
  saveSettings,
} from "@/lib/firestore-store";
import { fmtDate } from "@/lib/format";
import { SUPPORTED_GEMINI_MODELS, resolveModel } from "@/lib/gemini-utils";
import type { Settings, Suppression } from "@/lib/types";

export default function SettingsPage() {
  const { user } = useAuth();
  const [form, setForm] = useState<Settings | null>(null);
  const [suppressions, setSuppressions] = useState<Suppression[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([getSettings(user.uid), listSuppressions(user.uid)]).then(
      ([s, sup]) => {
        if (!active) return;
        setForm(s);
        setSuppressions(sup);
        setLoading(false);
      },
      (err) => {
        if (!active) return;
        setFailure(errorMessage(err));
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [user.uid]);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  const save = async () => {
    if (!form) return;
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      const saved = await saveSettings(user.uid, form);
      setForm(saved);
      setNotice("Settings saved.");
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const block = async () => {
    if (!email.trim()) return;
    setFailure(null);
    try {
      await addSuppression(user.uid, email, reason || "Added manually");
      setEmail("");
      setReason("");
      setSuppressions(await listSuppressions(user.uid));
      setNotice("Address suppressed. It will never be contacted.");
    } catch (err) {
      setFailure(errorMessage(err));
    }
  };

  const unblock = async (value: string) => {
    if (!window.confirm(`Allow contact with ${value} again?`)) return;
    setFailure(null);
    try {
      await removeSuppression(user.uid, value);
      setSuppressions(await listSuppressions(user.uid));
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
            Sending identity, limits and compliance. These rules are enforced before every Gmail dispatch.
          </p>
        </div>
      </div>

      <div className="stack">
        {failure && <Banner tone="bad">{failure}</Banner>}
        {notice && <Banner tone="ok">{notice}</Banner>}
        {loading && !form && <Progress label="Loading settings…" />}

        {form && (
          <Card title="Sender identity" sub="Used in every email and in the signature.">
            <div className="grid grid-3">
              <Field label="Your name">
                <input
                  className="input"
                  value={form.sender_name}
                  onChange={(e) => set("sender_name", e.target.value)}
                />
              </Field>
              <Field label="Role / positioning">
                <input
                  className="input"
                  value={form.sender_role}
                  onChange={(e) => set("sender_role", e.target.value)}
                />
              </Field>
              <Field label="Company">
                <input
                  className="input"
                  value={form.sender_company}
                  onChange={(e) => set("sender_company", e.target.value)}
                />
              </Field>
              <Field label="Reply-to address (optional)" hint="Defaults to the connected Gmail address.">
                <input
                  className="input"
                  value={form.sender_email}
                  onChange={(e) => set("sender_email", e.target.value)}
                  placeholder="you@gmail.com"
                />
              </Field>
              <Field label="Unsubscribe address (optional)" hint="Adds a List-Unsubscribe header for compliance.">
                <input
                  className="input"
                  value={form.unsubscribe_email}
                  onChange={(e) => set("unsubscribe_email", e.target.value)}
                />
              </Field>
              <Field
                label="Gemini model"
                hint="Use Gemini 3.1 Flash Lite if you hit 429 free-tier quota limits on Gemini 4 Hydrogen."
              >
                <select
                  className="select"
                  value={resolveModel(form.model)}
                  onChange={(e) => set("model", e.target.value)}
                >
                  {SUPPORTED_GEMINI_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                  {!SUPPORTED_GEMINI_MODELS.some((m) => m.id === resolveModel(form.model)) && (
                    <option value={resolveModel(form.model)}>{resolveModel(form.model)}</option>
                  )}
                </select>
              </Field>
            </div>
            <Field label="Physical address (optional)" hint="Some jurisdictions require a postal address in cold email.">
              <input
                className="input"
                value={form.physical_address}
                onChange={(e) => set("physical_address", e.target.value)}
              />
            </Field>
          </Card>
        )}

        {form && (
          <Card
            title="Sending controls"
            sub="Conservatively enforced to stay inside Gmail limits and anti-spam expectations."
          >
            <div className="grid grid-3">
              <Field label="Daily send limit" hint="25/day is a safe ceiling for a regular Gmail account.">
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={200}
                  value={form.daily_limit}
                  onChange={(e) => set("daily_limit", Number(e.target.value))}
                />
              </Field>
              <Field label="Campaign send limit">
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={500}
                  value={form.campaign_limit}
                  onChange={(e) => set("campaign_limit", Number(e.target.value))}
                />
              </Field>
              <Field label="Seconds between emails">
                <input
                  className="input"
                  type="number"
                  min={30}
                  max={900}
                  value={form.interval_seconds}
                  onChange={(e) => set("interval_seconds", Number(e.target.value))}
                />
              </Field>
              <Field label="Sending starts (hour)">
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={23}
                  value={form.send_window_start}
                  onChange={(e) => set("send_window_start", Number(e.target.value))}
                />
              </Field>
              <Field label="Sending ends (hour)">
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={24}
                  value={form.send_window_end}
                  onChange={(e) => set("send_window_end", Number(e.target.value))}
                />
              </Field>
              <Field label="Sending days" hint="1 = Monday … 7 = Sunday">
                <input
                  className="input"
                  value={form.send_days}
                  onChange={(e) => set("send_days", e.target.value)}
                />
              </Field>
              <Field label="Timezone offset (minutes from UTC)" hint="60 = UTC+1 (WAT).">
                <input
                  className="input"
                  type="number"
                  min={-720}
                  max={840}
                  value={form.timezone_offset}
                  onChange={(e) => set("timezone_offset", Number(e.target.value))}
                />
              </Field>
              <Field label="Default follow-up gap (days)">
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={30}
                  value={form.followup_days}
                  onChange={(e) => set("followup_days", Number(e.target.value))}
                />
              </Field>
              <Field label="Default minimum score">
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={100}
                  value={form.min_score}
                  onChange={(e) => set("min_score", Number(e.target.value))}
                />
              </Field>
            </div>
            <div className="row">
              <button
                className="btn btn-primary"
                onClick={() => void save()}
                disabled={busy}
                type="button"
              >
                {busy ? "Saving…" : "Save settings"}
              </button>
              <span className="tiny">Sending outside configured hours is refused automatically.</span>
            </div>
          </Card>
        )}

        <Card title="Suppression list" sub="Contacts who must never be emailed again, including automatic unsubscribes.">
          <div className="row" style={{ marginBottom: 12 }}>
            <input
              className="input"
              style={{ maxWidth: 280 }}
              placeholder="email@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <input
              className="input"
              style={{ maxWidth: 280 }}
              placeholder="Reason (optional)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <button className="btn" onClick={() => void block()} type="button">
              Suppress address
            </button>
          </div>
          {suppressions.length === 0 ? (
            <Empty title="No suppressed addresses">
              Unsubscribes are added here automatically when replies are synced.
            </Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Reason</th>
                    <th>Added</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {suppressions.map((entry) => (
                    <tr key={entry.email}>
                      <td className="strong">{entry.email}</td>
                      <td className="tiny">{entry.reason}</td>
                      <td className="tiny nowrap">{fmtDate(entry.created_at)}</td>
                      <td>
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => void unblock(entry.email)}
                          type="button"
                        >
                          Allow again
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Data" sub="Your data lives privately in Firebase Cloud Firestore under your verified Google account.">
          <ul className="tiny" style={{ paddingLeft: 16 }}>
            <li>Delete a prospect and its emails from the Leads page; the deletion is recorded in the audit log.</li>
            <li>Google Workspace access tokens stay strictly in memory and clear automatically when you sign out.</li>
            <li>Campaign history and audit entries remain available for your own records.</li>
          </ul>
        </Card>
      </div>
    </main>
  );
}
