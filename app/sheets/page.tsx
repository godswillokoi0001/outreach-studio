"use client";

import { useState } from "react";
import Link from "next/link";
import { api, errorMessage, useApi } from "@/lib/client";
import { Banner, Card, Empty, Field } from "@/components/ui";
import { LEAD_FIELDS } from "@/lib/columns";

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

interface CampaignRow {
  id: string;
  name: string;
  status: string;
  sheet_source: string | null;
}

export default function SheetsPage() {
  const [url, setUrl] = useState("");
  const [sheet, setSheet] = useState<TabsResponse | null>(null);
  const [tab, setTab] = useState("");
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [limit, setLimit] = useState(50);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [writeCampaign, setWriteCampaign] = useState("");

  const campaigns = useApi<{ campaigns: CampaignRow[] }>("/api/campaigns");

  const load = async (action: "tabs" | "preview") => {
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      if (action === "tabs") {
        const data = await api.post<TabsResponse>("/api/sheets", { action: "tabs", url });
        setSheet(data);
        setPreview(null);
        setTab(data.tabs[0]?.title ?? "");
      } else {
        const data = await api.post<PreviewResponse>("/api/sheets", { action: "preview", url, tab });
        setPreview(data);
        setNotice(`${data.totalRows} data rows found. ${Object.values(data.mapping ?? {}).filter((v) => v >= 0).length} columns mapped automatically.`);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const runImport = async () => {
    setBusy("import");
    setError(null);
    try {
      const result = await api.post<{ created: number; duplicates: number; skipped: number }>("/api/sheets", {
        action: "import",
        url,
        tab,
        limit,
      });
      setNotice(`Imported ${result.created} leads (${result.duplicates} duplicates skipped, ${result.skipped} empty rows).`);
      await campaigns.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const writeback = async () => {
    if (!writeCampaign) return;
    setBusy("writeback");
    setError(null);
    try {
      const result = await api.post<{ updated: number; column: string }>("/api/sheets", {
        action: "writeback",
        campaignId: writeCampaign,
      });
      setNotice(result.updated ? `Wrote ${result.updated} statuses to column ${result.column}.` : "Nothing to write for that campaign.");
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
          <Link className="btn btn-sm" href="/integrations">Google connection</Link>
        </div>
      </div>

      <div className="stack">
        {error && <Banner tone="bad">{error}</Banner>}
        {notice && <Banner tone="ok">{notice}</Banner>}

        <Card title="1. Choose a spreadsheet" sub="Paste the full Google Sheets link. The signed-in Google account must have access.">
          <div className="row">
            <input
              className="input"
              style={{ flex: 1, minWidth: 280 }}
              placeholder="https://docs.google.com/spreadsheets/d/..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button className="btn btn-primary" onClick={() => load("tabs")} disabled={!url || busy !== null} type="button">
              {busy === "tabs" ? "Loading…" : "Load worksheets"}
            </button>
          </div>
        </Card>

        {sheet && (
          <Card title="2. Pick a worksheet" sub={sheet.title}>
            <div className="row" style={{ marginBottom: 12 }}>
              <select className="select" style={{ maxWidth: 320 }} value={tab} onChange={(e) => { setTab(e.target.value); setPreview(null); }}>
                {sheet.tabs.map((t) => (
                  <option key={t.title} value={t.title}>
                    {t.title} ({t.rowCount} rows)
                  </option>
                ))}
              </select>
              <button className="btn" onClick={() => load("preview")} disabled={!tab || busy !== null} type="button">
                {busy === "preview" ? "Reading…" : "Preview and map columns"}
              </button>
            </div>
            {sheet.tabs.length === 0 && <Empty title="No worksheets found">Check that the spreadsheet has a data tab.</Empty>}
          </Card>
        )}

        {preview && (
          <Card title="3. Review the mapping" sub="Column names are matched automatically. Empty columns are ignored.">
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
                      <tr>{preview.headers.map((header, index) => <th key={index}>{header}</th>)}</tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row, rowIndex) => (
                        <tr key={rowIndex}>
                          {preview.headers.map((_, cellIndex) => (
                            <td key={cellIndex} className="tiny">{row[cellIndex] ?? ""}</td>
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
                    <button className="btn btn-primary" onClick={runImport} disabled={busy !== null} type="button">
                      {busy === "import" ? "Importing…" : `Import ${limit} prospects`}
                    </button>
                  </div>
                  <div style={{ paddingTop: 20 }} className="tiny">
                    Leaves the spreadsheet untouched. Existing email addresses are skipped, so outreach is never duplicated.
                  </div>
                </div>
              </>
            )}
          </Card>
        )}

        <Card title="Write statuses back" sub="Adds or updates a Status column for prospects in a campaign. Other columns are never modified.">
          <div className="row">
            <select className="select" style={{ maxWidth: 380 }} value={writeCampaign} onChange={(e) => setWriteCampaign(e.target.value)}>
              <option value="">Select a campaign…</option>
              {(campaigns.data?.campaigns ?? []).map((campaign) => (
                <option key={campaign.id} value={campaign.id}>
                  {campaign.name}{campaign.sheet_source ? "" : " (not linked to a sheet)"}
                </option>
              ))}
            </select>
            <button className="btn" onClick={writeback} disabled={!writeCampaign || busy !== null} type="button">
              {busy === "writeback" ? "Writing…" : "Write statuses"}
            </button>
          </div>
        </Card>
      </div>
    </main>
  );
}
