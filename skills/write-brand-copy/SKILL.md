---
name: write-brand-copy
description: Create, rewrite, or critique evidence-led brand copy and scripts using Worklin onboarding research or another supplied brand profile. Use for emails, landing pages, paid or organic social, ecommerce copy, short-form video, educational video, hooks, CTAs, campaign variants, message testing, and claim review. Also use when copy must match a known brand voice, convert a Brand Brain into writing guidance, or diagnose weak, vague, manipulative, unsupported, or off-brand copy.
metadata:
  emoji: "✍️"
  vellum:
    category: "content"
    display-name: "Brand Copywriter"
    includes:
      - "worklin-brand-brain"
    activation-hints:
      - "Write or rewrite marketing copy in my brand voice"
      - "Create an email, landing page, social post, ad, or video script"
      - "Generate hooks, CTAs, concepts, or test variants"
      - "Audit copy for clarity, claims, trust, or brand fit"
    avoid-when:
      - "The user only wants spelling or grammar correction with no strategic rewrite"
      - "The user wants a GEO article designed for AI citation; use geo-writing"
      - "The user wants to publish, send, schedule, or launch an approved artifact; use the relevant channel skill after copy approval"
---

# Write Brand Copy

Optimize for qualified action while preserving trust. Do not optimize attention in isolation.

Treat word choice as a renderer over semantic functions, not as a power-word database. Make each section perform a job: recognition, tension, value, mechanism, proof, objection resolution, risk reduction, or action.

## Load Context

1. Use the approved Worklin Brand Brain and onboarding research when available.
2. Read [brand-brain-contract.md](references/brand-brain-contract.md) to normalize that context and judge readiness.
3. Read [copy-contracts.md](references/copy-contracts.md) when the request is complex, automated, or needs a reusable brief/output object.
4. Read only the relevant channel section in [channel-playbooks.md](references/channel-playbooks.md).
5. Read [claim-critic.md](references/claim-critic.md) before finalizing commercial, comparative, regulated, scarcity, testimonial, or performance copy.
6. Read [evidence-basis.md](references/evidence-basis.md) when explaining a recommendation or deciding whether a tactic is a default principle or merely a test hypothesis.

The persisted Brand Brain is injected automatically when exactly one profile is available or the conversation is already bound to a brand. If several profiles exist, use the included Brand Brain skill to select the requested brand. Persist a correction only after the user explicitly approves it, and persist campaign learning only from a confirmed real result with an evidence note.

Do not make the user repeat brand information that Worklin already has. Surface only missing facts that materially affect the strategy, claim scope, or legal safety.

## Workflow

### 1. Normalize the brief

Identify:

- objective and success metric
- channel and format constraints
- funnel stage and involvement level
- audience situation, desired outcome, current alternative, and primary objection
- offer, mechanism, terms, and primary CTA
- verified proof and unsupported claims
- brand voice, approved examples, forbidden patterns, and speaker

Separate observed customer language from inferred audience language. Never invent a customer quote.

If context is incomplete, proceed with narrower claims and clearly labeled assumptions. Ask concise questions only when a missing answer would change the offer, audience, compliance posture, or core argument.

### 2. Build the claim ledger

Classify every material claim before drafting:

- `VERIFIED`: directly supported within a defined scope
- `QUALIFIED_INFERENCE`: reasonable interpretation that requires qualifying language
- `ASPIRATIONAL`: desired outcome framed as a possibility or purpose
- `UNSUPPORTED`: prohibited from final copy

Carry proof IDs, sources, dates, and allowed scope into the ledger. Never increase confidence beyond the evidence.

### 3. Diagnose the strategy

Determine the reader's awareness, risk, motivation, and proof burden. Select one primary objection and one desired behavioral outcome.

Generate at least three genuinely different concepts before choosing language. Vary the strategy, such as problem diagnosis, mechanism, demonstration, risk reduction, cost of the current process, educational insight, transformation, or relevant social proof.

Generate hooks independently from multiple families. Do not return superficial paraphrases of the first hook.

### 4. Draft with RIVET

- **Recognize:** name the audience's real situation or triggering moment.
- **Introduce bounded tension:** create one understandable unresolved contrast.
- **Deliver value early:** provide a useful answer before demanding patience or action.
- **Establish belief:** use mechanism, demonstration, scoped proof, limitations, and objection handling.
- **Transition to action:** offer one next step proportionate to readiness.

Every hook creates a payoff obligation. Resolve the exact gap the opening creates.

### 5. Critique in two passes

Run a copy pass for relevance, hook-payoff alignment, clarity, specificity, mechanism, product integration, objection handling, voice, emotional progression, and CTA fit.

Run a separate claim and compliance pass against the ledger and hard rejection rules in [claim-critic.md](references/claim-critic.md). Rewrite failures before presenting the artifact.

### 6. Package useful variants

Return a strong primary artifact and a small set of strategic variants. For each variant, name:

- the one variable changed
- the hypothesis
- the primary downstream metric
- guardrail metrics

Change one strategic variable class at a time. Never claim a variant will win before testing.

## Response Shape

For ordinary user requests, return:

1. the finished copy or script
2. a brief strategy note
3. materially different hooks or CTAs when useful
4. assumptions, unsupported claims removed, and risk flags
5. a test recommendation when variants were requested

Use the full output contract in [copy-contracts.md](references/copy-contracts.md) for automated workflows or when the user asks for structured output.

Keep internal process compact. Do not bury the deliverable beneath the rubric.

## Non-Negotiables

- Preserve the approved brand voice without copying verbal tics mechanically.
- Prefer concrete actions, objects, quantities, constraints, and examples over abstract adjectives.
- Attach emotion, humor, narrative, and surprise to the value or explanation.
- Use real scarcity, relevant social proof, and appropriately scoped evidence only.
- Pair threat or pain with a credible, achievable response.
- Keep CTAs direct and choice-preserving; do not use shame or coercion.
- Keep publishing, sending, scheduling, and spending as separate approval-bearing actions.
