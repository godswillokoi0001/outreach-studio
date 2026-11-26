"use client";

import React, { useState, ReactNode } from "react";
import { Check, Copy } from "lucide-react";

interface FormattedChatMessageProps {
  text: string;
  className?: string;
}

/**
 * Renders inline markdown: **bold**, *italic*, `code`, ~~strikethrough~~, [links](url)
 */
export function renderInlineFormatting(text: string, keyPrefix: string): ReactNode[] {
  if (!text) return [];

  // Match:
  // 1. [link text](url)
  // 2. **bold**
  // 3. `inline code`
  // 4. ~~strikethrough~~
  // 5. *italic* or _italic_
  const tokenRegex = /(\[[^\]]+\]\([^\s)]+\)|\*\*[^*]+\*\*|`[^`]+`|~~[^~]+~~|\*[^*\n]+\*|_[^_\n]+_)/g;
  const parts = text.split(tokenRegex);

  return parts.map((part, idx) => {
    if (!part) return null;
    const key = `${keyPrefix}-${idx}`;

    // Link: [label](url)
    if (part.startsWith("[") && part.includes("](") && part.endsWith(")")) {
      const closingBracket = part.indexOf("](");
      const label = part.slice(1, closingBracket);
      const url = part.slice(closingBracket + 2, -1).trim();

      // Basic safety: allow http(s), mailto, or relative paths
      const isSafe = /^(https?:\/\/|mailto:|\/)/i.test(url);
      if (isSafe) {
        return (
          <a
            key={key}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="chat-link"
          >
            {label}
          </a>
        );
      }
      return <span key={key}>{label}</span>;
    }

    // Bold: **text**
    if (part.startsWith("**") && part.endsWith("**") && part.length >= 4) {
      return (
        <strong key={key} className="chat-strong">
          {renderInlineFormatting(part.slice(2, -2), `${key}-b`)}
        </strong>
      );
    }

    // Inline code: `text`
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
      return (
        <code key={key} className="chat-inline-code">
          {part.slice(1, -1)}
        </code>
      );
    }

    // Strikethrough: ~~text~~
    if (part.startsWith("~~") && part.endsWith("~~") && part.length >= 4) {
      return (
        <del key={key} className="chat-del">
          {renderInlineFormatting(part.slice(2, -2), `${key}-d`)}
        </del>
      );
    }

    // Italic: *text* or _text_
    if (
      ((part.startsWith("*") && part.endsWith("*")) ||
        (part.startsWith("_") && part.endsWith("_"))) &&
      part.length >= 2
    ) {
      return (
        <em key={key} className="chat-em">
          {renderInlineFormatting(part.slice(1, -1), `${key}-i`)}
        </em>
      );
    }

    // Normal text
    return <span key={key}>{part}</span>;
  });
}

function ChatCodeBlock({
  language,
  code,
  blockIdx,
}: {
  language: string;
  code: string;
  blockIdx: number;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      // ignore clipboard permission errors
    }
  };

  const displayLang = language.trim() || "code";

  return (
    <div key={blockIdx} className="chat-code-block">
      <div className="chat-code-header">
        <span className="chat-code-lang">{displayLang}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="chat-copy-btn"
          aria-label="Copy code"
          title="Copy to clipboard"
        >
          {copied ? (
            <>
              <Check size={12} className="chat-copy-icon chat-copy-check" />
              <span>Copied!</span>
            </>
          ) : (
            <>
              <Copy size={12} className="chat-copy-icon" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="chat-code-content">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function ChatTable({ lines, blockIdx }: { lines: string[]; blockIdx: number }) {
  if (lines.length < 2) return null;

  const parseRow = (line: string) => {
    return line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
  };

  const headerCells = parseRow(lines[0]);
  // Line 1 is the delimiter row: e.g. | --- | --- |
  const bodyRows = lines.slice(2).map(parseRow);

  return (
    <div key={blockIdx} className="chat-table-wrap">
      <table className="chat-table">
        <thead>
          <tr>
            {headerCells.map((h, i) => (
              <th key={i}>{renderInlineFormatting(h, `th-${blockIdx}-${i}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bodyRows.map((row, rIdx) => (
            <tr key={rIdx}>
              {row.map((cell, cIdx) => (
                <td key={cIdx}>{renderInlineFormatting(cell, `td-${blockIdx}-${rIdx}-${cIdx}`)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type ParsedBlock =
  | { type: "code"; language: string; content: string }
  | { type: "table"; lines: string[] }
  | { type: "heading"; level: number; text: string }
  | { type: "blockquote"; lines: string[] }
  | { type: "ordered-list"; items: string[] }
  | { type: "unordered-list"; items: string[] }
  | { type: "hr" }
  | { type: "paragraph"; lines: string[] };

function parseMarkdownBlocks(rawText: string): ParsedBlock[] {
  const lines = rawText.split("\n");
  const blocks: ParsedBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Empty lines
    if (!trimmed) {
      i++;
      continue;
    }

    // Fenced Code Block: starts with ```
    if (trimmed.startsWith("```")) {
      const language = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length && lines[i].trim().startsWith("```")) {
        i++; // skip closing ```
      }
      blocks.push({
        type: "code",
        language,
        content: codeLines.join("\n"),
      });
      continue;
    }

    // Horizontal Rule: --- or *** or ___
    if (/^(\-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // Headings: #, ##, ###, ####
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
      });
      i++;
      continue;
    }

    // Blockquote: > text
    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({
        type: "blockquote",
        lines: quoteLines,
      });
      continue;
    }

    // Markdown Table: line has '|' and next line is '| --- |'
    if (
      trimmed.startsWith("|") &&
      trimmed.endsWith("|") &&
      i + 1 < lines.length &&
      /^\|(\s*:?-+:?\s*\|)+$/.test(lines[i + 1].trim())
    ) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|") && lines[i].trim().endsWith("|")) {
        tableLines.push(lines[i].trim());
        i++;
      }
      blocks.push({
        type: "table",
        lines: tableLines,
      });
      continue;
    }

    // Ordered List: 1. , 2. , etc.
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ""));
        i++;
      }
      blocks.push({
        type: "ordered-list",
        items,
      });
      continue;
    }

    // Unordered List: - , * , •
    if (/^[-*•]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*•]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*•]\s+/, ""));
        i++;
      }
      blocks.push({
        type: "unordered-list",
        items,
      });
      continue;
    }

    // Regular Paragraph
    const paragraphLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim().length > 0 &&
      !lines[i].trim().startsWith("```") &&
      !/^(\-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim()) &&
      !/^(#{1,4})\s+/.test(lines[i].trim()) &&
      !lines[i].trim().startsWith(">") &&
      !(
        lines[i].trim().startsWith("|") &&
        i + 1 < lines.length &&
        /^\|(\s*:?-+:?\s*\|)+$/.test(lines[i + 1].trim())
      ) &&
      !/^\d+\.\s+/.test(lines[i].trim()) &&
      !/^[-*•]\s+/.test(lines[i].trim())
    ) {
      paragraphLines.push(lines[i].trim());
      i++;
    }

    if (paragraphLines.length > 0) {
      blocks.push({
        type: "paragraph",
        lines: paragraphLines,
      });
    }
  }

  return blocks;
}

