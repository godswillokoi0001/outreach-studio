-- The settings table stores the user's private AI API key. It must only be
-- reachable from the server (service role) through the authenticated
-- /api/settings route, never from the browser with the public anon key.
--
-- Without this, anonymous inserts fail with 42501 (RLS) and anonymous selects
-- can leak the stored key.

alter table public.settings enable row level security;

revoke all on table public.settings from anon, authenticated;

grant all on table public.settings to service_role;
