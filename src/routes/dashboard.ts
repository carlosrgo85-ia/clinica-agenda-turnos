import { Router } from "express";
import { auditFiltersFromQuery, enrichAudit, listAudit } from "../services/audit";
import { cleanCancelReason } from "../services/appointment-events";
import type { AppointmentStatus, Weekday } from "@prisma/client";
import { prisma } from "../db/client";
import { listAvailableCalendars, listAvailableCalendarsForMicrosoft } from "../services/calendar";
import { chooseCalendarCredential } from "../services/calendar-link";
import { syncClinicBlocksNow } from "../jobs/calendar-sync";
import {
  buildMicrosoftConnectLink,
  isMicrosoftOAuthConfigured,
  isMicrosoftRevokedError,
  markMicrosoftAccountRevoked,
} from "../services/microsoft-auth";
import {
  addDaysToDateKey,
  clinicDateKey,
  clinicWallTimeToUtc,
  minutesToWallTime,
  weekdayFromDateKey,
} from "../services/time";
import { getConfigHealth } from "../services/config-health";
import {
  applyHolidays,
  holidaySuggestionsForClinic,
  relevantHolidayYears,
} from "../services/holidays";
import { suggestCountryFromTimezone } from "../data/holidays";
import { isSupportedCountry, supportedCountries } from "../repositories/countries.repository";
import {
  deleteScheduleException,
  describeWorkingHours,
  getEffectiveIntervalsForRange,
  intersectIntervals,
  intervalsKey,
  listScheduleExceptions,
  replaceWorkingHours,
  upsertScheduleException,
  WorkingHoursValidationError,
  type WorkingHoursInput,
} from "../services/working-hours";
import {
  buildConnectLink,
  isInvalidGrantError,
  isOAuthConfigured,
  markAccountRevoked,
} from "../services/google-auth";
import {
  createService,
  deleteService,
  listResourceTypes,
  listServices,
  updateService,
} from "../repositories/services.repository";
import { describeServices, isValidPriceNote, normalizeServiceName, PRICE_NOTE_MAX_LENGTH } from "../services/catalog";
import {
  clinicHasCatalog,
  countProfessionalServices,
  setFirstVisitService,
  setProfessionalServices,
  setServiceProfessionals,
  validProfessionalIds,
  validServiceIds,
} from "../repositories/professional-services.repository";
import {
  countFutureAppointments,
  createProfessional,
  createResource,
  createRoom,
  listProfessionals,
  listResources,
  listRooms,
  updateProfessional,
  updateResource,
  type ProfessionalInput,
  updateRoom,
} from "../repositories/resources.repository";
import { listTitlesForClinic } from "../repositories/professional-titles.repository";
import {
  listInsurersForClinic,
  setClinicInsurer,
} from "../repositories/insurers.repository";
import {
  countPendingEscalations,
  listEscalations,
  reopenEscalation,
  resolveEscalation,
} from "../repositories/escalations.repository";
import {
  HARD_FAILURE_MESSAGE,
  cancelAppointment,
  createManualAppointment,
  createManualBlocks,
  deleteManualBlock,
  updateAppointment,
  updateManualBlock,
  type AdminFailure,
  type AppointmentChanges,
} from "../services/appointment-admin";
import { CLINIC_CALENDAR_INCLUDE } from "../services/calendar";
import { gridLimits } from "../services/agenda-grid";
import {
  addPatientComment,
  createPatient,
  dateKeyOf,
  deletePatientComment,
  getPatientDetail,
  listPatients,
  updatePatient,
  validateNewPatientName,
  type PatientFailure,
} from "../services/patient-admin";
import { buildReport, forScreen, parseReportFilters, REPORT_KINDS, reportToCsv, type ReportKind } from "../services/reports";
import {
  assignPackage,
  createPackageTemplate,
  listPackageTemplates,
  updatePackageTemplate,
  listPackages,
  listPendingPackageAppointments,
  markAppointmentAttended,
  unmarkAppointmentAttended,
  updatePackage,
} from "../services/packages";
import {
  campaignStats,
  campaignStatus,
  closeLead,
  createCampaign,
  detectCampaign,
  listCampaigns,
  listLeads,
  updateCampaign,
  type CampaignInput,
  type TriggerInput,
} from "../services/campaigns";
import { normalizarNombre } from "../repositories/patients.repository";
import { getSandboxConversation, resetSandbox, runSandboxTurn, SandboxError } from "../services/sandbox";
import { PERMISSIONS } from "../config/permissions";
import { PLAN_FEATURES, planIncludes } from "../config/plan-features";
import { authenticate } from "../middleware/authenticate";
import { requirePermission } from "../middleware/authorize";

export const dashboardRouter = Router();

/**
 * API cruda para las features Base pendientes de interfaz visual —
 * auditoría de conversaciones, métricas, buscador de turnos y
 * configuración de calendarios. Cada ruta exige el permiso puntual que le
 * corresponde (ver src/config/permissions.ts); `authenticate` además exige
 * que, si la ruta trae `:clinicId`, el usuario pertenezca a esa clínica o
 * sea super-admin (ver middleware/authorize.ts).
 *
 * Falta todavía: paginación en /conversations, y una capa de frontend
 * (React) que consuma estos endpoints en vez de servir JSON crudo.
 */
dashboardRouter.use(authenticate);

/** Auditoría: historial de conversación de un paciente puntual. */
dashboardRouter.get(
  "/clinics/:clinicId/conversations/:patientPhone",
  requirePermission(PERMISSIONS.CONVERSACIONES_VER),
  async (req, res) => {
  const { clinicId, patientPhone } = req.params;
  const messages = await prisma.conversationMessage.findMany({
    where: { clinicId, patientPhone },
    orderBy: { createdAt: "asc" },
  });
  res.json(messages);
});

/**
 * Auditoría: las conversaciones recientes de una clínica.
 *
 * Es **una fila por teléfono**, no por paciente. Un número puede tener
 * varias fichas (una familia que comparte el WhatsApp) y la conversación es
 * una sola: el historial se guarda por número. Listando pacientes, el mismo
 * chat aparecía tres veces.
 *
 * Se devuelve el titular como identidad de la conversación y el resto de las
 * personas aparte, para poder mostrar "Carlos García Ortiz (+2)".
 */
dashboardRouter.get(
  "/clinics/:clinicId/conversations",
  requirePermission(PERMISSIONS.CONVERSACIONES_VER),
  async (req, res) => {
    const { clinicId } = req.params;
    const patients = await prisma.patient.findMany({
      where: { clinicId },
      orderBy: { updatedAt: "desc" },
      take: 300,
    });

    const porTelefono = new Map<string, typeof patients>();
    for (const p of patients) {
      const fichas = porTelefono.get(p.phone);
      if (fichas) fichas.push(p);
      else porTelefono.set(p.phone, [p]);
    }

    const conversaciones = [...porTelefono.values()]
      .map((fichas) => {
        // El titular es la ficha más vieja, igual que en
        // `getOrCreateConversationPatient()`.
        const ordenadas = [...fichas].sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
        );
        const titular = ordenadas[0];
        return {
          ...titular,
          personas: ordenadas.map((p) => ({ id: p.id, name: p.name, stage: p.stage })),
        };
      })
      .slice(0, 100);

    res.json(conversaciones);
  }
);

/** Mismos valores que el enum `AppointmentStatus` de prisma/schema.prisma. */
const ESTADOS_DE_TURNO: AppointmentStatus[] = ["confirmado", "cancelado", "atendido"];

/**
 * Buscador de turnos. Es la contraparte del evento espejo: en Google
 * Calendar el evento lleva el id del turno en el título/descripción, y con
 * ese id (o con el teléfono o el nombre del paciente) se llega acá al
 * detalle completo, que en el calendario no cabe — status, seña, espacio,
 * equipo, paquete, etapa de CRM.
 *
 * Query params, todos opcionales pero hace falta al menos uno: `q` (id de
 * turno, teléfono, o nombre del paciente — el nombre va por coincidencia
 * parcial, así que buscar un apellido funciona), `desde` / `hasta`
 * (YYYY-MM-DD), `estado`, `servicio`, `professionalId`, `roomId`.
 */
dashboardRouter.get(
  "/clinics/:clinicId/appointments/search",
  requirePermission(PERMISSIONS.TURNOS_VER),
  async (req, res) => {
  const { clinicId } = req.params;
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const estado = typeof req.query.estado === "string" ? req.query.estado.trim() : "";
  const servicio = typeof req.query.servicio === "string" ? req.query.servicio.trim() : "";
  const professionalId =
    typeof req.query.professionalId === "string" ? req.query.professionalId.trim() : "";
  const roomId = typeof req.query.roomId === "string" ? req.query.roomId.trim() : "";

  if (estado && !ESTADOS_DE_TURNO.includes(estado as AppointmentStatus)) {
    return res
      .status(400)
      .json({ error: `\`estado\` tiene que ser uno de: ${ESTADOS_DE_TURNO.join(", ")}.` });
  }

  const desdeKey = typeof req.query.desde === "string" ? req.query.desde : "";
  const hastaKey = typeof req.query.hasta === "string" ? req.query.hasta : "";

  if (!q && !desdeKey && !hastaKey && !estado && !servicio && !professionalId && !roomId) {
    return res.status(400).json({ error: "Hace falta al menos un filtro." });
  }

  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { timezone: true },
  });
  if (!clinic) return res.status(404).json({ error: "Clínica no encontrada" });

  /**
   * `desde` y `hasta` son días de pared de la clínica, no instantes UTC.
   *
   * Con `new Date("2026-09-15")` el corte quedaba en la medianoche UTC del
   * 15, que en México son las 18:00 del 14: buscar "hasta el 15" no
   * devolvía NINGUNA cita del 15. Y `hasta` tiene que ser el FINAL de ese
   * día —la medianoche del siguiente, comparada con `lt`— porque quien
   * elige "hasta el 15" espera que el 15 entre.
   */
  const desde = desdeKey ? clinicWallTimeToUtc(desdeKey, "00:00", clinic.timezone) : null;
  const finDeHasta = hastaKey ? addDaysToDateKey(hastaKey, 1) : null;
  const hasta = finDeHasta ? clinicWallTimeToUtc(finDeHasta, "00:00", clinic.timezone) : null;

  if ((desdeKey && !desde) || (hastaKey && !hasta)) {
    return res.status(400).json({ error: "`desde` y `hasta` tienen que ser fechas YYYY-MM-DD." });
  }

  // El id de turno es un cuid, así que una búsqueda por id es exacta; el
  // resto de los campos son de texto libre y van por coincidencia parcial.
  const filtroTexto = q
    ? {
        OR: [
          { id: q },
          { googleEventId: q },
          { service: { contains: q, mode: "insensitive" as const } },
          { patient: { phone: { contains: q } } },
          { patient: { name: { contains: q, mode: "insensitive" as const } } },
        ],
      }
    : {};

  const rango =
    desde || hasta
      ? {
          startTime: {
            ...(desde ? { gte: desde } : {}),
            // `lt` y no `lte`: `hasta` ya es la medianoche del día siguiente.
            ...(hasta ? { lt: hasta } : {}),
          },
        }
      : {};

  /**
   * El servicio se filtra por el NOMBRE (`Appointment.service`) y no por
   * `serviceId`: ese campo es null en los turnos que no matchearon el
   * catálogo —o que se crearon antes de que la clínica lo cargara— y esos
   * turnos existen igual. `service` siempre tiene el nombre, y cuando hubo
   * match es exactamente el del catálogo, así que una sola condición
   * alcanza para los dos casos.
   */
  const filtros = {
    ...(estado ? { status: estado as AppointmentStatus } : {}),
    ...(servicio ? { service: { equals: servicio, mode: "insensitive" as const } } : {}),
    ...(professionalId ? { professionalId } : {}),
    ...(roomId ? { roomId } : {}),
  };

  const appointments = await prisma.appointment.findMany({
    // El filtro por clinicId va siempre, para que una clínica no pueda ver
    // turnos de otra. Los ids de profesional y espacio vienen del cliente,
    // así que quedan acotados por él: pedir el de otra clínica no devuelve
    // nada en vez de filtrar turnos ajenos.
    where: { clinicId, ...filtroTexto, ...rango, ...filtros },
    orderBy: { startTime: "desc" },
    take: 50,
    include: {
      patient: { select: { name: true, phone: true, stage: true } },
      professional: { select: { name: true } },
      room: { select: { name: true } },
      resource: { select: { name: true, type: true } },
      serviceCatalog: { select: { name: true, durationMinutes: true } },
      package: { select: { serviceName: true, totalSessions: true, usedSessions: true } },
    },
  });

  res.json(appointments);
});

/**
 * Las citas de un rango, para la pantalla "Calendario".
 *
 * Es un endpoint aparte del buscador y no un parámetro más: el buscador
 * devuelve las 50 más recientes en orden descendente —sirve para encontrar
 * UNA cita—, y una agenda necesita TODAS las del rango en orden
 * cronológico, porque una que falte es un hueco que no existe.
 *
 * **Pensado para cuando una clínica tenga sucursales.** El filtro es
 * `professionalIds` (plural) y no un profesional suelto: el día en que haya
 * sucursales, elegir una se traduce a "los profesionales de esa sucursal" y
 * no hay que tocar ni el endpoint ni la vista. Por eso también se devuelve
 * el espacio de cada cita, que es el otro eje por el que se va a querer
 * agrupar.
 */
