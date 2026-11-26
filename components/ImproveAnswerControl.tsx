"use client";

import { useState } from "react";
import { Check, Loader2, Sparkles, X } from "lucide-react";
import { authedPost, errorMessage } from "@/lib/client";

export function ImproveAnswerControl({
  questionTitle,
  value,
  businessContext,
  onAccept,
}: {
  questionTitle: string;
  value: string;
  businessContext?: string;
  onAccept: (improved: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const improve = async () => {
    if (!value.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await authedPost<{ improved: string }>("/api/ai/onboarding-assist", {
        action: "improve_answer",
        questionTitle,
        answer: value,
        businessContext,
      });
      setSuggestion(res.improved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ marginTop: 6 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => void improve()}
          disabled={loading || value.trim().length < 6}
          title={value.trim().length < 6 ? "Type a quick draft first to improve it" : "Get an AI clarity suggestion"}
        >
          {loading ? <Loader2 size={12} className="spin" /> : <Sparkles size={12} style={{ color: "var(--teal-deep)" }} />}
          {loading ? "Polishing…" : "Improve my answer"}
        </button>
        {error && <span className="tiny" style={{ color: "var(--bad, #b91c1c)" }}>{error}</span>}
      </div>

      {suggestion !== null && (
        <div
          style={{
            marginTop: 8,
            padding: 12,
            borderRadius: 10,
            border: "1px solid var(--teal-deep, #0f766e)",
            background: "var(--surface-2)",
          }}
        >
          <div className="tiny strong" style={{ color: "var(--teal-deep)", marginBottom: 4 }}>
            Suggested improvement (nothing replaced until you accept):
          </div>
          <p style={{ margin: "0 0 10px", fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{suggestion}</p>
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                onAccept(suggestion);
                setSuggestion(null);
              }}
            >
              <Check size={12} />
              Accept suggestion
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setSuggestion(null)}
            >
              <X size={12} />
              Ignore
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
