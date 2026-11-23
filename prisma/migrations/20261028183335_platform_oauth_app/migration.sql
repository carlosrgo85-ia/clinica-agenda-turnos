-- CreateTable
CREATE TABLE "PlatformOAuthApp" (
    "provider" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "clientSecretEncrypted" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformOAuthApp_pkey" PRIMARY KEY ("provider")
);
