# Brand Research Report Contract

The report is an internal agent input, not a polished client deliverable. Keep
it explicit, dated, and easy for another model to parse.

```json
{
  "version": "brand_research_v1",
  "generatedAt": "2026-07-15T00:00:00.000Z",
  "query": { "brandName": "", "websiteUrl": "" },
  "executiveSummary": [],
  "identity": {
    "category": "",
    "positioning": "",
    "offers": [],
    "audienceSignals": []
  },
  "competitorLandscape": [
    {
      "name": "",
      "websiteUrl": "",
      "classification": "direct",
      "rationale": "",
      "positioning": "",
      "offers": [],
      "pricingPosture": "",
      "channelSignals": {
        "paidMedia": [],
        "social": [],
        "seoAndContent": [],
        "emailAndLifecycle": []
      },
      "differentiators": [],
      "notableMoves": [],
      "gaps": [],
      "evidenceIds": [],
      "confidence": "medium"
    }
  ],
  "channelFindings": {
    "seoAndContent": [],
    "social": [],
    "emailAndLifecycle": [],
    "sms": [],
    "productAndLaunches": []
  },
  "marketSignals": [],
  "customerSignals": [],
  "trendSignals": [],
  "evidence": [
    {
      "id": "",
      "url": "",
      "title": "",
      "sourceType": "official_site",
      "observedAt": "",
      "finding": "",
      "confidence": "high"
    }
  ],
  "visualEvidence": [
    {
      "id": "",
      "kind": "ad",
      "title": "",
      "sourceUrl": "",
      "mediaUrl": "",
      "thumbnailUrl": "",
      "mediaType": "image",
      "observedAt": "",
      "provider": "trendtrack",
      "evidenceIds": [],
      "caption": "",
      "caveats": []
    }
  ],
  "gaps": [],
  "recommendations": [
    {
      "priority": "now",
      "action": "",
      "rationale": "",
      "evidenceIds": []
    }
  ],
  "safety": {
    "readOnly": true,
    "publicSourcesOnly": true,
    "unsupportedClaimsExcluded": true,
    "caveats": []
  }
}
```

Use concise prose in arrays. Put the source URL and observation date in the
evidence ledger instead of repeating long citations through every section.
Omit `provider` for ordinary public-web evidence. Include it only when the
observation actually came from an explicitly connected provider; never put
credentials or tokens in the report.
Only include public HTTP media URLs. Visual evidence is optional and bounded;
use a text-only fallback when the source does not expose a public preview.
Visual evidence must point back to one or more evidence-led findings and must
not contain embedded HTML, data URLs, signed credentials, or invented media.
Every competitor and recommendation should reference one or more evidence
IDs, or explicitly say that it is a hypothesis.
`recommendations` must always be an array of objects with `priority`, `action`,
`rationale`, and `evidenceIds`. Use `priority` values `now`, `next`, or `later`;
do not return an object keyed by those three priorities.
Keep the evidence-backed competitor set to two or three entries. Use
`classification` values `direct`, `adjacent`, `substitute`, or `aspirational`.
Record unobservable channels in each competitor's `gaps` instead of inventing
coverage.
