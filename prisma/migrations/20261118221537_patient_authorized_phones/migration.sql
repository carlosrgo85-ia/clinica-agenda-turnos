-- AlterTable
ALTER TABLE "Patient" ADD COLUMN     "authorizedPhones" TEXT[] DEFAULT ARRAY[]::TEXT[];
