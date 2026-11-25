"use client";

import { getAccessToken } from "./auth";

/**
 * The app's data access layer, backed by Supabase through the authenticated
 * `/api/data` route.
 *
 * Every read and write is owner-scoped on the server from the verified session;
 * nothing here sends an owner id the browser could forge.
 */

export const db = { name: "supabase" } as const;

export enum OperationType {
  CREATE = "create",
  UPDATE = "update",
  DELETE = "delete",
  LIST = "list",
  GET = "get",
  WRITE = "write",
}

export interface DataErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: { userId?: string | null; email?: string | null };
}

export function handleDataError(
  error: unknown,
  operationType: OperationType,
  path: string | null,
): never {
  const errInfo: DataErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    operationType,
    path,
    authInfo: {},
  };
  console.error("Data layer error:", JSON.stringify(errInfo));
  throw new Error(errInfo.error);
}

/** A timestamp value kept for callers that build dates explicitly. */
export class Timestamp {
  private readonly ms: number;
  constructor(ms: number) {
    this.ms = ms;
  }
  toDate(): Date {
    return new Date(this.ms);
  }
  static now(): Timestamp {
    return new Timestamp(Date.now());
  }
  static fromDate(date: Date): Timestamp {
    return new Timestamp(date.getTime());
  }
}

const SERVER_TIMESTAMP = "__server_timestamp__";

/** Marker resolved to the current time when the write is sent. */
export function serverTimestamp(): unknown {
  return { [SERVER_TIMESTAMP]: true };
}

export interface DocumentReference {
  readonly kind: "doc";
  readonly table: string;
  readonly id: string;
  readonly path: string;
}

export interface CollectionReference {
  readonly kind: "collection";
  readonly table: string;
  readonly path: string;
}

export interface QueryConstraint {
  readonly kind: "where";
}

export interface DocumentSnapshot {
  readonly id: string;
  readonly ref: DocumentReference;
  exists(): boolean;
  data(): Record<string, unknown>;
}

export interface QuerySnapshot {
  readonly docs: DocumentSnapshot[];
  readonly empty: boolean;
}

const TABLE_BY_COLLECTION: Record<string, string> = {
  campaigns: "campaigns",
  leads: "leads",
  messages: "messages",
  replies: "replies",
  suppressions: "suppressions",
  sendLogs: "send_logs",
  auditLogs: "audit_logs",
  leadEvents: "lead_events",
  knowledge: "knowledge",
  knowledgeSources: "knowledge_sources",
  tracking: "email_opens",
};

function tableForCollection(name: string): string {
  const table = TABLE_BY_COLLECTION[name];
  if (!table) throw new Error(`Unknown data collection: ${name}`);
  return table;
}

/** `users/{uid}/leads/{id}` and `tracking` both resolve to a table. */
function resolvePath(rawPath: string): { table: string; id?: string } {
  const parts = rawPath.split("/").filter(Boolean);
  const scoped = parts[0] === "users" ? parts.slice(2) : parts;
  if (scoped.length === 0) throw new Error(`Unsupported data path: ${rawPath}`);
  return { table: tableForCollection(scoped[0]), id: scoped[1] };
}

const TO_SNAKE: Record<string, string> = {
  ownerId: "owner_id",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

const TO_CAMEL: Record<string, string> = {
  owner_id: "ownerId",
  created_at: "createdAt",
  updated_at: "updatedAt",
};

function encodeValues(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const column = TO_SNAKE[key] ?? key;
    if (value && typeof value === "object" && SERVER_TIMESTAMP in (value as Record<string, unknown>)) {
      out[column] = new Date().toISOString();
    } else if (value instanceof Timestamp) {
      out[column] = value.toDate().toISOString();
    } else {
      out[column] = value;
    }
  }
  return out;
}

function decodeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[TO_CAMEL[key] ?? key] = value;
  }
  return out;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new Error("Sign in with Google to continue.");

  const res = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
    credentials: "same-origin",
  });

  const text = await res.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    const message =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `Request failed (HTTP ${res.status}).`;
    throw new Error(message);
  }
  return parsed as T;
}

export function collection(_database: unknown, path: string): CollectionReference {
  const { table } = resolvePath(path);
  return { kind: "collection", table, path };
}

