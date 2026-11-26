import { NextRequest, NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import { AuthError, verifyRequest } from "@/lib/server-auth";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * The app's rows. Everything here is server-only (RLS + revoked anon), so the
 * browser talks to this route and the route scopes every statement to the
 * owner id resolved from the verified Supabase session.
 */
const COLUMNS: Record<string, string[]> = {
  campaigns: [
    "id", "owner_id", "name", "instruction", "config", "status", "sheet_source",
    "approved_at", "created_at", "updated_at",
  ],
  leads: [
    "id", "owner_id", "campaign_id", "business", "contact_name", "role", "email",
    "email_norm", "website", "phone", "location", "industry", "notes", "extra",
    "source", "source_ref", "sheet_row", "status", "score", "priority",
    "score_reason", "research", "research_at", "research_ok", "manual_research",
    "last_contacted_at", "created_at", "updated_at",
  ],
  messages: [
    "id", "owner_id", "lead_id", "campaign_id", "step", "kind", "subject", "body",
    "angle", "rationale", "service", "status", "gmail_id", "thread_id",
    "rfc_message_id", "sent_at", "error", "approved_at", "created_at", "updated_at",
  ],
  replies: [
    "id", "owner_id", "lead_id", "thread_id", "gmail_id", "from_email", "subject",
    "snippet", "body", "received_at", "classification", "summary",
    "recommended_action", "draft_reply", "handled", "created_at", "updated_at",
  ],
  suppressions: ["id", "owner_id", "email", "reason", "created_at", "updated_at"],
  send_logs: ["id", "owner_id", "lead_id", "message_id", "status", "at", "created_at"],
  audit_logs: ["id", "owner_id", "action", "entity", "entity_id", "detail", "created_at"],
  lead_events: ["id", "owner_id", "lead_id", "action", "detail", "created_at"],
  knowledge: [
    "id", "owner_id", "category", "title", "content", "sort", "is_master",
    "created_at", "updated_at",
  ],
  knowledge_sources: ["id", "owner_id", "label", "kind", "url", "content", "created_at", "updated_at"],
  email_opens: ["id", "owner_id", "message_id", "lead_id", "opened_at", "user_agent"],
};

const TIMESTAMP_COLUMNS = new Set([
  "created_at", "updated_at", "approved_at", "sent_at", "research_at",
  "last_contacted_at", "received_at", "opened_at", "at",
]);

type Row = Record<string, unknown>;

function resolveTable(name: string | null): string {
  if (!name || !COLUMNS[name]) {
    throw new AuthError(`Unknown data table: ${name ?? "(none)"}.`, 400);
  }
  return name;
}

/**
 * Screens that only need counters or list labels ask for a few columns instead
 * of `*`. Reading a 40 KB email body to count drafts is what pushed the project
 * into its disk IO budget, so the column list is honoured here.
 */
function resolveColumns(table: string, raw: string | null): string {
  if (!raw) return "*";
  const allowed = new Set(COLUMNS[table]);
  const requested = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^[a-z][a-z0-9_]*$/.test(value) && allowed.has(value));
  if (requested.length === 0) return "*";
  // Every row needs its id: the client turns it into the document handle.
  if (!requested.includes("id")) requested.unshift("id");
  return requested.join(",");
}

function resolveOrder(table: string, raw: string | null): { column: string; ascending: boolean } | null {
  if (!raw) return null;
  const [column, direction] = raw.split(".");
  const allowed = new Set(COLUMNS[table]);
  if (!column || !/^[a-z][a-z0-9_]*$/.test(column) || !allowed.has(column)) return null;
  return { column, ascending: direction !== "desc" };
}

function cleanValues(table: string, raw: unknown): Row {
  if (!raw || typeof raw !== "object") return {};
  const allowed = new Set(COLUMNS[table]);
  const out: Row = {};

  for (const [key, value] of Object.entries(raw as Row)) {
    if (key === "id" || key === "owner_id") continue;
    if (!allowed.has(key) || value === undefined) continue;
    if (typeof value === "string" && value.trim() === "" && TIMESTAMP_COLUMNS.has(key)) {
      out[key] = null;
      continue;
    }
    out[key] = value;
  }
  return out;
}

