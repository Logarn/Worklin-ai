ALTER TABLE retention_segment_runs
  ADD COLUMN IF NOT EXISTS cohort_limit INTEGER NOT NULL DEFAULT 500
    CHECK (cohort_limit BETWEEN 1 AND 500),
  ADD COLUMN IF NOT EXISTS cohort_count INTEGER NOT NULL DEFAULT 0
    CHECK (cohort_count BETWEEN 0 AND 500),
  ADD COLUMN IF NOT EXISTS cohort_strategy TEXT NOT NULL DEFAULT 'recent_non_open_activity_v1';

CREATE TABLE IF NOT EXISTS retention_segment_run_cohort (
  org_id UUID NOT NULL,
  segment_run_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  selected_rank INTEGER NOT NULL CHECK (selected_rank BETWEEN 1 AND 500),
  evidence_cutoff_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, segment_run_id, customer_id),
  UNIQUE (org_id, segment_run_id, selected_rank),
  FOREIGN KEY (org_id, segment_run_id)
    REFERENCES retention_segment_runs (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, customer_id)
    REFERENCES retention_customers (org_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS retention_segment_run_cohort_customer
  ON retention_segment_run_cohort (org_id, customer_id, segment_run_id);

ALTER TABLE retention_segment_run_cohort ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_segment_run_cohort FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'retention_segment_run_cohort'
      AND policyname = 'retention_org_isolation'
  ) THEN
    CREATE POLICY retention_org_isolation
      ON retention_segment_run_cohort
      USING (org_id = worklin_current_org_id())
      WITH CHECK (org_id = worklin_current_org_id());
  END IF;
END
$$;
