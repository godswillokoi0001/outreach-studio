import { requireUser } from "@/lib/auth";
import { route, ok } from "@/lib/http";
import { q, first } from "@/lib/db";
import { analysePerformance } from "@/lib/intelligence";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function collect(sub: string) {
  const [funnel, sendsByDay, replyTypes, campaigns, industries, angles, delivery, totals] = await Promise.all([
    q<{ status: string; c: number }>(`SELECT status, COUNT(*) AS c FROM leads WHERE owner_sub = ? GROUP BY status`, sub),
    q<{ day: string; c: number }>(
      `SELECT substr(at,1,10) AS day, COUNT(*) AS c FROM send_log WHERE owner_sub = ? AND status='sent'
       GROUP BY substr(at,1,10) ORDER BY day DESC LIMIT 30`,
      sub,
    ),
    q<{ classification: string; c: number }>(
      `SELECT COALESCE(classification,'other') AS classification, COUNT(*) AS c FROM replies
       WHERE owner_sub = ? GROUP BY classification`,
      sub,
    ),
    q<{ id: string; name: string; status: string; leads: number; sent: number; replies: number; positive: number }>(
      `SELECT c.id, c.name, c.status,
        (SELECT COUNT(*) FROM leads l WHERE l.owner_sub = c.owner_sub AND l.campaign_id = c.id) AS leads,
        (SELECT COUNT(*) FROM messages m WHERE m.owner_sub = c.owner_sub AND m.campaign_id = c.id AND m.status = 'sent') AS sent,
        (SELECT COUNT(*) FROM replies r WHERE r.owner_sub = c.owner_sub
          AND r.lead_id IN (SELECT l.id FROM leads l WHERE l.owner_sub = c.owner_sub AND l.campaign_id = c.id)) AS replies,
        (SELECT COUNT(*) FROM replies r WHERE r.owner_sub = c.owner_sub
          AND r.classification IN ('interested','more_info','pricing')
          AND r.lead_id IN (SELECT l.id FROM leads l WHERE l.owner_sub = c.owner_sub AND l.campaign_id = c.id)) AS positive
       FROM campaigns c WHERE c.owner_sub = ? ORDER BY c.created_at DESC LIMIT 20`,
      sub,
    ),
    q<{ industry: string; leads: number; contacted: number; replied: number }>(
      `SELECT COALESCE(NULLIF(l.industry,''),'Unknown') AS industry,
        COUNT(*) AS leads,
        SUM(CASE WHEN l.status IN ('sent','replied','followup_pending','converted','bounced') THEN 1 ELSE 0 END) AS contacted,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM replies r WHERE r.owner_sub = l.owner_sub AND r.lead_id = l.id) THEN 1 ELSE 0 END) AS replied
       FROM leads l WHERE l.owner_sub = ? GROUP BY industry ORDER BY leads DESC LIMIT 15`,
      sub,
    ),
    q<{ angle: string; sent: number; replied: number }>(
      `SELECT COALESCE(NULLIF(m.angle,''),'(not recorded)') AS angle,
        COUNT(*) AS sent,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM replies r WHERE r.owner_sub = m.owner_sub AND r.lead_id = m.lead_id) THEN 1 ELSE 0 END) AS replied
       FROM messages m WHERE m.owner_sub = ? AND m.status = 'sent' GROUP BY angle ORDER BY sent DESC LIMIT 15`,
      sub,
    ),
    q<{ status: string; c: number }>(`SELECT status, COUNT(*) AS c FROM messages WHERE owner_sub = ? GROUP BY status`, sub),
    first<{ leads: number; campaigns: number }>(
      `SELECT (SELECT COUNT(*) FROM leads WHERE owner_sub = ?) AS leads,
              (SELECT COUNT(*) FROM campaigns WHERE owner_sub = ?) AS campaigns`,
      sub,
      sub,
    ),
  ]);

  const messages = Object.fromEntries(delivery.map((d) => [d.status, d.c]));
  const sent = messages.sent ?? 0;
  const replies = replyTypes.reduce((sum, r) => sum + r.c, 0);
  return {
    funnel: Object.fromEntries(funnel.map((f) => [f.status, f.c])),
    sendsByDay: sendsByDay.reverse(),
    replyTypes: Object.fromEntries(replyTypes.map((r) => [r.classification, r.c])),
    campaigns,
    industries,
    angles,
    delivery: {
      sent,
      failed: messages.failed ?? 0,
      pending: (messages.pending_approval ?? 0) + (messages.approved ?? 0),
    },
    totals: {
      leads: totals?.leads ?? 0,
      campaigns: totals?.campaigns ?? 0,
      replies,
      replyRate: sent ? Math.round((replies / sent) * 1000) / 10 : 0,
      positive:
        (replyTypes.find((r) => r.classification === "interested")?.c ?? 0) +
        (replyTypes.find((r) => r.classification === "more_info")?.c ?? 0) +
        (replyTypes.find((r) => r.classification === "pricing")?.c ?? 0),
    },
  };
}

export async function GET() {
  return route(async () => {
    const user = await requireUser();
    return ok(await collect(user.sub));
  });
}

export async function POST(request: Request) {
  return route(async () => {
    const user = await requireUser(request);
    const settings = await getSettings(user.sub);
    const metrics = await collect(user.sub);
    const insight = await analysePerformance(user.sub, metrics, settings.model);
    return ok({ metrics, insight });
  });
}
