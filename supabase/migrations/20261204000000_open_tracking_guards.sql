-- Sender IP hash for self-open suppression.
-- The value is a salted SHA-256 prefix, never the raw address. Nullable: rows
-- sent before this migration simply fall back to the session and grace guards.
alter table if exists public.messages
  add column if not exists sender_ip_hash text;

comment on column public.messages.sender_ip_hash is
  'Salted hash of the sender machine IP at send time; used to ignore same-IP self-opens.';
