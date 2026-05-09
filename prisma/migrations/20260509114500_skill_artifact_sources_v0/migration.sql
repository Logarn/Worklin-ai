-- Skill artifact source declarations v0
ALTER TABLE "WorklinSkill"
ADD COLUMN "preferredSources" JSONB,
ADD COLUMN "fallbackSources" JSONB,
ADD COLUMN "requiredArtifacts" JSONB,
ADD COLUMN "optionalArtifacts" JSONB,
ADD COLUMN "missingSourceBehavior" JSONB,
ADD COLUMN "connectorDependencies" JSONB;
