# Worklin AI Handoff Context

Use this file to start a new Codex/chat session with enough context to continue Worklin AI without rereading the whole prior thread.

Last updated: 2026-05-10

## Product Summary

Worklin AI is an agent-first retention operating system for Shopify/DTC brands.

The app helps lifecycle/CRM teams turn Shopify data, Klaviyo data, brand knowledge, campaign history, playbooks, performance memory, and audit findings into:

- product intelligence
- campaign plans
- design-ready creative briefs
- QA/preflight results
- approved Klaviyo draft campaigns
- lifecycle flow coverage and recommendations
- campaign, flow, audience, and full-retention audit insights
- prepare-only fix packages
- durable approval state for prepared work
- durable action logs, recommendation outcomes, results/learning signals
- safe tool runtime execution for explicitly wired read/prep tools
- reusable skills, compact workspace context packs, source connector status, and source snapshots
- prepare-only commerce cohort to Klaviyo enrichment planning
- safe local unified customer identity, customer feature store, and rule-based customer scoring
- later: micro-segment definitions, campaign opportunity engine, micro-campaign factory, arbitration/frequency guardrails, approved sync, scheduled checks, proactive recommendations, and autopilot policy execution

Important naming note:

- The old product name was Oscar.
- Do not use Oscar in product copy, PR descriptions, comments, docs, or new code.
- Use Worklin AI / Worklin.

## Latest Main Status

Current expected local repo state after the latest sync:

```text
branch: main
remote: origin/main
status: main is up to date with origin/main
latest local main commit: 3c5f33a Rule-Based Customer Scoring v0 (#58)
latest merged PR: PR #58 Rule-Based Customer Scoring v0
PR #56 squash commit: a806e66e6df4d1df7b8e2f01724d7391b2010098
PR #57 squash commit: c85b963ee8022203928575404dbe5d484ee1603a
PR #58 squash commit: 3c5f33ad77507d15bbf567b24bec404809f44e94
recent milestone range now reflected: PR #49 through PR #58
stash: approval-gate-v0-wip still exists and must not be touched unless explicitly requested
```

Official repo:

```text
https://github.com/Logarn/ai-retention-marketer-
```

Local repo path:

```text
/Users/admin/Documents/Codex/2026-04-28/github-plugin-github-openai-curated-main/worklin-ai-git
```

Current stack:

- Next.js App Router
- Prisma 7
- PostgreSQL
- Local seeded data
- Shopify/local normalized data
- Klaviyo read and draft integrations
- Vercel target later

## Product North Star

Worklin is not just audit software. It is moving toward an autonomous personalized campaign factory for lifecycle retention:

- many precise micro-campaigns instead of 3-4 broad campaigns per week
- micro-segments mapped to specific messaging, product, offer, timing, and channel logic
- scoring, segmentation, arbitration, QA, approval, and learning as one operating loop
- the human sets policy; Worklin handles routine retention work and escalates exceptions

The current usable product direction is still audit-to-fix, but the customer engine milestone turns that loop into the substrate for personalized campaign automation.

User says:

```text
Audit my retention setup.
```

Worklin investigates:

```text
Product truth -> campaign truth -> flow truth -> audience/segment truth -> performance readiness -> lifecycle coverage -> prioritized fixes
```

Then Worklin can prepare safe fixes after user confirmation.

Near-term magic is not audit-to-plan. It is audit-to-fix:

```text
Audit -> user says "fix all this" -> Worklin prepares/fixes safe items in background -> returns one approval-ready package -> user approves/revises
```

Longer-term magic is policy-led autonomous retention work:

```text
Observe customers -> update identities/features/scores -> define micro-segment opportunities -> arbitrate timing/offer/message/channel -> prepare campaigns/fixes -> QA -> approval/policy gate -> learn from outcomes
```

Important current limitation:

- Worklin can prepare safe fixes and track approval state.
- Worklin can execute only explicitly wired safe tools through Tool Runtime.
- Most execution remains read-only or prepare-only.
- Worklin does not perform Segment/Profile Sync, live Klaviyo segment creation, live flow creation, sending, or scheduling yet.
- External live actions remain blocked.

## Current Architecture Spine

Worklin now has a backend-first audit-to-fix and agent spine:

