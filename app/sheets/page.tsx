"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";
import { Banner, Card, Empty, Field } from "@/components/ui";
import { authedPost, errorMessage } from "@/lib/client";
import { LEAD_FIELDS } from "@/lib/columns";
import { importSheetRows, listCampaigns } from "@/lib/firestore-store";
import { writebackCampaignStatuses } from "@/lib/pipeline-client";
import type { Campaign } from "@/lib/types";

interface TabsResponse {
  spreadsheetId: string;
  title: string;
  tabs: { title: string; rowCount: number; columnCount: number }[];
}

interface PreviewResponse {
  spreadsheetId: string;
  tab: string;
  headers: string[];
  rows: string[][];
  mapping: Record<string, number>;
  totalRows: number;
}

export default function SheetsPage() {
  const { user, workspaceToken, reconnectWorkspace } = useAuth();
  const [url, setUrl] = useState("");
  const [sheet, setSheet] = useState<TabsResponse | null>(null);
  const [tab, setTab] = useState("");
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [limit, setLimit] = useState(50);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [writeCampaign, setWriteCampaign] = useState("");
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);

  const loadCampaigns = useCallback(async () => {
    try {
      setCampaigns(await listCampaigns(user.uid));
    } catch {
      // ignore non-fatal dropdown refresh error
    }
  }, [user.uid]);

  useEffect(() => {
    let active = true;
    listCampaigns(user.uid).then(
      (res) => {
        if (active) setCampaigns(res);
      },
      () => {
        // ignore non-fatal dropdown refresh error
      },
    );
    return () => {
      active = false;
    };
  }, [user.uid]);

  const ensureWorkspace = async (): Promise<boolean> => {
    if (workspaceToken) return true;
    return reconnectWorkspace();
  };

  const load = async (action: "tabs" | "preview") => {
    if (!(await ensureWorkspace())) return;
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      if (action === "tabs") {
        const data = await authedPost<TabsResponse>(
          "/api/workspace/sheets",
          { action: "tabs", url },
          { requireWorkspace: true },
        );
        setSheet(data);
        setPreview(null);
        setTab(data.tabs[0]?.title ?? "");
      } else {
        const data = await authedPost<PreviewResponse>(
          "/api/workspace/sheets",
          { action: "preview", url, tab },
          { requireWorkspace: true },
        );
        setPreview(data);
        setNotice(
          `${data.totalRows} data rows found. ${Object.values(data.mapping ?? {}).filter((v) => v >= 0).length} columns mapped automatically.`,
        );
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const runImport = async () => {
    if (!(await ensureWorkspace())) return;
    setBusy("import");
    setError(null);
    try {
      const sheetData = await authedPost<{ spreadsheetId: string; tab: string; values: string[][] }>(
        "/api/workspace/sheets",
        { action: "values", url, tab },
        { requireWorkspace: true },
      );
      const result = await importSheetRows(user.uid, {
        spreadsheetId: sheetData.spreadsheetId,
        tab: sheetData.tab,
        rows: sheetData.values,
        limit,
      });
      setNotice(
        `Imported ${result.created} leads (${result.duplicates} duplicates skipped, ${result.skipped} empty rows).`,
      );
      await loadCampaigns();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const writeback = async () => {
    if (!writeCampaign) return;
    if (!(await ensureWorkspace())) return;
    if (
      !window.confirm(
        "Write current prospect statuses to the Status column in your Google Sheet? Existing columns will not be overwritten.",
      )
    ) {
      return;
    }
    setBusy("writeback");
    setError(null);
    try {
      const result = await writebackCampaignStatuses(user.uid, writeCampaign);
      setNotice(
        result.updated
          ? `Wrote ${result.updated} statuses to column ${result.column}.`
          : "Nothing to write for that campaign.",
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Google Sheets</h1>
          <p className="page-sub">
            Pull prospects straight from a spreadsheet, let the app identify the useful columns, and write campaign
            statuses back without touching your original data.
          </p>
        </div>
        <div className="row-end">
          <Link className="btn btn-sm" href="/integrations">
            Google connection
          </Link>
        </div>
      </div>

      <div className="stack">
        {!workspaceToken && (
          <Banner tone="warn">
            <strong>Google Sheets access needs reconnection for this tab session.</strong>{" "}
            <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => void reconnectWorkspace()} type="button">
              Grant / Reconnect Google Sheets Access
            </button>
          </Banner>
        )}
        {error && <Banner tone="bad">{error}</Banner>}
        {notice && <Banner tone="ok">{notice}</Banner>}

        <Card
          title="1. Choose a spreadsheet"
          sub="Paste the full Google Sheets link. Your signed-in Google account must have access."
        >
          <div className="row">
            <input
              className="input"
              style={{ flex: 1, minWidth: 280 }}
              placeholder="https://docs.google.com/spreadsheets/d/..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button
              className="btn btn-primary"
              onClick={() => void load("tabs")}
              disabled={!url || busy !== null}
              type="button"
            >
              {busy === "tabs" ? "Loading…" : "Load worksheets"}
            </button>
          </div>
        </Card>

        {sheet && (
          <Card title="2. Pick a worksheet" sub={sheet.title}>
            <div className="row" style={{ marginBottom: 12 }}>
              <select
                className="select"
                style={{ maxWidth: 320 }}
                value={tab}
                onChange={(e) => {
                  setTab(e.target.value);
                  setPreview(null);
                }}
              >
                {sheet.tabs.map((t) => (
                  <option key={t.title} value={t.title}>
                    {t.title} ({t.rowCount} rows)
                  </option>
                ))}
              </select>
              <button
                className="btn"
                onClick={() => void load("preview")}
                disabled={!tab || busy !== null}
                type="button"
              >
                {busy === "preview" ? "Reading…" : "Preview and map columns"}
              </button>
            </div>
            {sheet.tabs.length === 0 && (
              <Empty title="No worksheets found">Check that the spreadsheet has a data tab.</Empty>
            )}
          </Card>
        )}

        {preview && (
          <Card
            title="3. Review the mapping"
            sub="Column names are matched automatically. Empty columns are ignored."
          >
            {preview.headers.length === 0 ? (
              <Empty title="That worksheet is empty" />
            ) : (
              <>
                <div className="row" style={{ marginBottom: 12 }}>
                  {LEAD_FIELDS.map((field) => {
                    const index = preview.mapping?.[field] ?? -1;
                    return (
                      <span key={field} className="badge" data-tone={index >= 0 ? "ok" : undefined}>
                        {field.replace("_", " ")}: {index >= 0 ? preview.headers[index] : "—"}
                      </span>
                    );
                  })}
                </div>
                <div className="table-wrap" style={{ marginBottom: 14 }}>
                  <table>
                    <thead>
                      <tr>
                        {preview.headers.map((header, index) => (
                          <th key={index}>{header}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row, rowIndex) => (
                        <tr key={rowIndex}>
                          {preview.headers.map((_, cellIndex) => (
                            <td key={cellIndex} className="tiny">
                              {row[cellIndex] ?? ""}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="row">
                  <Field label="How many prospects to import">
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={500}
                      value={limit}
                      onChange={(e) => setLimit(Number(e.target.value))}
                      style={{ width: 120 }}
                    />
                  </Field>
                  <div style={{ paddingTop: 20 }}>
                    <button
                      className="btn btn-primary"
                      onClick={() => void runImport()}
                      disabled={busy !== null}
                      type="button"
                    >
                      {busy === "import" ? "Importing…" : `Import ${limit} prospects`}
                    </button>
                  </div>
                  <div style={{ paddingTop: 20 }} className="tiny">
                    Leaves the spreadsheet untouched. Existing email addresses are skipped, so outreach is never
                    duplicated.
                  </div>
                </div>
              </>
            )}
          </Card>
        )}

        <Card
          title="Write statuses back"
          sub="Adds or updates a Status column for prospects in a campaign. Other columns are never modified."
        >
          <div className="row">
            <select
              className="select"
              style={{ maxWidth: 380 }}
              value={writeCampaign}
              onChange={(e) => setWriteCampaign(e.target.value)}
            >
              <option value="">Select a campaign…</option>
              {campaigns.map((campaign) => (
                <option key={campaign.id} value={campaign.id}>
                  {campaign.name}
                  {campaign.sheet_source ? "" : " (not linked to a sheet)"}
                </option>
              ))}
            </select>
            <button
              className="btn"
              onClick={() => void writeback()}
              disabled={!writeCampaign || busy !== null}
              type="button"
            >
              {busy === "writeback" ? "Writing…" : "Write statuses"}
            </button>
          </div>
        </Card>
      </div>
    </main>
  );
}
