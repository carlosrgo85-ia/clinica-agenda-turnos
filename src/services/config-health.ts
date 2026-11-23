import { prisma } from "../db/client";
import { suggestCountryFromTimezone } from "../data/holidays";
import { isSupportedCountry, supportedCountries } from "../repositories/countries.repository";
import { pendingHolidaysByYear } from "./holidays";

/**
 * Qué le falta configurar a una clínica.
 *
 * Es la fuente única de los avisos: la usa `jobs/config-alerts.ts` para
 * mandar el mail y el WhatsApp, y la expone el dashboard en
 * `GET /dashboard/clinics/:id/config-health` para que el frontend pinte un
 * banner. Un solo lugar para que los tres canales no se contradigan.
 */

export type ConfigIssueCode =
  | "sin_horario_de_atencion"
  | "feriados_sin_cargar"
  | "sin_pais_configurado"
  | "sin_calendario_enlazado"
  | "calendario_revocado"
  | "sin_destinatario_de_urgencias"
  | "profesional_sin_servicios"
  | "servicio_sin_profesional"
  | "sin_aviso_de_privacidad";

export interface ConfigIssue {
  code: ConfigIssueCode;
  /**
   * `bloqueante` = el asistente está tomando turnos que no debería.
   * `advertencia` = funciona, pero hay algo por resolver.
   */
  severidad: "bloqueante" | "advertencia";
  mensaje: string;
  /** Qué hay que hacer, en una línea. */
  accion: string;
  /**
   * Datos extra para que la interfaz pueda ofrecer la acción concreta —
   * por ejemplo, qué años tienen feriados pendientes para poner un botón
   * por año.
   */
  datos?: Record<string, unknown>;
}

export interface ConfigHealth {
  clinicId: string;
  clinicName: string;
  ok: boolean;
  issues: ConfigIssue[];
  /** País actual de la clínica, para poder ofrecer siempre la opción de cambiarlo. */
  country: string | null;
  paisesSoportados: Array<{ id: string; name: string }>;
}

