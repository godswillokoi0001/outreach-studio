export const GLOBAL_KNOWLEDGE_MODULE_KEYS = [
  "module_1_prospecting_research_qualification",
  "module_2_copywriting_psychology_deliverability",
  "module_3_routing_templates_cadence",
  "module_4_replies_objections_closing_compliance",
] as const;

export type GlobalKnowledgeModuleKey = (typeof GLOBAL_KNOWLEDGE_MODULE_KEYS)[number];

export interface GlobalKnowledgeModule {
  id: string;
  module_key: GlobalKnowledgeModuleKey;
  title: string;
  version: number;
  content: string;
  is_active: boolean;
  updated_by?: string | null;
  created_at: string;
  updated_at: string;
}

export interface GlobalKnowledgeSeedEntry {
  module_key: GlobalKnowledgeModuleKey;
  title: string;
  version: number;
  content: string;
}

export type SendingTier = "free_gmail_starter" | "authenticated_custom_domain";

export interface UserBusinessProfile {
  owner_id: string;
  user_name: string;
  user_role: string;
  user_company: string;
  user_offer: string;
  user_mechanism: string;
  user_lead_magnet: string;
  user_proof: string;
  user_icp: string;
  user_exclusions: string;
  user_sending_tier: SendingTier;
  user_tone: string;
  user_custom_rules: string;
  created_at?: string;
  updated_at?: string;
}

export interface UserBusinessVariables {
  USER_NAME: string;
  USER_ROLE: string;
  USER_COMPANY: string;
  USER_OFFER: string;
  USER_MECHANISM: string;
  USER_LEAD_MAGNET: string;
  USER_PROOF: string;
  USER_ICP: string;
  USER_EXCLUSIONS: string;
  USER_SENDING_TIER: SendingTier;
  USER_TONE: string;
  USER_CUSTOM_RULES: string;
}

export const MODULE_TITLES: Record<GlobalKnowledgeModuleKey, string> = {
  module_1_prospecting_research_qualification:
    "System Core, Signal-Based Prospecting, Research Waterfall & Qualification",
  module_2_copywriting_psychology_deliverability:
    "Direct-Response Copywriting OS, Psychology, First Lines & Deliverability",
  module_3_routing_templates_cadence:
    "Prospect Routing Engine, Short Template Bank, Follow-Ups & Multi-Channel",
  module_4_replies_objections_closing_compliance:
    "Reply Triage, A-C-A Conversion, Objection Matrix, Pricing & Compliance",
};
