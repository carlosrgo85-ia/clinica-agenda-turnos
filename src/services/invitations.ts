import { env } from "../config/env";
import { generateResetToken } from "./auth";
import { createPasswordResetToken } from "../repositories/password-reset.repository";
import { sendAccountInvitationEmail } from "./email";
import { describeError, recordSystemEvent, SYSTEM_EVENT_KINDS } from "./system-events";

/**
 * Le manda a un usuario recién creado el link para elegir su propia
 * contraseña. Reusado tanto por el alta de usuarios de una clínica
 * (routes/users.ts) como por el alta del primer admin de una clínica nueva
 * (routes/platform.ts) — un solo lugar que arma el token y el email.
 */
export async function sendUserInvitation(user: { id: string; email: string; name: string }) {
  const { token, tokenHash } = generateResetToken();
  await createPasswordResetToken(user.id, tokenHash);
  const setPasswordUrl = `${env.frontendUrl}/app/set-password?token=${token}`;
  await sendAccountInvitationEmail({ toEmail: user.email, userName: user.name, setPasswordUrl });
}

/**
 * Igual que `sendUserInvitation()`, pero un correo que no sale (SMTP mal configurado o
 * caído) NO tumba el pedido: el usuario ya está creado y quien administra puede reenviar
 * la invitación. En Express 4 una excepción de un handler `async` es una promesa rechazada
 * sin manejar, y Node ≥15 mata el proceso con eso: así se cayó el servidor web en el primer
 * despliegue (2026-11-24). Devuelve si el correo salió; la falla queda en Monitoreo.
 */
export async function trySendUserInvitation(
  user: { id: string; email: string; name: string },
  clinicId: string | null
): Promise<boolean> {
  try {
    await sendUserInvitation(user);
    return true;
  } catch (error) {
    console.error("No se pudo enviar la invitación:", describeError(error));
    await recordSystemEvent({
      kind: SYSTEM_EVENT_KINDS.CORREO_ENVIO,
      clinicId,
      message: `Invitación de cuenta no enviada: ${describeError(error)}`,
    });
    return false;
  }
}