export async function getConfigHealth(
  clinicId: string,
  now = new Date()
): Promise<ConfigHealth | null> {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: {
      id: true,
      name: true,
      country: true,
      timezone: true,
      email: true,
      urgencyNotifyEmail: true,
      privacyNoticeUrl: true,
      sharedCalendarId: true,
      _count: { select: { workingHours: true } },
      professionals: {
        where: { active: true },
        select: { googleCalendarId: true },
      },
      workingHours: {
        where: { professionalId: null },
        select: { id: true },
        take: 1,
      },
    },
  });
  if (!clinic) return null;

  const issues: ConfigIssue[] = [];

  // 1. Sin horario de atención: bloqueante. Sin esto la clínica NO puede
  // agendar: services/booking.ts rechaza con `clinica_sin_horario` y no se le
  // ofrece ningún horario al paciente.
  if (clinic.workingHours.length === 0) {
    issues.push({
      code: "sin_horario_de_atencion",
      severidad: "bloqueante",
      mensaje:
        "No hay horario de atención cargado, así que el asistente no puede agendar ni ofrecer horarios: los pacientes que pidan una cita no van a poder sacarla.",
      accion: "Cargar el horario de la clínica por día de la semana.",
    });
  }

  // 1.b Sin a dónde avisar las urgencias. Es bloqueante: cuando el asistente
  // escala, le PROMETE al paciente que alguien lo va a contactar. Si no hay
  // destinatario, esa promesa no la cumple nadie.
  if (!clinic.urgencyNotifyEmail && !clinic.email) {
    issues.push({
      code: "sin_destinatario_de_urgencias",
      severidad: "bloqueante",
      mensaje:
        "No hay a dónde avisar cuando el asistente deriva una urgencia. El asistente le dice al paciente que alguien de la clínica lo va a contactar, y ese aviso no le llega a nadie.",
      accion: "Cargar el mail al que avisar las urgencias.",
    });
  }

  // 1.c Sin el link del aviso de privacidad de la clínica. Es una advertencia: el asistente funciona, pero no puede mandar el aviso. La responsable de los datos es la clínica.
  if (!clinic.privacyNoticeUrl?.trim()) {
    issues.push({
      code: "sin_aviso_de_privacidad",
      severidad: "advertencia",
      mensaje:
        "No está cargado el link del aviso de privacidad de la clínica, así que el asistente no puede mandárselo al paciente. La clínica es la responsable de los datos de sus pacientes.",
      accion: "Pedir a la plataforma que cargue el link del aviso de privacidad de la clínica.",
    });
  }

  // 2. Feriados sin cargar. Desde diciembre se cuenta también el año que
  // viene, para que el calendario esté confirmado antes del 1 de enero.
  if (clinic.country && (await isSupportedCountry(clinic.country))) {
    const porAnio = await pendingHolidaysByYear({ clinicId: clinic.id, now });

    if (porAnio.length > 0) {
      const total = porAnio.reduce((suma, a) => suma + a.pendientes, 0);
      const detalle = porAnio.map((a) => `${a.pendientes} de ${a.year}`).join(" y ");

      issues.push({
        code: "feriados_sin_cargar",
        severidad: "advertencia",
        mensaje: `Hay ${total} feriado(s) nacional(es) sin cargar (${detalle}). Esos días el asistente va a ofrecer citas.`,
        accion: "Revisar el calendario de feriados y confirmar los que no se atiende.",
        datos: { pendientesPorAnio: porAnio },
      });
    }
  } else if (!clinic.country) {
    // Sin país no se pueden sugerir feriados.
    issues.push({
      code: "sin_pais_configurado",
      severidad: "advertencia",
      mensaje:
        "La clínica no tiene país configurado, así que no se le pueden sugerir los feriados nacionales.",
      accion: "Configurar el país de la clínica.",
      // Para que la interfaz pueda ofrecer el selector ya armado, con el
      // valor propuesto según la zona horaria de la clínica.
      datos: {
        paisesSoportados: await supportedCountries(),
        sugerido: suggestCountryFromTimezone(clinic.timezone),
      },
    });
  }

  // 3. Ningún calendario de Google enlazado. No impide agendar — el turno
  // vive en Postgres igual — pero los profesionales no ven los turnos en su
  // agenda, que es la mitad del valor del producto.
  const algunCalendario =
    Boolean(clinic.sharedCalendarId) ||
    clinic.professionals.some((p) => Boolean(p.googleCalendarId));
  if (!algunCalendario) {
    issues.push({
      code: "sin_calendario_enlazado",
      severidad: "advertencia",
      mensaje:
        "No hay ningún calendario de Google enlazado. Las citas se agendan igual, pero no aparecen en la agenda de los profesionales.",
      accion: "Conectar la cuenta de Google de la clínica y elegir el calendario.",
    });
  }

  // 4. Una cuenta de calendario en uso con el acceso revocado. Es bloqueante:
  // sin ella no se importan los bloqueos de la agenda personal, y el asistente
  // ofrece horarios encima de otros compromisos. Es el mismo dato que dispara
  // el mail de jobs/calendar-access-alerts.ts.
  const enUso = {
    revokedAt: { not: null },
    OR: [{ sharedForClinics: { some: {} } }, { professionals: { some: { active: true } } }],
  };
  const [googleRevocadas, microsoftRevocadas] = await Promise.all([
    prisma.googleAccount.findMany({ where: { clinicId, ...enUso }, select: { email: true } }),
    prisma.microsoftAccount.findMany({ where: { clinicId, ...enUso }, select: { email: true } }),
  ]);
  const revocadas = [
    ...googleRevocadas.map((a) => `${a.email} (Google)`),
    ...microsoftRevocadas.map((a) => `${a.email} (Microsoft)`),
  ];
  if (revocadas.length > 0) {
    issues.push({
      code: "calendario_revocado",
      severidad: "bloqueante",
      mensaje: `El acceso al calendario fue revocado (${revocadas.join(", ")}). Hasta que se reconecte, el asistente no ve los horarios ocupados y puede ofrecer uno encima de otro compromiso.`,
      accion: "Reconectar la cuenta desde Calendarios.",
      datos: { cuentas: revocadas },
    });
  }

  // 5. Quién hace qué. Solo aplica con catálogo de servicios: sin él no hay
  // nada que asignar (y el agente tampoco restringe). Un profesional sin
  // servicios "no hace nada" y no se le asigna ningún turno; un servicio que
  // nadie realiza no se puede agendar y el agente deriva a una persona.
  const [profesionalesSinServicios, serviciosSinProfesional] = await Promise.all([
    prisma.service.count({ where: { clinicId, active: true } }).then((n) =>
      n === 0
        ? []
        : prisma.professional.findMany({
            where: { clinicId, active: true, services: { none: {} } },
            select: { name: true },
          })
    ),
    prisma.service.findMany({
      where: { clinicId, active: true, professionals: { none: { active: true } } },
      select: { name: true },
    }),
  ]);
  if (profesionalesSinServicios.length > 0) {
    issues.push({
      code: "profesional_sin_servicios",
      severidad: "advertencia",
      mensaje: `Estos profesionales no tienen ningún servicio asignado, así que el asistente no les agenda nada: ${profesionalesSinServicios
        .map((p) => p.name)
        .join(", ")}.`,
      accion: "Asignarles los servicios que realizan, desde Recursos.",
      datos: { profesionales: profesionalesSinServicios.map((p) => p.name) },
    });
  }
  if (serviciosSinProfesional.length > 0) {
    issues.push({
      code: "servicio_sin_profesional",
      severidad: "advertencia",
      mensaje: `Estos servicios no tienen ningún profesional que los realice, así que no se pueden agendar y el asistente deriva a una persona: ${serviciosSinProfesional
        .map((s) => s.name)
        .join(", ")}.`,
      accion: "Asignar los profesionales que lo realizan, desde Servicios.",
      datos: { servicios: serviciosSinProfesional.map((s) => s.name) },
    });
  }

  return {
    clinicId: clinic.id,
    clinicName: clinic.name,
    ok: issues.length === 0,
    issues,
    country: clinic.country,
    paisesSoportados: await supportedCountries(),
  };
}
