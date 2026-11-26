-- The model-provider vault (name, provider, model, base URL and key per
-- provider) used to live only in localStorage, so it vanished on another
-- browser. Storing the JSON document here keeps it with the account.
alter table public.settings
  add column if not exists ai_providers text not null default '';
