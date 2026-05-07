# Worklin AI Handoff Context

Use this file to start a new Codex/chat session with enough context to continue Worklin AI without rereading the whole prior thread.

Last updated: 2026-05-07

## Product Summary

Worklin AI is an audit-first, chat-led retention operating system for Shopify/DTC brands.

Worklin helps lifecycle/CRM teams turn Shopify/local commerce data, Klaviyo reads, brand knowledge, campaign history, playbooks, performance memory, and audit findings into:

- product intelligence
- campaign, flow, audience, and full-retention audit insights
- executive-ready visual audit canvases
- prepare-only fix packages
- durable approval state
- durable action logs
- later: guarded tool execution, outcome learning loops, scheduled checks, proactive heartbeat recommendations, and governed go-live execution

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
PR #44 verification: public GitHub API reported state=closed, draft=false, merged_at=2026-05-07T06:54:14Z, base=main, head=feature/action-log-v0
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

Worklin is now audit-first and chat-led.

Current core loop:

```text
User opens /agent
-> Worklin offers to audit retention setup
-> user can request audit anytime
-> Worklin runs the real Retention Audit Workflow
-> Retention Audit Canvas opens beside chat inside /agent
-> Worklin asks whether to prepare safe fixes
-> user says "fix all" / "fix all this"
-> Worklin runs prepare-only Audit Fix Run
-> Prepared Fix Package opens beside chat
-> nothing is sent, scheduled, synced, or changed live
```

The magical end-state is not audit-to-plan. It is audit-to-fix:

```text
Audit -> user confirms "fix all this" -> Worklin prepares safe fixes in background -> returns one approval-ready package -> user approves/revises -> future governed execution runtime handles allowed actions
```

Important current limitation:

- Worklin can audit, prepare safe fixes, persist approval state, and log important events.
- Worklin does not execute approved work yet.
- External live actions remain blocked.

## Current Architecture Spine

Worklin now has an audit-to-fix agent spine:

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
       Product, Order, OrderItem, Customer, CustomerEvent -> Product Performance Intelligence
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
       Durable records for audits, fix runs, approval transitions, refusals, failures, and future execution events
  -> Shared Audit Layer
       Audit Insight Framework -> ranked insights, evidence, caveats, recommended actions, chart hints
