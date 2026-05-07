-- CreateIndex
CREATE UNIQUE INDEX "Approval_pending_target_unique_idx"
ON "Approval"("targetType", "targetId")
WHERE "status" = 'pending';
