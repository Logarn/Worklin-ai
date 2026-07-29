# Hybrid Pooled And Dedicated Runtime Architecture Plan

## Objective

Replace “one always-on Railway service per assistant” as the default with a
hybrid placement model:

- new assistants that only need bounded interactive work use a warm pooled
  worker fleet;
- assistants that need long-lived, credential-heavy, streaming, or
  process-global capabilities use a dedicated runtime;
- an assistant can be promoted from pooled to dedicated through a fenced,
  auditable state cutover;
- existing dedicated assistants remain dedicated unless a separate migration
  is explicitly approved.

The intended user outcome is that ordinary onboarding creates logical tenant
state and becomes usable in seconds, without building a Railway service.
Dedicated provisioning remains available for the features that require its
stronger lifetime and isolation boundary.

This is a multi-PR effort. Track it with one parent issue and phase-specific
sub-issues; each PR must remain a distinct, deployable, backward-compatible
unit.

## Methodology From `.codex/AGENTS.md`

`.codex/AGENTS.md` is not present. This plan follows the root `AGENTS.md`,
`apps/AGENTS.md`, `apps/web/AGENTS.md`, `assistant/AGENTS.md`,
`assistant/src/runtime/AGENTS.md`, and `gateway/AGENTS.md`.

The baseline review covered:

- `ARCHITECTURE.md`;
- `deploy/production/README.md`;
- `docs/pooled-runtime-workers.md`;
- `railway.json`, `runtime/Dockerfile`, and `runtime/entrypoint.sh`;
- runtime-stack creation, routing, provisioning, admission, operations,
  worker catalog, leases, request routing, state checkpoints, health probes,
  coordinator ownership, model-key vault, and cutover modules under
  `control-plane/src/`;
- the assistant lifecycle, operational-status polling, pooled-provider
  configuration, onboarding handoff, and setup UI under `apps/web/src/`;
- the pooled-worker, two-tenant canary, runtime-cutover, route-policy,
  provisioning, and lifecycle tests.

The companion `vellum-assistant-platform` repository is not available in the
current workspace. Before implementation, review that repository for
compatibility with changed assistant payloads, operational-status contracts,
deployment configuration, and any platform proxy allowlists.

Implementation expectations:

- preserve all existing dedicated routing;
- keep GET routes side-effect-free;
- route browser-facing operations through the control plane/public edge and
  gateway boundary rather than exposing the assistant process;
- keep credentials in CES or the pooled control-plane vault, never in tenant
  workspace snapshots;
- update architecture and production docs as phases become shipped behavior;
- run only scoped tests plus package typechecks.

## Baseline Findings

### Shipped dedicated architecture

Production runs one public control-plane service and one private combined
runtime service per customer assistant. Each private runtime starts the
gateway, assistant, and credential executor against a dedicated persistent
volume. The provisioner creates a GitHub-backed Railway service, attaches a
volume, deploys it, waits for Railway success, probes `/readyz`, and then
records the private `railway.internal` URL.

This gives a strong container and volume boundary, but makes assistant
creation synonymous with infrastructure creation.

### Shipped pooled-worker foundation

The repository already contains substantially more than a pooled-worker
prototype:

- exact route allowlisting with fail-closed rejection;
- one active tenant lease per worker;
- monotonic lease generations and generation-bound actor/service tokens;
- database-backed coordinator ownership and restart fencing;
- signed object-storage restore/export with checksum verification;
- workspace quotas and storage-operation guards;
- an encrypted pooled model-key vault;
- request-handle tracking, drain, sanitization, revocation, quarantine, and
  operator recovery;
- startup health gates and worker catalog drift checks;
- a two-tenant sequential isolation canary.

The pool is disabled unless all startup gates are configured and healthy.
When enabled, only resource-free assistant placeholder stacks can select it.
Existing active dedicated stacks continue routing to their dedicated gateway.

### Gaps between the foundation and a productized hybrid

1. Production has no catalogued workers, state bucket, active pooled model-key
   vault, or enabled pool gates.
2. `WORKLIN_POOLED_RUNTIME_CANARY_ASSISTANT_IDS` and
   `WORKLIN_POOLED_RUNTIME_CANARY_USER_EMAIL_HASHES` are parsed but are not
   applied to routing. Enabling the pool would therefore make every otherwise
   eligible resource-free assistant pooled.
