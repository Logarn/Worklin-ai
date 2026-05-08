-- Results Ingestion + Learning Loop v0 stores state-only performance observations.
-- It does not execute, send, schedule, sync, draft, or mutate external platforms.

CREATE TABLE "RecommendationResult" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "recommendationOutcomeId" TEXT,
    "workflowRunId" TEXT,
    "campaignMemoryId" TEXT,
    "externalPlatform" TEXT,
    "externalId" TEXT,
    "resultType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "timeframeStart" TIMESTAMP(3),
    "timeframeEnd" TIMESTAMP(3),
    "metrics" JSONB,
    "summary" TEXT,
    "learningSignal" TEXT NOT NULL,
    "learningStatus" TEXT NOT NULL DEFAULT 'learned',
    "lessons" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecommendationResult_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RecommendationResult_sourceType_sourceId_idx" ON "RecommendationResult"("sourceType", "sourceId");
CREATE INDEX "RecommendationResult_recommendationOutcomeId_createdAt_idx" ON "RecommendationResult"("recommendationOutcomeId", "createdAt");
CREATE INDEX "RecommendationResult_workflowRunId_createdAt_idx" ON "RecommendationResult"("workflowRunId", "createdAt");
CREATE INDEX "RecommendationResult_campaignMemoryId_createdAt_idx" ON "RecommendationResult"("campaignMemoryId", "createdAt");
CREATE INDEX "RecommendationResult_externalPlatform_externalId_idx" ON "RecommendationResult"("externalPlatform", "externalId");
CREATE INDEX "RecommendationResult_resultType_status_idx" ON "RecommendationResult"("resultType", "status");
CREATE INDEX "RecommendationResult_learningSignal_createdAt_idx" ON "RecommendationResult"("learningSignal", "createdAt");
CREATE INDEX "RecommendationResult_createdAt_idx" ON "RecommendationResult"("createdAt");