```text
/agent Chat
  -> RAG Context Layer
  -> LLM Provider Router
  -> LLM Intent Parser
  -> Deterministic Command Router
  -> Tool Registry
  -> Campaign Workflow
       Planner -> Playbook-aware Brief Generator -> QA -> Approval Intent -> Klaviyo Draft Creation
  -> Lifecycle Flow Workflow
       Klaviyo Flow Read -> Flow Detection -> Flow Planner -> Flow Detail Read -> Flow Audit
  -> Product Intelligence
       Shopify/local normalized Product, Order, OrderItem, Customer, CustomerEvent data
       -> Product Performance Intelligence
  -> Campaign Intelligence
       Klaviyo Campaign Metadata Read -> Klaviyo Performance Read when configured -> Campaign Audit
  -> Audience Intelligence
       Klaviyo Audience Read + local customer/order/event signals -> Segment / Audience Audit
  -> Metric Readiness
       Klaviyo Metric Discovery -> likely conversion metric candidates and caveats
  -> Retention Audit Workflow
       Product + Campaign + Flow + Audience + Metric readiness -> Retention Audit WorkflowRun
  -> Audit Canvas
       Retention Audit WorkflowRun -> visual audit canvas in /agent and /agent/workflows
  -> Audit Fix Run
       Retention Audit WorkflowRun -> prepare-only audit-fix-run WorkflowRun
  -> Durable Approval State
       Approval rows for pending, approved, rejected, revision_requested decisions
  -> Action Log
       Durable safe event history for important agent/tool/workflow actions
  -> Recommendation Outcomes
       Lifecycle state for recommendations and prepared fixes over time
  -> Results / Learning Loop
       Read-only ingestion of performance results into learning signals
  -> Tool Execution Runtime
       Executes only registered, explicitly wired safe tools; blocks live/external actions
  -> Source Connector Registry
       Capability/status map for Klaviyo, Shopify, Figma, Canva, Google Docs, Google Sheets, uploaded files
  -> Source Snapshots
       Klaviyo Source Snapshot + Shopify Commerce/Cohort Snapshot, compact and read-only
  -> Workspace Context Pack
       Purpose/skill-scoped account memory bundle for workflows and skills
  -> Skill Registry / Skill Runner
       Reusable procedures, matching, proposals, patching, lifecycle, safe run modes
  -> Commerce Cohort -> Klaviyo Enrichment Plan
       Prepare-only property/segment/use-case definitions for future approved sync
  -> Unified Customer Identity
       Local read-only Worklin/Shopify/Klaviyo identity spine with confidence and caveats
  -> Customer Feature Store
       Durable customer-level facts/signals from local identity, Shopify, and available local Klaviyo/engagement data
  -> Rule-Based Customer Scoring
       Deterministic lifecycle/retention scores from feature records, with reasons, confidence, and advisory arbitration hints
  -> Shared Audit Layer
       Audit Insight Framework -> ranked insights, evidence, caveats, recommended actions, chart hints
```

This matters because Worklin should not jump from raw Klaviyo data to generic recommendations. Useful audits need product truth, asset truth, audience truth, evidence, confidence, caveats, and executive-friendly summaries before recommending action.

Current strong stack:

```text
Source Connector Registry
  -> Klaviyo Source Snapshot
  -> Shopify Commerce + Cohort Snapshot
  -> Unified Customer Identity
  -> Customer Feature Store
  -> Rule-Based Customer Scoring
  -> Workspace Context Pack
  -> Skill Registry / Skill Runner
  -> Tool Runtime / Approval / Action Log / Outcomes / Results
```

Important architecture re-center after the customer engine milestone:

- Worklin now has the first local customer engine: identity spine -> feature facts/signals -> rule-based scores.
- Unified Customer Identity v0 is not full Shopify-to-Klaviyo identity resolution yet; it is a safe local identity summary.
- Customer Feature Store v0 stores facts/signals, not final decisions.
- Rule-Based Customer Scoring v0 interprets feature records into deterministic 0-1000 lifecycle/retention scores, not segments or campaigns.
- The immediate next layer is Micro-Segment / Segment Definition Builder v0: turn scores into definition-only audience opportunities without duplicating Klaviyo segmentation or creating live segments.
- Worklin's sci-fi goal is near-zero prompting: Worklin wakes up, observes accounts, updates snapshots/features/scores, detects opportunities, prepares/executes within policy, escalates exceptions, and learns from outcomes.