3. `runtime-cutovers.ts` provides a durable, tested
   export/restore/verify/canary/commit/rollback state machine, but it is not
   registered or orchestrated by `control-plane/src/index.ts`.
4. The assistant payload reports a pooled assistant as active, but it does not
   expose desired placement, effective placement, a promotion state, or the
   reason a dedicated runtime is required.
5. `operationalStatusPayload()` always returns `active_operation: null`.
6. Pooled v1 does not support indefinite assistant SSE, terminal/ACP,
   background schedules and execution, direct credential operations,
   ChatGPT-subscription authentication, voice/telephony, worker-local
   integrations, or other process-global route families.
7. A pooled request that reaches an unsupported route fails closed, but there
   is no product workflow that promotes the assistant and resumes the user’s
   intended action.
8. Coordinator request capabilities and abort controllers are process-local,
   so the shipped pool requires exactly one active control-plane replica.

### Deployment facts

Railway supports Docker-image service sources, and skips the build phase when
the source is already an image. Railway also provides private
`railway.internal` service networking. Public Docker images are supported on
the current deployment model; private registry images require checking plan
eligibility. References:

- <https://docs.railway.com/deployments/reference>
- <https://docs.railway.com/services>
- <https://docs.railway.com/private-networking>

## Scope

### In scope

- A deterministic, server-owned placement policy for pooled versus dedicated.
- A one-worker, concurrency-one production canary followed by bounded fleet
  expansion.
- Pooled placement for new, resource-free, BYOK-compatible assistants using
  only the exact reviewed pooled route surface.
- Persistent placement intent and an auditable placement reason.
- A bounded wait response when all workers are busy.
- Promotion from pooled to dedicated with checkpoint verification, health
  gates, rollback, and no concurrent unfenced serving.
- UI status for pooled readiness, capacity waiting, promotion, dedicated
  provisioning, and terminal failures.
- Production metrics, operator recovery, capacity alerts, and runbooks.
- Backward compatibility for active dedicated assistants and existing clients.

### Out of scope

- Multiple simultaneous tenants inside one worker process.
- More than one tenant lease per worker.
- Dedicated-to-pooled migration of existing customers.
- Automatic demotion from dedicated to pooled.
- Pooled terminal/ACP, background schedules, voice, telephony, OAuth,
  integration credentials, ChatGPT-subscription authentication, or other
  currently denied route families.
- Multi-replica control-plane coordination.
- Replacing CES or weakening gateway-owned trust/security boundaries.
- Silent fallback from a failed or quarantined pool into an unbudgeted
  dedicated service.

## Desired Behavior

### Placement classes

| Class | Meaning | Initial routing |
|---|---|---|
| `interactive` | Reviewed bounded chat, workspace, memory, document, and app-data operations with supported provider BYOK | Pooled when the pool and cohort gates are healthy |
| `full` | Any dedicated-only capability, provider mode, long-lived connection, background execution, or process-global state | Dedicated |

Placement is a mechanical security and capability decision, not a text
classifier. A code-owned capability registry maps each runtime capability to
its minimum class. The browser cannot request a worker ID, lease generation,
or a weaker class than the server requires.

### New assistant flow

1. Consent and hatch create or resolve the assistant identity.
2. The explicit provisioning/prepare POST from the dedicated-runtime
   reliability plan asks the placement resolver to prepare the assistant.
3. Existing active dedicated assistants remain dedicated.
4. A resource-free assistant in the canary cohort becomes pooled only if all
   startup, ownership, vault, state-transport, quota, admission, operations,
   catalog, and health gates are green.
5. A pooled assistant is reported as active without holding a worker between
   requests.
6. The first bounded runtime request acquires a worker lease, restores the
   checkpoint or prepares an empty tenant, serves the request, exports and
   verifies state, sanitizes, revokes authority, and releases the worker.
7. If capacity is temporarily exhausted, return a retryable structured
   response with `retry_after_ms`; do not provision a dedicated runtime merely
   because the pool is busy.

### Dedicated requirement flow

