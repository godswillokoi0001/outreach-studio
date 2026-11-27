-- Migration: Per-user Settings isolation, Unique Account Links quarantine fix,
-- Persistent Background Jobs (Onboarding KB & Growth Advisor), and
-- Separate Hardened Admin Authentication.

-- 1. Enforce per-user isolation on `settings` (eliminate global single-row leak).
alter table if exists public.settings
  add column if not exists owner_id text;

-- Migrate legacy primary settings row cleanly to original primary owner and remove nulls.
update public.settings
   set owner_id = '35hOV0TRpFTxkRYpFk3ZUkE75yY2'
 where id = '00000000-0000-0000-0000-000000000001'
   and owner_id is null;

create unique index if not exists settings_owner_uidx
  on public.settings (owner_id)
  where owner_id is not null;

-- 2. Quarantine/separate duplicate legacy_owner_id bindings in `account_links`
-- and guarantee a 1-to-1 owner boundary moving forward.
do $$
declare
  dup record;
begin
  for dup in
    select email, supabase_user_id, legacy_owner_id
      from (
        select email,
               supabase_user_id,
               legacy_owner_id,
               row_number() over (partition by legacy_owner_id order by created_at asc, email asc) as rn
          from public.account_links
      ) t
     where rn > 1
  loop
    update public.account_links
       set legacy_owner_id = coalesce(dup.supabase_user_id::text, 'usr_' || md5(dup.email)),
           updated_at = now()
     where email = dup.email;

    insert into public.audit_logs (id, owner_id, action, entity, entity_id, detail)
    values (
      'quar_' || md5(dup.email || now()::text),
      '__platform_security__',
      'account_link_quarantined_and_separated',
      'account_links',
      dup.email,
      jsonb_build_object(
        'previous_shared_owner_id', dup.legacy_owner_id,
        'new_isolated_owner_id', coalesce(dup.supabase_user_id::text, 'usr_' || md5(dup.email))
      )
    )
    on conflict (id) do nothing;
  end loop;
end $$;

create unique index if not exists account_links_legacy_owner_uidx
  on public.account_links (legacy_owner_id);

-- 3. Persistent user-scoped server background jobs (Onboarding KB compilation & Growth Advisor research).
create table if not exists public.background_jobs (
  id text primary key,
  owner_id text not null,
  job_type text not null check (job_type in ('kb_compile', 'growth_research')),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  current_step integer not null default 0,
  steps jsonb not null default '[]'::jsonb,
  percent integer not null default 0 check (percent >= 0 and percent <= 100),
  estimated_seconds_remaining integer,
  payload jsonb,
  result jsonb,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists background_jobs_owner_idx
  on public.background_jobs (owner_id, job_type, created_at desc);

-- 4. Separate hardened Admin Authentication store (completely isolated from user accounts).
create table if not exists public.admin_accounts (
  id text primary key,
  email text unique not null,
  name text not null default '',
  password_hash text not null,
  role text not null default 'admin' check (role in ('super_admin', 'admin', 'support')),
  totp_secret_encrypted text,
  totp_enabled boolean not null default false,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  last_login_ip text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_login_attempts (
  id text primary key,
  identifier text not null,
  ip text not null default 'unknown',
  succeeded boolean not null default false,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists admin_login_attempts_idx
  on public.admin_login_attempts (identifier, created_at desc);

-- Strict server-only RLS on all new tables.
do $$
declare
  t text;
begin
  foreach t in array array['background_jobs', 'admin_accounts', 'admin_login_attempts']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;
