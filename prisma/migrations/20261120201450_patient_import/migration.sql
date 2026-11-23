-- AlterTable
ALTER TABLE "Patient" ADD COLUMN     "importBatchId" TEXT,
ADD COLUMN     "priorHistory" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "priorLastVisitOn" DATE;

-- CreateIndex
CREATE INDEX "Patient_clinicId_importBatchId_idx" ON "Patient"("clinicId", "importBatchId");