When a user enables or invokes a feature whose registered minimum class is
`full`:

1. Persist the stronger requirement and create one idempotent promotion
   operation.
2. Fence new pooled work for that assistant and wait for active request
   handles to drain.
3. Hold or reacquire one exact generation-bound worker assignment as the
   cutover source.
4. Export and verify a source checkpoint.
5. Provision a dedicated target without allowing it to accept tenant traffic.
6. Restore the checkpoint into the target, verify the restored checksum and
   tenant identity, and pass target health checks.
7. Use `runtime-cutovers.ts` to record verification, canary, commit, and a
   cooling period.
8. Change routing only at the committed cutover.
9. Release and sanitize the source worker after source-retirement
   authorization.

If any pre-commit step fails, routing stays on the pooled source when that
source remains healthy. Otherwise, the assistant becomes explicitly
unavailable with durable recovery information; it must never route to two
unfenced runtimes.

### Placement decision table

| Condition | Result |
|---|---|
| Active dedicated stack with a private gateway | Dedicated |
| Dedicated resources or provisioning lease already exist | Dedicated transition; never pooled implicitly |
| Required class is `full` | Prepare/promote to dedicated |
| Pool gates unhealthy or coordinator ownership lost | No new pooled allocation; fail closed |
| Resource-free `interactive` assistant outside canary during beta | Preserve current dedicated behavior |
| Resource-free `interactive` assistant inside canary with healthy pool | Pooled |
| Pooled worker capacity temporarily exhausted | Retryable capacity wait |
| Worker restore/export/sanitize/revoke ambiguity | Quarantine exact worker and generation |

## Key Changes

### Placement policy and persistence

- Add `control-plane/src/runtime-placement.ts`.
- Add an append-only `assistant_runtime_placements` control-plane table with:
  `assistant_id`, `org_id`, `required_class`, `selected_class`,
  `reason_code`, `version`, `created_at`, and `updated_at`.
- Keep effective routing derived from dedicated stack state, worker leases,
  coordinator state, and active cutovers; do not duplicate lease truth in the
  placement table.
- Add a code-static capability registry and tests proving every
  dedicated-only route rejection maps to a `full` requirement.
- Apply the existing assistant-ID/user-email-hash canary configuration before
  any global pooled admission. Remove those fields only after a replacement
  cohort mechanism is shipped and documented.

### Control-plane orchestration

- Register `ensureRuntimeCutoverSchema()` at startup.
- Add a `RuntimePlacementOrchestrator` that composes existing worker
  lifecycle, checkpoint, cutover, and Railway provisioning primitives.
- Add a per-assistant serialized operation queue and idempotency keys.
- Consult active placement transitions before the ordinary
  `selectRuntimeWorkerRoutingPolicy()` result so pooled source routing remains
  fenced during target preparation.
- Abort new pooled admissions immediately if coordinator ownership is lost.

### Dedicated target preparation

- Reuse the dedicated plan’s idempotent prepare operation and immutable image
  source.
- Add a target bootstrap state that can pass infrastructure startup checks
  while remaining unavailable to tenant routing until checkpoint restore and
  identity verification complete.
- Keep the target on a new empty volume; never attach the pooled worker’s live
  workspace.

### Public/API contracts

- Extend assistant responses with an optional `runtime_placement` object:
  `required_class`, `selected_class`, `effective_class`, and `reason_code`.
- Populate the existing operational-status `active_operation` during
  placement or promotion, including `operation_id`, `phase`, timestamps, and
  a non-sensitive target summary.
- Return structured codes for `pooled_capacity_wait`,
  `dedicated_runtime_required`, `runtime_promotion_in_progress`, and
  `runtime_promotion_failed`.
- Preserve current fields and semantics for clients that ignore the additions.
- Do not expose worker IDs, lease tokens, object paths, checksums, provider
  keys, or internal recovery tokens to browsers.

### Web app

- Keep lifecycle state in the existing Zustand lifecycle store and server
  state in TanStack Query.
- Reuse `useAssistantOperationalStatus()` for transitions; do not create a
  second provisioning poller.
