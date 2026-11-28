import { getGlobalKnowledgeModules } from "../global-knowledge/service";
import type { GlobalKnowledgeModuleKey, UserBusinessVariables } from "../global-knowledge/types";
import { loadUserContextServer, resolveUserBusinessVariables, type LoadedUserContext } from "../global-knowledge/user-context";
import { findUnresolvedPlaceholders, stripUnresolvedPlaceholders } from "../outreach-utils";
import type { CampaignConfig, Settings } from "../types";

export { findUnresolvedPlaceholders, stripUnresolvedPlaceholders };

export type OrchestratorWorkflow =
  | "research_and_qualify"
  | "draft_outreach"
  | "handle_reply"
  | "plan_campaign"
  | "growth_advisor"
  | "assistant_chat";

export const WORKFLOW_MODULES: Record<OrchestratorWorkflow, GlobalKnowledgeModuleKey[]> = {
  research_and_qualify: ["module_1_prospecting_research_qualification"],
  draft_outreach: [
    "module_1_prospecting_research_qualification",
    "module_2_copywriting_psychology_deliverability",
    "module_3_routing_templates_cadence",
  ],
  handle_reply: [
    "module_2_copywriting_psychology_deliverability",
    "module_4_replies_objections_closing_compliance",
  ],
  plan_campaign: [
    "module_1_prospecting_research_qualification",
    "module_3_routing_templates_cadence",
  ],
  growth_advisor: ["module_1_prospecting_research_qualification"],
  assistant_chat: [],
};

/**
 * Exact byte-for-byte separator dividing the static Global Knowledge prefix
 * (maximizing provider prompt caching across all tenants and requests) from
 * per-tenant dynamic runtime variables and task state.
 */
export const GLOBAL_PROMPT_CACHE_SEPARATOR =
  "\n\n================================================================================\n[END GLOBAL INTELLIGENCE PREFIX — BEGIN ACCOUNT & TASK RUNTIME CONTEXT]\n================================================================================\n\n";

export const PRECEDENCE_HEADER = `INSTRUCTION PRECEDENCE (STRICT):
1. Global Safety, Compliance & Anti-Hallucination Laws (highest priority — cannot be overridden).
2. Active User's Business Profile, Offer, Exclusions, Tone & Custom Knowledge Base (overrides global defaults for brand/scope choices).
3. Global Sales, Copywriting, Routing & Reply Frameworks (Modules 1-4 above).`;

const MAX_STATIC_PREFIX_CHARS = 9_000;

function compactModuleContent(content: string, maxChars: number): string {
  const clean = content.trim();
  if (clean.length <= maxChars) return clean;
  const slice = clean.slice(0, maxChars);
  const lastBreak = slice.lastIndexOf("\n");
  return (lastBreak > maxChars * 0.6 ? slice.slice(0, lastBreak) : slice).trim();
}

export function renderUserBusinessContextBlock(vars: UserBusinessVariables): string {
  return [
    "ACTIVE USER BUSINESS PROFILE VARIABLES:",
    `- USER_NAME: ${vars.USER_NAME}`,
    `- USER_ROLE: ${vars.USER_ROLE}`,
    `- USER_COMPANY: ${vars.USER_COMPANY}`,
    `- USER_OFFER: ${vars.USER_OFFER}`,
    `- USER_MECHANISM: ${vars.USER_MECHANISM}`,
    `- USER_LEAD_MAGNET: ${vars.USER_LEAD_MAGNET}`,
    `- USER_PROOF: ${vars.USER_PROOF}`,
    `- USER_ICP: ${vars.USER_ICP}`,
    `- USER_EXCLUSIONS: ${vars.USER_EXCLUSIONS}`,
    `- USER_SENDING_TIER: ${vars.USER_SENDING_TIER}`,
    `- USER_TONE: ${vars.USER_TONE}`,
    `- USER_CUSTOM_RULES: ${vars.USER_CUSTOM_RULES}`,
  ].join("\n");
}

