"use client";

import { normalizeEmail } from "./columns";
import { invalidateDataCache } from "./db-client";
import { authedPost, errorMessage, isQuotaError, sleep } from "./client";
import { ensureWorkspaceToken } from "./workspace";
import {
  addSuppression,
  createMessage,
  formatKnowledgeDigest,
  getKnowledgeBundle,
  getSendQuotaState,
  getSettings,
  listCampaigns,
  listLeads,
  listDismissedReplyIds,
  listMessages,
  listReplies,
  listSuppressions,
  markMessageFailed,
  markMessageSending,
  recordReply,
  recordSendSuccess,
  updateLeadFields,
  updateMessageStatus,
  writeAuditLog,
  writeLeadEvent,
} from "./store";
import {
  checkSendingTierDeliverability,
  DEFAULT_CAMPAIGN_MIN_SCORE,
  evaluateLeadSendEligibility,
  findCancellableFollowupMessageIds,
  resolveUserSendingTier,
} from "./guardrails";
import { checkSendWindow, createRfcMessageId, findFollowupCandidatesFromData } from "./outreach-utils";
import type { ComposedEmail } from "./compose";
import type { ReplyAnalysis } from "./intelligence";
import type { Campaign, Lead, Message, QualificationResult, ResearchResult } from "./types";

export interface BatchResult {
  processed: number;
  remaining: number;
  details: string[];
  errors: string[];
  waitSeconds?: number;
  info?: string;
}

export async function buildLiveKnowledgeDigest(uid: string): Promise<string> {
  const bundle = await getKnowledgeBundle(uid);
  const urlSources = bundle.sources
    .filter((s) => s.kind === "url" && s.url)
    .slice(0, 8)
    .map((s) => ({ id: s.id, url: s.url! }));

  let fetched: Record<string, string> = {};
  if (urlSources.length) {
    try {
      const res = await authedPost<{ results: Record<string, string> }>("/api/knowledge/fetch", {
        urls: urlSources,
      });
      fetched = res.results ?? {};
    } catch {
      fetched = {};
    }
  }
  return formatKnowledgeDigest(bundle, fetched);
}

function scopeLeadsByCampaign(leads: Lead[], campaignId?: string): Lead[] {
  if (!campaignId) return leads;
  return leads.filter((l) => l.campaign_id === campaignId);
}

export async function runResearchBatch(
  uid: string,
  campaignId?: string,
  limit = 2,
): Promise<BatchResult> {
  const [allLeads, settings, knowledge] = await Promise.all([
    listLeads(uid),
    getSettings(uid),
    buildLiveKnowledgeDigest(uid),
  ]);
  const scoped = scopeLeadsByCampaign(allLeads, campaignId);
  const queue = scoped.filter((l) => l.status === "queued_research");
  const batch = queue.slice(0, limit);
  const details: string[] = [];
  const errors: string[] = [];
  let processed = 0;

  for (let i = 0; i < batch.length; i++) {
    const lead = batch[i];
    try {
      const { research } = await authedPost<{ research: ResearchResult }>("/api/ai/research", {
        lead,
        knowledge,
        model: settings.model,
      });
      const insufficient = Boolean(research.insufficient_data);
      await updateLeadFields(uid, lead.id, {
        research,
        research_at: research.checked_at ?? new Date().toISOString(),
        research_ok: !insufficient,
        status: insufficient ? "needs_research" : "researched",
      });
      await writeLeadEvent(uid, lead.id, "researched", {
        confidence: research.confidence,
        insufficient_data: insufficient,
      });
      processed += 1;
      details.push(`${lead.business ?? lead.email ?? "Prospect"} researched (${research.confidence}/100)`);
      if (i < batch.length - 1) await sleep(900);
    } catch (err) {
      const msg = errorMessage(err);
      errors.push(`${lead.business ?? lead.email ?? lead.id}: ${msg}`);
      if (isQuotaError(err)) break;
    }
  }

  if (processed > 0) {
    await writeAuditLog(uid, "research_batch", "campaign", campaignId ?? "all", { processed });
  }

  return {
    processed,
    remaining: Math.max(0, queue.length - batch.length),
    details,
    errors,
  };
}

