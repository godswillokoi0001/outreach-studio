-- Signature template style chosen in Settings → Email signature.
-- plain_personal | executive_clean | accent_bar
alter table if exists public.settings
  add column if not exists email_template text not null default 'executive_clean';

comment on column public.settings.email_template is
  'Outgoing email wrapper style: plain_personal, executive_clean (default) or accent_bar.';
