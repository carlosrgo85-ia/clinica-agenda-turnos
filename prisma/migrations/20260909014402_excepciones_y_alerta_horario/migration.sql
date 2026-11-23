-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN     "workingHoursAlertSentAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ScheduleException" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "professionalId" TEXT,
    "date" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "startMinute" INTEGER,
    "endMinute" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleException_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduleException_clinicId_date_idx" ON "ScheduleException"("clinicId", "date");

-- CreateIndex
CREATE INDEX "ScheduleException_clinicId_professionalId_date_idx" ON "ScheduleException"("clinicId", "professionalId", "date");

-- AddForeignKey
ALTER TABLE "ScheduleException" ADD CONSTRAINT "ScheduleException_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleException" ADD CONSTRAINT "ScheduleException_professionalId_fkey" FOREIGN KEY ("professionalId") REFERENCES "Professional"("id") ON DELETE SET NULL ON UPDATE CASCADE;
