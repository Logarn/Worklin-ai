# Concurrent Multi-Tenant Runtime Service

The concurrent runtime is an opt-in, chat-only execution tier in which one
replica can process turns for many organizations and assistants at the same
time. It creates logical assistant state in shared PostgreSQL storage instead
of provisioning a Railway service and volume for every eligible assistant.

This tier does not switch a process-global assistant ID, workspace, current
directory, environment, or SQLite connection. Every request carries an
immutable tenant context and every durable query is scoped by organization and
assistant.

## Topology

```mermaid
flowchart LR
    Browser["Web or iOS client"] --> CP["Control plane"]
    CP --> GW["Shared gateway"]
    GW --> Runtime["Concurrent runtime replicas"]
    Runtime --> PG["PostgreSQL with forced RLS"]
    Runtime --> LLM["Managed LLM provider"]
```

The control plane remains the public API edge. It authenticates assistant
ownership and signs a short-lived actor token containing organization, user,
assistant, actor, and request identities. The shared gateway runs with
`RUNTIME_ASSISTANT_SCOPE_MODE=tenant_context`, verifies that the URL, token,
and canonical tenant headers agree, exchanges the token for the runtime
audience, and rewrites assistant-scoped URLs to flat runtime routes.

The runtime rejects pooled-worker leases, gateway service authority, missing
tenant claims, mismatched headers, subject mismatches, and insufficient
scopes.

Managed-model inference is available only inside the validated request-local
tenant context. The shared process does not switch a global assistant ID,
read personal provider credentials, or cache a key-bearing adapter across
requests. A company-owned provider key is stored only in the service's secret
environment; tenant identity is carried separately in usage attribution.

## Supported Contract

The first deployment slice supports:

- `POST /v1/messages`;
- `GET /v1/messages?conversationId=...`;
- `GET /v1/events` with durable replay and heartbeat frames;
- `POST /v1/conversations/:id/cancel`;
- `/health`, `/healthz`, and `/readyz`.

Messages are accepted idempotently, return `202`, and are executed through a
fair global/per-tenant scheduler. Turns for one conversation serialize while
different conversations can run concurrently. Retrying the accepted request
with the same idempotency key reclaims queued runs and processing runs whose
lease expired. SSE subscribers that cannot keep up are shed with structured
logging and Sentry reporting instead of growing an unbounded in-memory buffer.

All other `/v1/*` routes return `requires_dedicated_runtime`. Attachments,
onboarding bootstrap payloads, slash commands, personal provider credentials,
custom model endpoints, workspace operations, memory, tools, schedules,
channels, voice, host access, and long-lived local processes remain dedicated
runtime capabilities.

## Persistence And Isolation

`assistant/src/concurrent-runtime/` owns the stateless execution kernel and
PostgreSQL repository. `@vellumai/service-contracts/tenant-context` owns the
versioned tenant claim and execution-context schemas.

The initial append-only migration creates:

- tenant-scoped assistant, conversation, message, run, and event tables;
- compound ownership primary/foreign keys;
- tenant-scoped idempotency uniqueness;
- ordered transcript positions;
- run leases and fencing;
- durable event sequence indexes;
- enabled and forced row-level security on every tenant table.

Repository operations require an explicit `TenantExecutionContext`, set
transaction-local PostgreSQL tenant settings, and include explicit
organization and assistant predicates even though RLS is also active.

The application database role must not have `BYPASSRLS`. Run migrations with
a separate migration role through
`CONCURRENT_RUNTIME_MIGRATION_DATABASE_URL` when the application role cannot
perform DDL.

## Placement

Concurrent placement is disabled by default. The control plane accepts:

```text
WORKLIN_CONCURRENT_RUNTIME_MODE=disabled|internal|canary|new_assistants
WORKLIN_CONCURRENT_RUNTIME_GATEWAY_URL=http://<shared-gateway>:<port>
WORKLIN_CONCURRENT_RUNTIME_ASSISTANT_IDS=assistant-123,assistant-456
WORKLIN_CONCURRENT_RUNTIME_USER_IDS=user-123,user-456
```

`internal` and `canary` require a matching assistant or user allowlist entry.
`new_assistants` assigns every newly created runtime stack to the concurrent
service. Existing runtime-stack rows are never converted by changing these
variables. Migration between providers requires a separate fenced data
migration.

An eligible stack is created immediately with:

```json
{
  "provider": "concurrent_service",
  "status": "active",
  "service_ref": "concurrent-runtime",
  "workspace_volume_ref": null
}
```

Disabling placement stops new assignments. It does not invalidate assistants
already stored on the concurrent tier; draining or migrating those assistants
is an explicit operation.

## Service Configuration

Deploy the combined runtime image with:

```text
WORKLIN_RUNTIME_MODE=concurrent_service
RUNTIME_ASSISTANT_SCOPE_MODE=tenant_context
CONCURRENT_RUNTIME_DATABASE_URL=<application PostgreSQL URL>
CONCURRENT_RUNTIME_MIGRATION_DATABASE_URL=<optional migration PostgreSQL URL>
ACTOR_TOKEN_SIGNING_KEY=<shared 64-hex control-plane signing key>
CONCURRENT_RUNTIME_MANAGED_PROVIDER=<catalog provider id>
CONCURRENT_RUNTIME_MANAGED_MODEL=<optional model id; defaults to provider default>
<PROVIDER_API_KEY_ENV>=<company-owned managed inference key>
```

`WORKLIN_PLATFORM_ASSISTANT_ID` must be unset. The entrypoint starts the
gateway, CES, and concurrent HTTP kernel, and does not start the
single-tenant assistant process.

Optional tuning variables:

```text
CONCURRENT_RUNTIME_DATABASE_MAX_CONNECTIONS=20
CONCURRENT_RUNTIME_MAX_CONCURRENT_TURNS=32
CONCURRENT_RUNTIME_MAX_CONCURRENT_TURNS_PER_TENANT=2
CONCURRENT_RUNTIME_LEASE_DURATION_MS=600000
CONCURRENT_RUNTIME_EVENT_POLL_INTERVAL_MS=250
CONCURRENT_RUNTIME_PORT=3001
CONCURRENT_RUNTIME_HOST=0.0.0.0
```

Database URLs and signing keys are secrets. Keep them in the deployment secret
manager and never place them in a workspace, browser variable, run record, or
log.

## Release Gates

The code path is suitable for local and non-production canaries. Production
traffic remains gated until all of the following pass against managed
infrastructure:

1. PostgreSQL integration tests prove RLS isolation and connection-pool claim
   reset with separate migration and application roles.
2. Interleaved multi-tenant, cancellation, reconnect, replica-crash, and load
   tests find no cross-tenant rows or events.
3. At least 50 simultaneous turns meet the agreed latency, queue, memory,
   database-pool, and provider-rate SLOs.
4. Backup, restore, deletion, kill-switch, drain, and rollback drills pass.
5. Security review approves the token, RLS, logging, and shared-gateway
   boundaries.
6. Each additional capability receives its own concurrent-safety review before
   entering the allowlist.

Dedicated and leased pooled runtimes remain the fallback for unsupported
capabilities.
