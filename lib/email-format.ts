/**
 * Email body formatting, shared by the composer preview and the MIME builder so
 * what you see in the app is exactly what lands in the inbox.
 *
 * Bodies are stored as light Markdown — paragraphs separated by a blank line,
 * `**bold**`, `*italic*`, `[text](https://…)` links and `- ` bullet lines. Every
 * send turns that into styled HTML (plus a readable text/plain alternative),
 * including replies, so formatting never depends on the recipient's mail client
 * guessing where the paragraphs are.
 */

export function escapeEmailHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const BOLD = /\*\*([^*\n]+)\*\*/g;
const ITALIC_STAR = /(^|[\s(])\*([^*\n]+)\*(?=[\s.,!?)]|$)/g;
const ITALIC_UNDERSCORE = /(^|[\s(])_([^_\n]+)_(?=[\s.,!?)]|$)/g;
const LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

/** The same body as readable plain text, for the text/plain MIME part. */
export function formatEmailText(body: string): string {
  return body
    .replace(/\r\n/g, "\n")
    .replace(BOLD, "$1")
    .replace(ITALIC_STAR, "$1$2")
    .replace(ITALIC_UNDERSCORE, "$1$2")
    .replace(LINK, "$1 ($2)")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function inlineHtml(text: string): string {
  return escapeEmailHtml(text)
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" style="color:#1a5b3a;text-decoration:underline;">$1</a>',
    )
    .replace(BOLD, "<strong>$1</strong>")
    .replace(ITALIC_STAR, "$1<em>$2</em>")
    .replace(ITALIC_UNDERSCORE, "$1<em>$2</em>");
}

/**
 * Convert a stored body into inline-styled HTML. Paragraphs are blocks
 * separated by a blank line; a block made only of `- ` lines becomes a list.
 */
export function formatEmailHtml(body: string): string {
  const blocks = body
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks
    .map((block) => {
      const lines = block.split("\n");
      if (lines.every((line) => /^[-*•]\s+/.test(line.trim()))) {
        const items = lines
          .map(
            (line) =>
              `<li style="margin:0 0 6px;">${inlineHtml(line.trim().replace(/^[-*•]\s+/, ""))}</li>`,
          )
          .join("");
        return `<ul style="margin:0 0 14px;padding-left:22px;">${items}</ul>`;
      }
      return `<p style="margin:0 0 14px;">${lines
        .map((line) => inlineHtml(line))
        .join("<br />")}</p>`;
    })
    .join("");
}

/** Wraps formatted body HTML in the document a recipient's client renders. */
export function wrapEmailHtml(body: string, extraHtml = ""): string {
  return `<!doctype html><html><body style="margin:0;padding:0;"><div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;color:#1c1d1a;max-width:640px;">${formatEmailHtml(
    body,
  )}</div>${extraHtml}</body></html>`;
}

/**
 * Append the account-wide footer saved in Settings to an outgoing body.
 *
 * Applied at dispatch time so it lands on every email — initial, follow-up and
 * reply — without the AI ever rewriting it and without it being stored twice in
 * a draft. `[Label](https://…)` links inside the footer are rendered by the same
 * formatter as the body, in both the text/plain and text/html parts.
 */
export function applyEmailFooter(body: string, footer: string): string {
  const cleanFooter = (footer ?? "").replace(/\r\n/g, "\n").trim();
  if (!cleanFooter) return body;

  const cleanBody = (body ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
  if (!cleanBody) return cleanFooter;
  if (cleanBody.endsWith(cleanFooter)) return cleanBody;

  return `${cleanBody}\n\n${cleanFooter}`;
}
