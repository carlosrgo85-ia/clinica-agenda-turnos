import type { Clinic, Prisma } from "@prisma/client";
import type { prisma as prismaClient } from "../db/client";
import { findAvailableProfessional, isFirstTimePatient } from "./availability";

export { isFirstTimePatient };

type Db = Prisma.TransactionClient | typeof prismaClient;

interface ResolveProfessionalParams {
  clinic: Clinic;
  requestedProfessionalId: string | null;
  /**
   * Rango del turno. Hace falta para el criterio por default: sin saber
   * cuándo es, no se puede elegir un profesional que esté libre. Si no se
   * pasa, el default no se aplica y la función devuelve null como antes.
   */
  start?: Date;
  end?: Date;
  /**
   * Si el criterio por default tiene que descartar a los profesionales que
   * no trabajan a esa hora. Se apaga cuando la clínica todavía no cargó
   * horario estructurado (ver services/working-hours.ts).
   */
  enforceWorkingHours?: boolean;
  /**
   * Quiénes realizan el servicio pedido (`null` = sin restricción). Acota
   * TODOS los criterios: un pedido de alguien que no lo hace se ignora, y el
   * default solo elige entre los habilitados.
   */
  allowedProfessionalIds?: string[] | null;
  db?: Db;
}

interface ResolveProfessionalResult {
  professionalId: string | null;
  /** Cómo se decidió, para el log y para explicarlo en el dashboard. */
  criterio: "pedido_por_paciente" | "primero_libre" | "sin_resolver";
  /**
   * El paciente pidió a alguien que NO realiza el servicio, así que se lo
   * ignoró. Quien llama puede avisárselo al paciente.
   */
  requestedIgnored: boolean;
}

/**
 * Decide qué profesional corresponde para un turno nuevo.
 *
 * La política de "primera vez" ya NO se decide acá: sale del servicio marcado
 * `Service.firstVisit`, que `catalog.ts` impone al resolver el servicio y que
 * llega como `allowedProfessionalIds` (solo lo hacen los profesionales
 * asignados). Esta función solo elige entre los habilitados.
 *
 * El orden de prioridad es:
 *
 * 1. El profesional que pidió el paciente, si pidió alguno y realiza el servicio.
 * 2. El primero que esté libre en ese horario (criterio por default).
 */
export async function resolveProfessionalForBooking(
  params: ResolveProfessionalParams
): Promise<ResolveProfessionalResult> {
  const { clinic, start, end, db } = params;
  const allowed = params.allowedProfessionalIds ?? null;

  // Un pedido de alguien que no realiza el servicio no se respeta: se sigue
  // como si no hubiera pedido a nadie, y se deja constancia.
  let requestedProfessionalId = params.requestedProfessionalId;
  let requestedIgnored = false;
  if (requestedProfessionalId && allowed && !allowed.includes(requestedProfessionalId)) {
    requestedProfessionalId = null;
    requestedIgnored = true;
  }

  if (requestedProfessionalId) {
    return {
      professionalId: requestedProfessionalId,
      criterio: "pedido_por_paciente",
      requestedIgnored,
    };
  }

  // Criterio por default: el primero libre que además trabaje a esa hora.
  // Necesita saber el rango del turno; sin eso no hay nada que resolver.
  if (start && end) {
    const professionalId = await findAvailableProfessional(
      {
        clinicId: clinic.id,
        clinicTimezone: clinic.timezone,
        start,
        end,
        enforceWorkingHours: params.enforceWorkingHours ?? false,
        onlyProfessionalIds: allowed,
      },
      db
    );
    if (professionalId) {
      return {
        professionalId,
        criterio: "primero_libre",
        requestedIgnored,
      };
    }
  }

  return {
    professionalId: null,
    criterio: "sin_resolver",
    requestedIgnored,
  };
}
