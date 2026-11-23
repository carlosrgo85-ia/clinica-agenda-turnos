import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../config/env";

const BCRYPT_ROUNDS = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export interface SessionPayload {
  userId: string;
  clinicId: string | null;
}

export function signSession(payload: SessionPayload): string {
  // `expiresIn` viene de una env var (string libre, ej. "8h"), y los tipos
  // de jsonwebtoken exigen un literal más estricto — el valor lo valida la
  // librería en runtime igual.
  const options: jwt.SignOptions = { expiresIn: env.jwtExpiresIn as jwt.SignOptions["expiresIn"] };
  return jwt.sign(payload, env.jwtSecret, options);
}

/** Devuelve el payload si el JWT es válido y no venció; si no, null. */
export function verifySession(token: string): SessionPayload | null {
  try {
    const decoded = jwt.verify(token, env.jwtSecret);
    if (typeof decoded === "string") return null;
    if (typeof decoded.userId !== "string") return null;
    return { userId: decoded.userId, clinicId: (decoded.clinicId as string | null) ?? null };
  } catch {
    return null;
  }
}

export const SESSION_COOKIE_NAME = "session";

/**
 * Token de invitación ("elegí tu contraseña") o de recuperación
 * ("olvidé mi contraseña"): se genera al azar y se guarda SOLO el hash en
 * `PasswordResetToken.tokenHash` (mismo criterio que un password) — el
 * valor en texto plano únicamente viaja en el link del email, nunca a la
 * base.
 */
export function generateResetToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, tokenHash: hashResetToken(token) };
}

export function hashResetToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
