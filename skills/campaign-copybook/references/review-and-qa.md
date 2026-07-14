# Review And QA

## Review Loop

1. Read the current document revision and list open comments.
2. Classify each top-level comment as `actionable`, `ambiguous`, `conflicting`, or `non_blocking_note`.
3. For actionable feedback, make a targeted edit before replying or resolving.
4. For ambiguous feedback, reply with one concise clarification question. Do not guess and do not resolve it.
5. For conflicting feedback, identify the conflict and request a human decision.
6. Re-run affected copy and claim QA after substantive edits.
7. Resolve only comments actually addressed. Keep replies attached to their parent comment.

Prefer targeted replacement over full-document replacement during review. Comment anchors may be character offsets; broad rewrites can detach them and can discard unrelated human edits.

## Comment Severity

- `blocking`: factual correction, unsupported claim, wrong offer terms, legal/compliance issue, wrong audience, broken CTA, missing required content, explicit request for changes
- `warning`: preference, alternative phrasing, optional test, non-critical asset suggestion
- `question`: clarification with no requested change yet

Any open blocking comment prevents `ready_for_design`.

## Campaign QA Record

```json
{
  "campaign_id": "",
  "copy_revision": 1,
  "status": "passed | warnings | blocked",
  "checks": [
    {
      "id": "",
      "status": "passed | warning | failed",
      "message": "",
      "evidence_or_location": ""
    }
  ],
  "unsupported_claims_removed": [],
  "open_warning_ids": [],
  "externalActionTaken": false,
  "canGoLiveNow": false
}
```

## Blocking QA Checks

Fail the campaign when any of these is true:

- the copy no longer matches the approved objective, audience, angle, offer, or CTA
- a material claim lacks evidence, scope, qualification, or required disclosure
- a quote, testimonial, review, statistic, certification, result, deadline, inventory limit, or scarcity mechanism is fabricated or altered
- the subject/hook creates a payoff the body does not satisfy
- the product or content is not causally connected to the argument
- a material offer term is missing or hidden
- the CTA destination is invented, unverified, or mismatched
- the copy uses shame, coercion, sensitive-personal-attribute targeting, or unbounded health/performance promises
- required suppression or audience exclusions are absent from the brief
- email lacks required subject, preview, body, CTA placement, or terms
- SMS lacks final message, CTA/link posture, required disclosure, or channel constraint check

Warnings do not disappear because the copy receives a high average score. Record them for human review.

## Cross-Campaign QA

After individual QA, check the month as a sequence:

- repeated angles, hooks, products, or CTAs
- conflicting offers or dates
- cadence clustering and audience fatigue
- missing launch, holiday, content, or founder priority
- SMS merely duplicating email instead of serving a distinct role
- strategic progression from awareness or education toward the intended monthly result

## Approval

Approval must name the scope and revision. Valid examples include approval of strategy revision 2, all briefs in brief revision 1, or campaign copy revision 3.

Direct edits, silence, resolved comments, and prior-month approval are not approval.

When approval is explicit:

1. Verify no open blocking comments or failed QA checks remain.
2. Create or identify the immutable revision snapshot.
3. Record the reviewer, decision time, caveats, and open warnings.
4. Mark the month or campaign `ready_for_design`.
5. Stop and report that the copy snapshot is ready for human designer handoff only.

Never proceed to visual design, provider drafts, publishing, sending, scheduling, flow activation, or external mutation.
