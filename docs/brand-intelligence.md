# Worklin Brand Intelligence

## Purpose

Brand Intelligence is the durable, evidence-backed understanding Worklin
builds for one brand. It is both:

- a visual research dossier that a person can inspect; and
- a compact, revisioned context source that every brand-scoped agent task can
  use.

Competitor Intelligence is one deep area inside Brand Intelligence. It is not
the whole research product.

This design does not promise access to private company information or the
judgement of a named consulting firm. It enforces consulting-grade research
discipline over the public and explicitly connected evidence Worklin can
legally observe.

## Product Hierarchy

```text
Brand Brain
└── Brand Intelligence
    ├── Executive Briefing
    ├── Company And Operating Model
    ├── Market And Category
    ├── Customers And Demand
    ├── Offers, Pricing And Portfolio
    ├── Brand, Positioning And Creative System
    ├── Customer Journey
    ├── Growth Channels And Lifecycle
    ├── Economics And Financial Signals
    ├── Culture, Trends And External Forces
    ├── Reputation, Risk And Constraints
    ├── Competitor Intelligence
    │   ├── Landscape And Watchlist
    │   ├── Competitor Dossiers
    │   ├── Ads And Landing Pages
    │   ├── Email, Lifecycle And SMS
    │   ├── Social Content
    │   ├── SEO And Editorial Content
    │   ├── Products, Offers And Launches
    │   └── Moves, Timeline And Alerts
    ├── Strategic Choices And Action Plan
    └── Evidence Room And Methodology
```

Brand Brain remains the approved operating memory. Brand Intelligence contains
dated observations, estimates, hypotheses, and recommendations. Research does
not silently turn into an approved brand claim.

## Permanent Brand Scope

Every brand receives a permanent UUID when onboarding creates its research
seed. Names and domains are aliases that may change.

Every conversation, research run, research job, artifact, provider call,
scheduled refresh, tool call, and subagent carries:

- organization ID;
- assistant ID; and
- brand ID.

Names and URLs may help resolve an existing brand, but they are never the
authorization boundary. A task with one brand ID cannot request or save data
for another brand ID.

## Research Program

The coordinator may run eight bounded research tracks in parallel:

1. company and operating model;
2. market, category and economics;
3. customers and demand;
4. offers, pricing and portfolio;
5. brand, positioning and creative system;
6. customer journey, channels and lifecycle;
7. competitor landscape; and
8. reputation, risk, culture and trends.

The competitor track may coordinate up to three read-only competitor
specialists. Strategic synthesis and quality review happen after the track
work and remain the coordinator's responsibility.

If delegation is unavailable, Worklin executes the same tracks sequentially.
The report contract and completion rules do not change.

## Module Contract

Every research module records:

- status: `complete`, `partial`, `unavailable`, or `not_observable`;
- decision questions;
- hypotheses;
- material findings;
- metrics;
- supporting and disconfirming evidence;
- contradictions;
- implications;
- gaps and the cheapest useful validation step;
- analytical visualizations; and
- freshness and confidence.

A missing module never becomes an empty chart or a zero. It carries an
explicit status and explanation.

### Company And Operating Model

Map the entity, ownership status, history, revenue model, distribution,
geographic footprint, capabilities, milestones, partnerships, and observable
operating constraints.

### Market And Category

Define category boundaries, substitutes, value chain, maturity, regulation,
demand drivers, structural forces, growth ranges, and profit-pool signals.
Market-size and growth numbers require comparable scope, period, geography,
currency, and method.

### Customers And Demand

Separate buyer, user, influencer, and decision maker. Map segments,
jobs-to-be-done, usage occasions, triggers, pains, barriers, criteria,
objections, willingness-to-pay signals, and customer language.

Customer-language analysis is directional unless it includes at least fifteen
distinct expressions across at least two independent public venues.

### Offers, Pricing And Portfolio

Inventory products, services, packages, public prices, currencies,
promotions, bundles, claims, proof, entry offers, expansion paths, and
merchandising. Show an offer ladder and claim-to-proof matrix when evidence
allows.

### Brand, Positioning And Creative System

Analyze the promise, positioning, reasons to believe, message hierarchy,
voice, distinctive verbal and visual assets, consistency, and the difference
between intended positioning and observable external perception.

### Customer Journey

Map awareness, consideration, evaluation, conversion, onboarding, use,
retention, advocacy, and reactivation. For each stage show questions,
touchpoints, calls to action, proof, friction, handoffs, and observable gaps.
Inspect at least one real public path for every material entry point.

### Growth Channels And Lifecycle

For each paid, owned, and earned channel, record its observable role,
audience, journey stage, cadence, formats, themes, calls to action, metrics,
coverage period, and source limitations. Presence is not performance.

### Economics And Financial Signals

Record revenue drivers, price-volume signals, funding, valuation, growth,
margin, acquisition, retention, and unit-economics signals only when
observable. Every number is labeled `observed`, `calculated`, `estimated`, or
`modeled`. Private economics are never inferred from public traffic.

