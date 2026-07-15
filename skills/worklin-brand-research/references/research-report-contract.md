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
  "competitorLandscape": [],
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
  "evidence": [],
  "gaps": [],
  "recommendations": [],
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
Every competitor and recommendation should reference one or more evidence
IDs, or explicitly say that it is a hypothesis.
