-- Settings moved from Firestore to Supabase because the deployed Firestore
-- rules reject writes that carry the AI fields and cannot be republished while
-- the Firebase project is unverified. The row holds the whole settings document.
alter table public.settings
  add column if not exists sender_name text not null default '',
  add column if not exists sender_role text not null default '',
  add column if not exists sender_company text not null default '',
  add column if not exists sender_email text not null default '',
  add column if not exists signature text not null default '',
  add column if not exists daily_limit integer not null default 25,
  add column if not exists campaign_limit integer not null default 50,
  add column if not exists interval_seconds integer not null default 45,
  add column if not exists send_window_start integer not null default 9,
  add column if not exists send_window_end integer not null default 17,
  add column if not exists send_days text not null default '1,2,3,4,5',
  add column if not exists timezone_offset integer not null default 60,
  add column if not exists followup_days integer not null default 4,
  add column if not exists min_score integer not null default 55,
  add column if not exists unsubscribe_email text not null default '',
  add column if not exists physical_address text not null default '';
