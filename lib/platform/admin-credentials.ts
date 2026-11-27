import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { decryptSecret, encryptSecret, generateTotpSecret } from "../key-vault";
import { supabaseServer } from "../supabase-server";
import { appendAdminAuditLog, extractRequestMeta } from "./store-server";
import type { AdminRole } from "./types";

const PLATFORM_ADMIN_OWNER = "__platform_admin__";
const DOC_ADMIN_ACCOUNTS = "system_admin_accounts";
const DOC_LOGIN_ATTEMPTS = "system_admin_login_attempts";

const DEFAULT_ADMIN_EMAIL = "censusokoi515@gmail.com";
const DEFAULT_ADMIN_NAME = "Census Okoi (Super Admin)";
// Precomputed scrypt hash for bootstrap admin credentials (never store plaintext).
const DEFAULT_ADMIN_PASSWORD_HASH =
  "scrypt:v1:37fd974dee3e38da5bd5dd6d518c0335:e879f5489274a46bb45e21679eb4b81a556c15cb078fce5bccac93355be1962b022424b6074308287c76c978749f8933237e4e769361a8ba0b115a5cf2818568";

const LOCKOUT_MAX_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

export interface AdminAccountRecord {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  status: "active" | "suspended";
  passwordHash: string;
  totpEnabled: boolean;
  totpSecretEncrypted: string;
  backupCodesHashes?: string[];
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminAccountPublic {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  status: "active" | "suspended";
  totpEnabled: boolean;
  backupCodesRemaining: number;
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  createdBy: string | null;
  createdAt: string;
}

interface LoginAttemptState {
  attemptKey: string;
  failureCount: number;
  firstFailedAt: string;
  lockedUntil: string | null;
  lastAttemptIp: string | null;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Scrypt Password Hashing
// ---------------------------------------------------------------------------

export function hashAdminPassword(password: string): string {
  const clean = password;
  if (clean.length < 10) {
    throw new Error("Admin password must be at least 10 characters.");
  }
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(clean, salt, 64).toString("hex");
  return `scrypt:v1:${salt}:${derived}`;
}

export function verifyAdminPassword(password: string, storedHash: string): boolean {
  if (!password || !storedHash.startsWith("scrypt:v1:")) return false;
  const parts = storedHash.split(":");
  if (parts.length !== 4) return false;
  const [, , salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;
  try {
    const derived = scryptSync(password, salt, 64);
    const expected = Buffer.from(expectedHex, "hex");
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function toPublicAdminAccount(acc: AdminAccountRecord): AdminAccountPublic {
  return {
    id: acc.id,
    email: acc.email,
    name: acc.name,
    role: acc.role,
    status: acc.status,
    totpEnabled: acc.totpEnabled,
    backupCodesRemaining: Array.isArray(acc.backupCodesHashes) ? acc.backupCodesHashes.length : 0,
    lastLoginAt: acc.lastLoginAt,
    lastLoginIp: acc.lastLoginIp,
    createdBy: acc.createdBy,
    createdAt: acc.createdAt,
  };
}

const BACKUP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function normalizeBackupCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function hashBackupCode(normalized: string): string {
  const salt = randomBytes(12).toString("hex");
  const derived = scryptSync(normalized, salt, 32).toString("hex");
  return `scrypt_bc:${salt}:${derived}`;
}

function matchesBackupHash(normalized: string, stored: string): boolean {
  if (!normalized || !stored.startsWith("scrypt_bc:")) return false;
  const parts = stored.split(":");
  if (parts.length !== 3) return false;
  const [, salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;
  try {
    const derived = scryptSync(normalized, salt, 32);
    const expected = Buffer.from(expectedHex, "hex");
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function generateAdminBackupCodes(count = 10): {
  plaintextCodes: string[];
  hashes: string[];
} {
  const plaintextCodes: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const bytes = randomBytes(8);
    let chars = "";
    for (let j = 0; j < 8; j += 1) {
      chars += BACKUP_ALPHABET[bytes[j]! % BACKUP_ALPHABET.length];
    }
    const formatted = `${chars.slice(0, 4)}-${chars.slice(4)}`;
    plaintextCodes.push(formatted);
    hashes.push(hashBackupCode(chars));
  }
  return { plaintextCodes, hashes };
}

export async function consumeAdminBackupCode(
  account: AdminAccountRecord,
  rawCode: string,
): Promise<boolean> {
  const normalized = normalizeBackupCode(rawCode);
  const hashes = Array.isArray(account.backupCodesHashes) ? account.backupCodesHashes : [];
  if (!normalized || hashes.length === 0) return false;

  const matchedIdx = hashes.findIndex((h) => matchesBackupHash(normalized, h));
  if (matchedIdx < 0) return false;

  const remaining = hashes.filter((_, idx) => idx !== matchedIdx);
  await saveAdminAccountRecord({
    ...account,
    backupCodesHashes: remaining,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Storage Backend (admin_accounts table with owner-isolated knowledge fallback)
// ---------------------------------------------------------------------------

function mapSqlAccountRow(row: Record<string, unknown>): AdminAccountRecord {
  return {
    id: String(row.id ?? ""),
    email: String(row.email ?? "").trim().toLowerCase(),
    name: String(row.name ?? ""),
    role: (String(row.role ?? "support") as AdminRole) || "support",
    status: String(row.status ?? "active") === "suspended" ? "suspended" : "active",
    passwordHash: String(row.password_hash ?? ""),
    totpEnabled: Boolean(row.totp_enabled),
    totpSecretEncrypted: String(row.totp_secret_encrypted ?? ""),
    backupCodesHashes: Array.isArray(row.backup_codes_hashes)
      ? (row.backup_codes_hashes as unknown[]).map((v) => String(v))
      : [],
    lastLoginAt: row.last_login_at ? String(row.last_login_at) : null,
    lastLoginIp: row.last_login_ip ? String(row.last_login_ip) : null,
    createdBy: row.created_by ? String(row.created_by) : null,
    createdAt: String(row.created_at ?? new Date().toISOString()),
    updatedAt: String(row.updated_at ?? new Date().toISOString()),
  };
}

async function readFallbackAccounts(): Promise<AdminAccountRecord[]> {
  if (!supabaseServer) return [];
  const { data } = await supabaseServer
    .from("knowledge")
    .select("content")
    .eq("id", DOC_ADMIN_ACCOUNTS)
    .eq("owner_id", PLATFORM_ADMIN_OWNER)
    .maybeSingle();
  const raw = (data as { content?: string } | null)?.content;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AdminAccountRecord[]) : [];
  } catch {
    return [];
  }
}

async function writeFallbackAccounts(accounts: AdminAccountRecord[]): Promise<void> {
  if (!supabaseServer) return;
  await supabaseServer.from("knowledge").upsert(
    {
      id: DOC_ADMIN_ACCOUNTS,
      owner_id: PLATFORM_ADMIN_OWNER,
      category: "system_platform_admin_auth",
      title: "Admin Accounts Registry",
      content: JSON.stringify(accounts),
      sort: 999,
      is_master: false,
      updated_at: new Date().toISOString(),
    } as never,
    { onConflict: "id" },
  );
}

async function readAllAdminAccountsRaw(): Promise<{ accounts: AdminAccountRecord[]; useSql: boolean }> {
  if (!supabaseServer) return { accounts: [], useSql: false };
  const { data, error } = await supabaseServer
    .from("admin_accounts")
    .select("*")
    .order("created_at", { ascending: true });
  if (!error && Array.isArray(data)) {
    return {
      accounts: data.map((r) => mapSqlAccountRow(r as Record<string, unknown>)),
      useSql: true,
    };
  }
  return {
    accounts: await readFallbackAccounts(),
    useSql: false,
  };
}

async function upsertAdminAccountRaw(acc: AdminAccountRecord, useSql: boolean): Promise<void> {
  if (!supabaseServer) return;
  if (useSql) {
    const { error } = await supabaseServer.from("admin_accounts").upsert(
      {
        id: acc.id,
        email: acc.email,
        name: acc.name,
        role: acc.role,
        status: acc.status,
        password_hash: acc.passwordHash,
        totp_enabled: acc.totpEnabled,
        totp_secret_encrypted: acc.totpSecretEncrypted,
        backup_codes_hashes: acc.backupCodesHashes ?? [],
        last_login_at: acc.lastLoginAt,
        last_login_ip: acc.lastLoginIp,
        created_by: acc.createdBy,
        created_at: acc.createdAt,
        updated_at: acc.updatedAt,
      } as never,
      { onConflict: "id" },
    );
    if (!error) return;
  }
  const existing = await readFallbackAccounts();
  const next = existing.some((item) => item.id === acc.id)
    ? existing.map((item) => (item.id === acc.id ? acc : item))
    : [...existing, acc];
  await writeFallbackAccounts(next);
}

/**
 * Ensures the bootstrap Super Admin account exists cleanly with a precomputed scrypt hash
 * and never relies on hardcoded plaintext passwords or Google/Supabase user roles.
 */
export async function ensureDefaultSuperAdminAccount(): Promise<{
  accounts: AdminAccountRecord[];
  useSql: boolean;
}> {
  const { accounts, useSql } = await readAllAdminAccountsRaw();
  const bootstrapEmail = (process.env.ADMIN_BOOTSTRAP_EMAIL ?? DEFAULT_ADMIN_EMAIL).trim().toLowerCase();
  const bootstrapHash = (process.env.ADMIN_DEFAULT_PASSWORD_HASH ?? "").trim() || DEFAULT_ADMIN_PASSWORD_HASH;

  if (accounts.some((a) => a.email === bootstrapEmail)) {
    return { accounts, useSql };
  }

  const now = new Date().toISOString();
  const bootstrapRecord: AdminAccountRecord = {
    id: `adm_${bootstrapEmail.replace(/[^a-z0-9]/g, "_")}`,
    email: bootstrapEmail,
    name: DEFAULT_ADMIN_NAME,
    role: "super_admin",
    status: "active",
    passwordHash: bootstrapHash,
    totpEnabled: false,
    totpSecretEncrypted: encryptSecret(generateTotpSecret()),
    lastLoginAt: null,
    lastLoginIp: null,
    createdBy: "system_bootstrap",
    createdAt: now,
    updatedAt: now,
  };

  await upsertAdminAccountRaw(bootstrapRecord, useSql);
  return { accounts: [...accounts, bootstrapRecord], useSql };
}

export async function findAdminAccountById(adminId: string): Promise<AdminAccountRecord | null> {
  const { accounts } = await ensureDefaultSuperAdminAccount();
  return accounts.find((a) => a.id === adminId) ?? null;
}

export async function findAdminAccountByEmail(email: string): Promise<AdminAccountRecord | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const { accounts } = await ensureDefaultSuperAdminAccount();
  return accounts.find((a) => a.email === normalized) ?? null;
}

export async function listAdminAccountsPublic(): Promise<AdminAccountPublic[]> {
  const { accounts } = await ensureDefaultSuperAdminAccount();
  return accounts.map(toPublicAdminAccount);
}

export async function saveAdminAccountRecord(acc: AdminAccountRecord): Promise<void> {
  const { useSql } = await readAllAdminAccountsRaw();
  await upsertAdminAccountRaw({ ...acc, updatedAt: new Date().toISOString() }, useSql);
}

export async function getOrCreateAdminAccountTotpSecret(admin: AdminAccountRecord): Promise<string> {
  if (admin.totpSecretEncrypted) {
    try {
      const dec = decryptSecret(admin.totpSecretEncrypted);
      if (dec) return dec;
    } catch {
      /* regenerate below */
    }
  }
  const secret = generateTotpSecret();
  await saveAdminAccountRecord({
    ...admin,
    totpSecretEncrypted: encryptSecret(secret),
  });
  return secret;
}

export async function createAdminAccount(input: {
  email: string;
  name: string;
  role: AdminRole;
  password: string;
  actorId: string;
  actorEmail: string;
  req?: NextRequest | null;
}): Promise<AdminAccountPublic> {
  const normalizedEmail = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new Error("Enter a valid email address.");
  }
  const { accounts, useSql } = await ensureDefaultSuperAdminAccount();
  if (accounts.some((a) => a.email === normalizedEmail)) {
    throw new Error("An admin account with that email already exists.");
  }
  const passwordHash = hashAdminPassword(input.password);
  const now = new Date().toISOString();
  const record: AdminAccountRecord = {
    id: `adm_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`,
    email: normalizedEmail,
    name: input.name.trim() || normalizedEmail.split("@")[0] || "Admin",
    role: input.role,
    status: "active",
    passwordHash,
    totpEnabled: false,
    totpSecretEncrypted: encryptSecret(generateTotpSecret()),
    lastLoginAt: null,
    lastLoginIp: null,
    createdBy: input.actorEmail,
    createdAt: now,
    updatedAt: now,
  };

  await upsertAdminAccountRaw(record, useSql);
  await appendAdminAuditLog({
    actorId: input.actorId,
    actorEmail: input.actorEmail,
    actorRole: "super_admin",
    action: "admin_account_created",
    targetType: "admin_account",
    targetId: record.id,
    details: { targetEmail: record.email, assignedRole: record.role },
    req: input.req,
  });
  return toPublicAdminAccount(record);
}

// ---------------------------------------------------------------------------
// Rate Limiting & Temporary Account/IP Lockout
// ---------------------------------------------------------------------------

async function readAttemptMap(): Promise<{ map: Record<string, LoginAttemptState>; useSql: boolean }> {
  if (!supabaseServer) return { map: {}, useSql: false };
  const { data, error } = await supabaseServer
    .from("admin_login_attempts")
    .select("*");
  if (!error && Array.isArray(data)) {
    const map: Record<string, LoginAttemptState> = {};
    for (const row of data) {
      const r = row as Record<string, unknown>;
      const key = String(r.attempt_key ?? "");
      if (!key) continue;
      map[key] = {
        attemptKey: key,
        failureCount: Number(r.failure_count ?? 0),
        firstFailedAt: String(r.first_failed_at ?? new Date().toISOString()),
        lockedUntil: r.locked_until ? String(r.locked_until) : null,
        lastAttemptIp: r.last_attempt_ip ? String(r.last_attempt_ip) : null,
        updatedAt: String(r.updated_at ?? new Date().toISOString()),
      };
    }
    return { map, useSql: true };
  }

  const { data: kb } = await supabaseServer
    .from("knowledge")
    .select("content")
    .eq("id", DOC_LOGIN_ATTEMPTS)
    .eq("owner_id", PLATFORM_ADMIN_OWNER)
    .maybeSingle();
  const raw = (kb as { content?: string } | null)?.content;
  if (!raw) return { map: {}, useSql: false };
  try {
    return { map: JSON.parse(raw) as Record<string, LoginAttemptState>, useSql: false };
  } catch {
    return { map: {}, useSql: false };
  }
}

async function writeAttemptState(state: LoginAttemptState, useSql: boolean): Promise<void> {
  if (!supabaseServer) return;
  if (useSql) {
    const { error } = await supabaseServer.from("admin_login_attempts").upsert(
      {
        attempt_key: state.attemptKey,
        failure_count: state.failureCount,
        first_failed_at: state.firstFailedAt,
        locked_until: state.lockedUntil,
        last_attempt_ip: state.lastAttemptIp,
        updated_at: state.updatedAt,
      } as never,
      { onConflict: "attempt_key" },
    );
    if (!error) return;
  }

  const { map } = await readAttemptMap();
  map[state.attemptKey] = state;
  await supabaseServer.from("knowledge").upsert(
    {
      id: DOC_LOGIN_ATTEMPTS,
      owner_id: PLATFORM_ADMIN_OWNER,
      category: "system_platform_admin_auth",
      title: "Admin Login Attempts",
      content: JSON.stringify(map),
      sort: 999,
      is_master: false,
      updated_at: new Date().toISOString(),
    } as never,
    { onConflict: "id" },
  );
}

async function deleteAttemptKey(attemptKey: string, useSql: boolean): Promise<void> {
  if (!supabaseServer) return;
  if (useSql) {
    const { error } = await supabaseServer
      .from("admin_login_attempts")
      .delete()
      .eq("attempt_key", attemptKey);
    if (!error) return;
  }
  const { map } = await readAttemptMap();
  if (attemptKey in map) {
    delete map[attemptKey];
    await supabaseServer.from("knowledge").upsert(
      {
        id: DOC_LOGIN_ATTEMPTS,
        owner_id: PLATFORM_ADMIN_OWNER,
        category: "system_platform_admin_auth",
        title: "Admin Login Attempts",
        content: JSON.stringify(map),
        sort: 999,
        is_master: false,
        updated_at: new Date().toISOString(),
      } as never,
      { onConflict: "id" },
    );
  }
}

function attemptKeysFor(email: string, ip: string): string[] {
  const keys: string[] = [];
  const normEmail = email.trim().toLowerCase();
  if (normEmail) keys.push(`email:${normEmail}`);
  if (ip && ip !== "unknown") keys.push(`ip:${ip}`);
  return keys;
}

export async function checkAdminLoginLockout(
  email: string,
  req?: NextRequest | null,
): Promise<{ locked: boolean; retryAfterSeconds: number }> {
  const { ipAddress } = extractRequestMeta(req);
  const { map } = await readAttemptMap();
  const now = Date.now();
  let maxRemaining = 0;

  for (const key of attemptKeysFor(email, ipAddress)) {
    const entry = map[key];
    if (!entry?.lockedUntil) continue;
    const lockedMs = new Date(entry.lockedUntil).getTime();
    if (lockedMs > now) {
      maxRemaining = Math.max(maxRemaining, Math.ceil((lockedMs - now) / 1000));
    }
  }

  return { locked: maxRemaining > 0, retryAfterSeconds: maxRemaining };
}

export async function recordAdminAuthFailure(input: {
  email: string;
  stage: "password" | "totp";
  req?: NextRequest | null;
}): Promise<{ locked: boolean; retryAfterSeconds: number }> {
  const { ipAddress } = extractRequestMeta(input.req);
  const { map, useSql } = await readAttemptMap();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  let becameLocked = false;

  for (const key of attemptKeysFor(input.email, ipAddress)) {
    const existing = map[key];
    const windowExpired =
      !existing || now - new Date(existing.firstFailedAt).getTime() > LOCKOUT_WINDOW_MS;

    const nextCount = windowExpired ? 1 : existing.failureCount + 1;
    const firstFailedAt = windowExpired ? nowIso : existing.firstFailedAt;
    const shouldLock = nextCount >= LOCKOUT_MAX_ATTEMPTS;
    if (shouldLock) becameLocked = true;

    await writeAttemptState(
      {
        attemptKey: key,
        failureCount: nextCount,
        firstFailedAt,
        lockedUntil: shouldLock ? new Date(now + LOCKOUT_DURATION_MS).toISOString() : null,
        lastAttemptIp: ipAddress,
        updatedAt: nowIso,
      },
      useSql,
    );
  }

  await appendAdminAuditLog({
    actorId: "unauthenticated",
    actorEmail: input.email.trim().toLowerCase() || "unknown",
    actorRole: "support",
    action: becameLocked ? "admin_login_lockout" : "admin_login_failed",
    targetType: "admin_auth",
    targetId: input.stage,
    details: { stage: input.stage, ipAddress, locked: becameLocked },
    req: input.req,
  });

  return {
    locked: becameLocked,
    retryAfterSeconds: becameLocked ? Math.ceil(LOCKOUT_DURATION_MS / 1000) : 0,
  };
}

export async function clearAdminAuthFailures(email: string, req?: NextRequest | null): Promise<void> {
  const { ipAddress } = extractRequestMeta(req);
  const { useSql } = await readAttemptMap();
  for (const key of attemptKeysFor(email, ipAddress)) {
    await deleteAttemptKey(key, useSql);
  }
}
