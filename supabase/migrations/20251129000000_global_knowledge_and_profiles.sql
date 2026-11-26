-- Global Sales & Outreach Intelligence (shared once across all accounts)
-- + Per-User Dynamic Business Context Profiles.
--
-- Security / IP Protection:
-- Both tables are strictly server-only (RLS enabled, anon & authenticated roles
-- revoked, service_role only). Regular authenticated users never read or query
-- global_knowledge_modules directly; only server-side prompt orchestration
-- and authenticated platform admins access it.

create table if not exists public.global_knowledge_modules (
  id uuid primary key default gen_random_uuid(),
  module_key text not null check (
    module_key in (
      'module_1_prospecting_research_qualification',
      'module_2_copywriting_psychology_deliverability',
      'module_3_routing_templates_cadence',
      'module_4_replies_objections_closing_compliance'
    )
  ),
  title text not null default '',
  version integer not null default 1 check (version >= 1),
  content text not null,
  is_active boolean not null default true,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists global_knowledge_modules_key_idx
  on public.global_knowledge_modules (module_key, version desc);

create unique index if not exists global_knowledge_modules_key_version_uidx
  on public.global_knowledge_modules (module_key, version);

-- Enforce at most ONE active version per module_key.
create unique index if not exists global_knowledge_modules_active_uidx
  on public.global_knowledge_modules (module_key)
  where (is_active = true);

create table if not exists public.user_business_profiles (
  owner_id text primary key,
  user_name text not null default '',
  user_role text not null default '',
  user_company text not null default '',
  user_offer text not null default '',
  user_mechanism text not null default '',
  user_lead_magnet text not null default '',
  user_proof text not null default '',
  user_icp text not null default '',
  user_exclusions text not null default '',
  user_sending_tier text not null default 'free_gmail_starter' check (
    user_sending_tier in ('free_gmail_starter', 'authenticated_custom_domain')
  ),
  user_tone text not null default '',
  user_custom_rules text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Align default min_score for new settings rows with Tier B+ qualification threshold (65).
alter table if exists public.settings
  alter column min_score set default 65;

-- Strict RLS / server-only privileges.
do $$
declare
  t text;
begin
  foreach t in array array['global_knowledge_modules', 'user_business_profiles']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;

-- Atomic publish of a new global knowledge module version (single transaction).
create or replace function public.publish_global_knowledge_version(
  p_module_key text,
  p_title text,
  p_content text,
  p_updated_by text default null
)
returns setof public.global_knowledge_modules
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next_version integer;
  v_title text;
begin
  select coalesce(max(version), 0) + 1
    into v_next_version
    from public.global_knowledge_modules
   where module_key = p_module_key;

  select coalesce(nullif(trim(p_title), ''), (
    select title from public.global_knowledge_modules
    where module_key = p_module_key
    order by version desc limit 1
  ), p_module_key)
    into v_title;

  update public.global_knowledge_modules
     set is_active = false,
         updated_at = now()
   where module_key = p_module_key
     and is_active = true;

  return query
  insert into public.global_knowledge_modules (
    module_key,
    title,
    version,
    content,
    is_active,
    updated_by,
    created_at,
    updated_at
  )
  values (
    p_module_key,
    v_title,
    v_next_version,
    p_content,
    true,
    p_updated_by,
    now(),
    now()
  )
  returning *;
end $$;

-- Atomic rollback to any existing version (single transaction).
create or replace function public.rollback_global_knowledge_version(
  p_module_key text,
  p_version integer,
  p_updated_by text default null
)
returns setof public.global_knowledge_modules
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.global_knowledge_modules
    where module_key = p_module_key and version = p_version
  ) then
    raise exception 'Version % of module % does not exist.', p_version, p_module_key;
  end if;

  update public.global_knowledge_modules
     set is_active = false,
         updated_at = now()
   where module_key = p_module_key
     and is_active = true;

  return query
  update public.global_knowledge_modules
     set is_active = true,
         updated_by = coalesce(p_updated_by, updated_by),
         updated_at = now()
   where module_key = p_module_key
     and version = p_version
  returning *;
end $$;

revoke all on function public.publish_global_knowledge_version(text, text, text, text) from public, anon, authenticated;
grant execute on function public.publish_global_knowledge_version(text, text, text, text) to service_role;

revoke all on function public.rollback_global_knowledge_version(text, integer, text) from public, anon, authenticated;
grant execute on function public.rollback_global_knowledge_version(text, integer, text) to service_role;
