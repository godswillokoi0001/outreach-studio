"use client";

import { invalidateDataCache } from "./db-client";
import { clearWorkspaceToken } from "./workspace-token";

const LAST_OWNER_SESSION_KEY = "os:active-owner-id";
const SAFE_GLOBAL_KEYS = new Set(["knowrevo:theme"]);

export const ACCOUNT_SWITCHED_EVENT = "os:account-switched";

/**
 * Removes every browser-cached piece of user data (tokens, table caches,
 * localStorage drafts/chats/provider lists, and sessionStorage) on logout or
 * when a different account signs in inside the same browser profile.
 */
export function clearAllAccountClientData(): void {
  clearWorkspaceToken();
  invalidateDataCache();

  if (typeof window === "undefined") return;

  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (!k) continue;
      if (SAFE_GLOBAL_KEYS.has(k)) continue;
      if (
        k.startsWith("os:") ||
        k.startsWith("knowrevo:") ||
        k.startsWith("outreach-") ||
        k.startsWith("operator-") ||
        k.startsWith("sb-") // ignore Supabase managed tokens only if called AFTER signOut; we preserve non-app unrelated keys
      ) {
        if (!k.startsWith("sb-")) keysToRemove.push(k);
      } else if (
        k === "reply_drafts" ||
        k === "recent_geo" ||
        k.includes("reply_draft") ||
        k.includes("signal") ||
        k.includes("provider") ||
        k.includes("operator") ||
        k.includes("onboarding")
      ) {
        keysToRemove.push(k);
      }
    }
    for (const k of keysToRemove) {
      window.localStorage.removeItem(k);
    }
  } catch {
    /* ignore storage unavailable */
  }

  try {
    window.sessionStorage.clear();
  } catch {
    /* ignore */
  }

  try {
    window.dispatchEvent(new Event(ACCOUNT_SWITCHED_EVENT));
  } catch {
    /* ignore */
  }
}

export function syncActiveOwnerSessionMarker(ownerId: string | null): { switched: boolean } {
  if (typeof window === "undefined") return { switched: false };
  try {
    const prev = window.sessionStorage.getItem(LAST_OWNER_SESSION_KEY);
    if (!ownerId) {
      if (prev) {
        clearAllAccountClientData();
      }
      window.sessionStorage.removeItem(LAST_OWNER_SESSION_KEY);
      return { switched: Boolean(prev) };
    }
    if (prev && prev !== ownerId) {
      clearAllAccountClientData();
      window.sessionStorage.setItem(LAST_OWNER_SESSION_KEY, ownerId);
      return { switched: true };
    }
    window.sessionStorage.setItem(LAST_OWNER_SESSION_KEY, ownerId);
    return { switched: false };
  } catch {
    return { switched: false };
  }
}
