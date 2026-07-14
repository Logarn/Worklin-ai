---
name: campaign-copybook
description: Plan and produce a client-reviewable monthly email and SMS copybook from approved brand context, founder direction, launches, holidays, promotions, content priorities, and prior results. Use for annual copy docs, monthly campaign strategy, campaign calendars, briefs, copy, structured designer directions, comment-led revisions, QA, and ready-for-design approval. This skill never designs, publishes, sends, schedules, or activates campaigns.
compatibility: "Designed for Worklin assistants with a rich-text document editor"
metadata:
  emoji: "📕"
  vellum:
    category: "content"
    display-name: "Campaign Copybook"
    includes:
      - "worklin-brand-brain"
      - "worklin-copybook"
      - "document-editor"
      - "write-brand-copy"
    activation-hints:
      - "Plan this month's email and SMS campaigns"
      - "Create or update an annual campaign copy doc"
      - "Turn founder direction, launches, holidays, offers, or content into campaign briefs and copy"
      - "Address client comments and prepare approved copy for design"
    avoid-when:
      - "The user wants a single standalone copy asset with no monthly campaign workflow; use write-brand-copy"
      - "The user wants visual design, publishing, sending, scheduling, flow activation, or account mutation"
---

# Campaign Copybook

Run a staged, human-reviewed campaign production workflow while preserving the familiar annual copy-document model. The editable month document is the collaboration canvas. Structured stage records are the source of workflow truth.

## Boundaries

- Scope is monthly strategy, campaign calendar, email and SMS briefs, final copy, designer directions, review, revision, and `ready_for_design` approval.
- Never create visual designs, external provider drafts, sends, schedules, activations, audiences, segments, profiles, or store mutations.
- Never describe copy as ready to send or live. `ready_for_design` means only that the approved copy snapshot can be handed to a designer.
- Keep `externalActionTaken:false` and `canGoLiveNow:false` in every structured result.
- Do not treat inferred preferences, generated claims, or one-off edits as durable Brand Brain rules.

## Load Only What The Current Stage Needs

1. Read [copybook-contract.md](references/copybook-contract.md) before starting or resuming a copybook.
2. Read [month-template.md](references/month-template.md) when creating or updating the month document.
3. Read [review-and-qa.md](references/review-and-qa.md) for QA, comments, revisions, approval, or handoff.
4. Use the included Brand Brain skill for persisted context, the included Copybook Records skill for workflow state and immutable approval snapshots, the included Document Editor for the linked month document, and the included Brand Copywriter for each approved campaign brief.

Do not load an entire annual copybook into one generation prompt. Work one month at a time, and one campaign per copywriting call. Pass structured, approved inputs between stages.

When the host provides the included Copybook Records skill, create or update the structured annual copybook, month, and campaign records at each stage. Keep the editable month document linked to those records, but treat structured revisions and approvals as workflow truth. If record tools are unavailable, keep the same contract in the document and say plainly that the result is not persisted; never claim a transition or approval was recorded when it was not.

## Stage Workflow

### 1. Build the monthly input pack

Collect or reuse only material inputs:

- founder or operator direction
- launches, restocks, promotions, verified deadlines, and offer terms
- holidays or cultural moments relevant to the brand
- content, videos, articles, products, or proof to promote
- desired email and SMS cadence
- source freshness, prior confirmed results, exclusions, and constraints

Load durable voice, audience, offer, CTA, claim, and compliance rules from Brand Brain. Keep month-specific instructions in the input pack rather than persisting them as durable memory.

Label unknown facts and conflicts. Ask only when a missing answer changes the offer, audience, compliance posture, core argument, or calendar.

Select or create the annual copybook and month record before strategy drafting. `copybook_month_create` creates the editable month document. Capture the returned `month.documentSurfaceId`; this is the only document surface for that month. If it is absent, stop and report that the month document could not be prepared.