## Current Safety Rules

Non-negotiable safety posture:

- No scheduling.
- No sending.
- No live Klaviyo destructive actions.
- Klaviyo campaign creation remains draft-only.
- Audits and reads are read-only.
- Audit Fix Run is prepare-only.
- Approval state only updates `Approval` rows and does not execute actions.
- Tool Runtime only executes explicitly wired safe handlers and blocks unknown, unwired, approval-required, or `external_live_action` tools.
- Skills without explicit safe runners must refuse safely and must not execute arbitrary tools or LLM output.
- Skill proposals, matches, patches, and lifecycle transitions do not enable live actions by themselves.
- Source snapshots are read-only summaries and must keep connector verification separate from snapshot read status.
- Commerce Cohort -> Klaviyo Enrichment Plan is definition/planning only.
- Klaviyo enrichment properties and segments remain `not_synced` until future Segment/Profile Sync is explicitly built and approved.
- Segment/profile sync and Klaviyo flow creation are not built into the audit-to-fix execution path yet.
- Klaviyo flow reads are read-only.
- Klaviyo campaign metadata reads are read-only.
- Klaviyo campaign/flow/segment performance reads are read-only.
- `KLAVIYO_DRAFT_ONLY=true` is required for Klaviyo write-adjacent behavior.
- Agent approval means draft creation only in the existing campaign approval path, never send/schedule.
- Approval of an audit-fix-run does not create drafts, flows, segments, syncs, sends, or schedules.
- LLM interprets; deterministic router validates and executes.
- LLM output must never directly trigger Klaviyo drafts or external actions.
- Failed-QA briefs are held.
- Warning briefs are held unless explicitly included.
- Provider keys, Klaviyo keys, Shopify keys, database URLs, and GitHub tokens stay server-only and must never be printed or returned.
- Read routes should return safe JSON and caveats instead of crashing when config, scopes, or data are missing.
- Connector verification must not be overstated.
- Context packs must stay compact, purpose-scoped, and free of raw payloads or PII-heavy data.
- Customer identity, feature store, and scoring APIs must not return raw contact fields, raw customer/order/profile/event payloads, secrets, or PII-heavy data.
- Unified Customer Identity, Customer Feature Store, and Customer Scoring Tool Runtime tools are read-only and local-data based.
- Customer Feature Store features remain separate from Rule-Based Customer Scoring scores.
- Rule-Based Customer Scoring scores are advisory lifecycle/retention signals and do not create segments, campaigns, drafts, sends, schedules, syncs, or live actions.
- Uploads are fallback sources; connected sources and source snapshots should be preferred when available and verified/caveated correctly.
- For individual expert skills, ask Steve targeted questions before finalizing the expert process.

Current Klaviyo write surface:

- Worklin can create real Klaviyo templates and draft campaigns from approved QA-passed briefs.
- Worklin must not send or schedule campaigns.
- Worklin must not create duplicate drafts for the same brief when a local `KlaviyoDraft` already exists.

Current Klaviyo read surfaces:

- `GET /api/klaviyo/flows`
- `GET /api/klaviyo/flows/[flowId]`
- `POST /api/klaviyo/performance`
- `GET /api/klaviyo/campaigns`
- `GET /api/klaviyo/audiences`
- `GET /api/klaviyo/metrics`
- `POST /api/klaviyo/metrics/discover`

All of these are read-only.

## Canvas UX Principle

Any major visual artifact should ideally appear inside the chat experience as an inline or side canvas, Codex-style.

Standalone routes like `/agent/workflows` can remain deep-link/full-page fallbacks, but the primary UX should keep the user in `/agent` chat.

This applies to:

- Retention Audit Canvas
- Prepared Fix Package
- campaign plans
- briefs
- flow build plans
- audience packages
- QA reports
- future heartbeat reports

`/audits/retention` may exist as a secondary/dev route, but the primary experience should use real connected-account data inside the agent workflow/canvas pattern, not mock data.

## Current Main Includes

Earlier foundation layers:

