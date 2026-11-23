-- The Supabase settings row stores the selected model alongside the provider,
-- so the AI configuration survives even when Firestore rejects the write.
alter table public.settings add column if not exists model text not null default '';
