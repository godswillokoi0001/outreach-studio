/**
 * Deliverability-safe outgoing email wrapper.
 *
 * Plain inline CSS, a 600px column, system fonts and no newsletter chrome:
 * the kind of message that stays in Gmail's Primary tab. Signature links are
 * rendered as email-client-safe <table>/<a>/<img> badges, never <svg> (Gmail
 * and Outlook strip SVG), using the hosted PNGs in public/icons/email.
 */

import { escapeEmailHtml, formatEmailHtml, formatEmailText } from "./email-format";

export type EmailTemplateStyle = "plain_personal" | "executive_clean" | "accent_bar";

export const EMAIL_TEMPLATE_OPTIONS: { id: EmailTemplateStyle; label: string; blurb: string }[] = [
  { id: "plain_personal", label: "Plain Personal", blurb: "Bare text and clean links. Reads like a one-to-one note." },
  { id: "executive_clean", label: "Executive Clean", blurb: "Crisp type, a hairline divider and icon links. Recommended." },
  { id: "accent_bar", label: "Accent Bar", blurb: "A slim accent bar beside the signature block." },
];

export function normalizeEmailTemplate(raw: unknown): EmailTemplateStyle {
  return raw === "plain_personal" || raw === "accent_bar" ? raw : "executive_clean";
}

export type SignatureIcon = "globe" | "linkedin" | "x" | "github" | "instagram" | "calendar" | "mail";

export interface SignatureLink {
  label: string;
  url: string;
  icon: SignatureIcon;
}

export function iconForUrl(url: string, label = ""): SignatureIcon {
  const clean = url.toLowerCase();
  const text = label.toLowerCase();
  if (clean.startsWith("mailto:") || text.includes("email")) return "mail";
  if (/linkedin\.com/.test(clean)) return "linkedin";
  if (/(?:^|\/\/)(?:www\.)?(?:x\.com|twitter\.com)/.test(clean)) return "x";
  if (/github\.com/.test(clean)) return "github";
  if (/instagram\.com/.test(clean)) return "instagram";
  if (/calendly|cal\.com|calendar|booking|savvycal|tidycal/.test(clean)) return "calendar";
  return "globe";
}

/** Only http(s), mailto and tel survive into an email href. */
export function safeEmailUrl(raw: string): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  if (/^(?:https?:\/\/|mailto:|tel:)/i.test(value)) return value;
  if (/^www\./i.test(value)) return `https://${value}`;
  return null;
}

const MARKDOWN_LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const BARE_URL = /\bhttps?:\/\/[^\s<>"')]+/gi;

export function signatureLinksFromText(text: string): SignatureLink[] {
  const links: SignatureLink[] = [];
  const seen = new Set<string>();
  const push = (label: string, rawUrl: string) => {
    const url = safeEmailUrl(rawUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);
    links.push({ label: label.trim() || url.replace(/^https?:\/\//, ""), url, icon: iconForUrl(url, label) });
  };

  for (const match of (text ?? "").matchAll(MARKDOWN_LINK)) {
    push(match[1] ?? "", match[2] ?? "");
  }
  for (const match of (text ?? "").matchAll(BARE_URL)) {
    push("", match[0] ?? "");
  }
  return links.slice(0, 7);
}

/**
 * Icon + label badge. A table keeps Gmail/Outlook from collapsing the image
 * and text onto separate lines. `alt` is the fallback when images are blocked.
 */
export function renderSignatureLinksHtml(
  links: SignatureLink[],
  appUrl: string,
  accentColor = "#1F2937",
): string {
  if (links.length === 0) return "";
  const base = (appUrl || "").replace(/\/$/, "");
  const cells = links
    .map((link) => {
      const href = safeEmailUrl(link.url);
      if (!href) return "";
      const src = `${base}/icons/email/${link.icon}.png`;
      return `<td style="padding:0 14px 0 0;vertical-align:middle;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="padding:0 6px 0 0;vertical-align:middle;"><a href="${escapeEmailHtml(href)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;"><img src="${escapeEmailHtml(src)}" width="16" height="16" alt="${escapeEmailHtml(link.label)}" style="display:block;width:16px;height:16px;border:0;outline:none;text-decoration:none;" /></a></td>
    <td style="vertical-align:middle;"><a href="${escapeEmailHtml(href)}" target="_blank" rel="noopener noreferrer" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;color:${accentColor};text-decoration:none;">${escapeEmailHtml(link.label)}</a></td>
  </tr></table>
</td>`;
    })
    .filter(Boolean)
    .join("");
  if (!cells) return "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0 0;"><tr>${cells}</tr></table>`;
}

export interface OutgoingEmailInput {
  body: string;
  footer?: string;
  template?: EmailTemplateStyle | string;
  appUrl?: string;
  senderName?: string;
  senderRole?: string;
  senderCompany?: string;
}

/** The signature block for the chosen template (HTML only). */
function renderSignature(input: OutgoingEmailInput, links: SignatureLink[], appUrl: string): string {
  const style = normalizeEmailTemplate(input.template);
  if (style === "plain_personal") {
    return renderSignatureLinksHtml(links, appUrl);
  }

  const name = (input.senderName ?? "").trim();
  const role = (input.senderRole ?? "").trim();
  const company = (input.senderCompany ?? "").trim();
  const identity = [name, role && company ? `${role}, ${company}` : role || company]
    .filter(Boolean)
    .map((line) => `<div style="font-size:14px;line-height:1.5;color:#111827;">${escapeEmailHtml(line)}</div>`)
    .join("");

  if (style === "accent_bar") {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;"><tr>
  <td style="width:3px;background:#111827;border-radius:2px;">&nbsp;</td>
  <td style="padding-left:14px;">${identity}${renderSignatureLinksHtml(links, appUrl)}</td>
</tr></table>`;
  }

  return `<div style="margin-top:22px;padding-top:14px;border-top:1px solid #E5E7EB;">${identity}${renderSignatureLinksHtml(
    links,
    appUrl,
  )}</div>`;
}

/** Full HTML document for an outgoing message. */
export function buildOutgoingEmailHtml(input: OutgoingEmailInput): string {
  const appUrl = (input.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  const links = signatureLinksFromText(input.footer ?? "");
  const bodyHtml = formatEmailHtml(input.body ?? "");
  const signature = renderSignature(input, links, appUrl);

  return `<!doctype html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /></head>
<body style="margin:0;padding:0;background:#ffffff;">
<div style="max-width:600px;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1F2937;">
${bodyHtml}${signature}
</div>
</body></html>`;
}

/** Plain-text twin: markdown links become `Label: url`, never raw brackets. */
export function buildOutgoingEmailText(input: OutgoingEmailInput): string {
  const body = (input.body ?? "").replace(/\r\n/g, "\n").trim();
  const footer = (input.footer ?? "").replace(/\r\n/g, "\n").trim();
  const combined = footer ? `${body}\n\n${footer}` : body;
  return formatEmailText(combined);
}
