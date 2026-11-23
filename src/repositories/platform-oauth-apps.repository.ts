import { prisma } from "../db/client";
import { encryptToken } from "../services/crypto";

/**
 * La app de OAuth de la plataforma (hoy solo Google) tal como la ve la API.
 *
 * **Nunca lleva el secreto, ni siquiera cifrado**: `clientSecretEncrypted` se
 * lee solo desde `getGoogleOAuthAppEncrypted()`, que usa
 * `services/google-oauth-config.ts`. El filtro está acá y no en cada ruta a
 * propósito — mismo criterio que `PlatformSecretRecord`.
 */
export interface PlatformOAuthAppRecord {
  clientId: string;
  redirectUri: string;
}

const GOOGLE = "google";

export async function findGoogleOAuthApp(): Promise<PlatformOAuthAppRecord | null> {
  const row = await prisma.platformOAuthApp.findUnique({
    where: { provider: GOOGLE },
    select: { clientId: true, redirectUri: true },
  });
  return row;
}

/**
 * Guarda la app entera. Sin `clientSecret` se conserva el que ya había (para
 * poder corregir el id o la URI sin volver a pegar el secreto); la primera vez
 * es obligatorio.
 */
export async function saveGoogleOAuthApp(input: {
  clientId: string;
  redirectUri: string;
  clientSecret?: string;
}): Promise<PlatformOAuthAppRecord> {
  const existing = await prisma.platformOAuthApp.findUnique({
    where: { provider: GOOGLE },
    select: { provider: true },
  });
  if (!existing && input.clientSecret === undefined) {
    throw new Error("Falta el secreto del cliente: es obligatorio la primera vez.");
  }

  const secret = input.clientSecret !== undefined ? encryptToken(input.clientSecret) : undefined;
  const row = await prisma.platformOAuthApp.upsert({
    where: { provider: GOOGLE },
    create: {
      provider: GOOGLE,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      clientSecretEncrypted: secret!,
    },
    update: {
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      ...(secret ? { clientSecretEncrypted: secret } : {}),
    },
    select: { clientId: true, redirectUri: true },
  });
  return row;
}

/** Borra la app guardada: desde ahí se usan las variables del `.env`. */
export async function deleteGoogleOAuthApp(): Promise<void> {
  await prisma.platformOAuthApp.deleteMany({ where: { provider: GOOGLE } });
}

/** Para `services/google-oauth-config.ts`, el único que descifra. */
export async function getGoogleOAuthAppEncrypted(): Promise<
  (PlatformOAuthAppRecord & { clientSecretEncrypted: string }) | null
> {
  return prisma.platformOAuthApp.findUnique({ where: { provider: GOOGLE } }).then((row) =>
    row
      ? { clientId: row.clientId, redirectUri: row.redirectUri, clientSecretEncrypted: row.clientSecretEncrypted }
      : null
  );
}
