-- ============================================================================
-- Search/Enrichment Cache, Provider Quotas, and Checkpointed Growth Runs
-- ============================================================================

create table if not exists public.search_enrichment_cache (
  cache_key text primary key,
  kind text not null,
  payload jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists search_enrichment_cache_expires_idx
  on public.search_enrichment_cache (expires_at);

alter table public.search_enrichment_cache enable row level security;
revoke all on table public.search_enrichment_cache from anon, authenticated;

create table if not exists public.search_provider_quotas (
  provider text primary key,
  used_count integer not null default 0,
  quota_limit integer not null default 1000,
  reset_cycle text not null default 'monthly',
  exhausted_until timestamptz,
  last_reset_at timestamptz not null default now(),
  cache_hits_saved integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.search_provider_quotas enable row level security;
revoke all on table public.search_provider_quotas from anon, authenticated;

create table if not exists public.growth_execute_runs (
  id text primary key,
  owner_id text not null,
  status text not null default 'in_progress',
  current_stage text not null default 'strategy',
  state_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists growth_execute_runs_owner_idx
  on public.growth_execute_runs (owner_id, updated_at desc);

alter table public.growth_execute_runs enable row level security;
revoke all on table public.growth_execute_runs from anon, authenticated;
