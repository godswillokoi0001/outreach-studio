"use client";

import { MUTATING_TOOLS, sanitizeRoute, type AppRoute } from "./agent-meta";
import { authedPost, errorMessage } from "./client";
import type { ComposedEmail } from "./compose";
import {
  addKnowledgeSource,
  addSuppression,
  approveAllMessagesInCampaign,
  assignLeadsToCampaign,
  createCampaign,
  createLead,
  deleteLeadCascade,
  getKnowledgeBundle,
  getSettings,
  importSheetRows,
  listCampaigns,
  listLeads,
  listMessages,
  listReplies,
  listSuppressions,
  loadAnalyticsBundle,
  moveLeadsToCampaign,
  loadDashboardBundle,
  loadFollowupsBundle,
  saveMasterKnowledge,
  saveSettings,
  updateCampaignAction,
  updateLeadFields,
  updateMessageContent,
  updateMessageStatus,
  updateReplyHandled,
  upsertKnowledgeEntry,
  writeAuditLog,
} from "./store";
import type { CampaignPlan, DiscoveryCandidate, PerformanceInsight } from "./intelligence";
import {
  buildLiveKnowledgeDigest,
  runComposeBatch,
  runFollowupsBatch,
  runQualifyBatch,
  runResearchBatch,
  runSendBatch,
  runSyncBatch,
  writebackCampaignStatuses,
} from "./pipeline-client";
import { computeDashboardStats, findFollowupCandidatesFromData } from "./outreach-utils";
import {
  activeProviderEntry,
  patchActiveModel,
  providersFromSettings,
  readProviders,
  setActiveProviderId,
  toAiConfig,
  writeProviders,
} from "./ai/providers";
import { setActiveAiConfig } from "./ai-client";
import type { LeadStatus, Settings } from "./types";

export interface AgentExecutionEnv {
  uid: string;
  navigate: (route: AppRoute) => void;
  onDataMutated: () => void;
  hasWorkspaceToken: () => boolean;
}

export interface ToolExecutionResult {
  ok: boolean;
  summary: string;
  data: Record<string, unknown>;
  needsWorkspace?: boolean;
  navigatedTo?: AppRoute;
}

function asStr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function asInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampText(text: string | null | undefined, max: number): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export async function buildQuickWorkspaceSummary(uid: string): Promise<string> {
  try {
    const [leads, campaigns, messages, replies, settings] = await Promise.all([
      listLeads(uid),
      listCampaigns(uid),
      listMessages(uid),
      listReplies(uid),
      getSettings(uid),
    ]);
    const stats = computeDashboardStats({
      leads,
      campaigns,
      messages,
      replies,
      sendLogs: [],
      auditLogs: [],
    });
    const followupsDue = findFollowupCandidatesFromData({
      leads,
      campaigns,
      messages,
      replies,
      limit: 50,
    }).length;
    const s = stats.leads.byStatus;
    return [
      `Leads: ${stats.leads.total} total (${s.new ?? 0} new, ${s.queued_research ?? 0} queued_research, ${stats.leads.researched} researched, ${stats.leads.qualified} qualified, ${s.sent ?? 0} sent, ${s.replied ?? 0} replied)`,
      `Campaigns: ${stats.campaigns.length} (${stats.campaigns.filter((c) => c.status === "approved" || c.status === "running").length} active)`,
      `Emails: ${stats.emails.pending} pending approval, ${stats.emails.generated} generated, ${stats.emails.sent} sent, ${stats.emails.failed} failed`,
      `Replies: ${stats.replies.total} total (${stats.replies.positive} positive)`,
      `Follow-ups due: ${followupsDue}`,
      `Model: ${settings.model}`,
    ].join(" | ");
  } catch {
    return "Workspace summary unavailable";
  }
}

