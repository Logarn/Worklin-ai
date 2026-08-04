ALTER TABLE retention_integrations
  ADD COLUMN IF NOT EXISTS property_access_mode TEXT NOT NULL DEFAULT 'allowlist';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'retention_integrations_property_access_mode_check'
  ) THEN
    ALTER TABLE retention_integrations
      ADD CONSTRAINT retention_integrations_property_access_mode_check
      CHECK (property_access_mode IN ('allowlist', 'all'));
  END IF;
END
$$;
