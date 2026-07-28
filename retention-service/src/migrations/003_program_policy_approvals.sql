ALTER TABLE retention_programs
  ADD COLUMN IF NOT EXISTS policy_approval_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS policy_material_ciphertext TEXT;

UPDATE retention_programs
SET
  status = 'paused',
  approved_by = NULL,
  approved_at = NULL,
  updated_at = now()
WHERE status = 'active'
  AND (
    approved_by IS NULL
    OR approved_at IS NULL
    OR policy_approval_sha256 IS NULL
    OR policy_material_ciphertext IS NULL
  );

ALTER TABLE retention_programs
  DROP CONSTRAINT IF EXISTS retention_programs_active_policy_approval;

ALTER TABLE retention_programs
  ADD CONSTRAINT retention_programs_active_policy_approval
  CHECK (
    status <> 'active'
    OR (
      approved_by IS NOT NULL
      AND approved_at IS NOT NULL
      AND policy_approval_sha256 IS NOT NULL
      AND policy_material_ciphertext IS NOT NULL
    )
  );

CREATE INDEX IF NOT EXISTS retention_programs_active
  ON retention_programs (org_id, brand_id, status, updated_at DESC);
