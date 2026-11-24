"use client";

import type { User } from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { db, handleFirestoreError, OperationType } from "./firebase";
import {
  extractEmailsFromRow,
  mapHeaders,
  normalizeEmail,
  normalizeWebsite,
  type LeadField,
} from "./columns";
import { randomId } from "./crypto";
import {
  clampReqStr,
  clampStr,
  computeAnalyticsMetrics,
  computeDashboardStats,
  defaultCampaignConfig,
  findFollowupCandidatesFromData,
  getLocalSendParts,
  sanitizeFirestoreId,
} from "./outreach-utils";
import {
  DEFAULT_SETTINGS,
  type AuditLog,
  type Campaign,
  type CampaignConfig,
  type EmailOpen,
  type KnowledgeEntry,
  type KnowledgeSource,
  type Lead,
  type LeadStatus,
  type Message,
  type QualificationResult,
  type Reply,
  type ResearchResult,
  type SendLog,
  type Settings,
  type Suppression,
} from "./types";

function tsToIso(value: unknown, fallback = new Date().toISOString()): string {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && "toDate" in value && typeof (value as { toDate: () => Date }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return fallback;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeCampaignConfig(raw: Partial<CampaignConfig> | undefined, settings: Settings): CampaignConfig {
  const def = defaultCampaignConfig(settings);
  const src = raw ?? {};
  return {
    services: Array.isArray(src.services)
      ? src.services.map((s) => String(s).trim().slice(0, 120)).filter(Boolean).slice(0, 20)
      : def.services,
    target_industry: clampReqStr(src.target_industry, 160, def.target_industry),
    objective: clampReqStr(src.objective, 500, def.objective),
    tone: clampReqStr(src.tone, 200, def.tone),
    min_score: clampInt(src.min_score, 0, 100, def.min_score),
    lead_count: clampInt(src.lead_count, 1, 200, def.lead_count),
    send_limit: clampInt(src.send_limit, 1, 500, def.send_limit),
    interval_seconds: clampInt(src.interval_seconds, 30, 900, def.interval_seconds),
    followup_days:
      Array.isArray(src.followup_days) && src.followup_days.length
        ? src.followup_days.map((d) => clampInt(d, 1, 60, 4)).slice(0, 10)
        : def.followup_days,
    auto_approve_initial: Boolean(src.auto_approve_initial),
    auto_approve_followups: Boolean(src.auto_approve_followups),
    require_approval: src.require_approval === undefined ? def.require_approval : Boolean(src.require_approval),
    identity: src.identity === "personal" ? "personal" : "company",
    extra_instructions: clampReqStr(src.extra_instructions, 2000, ""),
    ...(src.summary ? { summary: clampReqStr(src.summary, 2000, "") } : {}),
    ...(Array.isArray(src.warnings) && src.warnings.length
      ? { warnings: src.warnings.map((w) => String(w).slice(0, 300)).slice(0, 20) }
      : {}),
  };
}

function normalizeSettingsPayload(uid: string, input: Partial<Settings>, base: Settings = DEFAULT_SETTINGS) {
  const s = { ...base, ...input };
  return {
    ownerId: uid,
    sender_name: clampReqStr(s.sender_name, 160, ""),
    sender_role: clampReqStr(s.sender_role, 160, ""),
    sender_company: clampReqStr(s.sender_company, 200, ""),
    sender_email: clampReqStr(s.sender_email, 320, ""),
    signature: clampReqStr(s.signature, 2000, ""),
    daily_limit: clampInt(s.daily_limit, 1, 200, DEFAULT_SETTINGS.daily_limit),
    campaign_limit: clampInt(s.campaign_limit, 1, 500, DEFAULT_SETTINGS.campaign_limit),
    interval_seconds: clampInt(s.interval_seconds, 30, 900, DEFAULT_SETTINGS.interval_seconds),
    send_window_start: clampInt(s.send_window_start, 0, 23, DEFAULT_SETTINGS.send_window_start),
    send_window_end: clampInt(s.send_window_end, 1, 24, DEFAULT_SETTINGS.send_window_end),
    send_days: clampReqStr(s.send_days, 32, DEFAULT_SETTINGS.send_days),
    timezone_offset: clampInt(s.timezone_offset, -720, 840, DEFAULT_SETTINGS.timezone_offset),
    followup_days: clampInt(s.followup_days, 1, 30, DEFAULT_SETTINGS.followup_days),
    min_score: clampInt(s.min_score, 0, 100, DEFAULT_SETTINGS.min_score),
    unsubscribe_email: clampReqStr(s.unsubscribe_email, 320, ""),
    physical_address: clampReqStr(s.physical_address, 400, ""),
    model: clampReqStr(s.model, 200, DEFAULT_SETTINGS.model) || DEFAULT_SETTINGS.model,
    ai_provider: clampReqStr(s.ai_provider, 40, DEFAULT_SETTINGS.ai_provider) || DEFAULT_SETTINGS.ai_provider,
    ai_api_key: clampStr(s.ai_api_key, 512) ?? "",
    ai_base_url: clampStr(s.ai_base_url, 400) ?? "",
    ai_verified_at: clampStr(s.ai_verified_at, 64) ?? "",
    ai_key_hint: clampStr(s.ai_key_hint, 40) ?? "",
  };
}

// ---------------------------------------------------------------------------
// Workspace Bootstrap
// ---------------------------------------------------------------------------

export async function ensureUserWorkspace(user: User): Promise<void> {
  const uid = user.uid;
  const userPath = `users/${uid}`;
  const userRef = doc(db, "users", uid);
  try {
    const snap = await getDoc(userRef);
    if (!snap.exists()) {
      await setDoc(userRef, {
        uid,
        email: clampReqStr(user.email, 320, "user@example.com"),
        displayName: clampReqStr(user.displayName, 160, ""),
        photoURL: clampStr(user.photoURL, 1000),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(userRef, {
        email: clampReqStr(user.email, 320, "user@example.com"),
        displayName: clampReqStr(user.displayName, 160, ""),
        photoURL: clampStr(user.photoURL, 1000),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, userPath);
  }

  const settingsRef = doc(db, "users", uid, "settings", "default");
  try {
    const sSnap = await getDoc(settingsRef);
    if (!sSnap.exists()) {
      const payload = normalizeSettingsPayload(uid, {
        sender_name: user.displayName ?? "",
        sender_email: user.email ?? "",
      });
      await setDoc(settingsRef, {
        ...payload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    // Settings live in Supabase now; a Firestore rules rejection here must not
    // block sign-in.
    console.warn("[settings] skipped Firestore bootstrap:", err instanceof Error ? err.message : err);
  }

  const masterPath = `users/${uid}/knowledge/master`;
  const masterRef = doc(db, "users", uid, "knowledge", "master");
  try {
    const mSnap = await getDoc(masterRef);
    if (!mSnap.exists()) {
      await setDoc(masterRef, {
        ownerId: uid,
        category: "master",
        title: "Master knowledge",
        content: "",
        sort: 0,
        is_master: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, masterPath);
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function toSettings(data: Record<string, unknown>): Settings {
  return {
      sender_name: String(data.sender_name ?? ""),
      sender_role: String(data.sender_role ?? ""),
      sender_company: String(data.sender_company ?? ""),
      sender_email: String(data.sender_email ?? ""),
      signature: String(data.signature ?? ""),
      daily_limit: clampInt(data.daily_limit, 1, 200, DEFAULT_SETTINGS.daily_limit),
      campaign_limit: clampInt(data.campaign_limit, 1, 500, DEFAULT_SETTINGS.campaign_limit),
      interval_seconds: clampInt(data.interval_seconds, 30, 900, DEFAULT_SETTINGS.interval_seconds),
      send_window_start: clampInt(data.send_window_start, 0, 23, DEFAULT_SETTINGS.send_window_start),
      send_window_end: clampInt(data.send_window_end, 1, 24, DEFAULT_SETTINGS.send_window_end),
      send_days: String(data.send_days ?? DEFAULT_SETTINGS.send_days),
      timezone_offset: clampInt(data.timezone_offset, -720, 840, DEFAULT_SETTINGS.timezone_offset),
      followup_days: clampInt(data.followup_days, 1, 30, DEFAULT_SETTINGS.followup_days),
      min_score: clampInt(data.min_score, 0, 100, DEFAULT_SETTINGS.min_score),
      unsubscribe_email: String(data.unsubscribe_email ?? ""),
      physical_address: String(data.physical_address ?? ""),
      model: String(data.model ?? DEFAULT_SETTINGS.model),
      ai_provider: String(data.ai_provider ?? DEFAULT_SETTINGS.ai_provider),
      ai_api_key: String(data.ai_api_key ?? ""),
      ai_base_url: String(data.ai_base_url ?? ""),
      ai_verified_at: String(data.ai_verified_at ?? ""),
      ai_key_hint: String(data.ai_key_hint ?? ""),
    };
}

/**
 * Settings live in Supabase now (Firebase is auth only), so they keep saving
 * when Firestore rules reject writes. Firestore is read only as a legacy
 * fallback for accounts that have not saved since the migration.
 */
export async function getSettings(uid: string): Promise<Settings> {
  const { fetchSettingsDocument } = await import("./supabase");
  const remote = await fetchSettingsDocument();
  if (remote.ok) {
    if (remote.settings) return toSettings(remote.settings as unknown as Record<string, unknown>);
  } else if (!remote.unconfigured) {
    // Never fall through to defaults here: an unreadable settings row used to
    // look exactly like a missing AI key and silently reset the whole profile.
    throw new Error(remote.message);
  }

  const path = `users/${uid}/settings/default`;
  try {
    const snap = await getDoc(doc(db, "users", uid, "settings", "default"));
    if (!snap.exists()) return { ...DEFAULT_SETTINGS };
    return toSettings(snap.data() as Record<string, unknown>);
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

export async function saveSettings(uid: string, patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings(uid);
  const payload = normalizeSettingsPayload(uid, patch, current);
  const { saveSettingsDocument } = await import("./supabase");
  const remote = await saveSettingsDocument(payload);
  if (remote.ok) {
    return remote.settings
      ? toSettings(remote.settings as unknown as Record<string, unknown>)
      : toSettings(payload as unknown as Record<string, unknown>);
  }
  if (!remote.unconfigured) throw new Error(remote.message);

  // Legacy fallback for deployments without Supabase configured.
  const path = `users/${uid}/settings/default`;
  const ref = doc(db, "users", uid, "settings", "default");
  try {
    const existingSnap = await getDoc(ref);
    if (!existingSnap.exists()) {
      await setDoc(ref, { ...payload, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    } else {
      const { ownerId: _ownerId, ...mutable } = payload;
      void _ownerId;
      await updateDoc(ref, { ...mutable, updatedAt: serverTimestamp() });
    }
    return getSettings(uid);
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

// ---------------------------------------------------------------------------
// Knowledge & Sources
// ---------------------------------------------------------------------------

export async function getKnowledgeBundle(uid: string): Promise<{
  master: string;
  entries: KnowledgeEntry[];
  sources: KnowledgeSource[];
}> {
  const kPath = `users/${uid}/knowledge`;
  const sPath = `users/${uid}/knowledgeSources`;
  let kSnap;
  let sSnap;
  try {
    kSnap = await getDocs(query(collection(db, kPath), where("ownerId", "==", uid)));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, kPath);
  }
  try {
    sSnap = await getDocs(query(collection(db, sPath), where("ownerId", "==", uid)));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, sPath);
  }

  let master = "";
  const entries: KnowledgeEntry[] = [];
  for (const d of kSnap.docs) {
    const data = d.data();
    if (d.id === "master" || data.is_master === true) {
      master = String(data.content ?? "");
    } else {
      entries.push({
        id: d.id,
        ownerId: String(data.ownerId ?? uid),
        category: String(data.category ?? "custom"),
        title: String(data.title ?? ""),
        content: String(data.content ?? ""),
        sort: Number(data.sort ?? 50),
        is_master: Boolean(data.is_master),
        created_at: tsToIso(data.createdAt),
        updated_at: tsToIso(data.updatedAt),
      });
    }
  }
  entries.sort((a, b) => a.sort - b.sort || a.title.localeCompare(b.title));

  const sources: KnowledgeSource[] = sSnap.docs
    .map((d) => {
      const data = d.data();
      return {
        id: d.id,
        ownerId: String(data.ownerId ?? uid),
        label: String(data.label ?? ""),
        kind: (data.kind as KnowledgeSource["kind"]) ?? "url",
        url: data.url ? String(data.url) : null,
        content: data.content ? String(data.content) : null,
        created_at: tsToIso(data.createdAt),
        updated_at: tsToIso(data.updatedAt),
      };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  return { master, entries, sources };
}

export async function saveMasterKnowledge(uid: string, content: string): Promise<void> {
  const path = `users/${uid}/knowledge/master`;
  const ref = doc(db, "users", uid, "knowledge", "master");
  try {
    const snap = await getDoc(ref);
    const trimmed = String(content ?? "").slice(0, 700_000);
    if (!snap.exists()) {
      await setDoc(ref, {
        ownerId: uid,
        category: "master",
        title: "Master knowledge",
        content: trimmed,
        sort: 0,
        is_master: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        category: "master",
        title: "Master knowledge",
        content: trimmed,
        sort: 0,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function upsertKnowledgeEntry(
  uid: string,
  input: { id?: string; title: string; content: string; category?: string; sort?: number },
): Promise<string> {
  const id = input.id ? sanitizeFirestoreId(input.id, "k") : randomId("k");
  const path = `users/${uid}/knowledge/${id}`;
  const ref = doc(db, "users", uid, "knowledge", id);
  try {
    const snap = await getDoc(ref);
    const title = clampReqStr(input.title, 200, "Untitled");
    const content = clampReqStr(input.content, 700_000, "");
    const category = clampReqStr(input.category, 64, "custom");
    const sort = clampInt(input.sort, 0, 10000, 50);
    if (!snap.exists()) {
      await setDoc(ref, {
        ownerId: uid,
        category,
        title,
        content,
        sort,
        is_master: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, { category, title, content, sort, updatedAt: serverTimestamp() });
    }
    return id;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function deleteKnowledgeEntry(uid: string, id: string): Promise<void> {
  if (id === "master") return;
  const path = `users/${uid}/knowledge/${id}`;
  try {
    await deleteDoc(doc(db, "users", uid, "knowledge", id));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export async function addKnowledgeSource(
  uid: string,
  input: { label: string; kind: KnowledgeSource["kind"]; url?: string | null; content?: string | null },
): Promise<string> {
  const id = randomId("src");
  const path = `users/${uid}/knowledgeSources/${id}`;
  try {
    await setDoc(doc(db, "users", uid, "knowledgeSources", id), {
      ownerId: uid,
      label: clampReqStr(input.label, 200, "Reference source"),
      kind: input.kind,
      url: clampStr(input.url, 1000),
      content: clampStr(input.content, 700_000),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return id;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function deleteKnowledgeSource(uid: string, id: string): Promise<void> {
  const path = `users/${uid}/knowledgeSources/${id}`;
  try {
    await deleteDoc(doc(db, "users", uid, "knowledgeSources", id));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export function formatKnowledgeDigest(
  bundle: { master: string; entries: KnowledgeEntry[]; sources: KnowledgeSource[] },
  fetchedUrlText: Record<string, string> = {},
  maxChars = 60_000,
): string {
  let out = "";
  const push = (block: string) => {
    if (!block.trim()) return;
    if (out.length + block.length > maxChars) {
      out += block.slice(0, Math.max(0, maxChars - out.length));
      return;
    }
    out += block + "\n\n";
  };

  if (bundle.master.trim()) push(`# MASTER KNOWLEDGE (authoritative)\n${bundle.master.trim()}`);
  if (bundle.sources.length) {
    const blocks: string[] = [];
    for (const source of bundle.sources.slice(0, 12)) {
      const body = fetchedUrlText[source.id] ?? source.content ?? "";
      blocks.push(`## Source: ${source.label}${source.url ? ` (${source.url})` : ""}\n${body.slice(0, 20_000)}`);
    }
    push(`# REFERENCE SOURCES\n${blocks.join("\n\n")}`);
  }
  for (const entry of bundle.entries.slice(0, 40)) {
    push(`## ${entry.title}\n${entry.content.trim()}`);
  }
  return out.trim();
}

// ---------------------------------------------------------------------------
// Audit & Lead Events
// ---------------------------------------------------------------------------

export async function writeAuditLog(
  uid: string,
  action: string,
  entity: string,
  entityId: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  const id = randomId("aud");
  const path = `users/${uid}/auditLogs/${id}`;
  try {
    await setDoc(doc(db, "users", uid, "auditLogs", id), {
      ownerId: uid,
      action: clampReqStr(action, 120, "event"),
      entity: clampReqStr(entity, 80, "workspace"),
      entity_id: clampReqStr(entityId, 128, "root"),
      detail: detail ?? null,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function writeLeadEvent(
  uid: string,
  leadId: string,
  action: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  const id = randomId("evt");
  const path = `users/${uid}/leadEvents/${id}`;
  try {
    await setDoc(doc(db, "users", uid, "leadEvents", id), {
      ownerId: uid,
      lead_id: leadId,
      action: clampReqStr(action, 80, "event"),
      detail: detail ?? null,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function listAuditLogs(uid: string): Promise<AuditLog[]> {
  const path = `users/${uid}/auditLogs`;
  try {
    const snap = await getDocs(query(collection(db, path), where("ownerId", "==", uid)));
    return snap.docs
      .map((d) => {
        const data = d.data();
        return {
          id: d.id,
          action: String(data.action ?? ""),
          entity: String(data.entity ?? ""),
          entity_id: String(data.entity_id ?? ""),
          detail: (data.detail as Record<string, unknown> | null) ?? null,
          created_at: tsToIso(data.createdAt),
        };
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 40);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

function mapCampaign(id: string, data: Record<string, unknown>): Campaign {
  return {
    id,
    ownerId: String(data.ownerId ?? ""),
    name: String(data.name ?? ""),
    instruction: data.instruction ? String(data.instruction) : null,
    config: normalizeCampaignConfig(data.config as Partial<CampaignConfig>, DEFAULT_SETTINGS),
    status: (data.status as Campaign["status"]) ?? "draft",
    sheet_source: data.sheet_source ? String(data.sheet_source) : null,
    approved_at: data.approved_at ? String(data.approved_at) : null,
    created_at: tsToIso(data.createdAt),
    updated_at: tsToIso(data.updatedAt),
  };
}

export async function listCampaigns(uid: string): Promise<Campaign[]> {
  const path = `users/${uid}/campaigns`;
  try {
    const snap = await getDocs(query(collection(db, path), where("ownerId", "==", uid)));
    return snap.docs
      .map((d) => mapCampaign(d.id, d.data()))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function createCampaign(
  uid: string,
  input: {
    name: string;
    instruction?: string | null;
    config: Partial<CampaignConfig>;
    sheetSource?: string | null;
  },
): Promise<Campaign> {
  const settings = await getSettings(uid);
  const id = randomId("camp");
  const path = `users/${uid}/campaigns/${id}`;
  const config = normalizeCampaignConfig(input.config, settings);
  const payload = {
    ownerId: uid,
    name: clampReqStr(input.name, 200, "Untitled campaign"),
    instruction: clampStr(input.instruction, 4000),
    config,
    status: "draft" as const,
    sheet_source: clampStr(input.sheetSource, 500),
    approved_at: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  try {
    await setDoc(doc(db, "users", uid, "campaigns", id), payload);
    await writeAuditLog(uid, "campaign_created", "campaign", id, { name: payload.name });
    const nowIso = new Date().toISOString();
    return {
      id,
      ownerId: uid,
      name: payload.name,
      instruction: payload.instruction,
      config,
      status: "draft",
      sheet_source: payload.sheet_source,
      approved_at: null,
      created_at: nowIso,
      updated_at: nowIso,
    };
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function updateCampaignAction(
  uid: string,
  id: string,
  action: "approve" | "pause" | "resume" | "unarchive" | "archive" | "complete",
): Promise<void> {
  const path = `users/${uid}/campaigns/${id}`;
  const ref = doc(db, "users", uid, "campaigns", id);
  try {
    const nowIso = new Date().toISOString();
    if (action === "approve") {
      await updateDoc(ref, { status: "approved", approved_at: nowIso, updatedAt: serverTimestamp() });
    } else if (action === "pause") {
      await updateDoc(ref, { status: "paused", updatedAt: serverTimestamp() });
    } else if (action === "resume") {
      await updateDoc(ref, { status: "approved", updatedAt: serverTimestamp() });
    } else if (action === "unarchive") {
      await updateDoc(ref, { status: "approved", updatedAt: serverTimestamp() });
    } else if (action === "archive") {
      await updateDoc(ref, { status: "archived", updatedAt: serverTimestamp() });
    } else if (action === "complete") {
      await updateDoc(ref, { status: "completed", updatedAt: serverTimestamp() });
    }
    await writeAuditLog(uid, `campaign_${action}`, "campaign", id);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

// ---------------------------------------------------------------------------
// Delete campaign
// ---------------------------------------------------------------------------

export async function deleteCampaign(uid: string, id: string): Promise<void> {
  const path = `users/${uid}/campaigns/${id}`;
  try {
    await deleteDoc(doc(db, "users", uid, "campaigns", id));
    await writeAuditLog(uid, "campaign_deleted", "campaign", id);
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

function mapLead(id: string, data: Record<string, unknown>): Lead {
  return {
    id,
    ownerId: String(data.ownerId ?? ""),
    campaign_id: data.campaign_id ? String(data.campaign_id) : null,
    business: data.business ? String(data.business) : null,
    contact_name: data.contact_name ? String(data.contact_name) : null,
    role: data.role ? String(data.role) : null,
    email: data.email ? String(data.email) : null,
    email_norm: data.email_norm ? String(data.email_norm) : null,
    website: data.website ? String(data.website) : null,
    phone: data.phone ? String(data.phone) : null,
    location: data.location ? String(data.location) : null,
    industry: data.industry ? String(data.industry) : null,
    notes: data.notes ? String(data.notes) : null,
    extra: data.extra ? String(data.extra) : null,
    source: data.source ? String(data.source) : null,
    source_ref: data.source_ref ? String(data.source_ref) : null,
    sheet_row: typeof data.sheet_row === "number" ? data.sheet_row : null,
    status: (data.status as LeadStatus) ?? "new",
    score: typeof data.score === "number" ? data.score : null,
    priority: (data.priority as Lead["priority"]) ?? null,
    score_reason: (data.score_reason as QualificationResult | null) ?? null,
    research: (data.research as ResearchResult | null) ?? null,
    research_at: data.research_at ? String(data.research_at) : null,
    research_ok: Boolean(data.research_ok),
    manual_research: data.manual_research ? String(data.manual_research) : null,
    last_contacted_at: data.last_contacted_at ? String(data.last_contacted_at) : null,
    created_at: tsToIso(data.createdAt),
    updated_at: tsToIso(data.updatedAt),
  };
}

export async function listLeads(uid: string): Promise<Lead[]> {
  const path = `users/${uid}/leads`;
  try {
    const snap = await getDocs(query(collection(db, path), where("ownerId", "==", uid)));
    return snap.docs
      .map((d) => mapLead(d.id, d.data()))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function createLead(
  uid: string,
  input: {
    business?: string;
    contact_name?: string;
    role?: string;
    email?: string;
    website?: string;
    phone?: string;
    location?: string;
    industry?: string;
    notes?: string;
    source?: string;
    campaignId?: string | null;
  },
): Promise<{ id: string; duplicate: boolean }> {
  const email = normalizeEmail(input.email ?? "");
  const existingLeads = await listLeads(uid);
  if (email) {
    const dup = existingLeads.find((l) => l.email_norm === email);
    if (dup) return { id: dup.id, duplicate: true };
  }
  const id = randomId("lead");
  const path = `users/${uid}/leads/${id}`;
  try {
    await setDoc(doc(db, "users", uid, "leads", id), {
      ownerId: uid,
      campaign_id: input.campaignId ? sanitizeFirestoreId(input.campaignId, "camp") : null,
      business: clampStr(input.business, 240),
      contact_name: clampStr(input.contact_name, 160),
      role: clampStr(input.role, 160),
      email,
      email_norm: email,
      website: clampStr(normalizeWebsite(input.website ?? ""), 500),
      phone: clampStr(input.phone, 64),
      location: clampStr(input.location, 200),
      industry: clampStr(input.industry, 160),
      notes: clampStr(input.notes, 4000),
      extra: null,
      source: clampStr(input.source ?? "manual", 64),
      source_ref: null,
      sheet_row: null,
      status: input.campaignId ? "queued_research" : "new",
      score: null,
      priority: null,
      score_reason: null,
      research: null,
      research_at: null,
      research_ok: false,
      manual_research: null,
      last_contacted_at: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    await writeLeadEvent(uid, id, "lead_created", { source: input.source ?? "manual" });
    return { id, duplicate: false };
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function importSheetRows(
  uid: string,
  input: {
    spreadsheetId: string;
    tab: string;
    rows: string[][];
    mapping?: Partial<Record<LeadField, number>>;
    limit?: number;
    campaignId?: string | null;
  },
): Promise<{ created: number; duplicates: number; skipped: number }> {
  const [header = [], ...body] = input.rows;
  const mapping =
    input.mapping && Object.keys(input.mapping).length
      ? (input.mapping as Record<LeadField, number>)
      : mapHeaders(header);
  const limit = input.limit && input.limit > 0 ? input.limit : body.length;
  const sourceRef = clampStr(`${input.spreadsheetId}|${input.tab}`, 500);

  const existingLeads = await listLeads(uid);
  const existingByEmail = new Map<string, Lead>();
  for (const l of existingLeads) {
    if (l.email_norm) existingByEmail.set(l.email_norm, l);
  }

  let created = 0;
  let duplicates = 0;
  let skipped = 0;

  for (const [index, row] of body.entries()) {
    if (created >= limit) break;
    if (!row || row.every((cell) => !String(cell ?? "").trim())) continue;
    const get = (field: LeadField): string => {
      const col = mapping[field];
      return col === undefined || col < 0 ? "" : String(row[col] ?? "").trim();
    };
    const business = get("business") || get("contact_name");
    const email = normalizeEmail(get("email")) ?? extractEmailsFromRow(row);
    if (!business && !email) {
      skipped += 1;
      continue;
    }

    if (email && existingByEmail.has(email)) {
      duplicates += 1;
      const existing = existingByEmail.get(email)!;
      if (input.campaignId && !existing.campaign_id) {
        const path = `users/${uid}/leads/${existing.id}`;
        try {
          await updateDoc(doc(db, "users", uid, "leads", existing.id), {
            campaign_id: input.campaignId,
            status: existing.status === "new" ? "queued_research" : existing.status,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, path);
        }
      }
      continue;
    }

    const extraPairs = header
      .map((h, i) =>
        mapping && Object.values(mapping).includes(i)
          ? null
          : `${String(h || `col${i + 1}`).trim()}: ${String(row[i] ?? "").trim()}`,
      )
      .filter((v): v is string => v !== null && !v.endsWith(":"));

    const id = randomId("lead");
    const path = `users/${uid}/leads/${id}`;
    try {
      await setDoc(doc(db, "users", uid, "leads", id), {
        ownerId: uid,
        campaign_id: input.campaignId ?? null,
        business: clampStr(business, 240),
        contact_name: clampStr(get("contact_name"), 160),
        role: clampStr(get("role"), 160),
        email,
        email_norm: email,
        website: clampStr(normalizeWebsite(get("website")), 500),
        phone: clampStr(get("phone"), 64),
        location: clampStr(get("location"), 200),
        industry: clampStr(get("industry"), 160),
        notes: clampStr(get("notes"), 4000),
        extra: extraPairs.length ? clampStr(extraPairs.join(" | "), 2000) : null,
        source: "google_sheets",
        source_ref: sourceRef,
        sheet_row: index + 2,
        status: input.campaignId ? "queued_research" : "new",
        score: null,
        priority: null,
        score_reason: null,
        research: null,
        research_at: null,
        research_ok: false,
        manual_research: null,
        last_contacted_at: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      if (email) {
        existingByEmail.set(email, { id, email_norm: email } as Lead);
      }
      created += 1;
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, path);
    }
  }

  await writeAuditLog(uid, "sheets_imported", "spreadsheet", input.spreadsheetId, {
    tab: input.tab,
    created,
    duplicates,
    skipped,
  });
  return { created, duplicates, skipped };
}

export async function assignLeadsToCampaign(
  uid: string,
  campaignId: string,
  config: CampaignConfig,
): Promise<number> {
  const leads = await listLeads(uid);
  const industry =
    config.target_industry && config.target_industry.toLowerCase() !== "any"
      ? config.target_industry.toLowerCase()
      : null;

  const matching = leads
    .filter(
      (l) =>
        l.status === "new" &&
        !l.campaign_id &&
        (!industry || (l.industry ?? "").toLowerCase().includes(industry)),
    )
    .slice(0, config.lead_count);

  for (const lead of matching) {
    const path = `users/${uid}/leads/${lead.id}`;
    try {
      await updateDoc(doc(db, "users", uid, "leads", lead.id), {
        campaign_id: campaignId,
        status: "queued_research",
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  }
  return matching.length;
}

export async function updateLeadFields(
  uid: string,
  id: string,
  patch: {
    manual_research?: string | null;
    notes?: string | null;
    status?: LeadStatus;
    action?: "requeue";
    research?: ResearchResult | null;
    research_at?: string | null;
    research_ok?: boolean;
    score?: number | null;
    priority?: Lead["priority"];
    score_reason?: QualificationResult | null;
    last_contacted_at?: string | null;
  },
): Promise<void> {
  const path = `users/${uid}/leads/${id}`;
  const ref = doc(db, "users", uid, "leads", id);
  try {
    if (patch.action === "requeue") {
      await updateDoc(ref, {
        manual_research: clampStr(patch.manual_research, 8000),
        research: null,
        research_at: null,
        research_ok: false,
        score: null,
        priority: null,
        score_reason: null,
        status: "queued_research",
        updatedAt: serverTimestamp(),
      });
      await writeLeadEvent(uid, id, "requeued_for_research");
      return;
    }
    if (patch.manual_research !== undefined || patch.notes !== undefined) {
      const updatePayload: Record<string, unknown> = { updatedAt: serverTimestamp() };
      if (patch.manual_research !== undefined) {
        updatePayload.manual_research = clampStr(patch.manual_research, 8000);
      }
      if (patch.notes !== undefined) {
        updatePayload.notes = clampStr(patch.notes, 4000);
      }
      await updateDoc(ref, updatePayload);
      return;
    }
    if (patch.research !== undefined) {
      await updateDoc(ref, {
        research: patch.research,
        research_at: patch.research_at ?? new Date().toISOString(),
        research_ok: Boolean(patch.research_ok),
        status: patch.status ?? "researched",
        updatedAt: serverTimestamp(),
      });
      return;
    }
    if (patch.score !== undefined) {
      await updateDoc(ref, {
        score: patch.score === null ? null : clampInt(patch.score, 0, 100, 0),
        priority: patch.priority ?? null,
        score_reason: patch.score_reason ?? null,
        status: patch.status ?? "qualified",
        updatedAt: serverTimestamp(),
      });
      return;
    }
    if (patch.status !== undefined || patch.last_contacted_at !== undefined) {
      const updatePayload: Record<string, unknown> = { updatedAt: serverTimestamp() };
      if (patch.status !== undefined) updatePayload.status = patch.status;
      if (patch.last_contacted_at !== undefined) updatePayload.last_contacted_at = patch.last_contacted_at;
      await updateDoc(ref, updatePayload);
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function deleteLeadCascade(uid: string, leadId: string): Promise<void> {
  const path = `users/${uid}/leads/${leadId}`;
  try {
    const batch = writeBatch(db);
    const [msgs, reps, evts] = await Promise.all([
      getDocs(query(collection(db, `users/${uid}/messages`), where("ownerId", "==", uid))),
      getDocs(query(collection(db, `users/${uid}/replies`), where("ownerId", "==", uid))),
      getDocs(query(collection(db, `users/${uid}/leadEvents`), where("ownerId", "==", uid))),
    ]);
    for (const m of msgs.docs) {
      if (m.data().lead_id === leadId) batch.delete(m.ref);
    }
    for (const r of reps.docs) {
      if (r.data().lead_id === leadId) batch.delete(r.ref);
    }
    for (const e of evts.docs) {
      if (e.data().lead_id === leadId) batch.delete(e.ref);
    }
    batch.delete(doc(db, "users", uid, "leads", leadId));
    await batch.commit();
    await writeAuditLog(uid, "lead_deleted", "lead", leadId);
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function mapMessage(id: string, data: Record<string, unknown>): Message {
  return {
    id,
    ownerId: String(data.ownerId ?? ""),
    lead_id: String(data.lead_id ?? ""),
    campaign_id: data.campaign_id ? String(data.campaign_id) : null,
    step: Number(data.step ?? 1),
    kind: data.kind === "followup" ? "followup" : "initial",
    subject: data.subject ? String(data.subject) : null,
    body: data.body ? String(data.body) : null,
    angle: data.angle ? String(data.angle) : null,
    rationale: data.rationale ? String(data.rationale) : null,
    service: data.service ? String(data.service) : null,
    status: (data.status as Message["status"]) ?? "draft",
    gmail_id: data.gmail_id ? String(data.gmail_id) : null,
    thread_id: data.thread_id ? String(data.thread_id) : null,
    rfc_message_id: data.rfc_message_id ? String(data.rfc_message_id) : null,
    sent_at: data.sent_at ? String(data.sent_at) : null,
    error: data.error ? String(data.error) : null,
    approved_at: data.approved_at ? String(data.approved_at) : null,
    created_at: tsToIso(data.createdAt),
    updated_at: tsToIso(data.updatedAt),
  };
}

export async function listMessages(uid: string): Promise<Message[]> {
  const path = `users/${uid}/messages`;
  try {
    const snap = await getDocs(query(collection(db, path), where("ownerId", "==", uid)));
    return snap.docs
      .map((d) => mapMessage(d.id, d.data()))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function createMessage(
  uid: string,
  input: {
    lead_id: string;
    campaign_id: string | null;
    step: number;
    kind: "initial" | "followup";
    subject: string;
    body: string;
    angle: string;
    rationale: string;
    service: string;
    status: Message["status"];
  },
): Promise<string> {
  const id = randomId("msg");
  const path = `users/${uid}/messages/${id}`;
  const nowIso = new Date().toISOString();
  try {
    await setDoc(doc(db, "users", uid, "messages", id), {
      ownerId: uid,
      lead_id: input.lead_id,
      campaign_id: input.campaign_id ?? null,
      step: clampInt(input.step, 1, 20, 1),
      kind: input.kind,
      subject: clampStr(input.subject, 200),
      body: clampStr(input.body, 12000),
      angle: clampStr(input.angle, 300),
      rationale: clampStr(input.rationale, 4000),
      service: clampStr(input.service, 200),
      status: input.status,
      gmail_id: null,
      thread_id: null,
      rfc_message_id: null,
      sent_at: null,
      error: null,
      approved_at: input.status === "approved" ? nowIso : null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return id;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function updateMessageContent(
  uid: string,
  id: string,
  patch: { subject?: string; body?: string; angle?: string; rationale?: string; service?: string },
): Promise<void> {
  const path = `users/${uid}/messages/${id}`;
  try {
    const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };
    if (patch.subject !== undefined) payload.subject = clampStr(patch.subject, 200);
    if (patch.body !== undefined) payload.body = clampStr(patch.body, 12000);
    if (patch.angle !== undefined) payload.angle = clampStr(patch.angle, 300);
    if (patch.rationale !== undefined) payload.rationale = clampStr(patch.rationale, 4000);
    if (patch.service !== undefined) payload.service = clampStr(patch.service, 200);
    await updateDoc(doc(db, "users", uid, "messages", id), payload);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function updateMessageStatus(
  uid: string,
  id: string,
  status: Message["status"],
  extra?: { approved_at?: string | null; error?: string | null },
): Promise<void> {
  const path = `users/${uid}/messages/${id}`;
  try {
    const payload: Record<string, unknown> = {
      status,
      updatedAt: serverTimestamp(),
    };
    if (extra?.approved_at !== undefined) payload.approved_at = extra.approved_at;
    if (extra?.error !== undefined) payload.error = clampStr(extra.error, 1000);
    await updateDoc(doc(db, "users", uid, "messages", id), payload);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function markMessageSending(uid: string, id: string, rfcMessageId: string): Promise<void> {
  const path = `users/${uid}/messages/${id}`;
  try {
    await updateDoc(doc(db, "users", uid, "messages", id), {
      status: "sending",
      rfc_message_id: clampStr(rfcMessageId, 300),
      error: null,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function markMessageFailed(uid: string, id: string, error: string): Promise<void> {
  const path = `users/${uid}/messages/${id}`;
  try {
    await updateDoc(doc(db, "users", uid, "messages", id), {
      status: "failed",
      error: clampStr(error, 1000),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function recordSendSuccess(
  uid: string,
  message: Message,
  lead: Lead,
  gmailId: string,
  threadId: string,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const msgPath = `users/${uid}/messages/${message.id}`;
  try {
    await updateDoc(doc(db, "users", uid, "messages", message.id), {
      status: "sent",
      gmail_id: clampStr(gmailId, 200),
      thread_id: clampStr(threadId, 200),
      sent_at: nowIso,
      error: null,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, msgPath);
  }

  await updateLeadFields(uid, lead.id, {
    status: message.kind === "followup" ? "followup_pending" : "sent",
    last_contacted_at: nowIso,
  });

  const logId = randomId("snd");
  const logPath = `users/${uid}/sendLogs/${logId}`;
  try {
    await setDoc(doc(db, "users", uid, "sendLogs", logId), {
      ownerId: uid,
      lead_id: lead.id,
      message_id: message.id,
      status: "sent",
      at: nowIso,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, logPath);
  }

  await writeLeadEvent(uid, lead.id, "email_sent", {
    messageId: message.id,
    kind: message.kind,
    gmailId,
  });
}

export async function approveAllMessagesInCampaign(uid: string, campaignId: string): Promise<number> {
  const messages = await listMessages(uid);
  const pending = messages.filter((m) => m.campaign_id === campaignId && m.status === "pending_approval");
  const nowIso = new Date().toISOString();
  for (const m of pending) {
    await updateMessageStatus(uid, m.id, "approved", { approved_at: nowIso });
    await updateLeadFields(uid, m.lead_id, { status: "approved" });
  }
  if (pending.length) {
    await writeAuditLog(uid, "messages_approved_bulk", "campaign", campaignId, { count: pending.length });
  }
  return pending.length;
}

// ---------------------------------------------------------------------------
// Replies & Suppressions & SendLogs
// ---------------------------------------------------------------------------

function mapReply(id: string, data: Record<string, unknown>): Reply {
  return {
    id,
    ownerId: String(data.ownerId ?? ""),
    lead_id: data.lead_id ? String(data.lead_id) : null,
    thread_id: data.thread_id ? String(data.thread_id) : null,
    gmail_id: String(data.gmail_id ?? ""),
    from_email: data.from_email ? String(data.from_email) : null,
    subject: data.subject ? String(data.subject) : null,
    snippet: data.snippet ? String(data.snippet) : null,
    body: data.body ? String(data.body) : null,
    received_at: data.received_at ? String(data.received_at) : null,
    classification: String(data.classification ?? "other"),
    summary: data.summary ? String(data.summary) : null,
    recommended_action: data.recommended_action ? String(data.recommended_action) : null,
    draft_reply: data.draft_reply ? String(data.draft_reply) : null,
    handled: Boolean(data.handled),
    created_at: tsToIso(data.createdAt),
    updated_at: tsToIso(data.updatedAt),
  };
}

export async function listReplies(uid: string): Promise<Reply[]> {
  const path = `users/${uid}/replies`;
  try {
    const snap = await getDocs(query(collection(db, path), where("ownerId", "==", uid)));
    return snap.docs
      .map((d) => mapReply(d.id, d.data()))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function recordReply(
  uid: string,
  input: {
    lead_id: string | null;
    thread_id: string | null;
    gmail_id: string;
    from_email: string | null;
    subject: string | null;
    snippet: string | null;
    body: string | null;
    received_at: string | null;
    classification: string;
    summary: string | null;
    recommended_action: string | null;
    draft_reply: string | null;
  },
): Promise<string> {
  const id = sanitizeFirestoreId(input.gmail_id, "rep");
  const path = `users/${uid}/replies/${id}`;
  const ref = doc(db, "users", uid, "replies", id);
  try {
    const existing = await getDoc(ref);
    if (existing.exists()) return id;
    await setDoc(ref, {
      ownerId: uid,
      lead_id: input.lead_id ?? null,
      thread_id: clampStr(input.thread_id, 200),
      gmail_id: clampReqStr(input.gmail_id, 200, id),
      from_email: clampStr(input.from_email, 320),
      subject: clampStr(input.subject, 300),
      snippet: clampStr(input.snippet, 1000),
      body: clampStr(input.body, 16000),
      received_at: clampStr(input.received_at, 64),
      classification: input.classification,
      summary: clampStr(input.summary, 2000),
      recommended_action: clampStr(input.recommended_action, 1000),
      draft_reply: clampStr(input.draft_reply, 6000),
      handled: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return id;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function updateReplyHandled(uid: string, id: string, handled: boolean): Promise<void> {
  const path = `users/${uid}/replies/${id}`;
  try {
    await updateDoc(doc(db, "users", uid, "replies", id), {
      handled,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function listSuppressions(uid: string): Promise<Suppression[]> {
  const path = `users/${uid}/suppressions`;
  try {
    const snap = await getDocs(query(collection(db, path), where("ownerId", "==", uid)));
    return snap.docs
      .map((d) => {
        const data = d.data();
        return {
          id: d.id,
          email: String(data.email ?? ""),
          reason: String(data.reason ?? ""),
          created_at: tsToIso(data.createdAt),
          updated_at: tsToIso(data.updatedAt),
        };
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function addSuppression(uid: string, email: string, reason: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || normalized.length < 3) throw new Error("Enter a valid email address.");
  const id = sanitizeFirestoreId(normalized, "sup");
  const path = `users/${uid}/suppressions/${id}`;
  const ref = doc(db, "users", uid, "suppressions", id);
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        ownerId: uid,
        email: clampReqStr(normalized, 320, normalized),
        reason: clampReqStr(reason, 400, "Added manually"),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        reason: clampReqStr(reason, 400, "Updated suppression"),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function removeSuppression(uid: string, email: string): Promise<void> {
  const id = sanitizeFirestoreId(email.trim().toLowerCase(), "sup");
  const path = `users/${uid}/suppressions/${id}`;
  try {
    await deleteDoc(doc(db, "users", uid, "suppressions", id));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export async function listSendLogs(uid: string): Promise<SendLog[]> {
  const path = `users/${uid}/sendLogs`;
  try {
    const snap = await getDocs(query(collection(db, path), where("ownerId", "==", uid)));
    return snap.docs
      .map((d): SendLog => {
        const data = d.data();
        return {
          id: d.id,
          lead_id: String(data.lead_id ?? ""),
          message_id: String(data.message_id ?? ""),
          status: data.status === "failed" ? "failed" : "sent",
          at: String(data.at ?? tsToIso(data.createdAt)),
          created_at: tsToIso(data.createdAt),
        };
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function getSendQuotaState(uid: string, settings: Settings): Promise<{
  sendsTodayCount: number;
  lastSendMs: number | null;
}> {
  const logs = await listSendLogs(uid);
  const { startOfLocalDayUtc } = getLocalSendParts(settings);
  let sendsTodayCount = 0;
  let lastSendMs: number | null = null;
  for (const log of logs) {
    if (log.status !== "sent") continue;
    const ms = new Date(log.at).getTime();
    if (Number.isNaN(ms)) continue;
    if (ms >= startOfLocalDayUtc) sendsTodayCount += 1;
    if (lastSendMs === null || ms > lastSendMs) lastSendMs = ms;
  }
  return { sendsTodayCount, lastSendMs };
}

// ---------------------------------------------------------------------------
// Composite Loaders & Subscriptions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Email open tracking
// ---------------------------------------------------------------------------

function mapOpen(id: string, data: Record<string, unknown>): EmailOpen {
  return {
    id,
    ownerId: String(data.ownerId ?? ""),
    message_id: String(data.message_id ?? ""),
    lead_id: data.lead_id ? String(data.lead_id) : null,
    opened_at: data.opened_at ? String(data.opened_at) : tsToIso(data.createdAt),
    user_agent: data.user_agent ? String(data.user_agent) : null,
  };
}

export async function listOpenEvents(uid: string): Promise<EmailOpen[]> {
  const path = "tracking";
  try {
    const snap = await getDocs(query(collection(db, path), where("ownerId", "==", uid)));
    return snap.docs
      .map((d) => mapOpen(d.id, d.data()))
      .sort((a, b) => b.opened_at.localeCompare(a.opened_at));
  } catch (err) {
    // A missing `tracking` rule or a brand-new account should not break the
    // dashboard, so treat read failures as "no opens recorded yet".
    if (err instanceof Error && /permission|insufficient/i.test(err.message)) return [];
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export function subscribeOpenEvents(
  uid: string,
  onChange: (events: EmailOpen[]) => void,
): () => void {
  return onSnapshot(
    query(collection(db, "tracking"), where("ownerId", "==", uid)),
    (snap) => onChange(snap.docs.map((d) => mapOpen(d.id, d.data()))),
    (err) => {
      if (err instanceof Error && /permission|insufficient/i.test(err.message)) {
        onChange([]);
        return;
      }
      handleFirestoreError(err, OperationType.LIST, "tracking");
    },
  );
}

export async function loadDashboardBundle(uid: string) {
  const [leads, campaigns, messages, replies, sendLogs, auditLogs, knowledge, settings, opens] =
    await Promise.all([
      listLeads(uid),
      listCampaigns(uid),
      listMessages(uid),
      listReplies(uid),
      listSendLogs(uid),
      listAuditLogs(uid),
      getKnowledgeBundle(uid),
      getSettings(uid),
      listOpenEvents(uid),
    ]);

  const stats = computeDashboardStats({
    leads,
    campaigns,
    messages,
    replies,
    sendLogs,
    auditLogs,
  });

  const knowledgeEmpty =
    !knowledge.master.trim() && knowledge.entries.length === 0 && knowledge.sources.length === 0;

  return {
    ...stats,
    settings,
    knowledgeEmpty,
    opens,
  };
}

export async function loadAnalyticsBundle(uid: string) {
  const [leads, campaigns, messages, replies] = await Promise.all([
    listLeads(uid),
    listCampaigns(uid),
    listMessages(uid),
    listReplies(uid),
  ]);
  return computeAnalyticsMetrics({ leads, campaigns, messages, replies });
}

export async function loadFollowupsBundle(uid: string) {
  const [leads, campaigns, messages, replies] = await Promise.all([
    listLeads(uid),
    listCampaigns(uid),
    listMessages(uid),
    listReplies(uid),
  ]);
  const due = findFollowupCandidatesFromData({ leads, campaigns, messages, replies, limit: 50 }).map(
    (c) => ({
      leadId: c.lead.id,
      business: c.lead.business,
      email: c.lead.email,
      industry: c.lead.industry,
      score: c.lead.score,
      campaignId: c.campaign.id,
      campaignName: c.campaign.name,
      step: c.step,
      daysSince: c.daysSince,
      lastContactedAt: c.lead.last_contacted_at,
    }),
  );
  const leadMap = new Map(leads.map((l) => [l.id, l]));
  const drafted = messages
    .filter((m) => m.kind === "followup" && (m.status === "pending_approval" || m.status === "approved"))
    .map((m) => {
      const lead = leadMap.get(m.lead_id);
      return {
        id: m.id,
        subject: m.subject,
        body: m.body,
        status: m.status,
        step: m.step,
        business: lead?.business ?? null,
        lead_email: lead?.email ?? null,
        created_at: m.created_at,
      };
    });
  const followupsSent = messages.filter((m) => m.kind === "followup" && m.status === "sent").length;
  return { due, drafted, followupsSent };
}

export function subscribeBadgeCounts(
  uid: string,
  onChange: (counts: { review: number; replies: number; followups: number }) => void,
) {
  let latestLeads: Lead[] = [];
  let latestCampaigns: Campaign[] = [];
  let latestMessages: Message[] = [];
  let latestReplies: Reply[] = [];

  const emit = () => {
    const review = latestMessages.filter((m) => m.status === "pending_approval").length;
    const replies = latestReplies.filter((r) => !r.handled).length;
    const followups = findFollowupCandidatesFromData({
      leads: latestLeads,
      campaigns: latestCampaigns,
      messages: latestMessages,
      replies: latestReplies,
    }).length;
    onChange({ review, replies, followups });
  };

  const unsubMsgs = onSnapshot(
    query(collection(db, `users/${uid}/messages`), where("ownerId", "==", uid)),
    (snap) => {
      latestMessages = snap.docs.map((d) => mapMessage(d.id, d.data()));
      emit();
    },
    (err) => handleFirestoreError(err, OperationType.LIST, `users/${uid}/messages`),
  );

  const unsubReplies = onSnapshot(
    query(collection(db, `users/${uid}/replies`), where("ownerId", "==", uid)),
    (snap) => {
      latestReplies = snap.docs.map((d) => mapReply(d.id, d.data()));
      emit();
    },
    (err) => handleFirestoreError(err, OperationType.LIST, `users/${uid}/replies`),
  );

  const unsubLeads = onSnapshot(
    query(collection(db, `users/${uid}/leads`), where("ownerId", "==", uid)),
    (snap) => {
      latestLeads = snap.docs.map((d) => mapLead(d.id, d.data()));
      emit();
    },
    (err) => handleFirestoreError(err, OperationType.LIST, `users/${uid}/leads`),
  );

  const unsubCamps = onSnapshot(
    query(collection(db, `users/${uid}/campaigns`), where("ownerId", "==", uid)),
    (snap) => {
      latestCampaigns = snap.docs.map((d) => mapCampaign(d.id, d.data()));
      emit();
    },
    (err) => handleFirestoreError(err, OperationType.LIST, `users/${uid}/campaigns`),
  );

  return () => {
    unsubMsgs();
    unsubReplies();
    unsubLeads();
    unsubCamps();
  };
}
