-- The operator's memory: every saved conversation, its messages and its action
-- log. It belongs to the account rather than one browser, so the bot remembers
-- earlier work on any device until the user clears its memory.
create table if not exists public.operator_conversations (
  id text primary key,
  owner_id text not null,
  title text not null default '',
  mode text not null default 'agent',
  model text,
  provider_id text,
  messages jsonb not null default '[]'::jsonb,
  contents jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists operator_conversations_owner_idx
  on public.operator_conversations (owner_id, updated_at desc);

-- Server-only access, exactly like the other tables: the browser goes through
-- the authenticated Next.js route and the route uses the service role.
alter table public.operator_conversations enable row level security;
revoke all on table public.operator_conversations from anon, authenticated;
grant all on table public.operator_conversations to service_role;
