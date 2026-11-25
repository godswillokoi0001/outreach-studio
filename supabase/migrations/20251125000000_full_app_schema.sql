-- Full application schema for Supabase.
--
-- This mirrors the Firestore collections the app currently uses. Documents keep
-- their existing string ids and the owner column is text, so a Firebase uid
-- (and the existing random ids) can be copied across unchanged.
--
-- The whole schema is server-only: every request goes through an authenticated
-- Next.js route that verifies the caller, then uses the service role. No table
-- is readable with the public anon key, because several rows hold private
-- prospect data and AI output.

-- Maps a sign-in to the data it owns. Migration seeds one row per Firebase
-- user (email -> Firebase uid). When the same person signs in with Supabase
-- Auth, the server attaches their new Supabase user id here and keeps using the
-- legacy owner id as the data key, so nothing has to be rewritten.
create table if not exists public.account_links (
  email text primary key,
  legacy_owner_id text not null,
  supabase_user_id uuid unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.campaigns (
  id text primary key,
  owner_id text not null,
  name text not null default '',
  instruction text,
  config jsonb not null default '{}'::jsonb,
  status text not null default 'draft',
  sheet_source text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists campaigns_owner_idx on public.campaigns (owner_id, created_at desc);

create table if not exists public.leads (
  id text primary key,
  owner_id text not null,
  campaign_id text,
  business text,
  contact_name text,
  role text,
  email text,
  email_norm text,
  website text,
  phone text,
  location text,
  industry text,
  notes text,
  extra text,
  source text,
  source_ref text,
  sheet_row integer,
  status text not null default 'new',
  score integer,
  priority text,
  score_reason jsonb,
  research jsonb,
  research_at timestamptz,
  research_ok boolean not null default false,
  manual_research text,
  last_contacted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists leads_owner_idx on public.leads (owner_id, updated_at desc);
create index if not exists leads_campaign_idx on public.leads (owner_id, campaign_id);
create unique index if not exists leads_owner_email_idx on public.leads (owner_id, email_norm)
  where email_norm is not null;

create table if not exists public.messages (
  id text primary key,
  owner_id text not null,
  lead_id text not null,
  campaign_id text,
  step integer not null default 1,
  kind text not null default 'initial',
  subject text,
  body text,
  angle text,
  rationale text,
  service text,
  status text not null default 'draft',
  gmail_id text,
  thread_id text,
  rfc_message_id text,
  sent_at timestamptz,
  error text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists messages_owner_idx on public.messages (owner_id, created_at desc);
create index if not exists messages_lead_idx on public.messages (owner_id, lead_id);

create table if not exists public.replies (
  id text primary key,
  owner_id text not null,
  lead_id text,
  thread_id text,
  gmail_id text not null,
  from_email text,
  subject text,
  snippet text,
  body text,
  received_at timestamptz,
  classification text not null default 'other',
  summary text,
  recommended_action text,
  draft_reply text,
  handled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists replies_owner_idx on public.replies (owner_id, created_at desc);

create table if not exists public.suppressions (
  id text primary key,
  owner_id text not null,
  email text not null,
  reason text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists suppressions_owner_email_idx on public.suppressions (owner_id, email);

create table if not exists public.send_logs (
  id text primary key,
  owner_id text not null,
  lead_id text not null,
  message_id text not null,
  status text not null default 'sent',
  at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists send_logs_owner_idx on public.send_logs (owner_id, at desc);

create table if not exists public.audit_logs (
  id text primary key,
  owner_id text not null,
  action text not null default '',
  entity text not null default '',
  entity_id text not null default '',
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_owner_idx on public.audit_logs (owner_id, created_at desc);

create table if not exists public.lead_events (
  id text primary key,
  owner_id text not null,
  lead_id text not null,
  action text not null default '',
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists lead_events_owner_idx on public.lead_events (owner_id, lead_id, created_at desc);

create table if not exists public.knowledge (
  id text primary key,
  owner_id text not null,
  category text not null default 'custom',
  title text not null default '',
  content text not null default '',
  sort integer not null default 50,
  is_master boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists knowledge_owner_idx on public.knowledge (owner_id, sort);

create table if not exists public.knowledge_sources (
  id text primary key,
  owner_id text not null,
  label text not null default '',
  kind text not null default 'url',
  url text,
  content text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists knowledge_sources_owner_idx on public.knowledge_sources (owner_id, created_at desc);

create table if not exists public.email_opens (
  id text primary key,
  owner_id text not null,
  message_id text not null,
  lead_id text,
  opened_at timestamptz not null default now(),
  user_agent text
);
create index if not exists email_opens_owner_idx on public.email_opens (owner_id, opened_at desc);

-- Server-only access, exactly like the existing settings table. The anon and
-- authenticated roles are revoked; the Next.js routes authenticate the user and
-- then query with the service role.
do $$
declare
  t text;
begin
  foreach t in array array[
    'account_links','campaigns','leads','messages','replies','suppressions',
    'send_logs','audit_logs','lead_events','knowledge','knowledge_sources',
    'email_opens'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;
