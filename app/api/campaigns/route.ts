import { requireUser } from "@/lib/auth";
import { route, ok, readJson, HttpError, str, num } from "@/lib/http";
import { q, first, run, now, audit } from "@/lib/db";
import { randomId } from "@/lib/crypto";
import { assignLeadsToCampaign, parseConfig, importRows } from "@/lib/leads";
import { getSpreadsheet, getSheetValues, parseSheetUrl } from "@/lib/google";
import { defaultCampaignConfig, getSettings } from "@/lib/settings";
import type { Campaign, CampaignConfig } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  return route(async () => {
    const user = await requireUser();
    const campaigns = await q<
      Campaign & {
        leads: number;
        researched: number;
        qualified: number;
        sent: number;
        pending: number;
        replies: number;
        positive: number;
      }
    >(
      `SELECT c.*,
        (SELECT COUNT(*) FROM leads l WHERE l.owner_sub = c.owner_sub AND l.campaign_id = c.id) AS leads,
        (SELECT COUNT(*) FROM leads l WHERE l.owner_sub = c.owner_sub AND l.campaign_id = c.id
          AND l.status IN ('researched','qualified','email_generated','approved','sent','replied','followup_pending')) AS researched,
        (SELECT COUNT(*) FROM leads l WHERE l.owner_sub = c.owner_sub AND l.campaign_id = c.id
          AND l.status IN ('qualified','email_generated','approved','sent','replied','followup_pending')) AS qualified,
        (SELECT COUNT(*) FROM messages m WHERE m.owner_sub = c.owner_sub AND m.campaign_id = c.id AND m.status = 'sent') AS sent,
        (SELECT COUNT(*) FROM messages m WHERE m.owner_sub = c.owner_sub AND m.campaign_id = c.id
          AND m.status IN ('pending_approval','approved')) AS pending,
        (SELECT COUNT(*) FROM replies r WHERE r.owner_sub = c.owner_sub
          AND r.lead_id IN (SELECT l.id FROM leads l WHERE l.owner_sub = c.owner_sub AND l.campaign_id = c.id)) AS replies,
        (SELECT COUNT(*) FROM replies r WHERE r.owner_sub = c.owner_sub
          AND r.classification IN ('interested','more_info','pricing')
          AND r.lead_id IN (SELECT l.id FROM leads l WHERE l.owner_sub = c.owner_sub AND l.campaign_id = c.id)) AS positive
       FROM campaigns c WHERE c.owner_sub = ? ORDER BY c.created_at DESC`,
      user.sub,
    );
    return ok({ campaigns: campaigns.map((c) => ({ ...c, config: parseConfig(c) })) });
  });
}