dashboardRouter.get(
  "/clinics/:clinicId/calendar",
  requirePermission(PERMISSIONS.TURNOS_VER),
  async (req, res) => {
    const { clinicId } = req.params;
    const desde = typeof req.query.desde === "string" ? req.query.desde : "";
    const hasta = typeof req.query.hasta === "string" ? req.query.hasta : "";

    const clinic = await prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { timezone: true },
    });
    if (!clinic) return res.status(404).json({ error: "Clínica no encontrada" });

    /*
     * Las fechas son días de pared de la clínica, no instantes UTC. Sin
     * convertir con su zona, "el 15" arrancaría a las 18:00 del 14 para una
     * clínica en México y la agenda del día mostraría la tarde anterior.
     */
    const inicio = clinicWallTimeToUtc(desde, "00:00", clinic.timezone);
    const finDateKey = addDaysToDateKey(hasta, 1);
    const fin = finDateKey ? clinicWallTimeToUtc(finDateKey, "00:00", clinic.timezone) : null;
    if (!inicio || !fin) {
      return res.status(400).json({ error: "`desde` y `hasta` tienen que ser fechas YYYY-MM-DD." });
    }

    const professionalIds = (
      Array.isArray(req.query.professionalIds)
        ? req.query.professionalIds
        : typeof req.query.professionalIds === "string"
          ? req.query.professionalIds.split(",")
          : []
    )
      .map((id) => String(id).trim())
      .filter(Boolean);

    const [citas, profesionales, workingHours, bloqueosCrudos] = await Promise.all([
      prisma.appointment.findMany({
        where: {
          clinicId,
          startTime: { gte: inicio, lt: fin },
          // Las canceladas no ocupan lugar en la agenda.
          status: { not: "cancelado" },
          ...(professionalIds.length > 0 ? { professionalId: { in: professionalIds } } : {}),
        },
        orderBy: { startTime: "asc" },
        select: {
          id: true,
          service: true,
          startTime: true,
          endTime: true,
          status: true,
          professionalId: true,
          serviceId: true,
          preferredRoomUnavailable: true,
          source: true,
          forcedRules: true,
          // Para el selector de paquete y el "atendida" del diálogo de la Agenda.
          packageId: true,
          attendedAt: true,
          package: { select: { serviceName: true, totalSessions: true, usedSessions: true } },
          patient: { select: { id: true, name: true, phone: true } },
          room: { select: { id: true, name: true } },
        },
      }),
      prisma.professional.findMany({
        where: { clinicId },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      prisma.workingHours.findMany({
        where: { clinicId, professionalId: null },
        select: { startMinute: true, endMinute: true },
      }),
      // Los bloqueos del rango: los importados del calendario externo y los
      // que se cargaron a mano. Lectura de Postgres, no de Google. De los
      // importados NO hay título (no se guarda); de los manuales sí.
      prisma.calendarBlock.findMany({
        where: {
          clinicId,
          startTime: { lt: fin },
          endTime: { gt: inicio },
          ...(professionalIds.length > 0 ? { professionalId: { in: professionalIds } } : {}),
        },
        orderBy: { startTime: "asc" },
        select: {
          id: true,
          professionalId: true,
          startTime: true,
          endTime: true,
          isAllDay: true,
          source: true,
          title: true,
        },
      }),
    ]);

    /*
     * Los límites de la grilla salen del horario de la clínica: una agenda
     * que arranca a las 00:00 son doce pantallas de nada antes de la primera
     * cita. Sin horario cargado se cae a una jornada razonable.
     */
    // Se estiran para abarcar las citas y los bloqueos con hora que haya en el rango: una cita guardada "fuera del horario"
    // (regla blanda confirmada) no puede quedar fuera de la grilla. Ver `gridLimits()`.
    const { desdeMinuto, hastaMinuto } = gridLimits({
      workingHours,
      timezone: clinic.timezone,
      events: [...citas, ...bloqueosCrudos.filter((b) => !b.isAllDay)],
    });

    /**
     * Cuándo atiende cada profesional cada día del rango.
     *
     * Sale de `getEffectiveIntervalsForRange()`, la MISMA función que valida
     * los turnos: horario semanal ∩ excepciones por fecha, con la herencia
     * del horario de la clínica ya resuelta. Así lo que la agenda pinta como
     * cerrado es exactamente lo que `booking.ts` rechaza — si se calculara
     * aparte, tarde o temprano mostraría abierto un rato en el que no se
     * puede agendar.
     *
     * Un día sin ningún tramo es un día cerrado: feriado, o la clínica no
     * atiende ese día de la semana. `motivo` trae el texto de la excepción
     * ("Navidad") cuando la hay.
     */
    // Tope de 31 días: la agenda pide un día o una semana. El límite es para
    // que un rango absurdo por query string no arme un bucle largo.
    const dias: Array<{ dateKey: string; weekday: Weekday }> = [];
    let cursor: string | null = desde;
    for (let i = 0; cursor && cursor <= hasta && i < 31; i += 1) {
      const weekday = weekdayFromDateKey(cursor);
      if (weekday) dias.push({ dateKey: cursor, weekday });
      cursor = addDaysToDateKey(cursor, 1);
    }

    const intervalos = await getEffectiveIntervalsForRange({
      clinicId,
      professionalIds: profesionales.map((p) => p.id),
      days: dias,
    });

    const disponibilidad = profesionales.flatMap((profesional) =>
      dias.map((dia) => {
        const efectivo = intervalos.get(intervalsKey(dia.dateKey, profesional.id));
        const tramos = efectivo
          ? intersectIntervals(efectivo.clinic.intervals, efectivo.professional.intervals)
          : [];
        return {
          professionalId: profesional.id,
          dateKey: dia.dateKey,
          tramos,
          cerrado: tramos.length === 0,
          motivo:
            efectivo?.clinic.exceptionReason ?? efectivo?.professional.exceptionReason ?? null,
        };
      })
    );

    res.json({
      timezone: clinic.timezone,
      grilla: { desdeMinuto, hastaMinuto },
      profesionales,
      citas,
      bloqueos: bloqueosCrudos,
      disponibilidad,
    });
  }
);

/**
 * --- Editar la Agenda: crear, mover, editar y cancelar citas, y bloqueos ---
 *
 * Todo pasa por `services/appointment-admin.ts`, que valida con las MISMAS
 * reglas que el asistente de WhatsApp y deja saltarse las blandas solo con
 * `force: true` después de mostrar cuáles se rompen. Las rutas solo validan el
 * body y traducen el resultado a HTTP:
 *
 *  - 409 + `requiereConfirmacion: true` + `violaciones`: hay reglas blandas
 *    rotas; la interfaz las muestra y reenvía con `force: true`.
 *  - 409 con `error`: una regla dura (espacio o equipo ocupado, la persona ya
 *    tiene otra cita a esa hora). No se puede forzar.
 */

/** Lo que necesita la Agenda para armar los diálogos de alta y edición. */
dashboardRouter.get(
  "/clinics/:clinicId/agenda-options",
  requirePermission(PERMISSIONS.TURNOS_VER),
  async (req, res) => {
    const { clinicId } = req.params;
    const [servicios, profesionales, espacios] = await Promise.all([
      prisma.service.findMany({
        where: { clinicId, active: true },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          durationMinutes: true,
          firstVisit: true,
          professionals: { where: { active: true }, select: { id: true } },
        },
      }),
      prisma.professional.findMany({
        where: { clinicId, active: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true, title: { select: { name: true } } },
      }),
      prisma.room.findMany({
        where: { clinicId, active: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true },
      }),
    ]);
    res.json({
      servicios: servicios.map((sv) => ({
        id: sv.id,
        name: sv.name,
        durationMinutes: sv.durationMinutes,
        firstVisit: sv.firstVisit,
        // Quiénes lo realizan, para filtrar el selector de profesional.
        professionalIds: sv.professionals.map((p) => p.id),
      })),
      profesionales: profesionales.map((p) => ({
        id: p.id,
        name: p.name,
        title: p.title?.name ?? null,
      })),
      espacios,
    });
  }
);

/** Buscar pacientes por nombre o teléfono, para elegir de quién es la cita. */
dashboardRouter.get(
  "/clinics/:clinicId/patients/search",
  requirePermission(PERMISSIONS.TURNOS_VER),
  async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length < 2) return res.json({ pacientes: [] });

    const digitos = q.replace(/\D/g, "");
    const pacientes = await prisma.patient.findMany({
      where: {
        clinicId: req.params.clinicId,
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          ...(digitos.length >= 4 ? [{ phone: { contains: digitos } }] : []),
        ],
      },
      orderBy: { name: "asc" },
      take: 10,
      select: { id: true, name: true, phone: true },
    });
    res.json({ pacientes });
  }
);

/** Un resultado de `appointment-admin` como respuesta HTTP. */
function responderFallo(res: import("express").Response, f: AdminFailure) {
  if (f.reason === "requiere_confirmacion") {
    return res.status(409).json({
      error: "Hay reglas que no se cumplen. Confirma para guardar igual.",
      requiereConfirmacion: true,
      violaciones: f.violations,
    });
  }
  const status = f.reason === "no_encontrado" ? 404 : f.reason === "datos_invalidos" ? 400 : 409;
  return res.status(status).json({ error: f.message, motivo: f.reason });
}

/** La clínica con las cuentas de calendario, que hacen falta para espejar. */
function clinicaParaAgenda(clinicId: string) {
  return prisma.clinic.findUnique({ where: { id: clinicId }, include: CLINIC_CALENDAR_INCLUDE });
}

function textoONull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

dashboardRouter.post(
  "/clinics/:clinicId/appointments",
  requirePermission(PERMISSIONS.CITAS_GESTIONAR),
  async (req, res) => {
    const { clinicId } = req.params;
    const b = (req.body ?? {}) as Record<string, unknown>;

    const clinic = await clinicaParaAgenda(clinicId);
    if (!clinic) return res.status(404).json({ error: "Clínica no encontrada" });

    // El paciente: uno existente, o uno nuevo con nombre y teléfono. El
    // teléfono es lo que usan los recordatorios de WhatsApp, así que se exige.
    const paciente = (b.patient ?? {}) as Record<string, unknown>;
    let patientId = textoONull(paciente.id);
    if (!patientId) {
      const phone = typeof paciente.phone === "string" ? paciente.phone.replace(/\D/g, "") : "";
      if (phone.length < 8) {
        return res.status(400).json({
          error: "Elige un paciente existente, o indica nombre, apellido y teléfono (con código de país) del nuevo.",
        });
      }
      // Nombre Y apellido, los dos: con una palabra sola la ficha quedaba incompleta (ver `validateNewPatientName`).
      const nombre = validateNewPatientName({
        name: paciente.name,
        firstName: paciente.firstName,
        lastName: paciente.lastName,
      });
      if (!nombre.ok) return res.status(400).json({ error: nombre.error });
      // Si esa persona ya está cargada en ese número, se reusa: sin esto cada
      // alta a mano duplicaría la ficha.
      const mismasFichas = await prisma.patient.findMany({ where: { clinicId, phone } });
      const existente = mismasFichas.find(
        (p) => p.name && normalizarNombre(p.name) === normalizarNombre(nombre.name)
      );
      patientId = (
        existente ??
        (await prisma.patient.create({
          data: { clinicId, phone, name: nombre.name, firstName: nombre.firstName, lastName: nombre.lastName },
        }))
      ).id;
      // Quedó dicho en la auditoría de la ruta que esta cita trajo una ficha nueva (sin nombre ni teléfono).
      enrichAudit(res, { details: { pacienteNuevo: !existente } });
    }

    const serviceId = textoONull(b.serviceId);
    const professionalId = textoONull(b.professionalId);
    const date = textoONull(b.date);
    const time = textoONull(b.time);
    if (!serviceId || !professionalId || !date || !time) {
      return res.status(400).json({ error: "Faltan el servicio, el profesional, el día o la hora." });
    }

    const result = await createManualAppointment({
      clinic,
      userId: req.user!.id,
      patientId,
      serviceId,
      professionalId,
      date,
      time,
      durationMinutes: typeof b.durationMinutes === "number" ? b.durationMinutes : null,
      roomId: textoONull(b.roomId),
      packageId: textoONull(b.packageId),
      force: b.force === true,
    });
    if (!result.ok) return responderFallo(res, result);

    res.status(201).json({ cita: result.appointment, reglasForzadas: result.forcedRules });
  }
);

dashboardRouter.patch(
  "/clinics/:clinicId/appointments/:appointmentId",
  requirePermission(PERMISSIONS.CITAS_GESTIONAR),
  async (req, res) => {
    const { clinicId, appointmentId } = req.params;
    const b = (req.body ?? {}) as Record<string, unknown>;

    const clinic = await clinicaParaAgenda(clinicId);
    if (!clinic) return res.status(404).json({ error: "Clínica no encontrada" });

    const changes: AppointmentChanges = {};
    if (b.date !== undefined) changes.date = String(b.date);
    if (b.time !== undefined) changes.time = String(b.time);
    if (b.professionalId !== undefined) changes.professionalId = String(b.professionalId);
    if (b.serviceId !== undefined) changes.serviceId = String(b.serviceId);
    if (b.roomId !== undefined) changes.roomId = b.roomId === null ? null : String(b.roomId);
    // null = desatar del paquete; un id = atar a ese; ausente = conservar.
    if (b.packageId !== undefined) changes.packageId = b.packageId === null ? null : String(b.packageId);
    if (b.durationMinutes !== undefined) {
      if (typeof b.durationMinutes !== "number") {
        return res.status(400).json({ error: "La duración tiene que ser un número de minutos." });
      }
      changes.durationMinutes = b.durationMinutes;
    }

    const result = await updateAppointment({
      clinic,
      userId: req.user!.id,
      appointmentId,
      changes,
      force: b.force === true,
      notifyPatient: b.notifyPatient === true,
    });
    if (!result.ok) return responderFallo(res, result);

    res.json({
      cita: result.appointment,
      reglasForzadas: result.forcedRules,
      avisoAlPaciente: result.patientNotice,
    });
  }
);

dashboardRouter.post(
  "/clinics/:clinicId/appointments/:appointmentId/cancel",
  requirePermission(PERMISSIONS.CITAS_GESTIONAR),
  async (req, res) => {
    const { clinicId, appointmentId } = req.params;
    const clinic = await clinicaParaAgenda(clinicId);
    if (!clinic) return res.status(404).json({ error: "Clínica no encontrada" });

    const result = await cancelAppointment({
      clinic,
      userId: req.user!.id,
      appointmentId,
      notifyPatient: (req.body as { notifyPatient?: unknown } | undefined)?.notifyPatient === true,
      reason: (req.body as { reason?: unknown } | undefined)?.reason,
    });
    if (!result.ok) return res.status(404).json({ error: HARD_FAILURE_MESSAGE.no_encontrado });
    // El motivo es un dato estructurado y no sensible: queda también en la auditoría.
    const motivo = cleanCancelReason((req.body as { reason?: unknown } | undefined)?.reason);
    if (motivo) enrichAudit(res, { details: { motivo } });

    res.json({ ok: true, avisoAlPaciente: result.patientNotice });
  }
);

