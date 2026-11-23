import { prisma } from "../../src/db/client";

/**
 * Borra de `AuditLog` lo que dejaron los tests de unas clínicas.
 *
 * El registro de auditoría está protegido por un trigger que rechaza UPDATE y DELETE: el
 * único camino es una sesión que declare mantenimiento (`app.audit_maintenance`), y es lo
 * que hace esto, dentro de una transacción (`set_config(..., true)` vale solo ahí). Se usa
 * únicamente en la limpieza de los tests: ver "Auditoría" en CLAUDE.md.
 *
 * Los tests que ejercitan código que audita (el turno del asistente, marcar una asistencia,
 * los jobs) tienen que llamarlo en su `afterEach`, o dejan filas en la base de desarrollo.
 */
export async function purgeAuditForClinics(clinicIds: string[]): Promise<void> {
  if (clinicIds.length === 0) return;
  await prisma.$transaction([
    prisma.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`,
    prisma.auditLog.deleteMany({ where: { clinicId: { in: clinicIds } } }),
  ]);
}
