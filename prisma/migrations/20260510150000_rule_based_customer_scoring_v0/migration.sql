-- Rule-Based Customer Scoring v0
CREATE TABLE "CustomerScoreStore" (
    "id" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "worklinCustomerId" TEXT,
    "shopifyCustomerId" TEXT,
    "klaviyoProfileId" TEXT,
    "sourceFeatureStoreId" TEXT,
    "featureVersion" TEXT NOT NULL,
    "scoringVersion" TEXT NOT NULL,
    "timeframeDays" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "identityConfidence" TEXT NOT NULL,
    "featureStatus" TEXT NOT NULL,
    "scores" JSONB NOT NULL,
    "scoreSummary" JSONB NOT NULL,
    "actionPriorityHints" JSONB NOT NULL,
    "arbitrationMetadata" JSONB NOT NULL,
    "sourceFeatureSummary" JSONB NOT NULL,
    "sourceCoverage" JSONB NOT NULL,
    "missingCapabilities" JSONB NOT NULL,
    "caveats" JSONB NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerScoreStore_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerScoreStore_identityId_timeframeDays_scoringVersion_key"
ON "CustomerScoreStore"("identityId", "timeframeDays", "scoringVersion");

CREATE INDEX "CustomerScoreStore_identityId_idx" ON "CustomerScoreStore"("identityId");
CREATE INDEX "CustomerScoreStore_worklinCustomerId_idx" ON "CustomerScoreStore"("worklinCustomerId");
CREATE INDEX "CustomerScoreStore_shopifyCustomerId_idx" ON "CustomerScoreStore"("shopifyCustomerId");
CREATE INDEX "CustomerScoreStore_klaviyoProfileId_idx" ON "CustomerScoreStore"("klaviyoProfileId");
CREATE INDEX "CustomerScoreStore_sourceFeatureStoreId_idx" ON "CustomerScoreStore"("sourceFeatureStoreId");
CREATE INDEX "CustomerScoreStore_computedAt_idx" ON "CustomerScoreStore"("computedAt");
CREATE INDEX "CustomerScoreStore_status_idx" ON "CustomerScoreStore"("status");
