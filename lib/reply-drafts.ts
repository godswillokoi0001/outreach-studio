"use client";

/**
 * Reply drafts the user is still writing.
 *
 * Sending a reply already stores the exact text in the database, but an edit in
 * progress lived only in the page's state: leaving Conversations or reloading
 * threw it away. Drafts are mirrored per account in this browser, written on
 * every keystroke, so a half-written answer survives navigation, reloads and a
 * dropped connection. Nothing is sent from here.
 */

const MAX_ENTRIES = 120;
const MAX_BODY = 20000;

type StoredDraft = { body: string; saved_at: string };
type DraftMap = Record<string, StoredDraft>;

function key(uid: string): string {
  return `os:reply-drafts:${uid}`;
}

function readAll(uid: string): DraftMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(key(uid));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: DraftMap = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const body = (value as StoredDraft).body;
      if (typeof body !== "string") continue;
      out[id] = {
        body: body.slice(0, MAX_BODY),
        saved_at: String((value as StoredDraft).saved_at ?? ""),
      };
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(uid: string, map: DraftMap): void {
  if (typeof window === "undefined") return;
  try {
    const entries = Object.entries(map)
      .sort((a, b) => b[1].saved_at.localeCompare(a[1].saved_at))
      .slice(0, MAX_ENTRIES);
    window.localStorage.setItem(key(uid), JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Storage can be full or blocked; the draft still lives in page state.
  }
}

/** Every saved draft for this account, keyed by reply id. */
export function loadReplyDrafts(uid: string): Record<string, string> {
  const all = readAll(uid);
  const out: Record<string, string> = {};
  for (const [id, draft] of Object.entries(all)) out[id] = draft.body;
  return out;
}

/** Mirror one draft. An empty body removes it. */
export function saveReplyDraft(uid: string, replyId: string, body: string): void {
  const all = readAll(uid);
  const trimmed = body.slice(0, MAX_BODY);
  if (!trimmed.trim()) {
    delete all[replyId];
  } else {
    all[replyId] = { body: trimmed, saved_at: new Date().toISOString() };
  }
  writeAll(uid, all);
}

/** Drop a draft once it has been sent (or the user reset it). */
export function clearReplyDraft(uid: string, replyId: string): void {
  const all = readAll(uid);
  if (!all[replyId]) return;
  delete all[replyId];
  writeAll(uid, all);
}
