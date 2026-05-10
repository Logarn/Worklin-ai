-- Opportunity-driven Micro-Campaign Factory v0
-- Prepared local packages only; no briefs, drafts, segments, syncs, sends, schedules, or live external actions.

CREATE TABLE "MicroCampaignPackageStore" (
    "id" TEXT NOT NULL,
    "packageKey" TEXT NOT NULL,
    "packageVersion" TEXT NOT NULL,
    "opportunityKey" TEXT NOT NULL,
    "opportunityId" TEXT,
    "opportunityVersion" TEXT NOT NULL,
    "timeframeDays" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "packageType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "confidence" TEXT NOT NULL,
    "activationStatus" TEXT NOT NULL,
    "approvalStatus" TEXT NOT NULL,
    "sourceOpportunity" JSONB NOT NULL,
    "linkedMicroSegment" JSONB NOT NULL,
    "audienceLogic" JSONB NOT NULL,
    "messageAngle" JSONB NOT NULL,
    "productOfferDirection" JSONB NOT NULL,
    "subjectCopyBriefDirection" JSONB NOT NULL,
    "qaRisks" JSONB NOT NULL,
    "approvalReadiness" JSONB NOT NULL,
    "blockedNextActions" JSONB NOT NULL,
    "plannerHandoff" JSONB NOT NULL,
    "briefHandoff" JSONB NOT NULL,
    "sourceSummary" JSONB NOT NULL,
    "caveats" JSONB NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MicroCampaignPackageStore_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MicroCampaignPackageStore_packageKey_timeframeDays_packageVersion_key" ON "MicroCampaignPackageStore"("packageKey", "timeframeDays", "packageVersion");
CREATE INDEX "MicroCampaignPackageStore_packageKey_idx" ON "MicroCampaignPackageStore"("packageKey");
CREATE INDEX "MicroCampaignPackageStore_opportunityKey_idx" ON "MicroCampaignPackageStore"("opportunityKey");
CREATE INDEX "MicroCampaignPackageStore_opportunityId_idx" ON "MicroCampaignPackageStore"("opportunityId");
CREATE INDEX "MicroCampaignPackageStore_computedAt_idx" ON "MicroCampaignPackageStore"("computedAt");
CREATE INDEX "MicroCampaignPackageStore_status_idx" ON "MicroCampaignPackageStore"("status");
CREATE INDEX "MicroCampaignPackageStore_priority_idx" ON "MicroCampaignPackageStore"("priority");
CREATE INDEX "MicroCampaignPackageStore_packageType_idx" ON "MicroCampaignPackageStore"("packageType");
CREATE INDEX "MicroCampaignPackageStore_approvalStatus_idx" ON "MicroCampaignPackageStore"("approvalStatus");
