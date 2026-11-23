import { env } from "../config/env";
import { generateResetToken } from "./auth";
import { createPasswordResetToken } from "../repositories/password-reset.repository";
import { sendAccountInvitationEmail } from "./email";

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
