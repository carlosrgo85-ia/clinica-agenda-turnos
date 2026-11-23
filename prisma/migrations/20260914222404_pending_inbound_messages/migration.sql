-- CreateTable
CREATE TABLE "PendingInboundMessage" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "patientPhone" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingInboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PendingInboundMessage_clinicId_patientPhone_receivedAt_idx" ON "PendingInboundMessage"("clinicId", "patientPhone", "receivedAt");

-- CreateIndex
CREATE INDEX "PendingInboundMessage_receivedAt_idx" ON "PendingInboundMessage"("receivedAt");

-- AddForeignKey
ALTER TABLE "PendingInboundMessage" ADD CONSTRAINT "PendingInboundMessage_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
