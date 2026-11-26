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
  operatorMemory: "operator_conversations",
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

/** Provider and database errors arrive as objects; never render "[object Object]". */
function describeApiError(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object" || !("error" in parsed)) return null;
  const value = (parsed as { error: unknown }).error;
  if (typeof value === "string") return value.trim() && value.trim() !== "[object Object]" ? value.trim() : null;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["message", "error_description", "details", "hint", "reason"]) {
      const nested = record[key];
      if (typeof nested === "string" && nested.trim()) return nested.trim();
    }
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
  return null;
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
    throw new Error(describeApiError(parsed) ?? `Request failed (HTTP ${res.status}).`);
  }
  return parsed as T;
}

/**
 * Short-lived client cache.
 *
 * Every screen used to re-read its whole table on each visit, which made
 * navigation slow and burned Supabase disk IO. Reads are now cached per
 * table + column set, concurrent identical reads share one request, and any
 * write drops the cache for that table so the next read is fresh.
 */
export interface ReadOptions {
  /** Return only these columns. */
  columns?: readonly string[];
  /** Server-side ordering, e.g. "created_at.desc". */
  order?: string;
  /** Maximum rows to return. */
  limit?: number;
  /** Skip the cache (pollers use this so they always see new rows). */
  force?: boolean;
  /** How often an `onSnapshot` listener re-reads, in milliseconds. */
  pollMs?: number;
}

interface CacheEntry {
  rows: Record<string, unknown>[];
  at: number;
}

// Long enough that moving between screens never re-reads a table, short enough
// that server-side changes (a send, a sync) show up without a manual reload.
// Every write in this tab clears the affected table immediately.
const CACHE_TTL_MS = 5 * 60_000;
const rowCache = new Map<string, CacheEntry>();
const pendingReads = new Map<string, Promise<Record<string, unknown>[]>>();

function cacheKey(table: string, path: string, options?: ReadOptions): string {
  // The owner is part of the key: two accounts in the same browser must never
  // see each other's cached rows.
  const owner = path.startsWith("users/") ? path.split("/")[1] ?? "" : "shared";
  return `${owner}|${table}|${options?.columns?.join(",") ?? "*"}|${options?.order ?? ""}|${options?.limit ?? ""}`;
}

/** Drops cached rows for a table (all column variants). */
export function invalidateDataCache(table?: string): void {
  if (!table) {
    rowCache.clear();
    return;
  }
  for (const key of Array.from(rowCache.keys())) {
    if (key.split("|")[1] === table) rowCache.delete(key);
  }
}

if (typeof window !== "undefined") {
  // The runners announce real writes; drop the cache so pages do not show
  // the state from before the sync or send.
  window.addEventListener("os:data-refreshed", () => rowCache.clear());
}

function snapshotFromRows(ref: CollectionReference, rows: Record<string, unknown>[]): QuerySnapshot {
  const docs = rows.map((row) => {
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

async function readRows(table: string, options?: ReadOptions): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams({ table });
  if (options?.columns?.length) params.set("columns", options.columns.join(","));
  if (options?.order) params.set("order", options.order);
  if (options?.limit && options.limit > 0) params.set("limit", String(options.limit));
  const data = await api<{ rows?: Record<string, unknown>[] }>(`/api/data?${params.toString()}`);
  return data.rows ?? [];
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

export async function getDocs(ref: CollectionReference, options?: ReadOptions): Promise<QuerySnapshot> {
  const key = cacheKey(ref.table, ref.path, options);
  const cached = rowCache.get(key);
  if (!options?.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return snapshotFromRows(ref, cached.rows);
  }

  const pending = pendingReads.get(key);
  if (pending) return snapshotFromRows(ref, await pending);

  const request = readRows(ref.table, options)
    .then((rows) => {
      rowCache.set(key, { rows, at: Date.now() });
      return rows;
    })
    .finally(() => pendingReads.delete(key));

  pendingReads.set(key, request);
  return snapshotFromRows(ref, await request);
}

export async function getDoc(ref: DocumentReference): Promise<DocumentSnapshot> {
  const key = `${cacheKey(ref.table, ref.path)}|id=${ref.id}`;
  const cached = rowCache.get(key);
  let row: Record<string, unknown> | null;
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    row = cached.rows[0] ?? null;
  } else {
    const data = await api<{ row?: Record<string, unknown> | null }>(
      `/api/data?table=${encodeURIComponent(ref.table)}&id=${encodeURIComponent(ref.id)}`,
    );
    row = data.row ?? null;
    rowCache.set(key, { rows: row ? [row] : [], at: Date.now() });
  }
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
  invalidateDataCache(ref.table);
}

export async function updateDoc(ref: DocumentReference, values: Record<string, unknown>): Promise<void> {
  await api(
    `/api/data?table=${encodeURIComponent(ref.table)}&id=${encodeURIComponent(ref.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ values: encodeValues(values) }),
    },
  );
  invalidateDataCache(ref.table);
}

export async function deleteDoc(ref: DocumentReference): Promise<void> {
  await api(
    `/api/data?table=${encodeURIComponent(ref.table)}&id=${encodeURIComponent(ref.id)}`,
    { method: "DELETE" },
  );
  invalidateDataCache(ref.table);
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
      invalidateDataCache(table);
    },
  };
}

/**
 * Supabase keeps no client subscriptions here, so these collections are polled.
 *
 * The interval is deliberately calm: every tick is a real table read on
 * Supabase, and four of them every 15 seconds (one per sidebar badge) was the
 * largest source of disk IO. Polling is now once a minute, skipped while the
 * tab is in the background, and only re-reads what the caller asked for.
 */
const POLL_INTERVAL_MS = 60_000;

export function onSnapshot(
  ref: CollectionReference,
  next: (snapshot: QuerySnapshot) => void,
  error?: (err: Error) => void,
  options?: ReadOptions,
): () => void {
  let active = true;

  const tick = async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      const snapshot = await getDocs(ref, { ...options, force: true });
      if (active) next(snapshot);
    } catch (err) {
      if (active) error?.(err instanceof Error ? err : new Error(String(err)));
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), options?.pollMs ?? POLL_INTERVAL_MS);
  const onVisible = () => {
    if (!document.hidden) void tick();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);

  return () => {
    active = false;
    clearInterval(timer);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
  };
}
