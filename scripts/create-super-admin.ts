/**
 * Crea el primer usuario super-admin de la plataforma. Correr con:
 *
 *   SUPER_ADMIN_EMAIL=vos@ejemplo.com SUPER_ADMIN_NAME="Tu nombre" npx tsx scripts/create-super-admin.ts
 *
 * No se le asigna contraseña acá: se le manda una invitación por email
 * (Mailhog en desarrollo, ver http://localhost:8025) para que la elija
 * él mismo — mismo mecanismo que el resto de las invitaciones. Requiere
 * haber corrido el seed antes (`npm run db:seed`), que es quien crea el
 * rol "Super Admin".
 */
import { prisma } from "../src/db/client";
import { sendUserInvitation } from "../src/services/invitations";

async function main() {
  const email = process.env.SUPER_ADMIN_EMAIL;
  const name = process.env.SUPER_ADMIN_NAME;
  if (!email || !name) {
    throw new Error("Faltan SUPER_ADMIN_EMAIL y/o SUPER_ADMIN_NAME.");
  }

  const superAdminRole = await prisma.role.findFirst({ where: { clinicId: null, name: "Super Admin" } });
  if (!superAdminRole) {
    throw new Error('No existe el rol "Super Admin" — corre `npm run db:seed` primero.');
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new Error(`Ya existe un usuario con ese email (id ${existing.id}).`);
  }

  const user = await prisma.user.create({
    data: {
      email,
      name,
      clinicId: null,
      roles: { create: [{ roleId: superAdminRole.id }] },
    },
  });

  await sendUserInvitation(user);

  console.log(`Super-admin creado: ${user.id}. Se le mandó una invitación a ${email}.`);
}

main()
  .catch((error) => {
    console.error(error.message ?? error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
