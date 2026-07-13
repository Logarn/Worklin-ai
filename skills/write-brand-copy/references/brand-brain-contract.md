# Brand Brain Contract

## Contents

- Source priority
- Worklin field mapping
- Voice rendering
- Readiness rules
- Normalized profile

## Source Priority

Use approved first-party context before generic assumptions:

1. User corrections in the current conversation
2. Approved Brand Brain rules, claims, examples, and compliance limits
3. Approved onboarding documents and direct customer language
4. Current offer and product facts supplied for this request
5. Dated campaign memory from the same audience, channel, and offer
6. Broader brand observations and generic research priors

Do not let a generic style heuristic override an approved brand rule. Do not treat fixture, draft, stale, or inferred material as approved.

## Worklin Field Mapping

Map Worklin's `BrandBrainContext` into the copy brief as follows:

| Brand Brain field                      | Copywriting use                                               |
| -------------------------------------- | ------------------------------------------------------------- |
| `brandName`, `industry`                | speaker identity and category context                         |
| `positioning.tagline`                  | positioning input, not a mandatory line to repeat             |
| `positioning.story`                    | narrative and belief context                                  |
| `positioning.uniqueSellingProposition` | differentiation hypothesis to verify against the offer        |
| `voice.summary`                        | default voice description                                     |
| `voice.sliders`                        | tone boundaries for formality, playfulness, and enthusiasm    |
| `voice.greetingStyle`, `signOffStyle`  | email and conversational framing                              |
| `voice.emojiUsage`                     | maximum emoji posture, not a quota                            |
| `audienceNotes`                        | audience priors; separate observed facts from interpretations |
| `offers[].constraint`                  | offer eligibility and framing limits                          |
| `products[]`                           | named products and operational context; not claim evidence    |
| `rules[type=do]`                       | required brand behaviors                                      |
| `rules[type=dont]`                     | forbidden style or positioning patterns                       |
| `rules[type=compliance]`               | claim and disclosure gates                                    |
| `rules[type=suppression]`              | audience eligibility and contact constraints                  |
| `ctas`                                 | approved CTA vocabulary                                       |
| `phrases[type=approved]`               | positive voice examples                                       |
| `phrases[type=avoid]`                  | forbidden or overused language                                |
| `compliance.*`                         | disclaimers, prohibited claims, and caution areas             |
| `documentSources[].keyFindings`        | research-backed brand observations, subject to source status  |
| `sourceProvenance`                     | approval, freshness, and fixture checks                       |
| `campaignMemory`                       | audience-specific learning; use outcomes as priors, not laws  |
| `readiness` and `caveats`              | confidence and missing-context handling                       |

## Voice Rendering

Treat voice as a set of decision boundaries, not a list of adjectives.

Translate each trait into observable behaviors:

```json
{
  "trait": "warm",
  "do": ["acknowledge the reader's situation", "use plain direct sentences"],
  "avoid": ["forced intimacy", "pet names", "manufactured empathy"],
  "approved_example": "A short approved line",
  "counterexample": "A line the brand would never use"
}
```

Apply slider values comparatively. A low formal-casual score can support contractions and direct address; it does not justify slang unless approved examples and speaker expectations support it. A high enthusiasm score permits energy; it does not permit unsupported superlatives.

Use approved examples to infer rhythm, sentence length, vocabulary, humor, and stance. Do not reproduce distinctive phrases so often that the copy becomes imitation.

## Readiness Rules

### Ready

Draft normally when the profile is approved, current, and includes voice rules, audience context, offer constraints, and evidence for material claims.

### Partial

Draft with labeled assumptions when the central offer and audience are known but proof, approved examples, or product-level claims are incomplete. Prefer mechanism, demonstration, and aspirational framing over performance promises.

### Missing

Do not synthesize a brand voice from stereotypes. Ask for the smallest useful set:

- who is speaking
- who they are speaking to and in what moment
- three voice traits with one approved and one rejected example
- what is being offered and how it works
- what claims and proof are approved
- what action the audience should take

## Normalized Profile

Use this internal shape after mapping onboarding context:

```json
{
  "speaker": "",
  "positioning": "",
  "voice": {
    "summary": "",
    "behaviors": [],
    "approved_examples": [],
    "forbidden_patterns": [],
    "tone_boundaries": {},
    "emoji_usage": "none | light | moderate"
  },
  "audience_priors": [],
  "direct_customer_language": [
    {
      "text": "",
      "source": "",
      "status": "verbatim | paraphrase",
      "observed_at": ""
    }
  ],
  "approved_ctas": [],
  "offer_constraints": [],
  "compliance": {
    "required_disclaimers": [],
    "forbidden_claims": [],
    "caution_areas": []
  },
  "readiness": "ready | partial | missing",
  "missing": [],
  "caveats": []
}
```

Never place invented language in `direct_customer_language`. Label a paraphrase as a paraphrase.
