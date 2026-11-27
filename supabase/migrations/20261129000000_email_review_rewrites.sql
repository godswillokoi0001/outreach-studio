-- ============================================================================
-- Email Review AI Rewrite Workspaces & Background Job Type Extension
-- ============================================================================

-- Allow email_review_rewrite (and existing app job types) in background_jobs
alter table if exists public.background_jobs
  drop constraint if exists background_jobs_job_type_check;

alter table if exists public.background_jobs
  add constraint background_jobs_job_type_check
  check (
    job_type in (
      'kb_compile',
      'onboarding_kb_compile',
      'growth_research',
      'growth_advisor_research',
      'email_review_rewrite'
    )
  );

-- Durable per-owner Email Rewrite workspace (diff, analysis, check, version history)
create table if not exists public.email_rewrite_workspaces (
  owner_id text primary key,
  state_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.email_rewrite_workspaces enable row level security;
revoke all on table public.email_rewrite_workspaces from public, anon, authenticated;
grant all on table public.email_rewrite_workspaces to service_role;
