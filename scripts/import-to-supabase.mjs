// Seeds Supabase from the Firestore export produced by scripts/export-firestore.mjs.
// Usage: node --env-file=.env.local scripts/import-to-supabase.mjs
import { readFileSync } from "node:fs";

const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
};

const data = JSON.parse(readFileSync("migration-export/firestore.json", "utf8"));
const owner = data.ownerId;
const collections = data.collections;

const iso = (value) => (typeof value === "string" ? value : value ? new Date(value).toISOString() : null);
const json = (value) => (value === undefined ? null : value);

function common(doc) {
  return {
    id: doc.id,
    owner_id: owner,
    created_at: iso(doc.createdAt) || new Date().toISOString(),
  };
}

const tables = [
  {
    table: "campaigns",
    rows: () =>
      collections.campaigns.map((d) => ({
        ...common(d),
        name: d.name ?? "",
        instruction: json(d.instruction),
        config: d.config ?? {},
        status: d.status ?? "draft",
        sheet_source: json(d.sheet_source),
        approved_at: iso(d.approved_at),
        updated_at: iso(d.updatedAt) || common(d).created_at,
      })),
  },
  {
    table: "leads",
    rows: () =>
      collections.leads.map((d) => ({
        ...common(d),
        campaign_id: json(d.campaign_id),
        business: json(d.business),
        contact_name: json(d.contact_name),
        role: json(d.role),
        email: json(d.email),
        email_norm: json(d.email_norm),
        website: json(d.website),
        phone: json(d.phone),
        location: json(d.location),
        industry: json(d.industry),
        notes: json(d.notes),
        extra: json(d.extra),
        source: json(d.source),
        source_ref: json(d.source_ref),
        sheet_row: json(d.sheet_row),
        status: d.status ?? "new",
        score: json(d.score),
        priority: json(d.priority),
        score_reason: json(d.score_reason),
        research: json(d.research),
        research_at: iso(d.research_at),
        research_ok: Boolean(d.research_ok),
        manual_research: json(d.manual_research),
        last_contacted_at: iso(d.last_contacted_at),
        updated_at: iso(d.updatedAt) || common(d).created_at,
      })),
  },
  {
    table: "messages",
    rows: () =>
      collections.messages.map((d) => ({
        ...common(d),
        lead_id: d.lead_id,
        campaign_id: json(d.campaign_id),
        step: d.step ?? 1,
        kind: d.kind ?? "initial",
        subject: json(d.subject),
        body: json(d.body),
        angle: json(d.angle),
        rationale: json(d.rationale),
        service: json(d.service),
        status: d.status ?? "draft",
        gmail_id: json(d.gmail_id),
        thread_id: json(d.thread_id),
        rfc_message_id: json(d.rfc_message_id),
        sent_at: iso(d.sent_at),
        error: json(d.error),
        approved_at: iso(d.approved_at),
        updated_at: iso(d.updatedAt) || common(d).created_at,
      })),
  },
  {
    table: "replies",
    rows: () =>
      collections.replies.map((d) => ({
        ...common(d),
        lead_id: json(d.lead_id),
        thread_id: json(d.thread_id),
        gmail_id: d.gmail_id,
        from_email: json(d.from_email),
        subject: json(d.subject),
        snippet: json(d.snippet),
        body: json(d.body),
        received_at: iso(d.received_at),
        classification: d.classification ?? "other",
        summary: json(d.summary),
        recommended_action: json(d.recommended_action),
        draft_reply: json(d.draft_reply),
        handled: Boolean(d.handled),
        updated_at: iso(d.updatedAt) || common(d).created_at,
      })),
  },
  {
    table: "suppressions",
    rows: () =>
      collections.suppressions.map((d) => ({
        ...common(d),
        email: d.email,
        reason: d.reason ?? "",
        updated_at: iso(d.updatedAt) || common(d).created_at,
      })),
  },
  {
    table: "send_logs",
    rows: () =>
      collections.sendLogs.map((d) => ({
        id: d.id,
        owner_id: owner,
        lead_id: d.lead_id,
        message_id: d.message_id,
        status: d.status ?? "sent",
        at: iso(d.at) || iso(d.createdAt),
        created_at: iso(d.createdAt) || iso(d.at) || new Date().toISOString(),
      })),
  },
  {
    table: "audit_logs",
    rows: () =>
      collections.auditLogs.map((d) => ({
        id: d.id,
        owner_id: owner,
        action: d.action ?? "",
        entity: d.entity ?? "",
        entity_id: d.entity_id ?? "",
        detail: json(d.detail),
        created_at: iso(d.createdAt) || new Date().toISOString(),
      })),
  },
  {
    table: "lead_events",
    rows: () =>
      collections.leadEvents.map((d) => ({
        id: d.id,
        owner_id: owner,
        lead_id: d.lead_id,
        action: d.action ?? "",
        detail: json(d.detail),
        created_at: iso(d.createdAt) || new Date().toISOString(),
      })),
  },
  {
    table: "knowledge",
    rows: () =>
      collections.knowledge.map((d) => ({
        ...common(d),
        category: d.category ?? "custom",
        title: d.title ?? "",
        content: d.content ?? "",
        sort: d.sort ?? 50,
        is_master: Boolean(d.is_master),
        updated_at: iso(d.updatedAt) || common(d).created_at,
      })),
  },
  {
    table: "knowledge_sources",
    rows: () =>
      collections.knowledgeSources.map((d) => ({
        ...common(d),
        label: d.label ?? "",
        kind: d.kind ?? "url",
        url: json(d.url),
        content: json(d.content),
        updated_at: iso(d.updatedAt) || common(d).created_at,
      })),
  },
];

async function count(table) {
  const res = await fetch(`${url}/rest/v1/${table}?select=id&owner_id=eq.${owner}`, {
    headers: { ...headers, Prefer: "count=exact", Range: "0-0" },
  });
  if (res.status === 404) return null;
  const total = res.headers.get("content-range")?.split("/")[1];
  return total ? Number(total) : 0;
}

// Fail fast with a clear message when the schema has not been created yet.
const existing = await count("campaigns");
if (existing === null) {
  console.error("The Supabase tables do not exist yet. Run supabase/migrations/20251125000000_full_app_schema.sql in the SQL Editor first.");
  process.exitCode = 1;
} else {

let failed = false;
for (const { table, rows } of tables) {
  const list = rows();
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const res = await fetch(`${url}/rest/v1/${table}?on_conflict=id`, {
      method: "POST",
      headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) {
      failed = true;
      console.error(`${table} insert failed (${res.status}): ${(await res.text()).slice(0, 500)}`);
      break;
    }
  }
  const expected = list.length;
  const actual = await count(table);
  console.log(`${table}: imported ${actual}/${expected}`);
  if (actual !== expected) failed = true;
}

// Map the legacy owner to the Google account that owns it.
const linkRes = await fetch(`${url}/rest/v1/account_links?on_conflict=email`, {
  method: "POST",
  headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
  body: JSON.stringify([{ email: data.ownerEmail, legacy_owner_id: owner }]),
});
console.log(`account_links: ${linkRes.ok ? "seeded " + data.ownerEmail : "failed " + (await linkRes.text()).slice(0, 300)}`);
if (!linkRes.ok) failed = true;

process.exitCode = failed ? 1 : 0;
}

