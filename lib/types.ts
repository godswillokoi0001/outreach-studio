export type LeadStatus =
  | "new"
  | "queued_research"
  | "researched"
  | "qualified"
  | "disqualified"
  | "needs_research"
  | "email_generated"
  | "approved"
  | "sent"
  | "replied"
  | "bounced"
  | "followup_pending"
  | "converted"
  | "unsubscribed"
  | "suppressed";

export type Priority = "high" | "medium" | "low" | "not_qualified" | "needs_research";

export interface Finding {
  area: string;
  observation: string;
  severity: "low" | "medium" | "high";
  evidence: string;
}

export interface AuditEvidenceItem {
  issue: string;
  evidence_type: "lighthouse" | "broken_link" | "dom_visible" | "vision_screenshot";
  proof: string;
}

export interface ResearchResult {
  business_name_confirmed: boolean;
  industry: string;
  summary: string;
  website_status: "no_site_known" | "unreachable" | "reachable" | "not_checked";
  website_facts: string[];
  verified_facts: { fact: string; source: string }[];
  findings: Finding[];
  inferences: string[];
  opportunities: { opportunity: string; service: string; rationale: string }[];
  recommended_angle: string;
  confidence: number;
  insufficient_data: boolean;
  notes: string;
  checked_at?: string;
  technical_signals?: Record<string, unknown>;
  /** Module 1 Workflow A structured extensions */
  score?: number;
  tier?: "A" | "B" | "C" | "DISQUALIFIED";
  kill_switch_triggered?: boolean;
  disqualification_reason?: string | null;
  missing_data?: string[];
  awareness_level?: string;
  recommended_template_id?: string;
  personalized_hook_candidates?: string[];
  socials?: { platform: string; url: string; verification_status?: string }[];
  contact_source_urls?: { channel: string; value: string; sourceUrl: string }[];
  verified_site_issues?: string[];
  /** "limited_public_info" when no public site could be verified live. */
  research_status?: "verified" | "limited_public_info";
  audit_evidence?: AuditEvidenceItem[];
  mobile_screenshot_url?: string | null;
  email_type?: "direct" | "role_inbox" | "invalid";
  mx_verified?: boolean;
  first_line?: string;
  contact_verification_status?: "Verified" | "Needs Contact Verification";
}

export interface QualificationResult {
  score: number;
  category: Priority;
  reasons: string[];
  opportunity: string;
  value_tier: "high" | "medium" | "low" | "unknown";
  recommended_service: string;
  disqualify_reason?: string;
  /** Module 1 Workflow A structured extensions */
  tier?: "A" | "B" | "C" | "DISQUALIFIED";
  kill_switch_triggered?: boolean;
  disqualification_reason?: string | null;
  verified_facts?: string[];
  missing_data?: string[];
  awareness_level?: string;
  recommended_template_id?: string;
  personalized_hook_candidates?: string[];
  socials?: { platform: string; url: string; verification_status?: string }[];
  contact_source_urls?: { channel: string; value: string; sourceUrl: string }[];
  verified_site_issues?: string[];
  research_status?: "verified" | "limited_public_info";
  email_type?: "direct" | "role_inbox" | "invalid";
  mx_verified?: boolean;
  first_line?: string;
  contact_verification_status?: "Verified" | "Needs Contact Verification";
}