dashboardRouter.post(
  "/clinics/:clinicId/blocks",
  requirePermission(PERMISSIONS.CITAS_GESTIONAR),
  async (req, res) => {
    const { clinicId } = req.params;
    const b = (req.body ?? {}) as Record<string, unknown>;

    const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { timezone: true } });
    if (!clinic) return res.status(404).json({ error: "Clínica no encontrada" });

    const professionalIds = Array.isArray(b.professionalIds)
      ? b.professionalIds.filter((id): id is string => typeof id === "string")
      : [];

    const result = await createManualBlocks({
      clinicId,
      timezone: clinic.timezone,
      userId: req.user!.id,
      professionalIds,
      title: typeof b.title === "string" ? b.title : "",
      date: typeof b.date === "string" ? b.date : "",
      startTime: typeof b.startTime === "string" ? b.startTime : undefined,
      endTime: typeof b.endTime === "string" ? b.endTime : undefined,
      allDay: b.allDay === true,
    });
    if (!result.ok) {
      return res.status(result.reason === "no_encontrado" ? 404 : 400).json({ error: result.message });
    }
    res.status(201).json({ bloqueos: result.blocks });
  }
);

dashboardRouter.patch(
  "/clinics/:clinicId/blocks/:blockId",
  requirePermission(PERMISSIONS.CITAS_GESTIONAR),
  async (req, res) => {
    const { clinicId, blockId } = req.params;
    const b = (req.body ?? {}) as Record<string, unknown>;

    const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { timezone: true } });
    if (!clinic) return res.status(404).json({ error: "Clínica no encontrada" });

    const result = await updateManualBlock({
      clinicId,
      timezone: clinic.timezone,
      blockId,
      changes: {
        date: typeof b.date === "string" ? b.date : undefined,
        startTime: typeof b.startTime === "string" ? b.startTime : undefined,
        endTime: typeof b.endTime === "string" ? b.endTime : undefined,
        professionalId: typeof b.professionalId === "string" ? b.professionalId : undefined,
        title: typeof b.title === "string" ? b.title : undefined,
      },
    });
    if (!result.ok) {
      return res.status(result.reason === "no_encontrado" ? 404 : 400).json({ error: result.message });
    }
    res.json({ bloqueo: result.blocks[0] });
  }
);

dashboardRouter.delete(
  "/clinics/:clinicId/blocks/:blockId",
  requirePermission(PERMISSIONS.CITAS_GESTIONAR),
  async (req, res) => {
    const { ok } = await deleteManualBlock(req.params.clinicId, req.params.blockId);
    if (!ok) {
      return res.status(404).json({
        error: "Bloqueo no encontrado, o es uno importado del calendario (esos no se borran desde acá).",
      });
    }
    res.status(204).end();
  }
);

/**
 * Las opciones de los filtros de la pantalla "Turnos".
 *
 * Los servicios salen de los turnos que la clínica realmente tiene, no del
 * catálogo: hay turnos con `serviceId` en null —de antes del catálogo, o
 * que no matchearon ninguno— y un desplegable armado desde el catálogo no
 * los ofrecería nunca. Así cada opción de la lista devuelve al menos un
 * resultado.
 */
dashboardRouter.get(
  "/clinics/:clinicId/appointments/filters",
  requirePermission(PERMISSIONS.TURNOS_VER),
  async (req, res) => {
    const { clinicId } = req.params;

    const [servicios, profesionales, espacios] = await Promise.all([
      prisma.appointment.findMany({
        where: { clinicId },
        distinct: ["service"],
        select: { service: true },
        orderBy: { service: "asc" },
      }),
      prisma.professional.findMany({
        where: { clinicId },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      prisma.room.findMany({
        where: { clinicId },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
    ]);

    res.json({
      estados: ESTADOS_DE_TURNO,
      servicios: servicios.map((s) => s.service),
      profesionales,
      espacios,
    });
  }
);

/**
 * Estado de configuración de calendarios de una clínica: qué cuentas de
 * Google tiene conectadas, qué calendario usa cada profesional, y con qué
 * credencial. Es lo que necesita la pantalla de configuración para
 * pintarse.
 *
 * Los tokens NO se devuelven nunca, en ningún campo.
 */
dashboardRouter.get(
  "/clinics/:clinicId/calendars",
  requirePermission(PERMISSIONS.CALENDARIOS_VER),
  async (req, res) => {
  const { clinicId } = req.params;
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    include: {
      sharedCalendarAccount: { select: { id: true, email: true, revokedAt: true } },
      sharedCalendarMicrosoftAccount: { select: { id: true, email: true, revokedAt: true } },
      googleAccounts: {
        select: { id: true, email: true, scope: true, revokedAt: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      },
      microsoftAccounts: {
        select: { id: true, email: true, scope: true, revokedAt: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      },
      professionals: {
        where: { active: true },
        select: {
          id: true,
          name: true,
          googleCalendarId: true,
          calendarProvider: true,
          blockSyncEnabled: true,
          googleAccount: { select: { id: true, email: true, revokedAt: true } },
          microsoftAccount: { select: { id: true, email: true, revokedAt: true } },
        },
      },
    },
  });
  if (!clinic) return res.status(404).json({ error: "Clínica no encontrada" });

  // "servicio" = el modo viejo de Google, sin OAuth: depende de que la
  // clínica le haya compartido el calendario a la cuenta de servicio.
  // "sin_cuenta" = un calendario de Microsoft sin cuenta conectada: a
  // diferencia de Google no hay cuenta de servicio de respaldo, así que no
  // hay espejo hasta que se conecte una.
  const credencialDe = (
    provider: "google" | "microsoft",
    google: unknown,
    microsoft: unknown
  ): "oauth" | "servicio" | "sin_cuenta" =>
    provider === "microsoft" ? (microsoft ? "oauth" : "sin_cuenta") : google ? "oauth" : "servicio";

  const microsoftDisponible = await isMicrosoftOAuthConfigured();
  const googleDisponible = await isOAuthConfigured();

  res.json({
    // Links para arrancar el flujo de OAuth y conectar una cuenta nueva.
    conectarCuentaUrl: googleDisponible ? buildConnectLink(clinicId) : null,
    oauthDisponible: googleDisponible,
    conectarMicrosoftUrl: microsoftDisponible ? buildMicrosoftConnectLink(clinicId) : null,
    microsoftDisponible,
    cuentasConectadas: clinic.googleAccounts,
    cuentasMicrosoft: clinic.microsoftAccounts,
    sharedCalendarId: clinic.sharedCalendarId,
    sharedCalendarProvider: clinic.sharedCalendarProvider,
    sharedCalendarAccount: clinic.sharedCalendarAccount,
    sharedCalendarMicrosoftAccount: clinic.sharedCalendarMicrosoftAccount,
    // Si hay calendario compartido, es el que manda para todo el equipo.
    modo: clinic.sharedCalendarId ? "compartido" : "por_profesional",
    profesionales: clinic.professionals.map((p) => ({
      ...p,
      calendarioEfectivo: clinic.sharedCalendarId ?? p.googleCalendarId,
      proveedorEfectivo: clinic.sharedCalendarId ? clinic.sharedCalendarProvider : p.calendarProvider,
      credencial: clinic.sharedCalendarId
        ? credencialDe(
            clinic.sharedCalendarProvider,
            clinic.sharedCalendarAccount,
            clinic.sharedCalendarMicrosoftAccount
          )
        : credencialDe(p.calendarProvider, p.googleAccount, p.microsoftAccount),
    })),
  });
});

/**
 * Los calendarios de una cuenta conectada, para poblar el selector de la
 * interfaz. Solo los que la cuenta puede escribir (ver
 * services/calendar.ts → listAvailableCalendars).
 */
dashboardRouter.get(
  "/clinics/:clinicId/google-accounts/:accountId/calendars",
  requirePermission(PERMISSIONS.CALENDARIOS_VER),
  async (req, res) => {
  const { clinicId, accountId } = req.params;

  // El clinicId va en el where para que no se pueda leer una cuenta de otra
  // clínica pasando su id.
  const account = await prisma.googleAccount.findFirst({
    where: { id: accountId, clinicId },
  });
  if (!account) return res.status(404).json({ error: "Cuenta no encontrada en esta clínica" });
  if (account.revokedAt) {
    return res.status(409).json({
      error: "La cuenta tiene el acceso revocado. Hay que volver a conectarla.",
      conectarCuentaUrl: buildConnectLink(clinicId),
    });
  }

  try {
    const calendars = await listAvailableCalendars(account);
    res.json({ email: account.email, calendarios: calendars });
  } catch (error) {
    if (isInvalidGrantError(error)) {
      await markAccountRevoked(account.id);
      return res.status(409).json({
        error: "Google rechazó el acceso de esta cuenta. Hay que volver a conectarla.",
        conectarCuentaUrl: buildConnectLink(clinicId),
      });
    }
    console.error(`Error listando calendarios de la cuenta ${accountId}:`, error);
    res.status(502).json({ error: "No se pudieron leer los calendarios de Google." });
  }
});

/**
 * Los calendarios de una cuenta de Microsoft conectada, para el selector.
 * Mismo criterio que la de Google: solo los que se pueden escribir.
 */
dashboardRouter.get(
  "/clinics/:clinicId/microsoft-accounts/:accountId/calendars",
  requirePermission(PERMISSIONS.CALENDARIOS_VER),
  async (req, res) => {
  const { clinicId, accountId } = req.params;

  // El clinicId va en el where para que no se pueda leer una cuenta de otra
  // clínica pasando su id.
  const account = await prisma.microsoftAccount.findFirst({ where: { id: accountId, clinicId } });
  if (!account) return res.status(404).json({ error: "Cuenta no encontrada en esta clínica" });
  if (account.revokedAt) {
    return res.status(409).json({
      error: "La cuenta tiene el acceso revocado. Hay que volver a conectarla.",
      conectarCuentaUrl: buildMicrosoftConnectLink(clinicId),
    });
  }

  try {
    const calendars = await listAvailableCalendarsForMicrosoft(account);
    res.json({ email: account.email, calendarios: calendars });
  } catch (error) {
    if (isMicrosoftRevokedError(error)) {
      await markMicrosoftAccountRevoked(account.id);
      return res.status(409).json({
        error: "Microsoft rechazó el acceso de esta cuenta. Hay que volver a conectarla.",
        conectarCuentaUrl: buildMicrosoftConnectLink(clinicId),
      });
    }
    console.error(`Error listando calendarios de la cuenta de Microsoft ${accountId}:`, error);
    res.status(502).json({ error: "No se pudieron leer los calendarios de Microsoft." });
  }
});

/**
 * Que la cuenta nombrada en un pedido sea de la clínica. Va en el where para
 * que no se pueda enlazar una credencial de otra clínica pasando su id.
 * Devuelve el mensaje de error, o null si está todo bien.
 */
async function checkAccountsBelongToClinic(
  clinicId: string,
  accounts: { googleAccountId?: string | null; microsoftAccountId?: string | null }
): Promise<string | null> {
  if (accounts.googleAccountId) {
    const owned = await prisma.googleAccount.findFirst({
      where: { id: accounts.googleAccountId, clinicId },
      select: { id: true },
    });
    if (!owned) return "Esa cuenta de Google no pertenece a esta clínica.";
  }
  if (accounts.microsoftAccountId) {
    const owned = await prisma.microsoftAccount.findFirst({
      where: { id: accounts.microsoftAccountId, clinicId },
      select: { id: true },
    });
    if (!owned) return "Esa cuenta de Microsoft no pertenece a esta clínica.";
  }
  return null;
}

/**
 * Enlaza (o desenlaza, mandando null) el calendario compartido de la
 * clínica. La credencial la dicen `provider` y la cuenta
 * (`googleAccountId` / `microsoftAccountId`); ver `chooseCalendarCredential`.
 * Con Google, una cuenta en null usa la cuenta de servicio (modo viejo); con
 * Microsoft la cuenta es obligatoria.
 */
dashboardRouter.put(
  "/clinics/:clinicId/calendars/shared",
  requirePermission(PERMISSIONS.CALENDARIOS_EDITAR),
  async (req, res) => {
  const { clinicId } = req.params;
  const { sharedCalendarId } = req.body ?? {};

  if (sharedCalendarId !== null && typeof sharedCalendarId !== "string") {
    return res.status(400).json({ error: "sharedCalendarId tiene que ser un string o null." });
  }

  const choice = chooseCalendarCredential(req.body ?? {}, { calendarBeingSet: Boolean(sharedCalendarId) });
  if (!choice.ok) return res.status(400).json({ error: choice.error });

  const notOwned = await checkAccountsBelongToClinic(clinicId, choice);
  if (notOwned) return res.status(400).json({ error: notOwned });

  const clinic = await prisma.clinic.update({
    where: { id: clinicId },
    data: {
      sharedCalendarId: sharedCalendarId || null,
      ...(sharedCalendarId
        ? {
            ...(choice.provider ? { sharedCalendarProvider: choice.provider } : {}),
            ...(choice.googleAccountId !== undefined ? { sharedCalendarAccountId: choice.googleAccountId || null } : {}),
            ...(choice.microsoftAccountId !== undefined
              ? { sharedCalendarMicrosoftAccountId: choice.microsoftAccountId || null }
              : {}),
          }
        : // Desenlazar el calendario también suelta las cuentas asociadas, para
          // no dejar una credencial apuntando a nada.
          {
            sharedCalendarProvider: "google",
            sharedCalendarAccountId: null,
            sharedCalendarMicrosoftAccountId: null,
          }),
    },
    include: {
      sharedCalendarAccount: { select: { id: true, email: true } },
      sharedCalendarMicrosoftAccount: { select: { id: true, email: true } },
    },
  });

  // Recién enlazado: se importan los bloqueos ahora y no dentro de 15 minutos.
  if (clinic.sharedCalendarId) syncClinicBlocksNow(clinicId, "calendario compartido enlazado");

  res.json({
    sharedCalendarId: clinic.sharedCalendarId,
    sharedCalendarProvider: clinic.sharedCalendarProvider,
    sharedCalendarAccount: clinic.sharedCalendarAccount,
    sharedCalendarMicrosoftAccount: clinic.sharedCalendarMicrosoftAccount,
  });
});

/**
 * Enlaza (o desenlaza) el calendario personal de un profesional. El campo se
 * llama `googleCalendarId` por historia: guarda el id en cualquier proveedor.
 */
dashboardRouter.put(
  "/clinics/:clinicId/professionals/:professionalId/calendar",
  requirePermission(PERMISSIONS.CALENDARIOS_EDITAR),
  async (req, res) => {
    const { clinicId, professionalId } = req.params;
    const { googleCalendarId, blockSyncEnabled } = req.body ?? {};

    if (googleCalendarId !== undefined && googleCalendarId !== null && typeof googleCalendarId !== "string") {
      return res.status(400).json({ error: "googleCalendarId tiene que ser un string o null." });
    }
    if (blockSyncEnabled !== undefined && typeof blockSyncEnabled !== "boolean") {
      return res.status(400).json({ error: "blockSyncEnabled tiene que ser booleano." });
    }

    const choice = chooseCalendarCredential(req.body ?? {}, {
      // Solo exige la cuenta de Microsoft si se está fijando un calendario.
      calendarBeingSet: typeof googleCalendarId === "string" && googleCalendarId !== "",
    });
    if (!choice.ok) return res.status(400).json({ error: choice.error });

    const notOwned = await checkAccountsBelongToClinic(clinicId, choice);
    if (notOwned) return res.status(400).json({ error: notOwned });

    // updateMany y no update: así el clinicId entra en el where y no se
    // puede tocar un profesional de otra clínica pasando su id.
    const { count } = await prisma.professional.updateMany({
      where: { id: professionalId, clinicId },
      data: {
        ...(googleCalendarId !== undefined ? { googleCalendarId: googleCalendarId || null } : {}),
        ...(choice.provider ? { calendarProvider: choice.provider } : {}),
        ...(choice.googleAccountId !== undefined ? { googleAccountId: choice.googleAccountId || null } : {}),
        ...(choice.microsoftAccountId !== undefined ? { microsoftAccountId: choice.microsoftAccountId || null } : {}),
        ...(blockSyncEnabled !== undefined ? { blockSyncEnabled } : {}),
        // Sin calendario no tiene sentido conservar ninguna credencial.
        ...(googleCalendarId === null
          ? { googleAccountId: null, microsoftAccountId: null, calendarProvider: "google" as const }
          : {}),
      },
    });
    if (count === 0) {
      return res.status(404).json({ error: "Profesional no encontrado en esta clínica" });
    }

    const professional = await prisma.professional.findUnique({
      where: { id: professionalId },
      select: {
        id: true,
        name: true,
        googleCalendarId: true,
        calendarProvider: true,
        blockSyncEnabled: true,
        googleAccount: { select: { id: true, email: true } },
        microsoftAccount: { select: { id: true, email: true } },
      },
    });
    // Enlazar un calendario (o prender la importación) trae los bloqueos ya.
    if (professional?.googleCalendarId && professional.blockSyncEnabled) {
      syncClinicBlocksNow(clinicId, "calendario de profesional enlazado");
    }

    res.json(professional);
  }
);

/**
 * Desconecta una cuenta de Google. Se borra el token guardado, así que la
 * plataforma pierde el acceso a esos calendarios.
 *
 * Los calendarios que la usaban quedan sin credencial, y por lo tanto se
 * caen a la cuenta de servicio — que probablemente tampoco tenga acceso.
 * Es a propósito: dejar el turno en Postgres sin espejo es mejor que
 * bloquear la desconexión.
 */
dashboardRouter.delete(
  "/clinics/:clinicId/google-accounts/:accountId",
  requirePermission(PERMISSIONS.CALENDARIOS_EDITAR),
  async (req, res) => {
  const { clinicId, accountId } = req.params;

  const account = await prisma.googleAccount.findFirst({
    where: { id: accountId, clinicId },
    select: { id: true },
  });
  if (!account) return res.status(404).json({ error: "Cuenta no encontrada en esta clínica" });

  await prisma.$transaction([
    prisma.professional.updateMany({
      where: { clinicId, googleAccountId: accountId },
      data: { googleAccountId: null },
    }),
    prisma.clinic.updateMany({
      where: { id: clinicId, sharedCalendarAccountId: accountId },
      data: { sharedCalendarAccountId: null },
    }),
    prisma.googleAccount.delete({ where: { id: accountId } }),
  ]);

  res.json({ desconectada: true });
});

/**
 * Desconecta una cuenta de Microsoft. Se borra el token guardado.
 *
 * Los calendarios que la usaban quedan de Microsoft y sin cuenta, y como no
 * hay cuenta de servicio de respaldo dejan de espejarse (el turno en Postgres
 * sigue siendo válido). La pantalla los muestra como "sin cuenta" hasta que
 * se conecte otra. Es a propósito: no bloquear la desconexión.
 */
dashboardRouter.delete(
  "/clinics/:clinicId/microsoft-accounts/:accountId",
  requirePermission(PERMISSIONS.CALENDARIOS_EDITAR),
  async (req, res) => {
  const { clinicId, accountId } = req.params;

  const account = await prisma.microsoftAccount.findFirst({
    where: { id: accountId, clinicId },
    select: { id: true },
  });
  if (!account) return res.status(404).json({ error: "Cuenta no encontrada en esta clínica" });

  await prisma.$transaction([
    prisma.professional.updateMany({
      where: { clinicId, microsoftAccountId: accountId },
      data: { microsoftAccountId: null },
    }),
    prisma.clinic.updateMany({
      where: { id: clinicId, sharedCalendarMicrosoftAccountId: accountId },
      data: { sharedCalendarMicrosoftAccountId: null },
    }),
    prisma.microsoftAccount.delete({ where: { id: accountId } }),
  ]);

  res.json({ desconectada: true });
});

/**
 * Horario de atención de la clínica y de cada profesional.
 *
 * `heredado: true` en un profesional significa que no tiene tramos propios
 * y usa el de la clínica. Los minutos van desde la medianoche local
 * (540 = 09:00); se devuelve también el texto legible para no obligar a la
 * interfaz a formatearlo.
 */
dashboardRouter.get(
  "/clinics/:clinicId/working-hours",
  requirePermission(PERMISSIONS.HORARIOS_VER),
  async (req, res) => {
  const { clinicId } = req.params;

  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    include: {
      professionals: { where: { active: true }, select: { id: true, name: true } },
      workingHours: { orderBy: [{ weekday: "asc" }, { startMinute: "asc" }] },
    },
  });
  if (!clinic) return res.status(404).json({ error: "Clínica no encontrada" });

  const deLaClinica = clinic.workingHours.filter((r) => r.professionalId === null);

  res.json({
    // Sin horario de clínica cargado, la clínica no puede agendar (booking.ts
    // rechaza con `clinica_sin_horario`). jobs/config-alerts.ts manda un aviso
    // diario por email mientras siga así.
    faltaCargarHorario: deLaClinica.length === 0,
    clinica: {
      tramos: deLaClinica.map(toTramoJson),
      // Es también, textualmente, lo que el bot le cuenta al paciente: el
      // prompt arma esa línea con esta misma función. Ya no hay un texto
      // libre aparte con el que comparar.
      descripcion: describeWorkingHours(deLaClinica),
    },
    profesionales: clinic.professionals.map((professional) => {
      const propios = clinic.workingHours.filter(
        (r) => r.professionalId === professional.id
      );
      const efectivos = propios.length > 0 ? propios : deLaClinica;
      return {
        id: professional.id,
        name: professional.name,
        heredado: propios.length === 0,
        tramos: efectivos.map(toTramoJson),
        descripcion: describeWorkingHours(efectivos),
      };
    }),
  });
});

function toTramoJson(row: {
  weekday: string;
  startMinute: number;
  endMinute: number;
}) {
  return {
    weekday: row.weekday,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    desde: minutesToWallTime(row.startMinute),
    hasta: minutesToWallTime(row.endMinute),
  };
}

/**
 * Reemplaza el horario de la clínica.
 *
 * El body es `{ tramos: [{ weekday, startMinute, endMinute }, ...] }`. Se
 * manda el set completo, no de a un tramo: el horario de un día son sus
 * tramos juntos, y los solapamientos solo se detectan viéndolos todos.
 *
 * El corte de comida se expresa como el hueco entre dos tramos del mismo
 * día — lunes 09:00-13:00 y 14:00-18:00 son dos tramos.
 */
dashboardRouter.put(
  "/clinics/:clinicId/working-hours",
  requirePermission(PERMISSIONS.HORARIOS_EDITAR),
  async (req, res) => {
  const { clinicId } = req.params;

  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { id: true } });
  if (!clinic) return res.status(404).json({ error: "Clínica no encontrada" });

  const parsed = parseTramos(req.body);
  if ("error" in parsed) return res.status(400).json({ error: parsed.error });

  try {
    const rows = await replaceWorkingHours({
      clinicId,
      professionalId: null,
      intervals: parsed.tramos,
    });
    res.json({ tramos: rows.map(toTramoJson), descripcion: describeWorkingHours(rows) });
  } catch (error) {
    if (error instanceof WorkingHoursValidationError) {
      return res.status(400).json({ error: "Horario inválido", detalles: error.errores });
    }
    throw error;
  }
});

