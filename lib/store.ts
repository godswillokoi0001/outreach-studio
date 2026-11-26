"use client";

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
  db,
  handleDataError,
  OperationType,
} from "./db-client";

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
  sanitizeId,
} from "./outreach-utils";
import { authedPost } from "./client";
import {
  EMPTY_GROWTH_PROFILE,
  type ExecutedCampaignBlueprint,
  type GrowthAdvisorReport,
  type GrowthProfile,
} from "./growth-advisor";
import {
  DEFAULT_ONBOARDING_ANSWERS,
  compileSectionsToMasterMarkdown,
  prefillAnswersFromUser,
  type KnowledgeVersion,
  type OnboardingState,
  type StructuredKnowledgeBase,
} from "./onboarding";
import type { AppUser } from "./auth";
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
    ai_providers: clampStr(s.ai_providers, 20_000) ?? "",
    ui_prefs: clampStr(s.ui_prefs, 500) ?? "",
  };
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
      ai_providers: String(data.ai_providers ?? ""),
      ui_prefs: String(data.ui_prefs ?? ""),
    };
}

export async function getSettings(uid: string): Promise<Settings> {
  void uid;
  const { fetchSettingsDocument } = await import("./supabase");
  const remote = await fetchSettingsDocument();
  if (!remote.ok) {
    // Never fall back to defaults: an unreadable settings row used to look
    // exactly like a missing AI key and silently reset the whole profile.
    throw new Error(remote.message);
  }
  return remote.settings
    ? toSettings(remote.settings as unknown as Record<string, unknown>)
    : { ...DEFAULT_SETTINGS };
}

