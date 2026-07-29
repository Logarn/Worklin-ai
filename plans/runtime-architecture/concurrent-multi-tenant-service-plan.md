# Concurrent Multi-Tenant Assistant Service Plan

## Objective

Replace infrastructure-per-assistant onboarding with a shared execution
service in which each replica safely processes work for multiple
organizations, assistants, users, and conversations at the same time.

Creating an eligible assistant creates logical tenant state, not a Railway
service and volume. An accepted request can run on any healthy replica, while
durable state lives in tenant-aware shared stores.

This is true concurrency, not the existing pooled-worker design that leases
an entire worker to one tenant at a time. It also is not implemented by
changing a global assistant ID, environment variable, working directory, or
database connection. Every operation receives an immutable, authenticated
tenant execution context, and every stateful dependency enforces it.

The first production scope is bounded interactive chat and an explicitly
audited set of memory and workspace operations. Capabilities that depend on
long-lived local processes, host access, unbounded streams, or unconverted
process-global state remain on dedicated runtimes until they are
concurrent-safe. The concurrent service can therefore become the shared tier
in the hybrid architecture without requiring unsafe feature parity on day
one.

This is a multi-PR program. Track it with a parent issue and phase-specific
sub-issues. Each PR must be independently deployable, backward compatible,
and reversible.

## Methodology From `.codex/AGENTS.md`

`.codex/AGENTS.md` is not present. This plan follows the root `AGENTS.md` and
the applicable instructions under `assistant/`, `gateway/`, `apps/`,
`packages/`, `credential-executor/`, and `control-plane/`.

The baseline review covered:

- production topology and provisioning in `deploy/production/README.md`;
- the single-tenant-at-a-time worker design in
  `docs/pooled-runtime-workers.md`;
- identity and path derivation in
  `assistant/src/runtime/assistant-scope.ts` and
  `assistant/src/util/platform.ts`;
- SQLite initialization and migrations under `assistant/src/memory/`;
- the process-level event hub in
  `assistant/src/runtime/assistant-event-hub.ts`;
- gateway database and security ownership under `gateway/src/`;
- credential executor path and configuration ownership;
- LLM routing through
  `assistant/src/providers/provider-send-message.ts`;
- control-plane admission, routing, worker, checkpoint, and cutover modules;
- web onboarding, lifecycle, chat, operational status, and event streaming.

The companion `vellum-assistant-platform` repository is not available in this
workspace. Before implementation, review it for authentication claims, proxy
contracts, assistant payload compatibility, event streaming, generated
clients, and deployment configuration.

Implementation expectations:

- keep public HTTP and webhook ingress at the gateway/control-plane edge;
- preserve `getConfiguredProvider(callSite)` as the LLM entry point;
- preserve interfaces through additive, versioned changes;
- add idempotent, append-only migrations for persisted format changes;
- keep trust rules gateway-owned and credentials CES-owned;
- keep secrets out of workspaces, object metadata, queues, and logs;
- pin dependencies exactly and verify MIT-compatible licenses;
- update architecture and production docs as behavior ships;
- run scoped tests and package typechecks, never an unscoped test suite.

## Baseline Findings

### The current runtime is structurally single-tenant

The assistant process is more than a shared model endpoint with a different
chat thread:

- internal assistant identity is deliberately represented as `self`;
- workspace, data, sandbox, and config paths come from process-level values;
- assistant memory is opened as workspace-scoped SQLite state;
- migrations remove the assistant ID dimension from several tables;
- the assistant event hub is a process singleton;
- gateway security and database state are process-scoped;
- credentials and local services use process-level paths and environment;
- lifecycle, schedules, tools, local Qdrant, and files assume one owner.

Those choices fit one container and volume per assistant. They make concurrent
tenant switching unsafe: two asynchronous turns can interleave after any
`await`, so changing a global ID, current directory, environment value,
singleton connection, or workspace pointer for one request can redirect
another tenant's read or write.

### Model execution is already shared upstream

The LLM inference engine is generally provider-hosted and shared. The
per-assistant Railway service supplies the stateful agent runtime: memory,
files, tools, credentials, events, schedules, and gateway policy. Removing
per-assistant services therefore requires externalizing or explicitly scoping
that state; it does not require a new model instance per user.

