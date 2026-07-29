CREATE TABLE IF NOT EXISTS retention_schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION worklin_current_org_id()
RETURNS UUID
LANGUAGE SQL
STABLE
AS $$
  SELECT NULLIF(current_setting('worklin.org_id', true), '')::UUID
$$;

CREATE TABLE IF NOT EXISTS retention_tenant_registry (
  org_id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_job_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS retention_org_settings (
  org_id UUID PRIMARY KEY,
  sensitive_targeting_enabled BOOLEAN NOT NULL DEFAULT false,
  lawful_basis_recorded_at TIMESTAMPTZ,
  lawful_basis_recorded_by TEXT,
  campaign_spend_limit_usd NUMERIC(12, 4),
  monthly_spend_limit_usd NUMERIC(12, 4),
  external_writes_enabled BOOLEAN NOT NULL DEFAULT false,
  send_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS retention_brands (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  name TEXT NOT NULL,
  website_url TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX IF NOT EXISTS retention_brands_org_name
  ON retention_brands (org_id, lower(name));

CREATE TABLE IF NOT EXISTS retention_integrations (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  brand_id UUID NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('shopify', 'klaviyo')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'backfilling', 'active', 'degraded', 'revoked', 'failed')),
  control_plane_connection_id TEXT NOT NULL,
  external_account_id TEXT,
  credential_ciphertext TEXT,
  webhook_secret_ciphertext TEXT,
  property_allowlist JSONB NOT NULL DEFAULT '[]'::JSONB,
  cursor JSONB NOT NULL DEFAULT '{}'::JSONB,
  last_webhook_at TIMESTAMPTZ,
  last_polled_at TIMESTAMPTZ,
  last_reconciled_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, control_plane_connection_id, provider),
  UNIQUE (org_id, brand_id, provider, external_account_id),
  FOREIGN KEY (org_id, brand_id)
    REFERENCES retention_brands (org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS retention_integrations_health
  ON retention_integrations (org_id, status, provider);

CREATE TABLE IF NOT EXISTS retention_migration_runs (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  integration_id UUID NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('preview', 'approved', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  manifest JSONB NOT NULL,
  checkpoint JSONB NOT NULL DEFAULT '{}'::JSONB,
  imported_count BIGINT NOT NULL DEFAULT 0,
  rejected_count BIGINT NOT NULL DEFAULT 0,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, integration_id)
    REFERENCES retention_integrations (org_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS retention_customers (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  brand_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'merged', 'deleted')),
  primary_email_ciphertext TEXT,
  primary_email_blind_index TEXT,
  primary_phone_ciphertext TEXT,
  primary_phone_blind_index TEXT,
  display_name_ciphertext TEXT,
  merged_into_customer_id UUID,
  source_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, brand_id)
    REFERENCES retention_brands (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, merged_into_customer_id)
    REFERENCES retention_customers (org_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS retention_customers_email_identity
  ON retention_customers (org_id, brand_id, primary_email_blind_index)
  WHERE primary_email_blind_index IS NOT NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS retention_customers_phone_identity
  ON retention_customers (org_id, brand_id, primary_phone_blind_index)
  WHERE primary_phone_blind_index IS NOT NULL AND status = 'active';

CREATE TABLE IF NOT EXISTS retention_customer_identities (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  brand_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  provider TEXT NOT NULL,
  identity_type TEXT NOT NULL,
  external_id_ciphertext TEXT NOT NULL,
  external_id_blind_index TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'verified'
    CHECK (status IN ('verified', 'candidate', 'conflicted', 'revoked')),
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, brand_id, provider, identity_type, external_id_blind_index),
  FOREIGN KEY (org_id, brand_id)
    REFERENCES retention_brands (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, customer_id)
    REFERENCES retention_customers (org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS retention_customer_identities_customer
  ON retention_customer_identities (org_id, customer_id);

CREATE TABLE IF NOT EXISTS retention_identity_conflicts (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  brand_id UUID NOT NULL,
  integration_id UUID NOT NULL,
  event_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'resolved', 'dismissed')),
  conflict_type TEXT NOT NULL,
  candidate_customer_ids UUID[] NOT NULL,
  evidence_ciphertext TEXT NOT NULL,
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, event_id),
  FOREIGN KEY (org_id, brand_id)
    REFERENCES retention_brands (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, integration_id)
    REFERENCES retention_integrations (org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS retention_identity_conflicts_open
  ON retention_identity_conflicts (org_id, brand_id, status, created_at);

CREATE TABLE IF NOT EXISTS retention_source_event_dedup (
  org_id UUID NOT NULL,
  integration_id UUID NOT NULL,
  external_event_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  event_id UUID NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, integration_id, external_event_id, payload_sha256),
  FOREIGN KEY (org_id, integration_id)
    REFERENCES retention_integrations (org_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS retention_source_payload_dedup (
  org_id UUID NOT NULL,
  integration_id UUID NOT NULL,
  payload_sha256 TEXT NOT NULL,
  event_id UUID NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, integration_id, payload_sha256),
  FOREIGN KEY (org_id, integration_id)
    REFERENCES retention_integrations (org_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS retention_source_events (
  id UUID NOT NULL,
  org_id UUID NOT NULL,
  brand_id UUID NOT NULL,
  integration_id UUID NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('shopify', 'klaviyo')),
  external_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  customer_id UUID,
  customer_external_id_ciphertext TEXT,
  raw_payload_ref TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  signature_verified BOOLEAN NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'processing', 'processed', 'failed', 'ignored')),
  occurred_at TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  PRIMARY KEY (org_id, id, occurred_at),
  FOREIGN KEY (org_id, brand_id)
    REFERENCES retention_brands (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, integration_id)
    REFERENCES retention_integrations (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, customer_id)
    REFERENCES retention_customers (org_id, id) ON DELETE SET NULL
) PARTITION BY RANGE (occurred_at);
CREATE TABLE IF NOT EXISTS retention_source_events_default
  PARTITION OF retention_source_events DEFAULT;
CREATE INDEX IF NOT EXISTS retention_source_events_customer_time
  ON retention_source_events (org_id, customer_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS retention_source_events_pending
  ON retention_source_events (org_id, processing_status, ingested_at);

CREATE TABLE IF NOT EXISTS retention_customer_traits (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  brand_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  trait_key TEXT NOT NULL,
  value_ciphertext TEXT NOT NULL,
  value_type TEXT NOT NULL,
  evidence_kind TEXT NOT NULL
    CHECK (evidence_kind IN ('observed', 'declared', 'imported', 'inferred')),
  sensitivity TEXT NOT NULL
    CHECK (sensitivity IN ('standard', 'personal', 'sensitive', 'restricted')),
  confidence NUMERIC(5, 4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  targeting_status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (targeting_status IN ('candidate', 'approved', 'rejected', 'expired')),
  evidence_event_ids UUID[] NOT NULL DEFAULT '{}',
  observed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  approved_for_targeting_by TEXT,
  approved_for_targeting_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, brand_id)
    REFERENCES retention_brands (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, customer_id)
    REFERENCES retention_customers (org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS retention_customer_traits_current
  ON retention_customer_traits (org_id, customer_id, trait_key, targeting_status);

CREATE TABLE IF NOT EXISTS retention_consent_events (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  brand_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'push', 'whatsapp')),
  state TEXT NOT NULL CHECK (state IN ('subscribed', 'unsubscribed', 'suppressed', 'unknown')),
  source_provider TEXT NOT NULL,
  source_event_id UUID,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, brand_id)
    REFERENCES retention_brands (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, customer_id)
    REFERENCES retention_customers (org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS retention_consent_events_latest
  ON retention_consent_events (org_id, customer_id, channel, occurred_at DESC);

CREATE TABLE IF NOT EXISTS retention_feature_snapshots (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  brand_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  version TEXT NOT NULL,
  features JSONB NOT NULL,
  evidence_cutoff_at TIMESTAMPTZ NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL,
  invalidated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, brand_id)
    REFERENCES retention_brands (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, customer_id)
    REFERENCES retention_customers (org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS retention_feature_snapshots_customer
  ON retention_feature_snapshots (org_id, customer_id, computed_at DESC);

CREATE TABLE IF NOT EXISTS retention_programs (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  brand_id UUID NOT NULL,
  program_type TEXT NOT NULL
    CHECK (program_type IN ('non_buyer_conversion', 're_engagement', 'repeat_purchase')),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  policy_version TEXT NOT NULL,
  policy JSONB NOT NULL,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, brand_id)
    REFERENCES retention_brands (org_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS retention_segment_definitions (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  brand_id UUID NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  expression JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'archived')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, brand_id, name, version),
  FOREIGN KEY (org_id, brand_id)
    REFERENCES retention_brands (org_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS retention_customer_decisions (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  brand_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  program_id UUID NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('pending_reasoning', 'eligible', 'ineligible', 'needs_review', 'expired')),
  objective TEXT,
  recommended_timing TIMESTAMPTZ,
  recommended_offer JSONB,
  reasoning_ciphertext TEXT,
  competing_hypotheses_ciphertext TEXT,
  dossier_sha256 TEXT,
  evidence_event_ids UUID[] NOT NULL DEFAULT '{}',
  sensitivity TEXT NOT NULL DEFAULT 'standard'
    CHECK (sensitivity IN ('standard', 'personal', 'sensitive', 'restricted')),
  requires_human_review BOOLEAN NOT NULL DEFAULT false,
  confidence NUMERIC(5, 4) CHECK (confidence >= 0 AND confidence <= 1),
  model_provider TEXT,
  model_id TEXT,
  prompt_version TEXT,
  input_evidence_cutoff_at TIMESTAMPTZ NOT NULL,
  reasoned_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, brand_id)
    REFERENCES retention_brands (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, customer_id)
    REFERENCES retention_customers (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, program_id)
    REFERENCES retention_programs (org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS retention_customer_decisions_current
  ON retention_customer_decisions (org_id, program_id, status, invalidated_at);

CREATE TABLE IF NOT EXISTS retention_campaigns (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  brand_id UUID NOT NULL,
  program_id UUID NOT NULL,
  segment_definition_id UUID,
  mode TEXT NOT NULL CHECK (mode IN ('dynamic_template', 'individual_message')),
  name TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  status TEXT NOT NULL
    CHECK (status IN ('draft', 'audience_frozen', 'generating', 'review_required', 'approved', 'ready_to_send', 'sending', 'sent', 'partially_sent', 'failed', 'cancelled')),
  strategy_ciphertext TEXT,
  strategy_version TEXT,
  model_provider TEXT,
  model_id TEXT,
  prompt_version TEXT,
  approval_snapshot_sha256 TEXT,
  approved_at TIMESTAMPTZ,
  approved_by TEXT,
  released_at TIMESTAMPTZ,
  released_by TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, brand_id)
    REFERENCES retention_brands (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, program_id)
    REFERENCES retention_programs (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, segment_definition_id)
    REFERENCES retention_segment_definitions (org_id, id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS retention_campaigns_status
  ON retention_campaigns (org_id, brand_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS retention_audience_snapshots (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  campaign_id UUID NOT NULL,
  definition_version INTEGER NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  member_count BIGINT NOT NULL,
  sensitive_member_count BIGINT NOT NULL DEFAULT 0,
  evidence_cutoff_at TIMESTAMPTZ NOT NULL,
  frozen_by TEXT NOT NULL,
  frozen_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, campaign_id),
  FOREIGN KEY (org_id, campaign_id)
    REFERENCES retention_campaigns (org_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS retention_audience_members (
  org_id UUID NOT NULL,
  audience_snapshot_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  decision_id UUID NOT NULL,
  inclusion_explanation_ciphertext TEXT NOT NULL,
  sensitive_inference_used BOOLEAN NOT NULL DEFAULT false,
  consent_state TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, audience_snapshot_id, customer_id),
  FOREIGN KEY (org_id, audience_snapshot_id)
    REFERENCES retention_audience_snapshots (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, customer_id)
    REFERENCES retention_customers (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, decision_id)
    REFERENCES retention_customer_decisions (org_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS retention_rendered_messages (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  campaign_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  subject_ciphertext TEXT NOT NULL,
  preheader_ciphertext TEXT,
  body_ciphertext TEXT NOT NULL,
  offer_ciphertext TEXT,
  explanation_ciphertext TEXT NOT NULL,
  message_sha256 TEXT NOT NULL,
  model_provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  quality_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (quality_status IN ('pending', 'passed', 'needs_review', 'blocked')),
  sensitive_content_blocked BOOLEAN NOT NULL DEFAULT false,
  generated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, campaign_id, customer_id),
  FOREIGN KEY (org_id, campaign_id)
    REFERENCES retention_campaigns (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, customer_id)
    REFERENCES retention_customers (org_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS retention_approvals (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  campaign_id UUID NOT NULL,
  approval_type TEXT NOT NULL
    CHECK (approval_type IN ('campaign', 'sensitive_targeting')),
  snapshot_sha256 TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'approved', 'rejected', 'invalidated')),
  requested_by TEXT NOT NULL,
  decided_by TEXT,
  requested_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  decision_note_ciphertext TEXT,
  material_ciphertext TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, campaign_id)
    REFERENCES retention_campaigns (org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS retention_approvals_campaign
  ON retention_approvals (org_id, campaign_id, status);

CREATE TABLE IF NOT EXISTS retention_dispatches (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  campaign_id UUID NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('klaviyo')),
  idempotency_key TEXT NOT NULL,
  approval_snapshot_sha256 TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'sending', 'sent', 'partially_sent', 'failed', 'cancelled')),
  provider_campaign_id TEXT,
  provider_list_id TEXT,
  provider_payload_reference TEXT,
  recipient_count BIGINT NOT NULL,
  accepted_count BIGINT NOT NULL DEFAULT 0,
  failed_count BIGINT NOT NULL DEFAULT 0,
  last_error_code TEXT,
  released_by TEXT NOT NULL,
  released_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, idempotency_key),
  FOREIGN KEY (org_id, campaign_id)
    REFERENCES retention_campaigns (org_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS retention_dispatch_recipients (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  dispatch_id UUID NOT NULL,
  campaign_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  opaque_recipient_id TEXT NOT NULL,
  content_ciphertext TEXT,
  consent_event_id UUID,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'failed', 'suppressed', 'cancelled')),
  provider_acceptance_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  accepted_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, dispatch_id, customer_id),
  UNIQUE (org_id, provider_acceptance_id),
  FOREIGN KEY (org_id, dispatch_id)
    REFERENCES retention_dispatches (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, campaign_id)
    REFERENCES retention_campaigns (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, customer_id)
    REFERENCES retention_customers (org_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS retention_dispatch_recipients_pending
  ON retention_dispatch_recipients (org_id, dispatch_id, status);

CREATE TABLE IF NOT EXISTS retention_delivery_events (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  dispatch_id UUID,
  campaign_id UUID,
  customer_id UUID,
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, provider_event_id),
  FOREIGN KEY (org_id, dispatch_id)
    REFERENCES retention_dispatches (org_id, id) ON DELETE SET NULL,
  FOREIGN KEY (org_id, campaign_id)
    REFERENCES retention_campaigns (org_id, id) ON DELETE SET NULL,
  FOREIGN KEY (org_id, customer_id)
    REFERENCES retention_customers (org_id, id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS retention_delivery_events_campaign_time
  ON retention_delivery_events (org_id, campaign_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS retention_experiments (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  brand_id UUID NOT NULL,
  program_id UUID NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('draft', 'active', 'completed', 'cancelled')),
  definition JSONB NOT NULL,
  recommendation_ciphertext TEXT,
  recommendation_status TEXT
    CHECK (recommendation_status IS NULL OR recommendation_status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, brand_id)
    REFERENCES retention_brands (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, program_id)
    REFERENCES retention_programs (org_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS retention_usage_events (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  campaign_id UUID,
  customer_id UUID,
  purpose TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(14, 6),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, campaign_id)
    REFERENCES retention_campaigns (org_id, id) ON DELETE SET NULL,
  FOREIGN KEY (org_id, customer_id)
    REFERENCES retention_customers (org_id, id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS retention_usage_events_org_time
  ON retention_usage_events (org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS retention_budget_reservations (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  campaign_id UUID NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('reserved', 'consumed', 'released', 'expired')),
  estimated_cost_usd NUMERIC(14, 6) NOT NULL,
  actual_cost_usd NUMERIC(14, 6),
  reserved_by TEXT NOT NULL,
  reserved_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, campaign_id, status),
  FOREIGN KEY (org_id, campaign_id)
    REFERENCES retention_campaigns (org_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS retention_jobs (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  job_type TEXT NOT NULL,
  dedupe_key TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'dead_letter')),
  payload_ciphertext TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (org_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS retention_jobs_active_dedupe
  ON retention_jobs (org_id, job_type, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS retention_jobs_claim
  ON retention_jobs (status, available_at, lease_expires_at);

CREATE TABLE IF NOT EXISTS retention_audit_events (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  actor_user_id TEXT,
  assistant_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  request_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX IF NOT EXISTS retention_audit_events_org_time
  ON retention_audit_events (org_id, created_at DESC);

CREATE OR REPLACE FUNCTION worklin_prevent_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'retention audit events are immutable';
END
$$;

DROP TRIGGER IF EXISTS retention_audit_immutable
  ON retention_audit_events;
CREATE TRIGGER retention_audit_immutable
  BEFORE UPDATE OR DELETE ON retention_audit_events
  FOR EACH ROW EXECUTE FUNCTION worklin_prevent_audit_mutation();

DO $$
DECLARE
  tenant_table TEXT;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'retention_tenant_registry',
    'retention_org_settings',
    'retention_brands',
    'retention_integrations',
    'retention_migration_runs',
    'retention_customers',
    'retention_customer_identities',
    'retention_identity_conflicts',
    'retention_source_event_dedup',
    'retention_source_payload_dedup',
    'retention_source_events',
    'retention_source_events_default',
    'retention_customer_traits',
    'retention_consent_events',
    'retention_feature_snapshots',
    'retention_programs',
    'retention_segment_definitions',
    'retention_customer_decisions',
    'retention_campaigns',
    'retention_audience_snapshots',
    'retention_audience_members',
    'retention_rendered_messages',
    'retention_approvals',
    'retention_dispatches',
    'retention_dispatch_recipients',
    'retention_delivery_events',
    'retention_experiments',
    'retention_usage_events',
    'retention_budget_reservations',
    'retention_jobs',
    'retention_audit_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tenant_table);
    IF NOT EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = tenant_table
        AND policyname = 'retention_org_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY retention_org_isolation ON %I USING (org_id = worklin_current_org_id()) WITH CHECK (org_id = worklin_current_org_id())',
        tenant_table
      );
    END IF;
  END LOOP;
END
$$;
