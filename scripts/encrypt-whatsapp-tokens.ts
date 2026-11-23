import { prisma } from "../src/db/client";
import { decryptToken, encryptToken } from "../src/services/crypto";

/**
 * Cifra los tokens de WhatsApp que quedaron en texto plano.
 *
 * La migración `20260913010000_whatsapp_waba_and_encrypted_token` solo
 * renombró la columna (`whatsappToken` → `whatsappTokenEncrypted`) para no
 * perder los valores: el cifrado de los que ya estaban cargados lo hace
 * esto. Hay que correrlo una vez después de migrar, en cada ambiente:
 *
 *   npx tsx scripts/encrypt-whatsapp-tokens.ts
 *
 * Es idempotente: detecta lo que ya está cifrado intentando descifrarlo, así
 * que correrlo dos veces no cifra dos veces (que dejaría el token
 * irrecuperable). Sin `CALENDAR_TOKEN_ENCRYPTION_KEY` falla antes de tocar
 * nada.
 */
async function main() {
  const clinics = await prisma.clinic.findMany({
    select: { id: true, name: true, whatsappTokenEncrypted: true },
  });

  let cifrados = 0;
  let yaEstaban = 0;

  for (const clinic of clinics) {
    if (yaEstaCifrado(clinic.whatsappTokenEncrypted)) {
      yaEstaban++;
      continue;
    }

    await prisma.clinic.update({
      where: { id: clinic.id },
      data: { whatsappTokenEncrypted: encryptToken(clinic.whatsappTokenEncrypted) },
    });
    cifrados++;
    console.log(`Cifrado el token de ${clinic.name} (${clinic.id})`);
  }

  console.log(
    `\nListo: ${cifrados} cifrado(s), ${yaEstaban} que ya lo estaban, ${clinics.length} en total.`
  );
}

/**
 * El formato cifrado es `iv:authTag:ciphertext` en base64, y GCM autentica:
 * si `decryptToken` no explota, el valor ya estaba cifrado con ESTA clave.
 * Un token de Meta en texto plano no tiene esa forma.
 */
function yaEstaCifrado(valor: string): boolean {
  try {
    decryptToken(valor);
    return true;
  } catch {
    return false;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
