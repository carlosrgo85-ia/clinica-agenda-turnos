-- Cuándo se avisó a la clínica que una cuenta de calendario hay que reconectarla.
ALTER TABLE "GoogleAccount" ADD COLUMN "revokedAlertSentAt" TIMESTAMP(3);
ALTER TABLE "MicrosoftAccount" ADD COLUMN "revokedAlertSentAt" TIMESTAMP(3);