export interface Lead {
  id: string;
  ownerId?: string;
  campaign_id: string | null;
  business: string | null;
  contact_name: string | null;
  role: string | null;
  email: string | null;
  email_norm: string | null;
  website: string | null;
  phone: string | null;
  location: string | null;
  industry: string | null;
  notes: string | null;
  extra: string | null;
  source: string | null;
  source_ref: string | null;
  sheet_row: number | null;
  status: LeadStatus;
  score: number | null;
  priority: Priority | null;
  score_reason: QualificationResult | null;
  research: ResearchResult | null;
  research_at: string | null;
  research_ok: boolean;
  manual_research: string | null;
  last_contacted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CampaignConfig {
  services: string[];
  target_industry: string;
  objective: string;
  tone: string;
  min_score: number;
  lead_count: number;
  send_limit: number;
  interval_seconds: number;
  followup_days: number[];
  auto_approve_initial: boolean;
  auto_approve_followups: boolean;
  require_approval: boolean;
  identity: "personal" | "company";
  extra_instructions: string;
  summary?: string;
  warnings?: string[];
}

export type MessageStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "sending"
  | "sent"
  | "failed"
  | "skipped"
  | "cancelled";

export interface Message {
  id: string;
  ownerId?: string;
  lead_id: string;
  campaign_id: string | null;
  step: number;
  kind: "initial" | "followup" | "reply";
  subject: string | null;
  body: string | null;
  angle: string | null;
  rationale: string | null;
  service: string | null;
  status: MessageStatus;
  gmail_id: string | null;
  thread_id: string | null;
  rfc_message_id: string | null;
  sent_at: string | null;
  error: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Campaign {
  id: string;
  ownerId?: string;
  name: string;
  instruction: string | null;
  config: CampaignConfig;
  status: "draft" | "approved" | "running" | "paused" | "completed" | "archived";
  sheet_source: string | null;
  created_at: string;
  approved_at: string | null;
  updated_at: string;
}

export interface Reply {
  id: string;
  ownerId?: string;
  lead_id: string | null;
  thread_id: string | null;
  gmail_id: string;
  from_email: string | null;
  subject: string | null;
  snippet: string | null;
  body: string | null;
  received_at: string | null;
  classification: string;
  summary: string | null;
  recommended_action: string | null;
  draft_reply: string | null;
  handled: boolean;
  reply_class?: "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8";
  sequence_action?: "PAUSE" | "SNOOZE" | "STOP" | "GLOBAL_SUPPRESS";
  snooze_until?: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeEntry {
  id: string;
  ownerId?: string;
  category: string;
  title: string;
  content: string;
  sort: number;
  is_master: boolean;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeSource {
  id: string;
  ownerId?: string;
  label: string;
  kind: "url" | "text" | "document" | "note";
  url: string | null;
  content: string | null;
  created_at: string;
  updated_at: string;
}

export interface Suppression {
  id: string;
  email: string;
  reason: string;
  created_at: string;
  updated_at: string;
}

export interface EmailOpen {
  id: string;
  ownerId: string;
  message_id: string;
  lead_id: string | null;
  opened_at: string;
  user_agent: string | null;
}

export interface SendLog {
  id: string;
  lead_id: string;
  message_id: string;
  status: "sent" | "failed";
  at: string;
  created_at: string;
}

export interface AuditLog {
  id: string;
  action: string;
  entity: string;
  entity_id: string;
  detail: Record<string, unknown> | null;
  created_at: string;
}

export interface Settings {
  sender_name: string;
  sender_role: string;
  sender_company: string;
  sender_email: string;
  signature: string;
  /** Account-wide footer appended to every outgoing email. Supports links. */
  email_footer: string;
  /** Outgoing email signature template: plain_personal | executive_clean | accent_bar. */
  email_template: string;
  daily_limit: number;
  campaign_limit: number;
  interval_seconds: number;
  send_window_start: number;
  send_window_end: number;
  send_days: string;
  timezone_offset: number;
  followup_days: number;
  min_score: number;
  unsubscribe_email: string;
  physical_address: string;
  model: string;
  /** Active AI provider id, e.g. "gemini", "openai", "anthropic". */
  ai_provider: string;
  /** User-supplied provider key, stored only in their private settings record. */
  ai_api_key: string;
  /** Optional custom OpenAI-compatible base URL. */
  ai_base_url: string;
  /** When the key was last verified live. */
  ai_verified_at: string;
  /** Masked tail of the key, for display. */
  ai_key_hint: string;
  /** JSON list of every saved model provider, so the vault survives a refresh. */
  ai_providers: string;
  /** JSON UI preferences (operator dock mode and panel position) for the account. */
  ui_prefs: string;
  /** Optional opt-out line in cold email footer (default OFF per plain personal voice). */
  include_opt_out_footer?: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  sender_name: "",
  sender_role: "",
  sender_company: "",
  sender_email: "",
  signature: "",
  email_footer: "",
  email_template: "executive_clean",
  daily_limit: 25,
  campaign_limit: 50,
  interval_seconds: 45,
  send_window_start: 9,
  send_window_end: 17,
  send_days: "1,2,3,4,5",
  timezone_offset: 60,
  followup_days: 4,
  min_score: 65,
  unsubscribe_email: "",
  physical_address: "",
  model: "gemini-3.5-flash",
  ai_provider: "gemini",
  ai_api_key: "",
  ai_base_url: "",
  ai_verified_at: "",
  ai_key_hint: "",
  ai_providers: "",
  ui_prefs: "",
  include_opt_out_footer: false,
};

export const LEAD_STATUS_LABELS: Record<string, string> = {
  new: "Unprocessed",
  queued_research: "Awaiting research",
  researched: "Research completed",
  qualified: "Qualified",
  disqualified: "Disqualified",
  needs_research: "Needs further research",
  email_generated: "Email generated",
  approved: "Approved",
  sent: "Sent",
  replied: "Replied",
  bounced: "Bounced",
  followup_pending: "Follow-up pending",
  converted: "Converted",
  unsubscribed: "Opted out",
  suppressed: "Suppressed",
};

export const SERVICES = [
  "Website redesign",
  "Business website development",
  "Landing page",
  "E-commerce website",
  "Brand identity and logo",
  "Graphic design",
  "Video editing and production",
  "Social media content",
  "Digital presence audit",
  "Website maintenance",
];