export function FormattedChatMessage({ text, className = "" }: FormattedChatMessageProps) {
  if (!text) return null;

  const blocks = parseMarkdownBlocks(text.trim());

  return (
    <div className={`chat-reply-text ${className}`.trim()}>
      {blocks.map((block, bIdx) => {
        switch (block.type) {
          case "code":
            return (
              <ChatCodeBlock
                key={bIdx}
                blockIdx={bIdx}
                language={block.language}
                code={block.content}
              />
            );

          case "table":
            return <ChatTable key={bIdx} blockIdx={bIdx} lines={block.lines} />;

          case "heading": {
            const headingContent = renderInlineFormatting(block.text, `h-${bIdx}`);
            if (block.level === 1) {
              return (
                <h3 key={bIdx} className="chat-h1">
                  {headingContent}
                </h3>
              );
            }
            if (block.level === 2) {
              return (
                <h4 key={bIdx} className="chat-h2">
                  {headingContent}
                </h4>
              );
            }
            if (block.level === 3) {
              return (
                <h5 key={bIdx} className="chat-h3">
                  {headingContent}
                </h5>
              );
            }
            return (
              <h6 key={bIdx} className="chat-h4">
                {headingContent}
              </h6>
            );
          }

          case "blockquote":
            return (
              <blockquote key={bIdx} className="chat-blockquote">
                {block.lines.map((l, lIdx) => (
                  <div key={lIdx}>
                    {renderInlineFormatting(l, `quote-${bIdx}-${lIdx}`)}
                  </div>
                ))}
              </blockquote>
            );

          case "ordered-list":
            return (
              <ol key={bIdx} className="chat-ol">
                {block.items.map((item, itemIdx) => (
                  <li key={itemIdx} className="chat-li">
                    {renderInlineFormatting(item, `ol-${bIdx}-${itemIdx}`)}
                  </li>
                ))}
              </ol>
            );

          case "unordered-list":
            return (
              <ul key={bIdx} className="chat-ul">
                {block.items.map((item, itemIdx) => (
                  <li key={itemIdx} className="chat-li">
                    {renderInlineFormatting(item, `ul-${bIdx}-${itemIdx}`)}
                  </li>
                ))}
              </ul>
            );

          case "hr":
            return <hr key={bIdx} className="chat-hr" />;

          case "paragraph":
            return (
              <p key={bIdx} className="chat-p">
                {block.lines.map((line, lIdx) => (
                  <React.Fragment key={lIdx}>
                    {renderInlineFormatting(line, `p-${bIdx}-${lIdx}`)}
                    {lIdx < block.lines.length - 1 ? <br /> : null}
                  </React.Fragment>
                ))}
              </p>
            );

          default:
            return null;
        }
      })}
    </div>
  );
}

/**
 * Backwards compatible export for DashboardChat
 */
export const FormattedReply = FormattedChatMessage;
