\set ON_ERROR_STOP on

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'worklin_retention_runtime_test'
  ) THEN
    DROP OWNED BY worklin_retention_runtime_test;
    DROP ROLE worklin_retention_runtime_test;
  END IF;
END
$$;
CREATE ROLE worklin_retention_runtime_test
  NOLOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO worklin_retention_runtime_test;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public
  TO worklin_retention_runtime_test;
GRANT EXECUTE ON FUNCTION worklin_current_org_id()
  TO worklin_retention_runtime_test;

SET ROLE worklin_retention_runtime_test;

DO $$
BEGIN
  IF (SELECT count(*) FROM retention_brands) <> 0 THEN
    RAISE EXCEPTION 'tenant table leaked rows without organization context';
  END IF;
  BEGIN
    INSERT INTO retention_org_settings (org_id)
    VALUES ('11111111-1111-4111-8111-111111111111');
    RAISE EXCEPTION 'tenant insert unexpectedly succeeded without context';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END
$$;

SELECT set_config(
  'worklin.org_id',
  '11111111-1111-4111-8111-111111111111',
  false
);
INSERT INTO retention_tenant_registry (org_id)
VALUES ('11111111-1111-4111-8111-111111111111');
INSERT INTO retention_org_settings (org_id)
VALUES ('11111111-1111-4111-8111-111111111111');
INSERT INTO retention_brands (id, org_id, name)
VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '11111111-1111-4111-8111-111111111111',
  'Tenant A'
);
INSERT INTO retention_customers (
  id,
  org_id,
  brand_id,
  primary_email_ciphertext,
  primary_email_blind_index
)
VALUES (
  'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  '11111111-1111-4111-8111-111111111111',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'same-encrypted-email',
  'same-email-blind-index'
);

SELECT set_config(
  'worklin.org_id',
  '22222222-2222-4222-8222-222222222222',
  false
);
INSERT INTO retention_tenant_registry (org_id)
VALUES ('22222222-2222-4222-8222-222222222222');
INSERT INTO retention_org_settings (org_id)
VALUES ('22222222-2222-4222-8222-222222222222');
INSERT INTO retention_brands (id, org_id, name)
VALUES (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '22222222-2222-4222-8222-222222222222',
  'Tenant B'
);
INSERT INTO retention_customers (
  id,
  org_id,
  brand_id,
  primary_email_ciphertext,
  primary_email_blind_index
)
VALUES (
  'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  '22222222-2222-4222-8222-222222222222',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'same-encrypted-email',
  'same-email-blind-index'
);

DO $$
BEGIN
  IF (SELECT count(*) FROM retention_customers) <> 1 THEN
    RAISE EXCEPTION 'tenant B did not see exactly its own customer';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM retention_customers
    WHERE org_id = '11111111-1111-4111-8111-111111111111'
  ) THEN
    RAISE EXCEPTION 'tenant B could read tenant A';
  END IF;
  BEGIN
    INSERT INTO retention_brands (id, org_id, name)
    VALUES (
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      '11111111-1111-4111-8111-111111111111',
      'Forged tenant'
    );
    RAISE EXCEPTION 'cross-tenant insert unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END
$$;

SELECT set_config(
  'worklin.org_id',
  '11111111-1111-4111-8111-111111111111',
  false
);
DO $$
BEGIN
  IF (SELECT count(*) FROM retention_customers) <> 1 THEN
    RAISE EXCEPTION 'tenant A did not see exactly its own customer';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM retention_customers
    WHERE org_id = '22222222-2222-4222-8222-222222222222'
  ) THEN
    RAISE EXCEPTION 'tenant A could read tenant B';
  END IF;
END
$$;

SELECT set_config('worklin.org_id', '', false);
DO $$
BEGIN
  IF (SELECT count(*) FROM retention_customers) <> 0 THEN
    RAISE EXCEPTION 'tenant rows leaked after organization context reset';
  END IF;
END
$$;

RESET ROLE;
DROP OWNED BY worklin_retention_runtime_test;
DROP ROLE worklin_retention_runtime_test;