/**
 * Reemplaza el horario de un profesional. Mandar `tramos: []` lo devuelve a
 * heredar el horario de la clínica.
 *
 * Ojo: el horario propio no habilita nada fuera del horario de la clínica.
 * Los dos tienen que permitir el turno (ver services/working-hours.ts), así
 * que cargarle a alguien un tramo con la clínica cerrada no le va a dar
 * turnos ahí.
 */
dashboardRouter.put(
  "/clinics/:clinicId/professionals/:professionalId/working-hours",
  requirePermission(PERMISSIONS.HORARIOS_EDITAR),
  async (req, res) => {
    const { clinicId, professionalId } = req.params;

    // El clinicId va en el where para no poder tocar un profesional ajeno.
    const professional = await prisma.professional.findFirst({
      where: { id: professionalId, clinicId },
      select: { id: true },
    });
    if (!professional) {
      return res.status(404).json({ error: "Profesional no encontrado en esta clínica" });
    }

    const parsed = parseTramos(req.body);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });

    try {
      const rows = await replaceWorkingHours({
        clinicId,
        professionalId,
        intervals: parsed.tramos,
      });
      res.json({
        heredado: rows.length === 0,
        tramos: rows.map(toTramoJson),
        descripcion: describeWorkingHours(rows),
      });
    } catch (error) {
      if (error instanceof WorkingHoursValidationError) {
        return res.status(400).json({ error: "Horario inválido", detalles: error.errores });
      }
      throw error;
    }
  }
);

/**
 * Qué le falta configurar a la clínica.
 *
 * Es lo que consume el banner del dashboard: `issues` viene ordenado con
 * los bloqueantes primero. Un `bloqueante` significa que el asistente está
 * tomando turnos que no debería.
 *
 * La misma fuente alimenta los avisos por email y WhatsApp
 * (`jobs/config-alerts.ts`), así que los tres canales dicen lo mismo.
 */
dashboardRouter.get(
  "/clinics/:clinicId/config-health",
  requirePermission(PERMISSIONS.CONFIGURACION_VER),
  async (req, res) => {
  const health = await getConfigHealth(req.params.clinicId);
  if (!health) return res.status(404).json({ error: "Clínica no encontrada" });

  res.json({
    ...health,
    issues: [...health.issues].sort((a, b) =>
      a.severidad === b.severidad ? 0 : a.severidad === "bloqueante" ? -1 : 1
    ),
  });
});

/**
 * Los feriados nacionales del año, marcando cuáles ya están cargados.
 *
 * Se devuelve el calendario completo con `yaCargado` en vez de solo los que
 * faltan, para que la interfaz pueda mostrar los tildes puestos en lugar de
 * una lista que se va vaciando sin dejar ver qué se hizo.
 *
 * Requiere `Clinic.country`. Si no está, la lista viene vacía.
 */
dashboardRouter.get(
  "/clinics/:clinicId/holidays",
  requirePermission(PERMISSIONS.FERIADOS_VER),
  async (req, res) => {
  const { clinicId } = req.params;

  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { id: true, country: true },
  });
  if (!clinic) return res.status(404).json({ error: "Clínica no encontrada" });

  const year =
    typeof req.query.year === "string" && /^\d{4}$/.test(req.query.year)
      ? Number(req.query.year)
      : new Date().getUTCFullYear();

  const { country, sugerencias } = await holidaySuggestionsForClinic({ clinicId, year });

  res.json({
    year,
    // Los años que hoy hay que tener cargados. Desde diciembre incluye el
    // siguiente, para que el calendario esté listo antes del 1 de enero.
    aniosRelevantes: relevantHolidayYears(),
    country,
    paisSoportado: country ? await isSupportedCountry(country) : false,
    paisesSoportados: await supportedCountries(),
    pendientes: sugerencias.filter((s) => !s.yaCargado).length,
    feriados: sugerencias,
  });
});

/**
 * Carga como días cerrados los feriados que la clínica confirmó.
 *
 * Body: `{ year?, dateKeys? }`. Sin `dateKeys` se cargan todos los que
 * falten del año — el caso "confirmo el calendario completo".
 *
 * Los feriados NO se cargan solos en el alta a propósito: hay clínicas que
 * atienden algunos, y cerrar un día sin que lo confirmen les haría perder
 * turnos reales. Las fechas que ya tenían una excepción cargada no se
 * tocan, para no pisar un horario especial definido a mano.
 */
dashboardRouter.post(
  "/clinics/:clinicId/holidays/apply",
  requirePermission(PERMISSIONS.FERIADOS_EDITAR),
  async (req, res) => {
  const { clinicId } = req.params;
  const body = (req.body ?? {}) as { year?: unknown; dateKeys?: unknown };

  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { id: true, country: true },
  });
  if (!clinic) return res.status(404).json({ error: "Clínica no encontrada" });
  if (!clinic.country) {
    return res.status(400).json({
      error: "La clínica no tiene país configurado, así que no hay calendario de feriados.",
    });
  }

  const year =
    typeof body.year === "number" ? body.year : new Date().getUTCFullYear();

  let dateKeys: string[] | undefined;
  if (body.dateKeys !== undefined) {
    if (!Array.isArray(body.dateKeys) || body.dateKeys.some((d) => typeof d !== "string")) {
      return res.status(400).json({ error: "`dateKeys` tiene que ser un arreglo de strings." });
    }
    dateKeys = body.dateKeys as string[];
  }

  const { cargados, omitidos } = await applyHolidays({ clinicId, year, dateKeys });

  res.json({
    year,
    cargados,
    // Fechas pedidas que no son feriados del catálogo, o que ya estaban
    // cargadas. Se informan para que la interfaz no diga que se cargaron.
    omitidos,
  });
});