- Campaign Memory
- Planner v0
- Brief Generator v0
- Plan -> Brief UI v0
- QA Engine v0 with Brain/Brand checks
- QA UI v0
- Agent Orchestrator v0
- WorkflowRun persistence
- Agent Output Canvas v0
- Klaviyo Draft Creation v0
- Approval Intent -> Auto Draft v0
- Playbook Engine v0
- Tool Registry v0
- Agent Command Router v0
- RAG Context Layer v0
- Context-Aware Command Router v1
- Agent Chat Integration v0
- LLM Provider Router v0
- LLM Intent Parser v0
- Playbook-aware Brief Generation v0
- Klaviyo Flow Read + Detection v0
- Flow Planner v0
- Flow Planner Agent Command Integration v0
- Klaviyo Flow Detail Read v0
- Klaviyo Performance Read v0
- Product Performance Intelligence v0
- Audit Insight Framework v0
- Flow Audit v0
- Expanded Flow Playbook Catalog v0
- Campaign Audit v0

Latest audit-to-fix layers:

- Segment / Audience Audit v0
- Klaviyo Metric Discovery / Performance Setup v0
- Retention Audit Workflow v0
- Audit Canvas / Visual Summary v0
- Audit Fix Run v0
- Agent Audit Starter + Fix Confirmation v0
- Durable Approval State v0
- Action Log v0
- Tool Execution Runtime v0
- Recommendation Outcome Tracking v0
- Results Ingestion + Learning Loop v0
- Skill Registry / Skill Runner v0
- Workspace Context Pack v0
- Source Connector Registry v0
- Klaviyo Source Snapshot v0
- Shopify Commerce + Cohort Snapshot v0
- Commerce Cohort -> Klaviyo Enrichment Plan v0
- Unified Customer Identity v0
- Customer Feature Store v0
- Rule-Based Customer Scoring v0

Completed/merged through PR #58:

- audit-to-fix loop
- approvals
- action logs
- recommendation outcomes
- results/learning signals
- tool runtime
- skills
- compact workspace context
- source connector registry
- Klaviyo source snapshot
- Shopify commerce/cohort snapshot
- prepare-only Klaviyo enrichment plan
- unified customer identity spine
- customer feature store
- rule-based customer scoring

## Recently Merged PRs

### PR #58: Rule-Based Customer Scoring v0

Status: completed and merged into `main`.

URL:

```text
https://github.com/Logarn/ai-retention-marketer-/pull/58
```

Squash commit:

```text
3c5f33ad77507d15bbf567b24bec404809f44e94
```

Adds:

- Durable `CustomerScoreStore` model and APIs.
- Computes 16 deterministic lifecycle/retention scores from persisted `CustomerFeatureStore` records.
- Scores use a 0-1000 scale with tier, confidence, reasons, source features, caveats, and `computedAt`.
- Supports multi-score customers; no forced single bucket.
- Adds advisory next-best-action/arbitration hints.
- Missing engagement data lowers confidence and adds caveats instead of punishing customers.
- Adds read-only Tool Runtime tool `memory.getCustomerScores`.
- Workspace Context Pack exposes only a compact `customerScoring` pointer/status, not full score dumps.

Safety:

- No Segment Builder yet.
- No Segment/Profile Sync.
- No campaign/flow/segment/profile creation.
- No draft creation, sending, scheduling, Shopify write, Klaviyo write, or live external action.
- No raw contact fields, PII-heavy payloads, raw customer/order/profile/event payloads, secrets, or token-like values returned.

### PR #57: Customer Feature Store v0

Status: completed and merged into `main`.

URL:

```text
https://github.com/Logarn/ai-retention-marketer-/pull/57
```

Squash commit:

```text
c85b963ee8022203928575404dbe5d484ee1603a
```

Adds:

- Durable `CustomerFeatureStore` model and APIs.
- Computes customer-level features from Unified Customer Identity, local Shopify data, and local Klaviyo/engagement data where available.
- Feature families:
  - identity
  - commerce
  - product/cohort
  - engagement
  - intent
  - lifecycle signals
  - derived labels
  - source coverage
  - missing capabilities
- Keeps features/facts/signals separate from scores and final decisions.
- Klaviyo engagement and intent remain local-only and are caveated when local event/profile linkage is missing.
- Adds read-only Tool Runtime tool `memory.getCustomerFeatureStore`.
- Workspace Context Pack exposes only a compact feature-store pointer/status.

