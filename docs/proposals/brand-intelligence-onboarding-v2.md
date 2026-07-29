# Worklin Brand Intelligence Onboarding v2

Status: Product and architecture proposal

## 1. Executive decision

Worklin onboarding should require one initial human input:

- A brand website URL, preferably.
- A brand name when no URL is known.

From that seed, Worklin should run a source-backed research program that builds
an agency-grade operating model of the brand, its products, audiences,
competitors, channels, market, claims, and opportunities.

This is not a longer questionnaire. It is an asynchronous intelligence job.
The client should do less work while Worklin does substantially more.

The core product promise is:

> Give Worklin the brand. Worklin builds the brief.

The user may later connect private systems or correct conclusions, but public
research begins without waiting for those steps.

## 2. What is wrong with the current model

The current `brand_brain_v1` is a compact copy and retention profile. It stores
useful fields such as positioning, voice sliders, audience notes, offers,
products, compliance constraints, source provenance, readiness, and campaign
memory.

The initial onboarding builder is intentionally conservative, but shallow. It
uses a public page title, description, and a small set of product hints to make
a partial profile. Most strategically important fields remain unconfirmed.

That design is appropriate for a safe draft. It is not enough for an AI
marketing organization expected to operate at the standard of a top agency.

Specific gaps:

1. The Brand Brain is treated as one profile instead of the synthesized view of
   a larger evidence system.
2. Provenance is too coarse to support claim-level verification.
3. Competitors are not modeled as entities with their own dossiers.
4. Channel strategies are not researched independently.
5. Customer language and sentiment are not represented as dated evidence.
6. Facts, inferences, hypotheses, and recommendations are not cleanly
   separated.
7. Freshness and contradictory evidence are not first-class concepts.
8. A single readiness score hides domain-specific gaps.
9. There is no research-run budget, source budget, or dollar guardrail.
10. There is no continuous intelligence loop after onboarding.

## 3. Product doctrine

### 3.1 One input, progressive depth

The initial experience asks only for the brand URL or name. Worklin should not
ask questions it can answer through research.

Worklin should interrupt only when one of these conditions is true:

- Brand identity is materially ambiguous.
- A private source is required to answer a high-value question.
- The user must grant access to a system.
- A legal, factual, or strategic claim needs human confirmation.
- Two credible sources conflict and the difference changes the strategy.
- The user needs to choose between consequential priorities.

### 3.2 Research is not truth

Every material statement must be classified as one of:

- `observed_fact`: directly supported by evidence.
- `derived_finding`: reasoned from cited facts.
- `hypothesis`: plausible and testable, but not established.
- `recommendation`: an advised action with rationale.
- `unknown`: important but not currently answerable.

No inference may silently become a fact. No generated marketing claim may
silently become approved brand truth.

### 3.3 Depth without context pollution

Worklin may produce a 50-page or 200-page dossier. That dossier is a view, not
the canonical data store.

The system of record should contain structured, atomic evidence and findings.
For each downstream task, a context compiler retrieves only relevant slices.
For example, an abandoned-cart email should receive product truth, audience
language, offer rules, prior email patterns, claim constraints, and applicable
campaign results, not the entire investor and SEO dossier.

### 3.4 Evidence before eloquence

The research system should optimize for:

1. Correct entity resolution.
2. Source quality and coverage.
3. Claim-level provenance.
4. Recency.
5. Contradiction detection.
6. Useful strategic synthesis.
7. Polished presentation.

Presentation comes last.

### 3.5 More agents require more control

Parallel agents increase coverage, but can also multiply duplicated work,
unsupported conclusions, and cost. Every specialist must use a bounded source
scope, structured output contract, and evidence requirements. A separate
auditor must be able to reject its work.

## 4. The five-layer intelligence architecture

### Layer 1: Source vault

Stores or references raw source material:

- Public web pages and sitemaps.
- Structured data and product feeds.
- Screenshots and rendered creative where permitted.
- Ad-library records.
- Email archive records.
- Social posts and public metrics.
- Search and traffic data.
- Reviews and customer language.
- Public filings, press releases, and investor materials.
- Connected first-party data.

