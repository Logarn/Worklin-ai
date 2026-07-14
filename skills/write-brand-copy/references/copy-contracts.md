# Copy Contracts

## Input Contract

```json
{
  "objective": "attention | retention | sharing | lead | sale | education",
  "campaign_id": null,
  "proposed_send_date": null,
  "channel": "email | sms | organic_social | paid_social | landing_page | ecommerce | short_video | long_video",
  "funnel_stage": "unaware | problem_aware | solution_aware | product_aware | returning_customer",
  "involvement_level": "low | medium | high",
  "audience": {
    "segment": "",
    "triggering_situation": "",
    "desired_outcome": "",
    "knowledge_state": "",
    "current_alternative": "",
    "objections": [],
    "language_from_research": []
  },
  "offer": {
    "product": "",
    "outcome": "",
    "mechanism": "",
    "price": null,
    "included": [],
    "risk_reversal": "",
    "verified_deadline": null,
    "verified_inventory": null
  },
  "proof_inventory": [
    {
      "proof_id": "",
      "claim_supported": "",
      "evidence": "",
      "source": "",
      "allowed_scope": "",
      "date": ""
    }
  ],
  "brand_profile": {
    "source": "worklin_brand_brain | supplied_brief | current_conversation",
    "readiness": "ready | partial | missing",
    "speaker": "",
    "traits": [],
    "approved_examples": [],
    "forbidden_patterns": [],
    "approved_ctas": [],
    "caveats": []
  },
  "primary_cta": "",
  "constraints": [],
  "regulated_context": "",
  "success_metric": ""
}
```

`language_from_research` must contain actual observed language and provenance. Do not invent voice-of-customer quotations.

Infer `involvement_level` from price, risk, familiarity, switching cost, reversibility, decision-makers, and buying-cycle length when it is not supplied. Increase mechanism, proof, comparison, implementation detail, and objection handling as involvement rises.

## Claim Ledger Entry

```json
{
  "claim": "",
  "status": "VERIFIED | QUALIFIED_INFERENCE | ASPIRATIONAL | UNSUPPORTED",
  "proof_id": null,
  "allowed_scope": "",
  "required_qualification": "",
  "prohibited_rewrite": ""
}
```

## Output Contract

```json
{
  "strategy_summary": {
    "objective": "",
    "audience_state": "",
    "primary_angle": "",
    "primary_objection": "",
    "mechanism": "",
    "proof_strategy": "",
    "cta_logic": ""
  },
  "primary_artifact": "",
  "artifact_sections": [
    {
      "section_id": "",
      "function": "header | body | proof | product | testimonial | cta | terms | sms_message",
      "copy": "",
      "placement": "",
      "required": true
    }
  ],
  "design_handoff": {
    "visual_hierarchy": [],
    "asset_needs": [],
    "cta_placements": [],
    "proof_or_testimonial_placements": [],
    "mobile_notes": [],
    "terms_that_must_remain_visible": []
  },
  "hook_variants": [
    {
      "hook": "",
      "family": "",
      "information_gap": "",
      "payoff_required": ""
    }
  ],
  "cta_variants": [],
  "claim_ledger": [],
  "unsupported_claims_removed": [],
  "risk_flags": [],
  "critic_scores": {},
  "test_hypotheses": [
    {
      "variant": "",
      "changed_variable": "",
      "hypothesis": "",
      "primary_metric": "",
      "guardrail_metrics": []
    }
  ]
}
```

For SMS, also return:

```json
{
  "sms": {
    "message": "",
    "link_placeholder": "",
    "required_disclosure": "",
    "character_count": null,
    "estimated_segments": null
  }
}
```

Compute character and segment counts only when a reliable counter is available. Otherwise leave them null and flag the check for downstream tooling. Designer-direction fields describe an intended handoff; they do not authorize or generate design.

## Learning Record

Store measured outcomes only after results are available:

```json
{
  "audience_segment": "",
  "channel": "",
  "offer": "",
  "creative_strategy": "",
  "hook_family": "",
  "proof_type": "",
  "result": {},
  "confidence": "low | medium | high",
  "date_range": "",
  "known_confounds": []
}
```

Keep audience, offer, channel, and date attached. Do not turn a local winner into a universal brand rule.
