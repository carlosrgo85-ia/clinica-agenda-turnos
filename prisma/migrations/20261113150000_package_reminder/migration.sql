-- AlterTable: el último día en que se mandó el mail de citas por paquete sin marcar.
ALTER TABLE "Clinic" ADD COLUMN "packageReminderSentOn" DATE;