export async function POST(request: Request) {
  return route(async () => {
    const user = await requireUser(request);
    const settings = await getSettings(user.sub);
    const body = await readJson<{
      name?: string;
      instruction?: string;
      config?: Partial<CampaignConfig>;
      sheetUrl?: string;
      sheetTab?: string;
      importLimit?: number;
    }>(request);

    const config: CampaignConfig = { ...defaultCampaignConfig(settings), ...(body.config ?? {}) };
    config.lead_count = Math.max(1, Math.min(num(config.lead_count, 10), 200));
    config.min_score = Math.max(0, Math.min(num(config.min_score, settings.min_score), 100));

    const id = randomId("camp");
    let sheetSource: string | null = null;
    let imported = 0;

    await run(
      `INSERT INTO campaigns (owner_sub, id, name, instruction, config, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      user.sub,
      id,
      str(body.name) || `Campaign ${new Date().toLocaleDateString()}`,
      str(body.instruction) || null,
      JSON.stringify(config),
      "draft",
      now(),
      now(),
    );

    try {
      if (str(body.sheetUrl)) {
        const { spreadsheetId } = parseSheetUrl(str(body.sheetUrl));
        let tab = str(body.sheetTab);
        if (!tab) {
          const meta = await getSpreadsheet(user.sub, spreadsheetId);
          tab = meta.tabs[0]?.title ?? "";
        }
        if (!tab) throw new HttpError(400, "That spreadsheet has no worksheets.");
        const values = await getSheetValues(user.sub, spreadsheetId, tab, "A1:Z2000");
        const result = await importRows(user.sub, {
          spreadsheetId,
          tab,
          rows: values,
          limit: Math.max(config.lead_count, num(body.importLimit, config.lead_count)),
          campaignId: id,
        });
        imported = result.created + result.duplicates;
        sheetSource = `${spreadsheetId}|${tab}`;
        await run(
          `UPDATE leads SET status = 'queued_research', updated_at = ? WHERE owner_sub = ? AND campaign_id = ? AND status = 'new'`,
          now(),
          user.sub,
          id,
        );
        await run(`UPDATE campaigns SET sheet_source = ? WHERE owner_sub = ? AND id = ?`, sheetSource, user.sub, id);
      } else {
        await assignLeadsToCampaign(user.sub, id, config);
      }
    } catch (err) {
      if (str(body.sheetUrl)) {
        await run(
          `DELETE FROM lead_events WHERE owner_sub = ? AND lead_id IN
            (SELECT id FROM leads WHERE owner_sub = ? AND campaign_id = ? AND source = 'google_sheets')`,
          user.sub,
          user.sub,
          id,
        );
        await run(
          `DELETE FROM leads WHERE owner_sub = ? AND campaign_id = ? AND source = 'google_sheets'`,
          user.sub,
          id,
        );
      } else {
        await run(
          `UPDATE leads SET campaign_id = NULL, status = 'new' WHERE owner_sub = ? AND campaign_id = ?`,
          user.sub,
          id,
        );
      }
      await run(`DELETE FROM campaigns WHERE owner_sub = ? AND id = ?`, user.sub, id);
      throw err;
    }

    await audit(user.sub, "campaign_created", "campaign", id, { imported });
    const campaign = await first<Campaign>(`SELECT * FROM campaigns WHERE owner_sub = ? AND id = ?`, user.sub, id);
    return ok({ campaign, config: parseConfig(campaign!), imported });
  });
}

export async function PATCH(request: Request) {
  return route(async () => {
    const user = await requireUser(request);
    const body = await readJson<{ id?: string; action?: string; config?: Partial<CampaignConfig>; name?: string }>(
      request,
    );
    const id = str(body.id);
    if (!id) throw new HttpError(400, "Missing campaign id.");
    const campaign = await first<Campaign>(`SELECT * FROM campaigns WHERE owner_sub = ? AND id = ?`, user.sub, id);
    if (!campaign) throw new HttpError(404, "Campaign not found.");
    const action = str(body.action);

    switch (action) {
      case "approve":
        await run(
          `UPDATE campaigns SET status = 'approved', approved_at = ?, updated_at = ? WHERE owner_sub = ? AND id = ?`,
          now(),
          now(),
          user.sub,
          id,
        );
        break;
      case "pause":
        await run(`UPDATE campaigns SET status = 'paused', updated_at = ? WHERE owner_sub = ? AND id = ?`, now(), user.sub, id);
        break;
      case "resume":
        await run(
          `UPDATE campaigns SET status = 'approved', updated_at = ? WHERE owner_sub = ? AND id = ?`,
          now(),
          user.sub,
          id,
        );
        break;
      case "complete":
        await run(
          `UPDATE campaigns SET status = 'completed', updated_at = ? WHERE owner_sub = ? AND id = ?`,
          now(),
          user.sub,
          id,
        );
        break;
      case "archive":
        await run(
          `UPDATE campaigns SET status = 'archived', updated_at = ? WHERE owner_sub = ? AND id = ?`,
          now(),
          user.sub,
          id,
        );
        break;
      case "assign": {
        const config = parseConfig(campaign);
        const added = await assignLeadsToCampaign(user.sub, id, config);
        await run(`UPDATE campaigns SET updated_at = ? WHERE owner_sub = ? AND id = ?`, now(), user.sub, id);
        return ok({ ok: true, added });
      }
      case "update_config": {
        const merged = { ...parseConfig(campaign), ...(body.config ?? {}) } as CampaignConfig;
        await run(
          `UPDATE campaigns SET config = ?, name = ?, updated_at = ? WHERE owner_sub = ? AND id = ?`,
          JSON.stringify(merged),
          str(body.name) || campaign.name,
          now(),
          user.sub,
          id,
        );
        break;
      }
      default:
        throw new HttpError(400, "Unknown campaign action.");
    }
    await audit(user.sub, `campaign_${action || "updated"}`, "campaign", id);
    return ok({ ok: true });
  });
}
