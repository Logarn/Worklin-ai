---
name: plan-skill
description: Use when an agent needs to create, revise, or review implementation plans in the repository's plans/ directory, especially when the user asks for a plan before implementation, asks to standardize planning, asks to incorporate reviewer feedback into a plan, or asks whether an existing plan follows repo methodology.
metadata:
  emoji: "🧭"
  vellum:
    category: "development"
    display-name: "Implementation Planning"
---

# Plan Skill

## Purpose

Use this skill to write plans that another engineer can execute with minimal ambiguity. Plans in this repo should be grounded in current code and docs, explicit about scope and risk, and clear about what will be implemented now versus deferred.

## Workflow

1. Read the request and identify the feature/domain.
2. Read `.codex/AGENTS.md` when present and follow its methodology.
3. Establish the baseline before planning:
   - Read the relevant `docs/<feature>` folder.
   - Read related code paths, routes, components, workers, utilities, tests, migrations, schemas, and existing plans.
   - Separate shipped behavior from desired behavior, assumptions, and future ideas.
4. Choose the plan location:
   - Prefer `plans/<feature>/<kebab-case-title>-plan.md` when a feature folder exists or should clearly exist.
   - Use `plans/<kebab-case-title>-plan.md` only for cross-cutting or one-off plans with no natural feature folder.
   - Use kebab-case filenames ending in `-plan.md`.
5. Write the plan. Do not implement unless the user explicitly asks to proceed.
6. When revising a plan from external feedback, verify each claim against code/docs before accepting it. Classify comments as must-fix, valid but future, non-issue, or already covered.

## Standard Plan Shape

Use only the sections that fit the work, but keep this order unless there is a strong reason to change it.

```markdown
# <Feature Or Problem> Plan

## Objective

Explain why the plan exists, the user/business problem, and the intended outcome.

## Methodology From `.codex/AGENTS.md`

Summarize the baseline work performed: docs read, code paths traced, scope boundaries, implementation expectations, and test/documentation expectations.

## Baseline Findings

Describe current shipped behavior, relevant architecture, data flows, schema/contracts, tests, docs, and known gaps.

## Scope

List what is in scope and out of scope. Call out live integrations, compatibility promises, data boundaries, security boundaries, and non-goals.

## Desired Behavior

Define the target behavior in plain language. Use tables or small contracts when they reduce ambiguity.

## Key Changes

Group proposed changes by subsystem: API, worker, database, UI, caching, docs, tests, migrations, deployment, or feature-specific modules.

## Implementation Plan

Break work into phases or ordered steps. Include rollback/fallback behavior when relevant.

## Public Interfaces

List new or changed APIs, types, constants, env vars, database columns, migrations, artifacts, routes, files, and user-visible behavior. Explicitly say "No database migration" or "No API response shape change" when true.

## Data Boundary And Security

Use for authz, PII, financial/customer data, service-role access, RLS, external APIs, or customer-facing trust claims.

## Test Plan

Specify unit, integration, browser, smoke, migration, and typecheck coverage. Tests should exercise app-used functions and contracts, not unused helpers.

## Documentation Plan

List docs folders/files to update. Put unimplemented ideas in `future-improvements.md`, not current-behavior docs.

## Rollout Plan

Use for flags, staged release, backward compatibility, production migrations, retry/backfill, and operational monitoring.

## Risks And Guardrails

Call out failure modes, performance/cost risks, live-system regressions, access-control risks, and mitigations.

## Acceptance Criteria

State how we know the work is done.

## Future Improvements

Defer useful but non-essential work here.

## Assumptions

List assumptions that materially affect the plan.
```

## Repo Planning Conventions

- Start with an `Objective`; readers should know why the plan matters without reading the thread.
- Include a methodology/baseline section for non-trivial work. Name the docs and code paths actually inspected.
- Prefer evidence over assertion. If a claim matters, ground it in current implementation, schema, tests, docs, logs, or reference data.
- Preserve live behavior by default. For live integrations, explicitly state compatibility, rollout, migration, and fallback behavior.
- Distinguish constants, env vars, migrations, and public API contracts. If a flag should be code-static instead of env-driven, say so.
- Do not overfit to a single incident. Capture the general failure mode and add tests or docs that prevent recurrence.
- Avoid vague implementation bullets such as "improve the service." Name the subsystem and the concrete behavior change.
- Keep plans current-tense about the proposal, not shipped behavior. After implementation, move reality into `docs/`.
- If the plan touches data ingestion, metering, exports, auth, permissions, or financial/customer data, include a data-boundary/security section.
- If reviewer feedback is incorporated, add or update a short "Reviewer Corrections Incorporated" section only when it helps future readers understand why the plan changed.

## Quality Bar

A good plan should answer:

- What problem are we solving and why now?
- What exists today?
- What exactly changes?
- What stays unchanged?
- What can regress?
- How do we test it?
- What docs change?
- How do we roll it out or back out?
- Which ideas are intentionally deferred?

If those answers are not clear, keep studying before writing the plan.