### Culture, Trends And External Forces

Separate structural trends, behavior shifts, technology changes, regulation,
cultural narratives, and short-lived fashions. Every trend records a
mechanism, horizon, contrary evidence, and dated support.

### Reputation, Risk And Constraints

Every risk records likelihood, impact, horizon, affected decision,
mitigation, residual uncertainty, and evidence. Risk types include legal,
regulatory, reputational, platform, privacy, concentration, supply,
operational, financial, and execution risk.

### Competitor Intelligence

Screen the broad landscape before selecting two or three deep competitors.
Every selected competitor needs:

- class and inclusion rationale;
- comparable positioning, offer and price observations;
- public proof and customer perception;
- paid, owned and earned channel signals;
- product, partnership and launch moves;
- visible strengths, weaknesses and strategic differences;
- contradictions, freshness, confidence and gaps; and
- source-linked visual assets when public previews exist.

### Strategic Choices

Connect evidence across modules into a diagnosis. State the choices the brand
faces, evaluate credible alternatives including doing nothing, separate
no-regret actions from contingent bets, and explain what evidence would change
the recommendation.

## Evidence Discipline

Every material claim receives a stable claim ID and one classification:

- `fact`;
- `estimate`;
- `calculation`;
- `pattern`;
- `inference`;
- `hypothesis`; or
- `open_question`.

Material conclusions normally require at least two independent sources of
different types, including a primary source where available. Several pages
that repeat the same original source count as one source.

Every hypothesis records supporting evidence, disconfirming evidence,
alternative explanations, a validation step, and one status:

- `supported`;
- `mixed`;
- `rejected`; or
- `untested`.

Every number records:

- value or range;
- unit and currency;
- period and geography;
- denominator;
- source method;
- whether it is observed, calculated, estimated, or modeled;
- evidence IDs; and
- confidence.

Contradictions are first-class records. They are never hidden in general gaps.

## Confidence

Confidence is calculated from:

- source quality: 25 points;
- directness: 20 points;
- independent triangulation: 20 points;
- freshness: 15 points;
- sample adequacy: 10 points; and
- consistency: 10 points.

Bands are:

- high: 80-100;
- medium: 60-79;
- low: 40-59; and
- hypothesis: below 40.

An unresolved material contradiction caps confidence at low. A material
single-source claim or opaque provider estimate cannot exceed medium.

## Quality Gate

A deep report is accepted only at 80 out of 100 or higher, with no category
below 60 percent of its available points.

| Category                           | Points |
| ---------------------------------- | -----: |
| Coverage                           |     15 |
| Evidence quality and traceability  |     20 |
| Hypothesis discipline              |     15 |
| Quantification                     |     15 |
| Strategic synthesis                |     15 |
| Visual reasoning                   |     10 |
| Transparency, risk and limitations |     10 |

The report must also satisfy all blocking rules:

- every required module has an explicit status;
- every material finding has evidence or is labeled a hypothesis;
- at least 80 percent of material conclusions are triangulated;
- every complete module has a decision-useful, source-linked analytical visual
  when the evidence supports one;
- no unresolved entity mismatch or cross-brand reference exists;
- no private access is implied;
- unsupported superlatives and false precision are absent; and
- recommendations are decision-ready.

Every recommendation states:

- the decision and action;
- the evidence and causal mechanism;
- expected impact as a range;
- effort, dependencies and risk;
- alternatives;
- suggested owner and timing;
- KPI;
- first test; and
- scale and stop criteria.

Any fabricated evidence, brand mismatch, private-access claim, estimate
presented as fact, or concealed contradiction fails the report immediately.

## Visual Promise

Visual quality is part of research quality. A media gallery alone is not
visual analysis.

The dossier supports:

- verified fact sheets and metric tiles;
- operating-model and brand-architecture diagrams;
- timelines;
- segment and jobs-to-be-done comparisons;
- journey maps;
- offer ladders;
- claim-to-proof matrices;
- positioning maps;
- message hierarchies;
- channel-role and cadence views;
- competitor comparison tables;
- source-linked ad, email, social, landing-page and product galleries;
- trend and change views;
- risk heatmaps;
- opportunity-priority matrices; and
- recommendation sequences.

Every visualization names the business question it answers and links each
datum to evidence. Decorative charts, unsupported rankings, vanity counters,
and charts that merely repeat one number do not count toward the quality
score.

## Progressive Experience

The Brand Intelligence artifact appears after the brand seed is saved. The
first conversation does not wait for deep research.

Modules independently move through:

- queued;
- collecting;
- analyzing;
- partial;
- ready;
- unavailable;
- failed;
- stale; and
- refreshing.

During a refresh, the last accepted snapshot remains visible. New evidence is
published only after validation. Partial modules show validated findings and
explicit gaps.

## Agent Context

Every brand-scoped turn receives a compact Brand Context Pack containing:

- permanent brand ID and research revision;
- approved brand facts, voice and compliance rules;
- positioning, audiences and offers;
- major competitor distinctions;
- current strategic signals;
- freshness, confidence and contradictions; and
- evidence IDs.

Raw reports and media do not enter every prompt. A read-only Brand
Intelligence query tool provides module, competitor, date-range, filter,
sorting and pagination access when deeper detail is needed.

## Storage And Recovery

Brand Brain is the live source of truth for agent work. A successful research
save updates Brand Brain first, writes the normal local immutable snapshot, and
then queues a best-effort off-volume archive. Archive latency or failure never
turns a valid Brand Brain save into a failed user task.

The pilot archive stores one private, immutable JSON manifest for each accepted
research snapshot. The manifest contains the full Brand Brain revision, full
research report, quality result, provenance, source links, and the inventory of
visual evidence. Public image and email-preview assets are copied when they are
safe and available. Video metadata, source links, transcripts, and thumbnails
are retained, but full video files are not copied in the pilot tier.

Objects are isolated by organization, assistant, and permanent brand ID. Stable
snapshot IDs and SHA-256 checksums make retries idempotent and avoid duplicate
copies within a brand. The application exposes no public bucket URL, presigned
download route, or browser credential. Failed asset copies leave an explicit
gap in the manifest instead of pretending the archive is complete.

Pilot cost controls are enforced before upload:

- 8 GiB across the entire archive;
- 1.5 GiB per brand;
- a warning at 70 percent of either limit;
- no automatic quota increase;
- at most 24 visual assets per snapshot;
- at most 10 MiB per visual asset; and
- at most 8 MiB for one submitted research payload.

The current archive is a recovery source, not the context agents read on every
turn. Restoring an older snapshot is an operator action: inspect the immutable
manifest, validate its tenant and evidence, and publish an approved Brand Brain
revision through the normal Brand Brain save contract. Automatic rollback is
intentionally absent so an old snapshot cannot silently overwrite newer
approved context.

### Railway Configuration

Create one private production Railway bucket and use reference variables from
the bucket service. `BUCKET` is the S3 API bucket name; do not use the display
name in `RAILWAY_BUCKET_NAME`.

| Control-plane variable                                    | Value                                                                                   |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_ENABLED`              | `true`                                                                                  |
| `WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_BUCKET`               | `${{brand-intelligence-archive.BUCKET}}`                                                |
| `WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_S3_ENDPOINT`          | `${{brand-intelligence-archive.ENDPOINT}}`                                              |
| `WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_S3_REGION`            | `${{brand-intelligence-archive.REGION}}`                                                |
| `WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_S3_ACCESS_KEY_ID`     | `${{brand-intelligence-archive.ACCESS_KEY_ID}}`                                         |
| `WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_S3_SECRET_ACCESS_KEY` | `${{brand-intelligence-archive.SECRET_ACCESS_KEY}}`                                     |
| `WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_S3_URL_STYLE`         | `virtual` for current Railway buckets; use the bucket Credentials tab for older buckets |
| `WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_GLOBAL_MAX_BYTES`     | 8589934592                                                                              |
| `WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_PER_BRAND_MAX_BYTES`  | 1610612736                                                                              |
| `WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_WARNING_PERCENT`      | `70`                                                                                    |
| `WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_MAX_JOB_BYTES`        | `8388608`                                                                               |
| `WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_MAX_ASSET_BYTES`      | `10485760`                                                                              |
| `WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_MAX_VISUAL_ASSETS`    | `24`                                                                                    |
| `WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_FETCH_TIMEOUT_MS`     | `10000`                                                                                 |

Set `WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_BRIDGE_ENABLED=true` on each assistant
runtime that may save brand research. The runtime receives no bucket
credentials; it may only submit a tenant-bound archive request through the
existing authenticated control-plane bridge.

## Public-Evidence Limits

Public research usually cannot prove private revenue, margin, CAC, LTV,
retention, conversion, attribution, campaign profitability, customer
representativeness, internal strategy, roadmap, operational capability, or
competitor targeting.

Public ads prove that an asset was observed, not that it performed. Social
engagement does not prove sales. Reviews are self-selected. Traffic,
market-size and valuation providers produce estimates, not audited facts.

When a fact cannot be established, Worklin returns:

1. an explicit unknown;
2. a bounded estimate only when assumptions are defensible; and
3. the cheapest validation step.

It never closes an evidence gap with confident prose.

## Rollout Gates

Before customer rollout:

1. two brands under one assistant must remain isolated across conversations,
   tools, subagents, artifacts and refreshes;
2. two users with permitted access must see the same workspace research
   without inheriting each other's credentials;
3. cancelled or expired workers must not overwrite a newer lease;
4. one thousand queued brand runs must preserve fairness, deduplication and
   bounded resource use in a load simulation;
5. every accepted deep report must pass the deterministic quality gate; and
6. authenticated browser tests must verify the visual dossier on desktop and
   mobile.