export async function runQualifyBatch(
  uid: string,
  campaignId?: string,
  limit = 3,
): Promise<BatchResult> {
  const [allLeads, campaigns, settings, knowledge] = await Promise.all([
    listLeads(uid),
    listCampaigns(uid),
    getSettings(uid),
    buildLiveKnowledgeDigest(uid),
  ]);
  const campaignMap = new Map<string, Campaign>(campaigns.map((c) => [c.id, c]));
  const scoped = scopeLeadsByCampaign(allLeads, campaignId);
  const queue = scoped.filter((l) => l.status === "researched");
  const batch = queue.slice(0, limit);
  const details: string[] = [];
  const errors: string[] = [];
  let processed = 0;

  for (let i = 0; i < batch.length; i++) {
    const lead = batch[i];
    try {
      const campaign = lead.campaign_id ? campaignMap.get(lead.campaign_id) : undefined;
      const cfg = campaign?.config ?? {
        services: ["Website redesign"],
        target_industry: lead.industry || "any",
        objective: "Start a conversation about improving their digital presence",
        tone: "conversational and professional",
        min_score: settings.min_score,
        lead_count: 10,
        send_limit: settings.campaign_limit,
        interval_seconds: settings.interval_seconds,
        followup_days: [4, 9],
        auto_approve_initial: false,
        auto_approve_followups: false,
        require_approval: true,
        identity: "company",
        extra_instructions: "",
      };
      const minScore = cfg.min_score ?? settings.min_score ?? DEFAULT_CAMPAIGN_MIN_SCORE;
      const { qualification } = await authedPost<{ qualification: QualificationResult }>(
        "/api/ai/qualify",
        {
          lead,
          research: lead.research,
          campaign: cfg,
          minScore,
          knowledge,
          model: settings.model,
        },
      );
      const killSwitchHit =
        Boolean(qualification.kill_switch_triggered) ||
        qualification.tier === "DISQUALIFIED" ||
        qualification.category === "not_qualified";
      const nextStatus =
        killSwitchHit
          ? "disqualified"
          : qualification.category === "needs_research"
            ? "needs_research"
            : qualification.score >= minScore
              ? "qualified"
              : "disqualified";

      await updateLeadFields(uid, lead.id, {
        score: qualification.score,
        priority: qualification.category,
        score_reason: qualification,
        status: nextStatus,
      });
      await writeLeadEvent(uid, lead.id, "qualified", {
        score: qualification.score,
        category: qualification.category,
      });
      processed += 1;
      details.push(`${lead.business ?? lead.email ?? "Prospect"}: ${qualification.score}/100 (${nextStatus})`);
      if (i < batch.length - 1) await sleep(900);
    } catch (err) {
      errors.push(`${lead.business ?? lead.email ?? lead.id}: ${errorMessage(err)}`);
      if (isQuotaError(err)) break;
    }
  }

  if (processed > 0) {
    await writeAuditLog(uid, "qualify_batch", "campaign", campaignId ?? "all", { processed });
  }

  return {
    processed,
    remaining: Math.max(0, queue.length - batch.length),
    details,
    errors,
  };
}