Each source record includes access method, license or terms classification,
capture time, observed publication time, geography, content hash, retention
policy, and the canonical URL or connector record ID.

### Layer 2: Evidence ledger

Extracts atomic claims from sources. Each evidence item should include:

```ts
interface EvidenceClaim {
  id: string;
  brandId: string;
  subjectEntityId: string;
  statement: string;
  classification: "observed_fact" | "derived_finding" | "hypothesis";
  sourceId: string;
  sourceLocator: string;
  observedAt: string | null;
  capturedAt: string;
  geography: string | null;
  channel: string | null;
  confidence: number;
  sourceQuality:
    | "primary"
    | "first_party"
    | "authoritative"
    | "secondary"
    | "weak";
  inferenceMethod: string | null;
  contradicts: string[];
  expiresAt: string | null;
}
```

Facts should be independently readable and independently invalidatable.

### Layer 3: Domain dossiers

Specialists synthesize evidence into focused research artifacts:

- Brand and corporate identity dossier.
- Product and offer dossier.
- Audience and jobs-to-be-done dossier.
- Voice-of-customer dossier.
- Positioning and messaging dossier.
- Competitor dossier for each selected competitor.
- Email and SMS intelligence dossier.
- Paid creative dossier.
- Organic social dossier.
- SEO and editorial dossier.
- Market, trend, and investor dossier.
- Compliance and claim-risk dossier.

Every dossier has its own coverage score, freshness score, source list,
conflicts, unknowns, and recommended next research action.

### Layer 4: Brand Brain v2

The Brand Brain becomes the canonical synthesized operating layer. It should
contain stable, reusable decisions and links back to evidence, not every raw
observation.

Suggested top-level domains:

- Identity and business model.
- Category and market definitions.
- Product, service, and offer catalog.
- Audiences, jobs, pains, desires, objections, and buying triggers.
- Positioning, differentiation, and category narrative.
- Voice, style, approved examples, and forbidden patterns.
- Claim ledger and substantiation status.
- Competitor graph and positioning map.
- Pricing and promotion posture.
- Channel-specific strategies and patterns.
- Customer sentiment and language bank.
- Trust, compliance, and reputation risks.
- Campaign learnings and test history.
- Strategic opportunities, tensions, and open questions.
- Domain freshness and confidence.

### Layer 5: Task context compiler

Before another agent writes, plans, or analyzes, Worklin compiles a bounded
brief from Brand Brain v2 and the evidence ledger.

The compiler should select context by:

- Brand and product.
- Target audience.
- Channel and format.
- Funnel stage.
- Geography and language.
- Objective and success metric.
- Involvement and purchase risk.
- Applicable claims and compliance regime.
- Recency requirement.

This layer is what makes deep onboarding useful in daily work.

## 5. Research program

### Phase 0: Resolve the brand

Input: URL or brand name.

Tasks:

- Normalize the domain and redirects.
- Resolve legal and trading names.
- Identify country, language, and operating regions.
- Detect parent company, subsidiaries, and alternate storefronts.
- Find official social, marketplace, app, and investor profiles.
- Detect whether the URL is a retailer, brand, agency, or unrelated entity.
- Calculate identity confidence.

Output:

- Canonical brand entity.
- Official-domain graph.
- Identity evidence.
- Ambiguity report.

Human gate: only if the identity confidence is below the launch threshold or
multiple materially different brands match.

### Phase 1: Crawl the first-party public brand

The website specialist should crawl by page type, not indiscriminately.

Priority page classes:

- Home and category pages.
- Product and service pages.
- Pricing and offer pages.
- About, founder, and mission pages.
- Landing pages discoverable through search or ad libraries.
- Blog, guides, reports, and glossary pages.
- FAQs, support, shipping, returns, warranty, and cancellation pages.
- Review and testimonial pages.
- Legal, privacy, terms, and compliance pages.
- Press, investor, careers, and partner pages.