### This is primarily a data-boundary refactor

The defining requirement is complete tenant scoping across:

- authentication and authorization;
- relational records and transactions;
- workspace files and artifacts;
- vector-memory reads and writes;
- caches, locks, queues, and idempotency;
- credentials and trust decisions;
- events, cancellations, approvals, and streaming;
- provider configuration and usage accounting;
- tool sandboxes and temporary files;
- metrics, traces, and logs.

Any missed scope is a potential cross-tenant disclosure or mutation. The
concurrent path must be a constrained execution kernel, not the current
process launched with different environment values.

### Existing pooled work remains useful

The pooled-worker implementation already provides capability admission,
route policy, lease fencing, checkpoint export/restore, sanitation,
quarantine, health concepts, cutover primitives, and canary tests. Those
concepts can inform admission, migration, and fallback.

Checkpoint restore is not the steady-state storage model for this service.
Restoring whole tenant workspaces into one shared process would recreate the
global-state problem.

## Scope

### In scope

- A runtime mode where one replica serves multiple tenants concurrently.
- Explicit `TenantExecutionContext` propagation and authorization.
- Shared relational, object, vector, queue, event, and credential adapters.
- Stateless interactive execution replicas.
- Logical assistant creation without a Railway service or volume.
- Bounded chat, conversation history, supported memory, supported workspace
  operations, cancellation, approvals, and event streaming.
- Per-conversation ordering and idempotent acceptance.
- Per-tenant quotas, fair scheduling, and usage attribution.
- Additive API and operational-status fields.
- New-account canary admission, kill switches, and dedicated fallback.
- A versioned path for later migration of existing assistants.
- Cross-tenant security, fault-injection, load, and recovery tests.

### Out of scope for the first release

- Sharing the existing per-workspace SQLite databases across replicas.
- Switching tenants through `process.env`, `cwd`, or process-global paths.
- Multiple tenants in one unsandboxed shell or shared mutable filesystem.
- Meet bots, voice/telephony, terminal or ACP sessions, host-computer access,
  indefinite processes, and unbounded background jobs.
- Full parity with every dedicated-runtime tool or integration.
- Automatic migration of existing dedicated assistants.
- Automatic mid-request failover between runtime providers.
- Per-tenant namespaces or per-request Railway services.
- A new durable sync ledger unrelated to the `sync_changed` contract.

## Desired Behavior

### New assistant creation

1. The control plane authenticates the user and resolves organization
   membership.
2. It creates the assistant and initial tenant configuration in one
   transaction.
3. It assigns `runtime_provider = "concurrent_service"` only when the cohort
   and requested capabilities are eligible.
4. It returns a usable assistant after shared-store initialization; it does
   not create a Railway service, deployment, or volume.
5. The web app can start a conversation immediately when logical state is
   ready.

### Request execution

1. The public edge validates the session and assistant authorization.
2. It mints a short-lived, audience-bound token with immutable tenant claims.
3. The gateway creates `TenantExecutionContext` and rejects disagreement
   between route, token, persisted ownership, and body.
4. An acceptance transaction writes an idempotency record, user message, run,
   and outbox event before returning `202 Accepted`.
5. A fair scheduler dispatches the run to any healthy replica.
6. The replica receives tenant-scoped repositories, configuration, event
   publisher, credential broker, and sandbox factory.
7. Work for one conversation is serialized. Different conversations run
   concurrently, including those belonging to the same assistant.
8. Events use shared infrastructure and can be consumed through any replica.
9. Completion updates durable state and usage accounting idempotently.

### Failure and retry

- Repeating an accepted request with the same idempotency key returns the
  existing run rather than adding a duplicate message.
- A worker crash leaves durable work available after its lease expires.
- Retry uses persisted context and input, never mutable process-global state.
- Side-effecting tools require idempotency/fencing; otherwise they are
  excluded from the first release.
- Capacity exhaustion returns bounded retry guidance and does not silently
  provision or reroute a dedicated runtime.
- Routing is fixed before acceptance. Promotion applies to a later request
  after an explicit cutover.

### Noisy-neighbor behavior

- Admission enforces organization and assistant concurrency limits.
- Fair queuing prevents one tenant from consuming the worker pool.
- Provider, database, vector, object, and credential usage is tenant-attributed.
- A throttled tenant cannot weaken isolation or block all other tenants.