export async function runComposeBatch(
  uid: string,
  campaignId?: string,
  limit = 2,
): Promise<BatchResult> {
  const [allLeads, campaigns, messages, suppressions, settings, knowledge] = await Promise.all([
    listLeads(uid),
    listCampaigns(uid),
    listMessages(uid),
    listSuppressions(uid),
    getSettings(uid),
    buildLiveKnowledgeDigest(uid),
  ]);
  const campaignMap = new Map<string, Campaign>(campaigns.map((c) => [c.id, c]));
  const suppressedSet = new Set(suppressions.map((s) => s.email.toLowerCase()));
  const existingInitialLeads = new Set(
    messages
      .filter((m) => m.kind === "initial" && m.status !== "cancelled" && m.status !== "failed")
      .map((m) => m.lead_id),
  );

  const scoped = scopeLeadsByCampaign(allLeads, campaignId);
  const queue = scoped.filter((l) => l.status === "qualified" && !existingInitialLeads.has(l.id));
  const batch = queue.slice(0, limit);
  const details: string[] = [];
  const errors: string[] = [];
  let processed = 0;

  for (let i = 0; i < batch.length; i++) {
    const lead = batch[i];
    if (lead.email_norm && suppressedSet.has(lead.email_norm.toLowerCase())) {
      await updateLeadFields(uid, lead.id, { status: "suppressed" });
      details.push(`${lead.email_norm} skipped (suppressed)`);
      continue;
    }
    if (!lead.research) {
      errors.push(`${lead.business ?? lead.id}: missing stored research.`);
      continue;
    }
    const campaign = lead.campaign_id ? campaignMap.get(lead.campaign_id) : undefined;
    if (!campaign) {
      errors.push(`${lead.business ?? lead.id}: assign prospect to a campaign first.`);
      continue;
    }
    // Phase 5 Hard Qualification Gate before drafting/queuing
    const gate = evaluateLeadSendEligibility({
      lead,
      campaign,
      minScore: campaign.config.min_score ?? settings.min_score ?? DEFAULT_CAMPAIGN_MIN_SCORE,
      senderEmail: settings.sender_email,
      suppressedEmails: suppressedSet,
    });
    if (!gate.eligible) {
      errors.push(`${lead.business ?? lead.email ?? lead.id}: ${gate.reason}`);
      if (gate.code === "SUPPRESSED") {
        await updateLeadFields(uid, lead.id, { status: "suppressed" });
      }
      continue;
    }
    try {
      const { composed } = await authedPost<{ composed: ComposedEmail }>("/api/ai/compose", {
        kind: "initial",
        lead,
        research: lead.research,
        campaign: campaign.config,
        settings,
        knowledge,
        model: settings.model,
      });
      const autoApprove = Boolean(campaign.config.auto_approve_initial && !campaign.config.require_approval);
      const msgStatus: Message["status"] = autoApprove ? "approved" : "pending_approval";
      await createMessage(uid, {
        lead_id: lead.id,
        campaign_id: campaign.id,
        step: 1,
        kind: "initial",
        subject: composed.subject,
        body: composed.body,
        angle: composed.angle,
        rationale: composed.rationale,
        service: composed.service,
        status: msgStatus,
      });
      await updateLeadFields(uid, lead.id, {
        status: autoApprove ? "approved" : "email_generated",
      });
      await writeLeadEvent(uid, lead.id, "email_composed", { step: 1, status: msgStatus });
      processed += 1;
      details.push(`Drafted email for ${lead.business ?? lead.email ?? "Prospect"}`);
      if (i < batch.length - 1) await sleep(900);
    } catch (err) {
      errors.push(`${lead.business ?? lead.email ?? lead.id}: ${errorMessage(err)}`);
      if (isQuotaError(err)) break;
    }
  }

  if (processed > 0) {
    await writeAuditLog(uid, "compose_batch", "campaign", campaignId ?? "all", { processed });
  }

  return {
    processed,
    remaining: Math.max(0, queue.length - batch.length),
    details,
    errors,
  };
}

export async function runFollowupsBatch(
  uid: string,
  campaignId?: string,
  limit = 2,
): Promise<BatchResult> {
  const [leads, campaigns, messages, replies, settings, knowledge] = await Promise.all([
    listLeads(uid),
    listCampaigns(uid),
    listMessages(uid),
    listReplies(uid),
    getSettings(uid),
    buildLiveKnowledgeDigest(uid),
  ]);

  const candidatesAll = findFollowupCandidatesFromData({
    leads: scopeLeadsByCampaign(leads, campaignId),
    campaigns,
    messages,
    replies,
    limit: 50,
  });
  const batch = candidatesAll.slice(0, limit);
  const details: string[] = [];
  const errors: string[] = [];
  let processed = 0;

  for (let i = 0; i < batch.length; i++) {
    const candidate = batch[i];
    const sentForLead = messages
      .filter((m) => m.lead_id === candidate.lead.id && m.status === "sent")
      .sort((a, b) => (b.sent_at ?? "").localeCompare(a.sent_at ?? ""));
    const original = sentForLead[0];
    if (!original) continue;

    try {
      const { composed } = await authedPost<{ composed: ComposedEmail }>("/api/ai/compose", {
        kind: "followup",
        lead: candidate.lead,
        research: candidate.lead.research,
        campaign: candidate.config,
        settings,
        knowledge,
        original,
        step: candidate.step,
        model: settings.model,
      });
      const autoApprove = Boolean(candidate.config.auto_approve_followups && !candidate.config.require_approval);
      const msgStatus: Message["status"] = autoApprove ? "approved" : "pending_approval";
      await createMessage(uid, {
        lead_id: candidate.lead.id,
        campaign_id: candidate.campaign.id,
        step: candidate.step,
        kind: "followup",
        subject: composed.subject,
        body: composed.body,
        angle: composed.angle,
        rationale: composed.rationale,
        service: composed.service,
        status: msgStatus,
      });
      await updateLeadFields(uid, candidate.lead.id, {
        status: autoApprove ? "approved" : "email_generated",
      });
      await writeLeadEvent(uid, candidate.lead.id, "followup_composed", { step: candidate.step });
      processed += 1;
      details.push(`Follow-up #${candidate.step} prepared for ${candidate.lead.business ?? candidate.lead.email}`);
      if (i < batch.length - 1) await sleep(900);
    } catch (err) {
      errors.push(`${candidate.lead.business ?? candidate.lead.id}: ${errorMessage(err)}`);
      if (isQuotaError(err)) break;
    }
  }

  return {
    processed,
    remaining: Math.max(0, candidatesAll.length - batch.length),
    details,
    errors,
  };
}

