import { NextRequest, NextResponse } from "next/server";
import { extractWorkspaceToken, handleApiError } from "@/lib/api-helpers";
import { mapHeaders } from "@/lib/columns";
import { verifyFirebaseRequest } from "@/lib/firebase-server-auth";
import { columnLetter, parseSheetUrl } from "@/lib/outreach-utils";

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

async function sheetsFetch<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${SHEETS_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const errMsg =
      json && typeof json === "object" && "error" in json
        ? String((json as { error?: { message?: string } }).error?.message ?? `Sheets API error (${res.status})`)
        : `Google Sheets request failed (${res.status}).`;
    throw new Error(errMsg);
  }
  return json as T;
}

function quoteTab(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

export async function POST(req: NextRequest) {
  try {
    await verifyFirebaseRequest(req);
    const token = extractWorkspaceToken(req);
    const body = (await req.json()) as {
      action: "tabs" | "preview" | "values" | "writeback";
      url?: string;
      spreadsheetId?: string;
      tab?: string;
      rows?: { row: number; status: string }[];
    };

    const parsed = body.spreadsheetId
      ? { spreadsheetId: body.spreadsheetId, gid: null }
      : parseSheetUrl(body.url ?? "");

    if (body.action === "tabs") {
      const meta = await sheetsFetch<{
        properties: { title: string };
        sheets: { properties: { sheetId: number; title: string; gridProperties?: { rowCount?: number; columnCount?: number } } }[];
      }>(token, `/${encodeURIComponent(parsed.spreadsheetId)}?fields=properties.title,sheets.properties`);

      return NextResponse.json({
        spreadsheetId: parsed.spreadsheetId,
        title: meta.properties?.title ?? "Spreadsheet",
        tabs: (meta.sheets ?? []).map((s) => ({
          sheetId: s.properties.sheetId,
          title: s.properties.title,
          rowCount: s.properties.gridProperties?.rowCount ?? 0,
          columnCount: s.properties.gridProperties?.columnCount ?? 0,
        })),
      });
    }

    const tab = body.tab?.trim();
    if (!tab) {
      return NextResponse.json({ error: "Worksheet tab name is required." }, { status: 400 });
    }

    if (body.action === "preview" || body.action === "values") {
      const range = encodeURIComponent(`${quoteTab(tab)}!A1:Z2000`);
      const data = await sheetsFetch<{ values?: string[][] }>(
        token,
        `/${encodeURIComponent(parsed.spreadsheetId)}/values/${range}?majorDimension=ROWS`,
      );
      const values = data.values ?? [];
      if (body.action === "values") {
        return NextResponse.json({
          spreadsheetId: parsed.spreadsheetId,
          tab,
          values,
        });
      }
      const [header = [], ...rows] = values;
      return NextResponse.json({
        spreadsheetId: parsed.spreadsheetId,
        tab,
        headers: header,
        rows: rows.slice(0, 10),
        mapping: mapHeaders(header),
        totalRows: rows.length,
      });
    }

    if (body.action === "writeback") {
      const updates = Array.isArray(body.rows) ? body.rows : [];
      if (!updates.length) {
        return NextResponse.json({ updated: 0, column: "" });
      }
      const headData = await sheetsFetch<{ values?: string[][] }>(
        token,
        `/${encodeURIComponent(parsed.spreadsheetId)}/values/${encodeURIComponent(`${quoteTab(tab)}!1:1`)}`,
      );
      const header = headData.values?.[0] ?? [];
      let statusCol = header.findIndex((h) => h.trim().toLowerCase() === "status");
      if (statusCol === -1) {
        statusCol = header.length;
        const colLetter = columnLetter(statusCol);
        await sheetsFetch(
          token,
          `/${encodeURIComponent(parsed.spreadsheetId)}/values/${encodeURIComponent(`${quoteTab(tab)}!${colLetter}1`)}?valueInputOption=USER_ENTERED`,
          {
            method: "PUT",
            body: JSON.stringify({ values: [["Status"]] }),
          },
        );
      }
      const colLetter = columnLetter(statusCol);
      await sheetsFetch(
        token,
        `/${encodeURIComponent(parsed.spreadsheetId)}/values:batchUpdate`,
        {
          method: "POST",
          body: JSON.stringify({
            valueInputOption: "USER_ENTERED",
            data: updates.map((u) => ({
              range: `${quoteTab(tab)}!${colLetter}${u.row}`,
              values: [[u.status]],
            })),
          }),
        },
      );
      return NextResponse.json({ updated: updates.length, column: colLetter });
    }

    return NextResponse.json({ error: "Unknown sheets action." }, { status: 400 });
  } catch (err) {
    return handleApiError(err);
  }
}
