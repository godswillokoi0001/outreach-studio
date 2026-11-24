// Supabase Database type for the `settings` table. Settings are the app's
// Supabase-backed document (Firebase handles auth only); other collections are
// still on Firestore.

type SettingsRow = {
  id: string;
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

export type Database = {
  public: {
    tables: {
      settings: {
        Row: SettingsRow;
        Insert: Partial<SettingsRow> & { id: string };
        Update: Partial<SettingsRow>;
      };
    };
    views: Record<string, unknown>;
    functions: Record<string, unknown>;
    profiles: Record<string, unknown>;
  };
};
