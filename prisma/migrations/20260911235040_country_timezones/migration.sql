-- AlterTable
ALTER TABLE "Country" ADD COLUMN     "timezones" TEXT[] DEFAULT ARRAY[]::TEXT[];
