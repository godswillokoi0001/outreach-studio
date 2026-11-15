import { requireUser } from "@/lib/auth";
import { route, ok, readJson, HttpError, str, num } from "@/lib/http";
import { q, first, run, now, audit, logEvent } from "@/lib/db";
import { createLead } from "@/lib/leads";
import { normalizeWebsite, normalizeEmail } from "@/lib/columns";
import type { Lead } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return route(async () => {
    const user = await requireUser();
    const params = new URL(request.url).searchParams;
    const status = params.get("status") ?? "";
    const campaign = params.get("campaign") ?? "";
    const search = (params.get("q") ?? "").trim();
    const page = Math.max(1, num(params.get("page"), 1));
    const pageSize = Math.min(100, Math.max(5, num(params.get("pageSize"), 20)));

    const where: string[] = ["owner_sub = ?"];
    const values: unknown[] = [user.sub];
    if (status && status !== "all") {
      const list = status.split(",").filter(Boolean);
      where.push(`status IN (${list.map(() => "?").join(",")})`);
      values.push(...list);
    }
    if (campaign) {
      where.push(`campaign_id = ?`);
      values.push(campaign);
    }
    if (search) {
      where.push(
        `(lower(COALESCE(business,'')) LIKE ? OR lower(COALESCE(email,'')) LIKE ? OR lower(COALESCE(contact_name,'')) LIKE ? OR lower(COALESCE(industry,'')) LIKE ?)`,
      );
      const term = `%${search.toLowerCase()}%`;
      values.push(term, term, term, term);
    }
    const clause = `WHERE ${where.join(" AND ")}`;
    const total = await first<{ c: number }>(`SELECT COUNT(*) AS c FROM leads ${clause}`, ...values);
    const rows = await q<Lead>(
      `SELECT * FROM leads ${clause} ORDER BY
        CASE status WHEN 'qualified' THEN 0 WHEN 'researched' THEN 1 WHEN 'email_generated' THEN 2 ELSE 3 END,
        COALESCE(score, 0) DESC, created_at DESC
       LIMIT ? OFFSET ?`,
      ...values,
      pageSize,
      (page - 1) * pageSize,
    );
    const counts = await q<{ status: string; c: number }>(
      `SELECT status, COUNT(*) AS c FROM leads WHERE owner_sub = ? GROUP BY status`,
      user.sub,
    );
    const industries = await q<{ industry: string }>(
      `SELECT DISTINCT industry FROM leads WHERE owner_sub = ? AND industry IS NOT NULL AND industry <> ''
       ORDER BY industry LIMIT 50`,
      user.sub,
    );

    return ok({
      leads: rows,
      total: total?.c ?? 0,
      page,
      pageSize,
      counts: Object.fromEntries(counts.map((c) => [c.status, c.c])),
      industries: industries.map((i) => i.industry),
    });
  });
}

export async function POST(request: Request) {
  return route(async () => {
    const user = await requireUser(request);
    const body = await readJson<{
      leads?: Record<string, unknown>[];
      business?: string;
      email?: string;
      website?: string;
      contact_name?: string;
      location?: string;
      industry?: string;
      notes?: string;
      source?: string;
    }>(request);
    const inputs = Array.isArray(body.leads) ? body.leads : [body];
    const created: { id: string; duplicate: boolean }[] = [];
    for (const input of inputs) {
      created.push(
        await createLead(user.sub, {
          business: str(input.business),
          email: str(input.email),
          website: str(input.website),
          contact_name: str(input.contact_name),
          location: str(input.location),
          industry: str(input.industry),
          notes: str(input.notes),
          source: str(input.source, "manual"),
        }),
      );
    }
    await audit(user.sub, "leads_created", "lead", undefined, { count: created.length });
    return ok({
      created: created.filter((c) => !c.duplicate).length,
      duplicates: created.filter((c) => c.duplicate).length,
      ids: created.map((c) => c.id),
    });
  });
}

const EDITABLE = [
  "business",
  "contact_name",
  "role",
  "email",
  "website",
  "phone",
  "location",
  "industry",
  "notes",
  "manual_research",
  "status",
  "score",
  "campaign_id",
] as const;

export async function PATCH(request: Request) {
  return route(async () => {
    const user = await requireUser(request);
    const body = await readJson<Record<string, unknown>>(request);
    const id = str(body.id);
    if (!id) throw new HttpError(400, "Missing lead id.");
    const lead = await first<Lead>(`SELECT * FROM leads WHERE owner_sub = ? AND id = ?`, user.sub, id);
    if (!lead) throw new HttpError(404, "Lead not found.");

    const sets: string[] = [];
    const values: unknown[] = [];
    for (const field of EDITABLE) {
      if (!(field in body)) continue;
      let value = body[field];
      if (field === "website") value = normalizeWebsite(str(value));
      if (field === "email") {
        const email = normalizeEmail(str(value));
        if (email) {
          const clash = await first<{ id: string }>(
            `SELECT id FROM leads WHERE owner_sub = ? AND email_norm = ? AND id <> ?`,
            user.sub,
            email,
            id,
          );
          if (clash) throw new HttpError(409, "Another lead already uses that email address.");
        }
        sets.push("email_norm = ?");
        values.push(email);
        value = email;
      }
      if (field === "score") value = value === null || value === "" ? null : num(value, 0);
      sets.push(`${field} = ?`);
      values.push(value === "" ? null : value);
    }

    if (body.action === "requeue") {
      sets.push("status = ?", "research = NULL");
      values.push("queued_research");
    }
    if (!sets.length) throw new HttpError(400, "Nothing to update.");
    sets.push("updated_at = ?");
    values.push(now(), user.sub, id);
    await run(`UPDATE leads SET ${sets.join(", ")} WHERE owner_sub = ? AND id = ?`, ...values);
    await logEvent(user.sub, id, "lead_updated", Object.keys(body));
    return ok({ ok: true });
  });
}

export async function DELETE(request: Request) {
  return route(async () => {
    const user = await requireUser(request);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new HttpError(400, "Missing lead id.");
    const lead = await first<Lead>(`SELECT * FROM leads WHERE owner_sub = ? AND id = ?`, user.sub, id);
    if (!lead) throw new HttpError(404, "Lead not found.");
    await run(`DELETE FROM messages WHERE owner_sub = ? AND lead_id = ?`, user.sub, id);
    await run(`DELETE FROM replies WHERE owner_sub = ? AND lead_id = ?`, user.sub, id);
    await run(`DELETE FROM lead_events WHERE owner_sub = ? AND lead_id = ?`, user.sub, id);
    await run(`DELETE FROM leads WHERE owner_sub = ? AND id = ?`, user.sub, id);
    await audit(user.sub, "lead_deleted", "lead", id, { email: lead.email });
    return ok({ ok: true });
  });
}