Call `document_open` with that surface ID before writing. Stream the month content into the same surface with multiple `document_update` calls in `append` mode. Never call `document_create`, `file_write`, `host_file_write`, or another workspace-file tool for copybook content. Never use a Markdown file or the chat transcript as the persistence fallback.

### 2. Draft monthly strategy and calendar

Create or update the month content in its existing linked document using the month template. Produce the objective, strategic narrative, message pillars, sequencing rationale, channel cadence, and proposed campaign calendar.

If `document_open` or `document_update` fails, retry the same operation against the same `month.documentSurfaceId`. Do not create a replacement document, advance the structured stage, claim that the draft was saved, or paste the full draft into chat. Report the unsaved section concisely and keep the generated section available for a retry.

Set the stage to `strategy_review` and stop. Do not draft campaign briefs or copy until a human explicitly approves the strategy. Direct edits are not approval by themselves.

Persist the named strategy revision before requesting review. After explicit approval, use the Copybook Records skill to approve that exact revision; do not advance from a chat acknowledgment alone if the persistence call fails.

### 3. Draft campaign briefs

After strategy approval, create one structured brief per calendar item. Briefs may be drafted independently in parallel, but one synthesis pass must check the month as a whole for duplication, cadence, sequencing, offer conflicts, and audience fatigue.

Render the briefs into the existing month document with `document_update`. Set the stage to `brief_review` only after those document updates succeed, then stop. Do not write final copy for an unapproved brief.

Create or update one campaign record per brief, preserving stable campaign identifiers across revisions. Record brief approval only after explicit human approval of the named revision.

### 4. Draft copy campaign by campaign

After brief approval, call the included Brand Copywriter separately for each campaign. Give it only:

- the approved brief
- the approved monthly strategy summary
- the normalized Brand Brain context
- relevant source material and proof
- the channel-specific constraints

Require the automated output contract in the Brand Copywriter's `copy-contracts.md`. Render finished copy and designer directions into the existing month surface with `document_update`; never create one document per campaign. A designer direction describes intended hierarchy, placement, or asset need; it is not visual design generation.

Persist each campaign's copy and design-handoff fields against its existing record. A persistence failure leaves that campaign in its prior stage and must be surfaced before review.

### 5. Run independent QA

Run copy quality and claim/compliance review independently from drafting. A campaign cannot enter review with a hard rejection, missing material offer term, unsupported claim, fabricated quote, fake scarcity, broken hook-payoff relationship, or absent primary CTA.

Set the stage to `copy_review` only after blocking QA failures are repaired. Keep warnings visible for human review.

### 6. Address comments and revisions

Use the document comment workflow in [review-and-qa.md](references/review-and-qa.md). Make targeted edits so unrelated approved material and comment anchors are preserved. Re-run affected QA after substantive edits.

### 7. Approve for design

Only an explicit human approval can create a versioned `ready_for_design` snapshot. Record the approved strategy revision, brief revision, copy revision, unresolved warnings, and approving actor. Open blocking comments prevent approval.

Use the Copybook Records skill for the approval transition and confirm the returned campaign state is `ready_for_design`. Never infer success from the document text or an attempted tool call.

The next action is designer handoff. Do not continue into design, provider drafts, scheduling, or sends.

## Parallel Work

Use subagents or a bounded workflow only inside a stage, for example to draft several approved briefs or independently QA several completed campaigns. Human review is a boundary between runs; never launch one unattended workflow that crosses approval stages.

Use anonymous workers for extraction and QA. Use brand-context-aware copywriting workers only for client-facing drafts. A synthesis pass remains responsible for cross-campaign coherence.

## User-Facing Communication

Keep chat concise. Put the full strategy, briefs, copy, directions, and revision history in the editable month document. In chat, state:

- what stage is complete
- what needs human review
- any blocking assumptions or warnings
- what Worklin will do after approval

Never bury the approval request beneath the generated copy.
Never expose internal planning narration, tool-selection reasoning, or self-talk. If document persistence fails, give only the affected stage or section and a retry-oriented status; do not dump the deliverable into chat.
