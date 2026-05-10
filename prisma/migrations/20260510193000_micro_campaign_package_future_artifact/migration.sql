-- Add an explicit futureArtifact handoff pointer to prepared micro-campaign packages.

ALTER TABLE "MicroCampaignPackageStore" ADD COLUMN "futureArtifact" JSONB NOT NULL DEFAULT '{}'::jsonb;
