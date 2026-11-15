import { requireUser } from "@/lib/auth";
import { route, ok } from "@/lib/http";
import { q } from "@/lib/db";
import { findFollowupCandidates } from "@/lib/leads";
import type { Message } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  return route(async () => {
    const user = await requireUser();
    const [candidates, drafted, sent] = await Promise.all([
      findFollowupCandidates(user.sub, 50),
      q<Message & { business: string | null; lead_email: string | null }>(
        `SELECT m.*, l.business, l.email AS lead_email FROM messages m
         JOIN leads l ON l.id = m.lead_id AND l.owner_sub = m.owner_sub
         WHERE m.owner_sub = ? AND m.kind = 'followup' AND m.status IN ('pending_approval','approved')
         ORDER BY m.created_at DESC LIMIT 50`,
        user.sub,
      ),
      q<{ c: number }>(
        `SELECT COUNT(*) AS c FROM messages WHERE owner_sub = ? AND kind = 'followup' AND status = 'sent'`,
        user.sub,
      ),
    ]);
    return ok({
      due: candidates.map((c) => ({
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
      })),
      drafted,
      followupsSent: sent[0]?.c ?? 0,
    });
  });
}