- Render pooled capacity wait and promotion phases in the setup/operation UI.
- Disable or annotate dedicated-only features while promotion is pending.
- When a user explicitly enables a full-runtime feature, call the owning
  feature mutation; the server raises the runtime requirement and returns the
  promotion operation. Do not let the client choose placement independently.
- Preserve web, Capacitor/iOS, and Electron behavior.

### Deployment and operations

- Publish the combined runtime image by immutable digest.
- Create one new private Railway worker service in `pooled_worker` mode.
- Create persistent control-plane storage, a tenant-state object bucket, and a
  stable pooled model-key vault key.
- Give object-store credentials only to the control plane. Workers receive
  signed, exact tenant-generation URLs.
- Keep worker gateways private on `railway.internal`.
- Add structured metrics for placement decisions, queue time, lease time,
  restore/export/sanitize duration, capacity exhaustion, promotion phase,
  quarantine, and state-object size.

## Implementation Plan

### Phase 0 — Stabilize lifecycle and operational status

Before pooled admission, make lifecycle preparation explicit and idempotent,
persist long-running operations, preserve compatible operational-status
phases, and ensure the frontend reports bounded progress or actionable
failure. The hybrid must not depend on the existing lazy-request deadlock.

Rollback: retain the current dedicated routing and retry endpoint.

### Phase 1 — Persist placement and enforce a closed cohort

1. Add the placement table and idempotent schema initializer.
2. Implement the capability registry and placement resolver.
3. Wire the existing canary lists into placement eligibility.
4. Keep the production default dedicated while the pool is disabled.
5. Add assistant/API payload fields and generated-client updates.
6. Add unit tests for every decision-table row.

Rollback: disable pooled startup gates; placement rows remain inert and
dedicated routing is unchanged.

### Phase 2 — Deploy one inert worker

1. Build and publish the pinned runtime image.
2. Provision object storage and control-plane-only credentials.
3. Configure the encrypted pooled model-key vault.
4. Deploy one new worker with max concurrency `1`.
5. Register the exact catalog and private gateway origin.
6. Run startup registration and health probes with external user admission
   still disabled.

Rollback: remove the worker from the candidate list only after confirming it
has no active or quarantined lease. Leave durable checkpoints intact.

### Phase 3 — Security and recovery canary

1. Admit two synthetic tenants sequentially.
2. Run the shipped two-tenant isolation canary against the real services.
3. Verify no cross-tenant IDs, messages, files, keys, approvals, object paths,
   process state, or authority files are visible.
4. Replay prior-generation actor, service, and model-key capabilities and
   require rejection.
5. Test crashes during restore, request handling, export, sanitization, and
   revocation.
6. Test control-plane restart quarantine and exact operator recovery.
7. Test capacity exhaustion without dedicated-service creation.

Rollback: fence pooled admission. If isolation is in doubt, stop all worker
traffic and recover each exact generation before reusing or discarding state.

### Phase 4 — Canary real interactive assistants

1. Admit only explicit assistant IDs or user-email hashes.
2. Support only BYOK providers accepted by the pooled model-key vault.
3. Measure request queue, restore, turn, export, and release latency.
4. Require zero isolation violations and zero unaccounted state loss through a
   defined observation window.
5. Expand from one worker only after the canary passes on every worker image
   and region.

Rollback: remove the cohort from new pooled admission; allow in-flight
requests to drain and checkpoint before disabling workers.

### Phase 5 — Productize pooled-to-dedicated promotion

1. Register the cutover schema and orchestrator.
2. Add the target bootstrap/restore gate.
3. Integrate feature capability requirements with placement.
4. Implement export, target provisioning, restore, verify, canary, commit,
   cooling, and source retirement.
5. Surface the operation through existing operational status.
6. Test every crash boundary and idempotent replay.

Rollback: before commit, keep or restore pooled source routing. After commit,
keep the dedicated target and do not automatically demote.

### Phase 6 — Default eligible new assistants to pooled

1. Change admission from explicit cohort to all eligible new assistants.
2. Preserve all existing dedicated placements.
3. Set alerts on saturation, quarantine rate, p95 queue time, checkpoint
   failures, and unexpected dedicated promotions.
4. Add workers gradually; keep one lease per worker.

