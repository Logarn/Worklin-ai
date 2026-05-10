-- Customer Feature Store v0
CREATE TABLE "CustomerFeatureStore" (
    "id" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "worklinCustomerId" TEXT,
    "shopifyCustomerId" TEXT,
    "klaviyoProfileId" TEXT,
    "identityConfidence" TEXT NOT NULL,
    "featureVersion" TEXT NOT NULL,
    "timeframeDays" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "sourceSystems" JSONB NOT NULL,
    "sourceCoverage" JSONB NOT NULL,
    "commerceFeatures" JSONB NOT NULL,
    "engagementFeatures" JSONB NOT NULL,
    "intentFeatures" JSONB NOT NULL,
    "lifecycleFeatures" JSONB NOT NULL,
    "cohortFeatures" JSONB NOT NULL,
    "derivedLabels" JSONB NOT NULL,
    "missingCapabilities" JSONB NOT NULL,
    "caveats" JSONB NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerFeatureStore_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerFeatureStore_identityId_timeframeDays_featureVersion_key"
ON "CustomerFeatureStore"("identityId", "timeframeDays", "featureVersion");

CREATE INDEX "CustomerFeatureStore_identityId_idx" ON "CustomerFeatureStore"("identityId");
CREATE INDEX "CustomerFeatureStore_worklinCustomerId_idx" ON "CustomerFeatureStore"("worklinCustomerId");
CREATE INDEX "CustomerFeatureStore_shopifyCustomerId_idx" ON "CustomerFeatureStore"("shopifyCustomerId");
CREATE INDEX "CustomerFeatureStore_klaviyoProfileId_idx" ON "CustomerFeatureStore"("klaviyoProfileId");
CREATE INDEX "CustomerFeatureStore_computedAt_idx" ON "CustomerFeatureStore"("computedAt");
CREATE INDEX "CustomerFeatureStore_status_idx" ON "CustomerFeatureStore"("status");