## Key Changes

### Immutable tenant execution context

Introduce a shared, versioned contract in an appropriate `packages/` module:

```ts
interface TenantExecutionContext {
  organizationId: string;
  assistantId: string;
  userId: string;
  conversationId?: string;
  requestId: string;
  idempotencyKey?: string;
  authzVersion: number;
  configVersion: number;
  runtimeGeneration: number;
}
```

Context is required at service and repository boundaries. Node
`AsyncLocalStorage` may mirror it for logs and traces, but must never be the
only source used to authorize a query, choose a path, decrypt a credential,
or scope a tool.

### Concurrent-safe module boundary

Create a narrow execution kernel with injected dependencies. Guard tests
prevent this path from using:

- path helpers based on process-global environment;
- process-global assistant or gateway database connections;
- internal `self` as a tenant key;
- process-global event subscribers;
- tenant-specific environment variables;
- a shared mutable current tenant;
- unsandboxed filesystem or shell adapters.

Legacy single-tenant code remains available for dedicated runtimes. Shared
logic moves to `packages/` only when it respects package boundaries and does
not import runtime state.

### Shared relational data plane

Use a managed PostgreSQL-compatible database for concurrent execution data.
Do not stretch per-workspace SQLite across replicas.

Initial logical tables include:

- `tenant_assistants`;
- `tenant_conversations`;
- `tenant_messages`;
- `tenant_runs`;
- `tenant_events`;
- `tenant_idempotency_keys`;
- `tenant_config_versions`;
- `tenant_workspace_manifests`;
- `tenant_workspace_objects`;
- `tenant_usage`;
- `outbox_events`.

Every tenant row includes `organization_id` and `assistant_id`. Child records
use compound ownership keys. Unique constraints include tenant identity.
Row-level security provides defense in depth, with separate migration,
application, and operational roles.

Repositories reject missing context before SQL and include explicit tenant
predicates even with RLS. Transactions set locally scoped database claims;
pooled connections must never retain tenant session state.

### Workspace and artifact storage

Represent workspace state as versioned manifests plus immutable objects:

`orgs/{organizationId}/assistants/{assistantId}/objects/{digest}`

Manifests contain normalized relative paths, object digests, size, media
type, and version, but never credentials. Writes upload immutable objects and
atomically advance a manifest with optimistic concurrency or an
assistant-scoped lock.

Execution receives exact, short-lived object access or a tenant-aware adapter.
Clients receive signed URLs only after a fresh authorization check. Prefix
alone is not an authorization boundary.

### Vector memory

Use a shared vector backend only through a tenant-aware adapter. Every search,
scroll, update, and delete includes organization and assistant filters.
Collection-per-tenant and shared-collection-with-filter designs must be
benchmarked before selection.

Guard tests fail when an operation omits tenant filters. Vector document IDs
and cache keys include tenant identity. Local managed Qdrant remains
dedicated-runtime behavior.

### Queue, locks, and events

Use Redis/Valkey or another supported coordination service for bounded
leases, fair admission, cancellation, and live fanout. It is not the source
of truth for messages or completed runs.

Use:

- a durable database outbox for accepted work and durable events;
- per-conversation serialization;
- assistant-scoped manifest locks for conflicting workspace writes;
- lease fencing tokens for run ownership;
- shared event transport so SSE can connect through any replica;
- bounded replay from durable `tenant_events`;
- `sync_changed` for persisted client cache invalidation.

### Tenant-aware provider configuration

Continue routing LLM calls through `getConfiguredProvider(callSite)`.
Refactor its dependencies behind a tenant-scoped resolver so effective
profile, provider credentials, limits, and usage tags come from the immutable
config version attached to the run.

Do not alter process-global profiles during a request or copy provider
secrets into run records. Fetch credentials through CES with a tenant- and
purpose-bound grant.

### Gateway, trust, and credentials

The gateway remains public ingress and owns tenant-aware trust. CES owns
credentials and returns narrowly scoped, short-lived access.

Internal tokens bind:

- organization, assistant, and user;
- audience and permitted operation;
- request/run ID and runtime generation;
- issue/expiry times and nonce;
- authorization/config versions where needed.

