"use client";

import { useRef, useState } from "react";
import { Bold, Eye, Italic, Link2, List, Pencil } from "lucide-react";
import { formatEmailHtml } from "@/lib/email-format";

/**
 * Email body editor with a small formatting bar and a preview of exactly what
 * the recipient's mail client will render.
 *
 * The body stays light Markdown in the textarea so it is editable, diffable and
 * stored the same way everywhere; the send renderer (lib/email-format.ts) turns
 * it into HTML for every email, including replies.
 */
export function EmailBodyEditor({
  value,
  onChange,
  label = "Body",
  minHeight = 260,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  minHeight?: number;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [preview, setPreview] = useState(false);

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
          type="button"
          className="btn btn-sm"
          onClick={() => setPreview((current) => !current)}
          style={{ marginLeft: "auto" }}
        >
          {preview ? <Pencil size={12} aria-hidden="true" /> : <Eye size={12} aria-hidden="true" />}
          {preview ? "Edit" : "Preview"}
        </button>
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
      </span>
    </div>
  );
}