```

Useful audits should not jump from raw Klaviyo data to generic recommendations. Worklin needs product truth, asset truth, audience truth, evidence, confidence, caveats, and executive-friendly summaries before recommending action.

## Canvas UX Principle

Any major visual output should appear inside the `/agent` chat experience as a side or inline canvas where possible.

Standalone routes like `/agent/workflows?workflowId=...` remain fallback/deep-link routes, but the primary user experience should keep the user in conversation with Worklin.

This applies to:

- Retention Audit Canvas
- Prepared Fix Package
- campaign plans
- campaign briefs
- flow build plans
- audience packages
- QA reports
- performance reports
- future heartbeat reports

`/audits/retention` may exist as a secondary/dev route, but the primary product path should use real connected-account data inside the agent workflow/canvas pattern, not mock data.

## Current Safety Rules

Non-negotiable safety posture:

- No sending.
- No scheduling.
- No live Klaviyo destructive actions.
- No flow creation/update yet.
- No segment/profile sync yet.
- Audits and reads are read-only.
- Audit Fix Run is prepare-only.
- Durable Approval State only records approval; it does not execute actions.
- Action Log records events; it does not execute actions.
- Klaviyo campaign creation remains draft-only through existing guarded flows.
- Klaviyo campaign/flow/audience/metric/performance reads are read-only.
- `KLAVIYO_DRAFT_ONLY=true` is required for Klaviyo write-adjacent behavior.
- Agent approval means draft creation only in the existing campaign approval path, never send/schedule.
- Approval of an audit-fix-run does not create drafts, flows, segments, syncs, sends, or schedules.
- LLM interprets; deterministic router validates and executes.
- Raw LLM output must never directly trigger Klaviyo drafts or external actions.
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

Latest audit-to-fix and governance layers:

- Segment / Audience Audit v0
- Klaviyo Metric Discovery / Performance Setup v0
- Retention Audit Workflow v0
- Audit Canvas / Visual Summary v0
- Audit Fix Run v0
- Agent Audit Starter + Fix Confirmation v0
- Durable Approval State v0
- Action Log v0

## Recent PRs

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
- Action log routes:
  - `GET /api/action-log`
  - `GET /api/action-log/[id]`

Logs:

- retention audit completed/failed
- audit fix run prepared/failed
- approval requested
- approval approved/rejected/revision_requested
- agent live-action refusals

Behavior:

- Stores safe summaries, IDs, counts, statuses, booleans, and compact metadata.
- Supports filtering by `workflowRunId`, `targetType`, `targetId`, `eventType`, `status`, `actionType`, `actorType`, `approvalId`, `externalActionTaken`, `canGoLiveNow`, and `limit`.
- Logging is best-effort; if ActionLog creation fails, main workflows still return safely.

Safety:

- No Klaviyo writes.
- No draft creation.
- No campaign/flow/segment creation.
- No profile sync.
- No sending/scheduling.
- No live external actions.
- No raw secrets, env values, auth headers, raw Klaviyo payloads, or full large audit/fix outputs are logged.

Known caveat:

- Smoke tests inserted expected local dev DB WorkflowRun, Approval, and ActionLog records into `worklin_dev_clean`.

### PR #43: Handoff Update After Audit-To-Fix Milestone

Status: completed and merged into `main`.

URL:

```text
https://github.com/Logarn/ai-retention-marketer-/pull/43
```

Latest main commit after merge:

```text
f183d58 Update Worklin handoff after audit-to-fix milestone (#43)
```

Adds:

- Docs-only handoff refresh after PRs #36-#42.
- No app code changes.

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

Safety:

- Approval only updates approval state.
- No Klaviyo writes.
- No draft creation.
- No campaign/flow/segment creation.
- No profile sync.
- No sending/scheduling.
- Approval does not run tools or mutate external systems.

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

- `/agent` starts with an audit-first offer.
- User can request a retention audit anytime via chat.
- Audit runs the real Retention Audit Workflow.
- Retention Audit Canvas opens inside `/agent` beside chat.
- Worklin asks before preparing safe fixes.
- User can say `fix all` or `fix all this` to run safe prepare-only Audit Fix Run.
- Prepared Fix Package opens inside `/agent` beside chat.
- Live send/schedule/sync/go-live requests are refused.

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
- Produces grouped safe prepared fixes in campaigns, flows, audiences, performance, and suppression.
- Every prepared or blocked item has `externalActionTaken: false` and `canGoLiveNow: false`.
- Returns blocked items with explanations when Worklin cannot safely prepare a fix.

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
- Retention Audit WorkflowRuns render as a visual audit canvas in `/agent` and `/agent/workflows`.
- `/audits/retention` may exist as a secondary/dev route.
- Uses real connected-account audit data, not mock data.
- Inspired by Kraymer-style audit structure: executive summary, product truth, campaign truth, flow truth, audience truth, lifecycle coverage, priority matrix, action preview, and caveats/data confidence.

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
- Returns summary, overall retention health, domain scorecards, lifecycle coverage, top issues, top opportunities, prioritized actions, insights, chart hints, caveats, source statuses, and metadata.
- Persists a parent Retention Audit WorkflowRun.
- Does not pollute child campaign/flow/segment WorkflowRuns.

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
- Includes `audienceQualityScorecard`, `audienceBuildPlan`, `lifecycleActivationMatrix`, `suppressionRisks`, `nextAudienceQuestions`, suppression guardrail insight, and product-interest dedupe fix.
- Uses Klaviyo audience inventory where available plus local customer/order/event signals.
- Returns caveats when Klaviyo audience reads or local signals are incomplete.

## Current Roadmap

Next feature:

1. Tool Execution Runtime v0

Stable roadmap:

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

- Tool Execution Runtime v0 should come next because approvals and action logs now exist, but approved work still cannot execute.
- Tool Execution Runtime v0 should remain guarded and separate from approval state.
- Results Ingestion + Learning Loop should connect outcomes back to recommendations and future audits.
- Skills should be defined later through a Q&A session where Steve explains his expert process and Worklin converts it into repeatable skills.
- Build future features closer to 80% useful v0s, not ultra-thin slices, while preserving safety.
- Audit outputs should be chart/visual-ready for founders/CMOs, not giant walls of text.
- Future executors must preserve the current prepare/approve/execute separation.

## Tools And Skills Architecture Note

We do not know all future tools upfront.

Worklin should have:

- an extensible tool/capability registry
- a missing-capability loop when a requested action cannot be safely completed yet
- atomic tools that perform narrow capabilities
- skills that compose tools, memory, expert judgment, and safety checks into repeatable procedures

Even "reading" can be a skill when it involves interpreting context, extracting evidence, and deciding what matters.

## Working Process Rules

Handoff update cadence:

- Do not update `WORKLIN_CONTEXT_HANDOFF.md` after every feature.
- Update it after meaningful work blocks, several PRs, major context shifts, end-of-day, or before a fresh Codex chat.
- Handoff updates should be docs-only unless the user explicitly asks for product work in the same branch.

Collaboration loop:

- Codex works stepwise.
- The user shares Codex output with ChatGPT for review before the next instruction.
- Codex should not run away through feature build/test/merge without review.
- Merge prompts must be explicit and require final status reporting.

Testing expectations:

- Manual UI testing is required for UI, agent behavior, approval flows, Klaviyo safety-critical work, and any canvas/workflow experience.
- Tests must be meaningful regressions, not happy-path-only.
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
- Let approval state or action log entries imply execution.

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
- For approval/action-log work, verify:
  - request approval for a real `audit-fix-run` WorkflowRun
  - duplicate pending approval behavior when relevant
  - pending -> approved
  - pending -> rejected
  - pending -> revision_requested
  - invalid transitions return safe `409`
  - invalid/unsupported targets return safe errors
  - approval list/detail routes work
  - action log list/detail/filter routes work
  - invalid action log id returns safe `404`
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
- Use Product Performance Intelligence, Flow Audit, Campaign Audit, Segment / Audience Audit, Metric Discovery, Retention Audit Workflow, Audit Fix Run, Durable Approval State, and Action Log as reusable substrate for future audit-to-fix work.
- Use Audit Insight Framework for all new audit findings so outputs are ranked, evidenced, caveated, and chart-ready.
- Preserve existing `/agent`, `/agent/workflows`, `/planner`, Klaviyo, product, flow, campaign, audience, metric, audit, approval, action-log, and performance routes while adding new features.
- Do not add scheduling, sending, autopilot, external live actions, PDF ingestion, Slack automation, profile sync, or Klaviyo flow creation until explicitly requested.
