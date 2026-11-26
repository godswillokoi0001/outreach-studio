-- The operator panel's docked/floating choice and its floating position are UI
-- preferences that belong to the account, so they follow the user to another
-- browser or computer instead of living in one localStorage.
alter table public.settings
  add column if not exists ui_prefs text not null default '';
