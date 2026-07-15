---
name: worklin-brand-brain
description: Read and maintain Worklin's persisted Brand Brain for the current brand. Use through write-brand-copy to select a stored brand, persist explicit user-approved voice or messaging corrections, and record verified campaign outcomes without inventing evidence.
metadata:
  emoji: "🧠"
  vellum:
    category: content
    display-name: Worklin Brand Brain
    activation-hints:
      - "Use the persisted Worklin Brand Brain"
    avoid-when:
      - "The task does not involve brand context, copy rules, or campaign learning"
---

# Worklin Brand Brain

Use the injected persisted profile first. If multiple profiles exist and none is bound to the conversation, call `brand_brain_read` with the user's brand name or website.

Call `brand_brain_apply_correction` only when the user directly corrects or explicitly approves a durable brand rule, phrase, CTA, audience note, positioning statement, or compliance constraint. Set `explicitly_approved` to true only in that case. Do not infer a durable preference from one edit or from generated copy.

Call `brand_brain_record_campaign_outcome` only when the user supplies or confirms an actual result and there is a concrete evidence note. Set `result_confirmed` to true only in that case. Treat stored campaign outcomes as dated priors, not universal laws.

When `worklin-brand-research` is active, use `brand_research_save` after the
main assistant has synthesized a complete public research report. The report
must declare `brand_research_v1`, `readOnly: true`, `publicSourcesOnly: true`,
and `unsupportedClaimsExcluded: true`. Research findings remain observations
or qualified inferences; they are not approved claims, voice rules, or
customer quotations.

Never store generated claims, invented customer language, speculative outcomes, or private credentials in Brand Brain.
