CREATE TABLE IF NOT EXISTS retention_raw_payload_deletions (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  source_event_id UUID NOT NULL,
  privacy_request_id UUID,
  raw_payload_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'deleted')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, source_event_id, raw_payload_ref),
  FOREIGN KEY (org_id, privacy_request_id)
    REFERENCES retention_privacy_requests (org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS retention_raw_payload_deletions_pending
  ON retention_raw_payload_deletions (org_id, status, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS retention_raw_payload_deletions_privacy
  ON retention_raw_payload_deletions (org_id, privacy_request_id, status)
  WHERE privacy_request_id IS NOT NULL;

ALTER TABLE retention_raw_payload_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_raw_payload_deletions FORCE ROW LEVEL SECURITY;
CREATE POLICY retention_org_isolation
  ON retention_raw_payload_deletions
  USING (org_id = worklin_current_org_id())
  WITH CHECK (org_id = worklin_current_org_id());