Rollback: stop new pooled placement while allowing existing pooled assistants
to drain or promote. An emergency isolation rollback fails pooled assistants
closed rather than risking cross-tenant access.

## Public Interfaces

### Changed contracts

- Assistant response: optional `runtime_placement`.
- Operational status: populated `active_operation` and additional placement
  detail states.
- Runtime error responses: new structured placement/capacity/promotion codes.
- OpenAPI sources and generated web client artifacts change in the same PR as
  their server contract.

### New internal modules and data

- `control-plane/src/runtime-placement.ts`.
- `assistant_runtime_placements` control-plane table.
- A placement orchestrator that integrates the existing
  `runtime-cutovers.ts`.
- No assistant workspace migration in the initial pooled-admission phases.
- Promotion uses the existing checkpoint object model; any new control-plane
  schema is additive and idempotent.

### Configuration

Reuse the existing all-or-nothing pool startup gates documented in
`docs/pooled-runtime-workers.md`. Do not add a second overlapping set of
worker catalog, transport, vault, quota, or ownership flags.

If a new admission-mode setting is necessary, use one explicit enum:

`WORKLIN_RUNTIME_PLACEMENT_MODE=dedicated|canary|hybrid`

Invalid or missing values resolve to `dedicated`. The existing canary ID/hash
lists apply only in `canary`.

## Data Boundary And Security

- Authenticate user, organization, assistant ownership, and admin permissions
  before placement or routing.
- Worker leases and every actor/service/model-key capability remain bound to
  organization, user, assistant, worker, generation, request, and expiry.
- Never put CES state, gateway security state, provider keys, credential
  material, raw trust data, or runtime authority files in checkpoint objects.
- Object-store paths and signed URLs are tenant- and generation-bound,
  short-lived, HTTPS-only, redirect-denying, and inaccessible to browsers.
- A failed or ambiguous restore, export, verification, sanitization,
  revocation, or lease renewal quarantines the exact worker generation.
- Do not reuse a worker until physical sanitization and authority revocation
  are both proven.
- Dedicated target secrets are newly generated/injected; they are not copied
  from the worker filesystem.
- Public error responses contain stable codes and safe messages, not raw
  storage, SQL, token, or provider errors.
- Audit every placement decision and cutover transition without logging
  credentials or customer content.

## Test Plan

### Control-plane unit tests

- Placement resolver decision table and default-dedicated behavior.
- Canary IDs/hashes actually gate pooled eligibility.
- Existing dedicated stacks never route pooled.
- Dedicated resource evidence always fails closed.
- Capability registry covers every dedicated-only route rejection.
- Capacity exhaustion returns retryable wait without creating Railway
  resources.
- Placement writes are idempotent and reject stale versions.

### Pool integration tests

- Startup remains all-or-nothing.
- Catalog/worker identity drift fails startup.
- Two tenants sequentially reuse one worker without data leakage.
- Same-assistant concurrent requests coalesce; unrelated assistants remain
  independently fenced.
- Old-generation tokens and model-key capabilities fail after release.
- Restore/export checksum mismatch quarantines the worker.
- Control-plane restart and ownership loss stop new routes immediately.

### Promotion and cutover tests

- Pooled source remains selected until commit.
- Dedicated target cannot serve tenant traffic before restore verification.
- Every phase is idempotent under retry.
- Crash/restart at every phase resumes or rolls back from durable state.
- Failed verification/canary never selects the target.
- Source retirement is impossible before cooling and target health.
- Post-commit routing remains dedicated after restart.

### Web tests

- Pooled-active assistants skip the setup screen.
- Capacity wait uses server-provided retry timing.
- Promotion phases render without starting a duplicate poller.
- Dedicated-only feature actions show promotion rather than a generic failure.
- Old payloads without `runtime_placement` remain supported.
- Web, iOS/Capacitor, and Electron platform gates remain correct.

### Commands

Run scoped Bun tests for changed control-plane and web files. Run:

- `cd control-plane && bunx tsc --noEmit`
- `cd apps/web && bunx tsc --noEmit`
- `cd assistant && bunx tsc --noEmit` when worker-facing contracts change
- `cd gateway && bunx tsc --noEmit` when gateway enforcement changes
- `runtime/pooled-worker-image.test.ts`

