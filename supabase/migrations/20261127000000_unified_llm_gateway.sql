-- ============================================================================
-- Unified Multi-Key Auto-Failover LLM Gateway (Admin Pool + User BYOK + Receipts)
-- ============================================================================

create table if not exists public.admin_ai_settings (
  id text primary key,
  master_mode text not null default 'auto',
  strategy text not null default 'balanced',
  fallback_chain_json jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_ai_keys (
  id text primary key,
  provider text not null,
  label text not null,
  encrypted_key text not null,
  masked_key text not null,
  account_id text,
  base_url text,
  enabled boolean not null default true,
  models_json jsonb not null default '[]'::jsonb,
  rpm_limit integer not null default 15,
  rpd_limit integer not null default 1000,
  health_status text not null default 'healthy',
  cooldown_until timestamptz,
  cooldown_step integer not null default 0,
  last_error text,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists admin_ai_keys_provider_idx
  on public.admin_ai_keys (provider, enabled, health_status);

create table if not exists public.user_ai_settings (
  owner_id text primary key,
  mode text not null default 'system_auto',
  active_key_id text,
  active_provider text,
  active_model text,
  fallback_to_system_auto boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.user_ai_keys (
  id text primary key,
  owner_id text not null,
  provider text not null,
  label text not null,
  encrypted_key text not null,
  masked_key text not null,
  account_id text,
  base_url text,
  models_json jsonb not null default '[]'::jsonb,
  last_verified_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists user_ai_keys_owner_idx
  on public.user_ai_keys (owner_id, provider);

create table if not exists public.ai_execution_logs (
  id text primary key,
  owner_id text not null,
  task_type text not null,
  feature text not null,
  requested_mode text not null,
  requested_model text,
  actual_provider text,
  actual_key_id text,
  actual_model text,
  fallback_hops integer not null default 0,
  fallback_used boolean not null default false,
  grounded boolean not null default false,
  latency_ms integer not null default 0,
  status text not null,
  error_summary text,
  created_at timestamptz not null default now()
);

create index if not exists ai_execution_logs_created_idx
  on public.ai_execution_logs (created_at desc);

create index if not exists ai_execution_logs_owner_idx
  on public.ai_execution_logs (owner_id, created_at desc);

alter table public.admin_ai_settings enable row level security;
alter table public.admin_ai_keys enable row level security;
alter table public.user_ai_settings enable row level security;
alter table public.user_ai_keys enable row level security;
alter table public.ai_execution_logs enable row level security;

revoke all on table public.admin_ai_settings from public, anon, authenticated;
grant all on table public.admin_ai_settings to service_role;

revoke all on table public.admin_ai_keys from public, anon, authenticated;
grant all on table public.admin_ai_keys to service_role;

revoke all on table public.user_ai_settings from public, anon, authenticated;
grant all on table public.user_ai_settings to service_role;

revoke all on table public.user_ai_keys from public, anon, authenticated;
grant all on table public.user_ai_keys to service_role;

revoke all on table public.ai_execution_logs from public, anon, authenticated;
grant all on table public.ai_execution_logs to service_role;
