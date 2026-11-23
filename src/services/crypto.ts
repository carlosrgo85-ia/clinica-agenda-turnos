import crypto from "node:crypto";
import { env } from "../config/env";

/**
 * Cifrado de las credenciales de larga duración que guardamos en la base:
 * el refresh token de Google (`GoogleAccount.refreshTokenEncrypted`) y el
 * token de WhatsApp de cada clínica (`Clinic.whatsappTokenEncrypted`).
 *
 * Ninguno de los dos puede quedar en texto plano en una columna: un dump de
 * la base, un backup mal guardado o un SELECT de más alcanzarían para operar
 * los calendarios de todas las clínicas, o para escribirle por WhatsApp a
 * todos sus pacientes en su nombre. La clave vive en
 * `CALENDAR_TOKEN_ENCRYPTION_KEY`, fuera de la base.
 *
 * AES-256-GCM porque además de cifrar autentica: si alguien edita la
 * columna a mano, el descifrado falla en vez de devolver basura.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // el tamaño recomendado para GCM
const KEY_LENGTH = 32; // AES-256

/**
 * La clave se espera en hex (64 caracteres = 32 bytes). Generar una con:
 *   openssl rand -hex 32
 */
function getKey(): Buffer {
  const raw = env.calendarTokenEncryptionKey;
  if (!raw) {
    throw new Error(
      "Falta CALENDAR_TOKEN_ENCRYPTION_KEY. Es obligatoria para descifrar el token de WhatsApp de cada clínica y para conectar calendarios por OAuth — genera una con `openssl rand -hex 32`."
    );
  }

  const key = Buffer.from(raw, "hex");
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `CALENDAR_TOKEN_ENCRYPTION_KEY tiene que ser de ${KEY_LENGTH} bytes en hex (${
        KEY_LENGTH * 2
      } caracteres). Generá una con \`openssl rand -hex 32\`.`
    );
  }
  return key;
}

/**
 * Devuelve `iv:authTag:ciphertext`, todo en base64. El IV es aleatorio por
 * cada cifrado, así que el mismo token guardado dos veces no produce el
 * mismo texto cifrado.
 */
export function encryptToken(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(
    ":"
  );
}

export function decryptToken(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 3) {
    throw new Error("Token cifrado con formato inválido.");
  }

  const [ivB64, authTagB64, cipherB64] = parts;
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getKey(),
    Buffer.from(ivB64, "base64")
  );
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(cipherB64, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/**
 * Firma el `state` del flujo de OAuth.
 *
 * Sin esto, cualquiera podría mandarle a la víctima un link al callback con
 * un `clinicId` ajeno y terminar conectando su propia cuenta de Google a la
 * clínica de otro. El state va firmado con HMAC y con vencimiento.
 */
export function signState(payload: Record<string, string>, ttlSeconds = 600): string {
  const body = JSON.stringify({ ...payload, exp: Date.now() + ttlSeconds * 1000 });
  const bodyB64 = Buffer.from(body, "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", getKey()).update(bodyB64).digest("base64url");
  return `${bodyB64}.${signature}`;
}

/** Devuelve el payload del state si la firma es válida y no venció; si no, null. */
export function verifyState(state: string): Record<string, string> | null {
  const parts = state.split(".");
  if (parts.length !== 2) return null;

  const [bodyB64, signature] = parts;
  const expected = crypto.createHmac("sha256", getKey()).update(bodyB64).digest("base64url");

  // timingSafeEqual explota si los buffers tienen largo distinto, así que
  // se chequea antes.
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(bodyB64, "base64url").toString("utf8"));
    if (typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
