"use client";

import { collection, deleteDoc, doc, getDocs, setDoc, db } from "./db-client";

/**
 * The operator's long-term memory, stored in Supabase rather than one browser.
 *
 * Every conversation keeps its messages and the model's own tool history
 * (`contents`), so the bot can recall what it was asked and what it actually
 * did. Memory is only removed when the user clears it or deletes a
 * conversation.
 */
export interface OperatorMemoryRecord {
  id: string;
  title: string;
  mode: string;
  model?: string;
  providerId?: string;
  messages: unknown[];
  contents: unknown[];
  createdAt: number;
  updatedAt: number;
  startedAt?: number | null;
  endedAt?: number | null;
  durationSeconds?: number;
}

const MEMORY_LIMIT = 200;

/** Fired after any memory write, so open panels can refresh their numbers. */
export const OPERATOR_MEMORY_CHANGED = "os:operator-memory-changed";
/** Fired when the user clears every conversation, so every open operator resets. */
export const OPERATOR_MEMORY_CLEARED = "os:operator-memory-cleared";

function announce(event: string): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(event));
}

function memoryPath(uid: string): string {
  return `users/${uid}/operatorMemory`;
}

function toMillis(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

/** Every saved conversation for this account, newest first. */
export async function loadOperatorMemory(uid: string): Promise<OperatorMemoryRecord[]> {
  const snapshot = await getDocs(collection(db, memoryPath(uid)), {
    order: "updated_at.desc",
    limit: MEMORY_LIMIT,
    force: true,
  });

  return snapshot.docs.map((entry) => {
    const row = entry.data();
    const mode = typeof row.mode === "string" ? row.mode : "agent";
    return {
      id: entry.id,
      title: typeof row.title === "string" && row.title.trim() ? row.title : "Conversation",
      mode,
      model: typeof row.model === "string" ? row.model : undefined,
      providerId: typeof row.providerId === "string" ? row.providerId : undefined,
      messages: Array.isArray(row.messages) ? row.messages : [],
      contents: Array.isArray(row.contents) ? row.contents : [],
      createdAt: toMillis(row.createdAt, Date.now()),
      updatedAt: toMillis(row.updatedAt, Date.now()),
      startedAt: row.startedAt || row.started_at ? toMillis(row.startedAt ?? row.started_at, Date.now()) : null,
      endedAt: row.endedAt || row.ended_at ? toMillis(row.endedAt ?? row.ended_at, Date.now()) : null,
      durationSeconds:
        typeof (row.durationSeconds ?? row.duration_seconds) === "number"
          ? Math.max(0, Math.round(Number(row.durationSeconds ?? row.duration_seconds)))
          : 0,
    };
  });
}

/** Create or update one conversation's memory row. */
export async function saveOperatorMemory(
  uid: string,
  record: OperatorMemoryRecord,
): Promise<void> {
  await setDoc(doc(db, `${memoryPath(uid)}/${record.id}`), {
    title: record.title.slice(0, 200),
    mode: record.mode,
    model: record.model ?? "",
    provider_id: record.providerId ?? "",
    messages: record.messages,
    contents: record.contents,
    created_at: new Date(record.createdAt).toISOString(),
    updated_at: new Date(record.updatedAt).toISOString(),
    ...(record.startedAt ? { started_at: new Date(record.startedAt).toISOString() } : {}),
    ...(record.endedAt ? { ended_at: new Date(record.endedAt).toISOString() } : { ended_at: null }),
    duration_seconds: Math.max(0, Math.round(record.durationSeconds ?? 0)),
  });
  announce(OPERATOR_MEMORY_CHANGED);
}

/** Forget one conversation. */
export async function deleteOperatorMemory(uid: string, id: string): Promise<void> {
  await deleteDoc(doc(db, `${memoryPath(uid)}/${id}`));
  announce(OPERATOR_MEMORY_CHANGED);
}

/** Forget everything. This is the only destructive path, and the user starts it. */
export async function clearOperatorMemory(uid: string): Promise<void> {
  const records = await loadOperatorMemory(uid);
  await Promise.all(records.map((record) => deleteDoc(doc(db, `${memoryPath(uid)}/${record.id}`))));
  announce(OPERATOR_MEMORY_CHANGED);
  announce(OPERATOR_MEMORY_CLEARED);
}
