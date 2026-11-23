import type { Prisma, Service } from "@prisma/client";
import { prisma } from "../db/client";
import { isFirstTimePatient } from "./availability";
import { campaignExtraProfessionalIds, loadCampaignForBooking } from "./campaigns";
import { clinicDateKey } from "./time";

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Busca en el catálogo formal el servicio que pidió el paciente.
 *
 * El match es laxo a propósito: `Clinic.services` es texto libre para el
 * prompt, así que lo que devuelve Claude en `servicio` es lo que dijo el
 * paciente ("una limpieza"), no una clave del catálogo. Si no matchea nada
 * el turno se crea igual, con la duración por default de la clínica — no
 * tener catálogo cargado es un caso válido (ver CLAUDE.md).
 */
export async function findServiceInCatalog(
  clinicId: string,
  serviceName: string | null,
  db: Db = prisma
): Promise<Service | null> {
  if (!serviceName) return null;

  return db.service.findFirst({
    where: {
      clinicId,
      active: true,
      name: { contains: serviceName.trim(), mode: "insensitive" },
    },
  });
}

/**
 * El catálogo de una clínica, en la frase que lee el prompt.
 *
 * Función pura, espejo de `describeWorkingHours()`: la idea es la misma, que el
 * texto que ve el modelo salga del dato estructurado y no de un campo libre que
 * puede contradecirlo. La duración va incluida para que el agente pueda
 * contestar "¿cuánto dura?" sin inventar.
 */
export function describeServices(
  services: Array<Pick<Service, "name" | "durationMinutes">>
): string {
  return services.map((s) => `${s.name} (${s.durationMinutes} min)`).join(", ");
}

/**
 * El nombre de un servicio tal como se guarda: sin espacios de más y con la primera letra en
 * mayúscula ("control de ortodoncia" → "Control de ortodoncia"). En español solo la primera
 * palabra lleva mayúscula en un nombre así; el resto NO se toca, para respetar siglas ("TAC"),
 * marcas ("Invisalign") y nombres propios. No es un corrector ortográfico a propósito: un
 * diccionario no distingue una errata de un término técnico, y el asistente copia este nombre
 * tal cual para buscar en el catálogo, así que no se "corrige" nada fuera de lo seguro.
 */
export function normalizeServiceName(name: string): string {
  const limpio = name.trim().replace(/\s+/g, " ");
  if (!limpio) return limpio;
  return limpio.charAt(0).toLocaleUpperCase("es") + limpio.slice(1);
}

/** El precio va dentro del prompt: una sola línea y corta, como `serviceNoun`. */
export const PRICE_NOTE_MAX_LENGTH = 200;

export function isValidPriceNote(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= PRICE_NOTE_MAX_LENGTH &&
    !/[\r\n\t]/.test(value)
  );
}

/**
 * Qué se le puede decir al paciente sobre el precio de cada servicio, SOLO de
 * los que la clínica cargó ("Diagnóstico inicial: $500 (sin costo si llega por
 * redes)"). Vacío si ninguno tiene: así el prompt no inventa ni afirma nada.
 * Va aparte de `describeServices()` para no tocar la línea que el modelo copia
 * al elegir el nombre exacto del catálogo.
 */
export function describeServicePrices(
  services: Array<Pick<Service, "name"> & { priceNote?: string | null }>
): string {
  return services
    .filter((s) => s.priceNote && s.priceNote.trim() !== "")
    .map((s) => `${s.name}: ${s.priceNote!.trim()}`)
    .join("; ");
}

