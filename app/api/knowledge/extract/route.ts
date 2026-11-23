import { NextRequest, NextResponse } from "next/server";
import { inflateRawSync, inflateSync } from "node:zlib";
import { handleApiError } from "@/lib/api-helpers";
import { verifyFirebaseRequest } from "@/lib/firebase-server-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_CHARS = 700_000;

function decodePdfString(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) break;
    if (next === "n") { out += "\n"; i += 1; continue; }
    if (next === "r") { out += "\r"; i += 1; continue; }
    if (next === "t") { out += "\t"; i += 1; continue; }
    if (next === "b") { out += "\b"; i += 1; continue; }
    if (next === "f") { out += "\f"; i += 1; continue; }
    if (next === "(" || next === ")" || next === "\\") { out += next; i += 1; continue; }
    if (next === "\n") { i += 1; continue; }
    if (/[0-7]/.test(next)) {
      let oct = "";
      let j = i + 1;
      while (j < raw.length && oct.length < 3 && /[0-7]/.test(raw[j])) {
        oct += raw[j];
        j += 1;
      }
      out += String.fromCharCode(parseInt(oct, 8));
      i = j - 1;
      continue;
    }
    out += next;
    i += 1;
  }
  return out;
}

function decodeHexString(hex: string): string {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, "");
  if (!clean) return "";
  const bytes: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) {
    bytes.push(parseInt(clean.slice(i, i + 2), 16));
  }
  // PDF text strings are commonly PDFDocEncoding (≈ latin1); UTF-16BE has a BOM.
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    }
    return out;
  }
  return String.fromCharCode(...bytes);
}

/** Pulls visible text out of a PDF content stream (Tj / TJ / ' / " operators). */
function textFromContentStream(stream: string): string {
  const token = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>|T[dD]|T\*|Tj|TJ|'|"|ET/g;
  let out = "";
  let pending = "";
  let match: RegExpExecArray | null;

  const flushWord = () => {
    if (pending.trim()) out += pending;
    pending = "";
  };

  while ((match = token.exec(stream)) !== null) {
    const value = match[0];
    if (value.startsWith("(")) {
      pending += decodePdfString(value.slice(1, -1));
    } else if (value.startsWith("<")) {
      pending += decodeHexString(value.slice(1, -1));
    } else if (value === "Tj" || value === "TJ" || value === "'" || value === '"') {
      flushWord();
    } else {
      flushWord();
      if (!out.endsWith("\n")) out += "\n";
    }
  }
  flushWord();
  return out;
}

function unescapePdfStreams(latin: string): string[] {
  const chunks: string[] = [];
  const re = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(latin)) !== null) {
    const start = match.index + match[0].length;
    const end = latin.indexOf("endstream", start);
    if (end < 0) continue;
    const dictionary = latin.slice(Math.max(0, match.index - 400), match.index);
    const rawBuf = Buffer.from(latin.slice(start, end), "latin1");
    if (/FlateDecode/.test(dictionary)) {
      try {
        chunks.push(inflateSync(rawBuf).toString("latin1"));
        continue;
      } catch {
        try {
          chunks.push(inflateRawSync(rawBuf).toString("latin1"));
          continue;
        } catch {
          /* not actually deflated */
        }
      }
    } else if (!/DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode|Image/.test(dictionary)) {
      chunks.push(rawBuf.toString("latin1"));
    }
    re.lastIndex = end;
  }
  return chunks;
}

function extractPdfText(buffer: Buffer): string {
  const latin = buffer.toString("latin1");
  const chunks = unescapePdfStreams(latin);
  let text = chunks.map(textFromContentStream).join("\n");

  if (text.replace(/\s+/g, "").length < 40) {
    // Some PDFs keep text outside compressed streams; scan the raw file too.
    text = `${text}\n${textFromContentStream(latin)}`;
  }

  return text
    .replace(/\u0000/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "");
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#\d+;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function POST(req: NextRequest) {
  try {
    await verifyFirebaseRequest(req);
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Choose a file to upload." }, { status: 400 });
    }
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: "That file is larger than 12 MB." }, { status: 413 });
    }

    const name = file.name || "Uploaded document";
    const lower = name.toLowerCase();
    const buffer = Buffer.from(await file.arrayBuffer());
    let text = "";
    let kind: "pdf" | "text" = "text";

    if (lower.endsWith(".pdf") || buffer.subarray(0, 5).toString("latin1") === "%PDF-") {
      kind = "pdf";
      text = extractPdfText(buffer);
      if (text.replace(/\s+/g, "").length < 40) {
        return NextResponse.json(
          {
            error:
              "No readable text found. This PDF is probably a scan or image export, which needs OCR. Paste the text as a note instead.",
          },
          { status: 422 },
        );
      }
    } else if (/\.(html?|htm)$/.test(lower) || /\.xml$/.test(lower)) {
      text = stripHtml(buffer.toString("utf8"));
    } else if (/\.(txt|md|markdown|csv|tsv|json|log|rtf)$/.test(lower) || file.type.startsWith("text/")) {
      text = buffer.toString("utf8");
      if (/\.rtf$/.test(lower)) {
        text = text.replace(/\\'([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
        text = text.replace(/\\[a-z]+-?\d* ?/gi, " ").replace(/[{}]/g, " ");
      }
    } else {
      return NextResponse.json(
        { error: "Supported files: PDF, TXT, MD, CSV, JSON, HTML and RTF. For other formats, paste the text." },
        { status: 415 },
      );
    }

    text = text.trim();
    if (!text) {
      return NextResponse.json({ error: "That file appears to be empty." }, { status: 422 });
    }

    const truncated = text.length > MAX_CHARS;
    return NextResponse.json({
      label: name.slice(0, 180),
      kind,
      text: truncated ? text.slice(0, MAX_CHARS) : text,
      characters: Math.min(text.length, MAX_CHARS),
      truncated,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