export async function executeAgentTool(
  name: string,
  rawArgs: Record<string, unknown> | undefined,
  env: AgentExecutionEnv,
): Promise<ToolExecutionResult> {
  const args = rawArgs ?? {};
  const { uid } = env;

  const notifyIfMutated = (didMutate = true) => {
    if (didMutate && MUTATING_TOOLS.has(name)) {
      env.onDataMutated();
    }
  };

  const requireWorkspace = (): ToolExecutionResult | null => {
    if (env.hasWorkspaceToken()) return null;
    return {
      ok: false,
      needsWorkspace: true,
      summary: "Google Workspace (Gmail & Sheets) needs to be reconnected first.",
      data: {
        error: "Google Workspace OAuth session is not active. Ask the user to click 'Reconnect Gmail & Sheets' and retry.",
        needsWorkspace: true,
      },
    };
  };

  try {
    switch (name) {
      case "navigate_to_page": {
        const route = sanitizeRoute(args.route);
        env.navigate(route);
        return {
          ok: true,
          summary: `Opened ${route}`,
          navigatedTo: route,
          data: { navigated: true, route },
        };
      }

      case "get_dashboard_overview": {
        const [dash, followups] = await Promise.all([loadDashboardBundle(uid), loadFollowupsBundle(uid)]);
        return {
          ok: true,
          summary: `${dash.leads.total} leads · ${dash.campaigns.length} campaigns · ${dash.emails.pending} pending review`,
          data: {
            leads: dash.leads,
            emails: dash.emails,
            replies: dash.replies,
            followups_due: followups.due.length,
            knowledge_empty: dash.knowledgeEmpty,
            campaigns: dash.campaigns.slice(0, 12).map((c) => ({
              id: c.id,
              name: c.name,
              status: c.status,
              leads: c.leads,
              pending: c.pending,
              sent: c.sent,
              replies: c.replies,
            })),
            recent_activity: dash.activity.slice(0, 8),
          },
        };
      }

      case "get_analytics_summary": {
        const [metrics, settings] = await Promise.all([loadAnalyticsBundle(uid), getSettings(uid)]);
        let insight: PerformanceInsight | null = null;
        if (Boolean(args.include_ai_review)) {
          const res = await authedPost<{ insight: PerformanceInsight }>("/api/ai/analytics", {
            metrics,
            model: settings.model,
          });
          insight = res.insight;
        }
        return {
          ok: true,
          summary: insight
            ? `Loaded analytics + AI review (${metrics.delivery.sent} sent, ${metrics.totals.replies} replies)`
            : `Loaded analytics (${metrics.totals.leads} leads, ${metrics.delivery.sent} sent)`,
          data: {
            totals: metrics.totals,
            delivery: metrics.delivery,
            campaigns: metrics.campaigns.slice(0, 10),
            industries: metrics.industries.slice(0, 10),
            angles: metrics.angles.slice(0, 8),
            replyTypes: metrics.replyTypes,
            ai_review: insight,
          },
        };
      }

      case "get_knowledge_base": {
        const bundle = await getKnowledgeBundle(uid);
        const includeContent = args.include_content !== false;
        return {
          ok: true,
          summary: `Master (${bundle.master.length} chars) · ${bundle.entries.length} notes · ${bundle.sources.length} sources`,
          data: {
            master: includeContent ? clampText(bundle.master, 4000) : `${bundle.master.length} characters`,
            entries: bundle.entries.slice(0, 15).map((e) => ({
              id: e.id,
              title: e.title,
              category: e.category,
              content: includeContent ? clampText(e.content, 800) : undefined,
            })),
            sources: bundle.sources.slice(0, 15).map((s) => ({
              id: s.id,
              label: s.label,
              kind: s.kind,
              url: s.url,
              preview: includeContent && s.content ? clampText(s.content, 500) : undefined,
            })),
          },
        };
      }

      case "update_master_knowledge": {
        const content = asStr(args.content);
        if (!content) {
          return { ok: false, summary: "No knowledge content provided.", data: { error: "content is required" } };
        }
        let nextContent = content;
        if (Boolean(args.append)) {
          const current = await getKnowledgeBundle(uid);
          nextContent = current.master.trim() ? `${current.master.trim()}\n\n${content}` : content;
        }
        await saveMasterKnowledge(uid, nextContent);
        await writeAuditLog(uid, "knowledge_updated", "knowledge", "master", { via: "ai_operator" });
        notifyIfMutated(true);
        return {
          ok: true,
          summary: args.append ? "Appended to master knowledge base" : "Updated master knowledge base",
          data: { saved: true, length: nextContent.length },
        };
      }

      case "add_knowledge_source": {
        const label = asStr(args.label, "Reference source");
        const kind = args.kind === "text" ? "text" : "url";
        const url = kind === "url" ? asStr(args.url) : null;
        const content = kind === "text" ? asStr(args.content) : null;
        if (kind === "url" && !url) {
          return { ok: false, summary: "URL is required for URL sources.", data: { error: "url is required" } };
        }
        if (kind === "text" && !content) {
          return { ok: false, summary: "Content is required for text sources.", data: { error: "content is required" } };
        }
        const id = await addKnowledgeSource(uid, { label, kind, url, content });
        notifyIfMutated(true);
        return {
          ok: true,
          summary: `Added knowledge source "${label}"`,
          data: { id, label, kind, url },
        };
      }

      case "save_knowledge_note": {
        const title = asStr(args.title, "Untitled note");
        const content = asStr(args.content);
        if (!content) {
          return { ok: false, summary: "Note content is required.", data: { error: "content is required" } };
        }
        const id = await upsertKnowledgeEntry(uid, {
          id: asStr(args.id) || undefined,
          title,
          content,
        });
        notifyIfMutated(true);
        return {
          ok: true,
          summary: `Saved knowledge note "${title}"`,
          data: { id, title },
        };
      }

      case "list_leads": {
        const leads = await listLeads(uid);
        const statusFilter = asStr(args.status).toLowerCase();
        const search = asStr(args.search).toLowerCase();
        const campaignFilter = asStr(args.campaign_id);
        const limit = asInt(args.limit, 1, 50, 20);

        const filtered = leads.filter((l) => {
          if (statusFilter && statusFilter !== "all" && l.status.toLowerCase() !== statusFilter) return false;
          if (campaignFilter && l.campaign_id !== campaignFilter) return false;
          if (search) {
            const hay = `${l.business ?? ""} ${l.contact_name ?? ""} ${l.email ?? ""} ${l.industry ?? ""} ${l.location ?? ""}`.toLowerCase();
            if (!hay.includes(search)) return false;
          }
          return true;
        });

        return {
          ok: true,
          summary: `Found ${filtered.length} lead${filtered.length === 1 ? "" : "s"} (showing ${Math.min(filtered.length, limit)})`,
          data: {
            total_matching: filtered.length,
            leads: filtered.slice(0, limit).map((l) => ({
              id: l.id,
              business: l.business,
              contact_name: l.contact_name,
              role: l.role,
              email: l.email,
              website: l.website,
              industry: l.industry,
              location: l.location,
              status: l.status,
              score: l.score,
              priority: l.priority,
              campaign_id: l.campaign_id,
              has_research: Boolean(l.research),
            })),
          },
        };
      }

      case "add_lead": {
        const business = asStr(args.business);
        if (!business) {
          return { ok: false, summary: "Business name is required.", data: { error: "business is required" } };
        }
        const res = await createLead(uid, {
          business,
          email: asStr(args.email) || undefined,
          contact_name: asStr(args.contact_name) || undefined,
          role: asStr(args.role) || undefined,
          website: asStr(args.website) || undefined,
          location: asStr(args.location) || undefined,
          industry: asStr(args.industry) || undefined,
          notes: asStr(args.notes) || undefined,
          campaignId: asStr(args.campaign_id) || null,
          source: "ai_operator",
        });
        notifyIfMutated(!res.duplicate);
        return {
          ok: true,
          summary: res.duplicate
            ? `Lead "${business}" already exists (ID ${res.id})`
            : `Added lead "${business}" (${res.id})`,
          data: { id: res.id, duplicate: res.duplicate, business },
        };
      }

      case "update_lead": {
        const leadId = asStr(args.lead_id);
        if (!leadId) {
          return { ok: false, summary: "lead_id is required.", data: { error: "lead_id is required" } };
        }
        if (Boolean(args.requeue_research)) {
          await updateLeadFields(uid, leadId, {
            action: "requeue",
            manual_research: args.manual_research !== undefined ? asStr(args.manual_research) : undefined,
          });
        } else {
          if (args.manual_research !== undefined || args.notes !== undefined) {
            await updateLeadFields(uid, leadId, {
              manual_research: args.manual_research !== undefined ? asStr(args.manual_research) : undefined,
              notes: args.notes !== undefined ? asStr(args.notes) : undefined,
            });
          }
          if (args.status !== undefined) {
            await updateLeadFields(uid, leadId, { status: asStr(args.status) as LeadStatus });
          }
        }
        notifyIfMutated(true);
        return {
          ok: true,
          summary: args.requeue_research ? `Requeued lead ${leadId} for research` : `Updated lead ${leadId}`,
          data: { lead_id: leadId, updated: true },
        };
      }

      case "move_leads_to_campaign": {
        const ids = Array.isArray(args.lead_ids)
          ? (args.lead_ids as unknown[]).map((value) => asStr(value)).filter(Boolean)
          : [];
        if (ids.length === 0) {
          return { ok: false, summary: "lead_ids is required.", data: { error: "lead_ids is required" } };
        }
        const targetCampaignId = asStr(args.campaign_id) || null;
        if (targetCampaignId) {
          const campaigns = await listCampaigns(uid);
          if (!campaigns.some((c) => c.id === targetCampaignId)) {
            return {
              ok: false,
              summary: `Campaign ${targetCampaignId} not found.`,
              data: { error: "Campaign not found" },
            };
          }
        }
        const moved = await moveLeadsToCampaign(uid, ids, targetCampaignId);
        notifyIfMutated(moved > 0);
        return {
          ok: true,
          summary: targetCampaignId
            ? `Moved ${moved} lead${moved === 1 ? "" : "s"} to campaign ${targetCampaignId}`
            : `Took ${moved} lead${moved === 1 ? "" : "s"} out of their campaign`,
          data: { moved, campaign_id: targetCampaignId },
        };
      }

      case "delete_lead": {
        const leadId = asStr(args.lead_id);
        if (!leadId) {
          return { ok: false, summary: "lead_id is required.", data: { error: "lead_id is required" } };
        }
        await deleteLeadCascade(uid, leadId);
        notifyIfMutated(true);
        return {
          ok: true,
          summary: `Deleted lead ${leadId}`,
          data: { lead_id: leadId, deleted: true },
        };
      }

      case "discover_prospects": {
        const industry = asStr(args.industry);
        if (!industry) {
          return { ok: false, summary: "Industry is required.", data: { error: "industry is required" } };
        }
        const location = asStr(args.location);
        const count = asInt(args.count, 3, 15, 5);
        const focus = asStr(args.focus);
        const settings = await getSettings(uid);
        const res = await authedPost<{
          candidates: DiscoveryCandidate[];
          notes: string;
          groundingUrls: { uri: string; title: string }[];
        }>("/api/ai/discover", {
          industry,
          location,
          count,
          focus,
          model: settings.model,
        });

        let savedCount = 0;
        let duplicateCount = 0;
        const savedIds: string[] = [];
        const saveToLeads = Boolean(args.save_to_leads);
        const campaignId = asStr(args.campaign_id) || null;

        if (saveToLeads && res.candidates.length > 0) {
          for (const c of res.candidates) {
            if (!c.business) continue;
            const created = await createLead(uid, {
              business: c.business,
              website: c.website || undefined,
              location: c.location || location || undefined,
              industry: c.industry || industry,
              notes: [c.why, c.source_url ? `Source: ${c.source_url}` : ""].filter(Boolean).join("\n"),
              source: "gemini_discovery",
              campaignId,
            });
            if (created.duplicate) {
              duplicateCount += 1;
            } else {
              savedCount += 1;
              savedIds.push(created.id);
            }
          }
          notifyIfMutated(savedCount > 0);
        }

        return {
          ok: true,
          summary: saveToLeads
            ? `Discovered ${res.candidates.length} prospects and saved ${savedCount} to Leads`
            : `Discovered ${res.candidates.length} prospects in ${industry}`,
          data: {
            count: res.candidates.length,
            saved: savedCount,
            duplicates: duplicateCount,
            saved_ids: savedIds,
            notes: res.notes,
            candidates: res.candidates,
          },
        };
      }

      case "inspect_google_sheet": {
        const wsErr = requireWorkspace();
        if (wsErr) return wsErr;
        const url = asStr(args.url);
        if (!url) {
          return { ok: false, summary: "Google Sheet URL is required.", data: { error: "url is required" } };
        }
        const meta = await authedPost<{
          spreadsheetId: string;
          title: string;
          tabs: { sheetId: number; title: string; rowCount: number; columnCount: number }[];
        }>("/api/workspace/sheets", { action: "tabs", url }, { requireWorkspace: true });

        const targetTab = asStr(args.tab) || meta.tabs[0]?.title;
        let preview: { headers: string[]; totalRows: number; mapping: Record<string, number>; sample: string[][] } | null = null;
        if (targetTab) {
          const p = await authedPost<{
            headers: string[];
            rows: string[][];
            mapping: Record<string, number>;
            totalRows: number;
          }>(
            "/api/workspace/sheets",
            { action: "preview", spreadsheetId: meta.spreadsheetId, tab: targetTab },
            { requireWorkspace: true },
          );
          preview = {
            headers: p.headers,
            totalRows: p.totalRows,
            mapping: p.mapping,
            sample: p.rows.slice(0, 3),
          };
        }

        return {
          ok: true,
          summary: `Inspected "${meta.title}" (${meta.tabs.length} tab${meta.tabs.length === 1 ? "" : "s"}${preview ? `, ${preview.totalRows} rows` : ""})`,
          data: {
            spreadsheetId: meta.spreadsheetId,
            title: meta.title,
            tabs: meta.tabs,
            preview_tab: targetTab ?? null,
            preview,
          },
        };
      }

      case "import_google_sheet": {
        const wsErr = requireWorkspace();
        if (wsErr) return wsErr;
        const url = asStr(args.url);
        if (!url) {
          return { ok: false, summary: "Google Sheet URL is required.", data: { error: "url is required" } };
        }
        const meta = await authedPost<{
          spreadsheetId: string;
          title: string;
          tabs: { title: string }[];
        }>("/api/workspace/sheets", { action: "tabs", url }, { requireWorkspace: true });

        const tab = asStr(args.tab) || meta.tabs[0]?.title;
        if (!tab) {
          return { ok: false, summary: "Spreadsheet has no readable worksheet tabs.", data: { error: "No tabs found" } };
        }

        const valRes = await authedPost<{ spreadsheetId: string; tab: string; values: string[][] }>(
          "/api/workspace/sheets",
          { action: "values", spreadsheetId: meta.spreadsheetId, tab },
          { requireWorkspace: true },
        );

        const limit = asInt(args.limit, 1, 500, 50);
        const campaignId = asStr(args.campaign_id) || null;
        const imported = await importSheetRows(uid, {
          spreadsheetId: valRes.spreadsheetId,
          tab: valRes.tab,
          rows: valRes.values,
          limit,
          campaignId,
        });
        notifyIfMutated(true);
        return {
          ok: true,
          summary: `Imported ${imported.created} leads from "${meta.title}" (${imported.duplicates} duplicates, ${imported.skipped} skipped)`,
          data: {
            title: meta.title,
            spreadsheetId: valRes.spreadsheetId,
            tab: valRes.tab,
            ...imported,
          },
        };
      }

      case "writeback_sheet_statuses": {
        const wsErr = requireWorkspace();
        if (wsErr) return wsErr;
        const campaignId = asStr(args.campaign_id);
        if (!campaignId) {
          return { ok: false, summary: "campaign_id is required.", data: { error: "campaign_id is required" } };
        }
        const res = await writebackCampaignStatuses(uid, campaignId);
        notifyIfMutated(true);
        return {
          ok: true,
          summary: res.updated
            ? `Updated ${res.updated} rows in Google Sheet column ${res.column}`
            : "No sheet-linked leads found in this campaign to write back.",
          data: res,
        };
      }

      case "list_campaigns": {
        const [campaigns, leads, messages, replies] = await Promise.all([
          listCampaigns(uid),
          listLeads(uid),
          listMessages(uid),
          listReplies(uid),
        ]);
        const includeArchived = Boolean(args.include_archived);
        const filtered = includeArchived ? campaigns : campaigns.filter((c) => c.status !== "archived");
        const leadToCamp = new Map<string, string>();
        for (const l of leads) {
          if (l.campaign_id) leadToCamp.set(l.id, l.campaign_id);
        }

        const rows = filtered.map((c) => {
          const cLeads = leads.filter((l) => l.campaign_id === c.id);
          const cMsgs = messages.filter((m) => m.campaign_id === c.id);
          const cReplies = replies.filter((r) => r.lead_id && leadToCamp.get(r.lead_id) === c.id);
          return {
            id: c.id,
            name: c.name,
            status: c.status,
            target_industry: c.config.target_industry,
            services: c.config.services,
            min_score: c.config.min_score,
            leads_count: cLeads.length,
            queued_research: cLeads.filter((l) => l.status === "queued_research").length,
            researched: cLeads.filter((l) => l.status === "researched").length,
            qualified: cLeads.filter((l) => l.status === "qualified").length,
            pending_approval: cMsgs.filter((m) => m.status === "pending_approval").length,
            approved_emails: cMsgs.filter((m) => m.status === "approved").length,
            sent_emails: cMsgs.filter((m) => m.status === "sent").length,
            replies: cReplies.length,
          };
        });

        return {
          ok: true,
          summary: `Found ${rows.length} campaign${rows.length === 1 ? "" : "s"}`,
          data: { campaigns: rows },
        };
      }

      case "plan_and_create_campaign": {
        const instruction = asStr(args.instruction);
        if (instruction.length < 8) {
          return {
            ok: false,
            summary: "Instruction must be at least 8 characters.",
            data: { error: "Provide a clearer campaign goal (at least 8 characters)." },
          };
        }
        const [settings, leads, campaigns, knowledge] = await Promise.all([
          getSettings(uid),
          listLeads(uid),
          listCampaigns(uid),
          buildLiveKnowledgeDigest(uid),
        ]);
        const byStatus: Record<string, number> = {};
        const indSet = new Set<string>();
        for (const l of leads) {
          byStatus[l.status] = (byStatus[l.status] ?? 0) + 1;
          if (l.industry) indSet.add(l.industry);
        }

        const { plan } = await authedPost<{ plan: CampaignPlan }>("/api/ai/plan", {
          instruction,
          settings,
          knowledge,
          availableLeads: { total: leads.length, byStatus, industries: Array.from(indSet) },
          recentCampaigns: campaigns.slice(0, 8).map((c) => ({ name: c.name, status: c.status })),
          model: settings.model,
        });

        if (args.auto_create === false) {
          return {
            ok: true,
            summary: `Planned "${plan.name}" (preview only)`,
            data: { created: false, plan },
          };
        }

        const campaign = await createCampaign(uid, {
          name: plan.name,
          instruction,
          config: { ...plan.config, summary: plan.summary, warnings: plan.warnings },
          sheetSource: plan.sheet_url || null,
        });

        let assigned = 0;
        let sheetImported: { created: number; duplicates: number; skipped: number } | null = null;
        if (plan.sheet_url && env.hasWorkspaceToken()) {
          try {
            const meta = await authedPost<{ spreadsheetId: string; tabs: { title: string }[] }>(
              "/api/workspace/sheets",
              { action: "tabs", url: plan.sheet_url },
              { requireWorkspace: true },
            );
            const firstTab = meta.tabs[0]?.title;
            if (firstTab) {
              const vals = await authedPost<{ spreadsheetId: string; tab: string; values: string[][] }>(
                "/api/workspace/sheets",
                { action: "values", spreadsheetId: meta.spreadsheetId, tab: firstTab },
                { requireWorkspace: true },
              );
              sheetImported = await importSheetRows(uid, {
                spreadsheetId: vals.spreadsheetId,
                tab: vals.tab,
                rows: vals.values,
                limit: plan.config.lead_count,
                campaignId: campaign.id,
              });
            }
          } catch {
            // Fall back to assigning existing leads if sheet import fails
          }
        }
        if (!sheetImported) {
          assigned = await assignLeadsToCampaign(uid, campaign.id, campaign.config);
        }

        notifyIfMutated(true);
        return {
          ok: true,
          summary: `Created campaign "${campaign.name}" (${sheetImported ? `${sheetImported.created} imported from sheet` : `${assigned} leads assigned`})`,
          data: {
            created: true,
            campaign_id: campaign.id,
            name: campaign.name,
            status: campaign.status,
            summary: plan.summary,
            assigned_leads: assigned,
            sheet_imported: sheetImported,
            warnings: plan.warnings,
          },
        };
      }

      case "manage_campaign": {
        const campaignId = asStr(args.campaign_id);
        const action = asStr(args.action) as "assign" | "approve" | "pause" | "resume" | "archive";
        if (!campaignId || !action) {
          return { ok: false, summary: "campaign_id and action are required.", data: { error: "Missing parameters" } };
        }
        if (action === "assign") {
          const campaigns = await listCampaigns(uid);
          const camp = campaigns.find((c) => c.id === campaignId);
          if (!camp) {
            return { ok: false, summary: `Campaign ${campaignId} not found.`, data: { error: "Campaign not found" } };
          }
          const assigned = await assignLeadsToCampaign(uid, campaignId, camp.config);
          notifyIfMutated(true);
          return {
            ok: true,
            summary: `Assigned ${assigned} unprocessed lead${assigned === 1 ? "" : "s"} to "${camp.name}"`,
            data: { campaign_id: campaignId, assigned },
          };
        }
        await updateCampaignAction(uid, campaignId, action);
        notifyIfMutated(true);
        return {
          ok: true,
          summary: `Campaign ${campaignId} updated (${action})`,
          data: { campaign_id: campaignId, action, updated: true },
        };
      }

      case "run_research_batch": {
        const campaignId = asStr(args.campaign_id) || undefined;
        const limit = asInt(args.limit, 1, 5, 2);
        const res = await runResearchBatch(uid, campaignId, limit);
        notifyIfMutated(res.processed > 0);
        return {
          ok: res.errors.length === 0 || res.processed > 0,
          summary: `Researched ${res.processed} lead${res.processed === 1 ? "" : "s"} (${res.remaining} remaining)`,
          data: { ...res },
        };
      }

      case "run_qualify_batch": {
        const campaignId = asStr(args.campaign_id) || undefined;
        const limit = asInt(args.limit, 1, 6, 3);
        const res = await runQualifyBatch(uid, campaignId, limit);
        notifyIfMutated(res.processed > 0);
        return {
          ok: res.errors.length === 0 || res.processed > 0,
          summary: `Qualified ${res.processed} lead${res.processed === 1 ? "" : "s"} (${res.remaining} remaining)`,
          data: { ...res },
        };
      }

      case "run_compose_batch": {
        const campaignId = asStr(args.campaign_id) || undefined;
        const limit = asInt(args.limit, 1, 5, 2);
        const res = await runComposeBatch(uid, campaignId, limit);
        notifyIfMutated(res.processed > 0);
        return {
          ok: res.errors.length === 0 || res.processed > 0,
          summary: `Drafted ${res.processed} email${res.processed === 1 ? "" : "s"} (${res.remaining} remaining)`,
          data: { ...res },
        };
      }

      case "run_followups_batch": {
        const campaignId = asStr(args.campaign_id) || undefined;
        const limit = asInt(args.limit, 1, 5, 2);
        const res = await runFollowupsBatch(uid, campaignId, limit);
        notifyIfMutated(res.processed > 0);
        return {
          ok: res.errors.length === 0 || res.processed > 0,
          summary: `Prepared ${res.processed} follow-up${res.processed === 1 ? "" : "s"} (${res.remaining} remaining)`,
          data: { ...res },
        };
      }

      case "list_messages": {
        const [messages, leads] = await Promise.all([listMessages(uid), listLeads(uid)]);
        const leadMap = new Map(leads.map((l) => [l.id, l]));
        const statusFilter = asStr(args.status).toLowerCase();
        const campaignId = asStr(args.campaign_id);
        const limit = asInt(args.limit, 1, 30, 15);

        const filtered = messages.filter((m) => {
          if (statusFilter && statusFilter !== "all" && m.status.toLowerCase() !== statusFilter) return false;
          if (campaignId && m.campaign_id !== campaignId) return false;
          return true;
        });

        return {
          ok: true,
          summary: `Found ${filtered.length} email${filtered.length === 1 ? "" : "s"}`,
          data: {
            total_matching: filtered.length,
            messages: filtered.slice(0, limit).map((m) => {
              const lead = leadMap.get(m.lead_id);
              return {
                id: m.id,
                lead_id: m.lead_id,
                campaign_id: m.campaign_id,
                business: lead?.business ?? null,
                email: lead?.email ?? null,
                kind: m.kind,
                step: m.step,
                status: m.status,
                subject: m.subject,
                body: clampText(m.body, 700),
                sent_at: m.sent_at,
                error: m.error,
              };
            }),
          },
        };
      }

      case "edit_or_regenerate_message": {
        const messageId = asStr(args.message_id);
        const action = asStr(args.action) as "edit" | "regenerate" | "reject";
        if (!messageId || !action) {
          return { ok: false, summary: "message_id and action are required.", data: { error: "Missing parameters" } };
        }
        const [messages, leads, campaigns, settings] = await Promise.all([
          listMessages(uid),
          listLeads(uid),
          listCampaigns(uid),
          getSettings(uid),
        ]);
        const msg = messages.find((m) => m.id === messageId);
        if (!msg) {
          return { ok: false, summary: `Message ${messageId} not found.`, data: { error: "Message not found" } };
        }
        if (action === "edit") {
          const subject = asStr(args.subject, msg.subject ?? "");
          const body = asStr(args.body, msg.body ?? "");
          await updateMessageContent(uid, messageId, { subject, body });
          notifyIfMutated(true);
          return {
            ok: true,
            summary: `Updated subject/body for email ${messageId}`,
            data: { message_id: messageId, subject, updated: true },
          };
        }
        if (action === "reject") {
          await updateMessageStatus(uid, messageId, "cancelled");
          notifyIfMutated(true);
          return {
            ok: true,
            summary: `Rejected email ${messageId}`,
            data: { message_id: messageId, status: "cancelled" },
          };
        }
        // regenerate
        const lead = leads.find((l) => l.id === msg.lead_id);
        const campaign = msg.campaign_id ? campaigns.find((c) => c.id === msg.campaign_id) : undefined;
        if (!lead || !campaign) {
          return {
            ok: false,
            summary: "Lead or campaign not found for regeneration.",
            data: { error: "Missing lead or campaign for this message" },
          };
        }
        const knowledge = await buildLiveKnowledgeDigest(uid);
        const { composed } = await authedPost<{ composed: ComposedEmail }>("/api/ai/compose", {
          kind: msg.kind,
          lead,
          research: lead.research,
          campaign: campaign.config,
          settings,
          knowledge,
          step: msg.step,
          model: settings.model,
        });
        await updateMessageContent(uid, messageId, {
          subject: composed.subject,
          body: composed.body,
          angle: composed.angle,
          rationale: composed.rationale,
          service: composed.service,
        });
        notifyIfMutated(true);
        return {
          ok: true,
          summary: `Regenerated email for ${lead.business ?? lead.email ?? messageId}`,
          data: { message_id: messageId, subject: composed.subject, body: composed.body },
        };
      }

      case "approve_message": {
        const messageId = asStr(args.message_id);
        if (!messageId) {
          return { ok: false, summary: "message_id is required.", data: { error: "message_id is required" } };
        }
        const messages = await listMessages(uid);
        const msg = messages.find((m) => m.id === messageId);
        if (!msg) {
          return { ok: false, summary: `Message ${messageId} not found.`, data: { error: "Message not found" } };
        }
        await updateMessageStatus(uid, messageId, "approved", { approved_at: new Date().toISOString() });
        await updateLeadFields(uid, msg.lead_id, { status: "approved" });
        notifyIfMutated(true);
        return {
          ok: true,
          summary: `Approved email ${messageId}`,
          data: { message_id: messageId, status: "approved" },
        };
      }

      case "approve_all_messages": {
        const campaignId = asStr(args.campaign_id);
        if (!campaignId) {
          return { ok: false, summary: "campaign_id is required.", data: { error: "campaign_id is required" } };
        }
        const count = await approveAllMessagesInCampaign(uid, campaignId);
        notifyIfMutated(count > 0);
        return {
          ok: true,
          summary: `Approved ${count} pending email${count === 1 ? "" : "s"} in campaign`,
          data: { campaign_id: campaignId, approved_count: count },
        };
      }

      case "send_approved_emails": {
        const wsErr = requireWorkspace();
        if (wsErr) return wsErr;
        const campaignId = asStr(args.campaign_id) || undefined;
        const limit = asInt(args.limit, 1, 5, 2);
        const res = await runSendBatch(uid, campaignId, limit);
        notifyIfMutated(res.processed > 0);
        return {
          ok: res.errors.length === 0 || res.processed > 0,
          summary: res.info
            ? res.info
            : `Sent ${res.processed} email${res.processed === 1 ? "" : "s"} via Gmail (${res.remaining} remaining)`,
          data: { ...res },
        };
      }

      case "sync_gmail_replies": {
        const wsErr = requireWorkspace();
        if (wsErr) return wsErr;
        const limit = asInt(args.limit, 5, 40, 15);
        const res = await runSyncBatch(uid, limit);
        notifyIfMutated(res.processed > 0);
        return {
          ok: res.errors.length === 0 || res.processed > 0,
          summary: res.info ?? `Synced ${res.processed} new replies`,
          data: { ...res },
        };
      }

      case "list_replies": {
        const [replies, leads] = await Promise.all([listReplies(uid), listLeads(uid)]);
        const leadMap = new Map(leads.map((l) => [l.id, l]));
        const filter = asStr(args.filter, "all").toLowerCase();

        const filtered = replies.filter((r) => {
          if (filter === "needs_attention") return !r.handled;
          if (filter === "positive") return r.classification === "interested" || r.classification === "more_info" || r.classification === "referral";
          if (filter === "pricing") return r.classification === "pricing";
          if (filter === "objection") return r.classification === "objection";
          if (filter === "unsubscribe") return r.classification === "unsubscribe";
          return true;
        });

        return {
          ok: true,
          summary: `Found ${filtered.length} repl${filtered.length === 1 ? "y" : "ies"}`,
          data: {
            total: filtered.length,
            replies: filtered.slice(0, 15).map((r) => {
              const lead = r.lead_id ? leadMap.get(r.lead_id) : undefined;
              return {
                id: r.id,
                business: lead?.business ?? null,
                from_email: r.from_email,
                subject: r.subject,
                classification: r.classification,
                handled: r.handled,
                summary: r.summary,
                recommended_action: r.recommended_action,
                draft_reply: clampText(r.draft_reply, 600),
                received_at: r.received_at,
              };
            }),
          },
        };
      }

      case "mark_reply_handled": {
        const replyId = asStr(args.reply_id);
        if (!replyId) {
          return { ok: false, summary: "reply_id is required.", data: { error: "reply_id is required" } };
        }
        const handled = Boolean(args.handled);
        await updateReplyHandled(uid, replyId, handled);
        notifyIfMutated(true);
        return {
          ok: true,
          summary: `Marked reply ${replyId} as ${handled ? "handled" : "unhandled"}`,
          data: { reply_id: replyId, handled },
        };
      }

      case "get_settings": {
        const includeSup = args.include_suppressions !== false;
        const [settings, suppressions] = await Promise.all([
          getSettings(uid),
          includeSup ? listSuppressions(uid) : Promise.resolve([]),
        ]);
        const providers = providersFromSettings(settings);
        const active = activeProviderEntry(providers, settings);
        // Never hand raw provider JSON to the model: it contains every API key.
        return {
          ok: true,
          summary: `Settings loaded (active AI: ${settings.ai_provider || "gemini"} / ${settings.model}, daily limit: ${settings.daily_limit})`,
          data: {
            settings: {
              ...settings,
              ai_providers: "(redacted — see providers)",
              ai_api_key: settings.ai_api_key ? "(stored privately — not shown)" : "",
              active_provider_id: active?.id ?? "",
            },
            providers: providers.map((provider) => ({
              id: provider.id,
              name: provider.name,
              provider: provider.provider,
              model: provider.model,
              enabled: provider.enabled,
              base_url: provider.baseUrl,
              key_hint: provider.apiKey ? `••••${provider.apiKey.slice(-4)}` : "",
              verified_at: provider.verifiedAt,
              last_error: provider.lastError,
            })),
            suppressions: suppressions.slice(0, 30).map((s) => ({ email: s.email, reason: s.reason })),
          },
        };
      }

      case "update_settings": {
        const patch: Partial<Settings> = {};
        const stringFields = [
          "sender_name",
          "sender_role",
          "sender_company",
          "sender_email",
          "physical_address",
          "send_days",
          "model",
        ] as const;
        for (const f of stringFields) {
          if (typeof args[f] === "string") {
            patch[f] = args[f] as string;
          }
        }
        const intFields = [
          "daily_limit",
          "campaign_limit",
          "interval_seconds",
          "send_window_start",
          "send_window_end",
          "timezone_offset",
          "followup_days",
          "min_score",
        ] as const;
        for (const f of intFields) {
          if (args[f] !== undefined && Number.isFinite(Number(args[f]))) {
            patch[f] = Math.round(Number(args[f]));
          }
        }
        // A model change also has to rewrite the active provider's entry, or the
        // saved conversation config keeps sending the previous model.
        if (typeof args.model === "string" && args.model.trim()) {
          const current = await getSettings(uid);
          const { patch: modelPatch, provider } = patchActiveModel(
            current,
            args.model.trim(),
            typeof args.provider === "string" ? args.provider : undefined,
          );
          Object.assign(patch, modelPatch);
          if (provider) {
            setActiveProviderId(provider.id);
            setActiveAiConfig(toAiConfig(provider));
          }
        }
        const saved = await saveSettings(uid, patch);
        // Publish the merged list so open panels show the new model right away.
        const stored = providersFromSettings(saved);
        if (stored.length > 0) {
          writeProviders([
            ...stored,
            ...readProviders().filter((local) => !stored.some((entry) => entry.id === local.id)),
          ]);
        }
        await writeAuditLog(uid, "settings_updated", "settings", "default", { via: "ai_operator", keys: Object.keys(patch) });
        notifyIfMutated(true);
        return {
          ok: true,
          summary: `Saved settings (${Object.keys(patch).join(", ") || "no changes"}) — active AI: ${saved.ai_provider || "gemini"} / ${saved.model}`,
          data: { settings: saved },
        };
      }

      case "suppress_email": {
        const email = asStr(args.email);
        const reason = asStr(args.reason, "Added by the operator");
        if (!email) {
          return { ok: false, summary: "Email address is required.", data: { error: "email is required" } };
        }
        await addSuppression(uid, email, reason);
        notifyIfMutated(true);
        return {
          ok: true,
          summary: `Suppressed ${email}`,
          data: { email, reason, suppressed: true },
        };
      }

      case "test_gemini_connection": {
        const settings = await getSettings(uid);
        const model = asStr(args.model) || settings.model;
        const res = await authedPost<{ model: string; ms: number; reply: string; provider?: string }>("/api/ai/test", {
          model,
        });
        const provider = res.provider || settings.ai_provider || "gemini";
        return {
          ok: true,
          summary: `${provider} (${res.model}) responded "${res.reply}" in ${res.ms} ms`,
          data: { ...res, provider },
        };
      }

      default:
        return {
          ok: false,
          summary: `Unknown tool "${name}"`,
          data: { error: `Tool "${name}" is not implemented.` },
        };
    }
  } catch (err) {
    const msg = errorMessage(err);
    const needsWorkspace = /workspace|gmail|sheets|reconnect|oauth/i.test(msg) && !env.hasWorkspaceToken();
    return {
      ok: false,
      needsWorkspace,
      summary: msg,
      data: { error: msg, ...(needsWorkspace ? { needsWorkspace: true } : {}) },
    };
  }
}
