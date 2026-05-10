-- Campaign Opportunity Engine v0 quality fields
-- Adds explicit opportunity type, why-now rationale, and future artifact
-- guidance so opportunity records do not read as micro-segment restatements.

ALTER TABLE "CampaignOpportunityStore"
  ADD COLUMN IF NOT EXISTS "opportunityType" TEXT NOT NULL DEFAULT 'campaign',
  ADD COLUMN IF NOT EXISTS "whyNow" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "futureArtifact" JSONB NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS "CampaignOpportunityStore_opportunityType_idx"
  ON "CampaignOpportunityStore"("opportunityType");
