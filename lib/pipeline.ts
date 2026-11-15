import { first, q, run, now, logEvent, audit } from "./db";
import { ConfigError } from "./env";
import { researchLead } from "./research";
import { qualifyLead } from "./qualify";
import { composeInitial, composeFollowUp, validateEmail } from "./compose";
import { analyseReply } from "./intelligence";
import { knowledgeForCampaign, findFollowupCandidates, parseConfig } from "./leads";
import { getSettings } from "./settings";
import {
  addSuppression,
  checkSendWindow,
  isSuppressed,
  sendApprovedMessage,
  sendsToday,
  lastSendAt,
} from "./mail";
import { getAccount, listGmailMessages, getGmailMessage, header, messageText } from "./google";
import type { Campaign, Lead, Message, ResearchResult, Settings } from "./types";

export interface BatchResult {
  processed: number;
  remaining: number;
  details: string[];
  errors: string[];
  waitSeconds?: number;
  info?: string;
}

function empty(): BatchResult {
  return { processed: 0, remaining: 0, details: [], errors: [] };
}

async function getCampaign(ownerSub: string, campaignId: string): Promise<Campaign> {
  const campaign = await first<Campaign>(
    `SELECT * FROM campaigns WHERE owner_sub = ? AND id = ?`,
    ownerSub,
    campaignId,
  );
  if (!campaign) throw new ConfigError("Campaign not found.");
  return campaign;
}

function parseResearch(raw: string | null): ResearchResult | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ResearchResult;
  } catch {
    return null;
  }
}

async function countLeads(ownerSub: string, campaignId: string, statuses: string[]): Promise<number> {
  const placeholders = statuses.map(() => "?").join(",");
  const row = await first<{ c: number }>(
    `SELECT COUNT(*) AS c FROM leads WHERE owner_sub = ? AND campaign_id = ? AND status IN (${placeholders})`,
    ownerSub,
    campaignId,
    ...statuses,
  );
  return row?.c ?? 0;
}

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------

export async function runResearch(ownerSub: string, campaignId: string, limit: number): Promise<BatchResult> {
  const result = empty();
  const leads = await q<Lead>(
    `SELECT * FROM leads WHERE owner_sub = ? AND campaign_id = ? AND status IN ('queued_research','new')
     ORDER BY COALESCE(sheet_row, 999999) ASC, created_at ASC LIMIT ?`,
    ownerSub,
    campaignId,
    Math.max(1, Math.min(limit, 5)),
  );
  for (const lead of leads) {
    try {
      const research = await researchLead(ownerSub, lead);
      await run(
        `UPDATE leads SET research = ?, research_at = ?, research_ok = ?, status = 'researched', updated_at = ?
         WHERE owner_sub = ? AND id = ?`,
        JSON.stringify(research),
        now(),
        research.insufficient_data ? 0 : 1,
        now(),
        ownerSub,
        lead.id,
      );
      await logEvent(ownerSub, lead.id, "researched", {
        confidence: research.confidence,
        insufficient: research.insufficient_data,
        website: research.website_status,
      });
      result.processed += 1;
      result.details.push(`${lead.business ?? lead.email}: ${research.summary.slice(0, 110)}`);
    } catch (err) {
      if (err instanceof ConfigError) {
        result.errors.push(err.message);
        break;
      }
      result.errors.push(`${lead.business ?? lead.email}: ${err instanceof Error ? err.message : "research failed"}`);
    }
  }
  result.remaining = await countLeads(ownerSub, campaignId, ["queued_research", "new"]);
  return result;
}

// ---------------------------------------------------------------------------
// Qualification
// ---------------------------------------------------------------------------

