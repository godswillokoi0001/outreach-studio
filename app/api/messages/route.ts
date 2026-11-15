import { requireUser } from "@/lib/auth";
import { route, ok, readJson, HttpError, str, num } from "@/lib/http";
import { q, first, run, now, audit } from "@/lib/db";
import { composeInitial, validateEmail } from "@/lib/compose";
import { knowledgeForCampaign, parseConfig } from "@/lib/leads";
import { getSettings } from "@/lib/settings";
import type { Campaign, Lead, Message, ResearchResult } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return route(async () => {
    const user = await requireUser();
    const params = new URL(request.url).searchParams;
    const status = params.get("status") ?? "pending_approval";
    const campaign = params.get("campaign") ?? "";
    const page = Math.max(1, num(params.get("page"), 1));
    const pageSize = Math.min(50, Math.max(5, num(params.get("pageSize"), 20)));

    const where: string[] = ["m.owner_sub = ?"];
    const values: unknown[] = [user.sub];
    if (status && status !== "all") {
      const list = status.split(",");
      where.push(`m.status IN (${list.map(() => "?").join(",")})`);
      values.push(...list);
    }
    if (campaign) {
      where.push(`m.campaign_id = ?`);
      values.push(campaign);
    }
    const clause = `WHERE ${where.join(" AND ")}`;
    const total = await first<{ c: number }>(`SELECT COUNT(*) AS c FROM messages m ${clause}`, ...values);
    const rows = await q<
      Message & {
        business: string | null;
        lead_email: string | null;
        contact_name: string | null;
        score: number | null;
        lead_status: string;
        industry: string | null;
      }
    >(
      `SELECT m.*, l.business, l.email AS lead_email, l.contact_name, l.score, l.status AS lead_status, l.industry
       FROM messages m JOIN leads l ON l.id = m.lead_id AND l.owner_sub = m.owner_sub
       ${clause}
       ORDER BY m.created_at DESC LIMIT ? OFFSET ?`,
      ...values,
      pageSize,
      (page - 1) * pageSize,
    );
    const counts = await q<{ status: string; c: number }>(
      `SELECT status, COUNT(*) AS c FROM messages WHERE owner_sub = ? GROUP BY status`,
      user.sub,
    );
    return ok({
      messages: rows,
      total: total?.c ?? 0,
      page,
      pageSize,
      counts: Object.fromEntries(counts.map((c) => [c.status, c.c])),
    });
  });
}

export async function PATCH(request: Request) {
  return route(async () => {
    const user = await requireUser(request);
    const sub = user.sub;
    const settings = await getSettings(sub);
    const body = await readJson<{ id?: string; action?: string; subject?: string; body?: string; campaignId?: string }>(
      request,
    );
    const action = str(body.action);

    if (action === "approve_all") {
      const campaignId = str(body.campaignId);
      if (!campaignId) throw new HttpError(400, "Missing campaign id.");
      const changed = await run(
        `UPDATE messages SET status = 'approved', approved_at = ?, updated_at = ?
         WHERE owner_sub = ? AND campaign_id = ? AND status = 'pending_approval'`,
        now(),
        now(),
        sub,
        campaignId,
      );
      await run(
        `UPDATE leads SET status = 'approved', updated_at = ?
         WHERE owner_sub = ? AND campaign_id = ? AND status = 'email_generated'`,
        now(),
        sub,
        campaignId,
      );
      await audit(sub, "emails_bulk_approved", "campaign", campaignId, { changed });
      return ok({ ok: true, changed });
    }

    const id = str(body.id);
    if (!id) throw new HttpError(400, "Missing message id.");
    const message = await first<Message>(`SELECT * FROM messages WHERE owner_sub = ? AND id = ?`, sub, id);
    if (!message) throw new HttpError(404, "Email not found.");
    const lead = await first<Lead>(`SELECT * FROM leads WHERE owner_sub = ? AND id = ?`, sub, message.lead_id);
    if (!lead) throw new HttpError(404, "Prospect not found.");

    switch (action) {
      case "approve": {
        const subject = str(body.subject) || message.subject || "";
        const bodyText = str(body.body) || message.body || "";
        const invalid = validateEmail(subject, bodyText);
        if (invalid) throw new HttpError(400, invalid);
        await run(
          `UPDATE messages SET status = 'approved', subject = ?, body = ?, approved_at = ?, updated_at = ?
           WHERE owner_sub = ? AND id = ?`,
          subject,
          bodyText,
          now(),
          now(),
          sub,
          id,
        );
        await run(`UPDATE leads SET status = 'approved', updated_at = ? WHERE owner_sub = ? AND id = ?`, now(), sub, lead.id);
        await audit(sub, "email_approved", "message", id);
        return ok({ ok: true });
      }
      case "edit": {
        const subject = str(body.subject) || message.subject || "";
        const bodyText = str(body.body) || message.body || "";
        const invalid = validateEmail(subject, bodyText);
        if (invalid) throw new HttpError(400, invalid);
        await run(
          `UPDATE messages SET subject = ?, body = ?, updated_at = ? WHERE owner_sub = ? AND id = ?`,
          subject,
          bodyText,
          now(),
          sub,
          id,
        );
        return ok({ ok: true });
      }
      case "reject":
        await run(`UPDATE messages SET status = 'cancelled', updated_at = ? WHERE owner_sub = ? AND id = ?`, now(), sub, id);
        await run(`UPDATE leads SET status = 'qualified', updated_at = ? WHERE owner_sub = ? AND id = ?`, now(), sub, lead.id);
        await audit(sub, "email_rejected", "message", id);
        return ok({ ok: true });
      case "regenerate": {
        if (message.status === "sent" || message.status === "sending") {
          throw new HttpError(400, "This email has already been sent and cannot be rewritten.");
        }
        if (!message.campaign_id) throw new HttpError(400, "This email is not linked to a campaign.");
        const campaign = await first<Campaign>(
          `SELECT * FROM campaigns WHERE owner_sub = ? AND id = ?`,
          sub,
          message.campaign_id,
        );
        if (!campaign) throw new HttpError(404, "Campaign not found.");
        let research: ResearchResult | null = null;
        try {
          research = lead.research ? (JSON.parse(lead.research) as ResearchResult) : null;
        } catch {
          research = null;
        }
        if (!research) throw new HttpError(400, "Run research for this prospect before regenerating.");
        const email = await composeInitial(
          sub,
          lead,
          research,
          parseConfig(campaign),
          settings,
          await knowledgeForCampaign(sub),
        );
        const invalid = validateEmail(email.subject, email.body);
        if (invalid) throw new HttpError(400, invalid);
        await run(
          `UPDATE messages SET subject = ?, body = ?, angle = ?, rationale = ?, service = ?,
            status = 'pending_approval', updated_at = ? WHERE owner_sub = ? AND id = ?`,
          email.subject,
          email.body,
          email.angle,
          email.rationale,
          email.service,
          now(),
          sub,
          id,
        );
        await audit(sub, "email_regenerated", "message", id);
        return ok({ ok: true, subject: email.subject, body: email.body, angle: email.angle, rationale: email.rationale });
      }
      default:
        throw new HttpError(400, "Unknown message action.");
    }
  });
}
