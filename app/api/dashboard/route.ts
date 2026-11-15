import { requireUser } from "@/lib/auth";
import { route, ok } from "@/lib/http";
import { q, first } from "@/lib/db";
import { getSettings, needsOnboarding } from "@/lib/settings";
import { getAccount, googleConfigured } from "@/lib/google";
import { runtimeConfig } from "@/lib/config";
import { findFollowupCandidates, knowledgeForCampaign } from "@/lib/leads";
import { isPlatformOwner } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  return route(async () => {
    const user = await requireUser();
    const sub = user.sub;

    const [statusCounts, messageCounts, replyCounts, sends, campaigns, activity, settings, account, googleState, config] =
      await Promise.all([
        q<{ status: string; c: number }>(`SELECT status, COUNT(*) AS c FROM leads WHERE owner_sub = ? GROUP BY status`, sub),
        q<{ status: string; c: number }>(`SELECT status, COUNT(*) AS c FROM messages WHERE owner_sub = ? GROUP BY status`, sub),
        q<{ classification: string; c: number }>(
          `SELECT COALESCE(classification,'unclassified') AS classification, COUNT(*) AS c FROM replies
           WHERE owner_sub = ? GROUP BY classification`,
          sub,
        ),
        q<{ day: string; c: number }>(
          `SELECT substr(at,1,10) AS day, COUNT(*) AS c FROM send_log WHERE owner_sub = ? AND status='sent'
           GROUP BY substr(at,1,10) ORDER BY day DESC LIMIT 14`,
          sub,
        ),
        q<{ id: string; name: string; status: string; leads: number; sent: number; pending: number; replies: number }>(
          `SELECT c.id, c.name, c.status,
            (SELECT COUNT(*) FROM leads l WHERE l.owner_sub = c.owner_sub AND l.campaign_id = c.id) AS leads,
            (SELECT COUNT(*) FROM messages m WHERE m.owner_sub = c.owner_sub AND m.campaign_id = c.id AND m.status = 'sent') AS sent,
            (SELECT COUNT(*) FROM messages m WHERE m.owner_sub = c.owner_sub AND m.campaign_id = c.id
              AND m.status = 'pending_approval') AS pending,
            (SELECT COUNT(*) FROM replies r WHERE r.owner_sub = c.owner_sub
              AND r.lead_id IN (SELECT l.id FROM leads l WHERE l.owner_sub = c.owner_sub AND l.campaign_id = c.id)) AS replies
           FROM campaigns c WHERE c.owner_sub = ? ORDER BY c.created_at DESC LIMIT 5`,
          sub,
        ),
        q<{ action: string; entity: string; created_at: string }>(
          `SELECT action, entity, created_at FROM audit_log WHERE owner_sub = ? ORDER BY created_at DESC LIMIT 8`,
          sub,
        ),
        getSettings(sub),
        getAccount(sub),
        googleConfigured(),
        runtimeConfig(sub),
      ]);

    const followups = await findFollowupCandidates(sub, 20).catch(() => []);
    const knowledge = await knowledgeForCampaign(sub);
    const statuses = Object.fromEntries(statusCounts.map((r) => [r.status, r.c]));
    const messages = Object.fromEntries(messageCounts.map((r) => [r.status, r.c]));
    const repliesByType = Object.fromEntries(replyCounts.map((r) => [r.classification, r.c]));

    return ok({
      leads: {
        total: Object.values(statuses).reduce((a, b) => a + b, 0),
        byStatus: statuses,
        researched:
          (statuses.researched ?? 0) +
          (statuses.qualified ?? 0) +
          (statuses.disqualified ?? 0) +
          (statuses.needs_research ?? 0) +
          (statuses.email_generated ?? 0) +
          (statuses.approved ?? 0) +
          (statuses.sent ?? 0),
        qualified:
          (statuses.qualified ?? 0) +
          (statuses.email_generated ?? 0) +
          (statuses.approved ?? 0) +
          (statuses.sent ?? 0),
        disqualified: statuses.disqualified ?? 0,
      },
      emails: {
        generated: (messages.pending_approval ?? 0) + (messages.approved ?? 0) + (messages.sent ?? 0),
        pending: (messages.pending_approval ?? 0) + (messages.approved ?? 0),
        sent: messages.sent ?? 0,
        failed: messages.failed ?? 0,
      },
      replies: {
        total: Object.values(repliesByType).reduce((a, b) => a + b, 0),
        positive: (repliesByType.interested ?? 0) + (repliesByType.more_info ?? 0) + (repliesByType.pricing ?? 0),
        byType: repliesByType,
      },
      followupsDue: followups.length,
      sends,
      campaigns,
      activity,
      settings: {
        daily_limit: settings.daily_limit,
        send_window: `${settings.send_window_start}:00-${settings.send_window_end}:00`,
      },
      setup: {
        onboarding_needed: needsOnboarding(settings),
        knowledge_empty: !knowledge.trim(),
        googleConfigured: googleState.ok,
        googleConnected: Boolean(account),
        geminiConfigured: Boolean(config.geminiKey),
        geminiModel: config.geminiModel,
        senderName: settings.sender_name,
        is_platform_owner: await isPlatformOwner(sub),
      },
    });
  });
}