export async function runSendBatch(
  uid: string,
  campaignId?: string,
  limit = 2,
): Promise<BatchResult> {
  if (!(await ensureWorkspaceToken())) {
    throw new Error("Connect Google (click 'Connect Google' in the top bar) before sending emails.");
  }
  // Sending must never work from a cached queue: another tab may have already
  // sent one of these, and a duplicate email cannot be undone.
  invalidateDataCache();

  const [leads, campaigns, messages, suppressions, settings] = await Promise.all([
    listLeads(uid),
    listCampaigns(uid),
    listMessages(uid),
    listSuppressions(uid),
    getSettings(uid),
  ]);

  const leadMap = new Map(leads.map((l) => [l.id, l]));
  const campaignMap = new Map(campaigns.map((c) => [c.id, c]));
  const suppressedSet = new Set(suppressions.map((s) => s.email.toLowerCase()));

  // Recover any message left in "sending" cleanly before counting queue
  const stuckSending = messages.filter(
    (m) => m.status === "sending" && m.rfc_message_id && (!campaignId || m.campaign_id === campaignId),
  );
  for (const m of stuckSending.slice(0, 5)) {
    const lead = leadMap.get(m.lead_id);
    if (!lead) continue;
    try {
      const { found } = await authedPost<{ found: { id: string; threadId: string } | null }>(
        "/api/workspace/gmail",
        { action: "findSentByRfc", rfcMessageId: m.rfc_message_id },
        { requireWorkspace: true },
      );
      if (found) {
        await recordSendSuccess(uid, m, lead, found.id, found.threadId);
      }
    } catch {
      // keep looking
    }
  }

  const queue = messages.filter((m) => {
    if (m.status !== "approved") return false;
    if (campaignId && m.campaign_id !== campaignId) return false;
    if (m.campaign_id) {
      const camp = campaignMap.get(m.campaign_id);
      if (camp && camp.status !== "approved" && camp.status !== "running") return false;
    }
    return true;
  });

  if (queue.length === 0) {
    const approvedSomewhere = messages.filter(
      (m) => m.status === "approved" && (!campaignId || m.campaign_id === campaignId),
    );
    const blockedByCampaign = approvedSomewhere.length > 0;
    return {
      processed: 0,
      remaining: 0,
      details: [],
      errors: [],
      info: blockedByCampaign
        ? "These emails are approved, but their campaign is not. Approve or resume the campaign first."
        : "No approved emails waiting to send.",
    };
  }

  const windowCheck = checkSendWindow(settings);
  if (!windowCheck.allowed) {
    return {
      processed: 0,
      remaining: queue.length,
      details: [],
      errors: [],
      info: `${windowCheck.reason} (Local time: ${windowCheck.localTime})`,
    };
  }

  const quota = await getSendQuotaState(uid, settings);
  const remainingDaily = settings.daily_limit - quota.sendsTodayCount;
  if (remainingDaily <= 0) {
    return {
      processed: 0,
      remaining: queue.length,
      details: [],
      errors: [],
      info: `Daily send limit reached (${settings.daily_limit}/day).`,
    };
  }

  if (quota.lastSendMs) {
    const elapsedSec = Math.floor((Date.now() - quota.lastSendMs) / 1000);
    if (elapsedSec < settings.interval_seconds) {
      return {
        processed: 0,
        remaining: queue.length,
        details: [],
        errors: [],
        waitSeconds: settings.interval_seconds - elapsedSec,
        info: `Respecting ${settings.interval_seconds}s send interval`,
      };
    }
  }

  const profile = await authedPost<{ emailAddress: string }>(
    "/api/workspace/gmail",
    { action: "profile" },
    { requireWorkspace: true },
  );
  const senderEmail = settings.sender_email?.trim() || profile.emailAddress;
  const sendingTier = resolveUserSendingTier(senderEmail);
  const tierQuotaCheck = checkSendingTierDeliverability({
    tier: sendingTier,
    configuredDailyLimit: settings.daily_limit,
    sendsTodayCount: quota.sendsTodayCount,
  });
  const effectiveRemainingDaily = tierQuotaCheck.effectiveDailyCap - quota.sendsTodayCount;
  if (effectiveRemainingDaily <= 0) {
    return {
      processed: 0,
      remaining: queue.length,
      details: [],
      errors: [],
      info: `Daily send limit reached (${tierQuotaCheck.effectiveDailyCap}/day for ${sendingTier === "free_gmail_starter" ? "Free Gmail Starter" : "Custom Domain"}).`,
    };
  }

  const sentPerCampaign = new Map<string, number>();
  for (const m of messages) {
    if (m.status === "sent" && m.campaign_id) {
      sentPerCampaign.set(m.campaign_id, (sentPerCampaign.get(m.campaign_id) ?? 0) + 1);
    }
  }

  const batch = queue.slice(0, Math.min(limit, effectiveRemainingDaily));
  const details: string[] = [];
  const errors: string[] = [];
  let processed = 0;

  for (let i = 0; i < batch.length; i++) {
    const msg = batch[i];
    const lead = leadMap.get(msg.lead_id);
    if (!lead?.email) {
      await markMessageFailed(uid, msg.id, "Prospect has no email address.");
      errors.push(`${lead?.business ?? msg.lead_id}: missing email address.`);
      continue;
    }
    const camp = msg.campaign_id ? campaignMap.get(msg.campaign_id) ?? null : null;
    const gate = evaluateLeadSendEligibility({
      lead,
      campaign: camp,
      minScore: camp?.config.min_score ?? settings.min_score ?? DEFAULT_CAMPAIGN_MIN_SCORE,
      senderEmail,
      suppressedEmails: suppressedSet,
    });
    if (!gate.eligible) {
      await markMessageFailed(uid, msg.id, gate.reason ?? "Blocked by qualification/deliverability guardrail.");
      if (gate.code === "SUPPRESSED") {
        await updateLeadFields(uid, lead.id, { status: "suppressed" });
      }
      errors.push(`${lead.business ?? lead.email}: ${gate.reason}`);
      continue;
    }
    if (camp) {
      const cap = camp.config.send_limit ?? settings.campaign_limit;
      const used = sentPerCampaign.get(msg.campaign_id!) ?? 0;
      if (used >= cap) {
        errors.push(`Campaign limit (${cap}) reached for ${camp.name ?? msg.campaign_id}.`);
        continue;
      }
    }

    const msgDeliv = checkSendingTierDeliverability({
      tier: sendingTier,
      subject: msg.subject,
      body: msg.body,
      isColdTouch1: msg.kind === "initial",
    });

    const rfcMessageId = createRfcMessageId(msg.id, senderEmail);
    const previousSent = messages
      .filter((m) => m.lead_id === lead.id && m.status === "sent")
      .sort((a, b) => (b.sent_at ?? "").localeCompare(a.sent_at ?? ""))[0];

    try {
      await markMessageSending(uid, msg.id, rfcMessageId);
      const sent = await authedPost<{ id: string; threadId: string; deliverabilityWarnings?: string[] }>(
        "/api/workspace/gmail",
        {
          action: "send",
          email: {
            to: lead.email,
            from: senderEmail,
            fromName: settings.sender_name || settings.sender_company || senderEmail,
            subject: msg.subject ?? "(no subject)",
            body: msg.body ?? "",
            rfcMessageId,
            inReplyTo: msg.kind === "followup" ? previousSent?.rfc_message_id ?? null : null,
            threadId: msg.kind === "followup" ? previousSent?.thread_id ?? null : null,
            plainTextOnly: msgDeliv.preferPlainText,
            tracking: { enabled: !msgDeliv.preferPlainText, messageId: msg.id, leadId: lead.id },
          },
        },
        { requireWorkspace: true },
      );
      await recordSendSuccess(uid, msg, lead, sent.id, sent.threadId);
      if (msg.campaign_id) {
        sentPerCampaign.set(msg.campaign_id, (sentPerCampaign.get(msg.campaign_id) ?? 0) + 1);
      }
      processed += 1;
      const warnSuffix = msgDeliv.warnings.length ? ` (Warning: ${msgDeliv.warnings[0]})` : "";
      details.push(`Sent to ${lead.email}${warnSuffix}`);
      if (i < batch.length - 1) {
        await sleep(settings.interval_seconds * 1000);
      }
    } catch (err) {
      const text = errorMessage(err);
      await markMessageFailed(uid, msg.id, text);
      errors.push(`${lead.email}: ${text}`);
    }
  }

  return {
    processed,
    remaining: Math.max(0, queue.length - batch.length),
    details,
    errors,
  };
}

