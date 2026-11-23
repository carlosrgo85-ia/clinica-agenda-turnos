-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN     "sharedCalendarId" TEXT;

-- AlterTable
ALTER TABLE "Professional" ADD COLUMN     "blockSyncEnabled" BOOLEAN NOT NULL DEFAULT true,
ALTER COLUMN "googleCalendarId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "CalendarBlock" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "professionalId" TEXT NOT NULL,
    "googleEventId" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "isAllDay" BOOLEAN NOT NULL DEFAULT false,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarBlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CalendarBlock_clinicId_professionalId_startTime_idx" ON "CalendarBlock"("clinicId", "professionalId", "startTime");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarBlock_professionalId_googleEventId_key" ON "CalendarBlock"("professionalId", "googleEventId");

-- AddForeignKey
ALTER TABLE "CalendarBlock" ADD CONSTRAINT "CalendarBlock_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarBlock" ADD CONSTRAINT "CalendarBlock_professionalId_fkey" FOREIGN KEY ("professionalId") REFERENCES "Professional"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
