import { requireUser } from "@/lib/auth";
import { route, ok, readJson, HttpError, num, str } from "@/lib/http";
import { getSpreadsheet, getSheetValues, parseSheetUrl } from "@/lib/google";
import { mapHeaders } from "@/lib/columns";
import { importRows, writebackStatuses } from "@/lib/leads";
import { first, audit } from "@/lib/db";
import type { Campaign } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return route(async () => {
    const user = await requireUser(request);
    const body = await readJson<{
      action?: string;
      url?: string;
      tab?: string;
      limit?: number;
      campaignId?: string;
      mapping?: Record<string, number>;
    }>(request);
    const action = str(body.action);

    if (action === "tabs") {
      const { spreadsheetId } = parseSheetUrl(str(body.url));
      const sheet = await getSpreadsheet(user.sub, spreadsheetId);
      return ok({ spreadsheetId, ...sheet });
    }

    if (action === "preview") {
      const { spreadsheetId } = parseSheetUrl(str(body.url));
      const tab = str(body.tab);
      if (!tab) throw new HttpError(400, "Select a worksheet first.");
      const values = await getSheetValues(user.sub, spreadsheetId, tab, "A1:Z2000");
      if (!values.length) return ok({ spreadsheetId, tab, headers: [], rows: [], mapping: {}, totalRows: 0 });
      const headers = values[0].map((h, i) => String(h || `Column ${i + 1}`).trim());
      return ok({
        spreadsheetId,
        tab,
        headers,
        rows: values.slice(1, 6),
        mapping: mapHeaders(headers),
        totalRows: Math.max(0, values.length - 1),
      });
    }

    if (action === "import") {
      const { spreadsheetId } = parseSheetUrl(str(body.url));
      const tab = str(body.tab);
      if (!tab) throw new HttpError(400, "Select a worksheet first.");
      const values = await getSheetValues(user.sub, spreadsheetId, tab, "A1:Z2000");
      if (values.length < 2) throw new HttpError(400, "That worksheet has no data rows.");
      const result = await importRows(user.sub, {
        spreadsheetId,
        tab,
        rows: values,
        mapping: body.mapping as never,
        limit: num(body.limit, 50),
      });
      await audit(user.sub, "sheet_imported", "sheet", `${spreadsheetId}|${tab}`, {
        created: result.created,
        duplicates: result.duplicates,
      });
      return ok({ ...result, sheet_source: `${spreadsheetId}|${tab}` });
    }

    if (action === "writeback") {
      const campaignId = str(body.campaignId);
      const campaign = await first<Campaign>(
        `SELECT * FROM campaigns WHERE owner_sub = ? AND id = ?`,
        user.sub,
        campaignId,
      );
      if (!campaign) throw new HttpError(404, "Campaign not found.");
      const result = await writebackStatuses(user.sub, campaign);
      await audit(user.sub, "sheet_writeback", "campaign", campaignId, result);
      return ok(result);
    }

    throw new HttpError(400, "Unknown action.");
  });
}