/** Configura el país de la clínica, que es lo que habilita los feriados. */
dashboardRouter.put(
  "/clinics/:clinicId/country",
  requirePermission(PERMISSIONS.CONFIGURACION_EDITAR),
  async (req, res) => {
  const { clinicId } = req.params;
  const { country } = (req.body ?? {}) as { country?: unknown };

  if (country !== null && typeof country !== "string") {
    return res.status(400).json({ error: "`country` tiene que ser un string o null." });
  }

  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { id: true, timezone: true },
  });
  if (!clinic) return res.status(404).json({ error: "Clínica no encontrada" });

  const normalizado = typeof country === "string" ? country.trim().toUpperCase() : null;
  if (normalizado && !(await isSupportedCountry(normalizado))) {
    return res.status(400).json({
      error: `Todavía no hay calendario de feriados para "${normalizado}".`,
      paisesSoportados: await supportedCountries(),
      // Un país nuevo se agrega desde la pantalla de plataforma "Países",
      // no editando código.
      sugerido: suggestCountryFromTimezone(clinic.timezone),
    });
  }

  const actualizada = await prisma.clinic.update({
    where: { id: clinicId },
    data: { country: normalizado },
    select: { country: true },
  });

  res.json(actualizada);
});

/**
 * Excepciones de horario por fecha: feriados, jornadas especiales, días de
 * media jornada.
 *
 * Query params opcionales `desde` / `hasta` (YYYY-MM-DD).
 */
dashboardRouter.get(
  "/clinics/:clinicId/schedule-exceptions",
  requirePermission(PERMISSIONS.HORARIOS_VER),
  async (req, res) => {
  const { clinicId } = req.params;

  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { id: true },
  });
  if (!clinic) return res.status(404).json({ error: "Clínica no encontrada" });

  const excepciones = await listScheduleExceptions({
    clinicId,
    desde: typeof req.query.desde === "string" ? req.query.desde : undefined,
    hasta: typeof req.query.hasta === "string" ? req.query.hasta : undefined,
  });

  res.json({
    excepciones: excepciones.map((e) => ({
      ...e,
      alcance: e.professionalId ? "profesional" : "clinica",
      tramos: e.tramos.map((t) => ({
        ...t,
        desde: minutesToWallTime(t.startMinute),
        hasta: minutesToWallTime(t.endMinute),
      })),
    })),
  });
});

/**
 * Carga (o sobrescribe) la excepción de una fecha.
 *
 * Body: `{ dateKey, reason, professionalId?, tramos? }`.
 *
 * - Sin `tramos` (o con `tramos: []`) → **cerrado todo el día**. Es el
 *   feriado y el "ese día tenemos una actividad y no atendemos".
 * - Con `tramos` → ese es el horario de ESE día, en lugar del semanal.
 *   Sirve para media jornada.
 *
 * `professionalId` en null (o ausente) afecta a toda la clínica; con valor,
 * solo a ese profesional.
 */
dashboardRouter.put(
  "/clinics/:clinicId/schedule-exceptions",
  requirePermission(PERMISSIONS.HORARIOS_EDITAR),
  async (req, res) => {
  const { clinicId } = req.params;
  const body = (req.body ?? {}) as {
    dateKey?: unknown;
    reason?: unknown;
    professionalId?: unknown;
    tramos?: unknown;
  };

  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { id: true },
  });
  if (!clinic) return res.status(404).json({ error: "Clínica no encontrada" });

  if (typeof body.dateKey !== "string") {
    return res.status(400).json({ error: "Hace falta `dateKey` en formato YYYY-MM-DD." });
  }
  if (typeof body.reason !== "string" || !body.reason.trim()) {
    return res.status(400).json({
      error: 'Hace falta `reason` (ej. "Feriado nacional", "Jornada de capacitación").',
    });
  }

  let professionalId: string | null = null;
  if (body.professionalId != null) {
    if (typeof body.professionalId !== "string") {
      return res.status(400).json({ error: "professionalId tiene que ser un string o null." });
    }
    // El clinicId va en el where para no poder tocar un profesional ajeno.
    const professional = await prisma.professional.findFirst({
      where: { id: body.professionalId, clinicId },
      select: { id: true },
    });
    if (!professional) {
      return res.status(404).json({ error: "Profesional no encontrado en esta clínica" });
    }
    professionalId = professional.id;
  }

  let tramos: Array<{ startMinute: number; endMinute: number }> = [];
  if (body.tramos !== undefined) {
    if (!Array.isArray(body.tramos)) {
      return res.status(400).json({ error: "`tramos` tiene que ser un arreglo." });
    }
    for (const raw of body.tramos) {
      const tramo = raw as { startMinute?: unknown; endMinute?: unknown };
      if (typeof tramo.startMinute !== "number" || typeof tramo.endMinute !== "number") {
        return res
          .status(400)
          .json({ error: "startMinute y endMinute tienen que ser números." });
      }
      tramos.push({ startMinute: tramo.startMinute, endMinute: tramo.endMinute });
    }
  }

  try {
    const rows = await upsertScheduleException({
      clinicId,
      input: { dateKey: body.dateKey, reason: body.reason, professionalId, tramos },
    });

    res.json({
      dateKey: body.dateKey,
      alcance: professionalId ? "profesional" : "clinica",
      professionalId,
      reason: body.reason.trim(),
      cerradoTodoElDia: tramos.length === 0,
      tramos: rows
        .filter((r) => r.startMinute !== null)
        .map((r) => ({
          startMinute: r.startMinute,
          endMinute: r.endMinute,
          desde: minutesToWallTime(r.startMinute as number),
          hasta: minutesToWallTime(r.endMinute as number),
        })),
    });
  } catch (error) {
    if (error instanceof WorkingHoursValidationError) {
      return res.status(400).json({ error: "Excepción inválida", detalles: error.errores });
    }
    throw error;
  }
});

/** Borra la excepción de una fecha, volviendo al horario semanal. */
dashboardRouter.delete(
  "/clinics/:clinicId/schedule-exceptions/:dateKey",
  requirePermission(PERMISSIONS.HORARIOS_EDITAR),
  async (req, res) => {
  const { clinicId, dateKey } = req.params;
  const professionalId =
    typeof req.query.professionalId === "string" ? req.query.professionalId : null;

  try {
    const count = await deleteScheduleException({ clinicId, dateKey, professionalId });
    if (count === 0) {
      return res.status(404).json({ error: "No había una excepción cargada para esa fecha" });
    }
    res.json({ borrada: true, dateKey });
  } catch (error) {
    if (error instanceof WorkingHoursValidationError) {
      return res.status(400).json({ error: "Fecha inválida", detalles: error.errores });
    }
    throw error;
  }
});

const DIAS: Weekday[] = [
  "lunes",
  "martes",
  "miercoles",
  "jueves",
  "viernes",
  "sabado",
  "domingo",
];

/** Valida la forma del body antes de pasarlo a la capa de servicio. */
function parseTramos(
  body: unknown
): { tramos: WorkingHoursInput[] } | { error: string } {
  const tramos = (body as { tramos?: unknown } | null)?.tramos;
  if (!Array.isArray(tramos)) {
    return { error: "El body tiene que traer `tramos` como arreglo." };
  }

  const parsed: WorkingHoursInput[] = [];
  for (const raw of tramos) {
    const tramo = raw as { weekday?: unknown; startMinute?: unknown; endMinute?: unknown };

    if (typeof tramo.weekday !== "string" || !DIAS.includes(tramo.weekday as Weekday)) {
      return { error: `weekday inválido. Valores válidos: ${DIAS.join(", ")}.` };
    }
    if (typeof tramo.startMinute !== "number" || typeof tramo.endMinute !== "number") {
      return { error: "startMinute y endMinute tienen que ser números (minutos desde medianoche)." };
    }

    parsed.push({
      weekday: tramo.weekday as Weekday,
      startMinute: tramo.startMinute,
      endMinute: tramo.endMinute,
    });
  }

  return { tramos: parsed };
}

/**
 * Catálogo formal de servicios de la clínica.
 *
 * Es lo que define cuánto dura cada turno y qué equipo ocupa, y —desde que el
 * prompt lo lee— también lo que el agente le cuenta al paciente. `Clinic.services`
 * (texto libre) queda como respaldo para las clínicas que todavía no lo cargaron;
 * el GET devuelve los dos para poder compararlos a ojo, igual que working-hours.
 */
dashboardRouter.get(
  "/clinics/:clinicId/services",
  requirePermission(PERMISSIONS.SERVICIOS_VER),
  async (req, res) => {
    const { clinicId } = req.params;

    const clinic = await prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { id: true, services: true },
    });
    if (!clinic) return res.status(404).json({ error: "Clínica no encontrada" });

    const servicios = await listServices(clinicId);
    const activos = servicios.filter((s) => s.active);

    // Para el selector de "quiénes lo realizan": va acá y no se lee de
    // Recursos porque son permisos distintos (`servicios.*` vs `recursos.*`).
    const profesionalesActivos = await prisma.professional.findMany({
      where: { clinicId, active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    });

    res.json({
      profesionalesDisponibles: profesionalesActivos,
      servicios: servicios.map((s) => ({
        id: s.id,
        name: s.name,
        durationMinutes: s.durationMinutes,
        requiredResourceType: s.requiredResourceType,
        active: s.active,
        priceNote: s.priceNote,
        firstVisit: s.firstVisit,
        turnos: s._count.appointments,
        // Quiénes lo realizan. Vacío = nadie: el agente no puede darlo.
        profesionales: s.professionals.map((p) => ({ id: p.id, name: p.name, active: p.active })),
      })),
      textoDelPrompt: clinic.services,
      descripcion: activos.length > 0 ? describeServices(activos) : clinic.services,
      usaCatalogo: activos.length > 0,
    });
  }
);

/**
 * Los tipos de equipo que la clínica tiene cargados.
 *
 * Alimenta el selector de "equipo requerido". Un servicio que pide un tipo de
 * equipo inexistente no tendría nunca un hueco libre ni se podría agendar, y no
 * daría ningún error visible — por eso las opciones salen de acá y no de un
 * campo de texto.
 */
dashboardRouter.get(
  "/clinics/:clinicId/resource-types",
  requirePermission(PERMISSIONS.SERVICIOS_VER),
  async (req, res) => {
    const { clinicId } = req.params;

    const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { id: true } });
    if (!clinic) return res.status(404).json({ error: "Clínica no encontrada" });

    res.json({ tipos: await listResourceTypes(clinicId) });
  }
);

dashboardRouter.post(
  "/clinics/:clinicId/services",
  requirePermission(PERMISSIONS.SERVICIOS_EDITAR),
  async (req, res) => {
    const { clinicId } = req.params;

    const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { id: true } });
    if (!clinic) return res.status(404).json({ error: "Clínica no encontrada" });

    const parsed = await parseServicio(req.body, clinicId);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });

    const servicio = await createService(clinicId, parsed.servicio);

    if (parsed.professionalIds) {
      await setServiceProfessionals(clinicId, servicio.id, parsed.professionalIds);
    }
    if (parsed.firstVisit) await setFirstVisitService(clinicId, servicio.id, true);

    res.status(201).json({ servicio });
  }
);

dashboardRouter.put(
  "/clinics/:clinicId/services/:serviceId",
  requirePermission(PERMISSIONS.SERVICIOS_EDITAR),
  async (req, res) => {
    const { clinicId, serviceId } = req.params;

    const parsed = await parseServicio(req.body, clinicId);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });

    // Los profesionales primero: si dejaría a alguien sin ningún servicio se
    // rechaza ANTES de tocar nada, para no guardar a medias.
    if (parsed.professionalIds) {
      const r = await setServiceProfessionals(clinicId, serviceId, parsed.professionalIds);
      if (!r.ok && r.reason === "no_encontrado") {
        return res.status(404).json({ error: "Servicio no encontrado en esta clínica" });
      }
      if (!r.ok) {
        return res.status(409).json({
          error: `Quitar este servicio dejaría sin ninguno a: ${r.professionals.join(
            ", "
          )}. Un profesional sin servicios no se puede agendar: asígnale otro primero.`,
        });
      }
    }

    const actualizado = await updateService(serviceId, clinicId, parsed.servicio);
    if (!actualizado) return res.status(404).json({ error: "Servicio no encontrado en esta clínica" });

    if (parsed.firstVisit !== undefined) {
      await setFirstVisitService(clinicId, serviceId, parsed.firstVisit);
    }

    res.json({ actualizado: true });
  }
);

dashboardRouter.delete(
  "/clinics/:clinicId/services/:serviceId",
  requirePermission(PERMISSIONS.SERVICIOS_EDITAR),
  async (req, res) => {
    const { clinicId, serviceId } = req.params;

    const result = await deleteService(serviceId, clinicId);
    if (result.ok) return res.status(204).end();

    if (result.reason === "no_encontrado") {
      return res.status(404).json({ error: "Servicio no encontrado en esta clínica" });
    }
    res.status(409).json({
      error:
        "Este servicio ya tiene citas y no se puede borrar. Desactívalo para dejar de ofrecerlo.",
    });
  }
);

/**
 * Valida el cuerpo de alta/edición de un servicio.
 *
 * El chequeo del tipo de equipo contra los equipos reales de la clínica va acá
 * y no solo en la interfaz: un tipo inexistente deja el servicio inagendable
 * para siempre y sin mensaje de error.
 */
async function parseServicio(
  body: unknown,
  clinicId: string
): Promise<
  | {
      servicio: {
        name: string;
        durationMinutes: number;
        requiredResourceType: string | null;
        active: boolean;
        priceNote: string | null;
      };
      /** undefined = no vino, no se toca; array = el set completo. */
      professionalIds?: string[];
      firstVisit?: boolean;
    }
  | { error: string }
