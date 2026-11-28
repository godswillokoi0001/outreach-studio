"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Session-scoped page state.
 *
 * Navigating between screens unmounts them, which used to lose filters,
 * pagination, the open review drawer and unsaved drafts. This hook mirrors a
 * value into sessionStorage so coming back restores exactly where the user
 * was — and does it without touching a server or throwing on quota errors.
 */

const PREFIX = "knowrevo:page:";

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readPageState<T>(key: string, fallback: T): T {
  const store = storage();
  if (!store) return fallback;
  try {
    const raw = store.getItem(PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writePageState<T>(key: string, value: T, maxChars = 120_000): void {
  const store = storage();
  if (!store) return;
  try {
    const raw = JSON.stringify(value);
    if (raw.length > maxChars) return;
    store.setItem(PREFIX + key, raw);
  } catch {
    /* quota or serialization failure: state persistence is best-effort */
  }
}

export function clearPageState(key: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

/** Remove every persisted page value (optionally only one route prefix). */
export function clearAllPageState(route?: string): void {
  const store = storage();
  if (!store) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key && key.startsWith(PREFIX) && (!route || key.startsWith(PREFIX + route))) {
        keys.push(key);
      }
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    /* ignore */
  }
}

type Setter<T> = (value: T | ((previous: T) => T)) => void;

export function usePersistedPageState<T>(
  key: string,
  initial: T,
): [T, Setter<T>, () => void] {
  const [value, setValue] = useState<T>(() =>
    typeof window === "undefined" ? initial : readPageState(key, initial),
  );

  useEffect(() => {
    writePageState(key, value);
  }, [key, value]);

  const update = useCallback<Setter<T>>((next) => {
    setValue((previous) => (typeof next === "function" ? (next as (p: T) => T)(previous) : next));
  }, []);

  const reset = useCallback(() => {
    clearPageState(key);
    setValue(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return [value, update, reset];
}

// ---------------------------------------------------------------------------
// Email drafts: unsaved subject/body/instructions survive navigation and are
// dropped the moment the message is saved or approved.
// ---------------------------------------------------------------------------

export interface EmailDraft {
  subject: string;
  body: string;
  instructions?: string;
}

const draftKey = (emailId: string) => `review:draft:${emailId}`;

export function readEmailDraft(emailId: string): EmailDraft | null {
  return readPageState<EmailDraft | null>(draftKey(emailId), null);
}

export function writeEmailDraft(emailId: string, draft: EmailDraft): void {
  writePageState(draftKey(emailId), draft);
}

export function clearEmailDraft(emailId: string): void {
  clearPageState(draftKey(emailId));
}
