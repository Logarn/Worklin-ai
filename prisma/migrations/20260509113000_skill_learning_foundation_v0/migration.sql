-- Skill Learning Foundation v0
ALTER TABLE "WorklinSkill"
ADD COLUMN "runMode" TEXT NOT NULL DEFAULT 'assist',
ADD COLUMN "workspaceContextSuggestions" JSONB,
ADD COLUMN "oneOffDetailsNotSavedToSkill" JSONB;

CREATE INDEX "WorklinSkill_runMode_status_idx" ON "WorklinSkill"("runMode", "status");