Reject replay, expiry, identity mismatch, and stale generations. Execution
and browsers never receive CES master keys or gateway security storage.

### Per-request sandboxing

Each tool invocation receives a new sandbox or a reusable tenant-bound
sandbox with a generation fence. A trusted broker derives host paths; user
IDs never become unchecked filesystem paths.

Enforce CPU, memory, wall-time, process, network, and disk limits. Sanitize
temporary data before reuse. Admit a tool only after reviewing its filesystem,
network, credential, cancellation, and side-effect behavior.

### Placement and capability policy

Maintain a versioned capability registry:

- `concurrent_safe`;
- `requires_dedicated`;
- `disabled`.

Placement uses requested capabilities, cohort, migration state, and kill
switches. Unknown capabilities fail closed. User-controlled route or tool
metadata cannot override placement.

## Implementation Plan

### Phase 0 - Freeze the safety contract

1. Inventory process-global state reachable from interactive chat.
2. Define tenant context, signed claims, generation, and capability classes.
3. Define the concurrent-safe import boundary and add guard coverage.
4. Record supported routes and tools in a deny-by-default registry.
5. Add architecture decisions for relational isolation, object storage,
   vector isolation, events/queueing, and sandboxing.
6. Review the companion platform before finalizing public contracts.

Rollback: documentation and inert contracts only.

### Phase 1 - Build the shared data plane

1. Provision non-production relational, object, vector, and coordination
   stores through infrastructure as code.
2. Add append-only migrations, RLS, compound ownership constraints, and
   least-privilege roles.
3. Implement tenant-required repositories and object manifests.
4. Implement outbox dispatch, idempotency, and run leases.
5. Implement vector adapters that cannot issue an unscoped operation.
6. Add backup, point-in-time recovery, retention, and restore drills.

Rollback: no production route uses the stores.

### Phase 2 - Extract the stateless execution kernel

1. Refactor the bounded conversation pipeline behind injected repositories.
2. Pass tenant context through message, memory, workspace, provider, event,
   cancellation, and usage paths.
3. Add per-conversation ordering and optimistic workspace concurrency.
4. Resolve provider config against the run's tenant/config version while
   preserving `getConfiguredProvider(callSite)`.
5. Add compile-time and runtime guards for forbidden globals.
6. Run the kernel with at least two simultaneous test tenants.

Rollback: the kernel has no production callers.

### Phase 3 - Add gateway, CES, and sandbox integration

1. Mint and validate versioned tenant-bound internal tokens.
2. Add tenant-aware trust and credential broker APIs.
3. Implement the sandbox broker and supported tool adapters.
4. Enforce quotas, timeouts, cancellation, and network policy.
5. Audit credential and privileged tool use without logging secrets.

Rollback: keep shared execution disabled.

### Phase 4 - Add durable dispatch and cross-replica events

1. Add the acceptance transaction and outbox.
2. Add fair scheduling, leases, fencing, retry, and dead-letter handling.
3. Publish live and durable events through shared infrastructure.
4. Make SSE reconnect, cancellation, and approvals work across replicas.
5. Fault-test every persistence boundary for duplicate messages or effects.

Rollback: stop consumers; accepted test work remains inspectable.

### Phase 5 - Integrate control plane and web app

1. Add the concurrent provider to placement and operational status.
2. Create logical assistants without Railway provisioning.
3. Preserve endpoints and add versioned fields.
4. Make onboarding usable after logical initialization.
5. Keep existing dedicated and pooled routing unchanged.
6. Regenerate clients from committed API sources.

Rollback: disable concurrent placement; existing records remain valid.

### Phase 6 - Prove isolation and capacity

1. Run cross-tenant relational, object, vector, cache, credential, event, and
   sandbox attack tests.
2. Run two-, ten-, and many-tenant tests with interleaved awaits, cancellation,
   retry, and crashes.
3. Sustain at least 50 in-flight turns per replica, then tune from measured
   CPU, memory, event-loop lag, provider limits, and database saturation.
4. Exercise restore, queue recovery, credential rotation, and dependency
   failures.
5. Complete security and threat-model sign-off.

Rollback: no user traffic is admitted.

### Phase 7 - Canary new accounts