Extract:

- Product taxonomy and variants.
- Prices, bundles, promotions, subscriptions, guarantees, and constraints.
- Stated audiences and use cases.
- Features, benefits, mechanisms, and proof.
- Quantitative, comparative, health, performance, scarcity, and testimonial
  claims.
- Navigation and information architecture.
- Recurring vocabulary, sentence patterns, CTAs, and tone by page type.
- Structured data, metadata, technology signals, and international variants.
- Internal links and conversion paths.

### Phase 2: Discover the competitive set

Do not ask the client to list competitors first. Generate candidates from
multiple independent methods:

- Category and problem searches.
- Product and use-case searches.
- Organic keyword overlap.
- Paid keyword overlap.
- Similar-audience and traffic sources.
- Retail and marketplace adjacency.
- Comparison pages and alternative queries.
- Customer discussions and review-site alternatives.
- Ad-library category and creative similarity.
- Company and investor materials.

Classify candidates as:

- Direct competitor.
- Indirect competitor.
- Substitute behavior or solution.
- Aspirational brand.
- Search competitor.
- Attention competitor.
- Retail or distribution competitor.

Score each candidate using product overlap, audience overlap, geography,
price band, positioning similarity, keyword overlap, and evidence quality.

The research director should select a bounded portfolio, for example:

- 5 direct competitors.
- 2 indirect or substitute competitors.
- 2 aspirational references.
- 1 category outlier with a notably different strategy.

The numbers are run-budget defaults, not universal truths.

### Phase 3: Build one dossier per competitor

Each selected competitor gets a common evidence-backed structure:

1. Company identity, ownership, geography, size signals, and dated financial
   or valuation evidence when available.
2. Product catalog, hero products, launch cadence, variants, and gaps.
3. Pricing, discounts, subscriptions, bundles, guarantees, and promotion
   cadence.
4. Target audiences, jobs, pains, desired outcomes, and objections.
5. Positioning, category framing, mechanisms, proof, and claims.
6. Landing-page and conversion architecture.
7. Paid social and paid search creative patterns.
8. Organic social formats, themes, cadence, creators, and engagement signals.
9. Email and SMS themes, cadence, lifecycle patterns, promotions, and creative.
10. SEO topics, rankings, content clusters, backlinks, and search gaps.
11. Reviews, complaints, praise, customer language, and reputation themes.
12. Partnerships, retail channels, press, launches, hiring, and strategic
    signals.
13. Strengths, weaknesses, contradictions, and strategic vulnerabilities.

The dossier must distinguish observed strategy from inferred strategy.

### Phase 4: Channel intelligence pods

Run channel specialists across the brand and selected competitors.

#### Paid social and display

Research:

- Active ads and available history.
- Creative format and duration.
- Hook family and opening frame.
- Problem, promise, mechanism, proof, offer, and CTA.
- Landing-page destination and message match.
- Creator-led versus brand-led creative.
- Variant density and signs of creative iteration.
- Geography and language where visible.

Never infer spend or performance unless the source provides it. Ad longevity is
a weak signal, not proof of profitability.

#### Organic social

Research by platform:

- Posting cadence and format mix.
- Content pillars.
- Recurring series and franchises.
- Founder, employee, creator, customer, and brand voices.
- Engagement rate proxies with explicit denominator and caveats.
- Comment themes and questions.
- Trend participation and platform-native behavior.
- Top and weak posts within the captured sample.
- Cross-platform reuse versus native adaptation.

#### Email and SMS

Research:

- Cadence and send-time patterns.
- Subject-line and preview-text patterns.
- Lifecycle stage where inferable.
- Promotion frequency and discount depth.
- Product launch sequences.
- Education, proof, urgency, and objection handling.
- Design system and content density.
- CTA architecture.
- Seasonal and event calendar.
- SMS frequency, message structure, offers, and compliance signals when a
  lawful source is available.