> {
  const input = (body ?? {}) as {
    name?: unknown;
    durationMinutes?: unknown;
    requiredResourceType?: unknown;
    active?: unknown;
    professionalIds?: unknown;
    firstVisit?: unknown;
    priceNote?: unknown;
  };

  if (typeof input.name !== "string" || input.name.trim() === "") {
    return { error: "El nombre del servicio es obligatorio" };
  }

  if (
    typeof input.durationMinutes !== "number" ||
    !Number.isInteger(input.durationMinutes) ||
    input.durationMinutes < 5 ||
    input.durationMinutes > 480
  ) {
    return { error: "La duración tiene que ser un número entero de minutos, entre 5 y 480" };
  }

  let requiredResourceType: string | null = null;
  if (typeof input.requiredResourceType === "string" && input.requiredResourceType.trim() !== "") {
    requiredResourceType = input.requiredResourceType.trim();
    const tipos = await listResourceTypes(clinicId);
    if (!tipos.includes(requiredResourceType)) {
      return {
        error: `La clínica no tiene equipos del tipo "${requiredResourceType}". Sin un equipo de ese tipo, este servicio no se podría agendar nunca.`,
      };
    }
  } else if (input.requiredResourceType !== undefined && input.requiredResourceType !== null) {
    return { error: "El tipo de equipo tiene que ser un texto o quedar vacío" };
  }

  if (input.active !== undefined && typeof input.active !== "boolean") {
    return { error: "El campo activo tiene que ser verdadero o falso" };
  }

  let professionalIds: string[] | undefined;
  if (input.professionalIds !== undefined) {
    if (
      !Array.isArray(input.professionalIds) ||
      !input.professionalIds.every((id) => typeof id === "string")
    ) {
      return { error: "Los profesionales tienen que ser una lista de ids" };
    }
    const validos = await validProfessionalIds(clinicId, input.professionalIds as string[]);
    if (!validos) return { error: "Algún profesional indicado no es de esta clínica" };
    professionalIds = validos;
  }

  if (input.firstVisit !== undefined && typeof input.firstVisit !== "boolean") {
    return { error: "El campo de primera vez tiene que ser verdadero o falso" };
  }

  // Vacío o ausente = sin precio cargado (null): el asistente no afirma ninguno.
  let priceNote: string | null = null;
  if (input.priceNote !== undefined && input.priceNote !== null && input.priceNote !== "") {
    if (!isValidPriceNote(input.priceNote)) {
      return {
        error: `El precio tiene que ser un texto de una línea, de hasta ${PRICE_NOTE_MAX_LENGTH} caracteres (ej. "$500" o "Sin costo si llega por redes")`,
      };
    }
    priceNote = input.priceNote.trim();
  }

  return {
    servicio: {
      name: normalizeServiceName(input.name),
      durationMinutes: input.durationMinutes,
      requiredResourceType,
      active: input.active ?? true,
      priceNote,
    },
    professionalIds,
    firstVisit: input.firstVisit as boolean | undefined,
  };
}

/**
 * Derivaciones: los casos que el asistente pasó a una persona.
 *
 * Por default solo los pendientes — es una cola de trabajo, no un historial.
 */
dashboardRouter.get(
  "/clinics/:clinicId/escalations",
  requirePermission(PERMISSIONS.DERIVACIONES_VER),
  async (req, res) => {
    const { clinicId } = req.params;

    const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { id: true } });
    if (!clinic) return res.status(404).json({ error: "Clínica no encontrada" });

    const derivaciones = await listEscalations({
      clinicId,
      incluirResueltos: req.query.incluirResueltas === "true",
    });

    res.json({
      derivaciones: derivaciones.map((e) => ({
        id: e.id,
        patientName: e.patientName,
        patientPhone: e.patientPhone,
        motivo: e.reason,
        mensaje: e.patientMessage,
        creadaEn: e.createdAt,
        atendidaEn: e.resolvedAt,
        atendidaPor: e.resolvedBy,
        avisadaPorMail: e.notifiedByEmail,
      })),
      pendientes: await countPendingEscalations(clinicId),
    });
  }
);

dashboardRouter.put(
  "/clinics/:clinicId/escalations/:escalationId/resolve",
  requirePermission(PERMISSIONS.DERIVACIONES_GESTIONAR),
  async (req, res) => {
    const { clinicId, escalationId } = req.params;
    const quien = req.user?.email ?? "desconocido";

    const ok = await resolveEscalation(escalationId, clinicId, quien);
    if (!ok) return res.status(404).json({ error: "Derivación no encontrada en esta clínica" });

    res.json({ atendida: true, atendidaPor: quien });
  }
);

dashboardRouter.put(
  "/clinics/:clinicId/escalations/:escalationId/reopen",
  requirePermission(PERMISSIONS.DERIVACIONES_GESTIONAR),
  async (req, res) => {
    const { clinicId, escalationId } = req.params;

    const ok = await reopenEscalation(escalationId, clinicId);
    if (!ok) return res.status(404).json({ error: "Derivación no encontrada en esta clínica" });

    res.json({ atendida: false });
  }
);

/**
 * ABM de los recursos con los que atiende una clínica: profesionales,
 * espacios y equipos.
 *
 * Hasta acá no había ninguna forma de cargarlos desde la interfaz — solo
 * `scripts/add-clinic.ts` o SQL directo—, así que una clínica que
 * contrataba un profesional no podía darlo de alta, y una sin ningún
 * espacio cargado veía `checkAvailability()` rechazar todos los turnos.
 *
 * Nada se borra: se desactiva. Los turnos históricos los referencian.
 */

/**
 * Con qué obras sociales / prepagas trabaja la clínica.
 *
 * Devuelve el catálogo entero con el estado de esta clínica en cada fila
 * (`active: null` = nunca la tomó), porque elegir una nueva es la acción
 * principal de la pantalla. El agente solo menciona las que están activas
 * en las dos puntas — ver `listActiveInsurersForClinic()`.
 */
dashboardRouter.get(
  "/clinics/:clinicId/insurers",
  requirePermission(PERMISSIONS.SEGUROS_VER),
  async (req, res) => {
    res.json({ seguros: await listInsurersForClinic(req.params.clinicId) });
  }
);

dashboardRouter.put(
  "/clinics/:clinicId/insurers/:insurerId",
  requirePermission(PERMISSIONS.SEGUROS_EDITAR),
  async (req, res) => {
    const { active } = (req.body ?? {}) as { active?: unknown };
    if (typeof active !== "boolean") {
      return res.status(400).json({ error: "`active` tiene que ser booleano." });
    }

    const result = await setClinicInsurer({
      clinicId: req.params.clinicId,
      insurerId: req.params.insurerId,
      active,
    });
    if (!result.ok) {
      return res
        .status(400)
        .json({ error: "Ese seguro no existe en el catálogo, o ya no está vigente." });
    }
    res.json({ ok: true });
  }
);

dashboardRouter.get(
  "/clinics/:clinicId/resources",
  requirePermission(PERMISSIONS.RECURSOS_VER),
  async (req, res) => {
    const { clinicId } = req.params;
    const [profesionales, espacios, equipos, turnos, titulos] = await Promise.all([
      listProfessionals(clinicId),
      listRooms(clinicId),
      listResources(clinicId),
      countFutureAppointments(clinicId),
      listTitlesForClinic(clinicId),
    ]);

    // Los servicios que se pueden asignar a un profesional. Vacío = la clínica
    // no tiene catálogo, y entonces no se exige asignar ninguno.
    const serviciosDisponibles = await prisma.service.findMany({
      where: { clinicId, active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    });

    res.json({
      serviciosDisponibles,
      // Los títulos que el selector puede ofrecer: los que la plataforma le
      // habilitó a esta clínica y siguen activos. Van en la misma respuesta
      // que los profesionales porque los usa la misma pantalla.
      titulos,
      profesionales: profesionales.map((p) => ({
        id: p.id,
        name: p.name,
        titleId: p.titleId,
        title: p.title?.name ?? null,
        active: p.active,
        preferredRoomId: p.preferredRoomId,
        preferredRoomName: p.preferredRoom?.name ?? null,
        contactEmail: p.contactEmail,
        whatsappPhone: p.whatsappPhone,
        notifyByEmail: p.notifyByEmail,
        notifyByWhatsapp: p.notifyByWhatsapp,
        servicios: p.services.map((x) => ({ id: x.id, name: x.name, active: x.active })),
        turnosFuturos: turnos.professionals.get(p.id) ?? 0,
      })),
      espacios: espacios.map((r) => ({
        id: r.id,
        name: r.name,
        active: r.active,
        turnosFuturos: turnos.rooms.get(r.id) ?? 0,
      })),
      equipos: equipos.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        active: r.active,
        inactiveReason: r.inactiveReason,
        turnosFuturos: turnos.resources.get(r.id) ?? 0,
      })),
    });
  }
);

/**
 * Los campos de contacto y avisos del profesional.
 *
 * El texto vacío se guarda como null y no como "": un email en blanco tiene
 * que apagar el aviso, no dejarlo apuntando a una cadena vacía.
 */
/** string trimeado, null si vino vacío, undefined si no vino. */
function textoOpcional(v: unknown): string | null | undefined {
  return typeof v === "string" ? (v.trim() ? v.trim() : null) : undefined;
}

/**
 * El título que llega en el body, validado contra los que la clínica tiene
 * habilitados **y activos** — la misma lista que ofrece el selector.
 *
 * Se valida en el backend y no solo en la interfaz por el mismo motivo que el
 * tipo de equipo de un `Service`: un `titleId` de otra clínica, o de un
 * título dado de baja, no da ningún error visible — el profesional queda
 * nombrado con algo que la clínica no usa.
 */
async function tituloValido(
  clinicId: string,
  body: Record<string, unknown>
): Promise<string | null | typeof INVALIDO> {
  const raw = body.titleId;
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string") return INVALIDO;

  const habilitados = await listTitlesForClinic(clinicId);
  return habilitados.some((t) => t.id === raw) ? raw : INVALIDO;
}

/** Los `serviceIds` del body, validados contra la clínica. [] si no vinieron. */
async function serviciosDelBody(
  clinicId: string,
  body: unknown
): Promise<string[] | typeof INVALIDO> {
  const raw = (body as { serviceIds?: unknown } | null)?.serviceIds;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || !raw.every((id) => typeof id === "string")) return INVALIDO;
  return (await validServiceIds(clinicId, raw as string[])) ?? INVALIDO;
}

function contactoDelBody(b: Record<string, unknown>) {
  const data: {
    contactEmail?: string | null;
    whatsappPhone?: string | null;
    notifyByEmail?: boolean;
    notifyByWhatsapp?: boolean;
  } = {};

  if (b.contactEmail !== undefined) data.contactEmail = textoOpcional(b.contactEmail) ?? null;
  if (b.whatsappPhone !== undefined) data.whatsappPhone = textoOpcional(b.whatsappPhone) ?? null;
  if (typeof b.notifyByEmail === "boolean") data.notifyByEmail = b.notifyByEmail;
  if (typeof b.notifyByWhatsapp === "boolean") data.notifyByWhatsapp = b.notifyByWhatsapp;

  return data;
}

/** Un nombre no vacío; devuelve null si el body no lo trae bien. */
function nombreDelBody(body: unknown): string | null {
  const name = (body as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

dashboardRouter.post(
  "/clinics/:clinicId/professionals",
  requirePermission(PERMISSIONS.RECURSOS_EDITAR),
  async (req, res) => {
    const name = nombreDelBody(req.body);
    if (!name) return res.status(400).json({ error: "El nombre es obligatorio." });

    const preferredRoomId = await espacioValido(req.params.clinicId, req.body);
    if (preferredRoomId === INVALIDO) {
      return res.status(400).json({ error: "El espacio indicado no es de esta clínica." });
    }

    const titleId = await tituloValido(
      req.params.clinicId,
      (req.body ?? {}) as Record<string, unknown>
    );
    if (titleId === INVALIDO) {
      return res.status(400).json({ error: "El título indicado no está habilitado para esta clínica." });
    }

    // Sin ningún servicio "no hace nada": no se lo deja dar de alta. Solo
    // cuando la clínica tiene catálogo — sin él no hay servicios que asignar.
    const serviceIds = await serviciosDelBody(req.params.clinicId, req.body);
    if (serviceIds === INVALIDO) {
      return res.status(400).json({ error: "Algún servicio indicado no es de esta clínica." });
    }
    if ((await clinicHasCatalog(req.params.clinicId)) && serviceIds.length === 0) {
      return res.status(400).json({
        error:
          "Elige al menos un servicio que realice este profesional: sin servicios asignados no se le puede agendar nada.",
      });
    }

    const creado = await createProfessional({
      clinicId: req.params.clinicId,
      name,
      titleId,
      preferredRoomId,
      serviceIds,
      ...contactoDelBody((req.body ?? {}) as Record<string, unknown>),
    });
    res.status(201).json(creado);
  }
);

dashboardRouter.put(
  "/clinics/:clinicId/professionals/:id",
  requirePermission(PERMISSIONS.RECURSOS_EDITAR),
  async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const data: ProfessionalInput = {};

    if (b.name !== undefined) {
      const name = nombreDelBody(b);
      if (!name) return res.status(400).json({ error: "El nombre no puede quedar vacío." });
      data.name = name;
    }
    if (b.titleId !== undefined) {
      const titleId = await tituloValido(req.params.clinicId, b);
      if (titleId === INVALIDO) {
        return res
          .status(400)
          .json({ error: "El título indicado no está habilitado para esta clínica." });
      }
      data.titleId = titleId;
    }
    if (b.active !== undefined) {
      if (typeof b.active !== "boolean") {
        return res.status(400).json({ error: "`active` tiene que ser booleano." });
      }
      data.active = b.active;
    }
    if (b.preferredRoomId !== undefined) {
      const espacio = await espacioValido(req.params.clinicId, b);
      if (espacio === INVALIDO) {
        return res.status(400).json({ error: "El espacio indicado no es de esta clínica." });
      }
      data.preferredRoomId = espacio;
    }

    Object.assign(data, contactoDelBody(b));

    // Servicios: el set completo. Con catálogo, no puede quedar vacío, ni
    // siquiera activando a alguien que hoy no tiene ninguno.
    const serviceIds = b.serviceIds !== undefined ? await serviciosDelBody(req.params.clinicId, b) : null;
    if (serviceIds === INVALIDO) {
      return res.status(400).json({ error: "Algún servicio indicado no es de esta clínica." });
    }
    if (await clinicHasCatalog(req.params.clinicId)) {
      const quedaran =
        serviceIds !== null
          ? serviceIds.length
          : await countProfessionalServices(req.params.clinicId, req.params.id);
      if (serviceIds !== null && serviceIds.length === 0) {
        return res.status(400).json({
          error:
            "Un profesional necesita al menos un servicio: sin ninguno no se le puede agendar nada.",
        });
      }
      if (data.active === true && quedaran === 0) {
        return res.status(400).json({
          error:
            "No se puede activar un profesional sin servicios. Asígnale al menos uno primero.",
        });
      }
    }

    const { count } = await updateProfessional(req.params.clinicId, req.params.id, data);
    if (count === 0) return res.status(404).json({ error: "Profesional no encontrado" });
    if (serviceIds !== null) {
      await setProfessionalServices(req.params.clinicId, req.params.id, serviceIds);
    }
    res.json({ ok: true });
  }
);

dashboardRouter.post(
  "/clinics/:clinicId/rooms",
  requirePermission(PERMISSIONS.RECURSOS_EDITAR),
  async (req, res) => {
    const name = nombreDelBody(req.body);
    if (!name) return res.status(400).json({ error: "El nombre es obligatorio." });
    res.status(201).json(await createRoom({ clinicId: req.params.clinicId, name }));
  }
);

dashboardRouter.put(
  "/clinics/:clinicId/rooms/:id",
  requirePermission(PERMISSIONS.RECURSOS_EDITAR),
  async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const data: { name?: string; active?: boolean } = {};

    if (b.name !== undefined) {
      const name = nombreDelBody(b);
      if (!name) return res.status(400).json({ error: "El nombre no puede quedar vacío." });
      data.name = name;
    }
    if (b.active !== undefined) {
      if (typeof b.active !== "boolean") {
        return res.status(400).json({ error: "`active` tiene que ser booleano." });
      }
      data.active = b.active;
    }

    const { count } = await updateRoom(req.params.clinicId, req.params.id, data);
    if (count === 0) return res.status(404).json({ error: "Espacio no encontrado" });
    res.json({ ok: true });
  }
);