1. Enable one internal organization and synthetic assistants.
2. Admit an explicit, low-volume new-account cohort.
3. Begin with bounded chat and read-only workspace operations.
4. Expand capabilities one at a time after security and SLO review.
5. Compare onboarding, latency, errors, cost, and parity with dedicated use.
6. Keep a global kill switch and cohort rollback.

Rollback: stop new placement. Drain or explicitly migrate existing canary
assistants; never switch only the routing field.

### Phase 8 - Make this the shared hybrid tier

1. Route eligible interactive assistants to the concurrent service by
   default.
2. Keep dedicated placement for capabilities not concurrent-safe.
3. Use fenced, versioned export/import for promotion to dedicated.
4. Expose placement reason and migration state to operations.
5. Remove per-assistant provisioning from eligible onboarding only after the
   concurrent SLO is sustained.

Rollback: close eligibility and retain dedicated provisioning.

### Phase 9 - Offer migration for existing assistants

1. Begin with opt-in internal migrations.
2. Export a quiesced, versioned assistant bundle with checksums.
3. Dry-run import and verify rows, objects, vectors, config, and credential
   references.
4. Fence the source, import, verify, record cutover, and change routing.
5. Keep the source recoverable for the rollback window.
6. Require exercised reverse migration before broad rollout.

Rollback: before target writes, route back to source. After writes, use the
explicit reverse export; never heuristically merge divergent state.

## Public Interfaces

### Existing public behavior

Keep assistant, conversation, message, cancellation, approval, file, and
event interfaces compatible wherever the supported feature is unchanged.
The public edge remains the only inbound HTTP boundary.

### Additive assistant fields

Add generated-schema fields such as:

```json
{
  "runtime_provider": "concurrent_service",
  "runtime_state": "ready",
  "runtime_capabilities": ["interactive_chat", "workspace_read"],
  "runtime_migration_state": null
}
```

Reconcile exact names with existing contracts and the companion platform.
Old clients must tolerate omission or unknown enum values using the
established compatibility strategy.

### Operational status

Separate logical initialization from infrastructure deployment. Recommended
internal phases:

- `creating_logical_state`;
- `ready`;
- `capacity_wait`;
- `migration_preparing`;
- `migration_verifying`;
- `migration_cutover`;
- `migration_failed`.

The UI should normally show ready, bounded retry, or actionable failure.
Internal architecture terms should not leak into general assistant copy.

### Internal execution contract

Define a versioned contract for runs, context claims, events, cancellation,
and results in `packages/`. The execution endpoint is private and accepts only
gateway/control-plane identities. It is not a public assistant-scoped route.

### Configuration

Add server-only configuration for:

- mode: `disabled`, `internal`, `canary`, `new_assistants`;
- relational, object, vector, and queue/event services;
- CES and trust-service audiences;
- concurrency, quota, lease, retry, and timeout limits;
- global and organization kill switches.

Secrets belong in the secret manager/CES or service security storage, not
browser variables, committed config, workspace files, or assistant rows.

## Data Boundary And Security

### Defense in depth

- Mint authenticated context at the trusted edge.
- Require route, token, body, ownership, and generation to agree.
- Require explicit context in service APIs and repositories.
- Protect SQL with predicates, compound keys, and RLS.
- Reset transaction-local connection claims automatically.
- Check ownership before exact, short-lived object access.
- Make unfiltered vector operations impossible through the adapter.
- Include tenant identity in cache, lock, queue, idempotency, and event keys.
- Retrieve credentials from CES with purpose-bound grants.
- Keep trust decisions gateway-owned.
- Isolate, quota, and sanitize sandboxes.
- Log opaque IDs and redact prompts, tokens, secrets, signed URLs, and private
  file contents by default.
- Give operator tooling separate audited roles.

### Authorization changes

Short-lived tokens carry an authorization version. Sensitive operations
perform a fresh authorization check. Revocation propagates through shared
invalidation rather than one replica's memory.

### Data residency and deletion

Track residency, retention, export, and deletion per organization. Deletion
is a durable workflow covering rows, objects, vectors, events, queued work,
credentials, policy-governed backups, and caches. Tombstones prevent delayed
work from recreating deleted state.

### Threat model

Review at minimum:

