import { q, run, now, ensureSchema } from "./db";
import { DEFAULT_SETTINGS, type Settings } from "./types";

const NUMERIC_KEYS: string[] = [
  "daily_limit",
  "campaign_limit",
  "interval_seconds",
  "send_window_start",
  "send_window_end",
  "timezone_offset",
  "followup_days",
  "min_score",
];

export async function getSettings(ownerSub: string): Promise<Settings> {
  await ensureSchema();
  const rows = await q<{ k: string; v: string }>(
    `SELECT k, v FROM user_settings WHERE owner_sub = ?`,
    ownerSub,
  );
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    if (NUMERIC_KEYS.includes(row.k)) {
      const n = Number(row.v);
      if (Number.isFinite(n)) merged[row.k] = n;
    } else {
      merged[row.k] = row.v;
    }
  }
  return merged as unknown as Settings;
}

export async function saveSettings(ownerSub: string, patch: Partial<Settings>): Promise<Settings> {
  await ensureSchema();
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_SETTINGS) || value === undefined || value === null) continue;
    await run(
      `INSERT INTO user_settings (owner_sub, k, v, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(owner_sub, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
      ownerSub,
      key,
      String(value),
      now(),
    );
  }
  return getSettings(ownerSub);
}

export function defaultCampaignConfig(settings: Settings) {
  return {
    services: ["Website redesign"],
    target_industry: "any",
    objective: "Start a conversation about improving their digital presence",
    tone: "conversational and professional",
    min_score: settings.min_score,
    lead_count: 10,
    send_limit: settings.campaign_limit,
    interval_seconds: settings.interval_seconds,
    followup_days: [4, 9],
    auto_approve_initial: false,
    auto_approve_followups: false,
    require_approval: true,
    identity: "company" as const,
    extra_instructions: "",
  };
}

/** True when the account has not set up its own identity yet. */
export function needsOnboarding(settings: Settings): boolean {
  return !settings.sender_name.trim() && !settings.sender_company.trim() && !settings.sender_email.trim();
}
