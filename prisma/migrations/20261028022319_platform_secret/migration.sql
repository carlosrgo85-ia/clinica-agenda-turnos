-- CreateTable
CREATE TABLE "PlatformSecret" (
    "key" TEXT NOT NULL,
    "expiresOn" DATE NOT NULL,
    "note" TEXT,
    "lastReminderOn" DATE,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSecret_pkey" PRIMARY KEY ("key")
);