Milled is the likely service intended by "meld.com." It is useful as a large
searchable ecommerce email archive. Worklin should use a licensed integration
or an authorized browser session, not build an undocumented scraper.

#### SEO and editorial

Research:

- Organic keyword and page footprint.
- Branded versus non-branded demand.
- Topic and intent clusters.
- Content depth, freshness, and publishing cadence.
- Backlink and authority signals.
- SERP features and competitor overlap.
- Content gaps and weakly defended topics.
- Search-to-offer alignment.
- AI-search visibility where supported by licensed data.

#### Video and creators

Research:

- Official YouTube and public video catalog.
- Topics, formats, duration, cadence, and public statistics.
- Repeated hooks and narrative structures.
- Creator partnerships and disclosure patterns.
- Product demonstration and proof styles.
- Comment and audience-response themes where terms permit.

### Phase 5: Voice of customer and sentiment

The customer intelligence specialist should build a language bank from lawful,
sourceable material:

- Connected support tickets and chat logs.
- Connected surveys, interviews, and sales calls.
- Verified reviews and marketplace reviews.
- Public comments and community discussions where permitted.
- Search queries and on-site search when connected.
- Returns, cancellations, and complaint reasons when connected.

Extract:

- Desired outcomes.
- Trigger events.
- Pains and anxieties.
- Objections and switching barriers.
- Alternative solutions.
- Decision criteria.
- Product-use context.
- Satisfaction and dissatisfaction drivers.
- Exact customer language with source and permission controls.

Sentiment must always include sample size, source, date range, selection bias,
and confidence. It should never be presented as representative of the market
without evidence.

### Phase 6: Market, company, and investor intelligence

For public companies and funded competitors, research:

- Public filings and material events.
- Revenue, segment, growth, margin, and risk disclosures.
- Investor presentations and earnings commentary.
- Funding rounds and acquisition history from licensed sources.
- Hiring patterns and organizational investment signals.
- Market forecasts with methodology and source-quality labels.
- Analyst, investor, customer, and employee sentiment kept as separate lenses.

Valuation must always have a source and as-of date. A private-company estimate
is not a fact. If no credible source exists, store `unknown` rather than
manufacturing precision.

### Phase 7: Strategic synthesis

The strategy synthesizer should produce:

- Category and demand map.
- Product and offer comparison matrix.
- Audience and jobs-to-be-done map.
- Positioning map with explicit dimensions and evidence.
- Message and mechanism matrix.
- Claim and proof matrix.
- Channel share-of-voice and activity map, with methodological caveats.
- White-space opportunities.
- Overused category conventions.
- Strategic tensions and risks.
- Testable messaging, offer, content, and channel hypotheses.
- Recommended first 30, 60, and 90 day learning agenda.

It should not declare that an angle "will work." It should explain why an
angle is worth testing, for whom, in which channel, against which alternative,
and with which success metric.

### Phase 8: Independent audit

The evidence auditor runs after synthesis and can block publication.

Checks:

- Every material fact has a resolvable citation.
- Quotes are exact and within storage and usage policy.
- Inferences are labeled.
- Contradictions are surfaced rather than averaged away.
- Dates and geographies are retained.
- Competitors are correctly resolved.
- No private or unrelated person was profiled.
- No invented valuation, spend, performance, customer count, or claim exists.
- The recommendation follows from the cited evidence.
- Stale evidence is flagged.
- Coverage scores reflect actual source coverage.

## 6. Specialist agent roster

The onboarding run should be coordinated by a research director. Specialist
roles are capabilities, not necessarily permanent personas.

1. Brand resolver.
2. First-party website and conversion analyst.
3. Product, offer, and pricing analyst.
4. Competitor discovery analyst.
5. Competitor dossier analyst, fanned out per competitor.
6. Paid creative intelligence analyst.
7. Organic social intelligence analyst.
8. Email and SMS intelligence analyst.
9. SEO and editorial intelligence analyst.
10. Voice-of-customer and sentiment analyst.
11. Market, company, and investor analyst.
12. Brand voice and messaging analyst.
13. Claims, legal, and compliance analyst.
14. Strategy synthesizer.
15. Evidence and contradiction auditor.