Safety:

- No raw contact fields, raw customer/order/profile/event payloads, secrets, or PII-heavy output.
- No Shopify writes.
- No Klaviyo writes.
- No drafts, sends, schedules, profile sync, segment creation, campaign creation, or flow creation.

### PR #56: Unified Customer Identity v0

Status: completed and merged into `main`.

URL:

```text
https://github.com/Logarn/ai-retention-marketer-/pull/56
```

Squash commit:

```text
a806e66e6df4d1df7b8e2f01724d7391b2010098
```

Adds:

- Safe local customer identity spine:
  - Shopify customer id where locally available
  - Klaviyo profile id acknowledged/caveated where not locally linked
  - Worklin identity confidence and caveats
- `GET /api/customers/identity`
- `POST /api/customers/identity`
- Read-only Tool Runtime tool `memory.getUnifiedCustomerIdentity`.
- Local identity summary only; not full Shopify-to-Klaviyo identity resolution yet.

Safety:

- Raw contact fields are not returned by default.
- No raw email, phone, address, customer array, profile payload, or PII-heavy output by default.
- No Shopify writes.
- No Klaviyo writes.
- No profile sync, segment creation, draft creation, send, schedule, or live external action.

### PR #54: Commerce Cohort -> Klaviyo Enrichment Plan v0

Status: completed and merged into `main`.

URL:

```text
https://github.com/Logarn/ai-retention-marketer-/pull/54
```

Squash commit:

```text
2a336ffecb54ca5354c8f3b4671887f49d26813f
```

Adds:

- `POST /api/enrichment/klaviyo/plan`
- Prepare-only Klaviyo enrichment planning route.
- Converts Shopify Commerce + Cohort Snapshot intelligence into Klaviyo-ready profile property and segment definitions.
- Includes recommended properties, segment definitions, campaign use cases, flow use cases, suppression use cases, refresh policy, approval package, risks, and caveats.
- Explicitly remains a definition/planning layer, not Customer Feature Store, Predictive Scoring, Segment Builder, Segment/Profile Sync, or live execution.
- Every property/segment/use case is `not_synced`, `approvalRequired`, and `externalActionTaken=false`.

Safety:

- No Klaviyo writes.
- No Shopify writes.
- No profile sync.
- No segment creation.
- No flow/campaign creation.
- No send/schedule behavior.

### PR #53: Shopify Commerce + Cohort Snapshot v0

Status: completed and merged into `main`.

Adds:

- `GET /api/sources/shopify/snapshot`
- `POST /api/sources/shopify/snapshot`
- Local Prisma Shopify data only:
  - `Customer`
  - `Order`
  - `OrderItem`
  - `Product`
  - `IntegrationState`
- Commerce summary, lifetime customer value, first-purchase cohorts, product-entry cohorts, product performance, lifecycle signals, and Klaviyo enrichment candidates.
- Connector verification stays separate from snapshot read status.
- `snapshotReadMethod: local_data`; Shopify is not marked live-verified.
- Cohort denominators and data coverage.
- Small cohorts marked directional with `minimumUsefulCohortSize: 10`.
- Klaviyo enrichment labels proposed only; no sync/write.
- Context Pack advertises Shopify snapshot availability without embedding or running the full snapshot.

Safety:

- No raw PII-heavy output.
- No Shopify/Klaviyo writes.
- No sends, schedules, syncs, flow creation, segment creation, or profile changes.

### PR #52: Klaviyo Source Snapshot v0

Status: completed and merged into `main`.

Adds:

- `GET /api/sources/klaviyo/snapshot`
- Compact read-only Klaviyo source snapshot.
- Connector verification separated from snapshot read status.
- `snapshotReadStatus`, `verifiedSections`, `caveatedSections`, and `snapshotAvailability`.
- Safe summaries of campaigns, flows, audiences, metrics, drafts, lifecycle, and safety where available.
- Audiences and metrics can be partial when caveated without marking the whole connector live-verified.
- Raw Klaviyo payloads, full workflow outputs, secrets, env values, and PII-heavy data are omitted.

Safety:

- No Klaviyo writes.
- No draft creation.
- No sends, schedules, syncs, flow creation, segment creation, or profile changes.

