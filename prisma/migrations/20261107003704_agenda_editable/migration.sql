-- CreateEnum
CREATE TYPE "CalendarBlockSource" AS ENUM ('calendario', 'manual');

-- CreateEnum
CREATE TYPE "AppointmentSource" AS ENUM ('whatsapp', 'panel');

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "createdByUserId" TEXT,
ADD COLUMN     "forcedRules" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "modifiedAt" TIMESTAMP(3),
ADD COLUMN     "modifiedByUserId" TEXT,
ADD COLUMN     "source" "AppointmentSource" NOT NULL DEFAULT 'whatsapp';

-- AlterTable
ALTER TABLE "CalendarBlock" ADD COLUMN     "createdByUserId" TEXT,
ADD COLUMN     "source" "CalendarBlockSource" NOT NULL DEFAULT 'calendario',
ADD COLUMN     "title" TEXT;
