-- CreateEnum
CREATE TYPE "HolidayRuleKind" AS ENUM ('fixed', 'nthWeekday', 'easter');

-- CreateTable
CREATE TABLE "Country" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Country_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HolidayRule" (
    "id" TEXT NOT NULL,
    "countryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "HolidayRuleKind" NOT NULL,
    "month" INTEGER,
    "day" INTEGER,
    "weekday" INTEGER,
    "ordinal" INTEGER,
    "offsetDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HolidayRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HolidayRule_countryId_idx" ON "HolidayRule"("countryId");

-- AddForeignKey
ALTER TABLE "HolidayRule" ADD CONSTRAINT "HolidayRule_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "Country"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