dashboardRouter.post(
  "/clinics/:clinicId/resources",
  requirePermission(PERMISSIONS.RECURSOS_EDITAR),
  async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = nombreDelBody(b);
    const type = typeof b.type === "string" && b.type.trim() ? b.type.trim() : null;
    if (!name || !type) {
      // El `type` es lo que enlaza con `Service.requiredResourceType`: un
      // equipo sin tipo no lo puede pedir ningún servicio.
      return res.status(400).json({ error: "El nombre y el tipo son obligatorios." });
    }
    res.status(201).json(await createResource({ clinicId: req.params.clinicId, name, type }));
  }
);

dashboardRouter.put(
  "/clinics/:clinicId/resources/:id",
  requirePermission(PERMISSIONS.RECURSOS_EDITAR),
  async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const data: { name?: string; type?: string; active?: boolean; inactiveReason?: string | null } =
      {};

    if (b.name !== undefined) {
      const name = nombreDelBody(b);
      if (!name) return res.status(400).json({ error: "El nombre no puede quedar vacío." });
      data.name = name;
    }
    if (b.inactiveReason !== undefined) {
      data.inactiveReason =
        typeof b.inactiveReason === "string" && b.inactiveReason.trim()
          ? b.inactiveReason.trim()
          : null;
    }
    if (b.type !== undefined) {
      if (typeof b.type !== "string" || !b.type.trim()) {
        return res.status(400).json({ error: "El tipo no puede quedar vacío." });
      }
      data.type = b.type.trim();
    }
    if (b.active !== undefined) {
      if (typeof b.active !== "boolean") {
        return res.status(400).json({ error: "`active` tiene que ser booleano." });
      }
      data.active = b.active;
      // Volver a activarlo borra el motivo: dejarlo puesto haría que el
      // próximo que lo mire crea que sigue roto.
      if (b.active === true) data.inactiveReason = null;
    }

    const { count } = await updateResource(req.params.clinicId, req.params.id, data);
    if (count === 0) return res.status(404).json({ error: "Equipo no encontrado" });
    res.json({ ok: true });
  }
);

/**
 * Valida que el espacio preferido sea de esta clínica.
 *
 * Sin este chequeo se le podría asignar a un profesional el consultorio de
 * otra clínica: el id viene del cliente y `Professional.preferredRoomId` no
 * tiene forma de saber a qué clínica pertenece.
 */
/** Lo comparten los validadores de espacio y de título. */
const INVALIDO = Symbol("valor invalido");

async function espacioValido(
  clinicId: string,
  body: unknown
): Promise<string | null | typeof INVALIDO> {
  const id = (body as { preferredRoomId?: unknown } | null)?.preferredRoomId;
  if (id === undefined || id === null || id === "") return null;
  if (typeof id !== "string") return INVALIDO;

  const room = await prisma.room.findFirst({ where: { id, clinicId }, select: { id: true } });
  return room ? room.id : INVALIDO;
}

// --- Paquetes de sesiones ---

/**
 * Los paquetes de la clínica, con cuántas sesiones tienen usadas, agendadas sin
 * confirmar y libres. `?patientId=` los de un paciente; `?onlyActive=true` solo
 * los que todavía sirven; `?serviceId=` los de ese servicio (o sin servicio).
 */
dashboardRouter.get(
  "/clinics/:clinicId/packages",
  requirePermission(PERMISSIONS.PAQUETES_VER),
  async (req, res) => {
    const q = req.query;
    res.json(
      await listPackages({
        clinicId: req.params.clinicId,
        patientId: typeof q.patientId === "string" ? q.patientId : undefined,
        onlyActive: q.onlyActive === "true",
        serviceId: typeof q.serviceId === "string" ? q.serviceId : undefined,
      })
    );
  }
);

/**
 * Lo que se le muestra a la asistente al entrar: las citas de hoy que vienen por
 * paquete y las de días anteriores que nadie marcó como atendidas. Ruta aparte
 * de `/packages` y declarada antes que `/packages/:packageId` para que "pending"
 * no se tome por un id.
 */
dashboardRouter.get(
  "/clinics/:clinicId/packages/pending",
  requirePermission(PERMISSIONS.PAQUETES_VER),
  async (req, res) => {
    const clinic = await prisma.clinic.findUnique({
      where: { id: req.params.clinicId },
      select: { id: true, timezone: true },
    });
    if (!clinic) return res.status(404).json({ error: "Clínica no encontrada" });
    res.json(await listPendingPackageAppointments({ clinicId: clinic.id, timezone: clinic.timezone }));
  }
);

/**
 * Le asigna a un paciente un paquete del catálogo (`templateId`): copia el
 * nombre, el servicio y las sesiones. Es la ÚNICA forma de dar de alta un paquete
 * por la API: no se arma uno nuevo, con su servicio y su cantidad, por cada
 * paciente.
 */
dashboardRouter.post(
  "/clinics/:clinicId/packages",
  requirePermission(PERMISSIONS.PAQUETES_GESTIONAR),
  async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await assignPackage({
      clinicId: req.params.clinicId,
      userId: req.user!.id,
      patientId: typeof b.patientId === "string" ? b.patientId : "",
      templateId: b.templateId,
    });
    if (!result.ok) {
      const status = result.reason === "datos_invalidos" ? 400 : 404;
      return res.status(status).json({ error: result.message, motivo: result.reason });
    }
    res.status(201).json(result.value);
  }
);

// --- Catálogo de paquetes ---

dashboardRouter.get(
  "/clinics/:clinicId/package-templates",
  requirePermission(PERMISSIONS.PAQUETES_VER),
  async (req, res) => {
    res.json(
      await listPackageTemplates({
        clinicId: req.params.clinicId,
        onlyActive: req.query.onlyActive === "true",
      })
    );
  }
);

function estadoDePlantilla(reason: string): number {
  if (reason === "plantilla_no_encontrada") return 404;
  if (reason === "nombre_duplicado") return 409;
  return 400;
}

dashboardRouter.post(
  "/clinics/:clinicId/package-templates",
  requirePermission(PERMISSIONS.PAQUETES_GESTIONAR),
  async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await createPackageTemplate({
      clinicId: req.params.clinicId,
      name: b.name,
      serviceId: b.serviceId,
      totalSessions: b.totalSessions,
      notes: textoONull(b.notes),
    });
    if (!result.ok) {
      return res.status(estadoDePlantilla(result.reason)).json({ error: result.message, motivo: result.reason });
    }
    res.status(201).json(result.value);
  }
);

dashboardRouter.put(
  "/clinics/:clinicId/package-templates/:templateId",
  requirePermission(PERMISSIONS.PAQUETES_GESTIONAR),
  async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await updatePackageTemplate({
      clinicId: req.params.clinicId,
      templateId: req.params.templateId,
      name: b.name,
      serviceId: b.serviceId,
      totalSessions: b.totalSessions,
      active: b.active,
      notes: b.notes === undefined ? undefined : textoONull(b.notes),
    });
    if (!result.ok) {
      return res.status(estadoDePlantilla(result.reason)).json({ error: result.message, motivo: result.reason });
    }
    res.json(result.value);
  }
);

dashboardRouter.put(
  "/clinics/:clinicId/packages/:packageId",
  requirePermission(PERMISSIONS.PAQUETES_GESTIONAR),
  async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.active !== undefined && typeof b.active !== "boolean") {
      return res.status(400).json({ error: "`active` tiene que ser booleano." });
    }
    const result = await updatePackage({
      clinicId: req.params.clinicId,
      packageId: req.params.packageId,
      totalSessions: b.totalSessions,
      active: b.active as boolean | undefined,
      notes: b.notes === undefined ? undefined : textoONull(b.notes),
    });
    if (!result.ok) {
      const status =
        result.reason === "no_encontrado" ? 404 : result.reason === "datos_invalidos" ? 400 : 409;
      return res.status(status).json({ error: result.message, motivo: result.reason });
    }
    res.json(result.value);
  }
);

/**
 * Una persona confirma que la cita se cumplió: si viene por un paquete, descuenta
 * una sesión. Idempotente. Va con `paquetes.gestionar` y no con
 * `citas.gestionar`: confirmar una asistencia es tocar el saldo prepago.
 */
dashboardRouter.post(
  "/clinics/:clinicId/appointments/:appointmentId/attended",
  requirePermission(PERMISSIONS.PAQUETES_GESTIONAR),
  async (req, res) => {
    const result = await markAppointmentAttended({
      clinicId: req.params.clinicId,
      appointmentId: req.params.appointmentId,
      userId: req.user!.id,
    });
    if (!result.ok) {
      const status = result.reason === "no_encontrado" ? 404 : 409;
      return res.status(status).json({ error: result.message, motivo: result.reason });
    }
    res.json({
      cita: result.appointment,
      paquete: result.package,
      yaEstabaMarcada: result.yaEstabaMarcada,
    });
  }
);

/** Deshace "atendida": devuelve la sesión. Para un click equivocado. */
dashboardRouter.delete(
  "/clinics/:clinicId/appointments/:appointmentId/attended",
  requirePermission(PERMISSIONS.PAQUETES_GESTIONAR),
  async (req, res) => {
    const result = await unmarkAppointmentAttended({
      clinicId: req.params.clinicId,
      appointmentId: req.params.appointmentId,
      userId: req.user!.id,
    });
    if (!result.ok) {
      const status = result.reason === "no_encontrado" ? 404 : 409;
      return res.status(status).json({ error: result.message, motivo: result.reason });
    }
    res.json({ cita: result.appointment, paquete: result.package });
  }
);

// --- Pacientes ---

function estadoDePaciente(reason: PatientFailure): number {
  if (reason === "no_encontrado") return 404;
  if (reason === "nombre_duplicado") return 409;
  return 400;
}

/**
 * La lista de pacientes. `?q=` busca por nombre, apellido o teléfono;
 * `?suggestedFrom=&suggestedTo=` (YYYY-MM-DD) o `?withSuggestion=true` los que
 * tienen próxima cita sugerida, lo más próximo primero: es la lista de "a quién hay
 * que darle cita para esa fecha".
 */
dashboardRouter.get(
  "/clinics/:clinicId/patients",
  requirePermission(PERMISSIONS.PACIENTES_VER),
  async (req, res) => {
    const q = req.query;
    const result = await listPatients({
      clinicId: req.params.clinicId,
      q: typeof q.q === "string" ? q.q : undefined,
      suggestedFrom: typeof q.suggestedFrom === "string" ? q.suggestedFrom : undefined,
      suggestedTo: typeof q.suggestedTo === "string" ? q.suggestedTo : undefined,
      withSuggestion: q.withSuggestion === "true",
      limit: typeof q.limit === "string" ? Number(q.limit) : undefined,
      offset: typeof q.offset === "string" ? Number(q.offset) : undefined,
    });
    if (!result.ok) return res.status(estadoDePaciente(result.reason)).json({ error: result.message });
    res.json(result.value);
  }
);

dashboardRouter.post(
  "/clinics/:clinicId/patients",
  requirePermission(PERMISSIONS.PACIENTES_EDITAR),
  async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await createPatient({
      clinicId: req.params.clinicId,
      firstName: b.firstName,
      lastName: b.lastName,
      phone: b.phone,
    });
    if (!result.ok) {
      return res.status(estadoDePaciente(result.reason)).json({ error: result.message, motivo: result.reason });
    }
    res.status(201).json(result.value);
  }
);

dashboardRouter.get(
  "/clinics/:clinicId/patients/:patientId",
  requirePermission(PERMISSIONS.PACIENTES_VER),
  async (req, res) => {
    const result = await getPatientDetail({
      clinicId: req.params.clinicId,
      patientId: req.params.patientId,
    });
    if (!result.ok) return res.status(estadoDePaciente(result.reason)).json({ error: result.message });
    res.json(result.value);
  }
);

dashboardRouter.put(
  "/clinics/:clinicId/patients/:patientId",
  requirePermission(PERMISSIONS.PACIENTES_EDITAR),
  async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await updatePatient({
      clinicId: req.params.clinicId,
      patientId: req.params.patientId,
      changes: {
        firstName: b.firstName,
        lastName: b.lastName,
        observations: b.observations,
        suggestedNextVisitDate: b.suggestedNextVisitDate,
        suggestedNextVisitNote: b.suggestedNextVisitNote,
        outreachOptOut: b.outreachOptOut,
        authorizedPhones: b.authorizedPhones,
      },
    });
    if (!result.ok) {
      return res.status(estadoDePaciente(result.reason)).json({ error: result.message, motivo: result.reason });
    }
    // Qué campos cambiaron DE VERDAD (solo los nombres, nunca los valores: una
    // observación clínica no puede quedar en el registro).
    enrichAudit(res, { details: { camposModificados: result.changedFields } });
    res.json(result.value);
  }
);

