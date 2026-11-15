import { requireUser } from "@/lib/auth";
import { route, ok, readJson, HttpError, str, num } from "@/lib/http";
import { q, first, run, now, audit } from "@/lib/db";
import { addSuppression } from "@/lib/mail";
import type { Lead, Message, Reply } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return route(async () => {
    const user = await requireUser();
    const params = new URL(request.url).searchParams;
    const filter = params.get("filter") ?? "all";
    const page = Math.max(1, num(params.get("page"), 1));
    const pageSize = Math.min(50, Math.max(5, num(params.get("pageSize"), 20)));

    const where: string[] = ["r.owner_sub = ?"];
    const values: unknown[] = [user.sub];
    if (filter === "positive") {
      where.push(`r.classification IN ('interested','more_info','pricing')`);
    } else if (filter === "needs_attention") {
      where.push(`r.handled = 0 AND r.classification NOT IN ('out_of_office')`);
    } else if (filter !== "all") {
      where.push(`r.classification = ?`);
      values.push(filter);
    }
    const clause = `WHERE ${where.join(" AND ")}`;
    const total = await first<{ c: number }>(`SELECT COUNT(*) AS c FROM replies r ${clause}`, ...values);
    const rows = await q<
      Reply & {
        business: string | null;
        industry: string | null;
        lead_email: string | null;
        contact_name: string | null;
        campaign_id: string | null;
      }
    >(
      `SELECT r.*, l.business, l.industry, l.email AS lead_email, l.contact_name, l.campaign_id
       FROM replies r LEFT JOIN leads l ON l.id = r.lead_id AND l.owner_sub = r.owner_sub
       ${clause} ORDER BY r.received_at DESC LIMIT ? OFFSET ?`,
      ...values,
      pageSize,
      (page - 1) * pageSize,
    );

    const threads: Record<string, Message[]> = {};
    for (const reply of rows) {
      if (!reply.lead_id || threads[reply.lead_id]) continue;
      threads[reply.lead_id] = await q<Message>(
        `SELECT * FROM messages WHERE owner_sub = ? AND lead_id = ? AND status IN ('sent','sending')
         ORDER BY sent_at ASC`,
        user.sub,
        reply.lead_id,
      );
    }
    const counts = await q<{ classification: string; c: number }>(
      `SELECT COALESCE(classification,'other') AS classification, COUNT(*) AS c FROM replies
       WHERE owner_sub = ? GROUP BY classification`,
      user.sub,
    );
    return ok({
      replies: rows,
      threads,
      total: total?.c ?? 0,
      page,
      pageSize,
      counts: Object.fromEntries(counts.map((c) => [c.classification, c.c])),
    });
  });
}

export async function PATCH(request: Request) {
  return route(async () => {
    const user = await requireUser(request);
    const sub = user.sub;
    const body = await readJson<{ id?: string; handled?: boolean; suppress?: boolean }>(request);
    const id = str(body.id);
    if (!id) throw new HttpError(400, "Missing reply id.");
    const reply = await first<Reply>(`SELECT * FROM replies WHERE owner_sub = ? AND id = ?`, sub, id);
    if (!reply) throw new HttpError(404, "Reply not found.");

    if (typeof body.handled === "boolean") {
      await run(`UPDATE replies SET handled = ? WHERE owner_sub = ? AND id = ?`, body.handled ? 1 : 0, sub, id);
    }
    if (body.suppress && reply.lead_id) {
      const lead = await first<Lead>(`SELECT * FROM leads WHERE owner_sub = ? AND id = ?`, sub, reply.lead_id);
      if (lead?.email) {
        await addSuppression(sub, lead.email, "Marked from conversation view");
        await run(`UPDATE leads SET status = 'unsubscribed', updated_at = ? WHERE owner_sub = ? AND id = ?`, now(), sub, lead.id);
        await run(
          `UPDATE messages SET status = 'cancelled', updated_at = ?
           WHERE owner_sub = ? AND lead_id = ? AND status IN ('pending_approval','approved')`,
          now(),
          sub,
          lead.id,
        );
        await audit(sub, "suppression_added", "lead", lead.id, { source: "reply" });
      }
    }
    return ok({ ok: true });
  });
}
