"use client";

import { useRef, useState } from "react";
import { Bold, Eye, Italic, Link2, List, Pencil, Sparkles, Undo2 } from "lucide-react";
import { formatEmailHtml } from "@/lib/email-format";
import { authedPost, errorMessage } from "@/lib/client";

/**
 * Email body editor with a small formatting bar and a preview of exactly what
 * the recipient's mail client will render.
 *
 * The body stays light Markdown in the textarea so it is editable, diffable and
 * stored the same way everywhere; the send renderer (lib/email-format.ts) turns
 * it into HTML for every email, including replies.
 *
 * "Refine with AI" rewrites the text that is in the box — the user's own draft or
 * the suggestion they started from — using a tone preset or a plain instruction.
 */

const TONES: { label: string; instruction: string }[] = [
  { label: "Professional", instruction: "Rewrite it in a professional, polished business tone." },
  { label: "Polite", instruction: "Make it more polite and considerate without making it weaker." },
  { label: "Friendly", instruction: "Make it warmer and friendlier while staying credible." },
  { label: "Concise", instruction: "Tighten it: keep the same meaning in noticeably fewer words and cut filler." },
  { label: "Direct", instruction: "Make the ask clearer and more direct while staying respectful." },
  { label: "Fix grammar", instruction: "Fix grammar, spelling and punctuation only. Do not change the wording beyond correctness." },
];

export function EmailBodyEditor({
  value,
  onChange,
  label = "Body",
  minHeight = 260,
  placeholder,
  kind = "email",
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  minHeight?: number;
  placeholder?: string;
  /** Tells the refiner whether this is a first/follow-up email or a reply. */
  kind?: "email" | "reply";
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [preview, setPreview] = useState(false);
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [previous, setPrevious] = useState<string | null>(null);

  const wrapSelection = (before: string, after: string, fallback: string) => {
    const el = ref.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = value.slice(start, end) || fallback;
    const next = `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`;
    const caret = start + before.length + selected.length + after.length;
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const bulletLines = () => {
    const el = ref.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const from = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const target = value.slice(from, Math.max(end, start)) || "List item";
    const lines = target.split("\n").map((line) => (/^[-*•]\s+/.test(line) ? line : `- ${line}`));
    const next = `${value.slice(0, from)}${lines.join("\n")}${value.slice(Math.max(end, start))}`;
    const caret = from + lines.join("\n").length;
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const refine = async (how: string) => {
    const current = value.trim();
    if (!current) {
      setRefineError("Write something first, then refine it.");
      return;
    }
    const asked = how.trim();
    if (!asked) {
      setRefineError("Say how the rewrite should change — a tone, or a concrete edit.");
      return;
    }
    setRefining(true);
    setRefineError(null);
    try {
      const res = await authedPost<{ text: string }>("/api/ai/refine", {
        body: current,
        instruction: asked,
        kind,
      });
      const next = (res.text ?? "").trim();
      if (!next) throw new Error("The rewrite service is briefly unavailable. Retry in a moment.");
      setPrevious(value);
      onChange(next);
      setInstruction("");
    } catch (err) {
      setRefineError(errorMessage(err));
    } finally {
      setRefining(false);
    }
  };

  return (
    <div className="field">
      <span className="label">{label}</span>
      <div className="row" style={{ marginBottom: 6, gap: 6 }}>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => wrapSelection("**", "**", "bold text")}
          disabled={preview}
          title="Bold"
        >
          <Bold size={12} aria-hidden="true" /> Bold
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => wrapSelection("*", "*", "italic text")}
          disabled={preview}
          title="Italic"
        >
          <Italic size={12} aria-hidden="true" /> Italic
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={bulletLines}
          disabled={preview}
          title="Bulleted list"
        >
          <List size={12} aria-hidden="true" /> List
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => wrapSelection("[", "](https://)", "link text")}
          disabled={preview}
          title="Link"
        >
          <Link2 size={12} aria-hidden="true" /> Link
        </button>
        <button
          className="btn btn-sm"
          onClick={() => setPreview((current) => !current)}
          style={{ marginLeft: "auto" }}
          type="button"
        >
          {preview ? <Pencil size={12} aria-hidden="true" /> : <Eye size={12} aria-hidden="true" />}
          {preview ? "Edit" : "Preview"}
        </button>
      </div>

      <div className="refine-bar">
        <div className="row refine-tones">
          <span className="label" style={{ marginBottom: 0 }}>
            Refine with AI
          </span>
          {TONES.map((tone) => (
            <button
              key={tone.label}
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={refining || preview}
              onClick={() => void refine(tone.instruction)}
              title={tone.instruction}
            >
              {tone.label}
            </button>
          ))}
        </div>
        <div className="row" style={{ gap: 6, marginTop: 6 }}>
          <input
            className="input"
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !refining) {
                event.preventDefault();
                void refine(instruction);
              }
            }}
            placeholder="Or describe the change — e.g. shorter, less salesy, mention the price"
            aria-label="Custom refine instruction"
            disabled={refining || preview}
          />
          <button
            type="button"
            className="btn btn-sm"
            disabled={refining || preview || !instruction.trim()}
            onClick={() => void refine(instruction)}
          >
            <Sparkles size={12} aria-hidden="true" />
            {refining ? "Refining…" : "Apply"}
          </button>
          {previous !== null && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={refining}
              onClick={() => {
                onChange(previous);
                setPrevious(null);
              }}
              title="Put back the text from before the last refine"
            >
              <Undo2 size={12} aria-hidden="true" /> Undo
            </button>
          )}
        </div>
        {refineError && (
          <span className="tiny" style={{ color: "var(--bad)" }} role="alert">
            {refineError}
          </span>
        )}
      </div>

      {preview ? (
        <div
          style={{
            minHeight,
            padding: "14px 16px",
            border: "1px solid var(--line)",
            borderRadius: 10,
            background: "var(--surface)",
            fontSize: 15,
            lineHeight: 1.65,
          }}
          // The renderer escapes the body first and only emits p/br/strong/em/ul/li/a.
          dangerouslySetInnerHTML={{ __html: formatEmailHtml(value || "") }}
        />
      ) : (
        <textarea
          ref={ref}
          className="textarea"
          style={{ minHeight }}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      <span className="tiny">
        Blank line starts a paragraph. **bold**, *italic*, - list items and [text](https://link) are sent formatted.
        Refining only rewrites the text above — nothing is sent.
      </span>
    </div>
  );
}
