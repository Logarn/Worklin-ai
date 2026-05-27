-- Arbitration + Frequency Guardrails v0
-- Advisory-only durable package-level arbitration records for the micro-campaign factory.

CREATE TABLE "MicroCampaignArbitrationStore" (
    "id" TEXT NOT NULL,
    "arbitrationKey" TEXT NOT NULL,
    "arbitrationVersion" TEXT NOT NULL,
    "packageKey" TEXT NOT NULL,
    "packageId" TEXT,
    "opportunityKey" TEXT,
    "opportunityId" TEXT,
    "microSegmentDefinitionKey" TEXT,
    "identityId" TEXT,
    "worklinCustomerId" TEXT,
    "shopifyCustomerId" TEXT,
    "klaviyoProfileId" TEXT,
    "timeframeDays" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "decision" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "rank" INTEGER NOT NULL,
    "confidence" TEXT NOT NULL,
    "activationStatus" TEXT NOT NULL,
    "packageType" TEXT NOT NULL,
    "packageStatus" TEXT NOT NULL,
    "frequencyStatus" JSONB NOT NULL,
    "cooldownRecommendation" JSONB NOT NULL,
    "guardrailFlags" JSONB NOT NULL,
    "winningReason" TEXT NOT NULL,
    "losingReasons" JSONB NOT NULL,
    "conflictNotes" JSONB NOT NULL,
    "suppressedPackageKeys" JSONB NOT NULL,
    "suppressedByPackageKeys" JSONB NOT NULL,
    "recommendedNextStep" TEXT NOT NULL,
    "sourcePackage" JSONB NOT NULL,
    "sourceOpportunity" JSONB NOT NULL,
    "sourceMicroSegment" JSONB NOT NULL,
    "caveats" JSONB NOT NULL,
    "externalActionTaken" BOOLEAN NOT NULL DEFAULT false,
    "canGoLiveNow" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MicroCampaignArbitrationStore_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MicroCampaignArbitrationStore_arbitrationKey_timeframeDays_arbit_key"
ON "MicroCampaignArbitrationStore"("arbitrationKey", "timeframeDays", "arbitrationVersion");

CREATE INDEX "MicroCampaignArbitrationStore_arbitrationKey_idx" ON "MicroCampaignArbitrationStore"("arbitrationKey");
CREATE INDEX "MicroCampaignArbitrationStore_packageKey_idx" ON "MicroCampaignArbitrationStore"("packageKey");
CREATE INDEX "MicroCampaignArbitrationStore_packageId_idx" ON "MicroCampaignArbitrationStore"("packageId");
CREATE INDEX "MicroCampaignArbitrationStore_opportunityKey_idx" ON "MicroCampaignArbitrationStore"("opportunityKey");
CREATE INDEX "MicroCampaignArbitrationStore_microSegmentDefinitionKey_idx" ON "MicroCampaignArbitrationStore"("microSegmentDefinitionKey");
CREATE INDEX "MicroCampaignArbitrationStore_identityId_idx" ON "MicroCampaignArbitrationStore"("identityId");
CREATE INDEX "MicroCampaignArbitrationStore_computedAt_idx" ON "MicroCampaignArbitrationStore"("computedAt");
CREATE INDEX "MicroCampaignArbitrationStore_decision_idx" ON "MicroCampaignArbitrationStore"("decision");
CREATE INDEX "MicroCampaignArbitrationStore_rank_idx" ON "MicroCampaignArbitrationStore"("rank");
CREATE INDEX "MicroCampaignArbitrationStore_priority_idx" ON "MicroCampaignArbitrationStore"("priority");
CREATE INDEX "MicroCampaignArbitrationStore_packageType_idx" ON "MicroCampaignArbitrationStore"("packageType");
CREATE INDEX "MicroCampaignArbitrationStore_packageStatus_idx" ON "MicroCampaignArbitrationStore"("packageStatus");
