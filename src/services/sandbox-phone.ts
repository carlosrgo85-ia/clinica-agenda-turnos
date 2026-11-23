import type { Prisma } from "@prisma/client";

/**
 * Cómo se reconoce una conversación del chat de pruebas (`services/sandbox.ts`): el teléfono es uno reservado,
 * `prueba:<usuario>`. Va aparte en un módulo sin dependencias para que los jobs y los reportes puedan IGNORAR a esos
 * pacientes sin importar todo el turno del asistente.
 */
export const SANDBOX_PHONE_PREFIX = "prueba:";

export const sandboxPhoneFor = (userId: string): string => `${SANDBOX_PHONE_PREFIX}${userId}`;
export const isSandboxPhone = (phone: string | null | undefined): boolean => !!phone && phone.startsWith(SANDBOX_PHONE_PREFIX);

/** Para los `where` de Prisma: deja afuera a los pacientes de prueba (`NOT: SANDBOX_PATIENT_FILTER`). */
export const SANDBOX_PATIENT_FILTER: Prisma.PatientWhereInput = { phone: { startsWith: SANDBOX_PHONE_PREFIX } };
