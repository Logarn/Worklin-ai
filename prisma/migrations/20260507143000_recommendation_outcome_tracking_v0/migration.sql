-- Recommendation Outcome Tracking v0
-- Tracks the lifecycle state of Worklin recommendations and prepared fixes.

CREATE TABLE "RecommendationOutcome" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceWorkflowRunId" TEXT,
    "recommendationId" TEXT,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "domain" TEXT,
    "actionType" TEXT,
    "targetType" TEXT,
    "targetId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'recommended',
    "priority" TEXT,
    "confidence" DOUBLE PRECISION,
    "approvalId" TEXT,
    "actionLogId" TEXT,
    "decisionNote" TEXT,
    "outcomeNote" TEXT,
    "metadata" JSONB,
    "decidedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecommendationOutcome_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RecommendationOutcome_sourceWorkflowRunId_recommendationId_key" ON "RecommendationOutcome"("sourceWorkflowRunId", "recommendationId");
CREATE INDEX "RecommendationOutcome_sourceType_sourceId_idx" ON "RecommendationOutcome"("sourceType", "sourceId");
CREATE INDEX "RecommendationOutcome_sourceWorkflowRunId_status_idx" ON "RecommendationOutcome"("sourceWorkflowRunId", "status");
CREATE INDEX "RecommendationOutcome_recommendationId_idx" ON "RecommendationOutcome"("recommendationId");
CREATE INDEX "RecommendationOutcome_status_updatedAt_idx" ON "RecommendationOutcome"("status", "updatedAt");
CREATE INDEX "RecommendationOutcome_domain_status_idx" ON "RecommendationOutcome"("domain", "status");
CREATE INDEX "RecommendationOutcome_actionType_status_idx" ON "RecommendationOutcome"("actionType", "status");
CREATE INDEX "RecommendationOutcome_targetType_targetId_idx" ON "RecommendationOutcome"("targetType", "targetId");
CREATE INDEX "RecommendationOutcome_approvalId_idx" ON "RecommendationOutcome"("approvalId");
CREATE INDEX "RecommendationOutcome_actionLogId_idx" ON "RecommendationOutcome"("actionLogId");
CREATE INDEX "RecommendationOutcome_createdAt_idx" ON "RecommendationOutcome"("createdAt");
