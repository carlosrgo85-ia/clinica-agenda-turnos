import { prisma } from "../db/client";
import type { TrackedSecretKey } from "../config/tracked-secrets";
import { encryptToken } from "../services/crypto";
import { clinicDateKey, dateKeyToUtcMidnight } from "../services/time";

/**
 * Lo que se sabe de un secreto. Las fechas salen como "YYYY-MM-DD".
 *
 * **Nunca lleva el valor, ni siquiera cifrado**: la columna `valueEncrypted`
 * se lee solo desde `getPlatformSecretValueEncrypted()`, que usa
 * `services/platform-secrets.ts`. El filtro está acá y no en cada ruta a
 * propósito: si dependiera de que cada handler se acuerde, el próximo
 * endpoint lo devuelve. Mismo criterio que `listAllClinics()` con el token de
 * WhatsApp.
 */
export interface PlatformSecretRecord {
  key: string;
  /** null = no se sigue el vencimiento. */
  expiresOn: string | null;
  note: string | null;
  lastReminderOn: string | null;
  /** Hay un valor guardado en la base (no cuál es). */
  hasStoredValue: boolean;
}

/**
 * Las columnas `@db.Date` se leen y se escriben SIEMPRE por medianoche UTC
 * (ver `dateKeyToUtcMidnight`): así el día no se corre según la zona del
 * servidor.
 */
const toKey = (date: Date): string => clinicDateKey(date, "UTC");

function toRecord(row: {
  key: string;
  expiresOn: Date | null;
  note: string | null;
  lastReminderOn: Date | null;
  valueEncrypted: string | null;
}): PlatformSecretRecord {
  return {
    key: row.key,
    expiresOn: row.expiresOn ? toKey(row.expiresOn) : null,
    note: row.note,
    lastReminderOn: row.lastReminderOn ? toKey(row.lastReminderOn) : null,
    hasStoredValue: row.valueEncrypted !== null,
  };
}

export async function listPlatformSecrets(): Promise<PlatformSecretRecord[]> {
  const rows = await prisma.platformSecret.findMany({ orderBy: { key: "asc" } });
  return rows.map(toRecord);
}

/**
 * Guarda el vencimiento de un secreto y, si viene, su valor (cifrado). Sin
 * `value` el valor que ya había no se toca: cambiar la fecha o la nota no
 * pisa el secreto.
 *
 * Se borra `lastReminderOn`: una fecha nueva es un secreto renovado, y el
 * próximo recordatorio tiene que poder salir el primer día de su ventana.
 */
export async function savePlatformSecret(
  key: TrackedSecretKey,
  input: { expiresOn: string; note: string | null; value?: string }
): Promise<PlatformSecretRecord> {
  const date = dateKeyToUtcMidnight(input.expiresOn);
  if (!date) throw new Error(`Fecha inválida: ${input.expiresOn}`);

  const valueEncrypted = input.value !== undefined ? encryptToken(input.value) : undefined;
  const row = await prisma.platformSecret.upsert({
    where: { key },
    create: { key, expiresOn: date, note: input.note, valueEncrypted },
    update: { expiresOn: date, note: input.note, lastReminderOn: null, ...(valueEncrypted ? { valueEncrypted } : {}) },
  });
  return toRecord(row);
}

/**
 * Deja de seguir el vencimiento: apaga los recordatorios. **No toca el valor
 * guardado**: quitar el aviso no puede dejar a la integración sin secreto.
 */
export async function clearPlatformSecretExpiry(key: TrackedSecretKey): Promise<void> {
  const row = await prisma.platformSecret.findUnique({ where: { key } });
  if (!row) return;
  if (row.valueEncrypted === null) {
    await prisma.platformSecret.delete({ where: { key } });
    return;
  }
  await prisma.platformSecret.update({
    where: { key },
    data: { expiresOn: null, note: null, lastReminderOn: null },
  });
}

/**
 * Quita el valor guardado: desde ahí se usa la variable del `.env`. **No toca
 * el vencimiento.**
 */
export async function clearPlatformSecretValue(key: TrackedSecretKey): Promise<void> {
  const row = await prisma.platformSecret.findUnique({ where: { key } });
  if (!row) return;
  if (row.expiresOn === null) {
    await prisma.platformSecret.delete({ where: { key } });
    return;
  }
  await prisma.platformSecret.update({ where: { key }, data: { valueEncrypted: null } });
}

/** Para `services/platform-secrets.ts`, el único que descifra. */
export async function getPlatformSecretValueEncrypted(key: string): Promise<string | null> {
  const row = await prisma.platformSecret.findUnique({ where: { key }, select: { valueEncrypted: true } });
  return row?.valueEncrypted ?? null;
}

export async function markSecretReminded(key: string, today: string): Promise<void> {
  const date = dateKeyToUtcMidnight(today);
  if (!date) throw new Error(`Fecha inválida: ${today}`);
  await prisma.platformSecret.update({ where: { key }, data: { lastReminderOn: date } });
}

/**
 * A quién se le avisa: los administradores de la plataforma (usuarios sin
 * clínica). No es el mail de ninguna clínica: el secreto es de la plataforma
 * y quien lo tiene que renovar es quien la opera.
 */
export async function listPlatformAdminEmails(): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: { clinicId: null, active: true },
    select: { email: true },
    orderBy: { email: "asc" },
  });
  return users.map((u) => u.email);
}
