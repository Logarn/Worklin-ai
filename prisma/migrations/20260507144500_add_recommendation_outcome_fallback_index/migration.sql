-- Support deterministic duplicate lookup when a recommendation is tracked without a WorkflowRun id.

CREATE INDEX "RecommendationOutcome_sourceType_sourceId_recommendationId_idx"
ON "RecommendationOutcome"("sourceType", "sourceId", "recommendationId");
