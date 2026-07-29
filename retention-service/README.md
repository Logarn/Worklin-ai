# Worklin Retention Service

`retention-service` is Worklin's private customer-intelligence and campaign
decisioning data service. It is a Bun/TypeScript HTTP service backed by
PostgreSQL and a private S3-compatible raw-payload bucket.

The authoritative production deployment and incident procedure is
[`docs/retention-service-production-runbook.md`](../docs/retention-service-production-runbook.md).
Do not deploy this service from the README alone.

## Security Boundary

- The service has no browser-facing or provider-facing public domain.
- The Worklin control plane mints short-lived actor tokens containing the
  organization, user, assistant, and retention permissions.
- Every tenant table includes `org_id` and uses forced PostgreSQL row-level
  security.
- Runtime queries set organization context transaction-locally.
- Readiness fails when the runtime database role is a superuser, can bypass
  RLS, owns tenant tables, starts with an organization context, or finds an
  organization-scoped table without forced RLS and its policy.
- Sensitive fields and raw payloads are encrypted by the application.
- Provider webhooks pass through the public gateway and control plane before
  reaching the private service.
- Tenant registration is a normal insert inside the authenticated
  organization's transaction. The schema has no cross-tenant
  `SECURITY DEFINER` helper.

## Safe Deployment Posture

Production starts with:

```text
WORKLIN_RETENTION_RUN_MIGRATIONS=false
WORKLIN_RETENTION_EXTERNAL_WRITES_ENABLED=false
WORKLIN_RETENTION_SEND_ENABLED=false
```

The organization-level write and send switches also default to false.

Do not enable sending in this revision. Campaign release creates idempotent
dispatch intent, but no outbound Klaviyo adapter consumes it.

Verified read-only webhook ingestion may begin only after the production
runbook's infrastructure, backup, isolation, and synthetic-tenant gates pass.

## Endpoints

- `GET /healthz`: process liveness only.
- `GET /readyz`: database, migration, runtime-role/RLS, bucket, and global
  kill-switch readiness.
- `GET /v1/retention/status`: tenant-scoped integration and job status.
- `POST /v1/retention/jobs/wake`: authenticated, permission-gated wake for only
  the token's organization.
- `/v1/retention/*`: authenticated operator and campaign APIs.
- `POST /v1/retention/integrations/{provider}/webhooks/{connectionId}`:
  private, signed webhook handoff from the control plane.

## Migrations

Migrations are append-only under `src/migrations`. The normal runtime database
role must never own schema objects or run migrations.

The current migration path uses a temporary private release with:

```text
WORKLIN_RETENTION_RUN_MIGRATIONS=true
WORKLIN_RETENTION_MIGRATION_DATABASE_URL=<migrator-role-url>
```

Stop that release after migration, apply the documented runtime grants, and
deploy the steady-state service with the runtime URL. Remove the migrator URL
from the steady-state service.

## Verification

From this package:

```bash
bun run typecheck
bun test src
```

Run `tests/tenant-isolation.sql` against a real PostgreSQL database using the
non-bypass runtime role. Never substitute an in-memory or privileged database
for the production isolation check.

The implemented worker does not scan across organizations. A verified webhook
wakes only its authenticated organization, and the worker re-wakes that same
organization until its eligible jobs are drained. The control plane performs a
recovery sweep at startup and every five minutes, selecting one active
assistant binding per organization and issuing separately signed tenant wakes.
Each tenant wake also drains durable raw-payload deletion work and schedules due
authenticated provider synchronization:
historical imports resume from a durable checkpoint, incremental polling is due
every five minutes, and recent-source reconciliation is due hourly. Checkpoints
advance only after encrypted raw evidence and deduplicated source events have
been durably recorded.

## Isolated Runtime Bridge

The control-plane provisioner enables the assistant bridge with:

```text
WORKLIN_RETENTION_ASSISTANT_BRIDGE_ENABLED=true
WORKLIN_CONTROL_PLANE_INTERNAL_URL=<private-control-plane-origin>
WORKLIN_RETENTION_GATEWAY_INGRESS_SECRET=<shared-ingress-secret>
```

Each isolated runtime also receives `PLATFORM_ORGANIZATION_ID` and
`WORKLIN_PLATFORM_ASSISTANT_ID`. The gateway rejects mismatched identities and
allows only the central retention preparation routes. Approval, release,
sending, access grants, and integration management are excluded.

## Current Limits

Implemented:

- Forced tenant RLS and complete non-bypass runtime readiness checks
- Tenant-scoped registration without `SECURITY DEFINER`
- Explicit webhook tenant wakes and five-minute restart recovery
- Empty-database migration, tenant-isolation SQL, and real PostgreSQL operator
  flow
- Identity-pinned, route-allowlisted assistant bridge
- Encrypted raw-payload storage
- Database-first durable raw-payload persistence before normalization
- Verified Shopify and Klaviyo webhook ingress
- Read-only Shopify customer/order and Klaviyo profile/event backfills with
  durable cursor and watermark checkpoints
- Five-minute incremental synchronization and hourly recent-source
  reconciliation, scoped to the authenticated organization
- Source-event deduplication and normalization jobs
- Customer, trait, consent, decision, campaign, approval, usage, dispatch, and
  immutable audit persistence
- Privacy access, export, correction, deletion, consent history, integration
  revocation, and deletion tombstones
- Durable raw-payload deletion outbox operations that never perform bucket
  deletion inside a database transaction
- Per-recipient dossier leases, decision persistence, and encrypted campaign
  message persistence
- Server-enforced message checks for unsupported numeric claims, factual
  contradictions, unsafe template tokens, and revealing sensitive inferences
- Checksum-bound program activation, campaign approval invalidation, and
  owner-facing Work review surfaces
- Global and organization write/send gates

Not production-complete:

- Shopify OAuth, webhook subscription management, Web Pixels, and complete
  product/refund/fulfillment backfills
- Klaviyo OAuth and complete system-webhook coverage
- Nightly authoritative reconciliation and raw-event replay tooling
- Production model runner and second-pass model review
- Organization kill-switch UI
- Outbound Klaviyo delivery and provider acceptance tracking
- Online encryption-key rotation
- Fleet metrics exporter and production-scale load proof

The runbook gap matrix is the release authority for these limits.
