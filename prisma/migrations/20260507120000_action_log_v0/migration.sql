-- CreateTable
CREATE TABLE "ActionLog" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "actorType" TEXT NOT NULL DEFAULT 'system',
    "targetType" TEXT,
    "targetId" TEXT,
    "workflowRunId" TEXT,
    "approvalId" TEXT,
    "riskLevel" TEXT NOT NULL DEFAULT 'low',
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "approvalStatus" TEXT,
    "externalActionTaken" BOOLEAN NOT NULL DEFAULT false,
    "canGoLiveNow" BOOLEAN NOT NULL DEFAULT false,
    "summary" TEXT NOT NULL,
    "inputSummary" JSONB,
    "outputSummary" JSONB,
    "errorMessage" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActionLog_eventType_createdAt_idx" ON "ActionLog"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "ActionLog_actionType_createdAt_idx" ON "ActionLog"("actionType", "createdAt");

-- CreateIndex
CREATE INDEX "ActionLog_status_createdAt_idx" ON "ActionLog"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ActionLog_workflowRunId_createdAt_idx" ON "ActionLog"("workflowRunId", "createdAt");

-- CreateIndex
CREATE INDEX "ActionLog_approvalId_createdAt_idx" ON "ActionLog"("approvalId", "createdAt");

-- CreateIndex
CREATE INDEX "ActionLog_targetType_targetId_idx" ON "ActionLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "ActionLog_createdAt_idx" ON "ActionLog"("createdAt");