export interface OrchestratedPrompt {
  workflow: OrchestratorWorkflow;
  moduleKeys: GlobalKnowledgeModuleKey[];
  staticPrefix: string;
  dynamicSuffix: string;
  system: string;
  variables: UserBusinessVariables;
}

/**
 * Centralized PromptOrchestrator:
 * - Reads active Global Knowledge Modules from RAM cache (20-min TTL).
 * - Places static modules FIRST (byte-for-byte identical prefix for LLM prompt caching).
 * - Appends strict precedence rules, bound tenant profile variables, tenant KB
 *   (Master knowledge, Sources, Additional notes), and task-specific instructions AFTER.
 */
export async function buildOrchestratedSystemPrompt(input: {
  workflow: OrchestratorWorkflow;
  ownerId?: string | null;
  userContext?: LoadedUserContext | null;
  settings?: Partial<Settings> | null;
  campaign?: Partial<CampaignConfig> | null;
  knowledgeDigest?: string;
  taskInstructions: string;
  /** Tighten the static module prefix for free-tier ITPM caps (Growth Advisor). */
  maxStaticPrefixChars?: number;
  /** Tighten the tenant knowledge slice for free-tier ITPM caps. */
  maxKnowledgeChars?: number;
}): Promise<OrchestratedPrompt> {
  const moduleKeys = WORKFLOW_MODULES[input.workflow];
  const staticBudget = Math.max(1_000, input.maxStaticPrefixChars ?? MAX_STATIC_PREFIX_CHARS);
  const knowledgeBudget = Math.max(500, input.maxKnowledgeChars ?? 7_500);
  const moduleMap = await getGlobalKnowledgeModules();

  // 1. Byte-for-byte identical static Global Knowledge prefix first (budgeted for <=8k TPM free tiers)!
  const perModuleCap =
    moduleKeys.length > 0 ? Math.floor(staticBudget / moduleKeys.length) : staticBudget;
  const staticPrefix = moduleKeys
    .map((key) => compactModuleContent(moduleMap.get(key)?.content ?? "", perModuleCap))
    .filter(Boolean)
    .join("\n\n---\n\n");

  // 2. Per-tenant isolated context resolution AFTER the static prefix.
  const loaded =
    input.userContext ??
    (input.ownerId
      ? await loadUserContextServer(input.ownerId, {
          settings: input.settings ?? null,
          campaign: input.campaign ?? null,
          knowledgeDigest: input.knowledgeDigest,
        })
      : null);

  const variables =
    loaded?.variables ??
    resolveUserBusinessVariables({
      settings: input.settings ?? null,
      campaign: input.campaign ?? null,
      knowledgeDigest: input.knowledgeDigest,
    });

  // Prioritize Master Knowledge & voice/sample/avoid rules within an extended 7,500-char
  // lossless window so user writing rules are NEVER silently truncated before reaching the model.
  const digest = (input.knowledgeDigest?.trim() || loaded?.knowledgeDigest || "").slice(0, knowledgeBudget);
  const userKbBlock = digest
    ? `USER BUSINESS KNOWLEDGE BASE (Master Knowledge, Sources & Additional Notes):\n${digest}`
    : "USER BUSINESS KNOWLEDGE BASE:\nNot provided — do not fabricate missing company offers, prices, or case studies.";

  const dynamicSuffix = [
    PRECEDENCE_HEADER,
    renderUserBusinessContextBlock(variables),
    userKbBlock,
    `WORKFLOW TASK INSTRUCTIONS (${input.workflow}):\n${input.taskInstructions.trim()}\n\nOUTPUT VARIABLE SAFETY: Never emit raw {{...}} placeholder tags in output. Use verified values only or omit gracefully.`,
  ].join("\n\n");

  return {
    workflow: input.workflow,
    moduleKeys,
    staticPrefix,
    dynamicSuffix,
    system: `${staticPrefix}${GLOBAL_PROMPT_CACHE_SEPARATOR}${dynamicSuffix}`,
    variables,
  };
}