export async function saveSettings(uid: string, patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings(uid);
  const payload = normalizeSettingsPayload(uid, patch, current);
  const { saveSettingsDocument } = await import("./supabase");
  const remote = await saveSettingsDocument(payload);
  if (!remote.ok) throw new Error(remote.message);
  return remote.settings
    ? toSettings(remote.settings as unknown as Record<string, unknown>)
    : toSettings(payload as unknown as Record<string, unknown>);
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
    handleDataError(err, OperationType.LIST, kPath);
  }
  try {
    sSnap = await getDocs(query(collection(db, sPath), where("ownerId", "==", uid)));
  } catch (err) {
    handleDataError(err, OperationType.LIST, sPath);
  }

  let master = "";
  const entries: KnowledgeEntry[] = [];
  for (const d of kSnap.docs) {
    const data = d.data();
    const category = String(data.category ?? "custom");
    if (
      category.startsWith("growth_advisor_") ||
      category.startsWith("system_onboarding_") ||
      category.startsWith("system_kb_")
    ) {
      continue;
    }
    if (d.id === "master" || d.id === `master_${uid}` || data.is_master === true || category === "master") {
      const text = String(data.content ?? "");
      if (text.trim() || !master) {
        master = text;
      }
    } else {
      entries.push({
        id: d.id,
        ownerId: String(data.ownerId ?? uid),
        category,
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
  const path = `users/${uid}/knowledge`;
  try {
    const trimmed = String(content ?? "").slice(0, 700_000);
    const snap = await getDocs(query(collection(db, path), where("ownerId", "==", uid)));
    const masterDocs = snap.docs.filter(
      (d) => d.id === "master" || d.id === `master_${uid}` || d.data().is_master === true || d.data().category === "master",
    );

    if (masterDocs.length > 0) {
      for (const d of masterDocs) {
        await updateDoc(d.ref, {
          category: "master",
          title: "Master knowledge",
          content: trimmed,
          sort: 0,
          is_master: true,
          updatedAt: serverTimestamp(),
        });
      }
      return;
    }

    // The master row id is unique across owners, so a new workspace gets its own.
    await setDoc(doc(db, "users", uid, "knowledge", `master_${uid}`), {
      ownerId: uid,
      category: "master",
      title: "Master knowledge",
      content: trimmed,
      sort: 0,
      is_master: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleDataError(err, OperationType.WRITE, path);
  }
}

export async function upsertKnowledgeEntry(
  uid: string,
  input: { id?: string; title: string; content: string; category?: string; sort?: number },
): Promise<string> {
  const id = input.id ? sanitizeId(input.id, "k") : randomId("k");
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
    handleDataError(err, OperationType.WRITE, path);
  }
}

export async function deleteKnowledgeEntry(uid: string, id: string): Promise<void> {
  if (id === "master") return;
  const path = `users/${uid}/knowledge/${id}`;
  try {
    await deleteDoc(doc(db, "users", uid, "knowledge", id));
  } catch (err) {
    handleDataError(err, OperationType.DELETE, path);
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
    handleDataError(err, OperationType.CREATE, path);
  }
}

export async function deleteKnowledgeSource(uid: string, id: string): Promise<void> {
  const path = `users/${uid}/knowledgeSources/${id}`;
  try {
    await deleteDoc(doc(db, "users", uid, "knowledgeSources", id));
  } catch (err) {
    handleDataError(err, OperationType.DELETE, path);
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
    handleDataError(err, OperationType.CREATE, path);
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
    handleDataError(err, OperationType.CREATE, path);
  }
}

export async function listAuditLogs(uid: string): Promise<AuditLog[]> {
  const path = `users/${uid}/auditLogs`;
  try {
    // Only the newest 40 rows are ever shown. Reading the whole audit table
    // (and slicing in the browser) was a pure waste of Supabase disk IO.
    const snap = await getDocs(query(collection(db, path), where("ownerId", "==", uid)), {
      columns: ["id", "action", "entity", "entity_id", "detail", "created_at"],
      order: "created_at.desc",
      limit: 40,
    });
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
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  } catch (err) {
    handleDataError(err, OperationType.LIST, path);
  }
}

export async function clearRecentActivity(
  _uid: string,
  range: "all" | "7d" | "30d" = "all",
): Promise<void> {
  await authedPost<{ ok: boolean }>("/api/activity/clear", { range });
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
    handleDataError(err, OperationType.LIST, path);
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
    handleDataError(err, OperationType.CREATE, path);
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
    handleDataError(err, OperationType.UPDATE, path);
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
    handleDataError(err, OperationType.DELETE, path);
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

export async function listLeads(uid: string, options?: { force?: boolean }): Promise<Lead[]> {
  const path = `users/${uid}/leads`;
  try {
    const snap = await getDocs(
      query(collection(db, path), where("ownerId", "==", uid)),
      options?.force ? { force: true } : undefined,
    );
    return snap.docs
      .map((d) => mapLead(d.id, d.data()))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  } catch (err) {
    handleDataError(err, OperationType.LIST, path);
  }
}

/**
 * The same leads without research JSON, notes or manual research.
 *
 * Dashboards and sidebar counters only read status and dates, and those text
 * columns are by far the heaviest part of the row.
 */
export async function listLeadIndex(uid: string): Promise<Lead[]> {
  const path = `users/${uid}/leads`;
  try {
    const snap = await getDocs(query(collection(db, path), where("ownerId", "==", uid)), {
      columns: [
        "id",
        "campaign_id",
        "business",
        "contact_name",
        "email",
        "industry",
        "location",
        "status",
        "score",
        "priority",
        "research_at",
        "last_contacted_at",
        "created_at",
        "updated_at",
      ],
    });
    return snap.docs.map((d) => mapLead(d.id, d.data()));
  } catch (err) {
    handleDataError(err, OperationType.LIST, path);
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
  // Duplicate detection must see rows added since the last cached read.
  const existingLeads = await listLeads(uid, { force: true });
  if (email) {
    const dup = existingLeads.find((l) => l.email_norm === email);
    if (dup) return { id: dup.id, duplicate: true };
  }
  const id = randomId("lead");
  const path = `users/${uid}/leads/${id}`;
  try {
    await setDoc(doc(db, "users", uid, "leads", id), {
      ownerId: uid,
      campaign_id: input.campaignId ? sanitizeId(input.campaignId, "camp") : null,
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
    handleDataError(err, OperationType.CREATE, path);
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

  const existingLeads = await listLeads(uid, { force: true });
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
          handleDataError(err, OperationType.UPDATE, path);
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
      handleDataError(err, OperationType.CREATE, path);
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
      handleDataError(err, OperationType.UPDATE, path);
    }
  }
  return matching.length;
}

export async function addLeadsToCampaign(
  uid: string,
  campaignId: string,
  leadIds: string[],
): Promise<number> {
  if (leadIds.length === 0) return 0;
  const leads = await listLeads(uid);
  const wanted = new Set(leadIds.map((id) => String(id)));
  const moving = leads.filter((lead) => wanted.has(lead.id) && lead.campaign_id !== campaignId);

  for (const lead of moving) {
    const path = `users/${uid}/leads/${lead.id}`;
    // A brand-new prospect starts at the research queue; anything already
    // researched or contacted keeps its stage so it is never emailed twice,
    // but it now belongs to this campaign.
    const queued = lead.status === "new";
    try {
      await updateDoc(doc(db, "users", uid, "leads", lead.id), {
        campaign_id: campaignId,
        ...(queued ? { status: "queued_research" as LeadStatus } : {}),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleDataError(err, OperationType.UPDATE, path);
    }
  }
  return moving.length;
}

export async function moveLeadsToCampaign(
  uid: string,
  leadIds: string[],
  campaignId: string | null,
): Promise<number> {
  if (leadIds.length === 0) return 0;
  const leads = await listLeads(uid);
  const wanted = new Set(leadIds.map((id) => String(id)));
  const target = campaignId ? sanitizeId(campaignId, "camp") : null;
  const moving = leads.filter((lead) => wanted.has(lead.id) && lead.campaign_id !== target);

  for (const lead of moving) {
    const path = `users/${uid}/leads/${lead.id}`;
    // A prospect that has not been researched or contacted starts fresh in the
    // new campaign. Contacted ones keep their stage so nobody is emailed twice.
    // Taking a prospect out of a campaign parks the untouched ones as new.
    const untouched = ["new", "queued_research", "needs_research"].includes(lead.status);
    const status = target
      ? untouched
        ? ("queued_research" as LeadStatus)
        : lead.status
      : lead.status === "queued_research"
        ? ("new" as LeadStatus)
        : lead.status;
    try {
      await updateDoc(doc(db, "users", uid, "leads", lead.id), {
        campaign_id: target,
        ...(status !== lead.status ? { status } : {}),
        updatedAt: serverTimestamp(),
      });
      await writeLeadEvent(uid, lead.id, target ? "moved_to_campaign" : "removed_from_campaign", {
        from: lead.campaign_id,
        to: target,
      });
    } catch (err) {
      handleDataError(err, OperationType.UPDATE, path);
    }
  }
  return moving.length;
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
    handleDataError(err, OperationType.UPDATE, path);
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
    handleDataError(err, OperationType.DELETE, path);
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
    kind:
      data.kind === "followup" ? "followup" : data.kind === "reply" ? "reply" : "initial",
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
    handleDataError(err, OperationType.LIST, path);
  }
}

/** Message rows without subject/body/rationale, for counters and badges. */
export async function listMessageIndex(uid: string): Promise<Message[]> {
  const path = `users/${uid}/messages`;
  try {
    const snap = await getDocs(query(collection(db, path), where("ownerId", "==", uid)), {
      columns: [
        "id",
        "lead_id",
        "campaign_id",
        "step",
        "kind",
        "angle",
        "status",
        "gmail_id",
        "thread_id",
        "rfc_message_id",
        "sent_at",
        "error",
        "approved_at",
        "created_at",
        "updated_at",
      ],
    });
    return snap.docs.map((d) => mapMessage(d.id, d.data()));
  } catch (err) {
    handleDataError(err, OperationType.LIST, path);
  }
}

/**
 * Delete one email record. Used for drafts that will never send (rejected or
 * failed), where keeping the row only clutters the review queue.
 */
export async function deleteMessage(uid: string, id: string): Promise<void> {
  const path = `users/${uid}/messages/${id}`;
  try {
    await deleteDoc(doc(db, "users", uid, "messages", id));
    await writeAuditLog(uid, "message_deleted", "message", id);
  } catch (err) {
    handleDataError(err, OperationType.DELETE, path);
  }
}

/**
 * Delete many emails at once, together with the open events recorded against
 * them. Deleting one row per request would time out on a long queue, so the
 * rows go out as one batch and the open events as chunked batches.
 */
export async function deleteMessages(uid: string, ids: string[]): Promise<number> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return 0;
  const path = `users/${uid}/messages`;
  const wanted = new Set(unique);
  try {
    // The API checks ownership of every op before deleting it, so keep each
    // request small enough to finish well inside its time limit.
    for (let i = 0; i < unique.length; i += 40) {
      const batch = writeBatch(db);
      for (const id of unique.slice(i, i + 40)) batch.delete(doc(db, "users", uid, "messages", id));
      await batch.commit();
    }

    const snap = await getDocs(query(collection(db, "tracking"), where("ownerId", "==", uid)), {
      columns: ["id", "message_id"],
    });
    const orphaned = snap.docs.filter((d) => wanted.has(String(d.data().message_id ?? "")));
    for (let i = 0; i < orphaned.length; i += 100) {
      const chunk = writeBatch(db);
      for (const openDoc of orphaned.slice(i, i + 100)) chunk.delete(openDoc.ref);
      await chunk.commit();
    }

    await writeAuditLog(uid, "messages_deleted", "message", unique[0], { count: unique.length });
    return unique.length;
  } catch (err) {
    handleDataError(err, OperationType.DELETE, path);
  }
}

export async function createMessage(
  uid: string,
  input: {
    lead_id: string;
    campaign_id: string | null;
    step: number;
    kind: "initial" | "followup" | "reply";
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
    handleDataError(err, OperationType.CREATE, path);
  }
}

/** Store a reply the operator sent from the app so the thread stays complete. */
export async function recordOutgoingReply(
  uid: string,
  input: {
    lead_id: string;
    campaign_id: string | null;
    subject: string;
    body: string;
    gmail_id: string;
    thread_id: string | null;
  },
): Promise<string> {
  const id = randomId("msg");
  const path = `users/${uid}/messages/${id}`;
  const nowIso = new Date().toISOString();
  try {
    await setDoc(doc(db, "users", uid, "messages", id), {
      ownerId: uid,
      lead_id: input.lead_id,
      campaign_id: input.campaign_id,
      step: 0,
      kind: "reply",
      subject: clampStr(input.subject, 200),
      body: clampStr(input.body, 12000),
      angle: null,
      rationale: null,
      service: null,
      status: "sent",
      gmail_id: clampStr(input.gmail_id, 200),
      thread_id: clampStr(input.thread_id, 200),
      rfc_message_id: null,
      sent_at: nowIso,
      error: null,
      approved_at: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return id;
  } catch (err) {
    handleDataError(err, OperationType.CREATE, path);
  }
}

/**
 * Deterministic id for the saved draft of one conversation reply: saving the
 * same reply again updates the same row instead of piling up copies.
 */
export function replyDraftMessageId(replyId: string): string {
  return sanitizeId(`replydraft_${replyId}`, "msg");
}

/**
 * Store the reply the user is still writing as a real message row with status
 * "draft". The browser also mirrors drafts locally, but this is the copy that
 * survives a different device, a cleared cache or an expired session.
 */
export async function saveReplyDraftMessage(
  uid: string,
  input: {
    replyId: string;
    lead_id: string;
    campaign_id: string | null;
    subject: string;
    body: string;
  },
): Promise<string> {
  const id = replyDraftMessageId(input.replyId);
  const path = `users/${uid}/messages/${id}`;
  try {
    await setDoc(doc(db, "users", uid, "messages", id), {
      ownerId: uid,
      lead_id: input.lead_id,
      campaign_id: input.campaign_id,
      step: 0,
      kind: "reply",
      subject: clampStr(input.subject, 200),
      body: clampStr(input.body, 12000),
      angle: null,
      rationale: null,
      service: null,
      status: "draft",
      gmail_id: null,
      thread_id: null,
      rfc_message_id: null,
      sent_at: null,
      error: null,
      approved_at: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    await writeAuditLog(uid, "reply_draft_saved", "reply", input.replyId);
    return id;
  } catch (err) {
    handleDataError(err, OperationType.CREATE, path);
  }
}

/** Remove a saved reply draft (after it was sent or the user discarded it). */
export async function deleteReplyDraftMessage(uid: string, replyId: string): Promise<void> {
  const id = replyDraftMessageId(replyId);
  const path = `users/${uid}/messages/${id}`;
  try {
    await deleteDoc(doc(db, "users", uid, "messages", id));
    await writeAuditLog(uid, "reply_draft_discarded", "reply", replyId);
  } catch (err) {
    handleDataError(err, OperationType.DELETE, path);
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
    handleDataError(err, OperationType.UPDATE, path);
  }
}

export async function updateMessageStatus(
  uid: string,
  id: string,
  status: Message["status"],
  extra?: {
    approved_at?: string | null;
    error?: string | null;
    /** Cleared when a sent email is taken back to the review queue. */
    sent_at?: string | null;
    gmail_id?: string | null;
    thread_id?: string | null;
  },
): Promise<void> {
  const path = `users/${uid}/messages/${id}`;
  try {
    const payload: Record<string, unknown> = {
      status,
      updatedAt: serverTimestamp(),
    };
    if (extra?.approved_at !== undefined) payload.approved_at = extra.approved_at;
    if (extra?.error !== undefined) payload.error = clampStr(extra.error, 1000);
    if (extra?.sent_at !== undefined) payload.sent_at = extra.sent_at;
    if (extra?.gmail_id !== undefined) payload.gmail_id = extra.gmail_id;
    if (extra?.thread_id !== undefined) payload.thread_id = extra.thread_id;
    await updateDoc(doc(db, "users", uid, "messages", id), payload);
  } catch (err) {
    handleDataError(err, OperationType.UPDATE, path);
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
    handleDataError(err, OperationType.UPDATE, path);
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
    handleDataError(err, OperationType.UPDATE, path);
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
    handleDataError(err, OperationType.UPDATE, msgPath);
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
    handleDataError(err, OperationType.CREATE, logPath);
  }

  await writeLeadEvent(uid, lead.id, "email_sent", {
    messageId: message.id,
    kind: message.kind,
    gmailId,
  });
}

export async function approveAllMessagesInCampaign(uid: string, campaignId: string): Promise<number> {
  const { evaluateLeadSendEligibility } = await import("./guardrails");
  const [messages, leads, campaigns, suppressions, settings] = await Promise.all([
    listMessages(uid),
    listLeads(uid),
    listCampaigns(uid),
    listSuppressions(uid),
    getSettings(uid),
  ]);
  const leadMap = new Map(leads.map((l) => [l.id, l]));
  const campaign = campaigns.find((c) => c.id === campaignId) ?? null;
  const supSet = new Set(suppressions.map((s) => s.email.toLowerCase()));

  const pending = messages.filter((m) => m.campaign_id === campaignId && m.status === "pending_approval");
  const nowIso = new Date().toISOString();
  let approvedCount = 0;

  for (const m of pending) {
    const lead = leadMap.get(m.lead_id);
    if (!lead) continue;
    const gate = evaluateLeadSendEligibility({
      lead,
      campaign,
      minScore: campaign?.config.min_score ?? settings.min_score,
      senderEmail: settings.sender_email,
      suppressedEmails: supSet,
    });
    if (!gate.eligible) continue;

    await updateMessageStatus(uid, m.id, "approved", { approved_at: nowIso });
    await updateLeadFields(uid, m.lead_id, { status: "approved" });
    approvedCount += 1;
  }
  if (approvedCount > 0) {
    await writeAuditLog(uid, "messages_approved_bulk", "campaign", campaignId, { count: approvedCount });
  }
  return approvedCount;
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
    handleDataError(err, OperationType.LIST, path);
  }
}

/** Reply rows without the full email body, for counters and badges. */
/**
 * Delete reply records. The Gmail messages are untouched, but the inbox sync
 * would otherwise re-import everything still inside its 21-day window, so each
 * deletion is also recorded as a dismissal keyed by Gmail message id.
 */
export async function deleteReplies(
  uid: string,
  replies: { id: string; gmail_id?: string | null }[],
): Promise<number> {
  const unique = replies.filter((reply) => reply.id);
  if (unique.length === 0) return 0;
  const path = `users/${uid}/replies`;
  try {
    for (let i = 0; i < unique.length; i += 100) {
      const batch = writeBatch(db);
      for (const reply of unique.slice(i, i + 100)) {
        batch.delete(doc(db, "users", uid, "replies", reply.id));
      }
      await batch.commit();
    }
    for (const reply of unique) {
      await writeAuditLog(uid, "reply_deleted", "reply", reply.gmail_id || reply.id);
    }
    return unique.length;
  } catch (err) {
    handleDataError(err, OperationType.DELETE, path);
    return 0;
  }
}

/** Gmail ids whose reply record was deleted, so the inbox sync leaves them out. */
export async function listDismissedReplyIds(uid: string): Promise<Set<string>> {
  const path = `users/${uid}/auditLogs`;
  try {
    const snap = await getDocs(query(collection(db, path), where("ownerId", "==", uid)), {
      columns: ["id", "action", "entity_id", "created_at"],
      order: "created_at.desc",
      limit: 1000,
    });
    const ids = new Set<string>();
    for (const d of snap.docs) {
      const row = d.data();
      if (row.action === "reply_deleted" && row.entity_id) ids.add(String(row.entity_id));
    }
    return ids;
  } catch {
    // A missing audit read must not stop an inbox sync.
    return new Set();
  }
}

export async function listReplyIndex(uid: string): Promise<Reply[]> {
  const path = `users/${uid}/replies`;
  try {
    const snap = await getDocs(query(collection(db, path), where("ownerId", "==", uid)), {
      columns: ["id", "lead_id", "classification", "handled", "received_at", "created_at"],
    });
    return snap.docs.map((d) => mapReply(d.id, d.data()));
  } catch (err) {
    handleDataError(err, OperationType.LIST, path);
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
  const id = sanitizeId(input.gmail_id, "rep");
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
    handleDataError(err, OperationType.CREATE, path);
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
    handleDataError(err, OperationType.UPDATE, path);
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
    handleDataError(err, OperationType.LIST, path);
  }
}

export async function addSuppression(uid: string, email: string, reason: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || normalized.length < 3) throw new Error("Enter a valid email address.");
  const id = sanitizeId(normalized, "sup");
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
    handleDataError(err, OperationType.WRITE, path);
  }
}

export async function removeSuppression(uid: string, email: string): Promise<void> {
  const id = sanitizeId(email.trim().toLowerCase(), "sup");
  const path = `users/${uid}/suppressions/${id}`;
  try {
    await deleteDoc(doc(db, "users", uid, "suppressions", id));
  } catch (err) {
    handleDataError(err, OperationType.DELETE, path);
  }
}

export async function listSendLogs(uid: string): Promise<SendLog[]> {
  const path = `users/${uid}/sendLogs`;
  try {
    const snap = await getDocs(query(collection(db, path), where("ownerId", "==", uid)), {
      columns: ["id", "lead_id", "message_id", "status", "at", "created_at"],
      order: "created_at.desc",
      limit: 1000,
    });
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
    handleDataError(err, OperationType.LIST, path);
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
    const snap = await getDocs(query(collection(db, path), where("ownerId", "==", uid)), {
      columns: ["id", "message_id", "lead_id", "opened_at", "user_agent"],
      order: "opened_at.asc",
      limit: 5000,
    });
    return snap.docs
      .map((d) => mapOpen(d.id, d.data()))
      .sort((a, b) => a.opened_at.localeCompare(b.opened_at));
  } catch (err) {
    handleDataError(err, OperationType.LIST, path);
    return [];
  }
}

/**
 * Delete every recorded open, so the Opened column and its notifications start
 * from empty. New opens are still recorded afterwards; only the history goes.
 */
export async function clearOpenEvents(uid: string): Promise<number> {
  const path = "tracking";
  try {
    const snap = await getDocs(query(collection(db, path), where("ownerId", "==", uid)), {
      columns: ["id"],
    });
    const docs = snap.docs;
    // One write per 100 rows: the API applies batch ops in sequence, so a
    // single 5,000-op request would time out before it finished.
    for (let i = 0; i < docs.length; i += 100) {
      const batch = writeBatch(db);
      for (const openDoc of docs.slice(i, i + 100)) batch.delete(openDoc.ref);
      await batch.commit();
    }
    if (docs.length) await writeAuditLog(uid, "open_history_cleared", "tracking", "all", { count: docs.length });
    return docs.length;
  } catch (err) {
    handleDataError(err, OperationType.DELETE, path);
    return 0;
  }
}

/**
 * Subscribes to new email-open events for `uid`.
 *
 * The underlying store has no push subscriptions, so the listener polls
 * `/api/data?table=email_opens` every 15s and replays the full result each
 * tick. To avoid re-firing old opens, the subscriber keeps the most recent
 * snapshot and only emits events strictly newer than that snapshot.
 */
export function subscribeOpenEvents(
  uid: string,
  onOpen: (events: EmailOpen[], latest: EmailOpen | null) => void,
): () => void {
  let last: EmailOpen[] = [];
  let active = true;

  const tick = () => {
    if (!active) return;
    if (typeof document !== "undefined" && document.hidden) return;
    getDocs(query(collection(db, "tracking"), where("ownerId", "==", uid)), {
      columns: ["id", "message_id", "lead_id", "opened_at"],
      order: "opened_at.desc",
      limit: 200,
      force: true,
    })
      .then((snap) =>
        snap.docs
          .map((d) => mapOpen(d.id, d.data()))
          .sort((a, b) => a.opened_at.localeCompare(b.opened_at)),
      )
      .then((current) => {
        if (!active) return;

        // Only emit events newer than what we last handed to the caller, but
        // always report the newest row: the notification menu needs to know
        // whether anything is still unread.
        const cutoff = last.length ? last[last.length - 1].opened_at : "";
        const next = current.filter((e) => e.opened_at > cutoff);
        last = current;
        onOpen(next, current.length ? current[current.length - 1] : null);
      })
      .catch((err) => {
        if (active) handleDataError(err, OperationType.LIST, "tracking");
      });
  };

  // Prime the baseline immediately, then poll once a minute while visible.
  tick();
  const timer = setInterval(tick, 60_000);
  const onVisible = () => {
    if (!document.hidden) tick();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);

  return () => {
    active = false;
    clearInterval(timer);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
  };
}

/**
 * True when the workspace has no knowledge at all.
 *
 * The dashboard only needs to know whether knowledge exists, and the master
 * document can be hundreds of kilobytes. Reading its content to render a
 * checkmark was the single heaviest query on the home screen.
 */
export async function getKnowledgePresence(uid: string): Promise<boolean> {
  try {
    const [entries, sources] = await Promise.all([
      getDocs(query(collection(db, `users/${uid}/knowledge`), where("ownerId", "==", uid)), {
        columns: ["id", "is_master", "category"],
      }),
      getDocs(query(collection(db, `users/${uid}/knowledgeSources`), where("ownerId", "==", uid)), {
        columns: ["id"],
      }),
    ]);
    const userKnowledgeDocs = entries.docs.filter((d) => {
      const cat = String(d.data().category ?? "");
      return (
        !cat.startsWith("growth_advisor_") &&
        !cat.startsWith("system_onboarding_") &&
        !cat.startsWith("system_kb_")
      );
    });
    return userKnowledgeDocs.length === 0 && sources.docs.length === 0;
  } catch (err) {
    handleDataError(err, OperationType.LIST, `users/${uid}/knowledge`);
  }
}

export async function loadDashboardBundle(uid: string) {
  const [leads, campaigns, messages, replies, sendLogs, auditLogs, knowledgeEmpty, settings, opens] =
    await Promise.all([
      listLeadIndex(uid),
      listCampaigns(uid),
      listMessageIndex(uid),
      listReplyIndex(uid),
      listSendLogs(uid),
      listAuditLogs(uid),
      getKnowledgePresence(uid),
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

  return {
    ...stats,
    settings,
    knowledgeEmpty,
    opens,
  };
}

export async function loadAnalyticsBundle(uid: string) {
  const [leads, campaigns, messages, replies] = await Promise.all([
    listLeadIndex(uid),
    listCampaigns(uid),
    listMessageIndex(uid),
    listReplyIndex(uid),
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
  onChange: (counts: {
    review: number;
    replies: number;
    followups: number;
    /** ISO time of the newest synced reply, or "" when there is none. */
    latestReplyAt: string;
  }) => void,
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
    const latestReplyAt = latestReplies.reduce(
      (latest, reply) => (reply.received_at && reply.received_at > latest ? reply.received_at : latest),
      "",
    );
    onChange({ review, replies, followups, latestReplyAt });
  };

  // Counters only need the light columns: polling email bodies every minute
  // just to show a badge number is what exhausted the disk IO budget.
  const unsubMsgs = onSnapshot(
    query(collection(db, `users/${uid}/messages`), where("ownerId", "==", uid)),
    (snap) => {
      latestMessages = snap.docs.map((d) => mapMessage(d.id, d.data()));
      emit();
    },
    (err) => handleDataError(err, OperationType.LIST, `users/${uid}/messages`),
    {
      // Reply notification is driven by the inbox sync (manual or every ten
      // minutes), so badge counters do not need a minute-by-minute read.
      pollMs: 3 * 60_000,
      columns: [
        "id",
        "lead_id",
        "campaign_id",
        "step",
        "kind",
        "status",
        "sent_at",
        "approved_at",
        "created_at",
        "updated_at",
      ],
    },
  );

  const unsubReplies = onSnapshot(
    query(collection(db, `users/${uid}/replies`), where("ownerId", "==", uid)),
    (snap) => {
      latestReplies = snap.docs.map((d) => mapReply(d.id, d.data()));
      emit();
    },
    (err) => handleDataError(err, OperationType.LIST, `users/${uid}/replies`),
    { pollMs: 3 * 60_000, columns: ["id", "lead_id", "classification", "handled", "received_at", "created_at"] },
  );

  const unsubLeads = onSnapshot(
    query(collection(db, `users/${uid}/leads`), where("ownerId", "==", uid)),
    (snap) => {
      latestLeads = snap.docs.map((d) => mapLead(d.id, d.data()));
      emit();
    },
    (err) => handleDataError(err, OperationType.LIST, `users/${uid}/leads`),
    {
      pollMs: 3 * 60_000,
      columns: [
        "id",
        "campaign_id",
        "status",
        "score",
        "priority",
        "research_at",
        "last_contacted_at",
        "created_at",
        "updated_at",
      ],
    },
  );

  const unsubCamps = onSnapshot(
    query(collection(db, `users/${uid}/campaigns`), where("ownerId", "==", uid)),
    (snap) => {
      latestCampaigns = snap.docs.map((d) => mapCampaign(d.id, d.data()));
      emit();
    },
    (err) => handleDataError(err, OperationType.LIST, `users/${uid}/campaigns`),
    { pollMs: 3 * 60_000 },
  );

  return () => {
    unsubMsgs();
    unsubReplies();
    unsubLeads();
    unsubCamps();
  };
}

// ---------------------------------------------------------------------------
// Growth Advisor persistence & execution
// ---------------------------------------------------------------------------

export async function getGrowthProfile(uid: string): Promise<GrowthProfile> {
  const docId = `growth_advisor_profile_${uid}`;
  try {
    const snap = await getDoc(doc(db, "users", uid, "knowledge", docId));
    if (!snap.exists()) return { ...EMPTY_GROWTH_PROFILE };
    const raw = JSON.parse(String(snap.data().content ?? "{}")) as Partial<GrowthProfile>;
    return {
      whoYouAre: String(raw.whoYouAre ?? ""),
      whatYouSell: String(raw.whatYouSell ?? ""),
      industry: String(raw.industry ?? ""),
      offer: String(raw.offer ?? ""),
      priceRange: String(raw.priceRange ?? ""),
      location: String(raw.location ?? ""),
      idealCustomer: String(raw.idealCustomer ?? ""),
      updatedAt: raw.updatedAt ? String(raw.updatedAt) : undefined,
    };
  } catch {
    return { ...EMPTY_GROWTH_PROFILE };
  }
}

export async function saveGrowthProfile(uid: string, profile: GrowthProfile): Promise<GrowthProfile> {
  const docId = `growth_advisor_profile_${uid}`;
  const path = `users/${uid}/knowledge/${docId}`;
  const next: GrowthProfile = {
    ...profile,
    updatedAt: new Date().toISOString(),
  };
  try {
    const ref = doc(db, "users", uid, "knowledge", docId);
    const snap = await getDoc(ref);
    const serialized = JSON.stringify(next);
    if (!snap.exists()) {
      await setDoc(ref, {
        ownerId: uid,
        category: "growth_advisor_profile",
        title: "Growth Advisor Business Profile",
        content: serialized,
        sort: 999,
        is_master: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        category: "growth_advisor_profile",
        content: serialized,
        updatedAt: serverTimestamp(),
      });
    }
    return next;
  } catch (err) {
    handleDataError(err, OperationType.WRITE, path);
  }
}

export async function getGrowthAdvisorReport(uid: string): Promise<GrowthAdvisorReport | null> {
  const docId = `growth_advisor_report_${uid}`;
  try {
    const snap = await getDoc(doc(db, "users", uid, "knowledge", docId));
    if (!snap.exists()) return null;
    const raw = JSON.parse(String(snap.data().content ?? "null")) as GrowthAdvisorReport | null;
    if (!raw || !Array.isArray(raw.recommendations)) return null;
    return raw;
  } catch {
    return null;
  }
}

export async function saveGrowthAdvisorReport(uid: string, report: GrowthAdvisorReport): Promise<void> {
  const docId = `growth_advisor_report_${uid}`;
  const path = `users/${uid}/knowledge/${docId}`;
  try {
    const ref = doc(db, "users", uid, "knowledge", docId);
    const snap = await getDoc(ref);
    const serialized = JSON.stringify(report);
    if (!snap.exists()) {
      await setDoc(ref, {
        ownerId: uid,
        category: "growth_advisor_report",
        title: "Growth Advisor Cached Research",
        content: serialized,
        sort: 999,
        is_master: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        category: "growth_advisor_report",
        content: serialized,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleDataError(err, OperationType.WRITE, path);
  }
}

export async function commitExecutedCampaign(
  uid: string,
  blueprint: ExecutedCampaignBlueprint,
): Promise<{ campaign: Campaign; leadsCreated: number; draftsCreated: number }> {
  const selectedProspects = blueprint.prospects.filter((p) => p.selected);
  const campaign = await createCampaign(uid, {
    name: blueprint.campaignName,
    instruction: `${blueprint.goal}\nAngle: ${blueprint.messagingAngle}\nLocation: ${blueprint.targetLocation}\nChannel: ${blueprint.channel}`,
    config: {
      services: blueprint.messagingAngle ? [blueprint.messagingAngle.slice(0, 100)] : ["Growth outreach"],
      target_industry: blueprint.targetIndustry || "General",
      objective: blueprint.goal,
      tone: "consultative",
      min_score: 65,
      lead_count: selectedProspects.length,
      send_limit: blueprint.schedule.dailyLimit,
      followup_days: blueprint.schedule.followupDays,
      auto_approve_initial: false,
      auto_approve_followups: false,
      require_approval: true,
      extra_instructions: `Channel: ${blueprint.channel}\nHook: ${blueprint.hook}\nCompliance: ${blueprint.complianceChecklist.join("; ")}`,
      summary: blueprint.goal,
    },
    sheetSource: "growth_advisor",
  });

  const existingLeads = await listLeads(uid, { force: true });
  const existingEmails = new Set(existingLeads.map((l) => l.email_norm).filter(Boolean));
  let leadsCreated = 0;
  let draftsCreated = 0;
  const nowIso = new Date().toISOString();

  for (const prospect of selectedProspects) {
    const emailNorm = normalizeEmail(prospect.email);
    if (emailNorm && existingEmails.has(emailNorm)) continue;
    if (emailNorm) existingEmails.add(emailNorm);

    const leadId = randomId("lead");
    const firstName = (prospect.contactName || "there").split(/\s+/)[0];
    await setDoc(doc(db, "users", uid, "leads", leadId), {
      ownerId: uid,
      campaign_id: campaign.id,
      business: clampStr(prospect.business, 240),
      contact_name: clampStr(prospect.contactName, 160),
      role: clampStr(prospect.role, 160),
      email: emailNorm,
      email_norm: emailNorm,
      website: clampStr(normalizeWebsite(prospect.website), 500),
      phone: clampStr(prospect.phone, 64),
      location: clampStr(prospect.location, 200),
      industry: clampStr(prospect.industry, 160),
      notes: clampStr(
        `Buying Intent: ${prospect.buyingIntentScore}/100 (${prospect.buyingIntentLevel.toUpperCase()})\nReasoning: ${prospect.buyingIntentReasoning}\nCompliance: ${prospect.complianceNote}`,
        4000,
      ),
      extra: null,
      source: "growth_advisor",
      source_ref: clampStr(prospect.sourceUrl, 500),
      sheet_row: null,
      status: "qualified",
      score: prospect.buyingIntentScore,
      priority: prospect.buyingIntentLevel,
      score_reason: {
        score: prospect.buyingIntentScore,
        category: prospect.buyingIntentLevel,
        reasons: [
          prospect.buyingIntentReasoning,
          ...prospect.signals.map((s) => `${s.signal}: ${s.evidence}`),
        ].filter(Boolean),
        opportunity: blueprint.goal,
        value_tier: prospect.buyingIntentLevel,
        recommended_service: blueprint.messagingAngle || "Growth Offer",
      },
      research: {
        business_name_confirmed: true,
        industry: prospect.industry,
        summary: prospect.buyingIntentReasoning,
        website_status: prospect.website ? "reachable" : "no_site_known",
        website_facts: prospect.signals.map((s) => s.evidence).filter(Boolean),
        verified_facts: [
          ...(prospect.sourceUrl
            ? [{ fact: `Verified public profile on ${prospect.sourceDate}`, source: prospect.sourceUrl }]
            : []),
        ],
        findings: prospect.signals.map((s) => ({
          area: "Buying intent signal",
          observation: s.signal,
          severity: s.strength === "strong" ? "high" : s.strength === "moderate" ? "medium" : "low",
          evidence: s.evidence,
        })),
        inferences: [],
        opportunities: [
          {
            opportunity: blueprint.goal,
            service: blueprint.messagingAngle,
            rationale: prospect.buyingIntentReasoning,
          },
        ],
        recommended_angle: blueprint.messagingAngle,
        confidence: prospect.buyingIntentScore,
        insufficient_data: false,
        notes: `Sourced via Growth Advisor (${prospect.complianceNote})`,
        checked_at: nowIso,
      },
      research_at: nowIso,
      research_ok: true,
      manual_research: null,
      last_contacted_at: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    await writeLeadEvent(uid, leadId, "growth_advisor_prospect_added", {
      campaignId: campaign.id,
      buyingIntentScore: prospect.buyingIntentScore,
    });
    leadsCreated += 1;

    if (emailNorm) {
      const subject = (prospect.draftSubject || blueprint.subjectLine || "Quick question for {{company}}")
        .replace(/\{\{company\}\}/gi, prospect.business)
        .replace(/\{\{first_name\}\}/gi, firstName);
      const body = (prospect.draftBody || blueprint.sampleEmailBody || "")
        .replace(/\{\{company\}\}/gi, prospect.business)
        .replace(/\{\{first_name\}\}/gi, firstName);
      if (body.trim()) {
        await createMessage(uid, {
          lead_id: leadId,
          campaign_id: campaign.id,
          step: 1,
          kind: "initial",
          subject,
          body,
          angle: blueprint.messagingAngle,
          rationale: prospect.buyingIntentReasoning,
          service: blueprint.targetIndustry,
          status: "pending_approval",
        });
        draftsCreated += 1;
      }
    }
  }

  await writeAuditLog(uid, "growth_advisor_executed", "campaign", campaign.id, {
    campaignName: campaign.name,
    leadsCreated,
    draftsCreated,
  });

  return { campaign, leadsCreated, draftsCreated };
}

// ---------------------------------------------------------------------------
// Onboarding & Structured Knowledge Base
// ---------------------------------------------------------------------------

export async function getOnboardingState(uid: string, user?: AppUser | null): Promise<OnboardingState> {
  const docId = `system_onboarding_${uid}`;
  const nowIso = new Date().toISOString();
  try {
    const snap = await getDoc(doc(db, "users", uid, "knowledge", docId));
    if (snap.exists()) {
      const parsed = JSON.parse(String(snap.data().content ?? "{}")) as Partial<OnboardingState>;
      const mergedAnswers = prefillAnswersFromUser(
        { ...DEFAULT_ONBOARDING_ANSWERS, ...(parsed.answers ?? {}) },
        user ?? null,
      );
      return {
        status:
          parsed.status === "completed" || parsed.status === "in_progress" || parsed.status === "not_started"
            ? parsed.status
            : "not_started",
        currentStep: typeof parsed.currentStep === "number" ? Math.max(1, Math.min(12, parsed.currentStep)) : 1,
        answers: mergedAnswers,
        startedAt: parsed.startedAt,
        updatedAt: parsed.updatedAt || nowIso,
        completedAt: parsed.completedAt,
      };
    }

    // No explicit onboarding record yet: distinguish brand-new Google sign-ups from
    // established returning accounts that already populated their workspace.
    const [knowledgeEmpty, campaigns, leads] = await Promise.all([
      getKnowledgePresence(uid),
      listCampaigns(uid),
      listLeadIndex(uid),
    ]);
    const isEstablishedAccount = !knowledgeEmpty || campaigns.length > 0 || leads.length > 0;

    return {
      status: isEstablishedAccount ? "completed" : "not_started",
      currentStep: isEstablishedAccount ? 12 : 1,
      answers: prefillAnswersFromUser({ ...DEFAULT_ONBOARDING_ANSWERS }, user ?? null),
      updatedAt: nowIso,
      completedAt: isEstablishedAccount ? nowIso : undefined,
    };
  } catch {
    return {
      status: "not_started",
      currentStep: 1,
      answers: prefillAnswersFromUser({ ...DEFAULT_ONBOARDING_ANSWERS }, user ?? null),
      updatedAt: nowIso,
    };
  }
}

export async function saveOnboardingState(uid: string, state: OnboardingState): Promise<OnboardingState> {
  const docId = `system_onboarding_${uid}`;
  const path = `users/${uid}/knowledge/${docId}`;
  const next: OnboardingState = {
    ...state,
    updatedAt: new Date().toISOString(),
  };
  try {
    const ref = doc(db, "users", uid, "knowledge", docId);
    const snap = await getDoc(ref);
    const serialized = JSON.stringify(next);
    if (!snap.exists()) {
      await setDoc(ref, {
        ownerId: uid,
        category: "system_onboarding_state",
        title: "Onboarding Progress & Answers",
        content: serialized,
        sort: 999,
        is_master: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        category: "system_onboarding_state",
        content: serialized,
        updatedAt: serverTimestamp(),
      });
    }
    return next;
  } catch (err) {
    handleDataError(err, OperationType.WRITE, path);
  }
}

export async function getStructuredKnowledgeBase(uid: string): Promise<StructuredKnowledgeBase | null> {
  const docId = `system_kb_structured_${uid}`;
  try {
    const snap = await getDoc(doc(db, "users", uid, "knowledge", docId));
    if (!snap.exists()) return null;
    const raw = JSON.parse(String(snap.data().content ?? "null")) as StructuredKnowledgeBase | null;
    if (!raw || !Array.isArray(raw.sections)) return null;
    return raw;
  } catch {
    return null;
  }
}

export async function saveStructuredKnowledgeBase(
  uid: string,
  kb: StructuredKnowledgeBase,
  authorNote = "Updated Knowledge Base",
): Promise<StructuredKnowledgeBase> {
  const docId = `system_kb_structured_${uid}`;
  const path = `users/${uid}/knowledge/${docId}`;
  const nowIso = new Date().toISOString();

  const snapshot: KnowledgeVersion = {
    id: randomId("kbv"),
    timestamp: nowIso,
    summary: `${kb.sections.length} sections · ${kb.missingGaps.length} gaps`,
    authorNote,
    sections: kb.sections.map((s) => ({ ...s })),
  };

  const nextVersions = [snapshot, ...(kb.versions ?? [])].slice(0, 25);
  const nextKb: StructuredKnowledgeBase = {
    ...kb,
    versions: nextVersions,
    updatedAt: nowIso,
  };

  try {
    const ref = doc(db, "users", uid, "knowledge", docId);
    const snap = await getDoc(ref);
    const serialized = JSON.stringify(nextKb);
    if (!snap.exists()) {
      await setDoc(ref, {
        ownerId: uid,
        category: "system_kb_structured",
        title: "Structured Knowledge Base & History",
        content: serialized,
        sort: 999,
        is_master: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        category: "system_kb_structured",
        content: serialized,
        updatedAt: serverTimestamp(),
      });
    }

    // Keep master_${uid} compiled cleanly so all downstream AI tools stay synced automatically.
    const compiledMaster = compileSectionsToMasterMarkdown(nextKb.sections);
    await saveMasterKnowledge(uid, compiledMaster);

    return nextKb;
  } catch (err) {
    handleDataError(err, OperationType.WRITE, path);
  }
}

export async function deleteAllUserProfileAndKnowledgeData(uid: string): Promise<void> {
  const [kSnap, sSnap] = await Promise.all([
    getDocs(query(collection(db, `users/${uid}/knowledge`), where("ownerId", "==", uid))),
    getDocs(query(collection(db, `users/${uid}/knowledgeSources`), where("ownerId", "==", uid))),
  ]);

  const batch = writeBatch(db);
  for (const d of kSnap.docs) {
    batch.delete(d.ref);
  }
  for (const d of sSnap.docs) {
    batch.delete(d.ref);
  }
  await batch.commit();
  await writeAuditLog(uid, "profile_and_knowledge_deleted", "knowledge", uid);
}
