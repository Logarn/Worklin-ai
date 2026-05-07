# Worklin AI Handoff Context

Use this file to start a new Codex/chat session with enough context to continue Worklin AI without rereading the whole prior thread.

Last updated: 2026-05-07

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
- later: guarded execution, action logs, learning loops, scheduled checks, and proactive heartbeat recommendations

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
latest local main commit: 61e8355 Add action log v0 (#44)
latest merged PR: PR #44 Action Log v0
PR #44 verification: git log -1 main reported 61e8355 Add action log v0 (#44); main was clean and up to date with origin/main after git pull on 2026-05-07
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

The current Worklin product direction is audit-to-fix.

User says:

```text
Audit my retention setup.
```

Worklin investigates:

```text
Product truth -> campaign truth -> flow truth -> audience/segment truth -> performance readiness -> lifecycle coverage -> prioritized fixes
```

Then Worklin can prepare safe fixes after user confirmation.

The magical end-state is not audit-to-plan. It is audit-to-fix:

```text
Audit -> user says "fix all this" -> Worklin prepares/fixes safe items in background -> returns one approval-ready package -> user approves/revises
```

Important current limitation:

- Worklin can prepare safe fixes and track approval state.
- Worklin does not execute approved work yet.
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
  -> Shared Audit Layer
       Audit Insight Framework -> ranked insights, evidence, caveats, recommended actions, chart hints
```

This matters because Worklin should not jump from raw Klaviyo data to generic recommendations. Useful audits need product truth, asset truth, audience truth, evidence, confidence, caveats, and executive-friendly summaries before recommending action.

## Current Safety Rules

Non-negotiable safety posture:

- No scheduling.
- No sending.
- No live Klaviyo destructive actions.
- Klaviyo campaign creation remains draft-only.
- Audits and reads are read-only.
- Audit Fix Run is prepare-only.
- Approval state only updates `Approval` rows and does not execute actions.
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

## Recently Merged PRs

### PR #44: Action Log v0

Status: completed and merged into `main`.

URL:

```text
https://github.com/Logarn/ai-retention-marketer-/pull/44
```

Latest main commit after merge:

```text
61e8355 Add action log v0 (#44)
```

Adds:

- Durable `ActionLog` model.
- Additive Prisma migration `20260507120000_action_log_v0`.
- Read-only action log routes:
  - `GET /api/action-log`
  - `GET /api/action-log/[id]`
- Shared action logging helper with secret redaction and safe failure behavior.
- Action log writes from retention audit, audit fix run, approval state changes, and agent command flows.

Behavior:

- Records proposed, prepared, approved, rejected, revision-requested, refused, skipped, completed, and failed work.
- Links entries to targets such as WorkflowRun rows and Approval rows where available.
- Preserves the primary workflow/API response if action logging fails.
- Supports filtered read-only inspection of action log entries.

Safety:

- Action logging is local persistence only.
- No Klaviyo writes.
- No draft creation.
- No campaign/flow/segment creation.
- No profile sync.
- No sending/scheduling.
- Action log reads are read-only.

### PR #42: Durable Approval State v0

Status: completed and merged into `main`.

URL:

```text
https://github.com/Logarn/ai-retention-marketer-/pull/42
```

Latest main commit after merge:

```text
afc548f Add durable approval state v0 (#42)
```

Adds:

- Durable `Approval` model.
- Additive Prisma migration `20260507000000_add_approval_state`.
- Postgres partial unique-index migration `20260507001000_add_pending_approval_unique_index` for one pending approval per target.
- Approval routes:
  - `POST /api/approvals/request`
  - `POST /api/approvals/[id]/approve`
  - `POST /api/approvals/[id]/reject`
  - `POST /api/approvals/[id]/request-revision`
  - `GET /api/approvals`
  - `GET /api/approvals/[id]`

Approval model shape:

```text
id
targetType
targetId
status: pending | approved | rejected | revision_requested
targetTitle
targetSummary
requestNote
decisionNote
requestedBy
decidedBy
decidedAt
metadata
createdAt
updatedAt
```

Supported target types:

- `audit-fix-run`
- `workflow-run`
- `campaign-brief`
- `flow-package`
- `audience-package`
- `klaviyo-draft`

Behavior:

- Requests approval for supported targets.
- For workflow-related targets, validates that the target WorkflowRun exists before creating approval state.
- For `audit-fix-run`, requires a completed `audit-fix-run` WorkflowRun.
- Duplicate pending approval requests for the same target return the existing pending approval.
- Only pending approvals can move to `approved`, `rejected`, or `revision_requested`.
- Invalid transitions return safe `409`.
- Invalid targets return safe errors without raw Prisma details.

Safety:

- Approval only updates approval state.
- No Klaviyo writes.
- No draft creation.
- No campaign/flow/segment creation.
- No profile sync.
- No sending/scheduling.
- Approval does not run tools or mutate external systems.

Known caveat:

- Smoke tests inserted dev DB records into `worklin_dev_clean`.
- Prisma schema cannot represent the partial unique index directly, so that index lives in SQL migration.

### PR #41: Agent Audit Starter + Fix Confirmation v0

Status: completed and merged into `main`.

URL:

```text
https://github.com/Logarn/ai-retention-marketer-/pull/41
```

Latest main commit after merge:

```text
709884f Add agent audit starter and fix confirmation v0 (#41)
```

Behavior:

- `/agent` now starts with an audit-first offer.
- User can request a retention audit anytime via chat.
- Audit runs the real Retention Audit Workflow.
- Retention Audit Canvas opens inside `/agent` beside chat.
- Worklin asks before preparing safe fixes.
- User can say `fix all` or `fix all this` to run safe prepare-only Audit Fix Run.
- Prepared Fix Package opens inside `/agent` beside chat.
- Live send/schedule/sync/go-live requests are refused.

Safety:

- No Klaviyo writes.
- No sending.
- No scheduling.
- No segment/profile sync.
- No flow creation/update.
- No live go-live behavior.

### PR #40: Audit Fix Run v0

Status: completed and merged into `main`.

URL:

```text
https://github.com/Logarn/ai-retention-marketer-/pull/40
```

Latest main commit after merge:

```text
02675ed Add audit fix run v0 (#40)
```

Adds:

- `POST /api/audits/fix-run`
- persisted prepare-only fix package as WorkflowRun type `audit-fix-run`

Behavior:

- Loads a persisted `retention-audit` WorkflowRun.
- Produces grouped safe prepared fixes in:
  - campaigns
  - flows
  - audiences
  - performance
  - suppression
- Every prepared or blocked item has:
  - `externalActionTaken: false`
  - `canGoLiveNow: false`
- Returns blocked items with explanations when Worklin cannot safely prepare a fix.

Safety:

- Prepare-only.
- No Klaviyo draft creation.
- No flow creation/update.
- No segment creation/update.
- No profile sync.
- No sending.
- No scheduling.
- No Klaviyo writes.

### PR #39: Audit Canvas / Visual Summary v0

Status: completed and merged into `main`.

URL:

```text
https://github.com/Logarn/ai-retention-marketer-/pull/39
```

Latest main commit after merge:

```text
90f6b6d Add retention audit canvas v0 (#39)
```

Behavior:

- Renders real Retention Audit Workflow output.
- Primary experience is inside `/agent/workflows` and now supports in-agent canvas patterns.
- `/audits/retention` may exist as a secondary/dev route.
- Uses real connected-account audit data, not mock data.
- Inspired by Kraymer-style audit structure:
  - executive summary
  - product truth
  - campaign truth
  - flow truth
  - audience truth
  - lifecycle coverage
  - priority matrix
  - action preview
  - caveats/data confidence

Safety:

- Visualizes persisted audit output.
- No Klaviyo writes.
- No sending.
- No scheduling.

### PR #38: Retention Audit Workflow v0

Status: completed and merged into `main`.

URL:

```text
https://github.com/Logarn/ai-retention-marketer-/pull/38
```

Latest main commit after merge:

```text
43d21f5 Add retention audit workflow v0 (#38)
```

Adds:

- `POST /api/audits/retention`

Behavior:

- Orchestrates product, campaign, flow, audience, and metric/performance readiness.
- Returns:
  - summary
  - overallRetentionHealth
  - domainScorecards
  - lifecycleCoverage
  - topIssues
  - topOpportunities
  - prioritizedActions
  - insights
  - chartHints
  - caveats
  - sourceStatuses
  - metadata
- Persists a parent Retention Audit WorkflowRun.
- Does not pollute child campaign/flow/segment WorkflowRuns.

Safety:

- Backend-only.
- Read-only.
- No Klaviyo writes.
- No sending.
- No scheduling.

### PR #37: Klaviyo Metric Discovery / Performance Setup v0

Status: completed and merged into `main`.

URL:

```text
https://github.com/Logarn/ai-retention-marketer-/pull/37
```

Latest main commit after merge:

```text
6dea1cc Klaviyo Metric Discovery / Performance Setup v0
```

Behavior:

- Adds read-only metric discovery.
- Helps identify likely Klaviyo conversion metrics.
- Keeps missing/unsupported metric access caveated.
- Does not select a metric permanently yet.
- Does not write env/config.

Safety:

- Read-only.
- No env/config writes.
- No Klaviyo object writes.
- No permanent metric selection.

### PR #36: Segment / Audience Audit v0

Status: completed and merged into `main`.

URL:

```text
https://github.com/Logarn/ai-retention-marketer-/pull/36
```

Latest main commit after merge:

```text
7c1fac6 Segment / Audience Audit v0 (#36)
```

Behavior:

- Adds operator-grade audience audit output.
- Includes:
  - `audienceQualityScorecard`
  - `audienceBuildPlan`
  - `lifecycleActivationMatrix`
  - `suppressionRisks`
  - `nextAudienceQuestions`
  - suppression guardrail insight
  - product-interest dedupe fix
- Uses Klaviyo audience inventory where available plus local customer/order/event signals.
- Returns caveats when Klaviyo audience reads or local signals are incomplete.

Safety:

- Read-only.
- No segment/profile sync.
- No Klaviyo writes.

## Current Roadmap

Completed audit-to-fix milestone:

1. Segment / Audience Audit v0
2. Klaviyo Metric Discovery / Performance Setup v0
3. Retention Audit Workflow v0
4. Audit Canvas / Visual Summary v0
5. Audit Fix Run v0
6. Agent Audit Starter + Fix Confirmation v0
7. Durable Approval State v0
8. Action Log v0

Current next/pending:

1. Tool Execution Runtime v0
2. Results Ingestion + Learning Loop
3. Recommendation Outcome Tracking
4. Campaign Fix Executor / Audit -> Campaign Workflow Integration
5. Flow Fix Package / Audit -> Flow Build Plan v0
6. Audience Fix Package / Segment Definition Builder
7. Segment/Profile Sync v0
8. Flow Definition Builder v0
9. Klaviyo Flow Creation / Update v0
10. Send/Schedule Execution
11. Skill Registry / Skill Runner v0
12. Web Research Tool v0
13. Cron Jobs / Scheduled Checks v0
14. Heartbeats / Proactive Recommendation Queue
15. BYOK + AI Settings
16. Nano Banana / Gemini Visual Layer
17. Image-heavy Email Understanding
18. Sub-agents / Child Workflows

Roadmap notes:

- Action Log v0 is now merged and provides durable history for what was proposed, approved, rejected, revised, skipped, blocked, and eventually executed.
- Tool Execution Runtime v0 should remain guarded and separate from approval state.
- Results Ingestion + Learning Loop should connect outcomes back to recommendations and future audits.
- Skills should be defined later through a Q&A session where Steve explains his expert process and Worklin converts it into repeatable skills.
- Build future features closer to 80% useful v0s, not ultra-thin slices, while preserving safety.
- Audit outputs should be chart/visual-ready for founders/CMOs, not giant walls of text.
- Future executors must preserve the current prepare/approve/execute separation.

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
- Use Product Performance Intelligence, Flow Audit, Campaign Audit, Segment / Audience Audit, Metric Discovery, Retention Audit Workflow, Audit Fix Run, and Durable Approval State as reusable substrate for future audit-to-fix work.
- Use Audit Insight Framework for all new audit findings so outputs are ranked, evidenced, caveated, and chart-ready.
- Preserve existing `/agent`, `/agent/workflows`, `/planner`, Klaviyo, product, flow, campaign, audience, metric, audit, approval, and performance routes while adding new features.
- Do not add scheduling, sending, autopilot, external live actions, PDF ingestion, Slack automation, profile sync, or Klaviyo flow creation until explicitly requested.
