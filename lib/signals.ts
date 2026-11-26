"use client";

/**
 * Per-account "what has already been announced / already been looked at" marks
 * for the two ambient signals: an email was opened, and a prospect replied.
 *
 * They live in the browser (one key per account) because they describe what
 * this person has seen, not workspace data. Each signal keeps two marks:
 *
 *   `${kind}_notified` — a toast has already been shown for activity up to here
 *   `${kind}_seen`     — the screen that lists that activity was opened
 *
 * So a signal is announced exactly once, stays "new" in the notification menu
 * until its screen is visited, and a later event raises it again.
 */
export type SignalKind = "open" | "reply";

export interface SignalMarks {
  open_seen: string;
  open_notified: string;
  reply_seen: string;
  reply_notified: string;
}

/** Fired on this window after the marks change, so open panels re-read them. */
export const SIGNALS_CHANGED = "os:signals-changed";

function storageKey(uid: string): string {
  return `os:signals:${uid}`;
}

/** Marks for a first visit: everything already in the database counts as seen. */
export function emptySignalMarks(at = new Date().toISOString()): SignalMarks {
  return { open_seen: at, open_notified: at, reply_seen: at, reply_notified: at };
}

export function readSignalMarks(uid: string): SignalMarks | null {
  if (typeof window === "undefined" || !uid) return null;
  try {
    const raw = window.localStorage.getItem(storageKey(uid));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SignalMarks>;
    const base = emptySignalMarks("");
    return {
      open_seen: String(parsed.open_seen ?? base.open_seen),
      open_notified: String(parsed.open_notified ?? base.open_notified),
      reply_seen: String(parsed.reply_seen ?? base.reply_seen),
      reply_notified: String(parsed.reply_notified ?? base.reply_notified),
    };
  } catch {
    return null;
  }
}

export function writeSignalMarks(uid: string, marks: SignalMarks): SignalMarks {
  if (typeof window === "undefined" || !uid) return marks;
  try {
    window.localStorage.setItem(storageKey(uid), JSON.stringify(marks));
  } catch {
    /* storage unavailable: notifications still work for this session */
  }
  window.dispatchEvent(new CustomEvent(SIGNALS_CHANGED, { detail: { uid } }));
  return marks;
}

/**
 * Cached snapshot for `useSyncExternalStore`. React requires the same object
 * back until the stored value actually changes, and reads localStorage on every
 * render otherwise.
 */
let snapshot: { uid: string; raw: string | null; value: SignalMarks | null } = {
  uid: "",
  raw: null,
  value: null,
};

export function getSignalMarks(uid: string): SignalMarks | null {
  if (typeof window === "undefined" || !uid) return null;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(storageKey(uid));
  } catch {
    raw = null;
  }
  if (snapshot.uid === uid && snapshot.raw === raw) return snapshot.value;
  const value = readSignalMarks(uid);
  snapshot = { uid, raw, value };
  return value;
}

/** Re-read the marks when this tab (or another tab) changes them. */
export function subscribeSignalMarks(uid: string, onChange: () => void): () => void {
  if (typeof window === "undefined" || !uid) return () => {};
  const onSignal = (event: Event) => {
    const detail = (event as CustomEvent<{ uid?: string }>).detail;
    if (!detail?.uid || detail.uid === uid) onChange();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === storageKey(uid)) onChange();
  };
  window.addEventListener(SIGNALS_CHANGED, onSignal);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(SIGNALS_CHANGED, onSignal);
    window.removeEventListener("storage", onStorage);
  };
}

/** Advance one mark to `at`, never backwards. Returns the resulting snapshot. */
export function markSignal(
  uid: string,
  kind: SignalKind,
  mark: "seen" | "notified",
  at = new Date().toISOString(),
): SignalMarks {
  const current = readSignalMarks(uid) ?? emptySignalMarks("");
  const field = `${kind}_${mark}` as keyof SignalMarks;
  if (!at || at <= current[field]) return current;
  return writeSignalMarks(uid, { ...current, [field]: at });
}

/** True when `latest` happened after the user last looked at that screen. */
export function isSignalNew(
  marks: SignalMarks | null,
  kind: SignalKind,
  latest: string,
): boolean {
  if (!marks || !latest) return false;
  return latest > marks[`${kind}_seen`];
}
