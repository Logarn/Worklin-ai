-- Campaign Opportunity Engine v0
-- Durable, prepare-only campaign opportunity definitions derived from
-- micro-segment definitions and local customer intelligence.

CREATE TABLE IF NOT EXISTS "CampaignOpportunityStore" (
  "id" TEXT NOT NULL,
  "opportunityKey" TEXT NOT NULL,
  "opportunityVersion" TEXT NOT NULL,
  "timeframeDays" INTEGER NOT NULL,
  "computedAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "priority" INTEGER NOT NULL,
  "confidence" TEXT NOT NULL,
  "activationStatus" TEXT NOT NULL,
  "linkedMicroSegment" JSONB NOT NULL,
  "audienceEstimate" JSONB NOT NULL,
  "whyItMatters" JSONB NOT NULL,
  "recommendedCampaignType" TEXT NOT NULL,
  "recommendedUseCase" JSONB NOT NULL,
  "recommendedProductOfferMessageDirection" JSONB NOT NULL,
  "recommendedChannel" TEXT,
  "suppressionCollisionHints" JSONB NOT NULL,
  "requiredFutureCapabilities" JSONB NOT NULL,
  "blockedByMissingCapabilities" JSONB NOT NULL,
  "sourceDefinitionVersion" TEXT NOT NULL,
  "sourceScoringVersion" TEXT NOT NULL,
  "sourceFeatureVersion" TEXT NOT NULL,
  "sourceSummary" JSONB NOT NULL,
  "caveats" JSONB NOT NULL,
  "metadata" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CampaignOpportunityStore_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CampaignOpportunityStore_opportunityKey_timeframeDays_opportunityVersion_key"
  ON "CampaignOpportunityStore"("opportunityKey", "timeframeDays", "opportunityVersion");

CREATE INDEX IF NOT EXISTS "CampaignOpportunityStore_opportunityKey_idx"
  ON "CampaignOpportunityStore"("opportunityKey");

CREATE INDEX IF NOT EXISTS "CampaignOpportunityStore_computedAt_idx"
  ON "CampaignOpportunityStore"("computedAt");

CREATE INDEX IF NOT EXISTS "CampaignOpportunityStore_status_idx"
  ON "CampaignOpportunityStore"("status");

CREATE INDEX IF NOT EXISTS "CampaignOpportunityStore_priority_idx"
  ON "CampaignOpportunityStore"("priority");

CREATE INDEX IF NOT EXISTS "CampaignOpportunityStore_recommendedCampaignType_idx"
  ON "CampaignOpportunityStore"("recommendedCampaignType");