export function doc(_database: unknown, ...segments: string[]): DocumentReference {
  const path = segments.join("/");
  const { table, id } = resolvePath(path);
  if (!id) throw new Error(`A document id is required for ${path}`);
  return { kind: "doc", table, id, path };
}

export function where(field: string, op: string, value: unknown): QueryConstraint {
  void field;
  void op;
  void value;
  return { kind: "where" };
}

export function query(ref: CollectionReference, ...constraints: QueryConstraint[]): CollectionReference {
  void constraints;
  return ref;
}

export async function getDocs(ref: CollectionReference): Promise<QuerySnapshot> {
  const data = await api<{ rows?: Record<string, unknown>[] }>(
    `/api/data?table=${encodeURIComponent(ref.table)}`,
  );
  const docs = (data.rows ?? []).map((row) => {
    const id = String(row.id ?? "");
    return {
      id,
      ref: { kind: "doc" as const, table: ref.table, id, path: `${ref.path}/${id}` },
      exists: () => true,
      data: () => decodeRow(row),
    };
  });
  return { docs, empty: docs.length === 0 };
}

export async function getDoc(ref: DocumentReference): Promise<DocumentSnapshot> {
  const data = await api<{ row?: Record<string, unknown> | null }>(
    `/api/data?table=${encodeURIComponent(ref.table)}&id=${encodeURIComponent(ref.id)}`,
  );
  const row = data.row ?? null;
  return {
    id: ref.id,
    ref,
    exists: () => row !== null,
    data: () => (row ? decodeRow(row) : {}),
  };
}

export async function setDoc(ref: DocumentReference, values: Record<string, unknown>): Promise<void> {
  await api(`/api/data?table=${encodeURIComponent(ref.table)}`, {
    method: "POST",
    body: JSON.stringify({ id: ref.id, values: encodeValues(values) }),
  });
}

export async function updateDoc(ref: DocumentReference, values: Record<string, unknown>): Promise<void> {
  await api(
    `/api/data?table=${encodeURIComponent(ref.table)}&id=${encodeURIComponent(ref.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ values: encodeValues(values) }),
    },
  );
}

export async function deleteDoc(ref: DocumentReference): Promise<void> {
  await api(
    `/api/data?table=${encodeURIComponent(ref.table)}&id=${encodeURIComponent(ref.id)}`,
    { method: "DELETE" },
  );
}

export interface WriteBatch {
  set(ref: DocumentReference, values: Record<string, unknown>): void;
  update(ref: DocumentReference, values: Record<string, unknown>): void;
  delete(ref: DocumentReference): void;
  commit(): Promise<void>;
}

export function writeBatch(_database: unknown): WriteBatch {
  void _database;
  const ops: { type: "upsert" | "delete"; id: string; values: Record<string, unknown> }[] = [];
  let table: string | null = null;

  const track = (ref: DocumentReference) => {
    if (table === null) table = ref.table;
    return table === ref.table;
  };

  return {
    set(ref, values) {
      if (!track(ref)) throw new Error("A batch cannot mix tables.");
      ops.push({ type: "upsert", id: ref.id, values: encodeValues(values) });
    },
    update(ref, values) {
      if (!track(ref)) throw new Error("A batch cannot mix tables.");
      ops.push({ type: "upsert", id: ref.id, values: encodeValues(values) });
    },
    delete(ref) {
      if (!track(ref)) throw new Error("A batch cannot mix tables.");
      ops.push({ type: "delete", id: ref.id, values: {} });
    },
    async commit() {
      if (table === null || ops.length === 0) return;
      await api(`/api/data?table=${encodeURIComponent(table)}`, {
        method: "POST",
        body: JSON.stringify({ ops }),
      });
    },
  };
}

/**
 * Supabase keeps no client subscriptions here, so these collections are polled.
 * The interval is deliberately calm: the dashboard also reloads on focus and the
 * send/reply runners refresh explicitly after they act.
 */
const POLL_INTERVAL_MS = 15_000;

export function onSnapshot(
  ref: CollectionReference,
  next: (snapshot: QuerySnapshot) => void,
  error?: (err: Error) => void,
): () => void {
  let active = true;

  const tick = async () => {
    try {
      const snapshot = await getDocs(ref);
      if (active) next(snapshot);
    } catch (err) {
      if (active) error?.(err instanceof Error ? err : new Error(String(err)));
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);

  return () => {
    active = false;
    clearInterval(timer);
  };
}
