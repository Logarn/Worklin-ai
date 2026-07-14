---
name: worklin-copybook
description: Maintain Worklin's structured campaign copybooks for monthly strategy, email and SMS briefs, human review gates, and approved design handoff. Use through campaign-copybook; never design, send, schedule, publish, or mutate an external marketing platform.
metadata:
  emoji: "📝"
  vellum:
    category: content
    display-name: Worklin Copybook
    activation-hints:
      - "Create or update a campaign copybook"
    avoid-when:
      - "The task does not involve monthly campaign strategy, email, or SMS copy"
---

# Worklin Copybook

Use these tools only to maintain Worklin's local structured copybook state. Use `copybook_list` before creating a copybook for a brand and year. The brand ID should come from the persisted Brand Brain workflow.

Create a month before creating its email or SMS campaigns. `copybook_month_create` returns that month's canonical `documentSurfaceId`; pass it to the included Document Editor's `document_open` and `document_update` tools. Keep the editable strategy, brief, copy, CTA placement, and visual directions in that one linked Worklin document; keep campaign metadata compact and structural. Never create a second document for the month or use a generic file-write tool as a fallback.

Move strategy and campaigns through review in order. Set `explicitly_approved:true` only after a human directly approves the monthly strategy, campaign copy, or design handoff. Approval tools save immutable document snapshots and attribute them to the trusted actor when available.

These tools do not create designs and cannot send, schedule, publish, activate, or mutate Shopify, Klaviyo, or another external platform. `ready_for_design` is a local handoff state only.
