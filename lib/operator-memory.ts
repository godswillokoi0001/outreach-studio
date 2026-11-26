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
}

const MEMORY_LIMIT = 200;

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
  });
}

/** Forget one conversation. */
export async function deleteOperatorMemory(uid: string, id: string): Promise<void> {
  await deleteDoc(doc(db, `${memoryPath(uid)}/${id}`));
}

/** Forget everything. This is the only destructive path, and the user starts it. */
export async function clearOperatorMemory(uid: string): Promise<void> {
  const records = await loadOperatorMemory(uid);
  await Promise.all(records.map((record) => deleteDoc(doc(db, `${memoryPath(uid)}/${record.id}`))));
}
