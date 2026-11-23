// Supabase Database type: only the `settings` table shape needed for the migration.
// The full schema would include all tables, but only `settings` is used by the
// Supabase data layer (getSupabaseSettings, saveSupabaseSettings, etc.).

export type Database = {
  public: {
    tables: {
      settings: {
        Row: {
          id: string;
          ai_provider: string;
          ai_api_key: string;
          ai_base_url: string;
          ai_verified_at: string;
          ai_key_hint: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          ai_provider: string;
          ai_api_key: string;
          ai_base_url: string;
          ai_verified_at?: string;
          ai_key_hint?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          ai_provider?: string;
          ai_api_key?: string;
          ai_base_url?: string;
          ai_verified_at?: string;
          ai_key_hint?: string;
          updated_at?: string;
        };
      };
      // Other tables exist in the Supabase project but are not referenced here;
      // Leads, Campaigns, Messages, Suppressions, etc. stay on Firebase.
    };
    views: Record<string, unknown>;
    functions: Record<string, unknown>;
    profiles: Record<string, unknown>; // optional, not used in this migration
  };
};