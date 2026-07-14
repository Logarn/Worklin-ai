# Copybook Contract

## Contents

- Hierarchy
- Record persistence
- Monthly input pack
- Campaign brief
- Workflow states
- Approval and safety

## Hierarchy

Treat the annual copybook as navigation and metadata, not one model context:

```json
{
  "copybook_id": "",
  "brand_id": "",
  "year": 2026,
  "months": [
    {
      "month_id": "",
      "month": 1,
      "document_surface_id": "",
      "stage": "inputs_draft",
      "strategy_revision": 0,
      "brief_revision": 0,
      "copy_revision": 0,
      "campaigns": []
    }
  ]
}
```

Use stable identifiers when the host supports them. Never infer approval from the presence of generated content.

## Record Persistence

When the host provides the included Copybook Records skill, use it as the write path for annual copybook, month, campaign, and approval state. Keep these responsibilities separate:

| Surface | Responsibility |
| --- | --- |
| Structured copybook records | Stable IDs, stage, revision, approval history, and immutable snapshots |
| Editable month document | Human editing, comments, strategy, briefs, copy, and designer directions |
| Chat | Concise progress, blockers, warnings, and explicit approval requests |

`copybook_month_create` returns the month record with `documentSurfaceId`. Treat that value as the canonical editable surface for the lifetime of the month:

1. Capture `month.documentSurfaceId` from the mutation result.
2. Stop if the value is absent; do not invent or create another surface.
3. Call `document_open` with the returned surface ID.
4. Call `document_update` repeatedly against that same surface ID to stream strategy, briefs, copy, and designer directions.
5. Use targeted document edits for later human or comment-led revisions so comment anchors and unrelated approved content remain intact.

Do not call `document_create`, `file_write`, `host_file_write`, or any generic workspace-file tool for copybook content. Do not save a parallel Markdown copy or paste the full copybook into chat. A failed document operation leaves the structured stage unchanged. Retry the failed operation against the same surface; if retry is not possible, report the unsaved stage or section without claiming persistence.

After every record mutation, check the returned state before describing the transition as complete. A failed or unavailable persistence call does not authorize a local-only state advance. When structured record tools are unavailable, retain this contract in the document, mark persistence as unavailable, and do not claim that an approval or `ready_for_design` snapshot was recorded.

Record mutations are limited to Worklin's internal copybook state. They never authorize visual design generation, provider draft creation, sending, scheduling, flow activation, audience or profile mutation, or shop writes.

## Monthly Input Pack

```json
{
  "period": "YYYY-MM",
  "monthly_objective": "",
  "founder_direction": [],
  "launches": [],
  "holidays_and_moments": [],
  "promotions": [
    {
      "name": "",
      "terms": "",
      "verified_start": null,
      "verified_end": null,
      "source": "",
      "status": "verified | incomplete | proposed"
    }
  ],
  "content_priorities": [],
  "product_priorities": [],
  "cadence": { "email": null, "sms": null },
  "confirmed_prior_results": [],
  "audience_constraints": [],
  "claim_and_compliance_constraints": [],
  "source_freshness": [],
  "assumptions": [],
  "conflicts": [],
  "missing_material_inputs": []
}
```

Every factual launch, promotion, deadline, price, inventory, testimonial, and performance claim needs a source and status. A proposed idea is not a verified fact.

## Campaign Brief

```json
{
  "campaign_id": "",
  "title": "",
  "channel": "email | sms",
  "proposed_send_date": "YYYY-MM-DD",
  "status": "brief_draft | brief_review | brief_approved | copy_draft | copy_review | ready_for_design",
  "objective": "",
  "ideal_result": "",
  "success_metric": "",
  "audience": {
    "segment": "",
    "triggering_situation": "",
    "desired_outcome": "",
    "primary_objection": "",
    "exclusions": []
  },
  "angle": "",
  "why_now": "",
  "offer": "",
  "key_message": "",
  "proof_ids": [],
  "required_qualifications": [],
  "primary_cta": "",
  "required_sources": [],
  "test_hypothesis": null,
  "design_requirements": [],
  "assumptions": [],
  "risk_flags": []
}
```

A brief must explain the campaign's job in the month, not merely name a topic. Keep one primary objective, angle, objection, and CTA unless the campaign is explicitly navigational.

## Workflow States

Allowed month stages:

```text
inputs_draft
  -> strategy_review
  -> strategy_approved
  -> brief_review
  -> briefs_approved
  -> copy_review
  -> ready_for_design
```

`blocked` may accompany any stage with a reason. Returning to an earlier stage creates a new revision; it does not overwrite approval history.

Required gates:

| Transition | Requirement |
| --- | --- |
| `strategy_review` -> `strategy_approved` | Explicit human approval of a named strategy revision |
| `brief_review` -> `briefs_approved` | Explicit human approval of the included brief revision |
| `copy_review` -> `ready_for_design` | Blocking QA passed, no open blocking comments, explicit human approval of a named copy revision |

Do not combine these into one blanket approval.

## Revision Snapshot

```json
{
  "revision_id": "",
  "scope": "strategy | briefs | campaign_copy | month_copy",
  "scope_id": "",
  "revision": 1,
  "content_hash": "",
  "created_at": "",
  "created_by": "assistant | human",
  "approval": {
    "status": "not_requested | requested | approved | changes_requested",
    "approved_by": null,
    "approved_at": null
  },
  "qa_summary": null,
  "open_warning_ids": []
}
```

An approval refers to one immutable revision. Any substantive edit after approval produces a new revision and returns the affected scope to review.

## Approval And Safety

Every structured stage result includes:

```json
{
  "artifactOnly": true,
  "externalActionTaken": false,
  "canGoLiveNow": false,
  "approvalStatus": "required | approved | blocked",
  "blockedCapabilities": [
    "visual_design_generation",
    "provider_draft_creation",
    "campaign_send",
    "campaign_schedule",
    "flow_activation",
    "audience_or_profile_mutation",
    "shop_write"
  ],
  "caveats": []
}
```

`ready_for_design` never changes these safety values. It authorizes only the copy snapshot's handoff to a human designer.