async function assertOwnership(table: string, id: string, ownerId: string): Promise<void> {
  if (!supabaseServer) throw new AuthError("Supabase is not configured on this deployment.", 503);
  const { data } = await supabaseServer
    .from(table as never)
    .select("owner_id")
    .eq("id", id)
    .maybeSingle();

  const existing = data as Row | null;
  if (existing && String(existing.owner_id ?? "") !== ownerId) {
    throw new AuthError("This record belongs to another account.", 403);
  }
}

async function upsertRow(table: string, id: string, ownerId: string, values: unknown): Promise<void> {
  if (!supabaseServer) throw new AuthError("Supabase is not configured on this deployment.", 503);
  const payload: Row = { id, owner_id: ownerId, ...cleanValues(table, values) };

  const { error } = await supabaseServer
    .from(table as never)
    .upsert(payload as never, { onConflict: "id" });
  if (error) throw new Error(`Could not save ${table}: ${error.message}`);
}

async function deleteRow(table: string, id: string, ownerId: string): Promise<void> {
  if (!supabaseServer) throw new AuthError("Supabase is not configured on this deployment.", 503);
  const { error } = await supabaseServer
    .from(table as never)
    .delete()
    .eq("id", id)
    .eq("owner_id", ownerId);
  if (error) throw new Error(`Could not delete from ${table}: ${error.message}`);
}

export async function GET(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    if (!supabaseServer) throw new AuthError("Supabase is not configured on this deployment.", 503);

    const params = req.nextUrl.searchParams;
    const table = resolveTable(params.get("table"));
    const id = params.get("id");
    const columns = resolveColumns(table, params.get("columns"));
    const order = resolveOrder(table, params.get("order"));
    const requestedLimit = Number(params.get("limit"));
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.floor(requestedLimit), 5000)
      : null;

    let scoped = supabaseServer.from(table as never).select(columns);
    scoped = id
      ? scoped.eq("id", id).eq("owner_id", user.ownerId)
      : scoped.eq("owner_id", user.ownerId);
    if (order) scoped = scoped.order(order.column, { ascending: order.ascending });
    if (limit) scoped = scoped.limit(limit);

    const { data, error } = await scoped;

    if (error) throw new Error(`Could not read ${table}: ${error.message}`);

    const rows = (data ?? []) as Row[];
    return NextResponse.json(
      id ? { row: rows[0] ?? null } : { rows },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const table = resolveTable(req.nextUrl.searchParams.get("table"));
    const body = (await req.json().catch(() => ({}))) as {
      id?: string;
      values?: unknown;
      ops?: { type?: string; id?: string; values?: unknown }[];
    };

    if (Array.isArray(body.ops)) {
      for (const op of body.ops) {
        const id = typeof op?.id === "string" ? op.id : "";
        if (!id) continue;
        if (op.type === "delete") {
          await assertOwnership(table, id, user.ownerId);
          await deleteRow(table, id, user.ownerId);
        } else {
          await assertOwnership(table, id, user.ownerId);
          await upsertRow(table, id, user.ownerId, op.values);
        }
      }
      return NextResponse.json({ ok: true });
    }

    if (!body.id) throw new AuthError("An id is required to save a record.", 400);
    await assertOwnership(table, body.id, user.ownerId);
    await upsertRow(table, body.id, user.ownerId, body.values);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    if (!supabaseServer) throw new AuthError("Supabase is not configured on this deployment.", 503);

    const params = req.nextUrl.searchParams;
    const table = resolveTable(params.get("table"));
    const id = params.get("id");
    if (!id) throw new AuthError("An id is required.", 400);

    const body = (await req.json().catch(() => ({}))) as { values?: unknown };
    const values = cleanValues(table, body.values);
    if (Object.keys(values).length === 0) return NextResponse.json({ ok: true });

    const { error } = await supabaseServer
      .from(table as never)
      .update(values as never)
      .eq("id", id)
      .eq("owner_id", user.ownerId);

    if (error) throw new Error(`Could not update ${table}: ${error.message}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = await verifyRequest(req);
    const params = req.nextUrl.searchParams;
    const table = resolveTable(params.get("table"));
    const id = params.get("id");
    if (!id) throw new AuthError("An id is required.", 400);

    await deleteRow(table, id, user.ownerId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