Recommended orchestration shape:

```text
resolve brand
  -> crawl first-party sources
  -> discover competitor candidates
  -> select competitor portfolio
  -> run competitor dossiers and channel pods in parallel
  -> run audience, market, voice, and claims synthesis
  -> run independent evidence audit
  -> publish Brand Brain v2 and client artifact
```

No specialist should publish directly to the canonical Brand Brain. Specialists
submit structured findings; the synthesizer proposes a revision; the auditor
validates it; then the store publishes the revision.

### 6.1 Current Worklin orchestration capability

Worklin already contains two different multi-agent mechanisms.

#### Conversational subagents: available by default

The bundled `subagent` skill is shipped for every user and is one of the skills
preactivated in every conversation. The main assistant can call:

- `subagent_spawn`.
- `subagent_read`.
- `subagent_message`.
- `subagent_abort`.
- `subagent_status` when a user explicitly asks for status.

Each subagent runs an independent agent loop and background conversation. The
parent can spawn multiple agents and continue working while they run. Roles
restrict tools to `researcher`, `planner`, `coder`, `investigator`, or
`general`. Fork mode can inherit the parent's conversation and system context.

Current limits:

- A connected client event channel is required to spawn.
- Subagents cannot spawn nested subagents; maximum nesting depth is one.
- The parent is responsible for decomposition, coordination, and synthesis.
- Parallelism and provider rate limits still constrain throughput.
- This mechanism is well suited to several rich specialist investigations, but
  not ideal for hundreds of uniform extraction jobs.

#### Workflow leaf agents: implemented, feature-gated

The workflow engine runs deterministic sandboxed scripts that fan out many
ephemeral leaf agents. It supports parallel maps and pipelines, structured
outputs, run journals, and resume after interruption. Default configuration
allows up to 500 leaves per run, 6 concurrent leaves, and 3 concurrent runs.

The `workflows` feature flag is off by default. The current runaway guard is an
agent cap; it does not provide a dollar-cost kill switch. Deep Brand
Intelligence onboarding should use this engine only after adding enforceable
source, token, paid-provider, time, and cost budgets.

Recommended transition:

1. Build the first vertical slice with 3 to 6 conversational research
   subagents so the evidence contracts can be tested visibly.
2. Move repetitive per-page, per-competitor, and per-channel extraction into
   workflow leaves once the contracts and cost governor are proven.
3. Keep high-judgment synthesis and independent audit as separate stronger
   agent passes.

## 7. Source strategy

### 7.1 Public and low-friction sources

- Brand and competitor public websites.
- Search results and public structured data.
- Meta Ad Library for active ads and supported transparency data.
- Google Ads Transparency Center.
- TikTok Creative Center for available top-ad, keyword, product, and trend
  intelligence.
- YouTube Data API for public channel and video resources.
- SEC EDGAR for US public-company submissions and XBRL facts.
- Public press releases, investor relations pages, and official reports.

### 7.2 Licensed intelligence sources

- Milled or an equivalent email archive.
- Semrush, Ahrefs, DataForSEO, or another licensed SEO provider.
- Similarweb or another licensed traffic intelligence provider.
- PitchBook, Crunchbase, CB Insights, or another licensed company-data source.
- Approved review, social listening, creator, and media monitoring providers.

Provider selection should be adapter-based. The Brand Brain cannot depend on a
single vendor's taxonomy.

### 7.3 First-party connectors

These are optional at first contact but necessary for account truth:

- Shopify or commerce platform.
- Klaviyo or email/SMS platform.
- GA4 and Google Search Console.
- Google Ads, Meta Ads, TikTok Ads, and other ad accounts.
- CRM and customer-data platform.
- Helpdesk, reviews, surveys, and call transcripts.
- Product information and digital asset systems.
- Financial or margin data at an appropriately restricted aggregation level.

Public research can reveal what a brand appears to do. Only first-party data
can establish what actually performs, converts, retains, or produces margin.

