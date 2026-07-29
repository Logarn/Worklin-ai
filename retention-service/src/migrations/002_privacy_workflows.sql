CREATE TABLE IF NOT EXISTS retention_privacy_requests (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  request_type TEXT NOT NULL
    CHECK (request_type IN ('deletion')),
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('processing', 'completed')),
  raw_payload_count BIGINT NOT NULL DEFAULT 0,
  requested_by TEXT NOT NULL,
  assistant_id TEXT,
  request_id TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (org_id, id),
  UNIQUE (org_id, customer_id, request_type, idempotency_key),
  FOREIGN KEY (org_id, customer_id)
    REFERENCES retention_customers (org_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS retention_privacy_requests_customer
  ON retention_privacy_requests (org_id, customer_id, requested_at DESC);

CREATE TABLE IF NOT EXISTS retention_customer_erasure_tombstones (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  brand_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  primary_email_blind_index TEXT,
  primary_phone_blind_index TEXT,
  erased_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, customer_id),
  FOREIGN KEY (org_id, brand_id)
    REFERENCES retention_brands (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, customer_id)
    REFERENCES retention_customers (org_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS retention_customer_erasure_email
  ON retention_customer_erasure_tombstones (
    org_id,
    brand_id,
    primary_email_blind_index
  )
  WHERE primary_email_blind_index IS NOT NULL;
CREATE INDEX IF NOT EXISTS retention_customer_erasure_phone
  ON retention_customer_erasure_tombstones (
    org_id,
    brand_id,
    primary_phone_blind_index
  )
  WHERE primary_phone_blind_index IS NOT NULL;

CREATE TABLE IF NOT EXISTS retention_identity_erasure_tombstones (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  brand_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  provider TEXT NOT NULL,
  identity_type TEXT NOT NULL,
  external_id_blind_index TEXT NOT NULL,
  erased_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (
    org_id,
    brand_id,
    provider,
    identity_type,
    external_id_blind_index
  ),
  FOREIGN KEY (org_id, brand_id)
    REFERENCES retention_brands (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, customer_id)
    REFERENCES retention_customers (org_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS retention_identity_erasure_customer
  ON retention_identity_erasure_tombstones (org_id, customer_id);

DO $$
DECLARE
  tenant_table TEXT;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'retention_privacy_requests',
    'retention_customer_erasure_tombstones',
    'retention_identity_erasure_tombstones'
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