### PR #51: Source Connector Registry v0

Status: completed and merged into `main`.

Adds:

- `GET /api/sources/connectors`
- `GET /api/sources/connectors/[id]`
- Capability map for:
  - Klaviyo
  - Shopify
  - Figma
  - Canva
  - Google Docs
  - Google Sheets
  - uploaded files
- `verificationStatus`, `verificationMethod`, and `lastVerifiedAt` so configured sources are not mistaken for live-verified sources.
- Klaviyo and Shopify are configured/partial unless separately live-verified.
- Figma, Canva, Google Docs, and Google Sheets are `not_connected` with upload fallbacks.
- Uploaded files are available as fallback.
- Workspace Context Pack uses connector registry statuses.

Safety:

- No live connector actions.
- No external writes.
- No syncs.

### PR #50: Workspace Context Pack v0

Status: completed and merged into `main`.

Adds:

- `GET /api/workspace/context-pack`
- `POST /api/workspace/context-pack`
- `compact`, `standard`, and `full` depth support.
- Default compact context pack is purpose/skill-scoped.
- Safe account memory/context from brand context, campaign memory, product truth, recent workflows, approvals, action logs, recommendation outcomes, results, skills, connector/source status, and safety posture where relevant.
- Metadata:
  - `sizeBytes`
  - `depth`
  - `effectiveLimit`
  - `omittedSections`
  - `truncatedSections`

Safety:

- Omits raw workflow input/output, full audit/fix JSON, raw payloads, secrets/env values, and PII-heavy data.
- Gives skills/workflows useful account memory without dumping everything.

### PR #49: Skill Registry / Skill Runner v0

Status: completed and merged into `main`.

Adds:

- `WorklinSkill` model and migrations.
- Skill list/detail/run/propose/match/patch/transition routes.
- Global/workspace/hybrid skill scopes.
- Shadow/assist/execute run modes.
- Source/artifact metadata:
  - `preferredSources`
  - `fallbackSources`
  - `requiredArtifacts`
  - `optionalArtifacts`
  - `connectorDependencies`
  - `missingSourceBehavior`
- 16 core DTC starter skills plus optional/hybrid `lead_magnet_analysis`.
- Agent-created skill proposals, skill matching, skill patching, and lifecycle transitions.

Core DTC starter skills:

- `retention_audit`
- `audit_fix_run`
- `campaign_calendar_builder`
- `campaign_copywriting`
- `campaign_copy_qa`
- `email_design_review`
- `email_slice_review`
- `flow_audit`
- `flow_fix_planning`
- `audience_strategy`
- `deliverability_review`
- `weekly_retention_reporting`
- `performance_reporting`
- `klaviyo_build_qa`
- `product_campaign_strategy`
- `post_purchase_lifecycle_optimization`

Optional/hybrid skill:

- `lead_magnet_analysis`, for workspaces with lead magnets, quizzes, freebies, guides, or acquisition cohorts.

Runtime behavior:

- Only `retention_audit` and `audit_fix_run` are runnable through Tool Runtime.
- Planned/proposed skills refuse safely unless explicitly wired.
- Skills are reusable procedures; brand facts belong in Brand Brain / Workspace Context.

Safety:

- No arbitrary tool execution.
- No Klaviyo writes.
- No sends or schedules.

## Current Roadmap

Completed/merged through PR #58:

- audit-to-fix loop
- approvals/action logs/outcomes/results
- tool runtime
- skills/context/source connectors/source snapshots/enrichment plan
- unified customer identity
- customer feature store
- rule-based customer scoring

Current next locked sequence:

1. Micro-Segment / Segment Definition Builder v0
2. Campaign Opportunity Engine v0
3. Campaign Variant / Micro-Campaign Factory v0
4. Arbitration + Frequency Guardrails v0
5. Approval Queue / Campaign Review Canvas v0
6. Segment/Profile Sync v0
7. Cron / Scheduled Checks v0
8. Heartbeat / Proactive Recommendation Queue v0
9. Autopilot Policies v0

Roadmap notes:

