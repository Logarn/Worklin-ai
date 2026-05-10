-- Micro-Segment / Segment Definition Builder v0
CREATE TABLE "MicroSegmentDefinitionStore" (
    "id" TEXT NOT NULL,
    "definitionKey" TEXT NOT NULL,
    "definitionVersion" TEXT NOT NULL,
    "timeframeDays" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "confidence" TEXT NOT NULL,
    "activationStatus" TEXT NOT NULL,
    "qualifyingLogic" JSONB NOT NULL,
    "audienceEstimate" JSONB NOT NULL,
    "whyItMatters" JSONB NOT NULL,
    "recommendedUseCases" JSONB NOT NULL,
    "productOrOfferDirection" JSONB NOT NULL,
    "collisionArbitrationHints" JSONB NOT NULL,
    "klaviyoNativePossible" BOOLEAN NOT NULL DEFAULT false,
    "requiresWorklinProperties" BOOLEAN NOT NULL DEFAULT true,
    "sourceScoringVersion" TEXT NOT NULL,
    "sourceFeatureVersion" TEXT NOT NULL,
    "sourceScoreSummary" JSONB NOT NULL,
    "missingCapabilities" JSONB NOT NULL,
    "caveats" JSONB NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MicroSegmentDefinitionStore_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MicroSegmentDefinitionStore_definitionKey_timeframeDays_definitionVersion_key"
ON "MicroSegmentDefinitionStore"("definitionKey", "timeframeDays", "definitionVersion");

CREATE INDEX "MicroSegmentDefinitionStore_definitionKey_idx" ON "MicroSegmentDefinitionStore"("definitionKey");
CREATE INDEX "MicroSegmentDefinitionStore_computedAt_idx" ON "MicroSegmentDefinitionStore"("computedAt");
CREATE INDEX "MicroSegmentDefinitionStore_status_idx" ON "MicroSegmentDefinitionStore"("status");
CREATE INDEX "MicroSegmentDefinitionStore_priority_idx" ON "MicroSegmentDefinitionStore"("priority");
