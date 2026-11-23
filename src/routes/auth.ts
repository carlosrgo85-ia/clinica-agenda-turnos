import { Router } from "express";
import rateLimit from "express-rate-limit";
import { env } from "../config/env";
import {
  generateResetToken,
  hashResetToken,
  hashPassword,
  SESSION_COOKIE_NAME,
  signSession,
  verifyPassword,
} from "../services/auth";
import { resolvePermissions } from "../services/permissions";
import { findUserForLogin, setUserPassword } from "../repositories/users.repository";
import {
  createPasswordResetToken,
  findValidResetToken,
  markResetTokenUsed,
} from "../repositories/password-reset.repository";
import { sendPasswordResetEmail } from "../services/email";
import { authenticate } from "../middleware/authenticate";
import { enrichAudit } from "../services/audit";
import { prisma } from "../db/client";

export const authRouter = Router();

const isProduction = process.env.NODE_ENV === "production";

/**
 * Sin `maxAge`: es una cookie de sesión de browser, se borra al cerrarlo.
 * La expiración real la impone el JWT (`env.jwtExpiresIn`) — evita
 * mantener dos valores de expiración sincronizados a mano.
 */
function setSessionCookie(res: import("express").Response, token: string) {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
  });
}

// Protege contra fuerza bruta de contraseña y contra saturar el envío de
// emails de recuperación. Por IP, no por cuenta — más simple para el MVP.
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

authRouter.post("/login", authRateLimit, async (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "Faltan email o password" });
    return;
  }

  const user = await findUserForLogin(email);
  // El motivo REAL queda en la auditoría aunque al cliente se le diga siempre lo
  // mismo (para no revelar qué cuentas existen): sirve para ver intentos contra una
  // cuenta, una cuenta desactivada o una sin contraseña. Nunca se guarda la contraseña.
  if (!user || !user.active || !user.passwordHash) {
    enrichAudit(res, {
      actor: { userId: user?.id ?? null, email: email.trim().toLowerCase().slice(0, 200) },
      clinicId: user?.clinicId ?? null,
      details: { motivo: !user ? "cuenta_inexistente" : !user.active ? "cuenta_desactivada" : "sin_contrasena" },
    });
    res.status(401).json({ error: "Email o contraseña inválidos" });
    return;
  }

  const passwordOk = await verifyPassword(password, user.passwordHash);
  if (!passwordOk) {
    enrichAudit(res, {
      actor: { userId: user.id, email: user.email, name: user.name },
      clinicId: user.clinicId,
      details: { motivo: "contrasena_incorrecta" },
    });
    res.status(401).json({ error: "Email o contraseña inválidos" });
    return;
  }

  enrichAudit(res, {
    actor: { userId: user.id, email: user.email, name: user.name },
    clinicId: user.clinicId,
  });
  const token = signSession({ userId: user.id, clinicId: user.clinicId });
  setSessionCookie(res, token);

  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    clinicId: user.clinicId,
    permissions: Array.from(resolvePermissions(user)),
  });
});

authRouter.post("/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE_NAME);
  res.status(204).end();
});

authRouter.get("/me", authenticate, async (req, res) => {
  // authenticate ya cargó y validó req.user contra la base.
  const user = req.user!;
  res.json({
    id: user.id,
    clinicId: user.clinicId,
    email: user.email,
    name: user.name,
    permissions: Array.from(user.permissions),
  });
});

authRouter.post("/forgot-password", authRateLimit, async (req, res) => {
  const { email } = req.body ?? {};
  if (typeof email !== "string") {
    res.status(400).json({ error: "Falta email" });
    return;
  }

  // Respuesta idéntica exista o no la cuenta, para no revelar qué emails
  // están registrados.
  const user = await prisma.user.findUnique({ where: { email } });
  enrichAudit(res, {
    actor: { userId: user?.id ?? null, email: email.trim().toLowerCase().slice(0, 200), name: user?.name ?? null },
    clinicId: user?.clinicId ?? null,
    // La respuesta al cliente es la misma exista o no; el registro interno sí lo dice.
    details: { cuentaEncontrada: Boolean(user && user.active) },
  });
  if (user && user.active) {
    const { token, tokenHash } = generateResetToken();
    await createPasswordResetToken(user.id, tokenHash);
    const resetUrl = `${env.frontendUrl}/app/set-password?token=${token}`;
    await sendPasswordResetEmail({ toEmail: user.email, userName: user.name, resetUrl });
  }

  res.json({ ok: true });
});

authRouter.post("/reset-password", async (req, res) => {
  const { token, password } = req.body ?? {};
  if (typeof token !== "string" || typeof password !== "string" || password.length < 8) {
    res.status(400).json({ error: "Token inválido o contraseña muy corta (mínimo 8 caracteres)" });
    return;
  }

  const record = await findValidResetToken(hashResetToken(token));
  if (!record) {
    res.status(400).json({ error: "El link venció o ya se usó. Pedí uno nuevo." });
    return;
  }

  await setUserPassword(record.userId, await hashPassword(password));
  await markResetTokenUsed(record.id);
  const dueno = await prisma.user.findUnique({
    where: { id: record.userId },
    select: { id: true, email: true, name: true, clinicId: true },
  });
  enrichAudit(res, {
    actor: { userId: record.userId, email: dueno?.email ?? null, name: dueno?.name ?? null },
    clinicId: dueno?.clinicId ?? null,
  });

  res.json({ ok: true });
});
