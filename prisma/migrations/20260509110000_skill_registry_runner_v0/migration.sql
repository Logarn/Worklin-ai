-- Skill Registry / Skill Runner v0
CREATE TABLE "WorklinSkill" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "origin" TEXT NOT NULL DEFAULT 'agent_created',
    "scope" TEXT NOT NULL DEFAULT 'workspace',
    "triggerExamples" JSONB,
    "requiredInputs" JSONB,
    "optionalInputs" JSONB,
    "requiredContext" JSONB,
    "toolsUsed" JSONB,
    "procedureSteps" JSONB,
    "verificationChecklist" JSONB,
    "pitfalls" JSONB,
    "safetyLevel" TEXT NOT NULL DEFAULT 'low',
    "approvalRequirements" JSONB,
    "outputShape" JSONB,
    "caveats" JSONB,
    "version" TEXT NOT NULL DEFAULT '0.1.0',
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdFromWorkflowRunId" TEXT,
    "createdFromActionLogId" TEXT,
    "missingCapabilities" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorklinSkill_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WorklinSkill_status_category_idx" ON "WorklinSkill"("status", "category");
CREATE INDEX "WorklinSkill_origin_status_idx" ON "WorklinSkill"("origin", "status");
CREATE INDEX "WorklinSkill_scope_status_idx" ON "WorklinSkill"("scope", "status");
CREATE INDEX "WorklinSkill_createdFromWorkflowRunId_idx" ON "WorklinSkill"("createdFromWorkflowRunId");
CREATE INDEX "WorklinSkill_createdFromActionLogId_idx" ON "WorklinSkill"("createdFromActionLogId");
CREATE INDEX "WorklinSkill_lastUsedAt_idx" ON "WorklinSkill"("lastUsedAt");
CREATE INDEX "WorklinSkill_createdAt_idx" ON "WorklinSkill"("createdAt");
