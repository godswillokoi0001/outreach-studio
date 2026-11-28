-- Migration: add the account-wide email footer saved in Settings.
-- The footer is appended server-side at Gmail dispatch time so it lands on
-- every outgoing email (initial, follow-up and reply). Plain text with light
-- Markdown links, up to 4000 characters.

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS email_footer TEXT NOT NULL DEFAULT '';
