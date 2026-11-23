-- AlterTable
ALTER TABLE "PlatformSecret" ADD COLUMN     "valueEncrypted" TEXT,
ALTER COLUMN "expiresOn" DROP NOT NULL;