export async function runQualify(ownerSub: string, campaignId: string, limit: number): Promise<BatchResult> {
  const [campaign, settings] = await Promise.all([getCampaign(ownerSub, campaignId), getSettings(ownerSub)]);
  const config = parseConfig(campaign);
  const result = empty();
  const leads = await q<Lead>(
    `SELECT * FROM leads WHERE owner_sub = ? AND campaign_id = ? AND status = 'researched'
     ORDER BY created_at ASC LIMIT ?`,
    ownerSub,
    campaignId,
    Math.max(1, Math.min(limit, 5)),
  );
  for (const lead of leads) {
    try {
      const research = parseResearch(lead.research);
      if (!research) {
        await run(
          `UPDATE leads SET status = 'queued_research', updated_at = ? WHERE owner_sub = ? AND id = ?`,
          now(),
          ownerSub,
          lead.id,
        );
        continue;
      }
      const minScore = config.min_score ?? settings.min_score;
      const qualification = await qualifyLead(ownerSub, lead, research, config, minScore);
      const status =
        qualification.category === "not_qualified"
          ? "disqualified"
          : qualification.category === "needs_research"
            ? "needs_research"
            : qualification.score >= minScore
              ? "qualified"
              : "disqualified";
      await run(
        `UPDATE leads SET score = ?, priority = ?, score_reason = ?, status = ?, updated_at = ?
         WHERE owner_sub = ? AND id = ?`,
        qualification.score,
        qualification.category,
        JSON.stringify({
          reasons: qualification.reasons,
          opportunity: qualification.opportunity,
          value_tier: qualification.value_tier,
          recommended_service: qualification.recommended_service,
          disqualify_reason: qualification.disqualify_reason ?? "",
        }),
        status,
        now(),
        ownerSub,
        lead.id,
      );
      await logEvent(ownerSub, lead.id, "qualified", {
        score: qualification.score,
        category: qualification.category,
        status,
      });
      result.processed += 1;
      result.details.push(`${lead.business ?? lead.email}: ${qualification.score}/100 (${qualification.category})`);
    } catch (err) {
      if (err instanceof ConfigError) {
        result.errors.push(err.message);
        break;
      }
      result.errors.push(`${lead.business ?? lead.email}: ${err instanceof Error ? err.message : "qualification failed"}`);
    }
  }
  result.remaining = await countLeads(ownerSub, campaignId, ["researched"]);
  return result;
}

// ---------------------------------------------------------------------------
// Email composition
// ---------------------------------------------------------------------------