Never run an unscoped `bun test`.

## Documentation Plan

- Update `ARCHITECTURE.md` with the shipped placement and promotion flow.
- Update `docs/pooled-runtime-workers.md` as each activation constraint becomes
  operational reality.
- Update `deploy/production/README.md` with worker, bucket, vault, admission
  mode, canary, rollback, and capacity procedures.
- Add an operator runbook for worker quarantine and exact-generation recovery.
- Add a promotion/cutover runbook with pre-commit rollback and post-commit
  retirement procedures.
- Document only shipped route support. Keep concurrent multi-tenant execution,
  dedicated-to-pooled migration, and multi-replica coordination in the
  `Future Improvements` section until implemented.

## Rollout Plan

- Deploy code first with `WORKLIN_RUNTIME_PLACEMENT_MODE=dedicated` and every
  pool gate off.
- Create new pooled workers; never repurpose an existing customer-bound
  runtime.
- Activate one worker and concurrency `1`.
- Pass the synthetic two-tenant canary before any real user.
- Admit explicit real canaries, then expand worker count, then enable hybrid
  placement for new eligible assistants.
- Keep existing dedicated assistants pinned.
- Roll back by disabling new pooled admission first, draining/exporting active
  leases, and then removing clean workers from the catalog.
- Never destroy a volume, checkpoint, or quarantined worker automatically
  during rollback.

## Risks And Guardrails

| Risk | Guardrail |
|---|---|
| Cross-tenant data or credential exposure | One lease per worker, generation-bound authority, exact route allowlist, mandatory sanitization, two-tenant canary |
| Lost state during worker failure | Durable checkpoint before release, checksums, quarantine on ambiguity |
| Pool saturation | Bounded capacity response, queue metrics, capacity alerts, gradual worker expansion |
| Cost explosion through automatic promotion | Server-owned capability registry, admission quotas, idempotent promotion, no busy-pool fallback |
| Existing assistant regression | Dedicated-first routing precedence and no automatic dedicated-to-pooled migration |
| Control-plane split brain | Singleton coordinator ownership and one expected replica |
| Long-lived route monopolizes worker | Indefinite SSE/upgrades/background execution remain dedicated-only |
| Promotion serves two runtimes | Routing changes only at verified cutover commit |
| Operator destroys recoverable data | Quarantine by default; explicit exact-generation recovery and literal destructive confirmation |

## Acceptance Criteria

- A new eligible assistant becomes pooled-active without creating a Railway
  service or volume for that assistant.
- Existing dedicated assistants remain routable with unchanged behavior.
- Pool enablement cannot admit users outside the configured canary cohort.
- One real worker passes the sequential two-tenant isolation canary.
- No browser response exposes worker, lease, checkpoint, or secret material.
- Capacity exhaustion produces a bounded retryable state and no dedicated
  resource creation.
- Enabling a dedicated-only capability creates one auditable promotion and
  preserves source routing until verified commit.
- Failed promotion rolls back or fails closed without concurrent serving.
- All new contracts are backward-compatible and represented in OpenAPI/client
  artifacts.
- Scoped tests and relevant package typechecks pass.
- Production and recovery documentation matches the enabled architecture.

## Future Improvements

- Dedicated-to-pooled migration after a separately reviewed reverse-cutover
  design.
- Automatic demotion after long idle periods.
- Concurrent multi-tenant request execution inside a stateless worker.
- Tenant-scoped OAuth and integration credential brokerage for pooled workers.
- Pooled background schedules, task execution, voice, and long-lived streams.
- Distributed coordinator/request registries for multiple control-plane
  replicas.
- Predictive autoscaling after enough real queue and lease-duration telemetry
  exists.

## Assumptions

- The combined runtime image can be published publicly by immutable digest
  because the repository is MIT-licensed and public. If a private image is
  required, the Railway plan and registry authentication must be upgraded
  before rollout.
- Production can supply persistent control-plane storage, object storage, and
  stable vault/coordinator secrets.
- Initial pooled users can use a provider supported by the control-plane BYOK
  vault.
- The companion platform proxy can pass through additive assistant and
  operational-status fields.
- Lifecycle and operational-status stabilization lands before pooled user
  admission.