export interface ResolvedServiceRequest {
  service: Service | null;
  durationMinutes: number;
  requiredResourceType: string | null;
  /**
   * Los profesionales activos que realizan el servicio. `null` = sin
   * restricción: no se nombró ningún servicio, o la clínica no tiene catálogo
   * (compatibilidad con las que nunca lo cargaron). Una lista VACÍA es
   * distinta y significa que nadie lo hace.
   */
  allowedProfessionalIds: string[] | null;
  /** Los profesionales que sumó la campaña (ya están dentro de `allowedProfessionalIds`). */
  campaignProfessionalIds: string[];
  /**
   * El paciente nombró un servicio, la clínica tiene catálogo y ninguno
   * coincide: no es algo que ofrezcan, así que no se agenda ni se ofrecen
   * horarios — se deriva a una persona.
   */
  notOffered: boolean;
  /** Se reemplazó lo pedido por el servicio de primera vez de la clínica. */
  firstVisitForced: boolean;
}

/**
 * Duración, equipo y profesionales habilitados de lo que pidió el paciente.
 *
 * Vive acá y no en `booking.ts` porque lo necesitan los dos caminos: el que
 * CREA el turno y el que ENUMERA los huecos para ofrecer. Si cada uno
 * resolviera esto por su lado y se desincronizaran, el bot ofrecería
 * horarios que después el turno rechaza — por ejemplo ofrecer las 12:30 para
 * un servicio que en el catálogo dura 45 minutos y se pasa del corte de la
 * comida, o con un profesional que no hace ese servicio.
 *
 * `context` es opcional: con él se aplica la regla de primera vez. Si la
 * persona es nueva (y no es una urgencia) y la clínica marcó un servicio de
 * primera vez, ese reemplaza a lo pedido: el paciente nuevo parte siempre por
 * el diagnóstico, que solo hace(n) el/los profesional(es) asignado(s).
 */
export async function resolveServiceForRequest(
  clinic: { id: string; defaultAppointmentMinutes: number; timezone?: string },
  serviceName: string | null,
  db: Db = prisma,
  context?: {
    patientId: string;
    isUrgent?: boolean;
    /**
     * La campaña por la que llegó la persona. Si es vigente y el servicio es el de su promoción, SUMA
     * a los profesionales del servicio los que la campaña habilita (aunque el catálogo no se los asigne).
     */
    campaignId?: string | null;
  }
): Promise<ResolvedServiceRequest> {
  let service: Service | null = null;
  let firstVisitForced = false;

  if (context && !context.isUrgent && (await isFirstTimePatient(clinic.id, context.patientId, db))) {
    service = await db.service.findFirst({
      where: { clinicId: clinic.id, active: true, firstVisit: true },
      orderBy: { name: "asc" },
    });
    firstVisitForced = service !== null;
  }

  service ??= await findServiceInCatalog(clinic.id, serviceName, db);

  let allowedProfessionalIds: string[] | null = null;
  let campaignProfessionalIds: string[] = [];
  if (service) {
    const rows = await db.professional.findMany({
      where: { clinicId: clinic.id, active: true, services: { some: { id: service.id } } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    allowedProfessionalIds = rows.map((r) => r.id);

    // La promoción de una campaña vigente puede sumarle profesionales a ESTE servicio. Se SUMAN: nunca
    // reemplazan ni sacan a los del catálogo. Con el servicio de primera vez forzado no aplica (el
    // servicio ya no es el de la promoción).
    if (context?.campaignId) {
      const campana = await loadCampaignForBooking(clinic.id, context.campaignId, db);
      if (campana) {
        const todayKey = clinicDateKey(new Date(), clinic.timezone ?? "UTC");
        const extras = campaignExtraProfessionalIds(
          { ...campana, extraProfessionals: campana.extraProfessionals },
          service.id,
          todayKey
        );
        allowedProfessionalIds = [...new Set([...allowedProfessionalIds, ...extras])];
        campaignProfessionalIds = extras;
      }
    }
  }

  let notOffered = false;
  if (!service && serviceName?.trim()) {
    notOffered = (await db.service.count({ where: { clinicId: clinic.id, active: true } })) > 0;
  }

  return {
    service,
    durationMinutes: service?.durationMinutes ?? clinic.defaultAppointmentMinutes,
    requiredResourceType: service?.requiredResourceType ?? null,
    allowedProfessionalIds,
    campaignProfessionalIds,
    notOffered,
    firstVisitForced,
  };
}