export async function runCompose(ownerSub: string, campaignId: string, limit: number): Promise<BatchResult> {
  const [campaign, settings, knowledge] = await Promise.all([
    getCampaign(ownerSub, campaignId),
    getSettings(ownerSub),
    knowledgeForCampaign(ownerSub),
  ]);
  const config = parseConfig(campaign);
  const result = empty();
  const leads = await q<Lead>(
    `SELECT * FROM leads WHERE owner_sub = ? AND campaign_id = ? AND status = 'qualified'
     ORDER BY COALESCE(score,0) DESC LIMIT ?`,
    ownerSub,
    campaignId,
    Math.max(1, Math.min(limit, 4)),
  );
  for (const lead of leads) {
    try {
      if (!lead.email) {
        await run(
          `UPDATE leads SET status = 'disqualified', updated_at = ? WHERE owner_sub = ? AND id = ?`,
          now(),
          ownerSub,
          lead.id,
        );
        continue;
      }
      if (await isSuppressed(ownerSub, lead.email)) {
        await run(
          `UPDATE leads SET status = 'suppressed', updated_at = ? WHERE owner_sub = ? AND id = ?`,
          now(),
          ownerSub,
          lead.id,
        );
        continue;
      }
      const already = await first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM messages WHERE owner_sub = ? AND lead_id = ? AND kind = 'initial'`,
        ownerSub,
        lead.id,
      );
      if ((already?.c ?? 0) > 0) {
        await run(
          `UPDATE leads SET status = 'email_generated', updated_at = ? WHERE owner_sub = ? AND id = ?`,
          now(),
          ownerSub,
          lead.id,
        );
        continue;
      }
      const research = parseResearch(lead.research);
      if (!research) {
        await run(
          `UPDATE leads SET status = 'queued_research', updated_at = ? WHERE owner_sub = ? AND id = ?`,
          now(),
          ownerSub,
          lead.id,
        );
        continue;
      }
      const email = await composeInitial(ownerSub, lead, research, config, settings, knowledge);
      const invalid = validateEmail(email.subject, email.body);
      if (invalid) throw new Error(invalid);
      const autoApprove = config.auto_approve_initial && !config.require_approval;
      await run(
        `INSERT INTO messages (owner_sub, id, lead_id, campaign_id, step, kind, subject, body, angle, rationale, service,
          status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ownerSub,
        crypto.randomUUID(),
        lead.id,
        campaignId,
        1,
        "initial",
        email.subject,
        email.body,
        email.angle,
        `${email.rationale}\n\nEvidence used: ${email.evidence.join("; ")}`,
        email.service,
        autoApprove ? "approved" : "pending_approval",
        now(),
        now(),
      );
      await run(
        `UPDATE leads SET status = ?, updated_at = ? WHERE owner_sub = ? AND id = ?`,
        autoApprove ? "approved" : "email_generated",
        now(),
        ownerSub,
        lead.id,
      );
      await logEvent(ownerSub, lead.id, "email_generated", { subject: email.subject, autoApprove });
      result.processed += 1;
      result.details.push(`${lead.business ?? lead.email}: "${email.subject}"`);
    } catch (err) {
      if (err instanceof ConfigError) {
        result.errors.push(err.message);
        break;
      }
      result.errors.push(`${lead.business ?? lead.email}: ${err instanceof Error ? err.message : "composition failed"}`);
    }
  }
  result.remaining = await countLeads(ownerSub, campaignId, ["qualified"]);
  return result;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

async function countApproved(ownerSub: string, campaignId: string | null): Promise<number> {
  const row = await first<{ c: number }>(
    `SELECT COUNT(*) AS c FROM messages WHERE owner_sub = ? AND status = 'approved'
     ${campaignId ? "AND campaign_id = ?" : ""}`,
    ...(campaignId ? [ownerSub, campaignId] : [ownerSub]),
  );
  return row?.c ?? 0;
}

export async function runSend(ownerSub: string, campaignId: string | null, limit: number): Promise<BatchResult> {
  const settings = await getSettings(ownerSub);
  const result = empty();
  const account = await getAccount(ownerSub);
  if (!account) throw new ConfigError("Connect your Gmail account before sending.");

  const window = checkSendWindow(settings);
  if (!window.allowed) return { ...result, info: window.reason, waitSeconds: 900 };

  const sentToday = await sendsToday(ownerSub, settings);
  if (sentToday >= settings.daily_limit) {
    return { ...result, info: `Daily limit reached (${sentToday}/${settings.daily_limit}). Sending resumes tomorrow.` };
  }

  let campaign: Campaign | null = null;
  let config = null as ReturnType<typeof parseConfig> | null;
  if (campaignId) {
    campaign = await getCampaign(ownerSub, campaignId);
    config = parseConfig(campaign);
    if (campaign.status === "paused") return { ...result, info: "Campaign is paused." };
    if (campaign.status === "draft" || campaign.status === "archived") {
      return {
        ...result,
        info: "Approve this campaign before any email is sent.",
        remaining: await countApproved(ownerSub, campaignId),
      };
    }
    const sentInCampaign = await first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM messages WHERE owner_sub = ? AND campaign_id = ? AND status = 'sent'`,
      ownerSub,
      campaignId,
    );
    if (config.send_limit && (sentInCampaign?.c ?? 0) >= config.send_limit) {
      return { ...result, info: `Campaign sending limit reached (${config.send_limit}).` };
    }
  }

  const last = await lastSendAt(ownerSub);
  const gap = (config?.interval_seconds ?? settings.interval_seconds) * 1000;
  if (last && Date.now() - last < gap) {
    return {
      ...result,
      waitSeconds: Math.ceil((gap - (Date.now() - last)) / 1000),
      remaining: await countApproved(ownerSub, campaignId),
    };
  }

  const messages = await q<Message>(
    `SELECT * FROM messages WHERE owner_sub = ? AND status = 'approved'
     ${campaignId ? "AND campaign_id = ?" : ""}
     ORDER BY created_at ASC LIMIT ?`,
    ...(campaignId ? [ownerSub, campaignId, 3] : [ownerSub, 3]),
  );

  for (const message of messages.slice(0, Math.max(1, Math.min(limit, 3)))) {
    const lead = await first<Lead>(
      `SELECT * FROM leads WHERE owner_sub = ? AND id = ?`,
      ownerSub,
      message.lead_id,
    );
    if (!lead) continue;
    if (await isSuppressed(ownerSub, lead.email)) {
      await run(
        `UPDATE messages SET status = 'skipped', error = 'Recipient is suppressed.', updated_at = ?
         WHERE owner_sub = ? AND id = ?`,
        now(),
        ownerSub,
        message.id,
      );
      await run(
        `UPDATE leads SET status = 'suppressed', updated_at = ? WHERE owner_sub = ? AND id = ?`,
        now(),
        ownerSub,
        lead.id,
      );
      continue;
    }
    if ((await sendsToday(ownerSub, settings)) >= settings.daily_limit) {
      result.info = `Daily limit reached (${settings.daily_limit}).`;
      break;
    }
    const outcome = await sendApprovedMessage(ownerSub, message, lead, settings);
    result.details.push(`${lead.business ?? lead.email}: ${outcome.status}${outcome.detail ? ` - ${outcome.detail}` : ""}`);
    if (outcome.status === "sent" || outcome.status === "already_sent") {
      result.processed += 1;
      break; // one send per request keeps us inside Gmail limits and the interval rule
    }
    result.errors.push(`${lead.business ?? lead.email}: ${outcome.detail}`);
  }

  result.remaining = await countApproved(ownerSub, campaignId);
  if (result.processed > 0 && result.remaining > 0) {
    result.waitSeconds = config?.interval_seconds ?? settings.interval_seconds;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Reply and bounce synchronisation
// ---------------------------------------------------------------------------

const UNSUBSCRIBE_WORDS = /(unsubscribe|remove me|stop emailing|do not contact|don't contact|opt out|take me off)/i;

export async function runSync(ownerSub: string, limit: number): Promise<BatchResult> {
  const account = await getAccount(ownerSub);
  if (!account) throw new ConfigError("Connect your Gmail account to read replies.");
  const settings = await getSettings(ownerSub);
  const result = empty();
  const mailbox = (account.email ?? "").toLowerCase();
  const knowledge = await knowledgeForCampaign(ownerSub);

  const incoming = await listGmailMessages(ownerSub, "newer_than:14d -in:sent", Math.max(1, Math.min(limit, 8)) * 3);
  let handled = 0;
  for (const item of incoming) {
    if (handled >= Math.max(1, Math.min(limit, 8))) break;
    try {
      const known = await first<{ id: string }>(
        `SELECT id FROM replies WHERE owner_sub = ? AND gmail_id = ?`,
        ownerSub,
        item.id,
      );
      if (known) continue;
      const message = await getGmailMessage(ownerSub, item.id, "full");
      const from = header(message, "from");
      const subject = header(message, "subject");
      const senderMatch = from.match(/[^\s<>,;"]+@[^\s<>,;"]+/);
      const senderEmail = (senderMatch?.[0] ?? "").toLowerCase();
      if (!senderEmail || senderEmail === mailbox) continue;

      const text = messageText(message);
      const isBounce =
        /mailer-daemon|postmaster/i.test(senderEmail) ||
        /delivery status notification|undeliverable|address not found/i.test(subject);

      if (isBounce) {
        const bounced = await resolveBouncedLead(ownerSub, text);
        if (!bounced) continue;
        const latest = await first<{ id: string }>(
          `SELECT id FROM messages WHERE owner_sub = ? AND lead_id = ? AND status = 'sent'
           ORDER BY sent_at DESC LIMIT 1`,
          ownerSub,
          bounced.id,
        );
        if (latest) {
          await run(
            `UPDATE messages SET status = 'failed', error = 'Bounced (Gmail delivery failure).', updated_at = ?
             WHERE owner_sub = ? AND id = ?`,
            now(),
            ownerSub,
            latest.id,
          );
        }
        await run(
          `UPDATE leads SET status = 'bounced', updated_at = ? WHERE owner_sub = ? AND id = ?`,
          now(),
          ownerSub,
          bounced.id,
        );
        await run(
          `INSERT INTO replies (owner_sub, id, lead_id, thread_id, gmail_id, from_email, subject, snippet, body,
            received_at, classification, summary, recommended_action, handled, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ownerSub,
          crypto.randomUUID(),
          bounced.id,
          item.threadId,
          item.id,
          senderEmail,
          subject,
          "Delivery failure notice",
          text.slice(0, 4000),
          now(),
          "bounce",
          `The email to ${bounced.email} could not be delivered.`,
          "Check the address before any further contact. Do not retry automatically.",
          0,
          now(),
        );
        await logEvent(ownerSub, bounced.id, "bounced", { subject });
        result.processed += 1;
        handled += 1;
        result.details.push(`Bounce: ${bounced.email}`);
        continue;
      }

      const lead = await first<Lead>(
        `SELECT * FROM leads WHERE owner_sub = ? AND email_norm = ?`,
        ownerSub,
        senderEmail,
      );
      if (!lead) continue;

      const analysis = await analyseReply(ownerSub, text || message.snippet || "", lead, settings, knowledge);
      const suppressionNeeded =
        analysis.suppress || analysis.classification === "unsubscribe" || UNSUBSCRIBE_WORDS.test(text);

      await run(
        `INSERT INTO replies (owner_sub, id, lead_id, thread_id, gmail_id, from_email, subject, snippet, body,
          received_at, classification, summary, recommended_action, draft_reply, handled, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
        ownerSub,
        crypto.randomUUID(),
        lead.id,
        message.threadId ?? item.threadId,
        item.id,
        senderEmail,
        subject,
        message.snippet ?? "",
        text.slice(0, 6000),
        new Date(Number(message.internalDate ?? Date.now())).toISOString(),
        suppressionNeeded ? "unsubscribe" : analysis.classification,
        analysis.summary,
        analysis.recommended_action,
        analysis.draft_reply ?? "",
        now(),
      );

      await run(
        `UPDATE messages SET status = 'cancelled', updated_at = ?
         WHERE owner_sub = ? AND lead_id = ? AND status IN ('pending_approval','approved')`,
        now(),
        ownerSub,
        lead.id,
      );
      if (suppressionNeeded) {
        if (lead.email) await addSuppression(ownerSub, lead.email, "Requested no further contact");
        await run(
          `UPDATE leads SET status = 'unsubscribed', updated_at = ? WHERE owner_sub = ? AND id = ?`,
          now(),
          ownerSub,
          lead.id,
        );
      } else {
        await run(
          `UPDATE leads SET status = 'replied', updated_at = ? WHERE owner_sub = ? AND id = ?`,
          now(),
          ownerSub,
          lead.id,
        );
      }
      await logEvent(ownerSub, lead.id, "replied", { classification: analysis.classification, suppress: suppressionNeeded });
      result.processed += 1;
      handled += 1;
      result.details.push(`${lead.business ?? senderEmail}: ${analysis.classification}`);
    } catch (err) {
      if (err instanceof ConfigError) {
        result.errors.push(err.message);
        break;
      }
      result.errors.push(err instanceof Error ? err.message : "reply sync failed");
    }
  }

  const pending = await first<{ c: number }>(
    `SELECT COUNT(*) AS c FROM messages WHERE owner_sub = ? AND status IN ('sent','sending')`,
    ownerSub,
  );
  result.info = `Checked ${incoming.length} recent messages; ${result.processed} new replies/bounces recorded.`;
  result.remaining = (pending?.c ?? 0) > 0 ? Math.min(limit, 5) : 0;
  return result;
}

async function resolveBouncedLead(ownerSub: string, text: string): Promise<Lead | null> {
  const emails = Array.from(
    new Set((text.match(/[^\s<>,;:"()]+@[^\s<>,;:"()]+\.[a-z]{2,}/gi) ?? []).map((e) => e.toLowerCase())),
  );
  for (const email of emails.slice(0, 6)) {
    const lead = await first<Lead>(`SELECT * FROM leads WHERE owner_sub = ? AND email_norm = ?`, ownerSub, email);
    if (lead) return lead;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Follow-ups
// ---------------------------------------------------------------------------

export async function runFollowups(
  ownerSub: string,
  campaignId: string | null,
  limit: number,
): Promise<BatchResult> {
  const [settings, knowledge] = await Promise.all([getSettings(ownerSub), knowledgeForCampaign(ownerSub)]);
  const result = empty();
  const candidates = await findFollowupCandidates(ownerSub, Math.max(1, Math.min(limit, 4)) * 3);
  const scoped = campaignId ? candidates.filter((c) => c.campaign.id === campaignId) : candidates;

  for (const candidate of scoped.slice(0, Math.max(1, Math.min(limit, 4)))) {
    try {
      if (candidate.campaign.status !== "approved" && candidate.campaign.status !== "running") {
        result.details.push(`${candidate.lead.business ?? candidate.lead.email}: campaign not approved, skipped`);
        continue;
      }
      if (await isSuppressed(ownerSub, candidate.lead.email)) continue;
      const original = await first<Message>(
        `SELECT * FROM messages WHERE owner_sub = ? AND lead_id = ? AND status = 'sent'
         ORDER BY sent_at DESC LIMIT 1`,
        ownerSub,
        candidate.lead.id,
      );
      if (!original) continue;
      const research = parseResearch(candidate.lead.research);
      const email = await composeFollowUp(
        ownerSub,
        candidate.lead,
        research,
        candidate.config,
        settings,
        knowledge,
        original,
        candidate.step,
      );
      const invalid = validateEmail(email.subject, email.body);
      if (invalid) throw new Error(invalid);
      const autoApprove = candidate.config.auto_approve_followups && !candidate.config.require_approval;
      await run(
        `INSERT INTO messages (owner_sub, id, lead_id, campaign_id, step, kind, subject, body, angle, rationale, service,
          status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ownerSub,
        crypto.randomUUID(),
        candidate.lead.id,
        candidate.campaign.id,
        candidate.step,
        "followup",
        email.subject,
        email.body,
        email.angle,
        `${email.rationale}\n\nEvidence used: ${email.evidence.join("; ")}`,
        email.service,
        autoApprove ? "approved" : "pending_approval",
        now(),
        now(),
      );
      await run(
        `UPDATE leads SET status = 'followup_pending', updated_at = ? WHERE owner_sub = ? AND id = ?`,
        now(),
        ownerSub,
        candidate.lead.id,
      );
      await logEvent(ownerSub, candidate.lead.id, "followup_generated", {
        step: candidate.step,
        daysSince: candidate.daysSince,
        autoApprove,
      });
      result.processed += 1;
      result.details.push(`${candidate.lead.business ?? candidate.lead.email}: follow-up ${candidate.step}`);
    } catch (err) {
      if (err instanceof ConfigError) {
        result.errors.push(err.message);
        break;
      }
      result.errors.push(err instanceof Error ? err.message : "follow-up failed");
    }
  }

  const remaining = await findFollowupCandidates(ownerSub, 50);
  result.remaining = campaignId ? remaining.filter((c) => c.campaign.id === campaignId).length : remaining.length;
  await audit(ownerSub, "followups_generated", "campaign", campaignId ?? "all", { processed: result.processed });
  return result;
}
