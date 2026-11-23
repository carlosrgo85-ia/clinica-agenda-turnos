-- Cada solicitud al agente (la llamada al modelo): metadatos, costo y decisión. Sin texto.
CREATE TABLE "AgentRequest" (
    "id" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clinicId" TEXT NOT NULL,
    "patientId" TEXT,
    "turnId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "model" TEXT NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cacheReadTokens" INTEGER,
    "cacheCreationTokens" INTEGER,
    "stopReason" TEXT,
    "promptChars" INTEGER,
    "outcome" TEXT NOT NULL,
    "errorMessage" TEXT,
    "intent" TEXT,
    "decision" JSONB,
    CONSTRAINT "AgentRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AgentRequest_clinicId_occurredAt_idx" ON "AgentRequest"("clinicId", "occurredAt");
CREATE INDEX "AgentRequest_turnId_idx" ON "AgentRequest"("turnId");
CREATE INDEX "AgentRequest_outcome_occurredAt_idx" ON "AgentRequest"("outcome", "occurredAt");
ALTER TABLE "AgentRequest" ADD CONSTRAINT "AgentRequest_clinicId_fkey"
  FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