/** Send one specific approved email immediately (the per-message Send now action). */
export async function sendMessageNow(
  uid: string,
  messageId: string,
): Promise<{ processed: number; info: string }> {
  if (!(await ensureWorkspaceToken())) {
    throw new Error("Connect Google (click 'Connect Google' in the top bar) before sending emails.");
  }
  invalidateDataCache();

  const [leads, campaigns, messages, suppressions, settings] = await Promise.all([
    listLeads(uid),
    listCampaigns(uid),
    listMessages(uid),
    listSuppressions(uid),
    getSettings(uid),
  ]);

  const msg = messages.find((m) => m.id === messageId);
  if (!msg) throw new Error("That email no longer exists. Reload and try again.");
  if (msg.status === "sent") return { processed: 0, info: "That email was already sent." };
  if (msg.status === "sending") throw new Error("That email is already being sent.");
  if (msg.status !== "approved") throw new Error("Approve the email before sending it.");

  const lead = leads.find((l) => l.id === msg.lead_id);
  if (!lead?.email) throw new Error("This prospect has no email address.");

  let sendCamp: Campaign | null = null;
  if (msg.campaign_id) {
    const camp = campaigns.find((c) => c.id === msg.campaign_id);
    if (camp && camp.status !== "approved" && camp.status !== "running") {
      throw new Error(
        `Campaign "${camp.name}" is ${camp.status}. Approve or resume it before sending its emails.`,
      );
    }
    sendCamp = camp ?? null;
  }

  const profile = await authedPost<{ emailAddress: string }>(
    "/api/workspace/gmail",
    { action: "profile" },
    { requireWorkspace: true },
  );
  const senderEmail = settings.sender_email?.trim() || profile.emailAddress;

  const gate = evaluateLeadSendEligibility({
    lead,
    campaign: sendCamp,
    minScore: sendCamp?.config.min_score ?? settings.min_score ?? DEFAULT_CAMPAIGN_MIN_SCORE,
    senderEmail,
    suppressedEmails: suppressions.map((s) => s.email),
  });
  if (!gate.eligible) {
    throw new Error(gate.reason || "Prospect is blocked from sending by qualification/deliverability guardrails.");
  }

  const quota = await getSendQuotaState(uid, settings);
  const sendingTier = resolveUserSendingTier(senderEmail);
  const delivCheck = checkSendingTierDeliverability({
    tier: sendingTier,
    subject: msg.subject,
    body: msg.body,
    configuredDailyLimit: settings.daily_limit,
    sendsTodayCount: quota.sendsTodayCount,
    isColdTouch1: msg.kind === "initial",
  });
  if (delivCheck.dailyCapExceeded) {
    throw new Error(`Daily send limit reached (${delivCheck.effectiveDailyCap}/day).`);
  }

  const rfcMessageId = createRfcMessageId(msg.id, senderEmail);
  const previousSent = messages
    .filter((m) => m.lead_id === lead.id && m.status === "sent")
    .sort((a, b) => (b.sent_at ?? "").localeCompare(a.sent_at ?? ""))[0];

  try {
    await markMessageSending(uid, msg.id, rfcMessageId);
    const sent = await authedPost<{ id: string; threadId: string }>(
      "/api/workspace/gmail",
      {
        action: "send",
        email: {
          to: lead.email,
          from: senderEmail,
          fromName: settings.sender_name || settings.sender_company || senderEmail,
          subject: msg.subject ?? "(no subject)",
          body: msg.body ?? "",
          rfcMessageId,
          inReplyTo: msg.kind === "followup" ? previousSent?.rfc_message_id ?? null : null,
          threadId: msg.kind === "followup" ? previousSent?.thread_id ?? null : null,
          plainTextOnly: delivCheck.preferPlainText,
          tracking: { enabled: !delivCheck.preferPlainText, messageId: msg.id, leadId: lead.id },
        },
      },
      { requireWorkspace: true },
    );
    await recordSendSuccess(uid, msg, lead, sent.id, sent.threadId);
    const warnNote = delivCheck.warnings.length ? ` Deliverability note: ${delivCheck.warnings[0]}` : "";
    return { processed: 1, info: `Sent to ${lead.email}.${warnNote}` };
  } catch (err) {
    const text = errorMessage(err);
    await markMessageFailed(uid, msg.id, text);
    throw new Error(text);
  }
}

