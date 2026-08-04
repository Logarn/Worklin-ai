CREATE TABLE IF NOT EXISTS retention_segment_runs (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  brand_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'claimed', 'paused', 'completed', 'failed')),
  max_segments INTEGER NOT NULL CHECK (max_segments BETWEEN 1 AND 50),
  sample_limit_per_segment INTEGER NOT NULL
    CHECK (sample_limit_per_segment BETWEEN 1 AND 2),
  tranche_size INTEGER NOT NULL CHECK (tranche_size BETWEEN 1 AND 10),
  completed_segment_count INTEGER NOT NULL DEFAULT 0
    CHECK (completed_segment_count >= 0),
  evidence_cutoff_at TIMESTAMPTZ NOT NULL,
  account_dossier_ciphertext TEXT NOT NULL,
  account_dossier_sha256 TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_by TEXT NOT NULL,
  claimed_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, brand_id)
    REFERENCES retention_brands (org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS retention_segment_runs_brand_time
  ON retention_segment_runs (org_id, brand_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS retention_segment_runs_one_open_per_brand
  ON retention_segment_runs (org_id, brand_id)
  WHERE status IN ('queued', 'claimed', 'paused');

ALTER TABLE retention_segment_definitions
  ADD COLUMN IF NOT EXISTS source_run_id UUID,
  ADD COLUMN IF NOT EXISTS definition_checksum_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS activated_by TEXT,
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'retention_segment_definitions_source_run_fk'
  ) THEN
    ALTER TABLE retention_segment_definitions
      ADD CONSTRAINT retention_segment_definitions_source_run_fk
      FOREIGN KEY (org_id, source_run_id)
      REFERENCES retention_segment_runs (org_id, id) ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS retention_segment_definitions_source_run
  ON retention_segment_definitions (org_id, source_run_id, version);

CREATE TABLE IF NOT EXISTS retention_segment_memberships (
  org_id UUID NOT NULL,
  segment_definition_id UUID NOT NULL,
  segment_run_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  campaign_eligible BOOLEAN NOT NULL,
  eligibility_reason TEXT NOT NULL
    CHECK (eligibility_reason IN (
      'eligible',
      'missing_email',
      'unsubscribed',
      'suppressed',
      'consent_unknown'
    )),
  evidence_cutoff_at TIMESTAMPTZ NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, segment_definition_id, customer_id),
  FOREIGN KEY (org_id, segment_definition_id)
    REFERENCES retention_segment_definitions (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, segment_run_id)
    REFERENCES retention_segment_runs (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, customer_id)
    REFERENCES retention_customers (org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS retention_segment_memberships_current
  ON retention_segment_memberships (
    org_id,
    segment_definition_id,
    campaign_eligible,
    customer_id
  );

CREATE TABLE IF NOT EXISTS retention_campaign_previews (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  segment_run_id UUID NOT NULL,
  segment_definition_id UUID NOT NULL,
  strategy_ciphertext TEXT NOT NULL,
  evidence_ciphertext TEXT NOT NULL,
  quality_status TEXT NOT NULL
    CHECK (quality_status IN ('passed', 'needs_review', 'blocked')),
  quality_issues_ciphertext TEXT NOT NULL,
  model_provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  usage JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, segment_definition_id),
  FOREIGN KEY (org_id, segment_run_id)
    REFERENCES retention_segment_runs (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, segment_definition_id)
    REFERENCES retention_segment_definitions (org_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS retention_campaign_preview_samples (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  campaign_preview_id UUID NOT NULL,
  customer_reference_ciphertext TEXT NOT NULL,
  subject_ciphertext TEXT NOT NULL,
  preheader_ciphertext TEXT,
  body_ciphertext TEXT NOT NULL,
  explanation_ciphertext TEXT NOT NULL,
  message_sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, campaign_preview_id)
    REFERENCES retention_campaign_previews (org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS retention_campaign_preview_samples_preview
  ON retention_campaign_preview_samples (org_id, campaign_preview_id, created_at);

DO $$
DECLARE
  tenant_table TEXT;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'retention_segment_runs',
    'retention_segment_memberships',
    'retention_campaign_previews',
    'retention_campaign_preview_samples'
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
