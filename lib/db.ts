import { getEnv } from "./env";
import type { D1Database } from "./d1";
import { randomId } from "./crypto";

let schemaReady: Promise<void> | null = null;

export class DatabaseUnavailableError extends Error {}

export const SCHEMA_VERSION = 2;

export async function getDB(): Promise<D1Database> {
  const env = await getEnv();
  if (!env.DB) {
    throw new DatabaseUnavailableError(
      "The D1 database binding (DB) is not available. Run `npm run dev` (local D1) or deploy to Sites.",
    );
  }
  return env.DB;
}

// v2 is multi-tenant: every business record carries owner_sub.
const LEGACY_TABLES = [
  "settings",
  "google_account",
  "leads",
  "lead_events",
  "campaigns",
  "messages",
  "replies",
  "suppressions",
  "send_log",
  "audit_log",
  "knowledge",
  "app_config",
];

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS app_meta (k TEXT PRIMARY KEY, v TEXT, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS app_config (
     owner_sub TEXT NOT NULL, k TEXT NOT NULL, v TEXT, updated_at TEXT,
     PRIMARY KEY (owner_sub, k))`,
  `CREATE TABLE IF NOT EXISTS user_settings (
     owner_sub TEXT NOT NULL, k TEXT NOT NULL, v TEXT, updated_at TEXT,
     PRIMARY KEY (owner_sub, k))`,
  `CREATE TABLE IF NOT EXISTS knowledge (
     owner_sub TEXT NOT NULL, id TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL,
     content TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, is_master INTEGER NOT NULL DEFAULT 0,
     updated_at TEXT NOT NULL, PRIMARY KEY (owner_sub, id))`,
  `CREATE TABLE IF NOT EXISTS knowledge_sources (
     owner_sub TEXT NOT NULL, id TEXT NOT NULL, label TEXT NOT NULL, kind TEXT NOT NULL,
     url TEXT, content TEXT, created_at TEXT NOT NULL, PRIMARY KEY (owner_sub, id))`,
  `CREATE TABLE IF NOT EXISTS google_account (
     owner_sub TEXT PRIMARY KEY, email TEXT, name TEXT, access_token TEXT, refresh_token TEXT,
     token_expiry INTEGER, scopes TEXT, connected_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS leads (
     owner_sub TEXT NOT NULL, id TEXT NOT NULL,
     campaign_id TEXT, business TEXT, contact_name TEXT, role TEXT,
     email TEXT, email_norm TEXT, website TEXT, phone TEXT, location TEXT, industry TEXT,
     notes TEXT, extra TEXT, source TEXT, source_ref TEXT, sheet_row INTEGER,
     status TEXT NOT NULL DEFAULT 'new', score INTEGER, priority TEXT, score_reason TEXT,
     research TEXT, research_at TEXT, research_ok INTEGER NOT NULL DEFAULT 0,
     manual_research TEXT, last_contacted_at TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
     PRIMARY KEY (owner_sub, id))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_owner_email ON leads(owner_sub, email_norm)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_owner_status ON leads(owner_sub, status)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_campaign ON leads(owner_sub, campaign_id)`,
  `CREATE TABLE IF NOT EXISTS lead_events (
     owner_sub TEXT NOT NULL, id TEXT NOT NULL, lead_id TEXT NOT NULL, type TEXT NOT NULL,
     detail TEXT, created_at TEXT NOT NULL, PRIMARY KEY (owner_sub, id))`,
  `CREATE INDEX IF NOT EXISTS idx_events_lead ON lead_events(owner_sub, lead_id)`,
  `CREATE TABLE IF NOT EXISTS campaigns (
     owner_sub TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, instruction TEXT,
     config TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', sheet_source TEXT,
     created_at TEXT NOT NULL, approved_at TEXT, updated_at TEXT NOT NULL,
     PRIMARY KEY (owner_sub, id))`,
  `CREATE TABLE IF NOT EXISTS messages (
     owner_sub TEXT NOT NULL, id TEXT NOT NULL, lead_id TEXT NOT NULL, campaign_id TEXT,
     step INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'initial',
     subject TEXT, body TEXT, angle TEXT, rationale TEXT, service TEXT,
     status TEXT NOT NULL DEFAULT 'draft', gmail_id TEXT, thread_id TEXT, rfc_message_id TEXT,
     sent_at TEXT, error TEXT, approved_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
     PRIMARY KEY (owner_sub, id))`,
  `CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages(owner_sub, lead_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(owner_sub, status)`,
  `CREATE TABLE IF NOT EXISTS replies (
     owner_sub TEXT NOT NULL, id TEXT NOT NULL, lead_id TEXT, thread_id TEXT, gmail_id TEXT,
     from_email TEXT, subject TEXT, snippet TEXT, body TEXT, received_at TEXT,
     classification TEXT, summary TEXT, recommended_action TEXT, draft_reply TEXT,
     handled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
     PRIMARY KEY (owner_sub, id))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_replies_owner_gmail ON replies(owner_sub, gmail_id)`,
  `CREATE TABLE IF NOT EXISTS suppressions (
     owner_sub TEXT NOT NULL, email TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL,
     PRIMARY KEY (owner_sub, email))`,
  `CREATE TABLE IF NOT EXISTS send_log (
     owner_sub TEXT NOT NULL, id TEXT NOT NULL, lead_id TEXT, message_id TEXT, status TEXT,
     at TEXT NOT NULL, PRIMARY KEY (owner_sub, id))`,
  `CREATE INDEX IF NOT EXISTS idx_sendlog_at ON send_log(owner_sub, at)`,
  `CREATE TABLE IF NOT EXISTS audit_log (
     owner_sub TEXT NOT NULL, id TEXT NOT NULL, action TEXT NOT NULL, entity TEXT,
     entity_id TEXT, detail TEXT, created_at TEXT NOT NULL, PRIMARY KEY (owner_sub, id))`,
  `CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(owner_sub, created_at)`,
];

export async function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const db = await getDB();
      await db.prepare(`CREATE TABLE IF NOT EXISTS app_meta (k TEXT PRIMARY KEY, v TEXT, updated_at TEXT)`).run();
      const version = await db.prepare(`SELECT v FROM app_meta WHERE k = 'schema_version'`).first<{ v: string }>();
      const current = Number(version?.v ?? 0);
      if (current < SCHEMA_VERSION) {
        for (const table of LEGACY_TABLES) {
          await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
        }
      }
      for (const sql of STATEMENTS) {
        await db.prepare(sql).run();
      }
      await db
        .prepare(
          `INSERT INTO app_meta (k, v, updated_at) VALUES ('schema_version', ?, ?)
           ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
        )
        .bind(String(SCHEMA_VERSION), new Date().toISOString())
        .run();
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

export async function q<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
  await ensureSchema();
  const db = await getDB();
  const res = await db.prepare(sql).bind(...params).all<T>();
  return res.results ?? [];
}

export async function first<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | null> {
  await ensureSchema();
  const db = await getDB();
  return db.prepare(sql).bind(...params).first<T>();
}

export async function run(sql: string, ...params: unknown[]): Promise<number> {
  await ensureSchema();
  const db = await getDB();
  const res = await db.prepare(sql).bind(...params).run();
  return res.meta?.changes ?? 0;
}

export function now(): string {
  return new Date().toISOString();
}

export async function audit(
  ownerSub: string,
  action: string,
  entity?: string,
  entityId?: string,
  detail?: unknown,
): Promise<void> {
  try {
    await run(
      `INSERT INTO audit_log (owner_sub, id, action, entity, entity_id, detail, created_at) VALUES (?,?,?,?,?,?,?)`,
      ownerSub,
      randomId("aud"),
      action,
      entity ?? null,
      entityId ?? null,
      detail === undefined ? null : JSON.stringify(detail).slice(0, 4000),
      now(),
    );
  } catch {
    // Audit failures must never break the request path.
  }
}

export async function logEvent(ownerSub: string, leadId: string, type: string, detail?: unknown): Promise<void> {
  await run(
    `INSERT INTO lead_events (owner_sub, id, lead_id, type, detail, created_at) VALUES (?,?,?,?,?,?)`,
    ownerSub,
    randomId("evt"),
    leadId,
    type,
    detail === undefined ? null : JSON.stringify(detail).slice(0, 2000),
    now(),
  );
}

export async function getMeta(k: string): Promise<string | null> {
  const row = await first<{ v: string }>(`SELECT v FROM app_meta WHERE k = ?`, k);
  return row?.v ?? null;
}

export async function setMeta(k: string, v: string): Promise<void> {
  await run(
    `INSERT INTO app_meta (k, v, updated_at) VALUES (?,?,?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
    k,
    v,
    now(),
  );
}
