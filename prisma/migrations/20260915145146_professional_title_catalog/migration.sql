/*
  Warnings:

  - You are about to drop the column `title` on the `Professional` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Professional" DROP COLUMN "title",
ADD COLUMN     "titleId" TEXT;

-- CreateTable
CREATE TABLE "ProfessionalTitle" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfessionalTitle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_ClinicProfessionalTitles" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ProfessionalTitle_name_key" ON "ProfessionalTitle"("name");

-- CreateIndex
CREATE UNIQUE INDEX "_ClinicProfessionalTitles_AB_unique" ON "_ClinicProfessionalTitles"("A", "B");

-- CreateIndex
CREATE INDEX "_ClinicProfessionalTitles_B_index" ON "_ClinicProfessionalTitles"("B");

-- CreateIndex
CREATE INDEX "Professional_titleId_idx" ON "Professional"("titleId");

-- AddForeignKey
ALTER TABLE "Professional" ADD CONSTRAINT "Professional_titleId_fkey" FOREIGN KEY ("titleId") REFERENCES "ProfessionalTitle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ClinicProfessionalTitles" ADD CONSTRAINT "_ClinicProfessionalTitles_A_fkey" FOREIGN KEY ("A") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ClinicProfessionalTitles" ADD CONSTRAINT "_ClinicProfessionalTitles_B_fkey" FOREIGN KEY ("B") REFERENCES "ProfessionalTitle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
