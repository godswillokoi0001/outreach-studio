// Supabase types for every table the app uses. Only `settings` is strongly
// typed; the document tables keep their rows loosely typed because the data
// layer converts camelCase document fields to snake_case columns.

type SettingsRow = {
  id: string;
  owner_id?: string | null;
  sender_name: string;
  sender_role: string;
  sender_company: string;
  sender_email: string;
  signature: string;
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
  ai_provider: string;
  ai_api_key: string;
  ai_base_url: string;
  ai_verified_at: string;
  ai_key_hint: string;
  created_at: string;
  updated_at: string;
};

type Row = Record<string, unknown>;
type LooseTable = { Row: Row; Insert: Row; Update: Row };

export type Database = {
  public: {
    tables: {
      settings: {
        Row: SettingsRow;
        Insert: Partial<SettingsRow> & { id: string };
        Update: Partial<SettingsRow>;
      };
      account_links: LooseTable;
      campaigns: LooseTable;
      leads: LooseTable;
      messages: LooseTable;
      replies: LooseTable;
      suppressions: LooseTable;
      send_logs: LooseTable;
      audit_logs: LooseTable;
      lead_events: LooseTable;
      knowledge: LooseTable;
      knowledge_sources: LooseTable;
      email_opens: LooseTable;
      operator_conversations: LooseTable;
      global_knowledge_modules: LooseTable;
      user_business_profiles: LooseTable;
      background_jobs: LooseTable;
      email_rewrite_workspaces: LooseTable;
      admin_accounts: LooseTable;
      admin_login_attempts: LooseTable;
      admin_ai_settings: LooseTable;
      admin_ai_keys: LooseTable;
      user_ai_settings: LooseTable;
      user_ai_keys: LooseTable;
      ai_execution_logs: LooseTable;
      search_enrichment_cache: LooseTable;
      search_provider_quotas: LooseTable;
      growth_execute_runs: LooseTable;
    };
    views: Record<string, unknown>;
    functions: Record<string, unknown>;
  };
};