dashboardRouter.post(
  "/clinics/:clinicId/patients/:patientId/comments",
  requirePermission(PERMISSIONS.PACIENTES_EDITAR),
  async (req, res) => {
    const autor = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } });
    const result = await addPatientComment({
      clinicId: req.params.clinicId,
      patientId: req.params.patientId,
      userId: req.user!.id,
      authorName: autor?.name ?? "Personal de la clínica",
      text: (req.body as { text?: unknown } | undefined)?.text,
    });
    if (!result.ok) return res.status(estadoDePaciente(result.reason)).json({ error: result.message });
    res.status(201).json(result.value);
  }
);

dashboardRouter.delete(
  "/clinics/:clinicId/patients/:patientId/comments/:commentId",
  requirePermission(PERMISSIONS.PACIENTES_EDITAR),
  async (req, res) => {
    const result = await deletePatientComment({
      clinicId: req.params.clinicId,
      patientId: req.params.patientId,
      commentId: req.params.commentId,
    });
    if (!result.ok) return res.status(estadoDePaciente(result.reason)).json({ error: result.message });
    res.json({ eliminado: true });
  }
);

// --- Campañas y promociones ---

const estadoDeCampana = (reason: string): number =>
  reason === "no_encontrada" ? 404 : reason === "nombre_duplicado" || reason === "formato_duplicado" ? 409 : 400;

/** Del cuerpo de la petición a lo que acepta el servicio: solo los campos que vinieron. */
function campanaDelBody(b: Record<string, unknown>): Partial<CampaignInput> {
  const out: Partial<CampaignInput> = {};
  if (typeof b.name === "string") out.name = b.name;
  if (b.channel !== undefined) out.channel = textoONull(b.channel);
  if (b.description !== undefined) out.description = textoONull(b.description);
  if (typeof b.active === "boolean") out.active = b.active;
  if (b.startsOn !== undefined) out.startsOn = typeof b.startsOn === "string" && b.startsOn ? b.startsOn : null;
  if (b.endsOn !== undefined) out.endsOn = typeof b.endsOn === "string" && b.endsOn ? b.endsOn : null;
  if (b.serviceId !== undefined) out.serviceId = typeof b.serviceId === "string" && b.serviceId ? b.serviceId : null;
  if (Array.isArray(b.extraProfessionalIds)) out.extraProfessionalIds = b.extraProfessionalIds.filter((x): x is string => typeof x === "string");
  if (Array.isArray(b.triggers)) {
    out.triggers = b.triggers.map((t) => ({
      kind: (t as { kind?: unknown })?.kind as TriggerInput["kind"],
      value: String((t as { value?: unknown })?.value ?? ""),
    }));
  }
  for (const k of ["followUpMaxAttempts", "followUpAfterHours", "followUpIntervalHours"] as const) {
    if (b[k] !== undefined) out[k] = b[k] as number;
  }
  return out;
}

/**
 * Las campañas de la clínica con su estado a hoy y cómo les fue, más lo que el formulario necesita para
 * armarse (servicios con sus profesionales, y todos los profesionales activos).
 */
dashboardRouter.get(
  "/clinics/:clinicId/campaigns",
  requirePermission(PERMISSIONS.CAMPANAS_VER),
  async (req, res) => {
    const { clinicId } = req.params;
    const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { timezone: true, campaignFollowUpEnabled: true, plan: { select: { features: true } } } });
    if (!clinic) return res.status(404).json({ error: "Clínica no encontrada" });

    const hoy = clinicDateKey(new Date(), clinic.timezone);
    const [campanas, stats, servicios, profesionales] = await Promise.all([
      listCampaigns(clinicId),
      campaignStats({ clinicId, from: new Date(0), toExclusive: new Date(Date.now() + 86_400_000) }),
      prisma.service.findMany({
        where: { clinicId, active: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true, professionals: { where: { active: true }, select: { id: true } } },
      }),
      prisma.professional.findMany({ where: { clinicId, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    ]);

    res.json({
      // Prendido Y con el plan que lo incluye: es lo mismo que decide el job.
      seguimientoHabilitado: clinic.campaignFollowUpEnabled && planIncludes(clinic, PLAN_FEATURES.CAMPAIGN_FOLLOWUP),
      seguimientoEnPlan: planIncludes(clinic, PLAN_FEATURES.CAMPAIGN_FOLLOWUP),
      campanas: campanas.map((c) => ({
        ...c,
        startsOn: dateKeyOf(c.startsOn),
        endsOn: dateKeyOf(c.endsOn),
        estado: campaignStatus(c, hoy),
        estadisticas: stats.get(c.id) ?? { campaignId: c.id, contacts: 0, newContacts: 0, converted: 0, open: 0, closedNoReply: 0, followUpsSent: 0, appointments: 0, viaAd: 0, viaText: 0, viaAssistant: 0 },
      })),
      opciones: {
        servicios: servicios.map((s) => ({ id: s.id, name: s.name, profesionalIds: s.professionals.map((p) => p.id) })),
        profesionales,
      },
    });
  }
);

dashboardRouter.post(
  "/clinics/:clinicId/campaigns",
  requirePermission(PERMISSIONS.CAMPANAS_EDITAR),
  async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const input = campanaDelBody(b);
    // Solo nombres de campos y datos estructurados: nunca el texto de la promoción ni las frases.
    enrichAudit(res, { details: { conServicio: Boolean(input.serviceId), formatos: input.triggers?.length ?? 0 } });
    const result = await createCampaign(req.params.clinicId, { name: "", ...input });
    if (!result.ok) return res.status(estadoDeCampana(result.reason)).json({ error: result.message, motivo: result.reason });
    res.status(201).json(result.value);
  }
);

dashboardRouter.put(
  "/clinics/:clinicId/campaigns/:campaignId",
  requirePermission(PERMISSIONS.CAMPANAS_EDITAR),
  async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const input = campanaDelBody(b);
    enrichAudit(res, { details: { camposModificados: Object.keys(input) } });
    const result = await updateCampaign(req.params.clinicId, req.params.campaignId, input);
    if (!result.ok) return res.status(estadoDeCampana(result.reason)).json({ error: result.message, motivo: result.reason });
    res.json(result.value);
  }
);

/**
 * "¿Se reconocería este mensaje?": prueba un texto contra los formatos de las campañas activas, con la MISMA regla que
 * el webhook (`detectCampaign`), y dice cuál coincidió y por qué formato. No guarda nada y el texto va por query (que la
 * auditoría nunca guarda). Es lo que permite ver si una campaña está bien armada sin escribirle a la clínica por WhatsApp.
 */
dashboardRouter.get(
  "/clinics/:clinicId/campaigns/match",
  requirePermission(PERMISSIONS.CAMPANAS_VER),
  async (req, res) => {
    const texto = typeof req.query.texto === "string" ? req.query.texto.slice(0, 1000) : "";
    if (!texto.trim()) return res.status(400).json({ error: "Escribe un mensaje para probar." });
    const hit = await detectCampaign({ clinicId: req.params.clinicId, text: texto });
    res.json({
      reconocida: hit ? { id: hit.campaign.id, name: hit.campaign.name } : null,
      formato: hit ? { kind: hit.triggerKind, value: hit.trigger } : null,
    });
  }
);

/**
 * Los contactos que llegaron por campañas (con nombre y teléfono: es una lectura sensible, queda en la
 * auditoría). Declarada antes que cualquier `/campaigns/:campaignId`.
 */
dashboardRouter.get(
  "/clinics/:clinicId/campaigns/leads",
  requirePermission(PERMISSIONS.CAMPANAS_VER),
  async (req, res) => {
    const status = typeof req.query.estado === "string" ? req.query.estado : undefined;
    if (status && !["abierto", "convertido", "cerrado"].includes(status)) {
      return res.status(400).json({ error: "El estado tiene que ser abierto, convertido o cerrado." });
    }
    res.json(
      await listLeads({
        clinicId: req.params.clinicId,
        campaignId: typeof req.query.campaignId === "string" && req.query.campaignId ? req.query.campaignId : undefined,
        status: status as "abierto" | "convertido" | "cerrado" | undefined,
      })
    );
  }
);

/** Cierra el seguimiento de un contacto (la clínica ya lo resolvió por otro medio, o no corresponde insistir). */
dashboardRouter.post(
  "/clinics/:clinicId/campaigns/leads/:leadId/close",
  requirePermission(PERMISSIONS.CAMPANAS_EDITAR),
  async (req, res) => {
    const cerrado = await closeLead({
      clinicId: req.params.clinicId,
      leadId: req.params.leadId,
      reason: "cerrado_por_la_clinica",
      userId: req.user?.id ?? null,
    });
    if (!cerrado) return res.status(404).json({ error: "El contacto no existe o ya no está abierto." });
    res.json({ cerrado: true });
  }
);

// --- Chat de pruebas ---

/** Conversaciones de prueba con un turno en curso en ESTE proceso: dos mensajes a la vez de la misma persona se pisarían. */
const pruebasEnCurso = new Set<string>();

/**
 * Un mensaje del chat de pruebas: corre el turno completo del asistente y devuelve lo que habría contestado, sin
 * pasar por WhatsApp y sin avisos reales (ver `services/sandbox.ts`). Cada persona del panel tiene su propia
 * conversación. Cada mensaje llama al modelo: por eso lleva su propio permiso.
 */
dashboardRouter.post(
  "/clinics/:clinicId/test-chat",
  requirePermission(PERMISSIONS.CHAT_PRUEBAS_USAR),
  async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const clave = `${req.params.clinicId}:${req.user!.id}`;
    if (pruebasEnCurso.has(clave)) {
      return res.status(409).json({ error: "El asistente todavía está contestando el mensaje anterior." });
    }
    pruebasEnCurso.add(clave);
    try {
      res.json(
        await runSandboxTurn({
          clinicId: req.params.clinicId,
          userId: req.user!.id,
          text: typeof b.message === "string" ? b.message : "",
        })
      );
    } catch (error) {
      if (error instanceof SandboxError) {
        return res.status(error.reason === "clinica_no_encontrada" ? 404 : 400).json({ error: error.message, motivo: error.reason });
      }
      console.error(`Falló el chat de pruebas (clínica ${req.params.clinicId}):`, error);
      res.status(500).json({ error: "No se pudo obtener la respuesta del asistente. Mira el detalle en Monitoreo." });
    } finally {
      pruebasEnCurso.delete(clave);
    }
  }
);

/** Lo hablado, las citas de prueba y la campaña de esta conversación de prueba. */
dashboardRouter.get(
  "/clinics/:clinicId/test-chat",
  requirePermission(PERMISSIONS.CHAT_PRUEBAS_USAR),
  async (req, res) => {
    try {
      res.json(await getSandboxConversation(req.params.clinicId, req.user!.id));
    } catch (error) {
      if (error instanceof SandboxError) return res.status(404).json({ error: error.message, motivo: error.reason });
      console.error(`No se pudo leer el chat de pruebas (clínica ${req.params.clinicId}):`, error);
      res.status(500).json({ error: "No se pudo leer la conversación de prueba." });
    }
  }
);

/** Reiniciar: borra la ficha de prueba, lo hablado, las citas y el contacto de campaña de esta conversación. */
dashboardRouter.delete(
  "/clinics/:clinicId/test-chat",
  requirePermission(PERMISSIONS.CHAT_PRUEBAS_USAR),
  async (req, res) => {
    try {
      const borrado = await resetSandbox(req.params.clinicId, req.user!.id);
      enrichAudit(res, { details: { pacientes: borrado.patients, citas: borrado.appointments } });
      res.json({ reiniciado: true, ...borrado });
    } catch (error) {
      console.error(`No se pudo reiniciar el chat de pruebas (clínica ${req.params.clinicId}):`, error);
      res.status(500).json({ error: "No se pudo reiniciar la conversación de prueba." });
    }
  }
);

// --- Reportes ---

/** Los profesionales y servicios de la clínica, para los filtros de los reportes (incluye los inactivos: lo histórico los usa). */
dashboardRouter.get(
  "/clinics/:clinicId/reports/options",
  requirePermission(PERMISSIONS.REPORTES_VER),
  async (req, res) => {
    const { clinicId } = req.params;
    const [profesionales, servicios] = await Promise.all([
      prisma.professional.findMany({ where: { clinicId }, select: { id: true, name: true } }),
      prisma.service.findMany({ where: { clinicId }, select: { id: true, name: true } }),
    ]);
    // Ordenados acá y no en la base: el orden de Postgres depende de la colación del servidor
    // y con acentos ("Láser" después de "Limpieza") sale mal.
    const porNombre = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "es");
    res.json({ profesionales: profesionales.sort(porNombre), servicios: servicios.sort(porNombre) });
  }
);

/**
 * Un reporte de citas: `resumen`, `cancelaciones`, `reagendadas`, `atendidos` o
 * `sin-confirmar`. Filtros: `desde` y `hasta` (YYYY-MM-DD, el día de la clínica; por defecto los
 * últimos 30 días), `base` (`evento`: cuándo pasó; `cita`: de qué día era la cita),
 * `professionalId` y `serviceId`. Con `?formato=csv` se descarga el detalle.
 *
 * Ver y exportar quedan en la auditoría: el detalle muestra nombres de pacientes.
 */
dashboardRouter.get(
  "/clinics/:clinicId/reports/:report",
  requirePermission(PERMISSIONS.REPORTES_VER),
  async (req, res) => {
    const kind = req.params.report as ReportKind;
    if (!REPORT_KINDS.includes(kind)) {
      return res.status(404).json({ error: `No existe el reporte "${req.params.report}".` });
    }
    const clinic = await prisma.clinic.findUnique({
      where: { id: req.params.clinicId },
      select: { id: true, timezone: true },
    });
    if (!clinic) return res.status(404).json({ error: "Clínica no encontrada" });

    const parsed = parseReportFilters(req.query, clinic);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });

    const csv = req.query.formato === "csv";
    // Solo parámetros de la consulta: nada de lo que muestra el reporte.
    enrichAudit(res, {
      action: csv ? "report.export" : "report.view",
      details: {
        reporte: kind,
        formato: csv ? "csv" : "pantalla",
        desde: parsed.filters.fromKey,
        hasta: parsed.filters.toKey,
        base: parsed.filters.base,
        ...(parsed.filters.professionalId ? { filtraPorProfesional: true } : {}),
        ...(parsed.filters.serviceId ? { filtraPorServicio: true } : {}),
      },
    });

    const result = await buildReport({ kind, clinic, filters: parsed.filters });
    if (csv) {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="reporte-${kind}-${parsed.filters.fromKey}-${parsed.filters.toKey}.csv"`
      );
      return res.send(reportToCsv(result));
    }
    res.json(forScreen(result));
  }
);