### 7.4 Source restrictions

Worklin must not rely on fragile, unauthorized competitor scraping. Some
platform research APIs exclude commercial users, some APIs expose only owned
accounts, and some public libraries expose only active or curated ads.

Each source adapter needs:

- Permitted-use classification.
- Authentication type.
- Rate and quota limits.
- Data-retention rules.
- Whether derived commercial insights are allowed.
- Whether content can be shown to the client or only used transiently.
- Fallback behavior when unavailable.

## 8. Onboarding experience

### Screen 1: Brand seed

Prompt:

> What brand should your AI coworker learn?

Control:

- One URL or brand-name field.
- Primary action: `Build my Brand Brain`.
- Secondary action: `I do not have a website yet`.

No forced assistant naming, work-type questionnaire, tool checklist, or data
connection should block the research run.

### Screen 2: Identity confirmation only when needed

Show candidate brands with domain, logo, country, and short description. Ask
the user to select only when resolution is genuinely ambiguous.

### Screen 3: Research mission

Show what Worklin has decided to research:

- Brand and products.
- Audience and positioning.
- Competitors.
- Marketing channels.
- Customer sentiment.
- Market and company signals.

This is a transparent progress view, not a questionnaire. The user may remove a
source category or add a known competitor, but neither is required.

### During the run

The user can enter Worklin immediately. Research continues as a background work
item and emits progress by phase:

- Brand resolved.
- Website mapped.
- Competitors discovered.
- Competitor dossiers in progress.
- Channel research in progress.
- Evidence audit in progress.
- Brand Brain ready.

Early verified findings may become available before the complete run, but the
UI must clearly mark draft versus audited content.

### Completion artifact

The human-facing artifact should provide:

- Executive brief.
- Brand and audience.
- Product and offer map.
- Competitor landscape.
- Channel intelligence.
- Customer language.
- Opportunities and risks.
- Recommended learning agenda.
- Sources, conflicts, and unknowns.

The full machine dossier remains inspectable through an artifact or data view,
with every claim linked to source evidence.

### Human interventions after onboarding

Use small, contextual requests instead of a deferred giant questionnaire:

- "I found two brands with this name. Which is yours?"
- "Connect Klaviyo to replace public email patterns with actual performance."
- "This product claim appears on the site but has no substantiation attached."
- "Competitor pricing differs by region. Which market matters first?"
- "These two positioning directions are both plausible. Which business goal is
  primary this quarter?"

## 9. Budget and reliability controls

The existing workflow engine provides useful agent and concurrency caps, but a
production onboarding product also needs an explicit cost governor before deep
research is enabled broadly.

Each run should define:

- Maximum competitors.
- Maximum pages per domain and page class.
- Maximum source records per channel.
- Maximum LLM input and output tokens.
- Maximum paid-provider units or credits.
- Maximum browser minutes.
- Maximum retries per adapter and phase.
- Maximum wall-clock duration.
- Maximum estimated and actual cost.
- Maximum monthly refresh cost per brand.

Cost policy:

- Cache by canonical URL and content hash.
- Reuse source snapshots across specialists.
- Use deterministic parsers before LLM extraction.
- Use lower-cost models for classification and extraction.
- Use stronger models for synthesis, contradiction analysis, and audit.
- Refresh by diff, not full recrawl.
- Stop low-value research branches when evidence saturation is reached.
- Never retry paid calls indefinitely.
- Surface estimated scope before an unusually expensive run.

Suggested product tiers are scope policies rather than quality policies:

- `foundation`: first-party site, initial category map, and a small competitor
  set.
- `deep`: full channel pods and expanded competitor portfolio.
- `continuous`: scheduled monitoring, change detection, and learning updates.

Every tier uses the same evidence standard.

## 10. Freshness and continuous intelligence

Onboarding creates the first intelligence baseline. It should not freeze the
brand in time.

Suggested refresh classes:

- Daily: material site, price, promotion, and ad changes where affordable.
- Weekly: email, content, social, product launch, and competitor change digest.
- Monthly: SEO, traffic, positioning, and market synthesis.
- Quarterly: strategic review and competitor portfolio reselection.
- Event-driven: new product, funding, filing, rebrand, major campaign, pricing
  change, controversy, or connected performance event.

Every Brand Brain field should carry a freshness policy. A price may expire in
days; a founding story may remain stable for years.

New evidence should create a proposed revision, not silently overwrite history.
The event log should explain what changed, why, and which downstream assumptions
are affected.

## 11. Security, privacy, and legal boundaries

- Respect source terms, robots controls, rate limits, and access restrictions.
- Do not bypass logins, paywalls, anti-bot systems, or geographic controls.
- Do not profile private individuals or infer sensitive personal attributes.
- Minimize and isolate customer PII from connected sources.
- Store only the minimum copyrighted source content needed for evidence and
  audit; prefer locators and bounded excerpts where possible.
- Encrypt connector credentials and keep source-specific access scopes.
- Keep research read-only by default. Research may not send, publish, purchase,
  subscribe, or modify external systems.
- Preserve deletion and source-disconnection semantics.
- Record which evidence can be used for generation, shown in artifacts, or only
  used in aggregate.

## 12. Reuse and rebuild decisions

### Reuse

- Revisioned Brand Brain persistence and event history.
- Conversation-to-brand binding.
- Background conversations and work-item lifecycle.
- SSE progress events.
- Workflow fan-out, journal, resume, and structured leaf outputs.
- Existing subagent progress surfaces.
- Browser relay and browser-use architecture.
- Existing Shopify and Klaviyo read paths.
- `write-brand-copy` and its Brand Brain contract as the first downstream
  consumer.

### Extend

- Evolve `brand_brain_v1` into a versioned v2 synthesis schema.
- Add evidence, source, entity, dossier, conflict, and research-run stores.
- Add a context compiler rather than injecting the full brain everywhere.
- Add domain-level coverage and freshness scores.
- Add source adapters with licensing metadata.
- Add a cost governor to the workflow runtime.

### Replace

- Replace the single-page public-signal read as the main brand analysis.
- Replace generic "research me" onboarding directives with an explicit brand
  research work item.
- Replace one opaque readiness score with evidence-backed domain readiness.
- Replace manual competitor intake as the default with automated discovery.

## 13. Implementation phases

### Phase A: Intelligence foundation

Build:

- Brand Research Run state machine.
- Source vault and evidence ledger.
- Entity and competitor graph.
- Claim classification and citation contract.
- Conflict and unknown records.
- Domain coverage and freshness scoring.
- Cost governor and provider-unit ledger.
- Brand Brain v2 schema and v1 migration strategy.

Launch gate:

- A run can be stopped, resumed, audited, and reproduced from stored source
  references without publishing unsupported facts.

### Phase B: Public-web research MVP

Build:

- Brand resolver.
- Sitemap and page-type crawler.
- Product, offer, claim, and voice extraction.
- Competitor candidate discovery and scoring.
- Bounded competitor website dossiers.
- Public ad-library and YouTube adapters.
- Research progress UI and final artifact.

Launch gate:

- One URL produces an audited Brand Brain with a useful initial competitive
  landscape and claim-level citations, without further required input.

### Phase C: Channel intelligence

Build:

- Licensed email archive adapter.
- SEO and traffic provider adapters.
- Paid creative, organic social, email/SMS, SEO, and editorial dossiers.
- Customer-language ingestion from permitted public sources.
- Cross-channel strategy synthesis.

Launch gate:

- The same competitor set can be compared through a common channel schema, and
  every absence is labeled as unavailable rather than "not used."

### Phase D: First-party truth

Build:

- Commerce, email, analytics, ad, CRM, helpdesk, survey, and review connectors.
- Permissioned aggregation and PII controls.
- Performance and margin-aware campaign memory.
- Public-observation versus account-truth reconciliation.

Launch gate:

- Worklin can distinguish what competitors appear to do from what the client
  can prove works for its own audiences.

### Phase E: Continuous intelligence

Build:

- Change detection and differential refresh.
- Scheduled and event-driven research.
- Brand Brain revision proposals.
- Strategy alerts with frequency controls.
- Historical comparisons and learning decay.

Launch gate:

- A material external change updates affected dossiers and proposes a traceable
  Brand Brain revision without rewriting unrelated knowledge.

## 14. Acceptance criteria

### Identity

- The system resolves the correct official brand and domain or asks for
  confirmation.
- Parent, subsidiary, regional, and retailer entities are not conflated.

### Evidence

- 100 percent of published factual claims have a source locator.
- Every source-backed statement retains capture date and applicable observed
  date.
- Every inference and hypothesis is visibly typed.
- Contradictory credible evidence remains visible.

### Coverage

- Every enabled research domain reports covered, partial, unavailable, or not
  applicable.
- Missing API access is not interpreted as competitor inactivity.
- Competitor selection records its rationale and evidence.

### Safety

- No external mutation occurs during research.
- No invented spend, conversion, valuation, customer count, review, or claim is
  published.
- Source and connector use complies with recorded adapter policy.

### Cost and operations

- Every run has enforceable source, token, provider-unit, time, and cost caps.
- Duplicate source content is not paid for or processed repeatedly.
- Failed specialists do not corrupt the canonical Brand Brain.
- Runs can resume without repeating completed paid work.

### Downstream usefulness

- `write-brand-copy` can request a channel-specific evidence brief without
  reading the full dossier.
- Generated copy can resolve every material claim against the claim ledger.
- A correction updates the appropriate durable Brand Brain rule without
  rewriting raw evidence.
- Verified campaign outcomes update audience- and channel-specific priors.

## 15. Evaluation suite

Create benchmark brands that cover:

- A clear DTC ecommerce brand.
- A B2B SaaS company.
- A local service business.
- A regulated health or finance brand.
- A marketplace or retailer with many third-party products.
- A new brand with little public footprint.
- A common brand name with identity ambiguity.
- A global brand with regional sites and prices.
- A public company with extensive filings.
- A private company with little credible valuation data.

Score each run on:

- Entity-resolution accuracy.
- Citation precision and recall.
- Unsupported-claim rate.
- Competitor relevance.
- Product and pricing accuracy.
- Voice-example fidelity.
- Conflict detection.
- Coverage honesty.
- Strategic usefulness judged blind by experienced marketers.
- Cost, duration, retries, and source efficiency.
- Downstream copy improvement against the current Brand Brain.

Hard failure conditions:

- Wrong brand.
- Unsupported fact promoted as verified.
- Fabricated quote, review, metric, valuation, or performance claim.
- Private data leakage across brands or users.
- Source access outside its permitted use.
- Research action that mutates an external system.

## 16. Recommended first build

The first build should not attempt every channel. It should prove the evidence
architecture with a coherent vertical slice:

1. One URL input.
2. Brand resolution.
3. First-party website map and deep extraction.
4. Automated competitor discovery.
5. Five bounded competitor website dossiers.
6. Product, offer, positioning, voice, claims, and audience comparison.
7. Evidence audit.
8. Brand Brain v2 publication.
9. A context compiler for `write-brand-copy`.
10. A human-readable artifact with citations and unknowns.

This slice creates immediate product value and establishes the contracts every
later channel adapter must obey. Email, social, ads, SEO, investor, and private
connectors can then be added without redesigning the brain.

## 17. Final product position

Worklin should not present onboarding as "tell the AI about your business."
That makes the client the researcher.

Worklin should present onboarding as:

> Give us the brand. Your AI coworker will research the company, market,
> customers, competitors, and channels, show its evidence, and keep the Brand
> Brain current as the business changes.

The defensible advantage is not the length of the report or the number of
agents. It is a continuously updated, source-backed marketing intelligence
system that every Worklin skill can use without asking the client to repeat the
brief.