- After PR #58, the first customer engine milestone exists: unified identity, feature store, and rule-based scoring.
- The immediate next feature is Micro-Segment / Segment Definition Builder v0.
- Micro-Segment / Segment Definition Builder v0 should turn scores into definition-only audience opportunities without duplicating Klaviyo segmentation or creating live segments.
- Campaign Opportunity Engine and Micro-Campaign Factory should build on segment definitions and score explanations rather than raw customer payloads.
- Arbitration and frequency guardrails should stay advisory until policy/approval surfaces are built.
- Segment/Profile Sync must remain behind approvals, Tool Runtime gates, missing-capability checks, future policy controls, and explicit user approval.
- Future executors must preserve prepare/approve/execute separation.
- Sending/scheduling/live external actions remain much later.

Preserved product rules:

- No sending, scheduling, or live external actions unless explicitly built later and approval/policy allows.
- Planning/prep layers are allowed, but do not keep adding them before the intelligence engine.
- Skills are reusable procedures; brand facts live in Brand Brain / Workspace Context.
- Uploads are fallback; connected sources/snapshots should be preferred when available.
- Connector verification must not be overstated.
- Context packs must stay compact and purpose-scoped.
- For individual skills, ask Steve targeted questions before finalizing expert process.

## Working Process Rules

Handoff update cadence:

- Do not update `WORKLIN_CONTEXT_HANDOFF.md` after every feature.
- Update it after roughly 5-6 meaningful PRs, major architecture shifts, end-of-day, or before a new long chat.
- Handoff updates should be docs-only unless the user explicitly asks for product work in the same branch.

Collaboration loop:

- Codex should work stepwise.
- The user shares Codex output with ChatGPT for review before the next instruction.
- Codex should not run away through feature build/test/merge without review.
- Merge prompts must be explicit and require final status reporting.

Testing expectations:

- Manual UI/terminal testing is required when features touch UI, agent behavior, approval flows, Klaviyo/draft behavior, workflow orchestration, or safety-critical paths.
- Tests should be meaningful regressions, not happy-path-only.
- Preserve route-level regressions for `/agent`, `/agent/workflows`, and `/planner` when app shell or agent UI changes.

## Git Workflow Rules

Do:

- Start every feature from latest `main`.
- Run `git status --short --branch` before editing.
- Create a fresh feature branch named as requested, usually `feature/<short-feature-name>` for product work or `docs/<short-doc-name>` for docs-only handoff work.
- Stage only related files.
- Run `npm run build` before feature PRs.
- Run relevant route/API smoke tests.
- Run `git diff --check`.
- Run a staged secret scan before commit when code, env-adjacent files, or large diffs are staged.
- Push the branch and open a draft PR.
- Wait for explicit user approval before merging.
- After merge approval, checkout `main`, pull latest `origin/main`, confirm main is up to date, and delete the local feature branch if safe.

Do not:

- Work directly on `main` for feature work.
- Merge a PR unless the user explicitly says it is approved to merge.
- Commit unrelated files.
- Include `WORKLIN_CONTEXT_HANDOFF.md` in feature PRs unless the user asks for a handoff update.
- Use `git add -A` when unrelated files exist.
- Force push unless explicitly approved.
- Delete/apply/drop stashes unless explicitly requested.
- Revert user changes unless explicitly requested.
- Use destructive commands such as `git reset --hard` unless explicitly approved.

## Local Working Tree Rules

`WORKLIN_CONTEXT_HANDOFF.md` is a tracked repo document. Keep it out of normal feature PRs unless the user explicitly asks for handoff/context maintenance.

There is one known local stash:

```text
stash@{0}: On feature/approval-gate-v0: approval-gate-v0-wip
```

That stash contains unfinished Approval Gate v0 work from before the user pivoted to Approval Intent -> Auto Draft. Do not drop, apply, inspect, or rewrite it unless the user explicitly asks.

## Database Rules

Use the clean local DB:

```text
worklin_dev_clean
```

Do:

- Use proper Prisma migrations for schema changes.
- Prefer additive migrations.
- Run migration verification when schema changes:

```bash
npx prisma validate --config prisma.config.ts
npx prisma generate --config prisma.config.ts
npx prisma migrate deploy --config prisma.config.ts
```

Do not:

- Mutate or reset the old drifted DB `retention_ai`.
- Use `prisma db push` unless explicitly approved.
- Use `prisma db execute` unless explicitly approved.
- Use `prisma migrate reset` unless explicitly approved.
- Hide drift by making manual database changes.

