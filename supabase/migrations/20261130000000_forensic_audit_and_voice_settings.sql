-- Migration: Add include_opt_out_footer toggle (default false) to settings
-- Note: audit_evidence & mobile_screenshot_url live inside leads.research JSONB,
-- and search_enrichment_cache/search_provider_quotas already support 'contact' & updated search providers.

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS include_opt_out_footer BOOLEAN NOT NULL DEFAULT false;
