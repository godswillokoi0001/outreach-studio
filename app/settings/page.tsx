"use client";

import { BrandLoader } from "@/components/BrandLoader";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BookOpen, Camera, KeyRound, RotateCcw, Trash2 } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { PasswordStrengthInput } from "@/components/PasswordStrengthInput";
import { UserAvatar } from "@/components/UserAvatar";
import { Banner, Card, Empty, Field, Stat, Toggle } from "@/components/ui";
import { useConfirm, useToast } from "@/components/Feedback";
import { authedPost, errorMessage } from "@/lib/client";
import { evaluatePasswordStrength } from "@/lib/password-policy";
import {
  addSuppression,
  deleteAllUserProfileAndKnowledgeData,
  getSettings,
  listSuppressions,
  removeSuppression,
  saveSettings,
} from "@/lib/store";
import { fmtDate } from "@/lib/format";
import { DEFAULT_SETTINGS, type Settings, type Suppression } from "@/lib/types";
import { AiProviderSettingsCard } from "@/components/AiProviderSettingsCard";
import { ClearActivityModal } from "@/components/ClearActivityModal";
import {
  OPERATOR_MEMORY_CHANGED,
  clearOperatorMemory,
  loadOperatorMemory,
} from "@/lib/operator-memory";

const DEVELOPER_MODE_KEY = "os:developer-mode";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function subscribeDeveloperMode(onChange: () => void) {
  window.addEventListener(DEVELOPER_MODE_KEY, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(DEVELOPER_MODE_KEY, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readDeveloperMode(): boolean {
  try {
    return window.localStorage.getItem(DEVELOPER_MODE_KEY) === "true";
  } catch {
    return false;
  }
}

export default function SettingsPage() {
  const { user, patchUserLocal } = useAuth();
  const confirmDialog = useConfirm();
  const toast = useToast();
  const avatarFileRef = useRef<HTMLInputElement | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const developerMode = useSyncExternalStore(subscribeDeveloperMode, readDeveloperMode, () => false);
  const [form, setForm] = useState<Settings>(DEFAULT_SETTINGS);
  const [suppressions, setSuppressions] = useState<Suppression[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [memoryStats, setMemoryStats] = useState<{ count: number; bytes: number; lastAt: number } | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [clearingMemory, setClearingMemory] = useState(false);
  const [clearActivityOpen, setClearActivityOpen] = useState(false);

  const changeDeveloperMode = (on: boolean) => {
    try {
      window.localStorage.setItem(DEVELOPER_MODE_KEY, on ? "true" : "false");
      window.dispatchEvent(new Event(DEVELOPER_MODE_KEY));
    } catch {
      /* storage unavailable */
    }
    toast.info(
      on ? "Developer mode enabled" : "Developer mode disabled",
      on ? "The Developer option now appears in the operator's mode switch." : "The operator keeps Chat and Agent only.",
    );
  };

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const settings = await getSettings(user.uid);
        if (active) setForm(settings);
      } catch (err) {
        if (active) setFailure(errorMessage(err));
      }
      if (active) setLoading(false);

      // The suppression list is optional: a database hiccup must not hide the
      // settings that did load.
      try {
        const sup = await listSuppressions(user.uid);
        if (active) setSuppressions(sup);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      active = false;
    };
  }, [user.uid]);

  // Memory numbers come from the real rows, so the count and size are what the
  // operator actually remembers — not a guess. The panel updates after any save
  // or clear, lightly debounced so a streaming reply is not a read per token.
  useEffect(() => {
    let active = true;
    let timer: number | null = null;
    const refresh = async () => {
      try {
        const records = await loadOperatorMemory(user.uid);
        if (!active) return;
        const bytes = records.reduce(
          (total, record) => total + new TextEncoder().encode(JSON.stringify(record)).length,
          0,
        );
        setMemoryStats({
          count: records.length,
          bytes,
          lastAt: records.reduce((latest, record) => Math.max(latest, record.updatedAt), 0),
        });
        setMemoryError(null);
      } catch (err) {
        if (active) setMemoryError(errorMessage(err));
      }
    };
    void refresh();
    const onChange = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), 1200);
    };
    window.addEventListener(OPERATOR_MEMORY_CHANGED, onChange);
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
      window.removeEventListener(OPERATOR_MEMORY_CHANGED, onChange);
    };
  }, [user.uid]);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const saved = await saveSettings(user.uid, form);
      setForm(saved);
      toast.success("Settings saved", "Your sending rules are in effect.");
    } catch (err) {
      const message = errorMessage(err);
      setFailure(message);
      toast.error("Settings were not saved", message);
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
      toast.success("Address suppressed", "It will never be contacted.");
    } catch (err) {
      const message = errorMessage(err);
      setFailure(message);
      toast.error("Could not suppress that address", message);
    }
  };

  const unblock = async (value: string) => {
    const ok = await confirmDialog({
      title: `Allow contact with ${value} again?`,
      message: "The address is removed from the suppression list and can be emailed again.",
      confirmLabel: "Allow contact",
      tone: "info",
    });
    if (!ok) return;
    setFailure(null);
    try {
      await removeSuppression(user.uid, value);
      setSuppressions(await listSuppressions(user.uid));
      toast.success("Contact allowed again", value);
    } catch (err) {
      const message = errorMessage(err);
      setFailure(message);
      toast.error("Could not update the suppression list", message);
    }
  };

  const clearMemory = async () => {
    const ok = await confirmDialog({
      title: "Clear the operator's memory?",
      message:
        "Every saved conversation, message and action log is deleted from your account. The operator will not remember any of it. This cannot be undone.",
      confirmLabel: "Clear memory",
      tone: "bad",
    });
    if (!ok) return;
    setClearingMemory(true);
    setMemoryError(null);
    try {
      await clearOperatorMemory(user.uid);
      setMemoryStats({ count: 0, bytes: 0, lastAt: 0 });
      toast.success("Operator memory cleared", "The operator no longer remembers earlier conversations.");
    } catch (err) {
      const message = errorMessage(err);
      setMemoryError(message);
      toast.error("Could not clear operator memory", message);
    } finally {
      setClearingMemory(false);
    }
  };

  const handleAvatarUpload = async (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Invalid image", "Please choose a PNG, JPG, or WebP file.");
      return;
    }
    if (file.size > 500_000) {
      toast.error("Image too large", "Please choose an image under 500 KB.");
      return;
    }
    setAvatarBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(new Error("Could not read file."));
        reader.readAsDataURL(file);
      });
      const res = await authedPost<{ photoURL: string | null; avatarSource: "google" | "custom" }>(
        "/api/account/avatar",
        { action: "upload", dataUrl },
      );
      patchUserLocal({ photoURL: res.photoURL, avatarSource: res.avatarSource });
      toast.success("Profile picture updated");
    } catch (err) {
      toast.error("Upload failed", errorMessage(err));
    } finally {
      setAvatarBusy(false);
    }
  };

  const handleResetAvatarToGoogle = async () => {
    setAvatarBusy(true);
    try {
      const res = await authedPost<{ photoURL: string | null; avatarSource: "google" | "custom" }>(
        "/api/account/avatar",
        { action: "reset_google" },
      );
      patchUserLocal({ photoURL: res.photoURL, avatarSource: res.avatarSource });
      toast.success("Restored Google profile picture");
    } catch (err) {
      toast.error("Reset failed", errorMessage(err));
    } finally {
      setAvatarBusy(false);
    }
  };

  const handleSavePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    const assessment = evaluatePasswordStrength(newPassword);
    if (!assessment.valid) {
      setPasswordError(assessment.error || "Password requirements not met.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("Passwords do not match.");
      return;
    }
    setPasswordBusy(true);
    setPasswordError(null);
    try {
      await authedPost("/api/account/password", {
        action: user.hasPassword ? "change" : "create_initial",
        currentPassword: user.hasPassword ? currentPassword : undefined,
        newPassword,
        confirmPassword,
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      patchUserLocal({ hasPassword: true });
      toast.success("Password updated", "You can sign in anytime with email and password or Google.");
    } catch (err) {
      setPasswordError(errorMessage(err));
    } finally {
      setPasswordBusy(false);
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
        {loading && <BrandLoader />}

        <div className="grid grid-2" style={{ gap: 14 }}>
          <Card title="Profile picture" sub="Shown in header, sidebar, onboarding and chat.">
            <div className="row" style={{ gap: 14, alignItems: "center", flexWrap: "wrap" }}>
              <UserAvatar
                photoURL={user.photoURL}
                name={user.displayName}
                email={user.email}
                size={60}
              />
              <div className="stack" style={{ gap: 6, flex: 1 }}>
                <div className="strong">{user.displayName || user.email}</div>
                <div className="tiny muted">
                  Source: {user.avatarSource === "custom" ? "Custom upload" : "Google account"}
                </div>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <input
                    ref={avatarFileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const f = e.target.files?.[0] ?? null;
                      void handleAvatarUpload(f);
                      e.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={avatarBusy}
                    onClick={() => avatarFileRef.current?.click()}
                  >
                    <Camera size={13} />
                    {avatarBusy ? "Saving…" : "Upload picture"}
                  </button>
                  {user.googlePhotoURL && user.avatarSource === "custom" && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      disabled={avatarBusy}
                      onClick={() => void handleResetAvatarToGoogle()}
                    >
                      <RotateCcw size={13} />
                      Use Google picture
                    </button>
                  )}
                </div>
              </div>
            </div>
          </Card>

          <Card
            title={user.hasPassword ? "Change password" : "Set password"}
            sub="Sign in with email & password in addition to Google Sign-In."
          >
            <form onSubmit={(e) => void handleSavePassword(e)} className="stack" style={{ gap: 10 }}>
              {passwordError && <Banner tone="bad">{passwordError}</Banner>}
              {user.hasPassword && (
                <Field label="Current password">
                  <input
                    className="input"
                    type="password"
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Enter current password"
                  />
                </Field>
              )}
              <PasswordStrengthInput
                password={newPassword}
                confirmPassword={confirmPassword}
                onPasswordChange={setNewPassword}
                onConfirmPasswordChange={setConfirmPassword}
                passwordLabel={user.hasPassword ? "New password" : "Create password"}
              />
              <div>
                <button type="submit" className="btn btn-primary btn-sm" disabled={passwordBusy}>
                  <KeyRound size={13} />
                  {passwordBusy ? "Updating…" : user.hasPassword ? "Change password" : "Set password"}
                </button>
              </div>
            </form>
          </Card>
        </div>

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
          </div>
          <Field label="Physical address (optional)" hint="Some jurisdictions require a postal address in cold email.">
            <input
              className="input"
              value={form.physical_address}
              onChange={(e) => set("physical_address", e.target.value)}
            />
          </Field>
        </Card>

        <div id="ai-engine">
          {!loading && (
            <AiProviderSettingsCard />
          )}
        </div>

        <Card
          title="Operator"
          sub="How the assistant behaves in your workspace."
        >
          <Toggle
            checked={developerMode}
            onChange={changeDeveloperMode}
            label="Developer mode"
            hint="Adds a Developer option to the operator's mode switch for diagnosing problems and proposing fixes. Leave it off for day-to-day outreach."
          />
        </Card>

        <Card
          title="Operator memory"
          sub="Every conversation, message and action the operator remembers. It is saved in your account, so it follows you to any computer."
          actions={
            <button
              className="btn btn-sm btn-danger"
              type="button"
              onClick={() => void clearMemory()}
              disabled={clearingMemory || !memoryStats || memoryStats.count === 0}
            >
              <Trash2 size={12} aria-hidden="true" />
              <span>{clearingMemory ? "Clearing…" : "Clear all memory"}</span>
            </button>
          }
        >
          <div className="grid grid-3">
            <Stat label="Conversations remembered" value={memoryStats ? memoryStats.count : "—"} />
            <Stat label="Space used" value={memoryStats ? formatBytes(memoryStats.bytes) : "—"} />
            <Stat
              label="Last remembered"
              value={
                memoryStats?.lastAt ? new Date(memoryStats.lastAt).toLocaleDateString() : "—"
              }
            />
          </div>
          {memoryError ? (
            <p className="tiny" style={{ marginTop: 10 }}>
              Memory could not be read: {memoryError}
            </p>
          ) : (
            <p className="tiny" style={{ marginTop: 10 }}>
              {memoryStats && memoryStats.count > 0
                ? "The operator uses this memory to pick up earlier work. Clearing it deletes every saved conversation and action log from your account — this cannot be undone."
                : "No conversations are remembered yet. As you work with the operator, its conversations and actions are saved here."}
            </p>
          )}
        </Card>

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
          <div style={{ margin: "12px 0" }}>
            <Toggle
              checked={Boolean(form.include_opt_out_footer)}
              onChange={(checked) => set("include_opt_out_footer", checked)}
              label="Include opt-out line in email footer"
              hint="Off by default so cold emails stay personal and concise. Enable if you want every draft to include a plain-text opt-out line."
            />
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

        <Card title="Suppression list" sub="Contacts who must never be emailed again, including automatic opt-outs.">
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
              Addresses are added here automatically when replies are synced and a prospect asks you to stop.
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

        <Card
          title="Knowledge Base & Onboarding Profile"
          sub="Your structured business Knowledge Base powers Growth Advisor, Analyse, Prospect Research, and Outreach."
        >
          <p className="tiny" style={{ margin: "0 0 12px", lineHeight: 1.55 }}>
            Your answers and Knowledge Base sections are stored privately under your Google account in Supabase. You can
            edit individual sections anytime, re-run the onboarding questionnaire, or permanently delete all profile and
            Knowledge Base data on request.
          </p>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <Link href="/knowledge" className="btn btn-primary btn-sm">
              <BookOpen size={13} />
              Open Knowledge Base
            </Link>
            <Link href="/onboarding" className="btn btn-sm">
              <RotateCcw size={13} />
              Re-run onboarding questions
            </Link>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={async () => {
                const ok = await confirmDialog({
                  title: "Delete all profile & Knowledge Base data?",
                  message:
                    "This permanently deletes your saved onboarding answers, structured Knowledge Base sections, version history, custom notes, uploaded documents, and Growth Advisor profile.",
                  confirmLabel: "Delete all data",
                  tone: "bad",
                });
                if (!ok) return;
                try {
                  await deleteAllUserProfileAndKnowledgeData(user.uid);
                  toast.success("Profile & Knowledge Base deleted", "Your workspace knowledge has been wiped.");
                } catch (err) {
                  toast.error("Could not delete data", errorMessage(err));
                }
              }}
            >
              <Trash2 size={13} />
              Delete profile &amp; Knowledge Base
            </button>
          </div>
        </Card>

        <Card
          title="Data"
          sub="Settings and your AI key live in your database (Supabase) behind your Google sign-in. Pipeline records live in Supabase under the same account."
        >
          <ul className="tiny" style={{ paddingLeft: 16 }}>
            <li>Delete a prospect and its emails from the Leads page; the deletion is recorded in the audit log.</li>
            <li>Delete rejected and failed emails from Email review, clear the open history from Sent emails, and delete reply records from Conversations.</li>
            <li>Google Workspace access tokens stay strictly in memory and clear automatically when you sign out.</li>
            <li>Campaign history and audit entries remain available for your own records.</li>
          </ul>
        </Card>

        <Card
          title="Recent activity log"
          sub="Audit trail entries recorded across your workspace. Clearing logs does not delete leads, campaigns, or analysis results."
          actions={
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => setClearActivityOpen(true)}
              type="button"
            >
              <Trash2 size={13} aria-hidden="true" />
              Clear activity
            </button>
          }
        >
          <p className="tiny" style={{ margin: 0, lineHeight: 1.5 }}>
            Audit records track pipeline activity, automated runs, imports, and message sends. You can clear all activity or remove logs older than 7 or 30 days at any time. Your prospects, campaigns, messages, and analysis results will never be touched.
          </p>
        </Card>

        <ClearActivityModal
          open={clearActivityOpen}
          onClose={() => setClearActivityOpen(false)}
          uid={user.uid}
          onCleared={() => {}}
        />
      </div>
    </main>
  );
}