Known old DB drift symptom:

```text
ERROR: column "storeId" does not exist
```

## API And Error Handling Rules

Do:

- Use defensive validation.
- Use `try/catch` in API routes.
- Return safe JSON.
- Return `400` for bad input/config.
- Return `404` for missing resources.
- Return `409` for invalid approval/lifecycle transitions.
- Return safe `500` for unexpected server errors.
- Prefer empty arrays/objects and caveats over crashes when data is missing.
- Reuse existing shared helpers when possible.
- For approval/action/execution features, include explicit fields that show whether external actions were attempted.

Do not:

- Leak raw Prisma errors or secrets to clients.
- Assume optional records exist.
- Let malformed JSON or missing data crash an endpoint.
- Break existing routes while adding new ones.
- Let approval state imply execution.

## Testing Rules

Do:

- Run `npm run build` before feature PRs.
- Run relevant API smoke tests.
- If schema changed, run Prisma validate/generate/migrate deploy.
- Start a local dev server when testing API/UI behavior.
- Report skipped tests or environmental blockers.
- For audit-to-fix work, verify:
  - `POST /api/audits/retention {}`
  - `POST /api/audits/fix-run` with a real retention audit `workflowId`
  - `POST /api/agent/command` with `audit my retention setup`
  - `POST /api/agent/command` with `fix all` and audit context
  - `/agent`
  - `/agent/workflows`
  - `/planner`
- For approval work, verify:
  - request approval for a real `audit-fix-run` WorkflowRun
  - duplicate pending approval behavior
  - pending -> approved
  - pending -> rejected
  - pending -> revision_requested
  - invalid transitions return safe `409`
  - invalid/unsupported targets return safe errors
  - approval list/detail routes work
  - Klaviyo draft count unchanged

Known build note:

- `npm run build` may fail in a sandbox because Next/font tries to fetch Google Fonts.
- If that happens, rerun build with network access rather than changing app code.

## Secret And Environment Rules

Do:

- Use env vars from local `.env` only at runtime.
- Keep all API keys server-side.
- Use presence checks rather than printing secret values.
- Before committing, scan staged changes for secrets when appropriate.

Do not:

- Print API keys or tokens.
- Commit `.env` or `.env.local`.
- Expose Klaviyo, Shopify, OpenAI, Anthropic, Groq, GitHub, or database credentials to the client.
- Put secrets in PR descriptions, logs, screenshots, or final answers.

Suggested staged secret scan:

```bash
git diff --cached > /tmp/worklin-staged.diff
rg -n "(?i)(api[_-]?key|secret|token|password|authorization|bearer|github_pat|ghp_|sk-[A-Za-z0-9])" /tmp/worklin-staged.diff
rg -n '^[+].*(API_KEY|SECRET|TOKEN|PASSWORD|AUTH).*=[[:space:]]*["'\"'][^"'\"']{4,}' /tmp/worklin-staged.diff
```

## Feature Discipline

Worklin should keep moving in useful, safe increments:

- Build backend truth layers before UI polish when the audit engine needs them.
- Keep v0 features deterministic and fallback-based unless live AI is explicitly requested and guarded.
- Use Product Performance Intelligence, Flow Audit, Campaign Audit, Segment / Audience Audit, Metric Discovery, Retention Audit Workflow, Audit Fix Run, Durable Approval State, Action Log, Recommendation Outcomes, Results, Tool Runtime, Skill Registry, Workspace Context Pack, Source Connector Registry, Source Snapshots, Unified Customer Identity, Customer Feature Store, and Rule-Based Customer Scoring as reusable substrate for future audit-to-fix and personalized campaign factory work.
- Use Audit Insight Framework for all new audit findings so outputs are ranked, evidenced, caveated, and chart-ready.
- Preserve existing `/agent`, `/agent/workflows`, `/planner`, Klaviyo, Shopify, product, flow, campaign, audience, metric, audit, approval, action log, outcome, result, skill, source, context-pack, and enrichment routes while adding new features.
- Do not add scheduling, sending, autopilot, external live actions, PDF ingestion, Slack automation, profile sync, segment creation, or Klaviyo flow creation until explicitly requested.