- forged, replayed, expired, or cross-assistant tokens;
- confused-deputy calls among gateway, execution, storage, and CES;
- missing SQL/RLS/vector/object predicates;
- cache collisions and pooled-connection leakage;
- path traversal, symlink, archive, and sandbox escape;
- event/cancellation/approval misrouting;
- provider-config or prompt-cache contamination;
- stale leases and duplicate external side effects;
- noisy-neighbor exhaustion;
- operator and backup access;
- migration tampering and rollback divergence.

## Test Plan

### Unit and guard tests

- Context schema and signed-claim validation.
- Repository construction fails without tenant context.
- Concurrent-safe modules cannot import forbidden global modules.
- Query builders include tenant keys.
- Object paths reject traversal and ownership mismatch.
- Vector adapters reject missing filters.
- Cache, lock, queue, event, and idempotency keys include tenant identity.
- Provider config uses the run's immutable config version.
- Capability admission fails closed.

### Database and storage integration

- Cross-tenant reads and writes fail under RLS.
- Compound foreign keys reject another tenant's child IDs.
- Pooled connections do not retain prior claims.
- Transactions and outbox survive boundary failures.
- Concurrent manifest writes detect conflicts without data loss.
- Signed object access cannot be reused for another tenant or object.
- Vector search/update/delete cannot cross tenant scope.
- Backup restore preserves ownership and audits.

### Runtime concurrency

- Two tenants interleave every async stage without leakage.
- Ten tenants stream through different replicas.
- Same-conversation turns serialize; different conversations run in parallel.
- Cancellation and approvals reach the right run after reassignment.
- Retry after crash does not duplicate messages or supported side effects.
- One tenant's quota exhaustion does not block others.
- Credential rotation and revocation apply across replicas.

### Security

- Token forgery, replay, audience mismatch, stale generation, and route/body
  mismatch.
- SQL/RLS bypass using guessed child IDs.
- Object prefix, signed URL, vector filter, and cache poisoning.
- Traversal, symlink races, archive extraction, process escape, sandbox reuse.
- Cross-tenant subscriptions, cancellations, and approvals.
- Log and trace scans for secrets and private content.
- Migration signature, checksum, replay, and downgrade attacks.

### Web and contracts

- A canary creates an assistant without infrastructure provisioning and sends
  the first message.
- Existing dedicated assistants retain behavior.
- Old clients remain compatible with additive fields.
- Setup does not poll forever and reports bounded capacity or failure.
- SSE reconnect receives only the tenant's missed events.
- Generated clients match committed schemas.

### Performance and resilience

- Sustain at least 50 in-flight turns per replica initially.
- Measure queue time, service overhead excluding provider latency, event-loop
  lag, memory per run, CPU, database pool, object/vector latency, and provider
  throttling.
- Initial target: p95 platform overhead below 250 ms for an accepted simple
  chat turn, excluding LLM and tool execution; revise from recorded data.
- Prove graceful drain, crash recovery, queue/database failover, dependency
  timeouts, and kill-switch behavior.
- Record per-tenant cost and confirm fair scheduling under overload.

Run only scoped tests for changed modules, then typecheck affected packages.
Expected coverage includes `assistant`, `gateway`, `credential-executor`,
`control-plane`, shared contracts, and `apps/web`. Never run unscoped
`bun test`.

## Documentation Plan

- Update `ARCHITECTURE.md` with service and shared-store boundaries.
- Add production topology and failure modes under `deploy/production/`.
- Update or supersede `docs/pooled-runtime-workers.md` with a comparison of
  leased workers and concurrent replicas.
- Document context, capability classes, RLS/repositories, object manifests,
  vector filters, and event semantics.
- Document backup/restore, credential rotation, deletion, incident
  containment, rollback, and migration runbooks.
- Update onboarding and operational-status documentation.
- Update impacted `AGENTS.md` files only for new mandatory patterns.
- Document companion-platform changes in the same rollout phase.

## Rollout Plan

### Controls

- Global concurrent-runtime kill switch.
- Environment mode gate.
- Organization and assistant cohort allowlists.
- Per-capability gates.
- Separate gates for creation, request admission, workspace writes, tools,
  migration, and deletion.

### Order

1. Local synthetic tenants.
2. CI security and concurrency suites.
3. Non-production shared infrastructure.
4. Internal organization with synthetic, then normal data.
5. Small new-account canary with chat only.
6. Gradual cohort and capability expansion.
7. Default shared placement for eligible new assistants.
8. Opt-in existing-assistant migrations.

