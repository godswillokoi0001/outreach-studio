import { q, first, run, now, ensureSchema, logEvent } from "./db";
import { randomId } from "./crypto";
import { mapHeaders, normalizeEmail, normalizeWebsite, extractEmailsFromRow, type LeadField } from "./columns";
import { LEAD_STATUS_LABELS, type CampaignConfig, type Campaign, type Lead } from "./types";
import { knowledgeDigest } from "./knowledge";

export function parseConfig(campaign: Campaign): CampaignConfig {
  try {
    return JSON.parse(campaign.config) as CampaignConfig;
  } catch {
    return {
      services: [],
      target_industry: "any",
      objective: "Start a conversation",
      tone: "professional",
      min_score: 55,
      lead_count: 10,
      send_limit: 25,
      interval_seconds: 45,
      followup_days: [4, 9],
      auto_approve_initial: false,
      auto_approve_followups: false,
      require_approval: true,
      identity: "company",
      extra_instructions: "",
    };
  }
}

export interface ImportResult {
  created: number;
  duplicates: number;
  skipped: number;
  leads: { id: string; business: string; email: string }[];
}

export async function importRows(
  ownerSub: string,
  input: {
    spreadsheetId: string;
    tab: string;
    rows: string[][];
    mapping?: Partial<Record<LeadField, number>>;
    limit?: number;
    campaignId?: string | null;
  },
): Promise<ImportResult> {
  await ensureSchema();
  const [header = [], ...body] = input.rows;
  const mapping =
    input.mapping && Object.keys(input.mapping).length
      ? (input.mapping as Record<LeadField, number>)
      : mapHeaders(header);
  const limit = input.limit && input.limit > 0 ? input.limit : body.length;
  const result: ImportResult = { created: 0, duplicates: 0, skipped: 0, leads: [] };
  const sourceRef = `${input.spreadsheetId}|${input.tab}`;

  for (const [index, row] of body.entries()) {
    if (result.created >= limit) break;
    if (!row || row.every((cell) => !String(cell ?? "").trim())) continue;
    const get = (field: LeadField): string => {
      const col = mapping[field];
      return col === undefined || col < 0 ? "" : String(row[col] ?? "").trim();
    };
    const business = get("business") || get("contact_name");
    const email = normalizeEmail(get("email")) ?? extractEmailsFromRow(row);
    if (!business && !email) {
      result.skipped += 1;
      continue;
    }
    if (email) {
      const existing = await first<{ id: string }>(
        `SELECT id FROM leads WHERE owner_sub = ? AND email_norm = ?`,
        ownerSub,
        email,
      );
      if (existing) {
        result.duplicates += 1;
        if (input.campaignId) {
          await run(
            `UPDATE leads SET campaign_id = COALESCE(campaign_id, ?) WHERE owner_sub = ? AND id = ?`,
            input.campaignId,
            ownerSub,
            existing.id,
          );
        }
        continue;
      }
    }
    const extraPairs = header
      .map((h, i) =>
        mapping && Object.values(mapping).includes(i)
          ? null
          : `${String(h || `col${i + 1}`).trim()}: ${String(row[i] ?? "").trim()}`,
      )
      .filter((v): v is string => Boolean(v) && !v!.endsWith(":"));

    const id = randomId("lead");
    await run(
      `INSERT INTO leads (owner_sub, id, campaign_id, business, contact_name, role, email, email_norm, website, phone,
        location, industry, notes, extra, source, source_ref, sheet_row, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ownerSub,
      id,
      input.campaignId ?? null,
      business || null,
      get("contact_name") || null,
      get("role") || null,
      email,
      email,
      normalizeWebsite(get("website")),
      get("phone") || null,
      get("location") || null,
      get("industry") || null,
      get("notes") || null,
      extraPairs.length ? extraPairs.join(" | ").slice(0, 2000) : null,
      "google_sheets",
      sourceRef,
      index + 2,
      "new",
      now(),
      now(),
    );
    result.created += 1;
    result.leads.push({ id, business: business || email || "", email: email ?? "" });
  }
  return result;
}

export async function createLead(
  ownerSub: string,
  input: {
    business?: string;
    contact_name?: string;
    role?: string;
    email?: string;
    website?: string;
    phone?: string;
    location?: string;
    industry?: string;
    notes?: string;
    source?: string;
    campaignId?: string | null;
  },
): Promise<{ id: string; duplicate: boolean }> {
  const email = normalizeEmail(input.email ?? "");
  if (email) {
    const existing = await first<{ id: string }>(
      `SELECT id FROM leads WHERE owner_sub = ? AND email_norm = ?`,
      ownerSub,
      email,
    );
    if (existing) return { id: existing.id, duplicate: true };
  }
  const id = randomId("lead");
  await run(
    `INSERT INTO leads (owner_sub, id, campaign_id, business, contact_name, role, email, email_norm, website, phone,
      location, industry, notes, source, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ownerSub,
    id,
    input.campaignId ?? null,
    input.business?.trim() || null,
    input.contact_name?.trim() || null,
    input.role?.trim() || null,
    email,
    email,
    normalizeWebsite(input.website ?? ""),
    input.phone?.trim() || null,
    input.location?.trim() || null,
    input.industry?.trim() || null,
    input.notes?.trim() || null,
    input.source ?? "manual",
    "new",
    now(),
    now(),
  );
  await logEvent(ownerSub, id, "lead_created", { source: input.source ?? "manual" });
  return { id, duplicate: false };
}

export async function assignLeadsToCampaign(
  ownerSub: string,
  campaignId: string,
  config: CampaignConfig,
): Promise<number> {
  const industry =
    config.target_industry && config.target_industry.toLowerCase() !== "any" ? config.target_industry : null;
  const rows = await q<{ id: string }>(
    `SELECT id FROM leads
     WHERE owner_sub = ? AND status = 'new' AND (campaign_id IS NULL OR campaign_id = '')
       ${industry ? "AND lower(COALESCE(industry, '')) LIKE ?" : ""}
     ORDER BY created_at ASC LIMIT ?`,
    ...(industry ? [ownerSub, `%${industry.toLowerCase()}%`, config.lead_count] : [ownerSub, config.lead_count]),
  );
  for (const row of rows) {
    await run(
      `UPDATE leads SET campaign_id = ?, status = 'queued_research', updated_at = ?
       WHERE owner_sub = ? AND id = ?`,
      campaignId,
      now(),
      ownerSub,
      row.id,
    );
  }
  return rows.length;
}

function columnLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * Writes current lead statuses back to the campaign's worksheet in a dedicated
 * "Status" column, adding the column when it is missing. Other cells are never
 * modified.
 */
export async function writebackStatuses(
  ownerSub: string,
  campaign: Campaign,
): Promise<{ updated: number; column: string; skipped: number }> {
  const { getSheetValues, updateSheetValues } = await import("./google");
  if (!campaign.sheet_source) return { updated: 0, column: "", skipped: 0 };
  const [spreadsheetId, tab] = campaign.sheet_source.split("|");
  if (!spreadsheetId || !tab) return { updated: 0, column: "", skipped: 0 };

  const leads = await q<{ id: string; sheet_row: number | null; status: string }>(
    `SELECT id, sheet_row, status FROM leads WHERE owner_sub = ? AND campaign_id = ? AND sheet_row IS NOT NULL
     ORDER BY sheet_row ASC`,
    ownerSub,
    campaign.id,
  );
  if (!leads.length) return { updated: 0, column: "", skipped: 0 };

  const sheet = await getSheetValues(ownerSub, spreadsheetId, tab, "A1:AZ2000");
  const header = sheet[0] ?? [];
  let statusCol = header.findIndex((h) => /^(status|outreach status|campaign status)$/i.test(String(h).trim()));
  const isNew = statusCol === -1;
  if (isNew) {
    let lastUsed = header.length;
    for (const row of sheet.slice(0, 50)) {
      for (let i = row.length - 1; i >= 0; i--) {
        if (String(row[i] ?? "").trim() !== "") {
          if (i + 1 > lastUsed) lastUsed = i + 1;
          break;
        }
      }
    }
    statusCol = lastUsed;
  }

  const maxRow = Math.max(...leads.map((l) => l.sheet_row ?? 1));
  const byRow = new Map(leads.map((l) => [l.sheet_row, LEAD_STATUS_LABELS[l.status] ?? l.status]));
  const values: string[][] = [];
  for (let row = 1; row <= maxRow; row++) {
    if (row === 1) {
      values.push([isNew ? "Status" : String(header[statusCol] ?? "Status")]);
    } else {
      values.push([byRow.get(row) ?? ""]);
    }
  }
  const letter = columnLetter(statusCol);
  await updateSheetValues(ownerSub, spreadsheetId, tab, `${letter}1:${letter}${maxRow}`, values);
  return { updated: leads.length, column: letter, skipped: 0 };
}

export interface FollowupCandidate {
  lead: Lead;
  campaign: Campaign;
  config: CampaignConfig;
  step: number;
  daysSince: number;
}

export async function findFollowupCandidates(ownerSub: string, limit = 50): Promise<FollowupCandidate[]> {
  const rows = await q<Lead>(
    `SELECT * FROM leads WHERE owner_sub = ? AND status IN ('sent','followup_pending')
       AND last_contacted_at IS NOT NULL ORDER BY last_contacted_at ASC LIMIT ?`,
    ownerSub,
    limit * 4,
  );
  const out: FollowupCandidate[] = [];
  for (const lead of rows) {
    if (!lead.campaign_id) continue;
    const reply = await first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM replies WHERE owner_sub = ? AND lead_id = ?`,
      ownerSub,
      lead.id,
    );
    if ((reply?.c ?? 0) > 0) continue;
    const campaign = await first<Campaign>(
      `SELECT * FROM campaigns WHERE owner_sub = ? AND id = ?`,
      ownerSub,
      lead.campaign_id,
    );
    if (!campaign || campaign.status === "paused" || campaign.status === "archived") continue;
    const config = parseConfig(campaign);
    const sent = await first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM messages WHERE owner_sub = ? AND lead_id = ? AND status = 'sent'`,
      ownerSub,
      lead.id,
    );
    const step = sent?.c ?? 0;
    const gaps = config.followup_days?.length ? config.followup_days : [4, 9];
    if (step > gaps.length) continue;
    const pending = await first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM messages WHERE owner_sub = ? AND lead_id = ? AND status IN ('pending_approval','approved','sending')`,
      ownerSub,
      lead.id,
    );
    if ((pending?.c ?? 0) > 0) continue;
    const lastSent = await first<{ sent_at: string }>(
      `SELECT sent_at FROM messages WHERE owner_sub = ? AND lead_id = ? AND status = 'sent'
       ORDER BY sent_at DESC LIMIT 1`,
      ownerSub,
      lead.id,
    );
    if (!lastSent?.sent_at) continue;
    const days = (Date.now() - new Date(lastSent.sent_at).getTime()) / 86_400_000;
    const gap = gaps[step - 1] ?? gaps[gaps.length - 1];
    if (days >= gap) {
      out.push({ lead, campaign, config, step: step + 1, daysSince: Math.floor(days) });
      if (out.length >= limit) break;
    }
  }
  return out;
}

export async function knowledgeForCampaign(ownerSub: string): Promise<string> {
  return knowledgeDigest(ownerSub);
}