function extractEmailAddress(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/[^\s<>]+@[^\s<>]+\.[a-z]{2,}/i);
  return match ? normalizeEmail(match[0]) : null;
}

export async function runSyncBatch(uid: string, limit = 15): Promise<BatchResult> {
  if (!(await ensureWorkspaceToken())) {
    throw new Error("Connect Google (click 'Connect Google' in the top bar) to sync Gmail replies.");
  }

  const [leads, messages, replies, settings, knowledge, dismissed] = await Promise.all([
    listLeads(uid),
    listMessages(uid),
    listReplies(uid),
    getSettings(uid),
    buildLiveKnowledgeDigest(uid),
    listDismissedReplyIds(uid),
  ]);

  // Replies the user deleted stay deleted: the records are gone, so their Gmail
  // ids are remembered separately and skipped when the inbox is read again.
  const seenGmailIds = new Set([
    ...replies.map((r) => r.gmail_id),
    ...Array.from(dismissed),
  ]);
  const leadByEmail = new Map<string, Lead>();
  for (const l of leads) {
    if (l.email_norm) leadByEmail.set(l.email_norm.toLowerCase(), l);
  }
  const leadByThread = new Map<string, Lead>();
  const leadMap = new Map(leads.map((l) => [l.id, l]));
  for (const m of messages) {
    if (m.thread_id && m.status === "sent") {
      const lead = leadMap.get(m.lead_id);
      if (lead) leadByThread.set(m.thread_id, lead);
    }
  }

  const listed = await authedPost<{ messages: { id: string; threadId: string }[] }>(
    "/api/workspace/gmail",
    { action: "list", q: "in:inbox newer_than:21d", maxResults: Math.max(15, limit * 2) },
    { requireWorkspace: true },
  );

  const details: string[] = [];
  const errors: string[] = [];
  let processed = 0;

  for (const item of listed.messages) {
    if (seenGmailIds.has(item.id)) continue;
    try {
      const full = await authedPost<{
        id: string;
        threadId: string;
        snippet: string;
        internalDate: string;
        headers: Record<string, string>;
        body: string;
      }>("/api/workspace/gmail", { action: "get", id: item.id }, { requireWorkspace: true });

      const fromEmail = extractEmailAddress(full.headers.from);
      const receivedAt = new Date(Number(full.internalDate) || Date.now()).toISOString();
      const bodyLower = `${full.headers.subject ?? ""}\n${full.body}\n${full.snippet}`.toLowerCase();
      const isBounce =
        Boolean(fromEmail && (fromEmail.includes("mailer-daemon") || fromEmail.includes("postmaster"))) ||
        bodyLower.includes("delivery status notification") ||
        bodyLower.includes("address not found");

      if (isBounce) {
        const bouncedLead = leads.find(
          (l) => l.email_norm && bodyLower.includes(l.email_norm.toLowerCase()),
        );
        if (bouncedLead) {
          await recordReply(uid, {
            lead_id: bouncedLead.id,
            thread_id: full.threadId,
            gmail_id: full.id,
            from_email: fromEmail,
            subject: full.headers.subject ?? "(bounce)",
            snippet: full.snippet,
            body: full.body,
            received_at: receivedAt,
            classification: "bounce",
            summary: "Delivery bounce detected for prospect email address.",
            recommended_action: "Verify or remove bounced email address.",
            draft_reply: "",
          });
          await updateLeadFields(uid, bouncedLead.id, { status: "bounced" });
          if (bouncedLead.email_norm) {
            await addSuppression(uid, bouncedLead.email_norm, "Hard bounce detected in Gmail");
          }
          processed += 1;
          details.push(`Bounce logged for ${bouncedLead.email_norm}`);
        }
        continue;
      }

      const matchedLead =
        (fromEmail ? leadByEmail.get(fromEmail.toLowerCase()) : undefined) ??
        leadByThread.get(full.threadId);
      if (!matchedLead) continue;

      const leadThreadMsgs = messages.filter((m) => m.lead_id === matchedLead.id);
      const { analysis } = await authedPost<{ analysis: ReplyAnalysis }>("/api/ai/analyse-reply", {
        replyText: full.body || full.snippet,
        lead: matchedLead,
        settings,
        knowledge,
        model: settings.model,
        threadMessages: leadThreadMsgs,
      });

      const actionTag = `[${analysis.reply_class} · ${analysis.sequence_action}${
        analysis.snooze_until ? ` until ${analysis.snooze_until}` : ""
      }]`;

      await recordReply(uid, {
        lead_id: matchedLead.id,
        thread_id: full.threadId,
        gmail_id: full.id,
        from_email: fromEmail ?? matchedLead.email,
        subject: full.headers.subject ?? "",
        snippet: full.snippet,
        body: full.body,
        received_at: receivedAt,
        classification: analysis.classification,
        summary: analysis.summary,
        recommended_action: `${actionTag} ${analysis.recommended_action}`.trim(),
        draft_reply: analysis.suggested_reply ?? analysis.draft_reply,
      });

      // Halt or snooze unsent active follow-ups for this prospect immediately
      const cancellableIds = findCancellableFollowupMessageIds(messages, matchedLead.id);
      for (const msgId of cancellableIds) {
        await updateMessageStatus(uid, msgId, "cancelled", {
          error:
            analysis.sequence_action === "SNOOZE" && analysis.snooze_until
              ? `Snoozed until ${analysis.snooze_until} (${analysis.reply_class})`
              : `Stopped by reply triage (${analysis.reply_class} -> ${analysis.sequence_action})`,
        });
      }

      const isUnsub =
        analysis.sequence_action === "GLOBAL_SUPPRESS" ||
        analysis.suppress ||
        analysis.classification === "unsubscribe";
      await updateLeadFields(uid, matchedLead.id, {
        status: isUnsub ? "unsubscribed" : "replied",
      });
      if (isUnsub && matchedLead.email_norm) {
        await addSuppression(uid, matchedLead.email_norm, `Opt-out (${analysis.reply_class})`);
      }
      await writeLeadEvent(uid, matchedLead.id, "reply_received", {
        classification: analysis.classification,
        reply_class: analysis.reply_class,
        sequence_action: analysis.sequence_action,
        snooze_until: analysis.snooze_until,
      });
      processed += 1;
      details.push(`Reply from ${matchedLead.business ?? matchedLead.email} (${analysis.reply_class} -> ${analysis.sequence_action})`);
    } catch (err) {
      errors.push(errorMessage(err));
      if (isQuotaError(err)) break;
    }
  }

  return {
    processed,
    remaining: 0,
    details,
    errors,
    info: processed ? `Synced ${processed} new repl${processed === 1 ? "y" : "ies"}.` : "Inbox is up to date.",
  };
}

