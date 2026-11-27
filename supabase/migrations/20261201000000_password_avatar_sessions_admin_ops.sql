-- Migration: Password & Avatar Profiles, Chat Session Timestamps, Background Jobs Alignment,
-- Admin 2FA Backup Codes, Notifications, Pagination Indexes & Admin Chat History.

-- 1. User Auth Profile (bcrypt password hash + Google/custom avatar storage)
CREATE TABLE IF NOT EXISTS public.user_auth_profiles (
  owner_id TEXT PRIMARY KEY,
  email TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  password_set_at TIMESTAMPTZ,
  avatar_source TEXT NOT NULL DEFAULT 'google' CHECK (avatar_source IN ('google', 'custom')),
  google_avatar_url TEXT,
  custom_avatar_data TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.user_auth_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_auth_profiles FROM anon, authenticated;
GRANT ALL ON TABLE public.user_auth_profiles TO service_role;

-- 2. Operator conversation accurate server session duration columns
ALTER TABLE IF EXISTS public.operator_conversations
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS duration_seconds INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS operator_conversations_session_idx
  ON public.operator_conversations (owner_id, ended_at DESC, updated_at DESC);

-- 3. Align background_jobs schema cleanly (covers both legacy and current worker fields)
CREATE TABLE IF NOT EXISTS public.background_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  current_step TEXT NOT NULL DEFAULT '',
  total_steps INTEGER NOT NULL DEFAULT 0,
  progress_pct INTEGER NOT NULL DEFAULT 0,
  estimated_seconds_remaining INTEGER NOT NULL DEFAULT 0,
  steps_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.background_jobs
  ADD COLUMN IF NOT EXISTS total_steps INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS progress_pct INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS steps_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS error_message TEXT;

CREATE INDEX IF NOT EXISTS background_jobs_owner_idx
  ON public.background_jobs (owner_id, job_type, created_at DESC);

ALTER TABLE public.background_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.background_jobs FROM anon, authenticated;
GRANT ALL ON TABLE public.background_jobs TO service_role;

-- 4. Admin Accounts backup codes support + Security Indexes for fast server-side pagination
ALTER TABLE IF EXISTS public.admin_accounts
  ADD COLUMN IF NOT EXISTS backup_codes_hashes JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS audit_logs_activity_created_idx
  ON public.audit_logs (owner_id, action, created_at DESC);

CREATE INDEX IF NOT EXISTS admin_audit_logs_created_idx
  ON public.admin_audit_logs (created_at DESC, actor_email, action);

-- 5. Admin Notifications Center (deduped grouped platform alerts + read/unread state)
CREATE TABLE IF NOT EXISTS public.admin_notifications (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('critical', 'warning', 'info')),
  message TEXT NOT NULL,
  link_section TEXT NOT NULL DEFAULT 'overview',
  group_key TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  read BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS admin_notifications_unread_idx
  ON public.admin_notifications (read, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_notifications_group_idx
  ON public.admin_notifications (group_key, created_at DESC);

ALTER TABLE public.admin_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_notifications FROM anon, authenticated;
GRANT ALL ON TABLE public.admin_notifications TO service_role;

-- 6. Admin AI Assistant per-admin conversation history
CREATE TABLE IF NOT EXISTS public.admin_chat_conversations (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'Admin Investigation',
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS admin_chat_conversations_admin_idx
  ON public.admin_chat_conversations (admin_id, updated_at DESC);

ALTER TABLE public.admin_chat_conversations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_chat_conversations FROM anon, authenticated;
GRANT ALL ON TABLE public.admin_chat_conversations TO service_role;
