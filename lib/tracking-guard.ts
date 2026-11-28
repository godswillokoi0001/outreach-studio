/**
 * Open-tracking sanity guards.
 *
 * A pixel that fires on the sender's own preview, on Gmail's immediate
 * Sent-folder render, or on a mail-gateway link scanner produces fake opens
 * that make the pipeline look healthier than it is. These pure helpers decide
 * whether a hit is a real recipient open before anything is written.
 */

import { createHash } from "node:crypto";

/** The logged-in sender's own browser always carries a Supabase auth cookie. */
export const AUTH_COOKIE_PATTERN = /^sb-.*-auth-token(?:\.\d+)?$/i;

export function hasSenderSessionCookie(cookieNames: string[]): boolean {
  return cookieNames.some((name) => AUTH_COOKIE_PATTERN.test(name.trim()));
}

const PREFETCH_HEADERS = ["sec-purpose", "purpose", "x-purpose", "x-moz"];

export function isPrefetchRequest(headers: { get(name: string): string | null }): boolean {
  for (const name of PREFETCH_HEADERS) {
    const value = (headers.get(name) ?? "").toLowerCase();
    if (value.includes("prefetch") || value.includes("prerender") || value.includes("preview")) {
      return true;
    }
  }
  const cacheControl = (headers.get("cache-control") ?? "").toLowerCase();
  return cacheControl.includes("no-cache") && (headers.get("purpose") ?? "").length > 0;
}

const BOT_PATTERN =
  /googleimageproxy|ggpht|google-?proxy|googlebot|bingpreview|bingbot|yahoo!?\s?slurp|outlook-?image|microsoft\s?preview|barracuda|proofpoint|mimecast|symantec|messagelabs|sophos|forcepoint|fireeye|cloudmark|spamhaus|bitdefender|kaspersky|mailchimp|sendgrid|postmark|mandrill|amazonses|bot\b|spider|crawler|scanner|preview/i;

export function isScannerUserAgent(userAgent: string | null | undefined): boolean {
  const ua = (userAgent ?? "").trim();
  if (!ua) return false;
  return BOT_PATTERN.test(ua);
}

export function hashSenderIp(ip: string | null | undefined, salt = process.env.TRACKING_IP_SALT ?? "knowrevo-open"): string | null {
  const clean = (ip ?? "").split(",")[0].trim();
  if (!clean) return null;
  return createHash("sha256").update(`${salt}:${clean}`).digest("hex").slice(0, 40);
}

/** First usable client IP from the proxy chain. */
export function clientIpFromHeaders(headers: { get(name: string): string | null }): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || headers.get("cf-connecting-ip")?.trim() || null;
}

export const IMMEDIATE_OPEN_GRACE_MS = 20_000;

export interface OpenDecisionInput {
  cookieNames: string[];
  headers: { get(name: string): string | null };
  userAgent?: string | null;
  sentAt?: string | null;
  senderIpHash?: string | null;
  requestIpHash?: string | null;
  now?: number;
}

export interface OpenDecision {
  record: boolean;
  reason?: "sender_session" | "prefetch" | "scanner" | "too_soon" | "same_ip";
}

/** Single source of truth for "is this a real open?". */
export function decideOpen(input: OpenDecisionInput): OpenDecision {
  if (hasSenderSessionCookie(input.cookieNames)) {
    return { record: false, reason: "sender_session" };
  }
  if (isPrefetchRequest(input.headers)) {
    return { record: false, reason: "prefetch" };
  }
  if (isScannerUserAgent(input.userAgent)) {
    return { record: false, reason: "scanner" };
  }
  if (input.sentAt) {
    const sentMs = Date.parse(input.sentAt);
    if (Number.isFinite(sentMs) && (input.now ?? Date.now()) - sentMs < IMMEDIATE_OPEN_GRACE_MS) {
      return { record: false, reason: "too_soon" };
    }
  }
  if (input.senderIpHash && input.requestIpHash && input.senderIpHash === input.requestIpHash) {
    return { record: false, reason: "same_ip" };
  }
  return { record: true };
}
