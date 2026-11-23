-- Escrita a mano: Prisma generaba DROP + ADD, que se lleva puestos los
-- tokens de las clínicas ya cargadas. Un RENAME conserva los valores.
--
-- OJO: después de esta migración los valores siguen estando EN TEXTO PLANO,
-- solo cambió el nombre de la columna. Hay que correr el backfill que los
-- cifra, que es idempotente:
--
--   npx tsx scripts/encrypt-whatsapp-tokens.ts
--
ALTER TABLE "Clinic" RENAME COLUMN "whatsappToken" TO "whatsappTokenEncrypted";

-- El WABA (WhatsApp Business Account) dueño del número. Nullable porque las
-- clínicas dadas de alta a mano no lo tienen cargado.
ALTER TABLE "Clinic" ADD COLUMN "whatsappWabaId" TEXT;