### Promotion gates

Advance only when:

- cross-tenant tests find zero unauthorized reads, writes, or events;
- security review closes critical and high issues;
- backup and restore drills succeed;
- latency, error rate, queue time, and cost meet agreed SLOs;
- kill-switch and drain drills succeed;
- existing dedicated behavior has no regression;
- companion-platform and client compatibility is verified.

### Rollback

Closing admission must be immediate and preserve shared state. Accepted runs
drain or safely retry. New placement returns to a supported provider. Moving
an assistant between shared and dedicated storage requires the fenced
migration; operators must never change only its routing field.

## Risks And Guardrails

| Risk | Guardrail |
|---|---|
| Cross-tenant disclosure | Explicit context, compound keys, RLS, tenant-required repositories, attack tests |
| Async context leakage | No mutable current tenant; explicit parameters; async-local context for observability only |
| Residual singletons | Concurrent-safe import boundary and guard tests |
| Connection-pool leakage | Transaction-local claims, automatic reset, integration tests |
| Cache/vector/object contamination | Tenant-aware adapters and fail-closed key/filter construction |
| Credential/trust confusion | Gateway/CES ownership and tenant-bound short-lived grants |
| Tool/filesystem escape | Per-request sandbox, deny-by-default tools, quotas, review |
| Duplicate effects | Idempotency, outbox, leases, fencing, tool-specific controls |
| Lost or misrouted events | Shared fanout, durable events, ownership checks |
| Conversation races | Per-conversation ordering and optimistic versions |
| Noisy neighbor | Fair queueing and tenant resource quotas |
| Provider throttling | Attribution, global limits, bounded retry, backpressure |
| Shared-store outage | Timeouts, durable retry, restore, kill switch |
| Migration divergence | Quiesce, signed bundle, checksum, verification, fencing |
| Scope expansion | Bounded capability registry and phase gates |
| Cost growth | Tenant usage accounting and promotion gates |

## Acceptance Criteria

- One production-like replica safely runs simultaneous work for at least ten
  tenants and is load-tested at 50 in-flight turns without cross-tenant data,
  events, credentials, files, vector results, or cache entries.
- Eligible assistant creation performs no Railway service, deployment, or
  volume creation and becomes chat-ready after logical initialization.
- Every concurrent execution path receives immutable tenant context.
- No concurrent-safe module depends on process-global tenant identity, paths,
  current directory, SQLite singleton, or event singleton.
- Relational isolation uses predicates, compound ownership keys, and RLS.
- Object, vector, queue, cache, event, CES, trust, and sandbox adapters enforce
  tenant identity.
- Same-conversation turns are ordered while different conversations execute
  concurrently.
- Acceptance, crash retry, cancellation, approval, and SSE reconnect are
  idempotent and work across replicas.
- Supported behavior passes web and contract regressions; unsupported
  capabilities fail closed to documented placement.
- Existing dedicated and leased-pooled assistants continue to work.
- Kill switch, drain, backup/restore, and canary rollback drills pass.
- Architecture, security, operations, migration, and companion-platform docs
  are complete.

## Future Improvements

- Expand the concurrent-safe tool and integration registry.
- Run scheduled work as tenant-context jobs after interactive isolation.
- Add regional placement and data-residency-aware routing.
- Evaluate dedicated schemas or collections for higher-isolation tiers.
- Autoscale on queue time, active runs, provider limits, and memory.
- Replace broad manifest locks with typed workspace operations.
- Recommend placement from measured capability and usage requirements while
  keeping security policy deterministic.
- Promote high-cost tenants to dedicated runtimes for economic reasons when
  beneficial.

## Assumptions

- The first release can support fewer capabilities than dedicated runtime.
- Production can provide managed relational, object, vector, and coordination
  services with backup and observability.
- Existing assistants remain on their runtime until explicit migration.
- Public and companion platforms can pass additive runtime fields and
  tenant-bound internal claims.
- CES can broker credentials without copying secrets into execution state.
- Dedicated runtime remains available for unsupported capabilities and
  rollout fallback.
- Security review is a release gate.
- Throughput and latency targets will be revised from recorded load tests
  before broad rollout.
