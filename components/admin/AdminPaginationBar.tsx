"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight, Download, Trash2 } from "lucide-react";
import { Modal } from "../ui";

export type ClearRangeOption = "all" | "7d" | "30d" | "90d";

export const CLEAR_RANGE_LABELS: Record<ClearRangeOption, string> = {
  all: "All entries",
  "7d": "Older than 7 days",
  "30d": "Older than 30 days",
  "90d": "Older than 90 days",
};

export function AdminPaginationBar({
  page,
  pageSize,
  totalCount,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageSize: number;
  totalCount: number;
  onPageChange: (nextPage: number) => void;
  onPageSizeChange: (nextSize: number) => void;
}) {
  const safeSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(totalCount / safeSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = totalCount === 0 ? 0 : (safePage - 1) * safeSize + 1;
  const end = Math.min(totalCount, safePage * safeSize);

  const pageNumbers: (number | "ellipsis-l" | "ellipsis-r")[] = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i += 1) pageNumbers.push(i);
  } else {
    pageNumbers.push(1);
    if (safePage > 3) pageNumbers.push("ellipsis-l");
    const lo = Math.max(2, safePage - 1);
    const hi = Math.min(totalPages - 1, safePage + 1);
    for (let i = lo; i <= hi; i += 1) pageNumbers.push(i);
    if (safePage < totalPages - 2) pageNumbers.push("ellipsis-r");
    pageNumbers.push(totalPages);
  }

  return (
    <div
      className="row"
      style={{
        justifyContent: "space-between",
        alignItems: "center",
        paddingTop: 12,
        borderTop: "1px solid var(--line-soft)",
        marginTop: 10,
        gap: 10,
        flexWrap: "wrap",
      }}
    >
      <div className="row" style={{ gap: 10, alignItems: "center" }}>
        <span className="tiny muted">
          Showing {start}–{end} of {totalCount}
        </span>
        <label className="row tiny muted" style={{ gap: 6, alignItems: "center" }}>
          <span>Rows:</span>
          <select
            className="select"
            aria-label="Rows per page"
            value={safeSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            style={{ width: "auto", padding: "3px 8px", fontSize: 12 }}
          >
            <option value={10}>10</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
          </select>
        </label>
      </div>

      <div className="row" style={{ gap: 4, alignItems: "center", flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={safePage <= 1}
          onClick={() => onPageChange(safePage - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft size={13} />
          <span>Prev</span>
        </button>

        {pageNumbers.map((token) =>
          typeof token === "number" ? (
            <button
              key={token}
              type="button"
              className={`btn btn-sm ${token === safePage ? "btn-primary" : "btn-ghost"}`}
              aria-current={token === safePage ? "page" : undefined}
              onClick={() => onPageChange(token)}
              style={{ minWidth: 30 }}
            >
              {token}
            </button>
          ) : (
            <span key={token} className="tiny muted" style={{ padding: "0 4px" }}>
              …
            </span>
          ),
        )}

        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={safePage >= totalPages}
          onClick={() => onPageChange(safePage + 1)}
          aria-label="Next page"
        >
          <span>Next</span>
          <ChevronRight size={13} />
        </button>
      </div>
    </div>
  );
}

export function AdminClearConfirmModal({
  open,
  title,
  description,
  range,
  previewCount,
  loadingPreview,
  clearing,
  canDownloadCsv,
  onDownloadCsv,
  onRangeChange,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  range: ClearRangeOption;
  previewCount: number | null;
  loadingPreview: boolean;
  clearing: boolean;
  canDownloadCsv?: boolean;
  onDownloadCsv?: () => void;
  onRangeChange: (next: ClearRangeOption) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [ackChecked, setAckChecked] = useState(false);

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="stack" style={{ gap: 12 }}>
        <p className="tiny muted" style={{ margin: 0 }}>
          {description}
        </p>

        <div className="field" style={{ marginBottom: 0 }}>
          <label className="label">Range to clear</label>
          <select
            className="input"
            value={range}
            onChange={(e) => onRangeChange(e.target.value as ClearRangeOption)}
            disabled={clearing}
          >
            {(Object.keys(CLEAR_RANGE_LABELS) as ClearRangeOption[]).map((opt) => (
              <option key={opt} value={opt}>
                {CLEAR_RANGE_LABELS[opt]}
              </option>
            ))}
          </select>
        </div>

        <div
          style={{
            padding: 10,
            borderRadius: 8,
            border: "1px solid var(--line)",
            background: "var(--surface-2)",
          }}
        >
          <div className="tiny">
            {loadingPreview ? (
              "Calculating exact entries to be removed…"
            ) : previewCount !== null ? (
              <>
                <strong>{previewCount}</strong> entry{previewCount === 1 ? "" : " entries"} match{" "}
                <strong>{CLEAR_RANGE_LABELS[range]}</strong>.
              </>
            ) : (
              "Select a date range to preview exact entries."
            )}
          </div>
        </div>

        {canDownloadCsv && onDownloadCsv && (
          <div>
            <button type="button" className="btn btn-sm" onClick={onDownloadCsv}>
              <Download size={13} />
              <span>Download CSV backup first</span>
            </button>
          </div>
        )}

        <label className="check tiny">
          <input
            type="checkbox"
            checked={ackChecked}
            onChange={(e) => setAckChecked(e.target.checked)}
          />
          <span>I confirm permanently removing these {previewCount ?? 0} log/history records.</span>
        </label>

        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={clearing}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={clearing || loadingPreview || !ackChecked || (previewCount ?? 0) === 0}
            onClick={onConfirm}
          >
            <Trash2 size={13} />
            <span>{clearing ? "Clearing…" : `Clear ${previewCount ?? 0} entries`}</span>
          </button>
        </div>
      </div>
    </Modal>
  );
}
