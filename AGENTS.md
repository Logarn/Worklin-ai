# Worklin Codex Operating Manual

Use this file for standing project rules. Read `WORKLIN_CONTEXT_HANDOFF.md` for current merged state, roadmap, and the next recommended feature.

## 1. Product North Star

Worklin is an agent-first autonomous retention operating system for DTC brands. The long-term goal is a personalized campaign factory: many precise micro-campaigns mapped to micro-segments, with scoring, arbitration, QA, approvals, learning, and eventually safe autopilot.

## 2. Current Product Posture

- Primary UX is `/agent` with side canvas.
- Older dashboard/manual UX exists, but treat it as legacy/internal unless the task explicitly asks to refactor it.
- Do not build dashboard-first features unless requested.
- Keep major workflow output inside the agent-led experience when there is a choice.

## 3. Architecture Layers

- Source truth: Shopify/local commerce data, Klaviyo reads/snapshots, Brand Brain, campaign memory, playbooks, uploaded sources.
- Workspace context: compact Context Pack summaries for workflows, skills, and agent routing.
- Skills: reusable safe procedures and skill-runner paths, with explicit safe modes.
- Customer intelligence engine: unified identity, feature store, rule-based scoring, micro-segment definitions, campaign opportunities.
- Campaign factory: planner, brief generator, QA, approval, draft-only handoff, micro-campaign packages.
- Governance and safety: approval state, action log, tool registry/runtime, execution gates, audit/fix prepare-only paths.
- Proactive autonomy: future scheduled observation, arbitration, recommendations, approvals, learning, and policy-bound autopilot.

## 4. Safety Defaults

By default, do not send, schedule, perform live Klaviyo writes, perform Shopify writes, sync profiles, create segments, create flows, or take external live actions.

Draft-only and read-only behavior is allowed only through existing safe paths. Any live action must be explicitly requested, supported by the existing safety model, and approved in the task.

## 5. Protected Files And State

Do not touch these unless explicitly requested:

- `.env`, `.env.local`, secrets, tokens, or local credentials
- unrelated files outside the task scope
- `approval-gate-v0-wip` stash
- `WORKLIN_CONTEXT_HANDOFF.md`

For feature work, leave handoff updates out unless the user asks for a handoff refresh.

## 6. Codex Workflow

- Inspect the repo before changing files.
- Propose a short plan when the implementation path is not obvious.
- Build focused features that match existing patterns.
- Prefer backend-only/read-only/prepare-only work unless the task says otherwise.
- Stop before commit, push, PR, or merge unless the user asks for that step.
- Report compactly: what changed, files touched, tests run, caveats, and protected-file confirmation.
- Do not over-explain routine checks.

## 7. Testing Expectations

- For build turns, run focused checks around the touched surfaces.
- For PR prep, run fuller QA.
- Include `npm run build`, `git diff --check`, relevant API route checks, and regressions around changed workflows.
- For schema changes, run Prisma validate, generate, and migrate deploy.
- If the local app database has stale migration state, validate migrations against a clean scratch database and report the caveat.

## 8. PR Conventions

- Use feature branches named `feature/...` or `codex/...`.
- Open draft PRs unless told otherwise.
- Do not merge without explicit approval.
- Stage only expected files.
- Report PR URL, commit SHA, files changed, tests, and protected-file confirmation.

## 9. Legacy UX Policy

- Do not delete old UX without inventory and review.
- Hide, gate, or refactor legacy surfaces into the agent-first flow over time.
- Keep useful planner, brief, QA, approval, and draft code as campaign-factory hands.
- Avoid expanding legacy dashboard/manual workflows unless the task specifically asks for it.

## 10. Source Of Current Truth

- `AGENTS.md` contains standing operating rules.
- `WORKLIN_CONTEXT_HANDOFF.md` contains changing project state, latest merged milestones, roadmap, and next feature guidance.
- Read `WORKLIN_CONTEXT_HANDOFF.md` first when starting new Worklin feature work or when the user asks to update context.

## Framework Note

This repo uses a modern Next.js App Router stack. If framework behavior seems surprising, inspect the local installed docs or existing code before assuming older Next.js conventions.