export async function writebackCampaignStatuses(
  uid: string,
  campaignId: string,
): Promise<{ updated: number; column: string }> {
  const leads = await listLeads(uid);
  const campLeads = leads.filter((l) => l.campaign_id === campaignId && l.source_ref && l.sheet_row);
  if (!campLeads.length) return { updated: 0, column: "" };

  const grouped = new Map<string, { spreadsheetId: string; tab: string; rows: { row: number; status: string }[] }>();
  for (const lead of campLeads) {
    const [spreadsheetId, tab] = String(lead.source_ref).split("|");
    if (!spreadsheetId || !tab || !lead.sheet_row) continue;
    const key = `${spreadsheetId}|${tab}`;
    const entry = grouped.get(key) ?? { spreadsheetId, tab, rows: [] };
    entry.rows.push({ row: lead.sheet_row, status: lead.status });
    grouped.set(key, entry);
  }

  let totalUpdated = 0;
  let lastColumn = "";
  for (const group of grouped.values()) {
    const res = await authedPost<{ updated: number; column: string }>(
      "/api/workspace/sheets",
      {
        action: "writeback",
        spreadsheetId: group.spreadsheetId,
        tab: group.tab,
        rows: group.rows,
      },
      { requireWorkspace: true },
    );
    totalUpdated += res.updated;
    lastColumn = res.column || lastColumn;
  }
  return { updated: totalUpdated, column: lastColumn };
}
