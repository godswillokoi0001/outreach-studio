"use client";

import { useState } from "react";
import { AlertTriangle, Clock, Trash2 } from "lucide-react";
import { Modal } from "./ui";
import { useToast } from "./Feedback";
import { clearRecentActivity } from "@/lib/store";
import { errorMessage } from "@/lib/client";

interface ClearActivityModalProps {
  open: boolean;
  onClose: () => void;
  uid: string;
  onCleared: () => void;
}

export function ClearActivityModal({ open, onClose, uid, onCleared }: ClearActivityModalProps) {
  const toast = useToast();
  const [range, setRange] = useState<"all" | "7d" | "30d">("all");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleClear = async () => {
    if (!confirmed) return;
    setBusy(true);
    try {
      await clearRecentActivity(uid, range);
      toast.success(
        "Activity log cleared",
        range === "all"
          ? "All recent activity entries have been cleared."
          : `Activity older than ${range === "7d" ? "7 days" : "30 days"} has been cleared.`,
      );
      onCleared();
      onClose();
    } catch (err) {
      toast.error("Failed to clear activity", errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Clear Recent Activity">
      <div className="stack" style={{ gap: 16 }}>
        <p className="tiny" style={{ lineHeight: 1.5 }}>
          Choose which activity entries to clear from your feed. This cleans up your audit logs and timeline without
          affecting your pipeline.
        </p>

        <div
          style={{
            padding: "10px 14px",
            background: "rgba(22, 101, 52, 0.08)",
            borderRadius: 8,
            border: "1px solid rgba(22, 101, 52, 0.2)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <Clock size={16} style={{ color: "var(--teal-deep, #15803d)", flexShrink: 0 }} />
          <span className="tiny" style={{ color: "var(--ink-2)" }}>
            <strong>Safe operation:</strong> Leads, campaigns, messages, and analysis results will <em>not</em> be deleted.
          </span>
        </div>

        <div className="stack" style={{ gap: 10 }}>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 12px",
              borderRadius: 6,
              border: range === "all" ? "1px solid var(--line-active, #2563eb)" : "1px solid var(--line)",
              background: range === "all" ? "var(--surface-active, rgba(37,99,235,0.04))" : "transparent",
              cursor: "pointer",
            }}
          >
            <input
              type="radio"
              name="activityRange"
              value="all"
              checked={range === "all"}
              onChange={() => setRange("all")}
            />
            <div>
              <div className="strong" style={{ fontSize: 13.5 }}>Clear all activity</div>
              <div className="tiny muted">Remove all logged actions and events across the workspace.</div>
            </div>
          </label>

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 12px",
              borderRadius: 6,
              border: range === "7d" ? "1px solid var(--line-active, #2563eb)" : "1px solid var(--line)",
              background: range === "7d" ? "var(--surface-active, rgba(37,99,235,0.04))" : "transparent",
              cursor: "pointer",
            }}
          >
            <input
              type="radio"
              name="activityRange"
              value="7d"
              checked={range === "7d"}
              onChange={() => setRange("7d")}
            />
            <div>
              <div className="strong" style={{ fontSize: 13.5 }}>Clear older than 7 days</div>
              <div className="tiny muted">Keep events from the last 7 days and delete older entries.</div>
            </div>
          </label>

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 12px",
              borderRadius: 6,
              border: range === "30d" ? "1px solid var(--line-active, #2563eb)" : "1px solid var(--line)",
              background: range === "30d" ? "var(--surface-active, rgba(37,99,235,0.04))" : "transparent",
              cursor: "pointer",
            }}
          >
            <input
              type="radio"
              name="activityRange"
              value="30d"
              checked={range === "30d"}
              onChange={() => setRange("30d")}
            />
            <div>
              <div className="strong" style={{ fontSize: 13.5 }}>Clear older than 30 days</div>
              <div className="tiny muted">Keep events from the last month and delete older entries.</div>
            </div>
          </label>
        </div>

        <div
          style={{
            padding: "10px 12px",
            background: "rgba(220, 38, 38, 0.06)",
            borderRadius: 6,
            border: "1px solid rgba(220, 38, 38, 0.2)",
          }}
        >
          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span className="tiny" style={{ color: "var(--ink)" }}>
              I understand this action will permanently clear the selected activity logs.
            </span>
          </label>
        </div>

        <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={!confirmed || busy}
            onClick={() => void handleClear()}
          >
            <Trash2 size={13} aria-hidden="true" />
            {busy ? "Clearing…" : "Clear activity"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
