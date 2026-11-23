import type { Patient } from "@prisma/client";
import { prisma } from "../db/client";
import { CLINIC_CALENDAR_INCLUDE } from "./calendar";
import { recordCampaignContact } from "./campaigns";
import { defaultAgentTurnDeps, runAgentTurn, type AgentTurnDeps, type SandboxCollector } from "./agent-turn";
import { isSandboxPhone, SANDBOX_PATIENT_FILTER, SANDBOX_PHONE_PREFIX, sandboxPhoneFor } from "./sandbox-phone";
import { clinicDateKey, formatWallTime } from "./time";
import type { ClaudeAgentResponse } from "../types";

/**
 * El chat de pruebas: hablar con el asistente desde el panel, sin pasar por WhatsApp.
 *
 * Corre el **mismo turno** que un mensaje real (`runAgentTurn`): el mismo prompt, las mismas reglas de agenda y la
 * misma conversación guardada. Lo que cambia es lo que NO sale hacia afuera:
 *
 * - **Nada va por WhatsApp**: lo que el asistente contesta se captura y se devuelve al panel.
 * - **Ningún aviso real**: no se le avisa al profesional (mail ni WhatsApp), no se espeja en su Google Calendar
 *   (`skipExternalEffects` de `booking.ts`), y una derivación a una persona no se guarda ni se manda por mail: queda
 *   como una nota en el chat (`SandboxCollector`).
 * - **La cita SÍ se crea** (con todas sus reglas: horario, espacio, equipo, profesionales), a nombre de un paciente de
 *   prueba, para poder probar el recorrido completo (agendar, cambiar, cancelar). Ocupa la agenda hasta que se
 *   reinicie la conversación.
 *
 * **No hay atajos**: el mensaje entra por el mismo camino que uno de WhatsApp. Si una campaña se reconoce es porque el texto trae
 * una de sus frases, igual que en producción; no se puede "simular" que alguien llegó por una campaña.
 *
 * **Todo lo de una prueba cuelga de un teléfono reservado** (`prueba:<usuario>`), uno por usuario del panel, así que
 * se borra de una vez: con "Reiniciar" y, si alguien se olvida, solo (`jobs/sandbox-cleanup.ts`, a las 2 horas sin
 * actividad). Los jobs que le escribirían a un paciente (recordatorios, seguimientos) y las estadísticas de campañas
 * **ignoran** esos teléfonos.
 *
 * Lo que sí es real: cada mensaje llama al modelo (cuesta tokens y queda en las solicitudes de Monitoreo) y la auditoría
 * registra los cambios de la ficha de prueba.
 */

export { SANDBOX_PATIENT_FILTER, SANDBOX_PHONE_PREFIX, isSandboxPhone, sandboxPhoneFor };
/** Horas sin actividad después de las cuales una conversación de prueba se borra sola. */
export const SANDBOX_IDLE_HOURS = 2;
export const SANDBOX_MAX_MESSAGE_LENGTH = 1000;

export class SandboxError extends Error {
  constructor(
    public readonly reason: "clinica_no_encontrada" | "mensaje_vacio" | "mensaje_demasiado_largo",
    message: string
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

/** Lo que el panel muestra de lo que entendió el asistente (sin el texto de la respuesta, que ya está en el chat). */
export interface DecisionResumen {
  intent: string;
  servicio: string | null;
  fecha: string | null;
  hora: string | null;
  profesional: string | null;
  pacienteDelTurno: string | null;
  pideHorarios: boolean;
  confirmo: boolean;
  derivar: boolean;
  motivoDerivar: string | null;
  pidioUbicacion: boolean;
  turnoAModificar: string | null;
  motivoCancelacion: string | null;
  esQueja: boolean;
  /** La promoción vigente que el asistente reconoció en lo que dijo la persona (sin que coincidiera un formato). */
  campanaMencionada: string | null;
}

export function summarizeDecision(r: ClaudeAgentResponse): DecisionResumen {
  return {
    intent: r.intent,
    servicio: r.servicio,
    fecha: r.fecha_solicitada,
    hora: r.hora_solicitada,
    profesional: r.profesional_solicitado ?? null,
    pacienteDelTurno: r.paciente_del_turno,
    pideHorarios: r.requiere_horarios_disponibles,
    confirmo: r.confirmacion_explicita,
    derivar: r.escalar_a_humano,
    motivoDerivar: r.motivo_escalar,
    pidioUbicacion: r.pidio_ubicacion,
    turnoAModificar: r.turno_a_modificar,
    motivoCancelacion: r.motivo_cancelacion ?? null,
    esQueja: r.motivo_es_queja ?? false,
    campanaMencionada: r.campana_mencionada ?? null,
  };
}

export interface SandboxAppointment {
  id: string;
  /** Nombre de la persona del turno (null si todavía no se presentó). Es de una ficha de PRUEBA, no de un paciente real. */
  patient: string | null;
  service: string;
  professional: string;
  room: string;
  /** Fecha y hora locales de la clínica, ya formateadas. */
  cuando: string;
  status: string;
}

export interface SandboxTurnResult {
  /** Lo que el asistente le habría mandado por WhatsApp, en orden. */
  respuestas: string[];
  /** Lo que el turno hizo (o habría hecho) hacia afuera: cita creada, derivación a una persona. */
  notas: string[];
  /** Qué entendió el asistente en cada llamada al modelo del turno. */
  decisiones: DecisionResumen[];
  citas: SandboxAppointment[];
}

/** El paciente de prueba de este usuario en esta clínica (se crea la primera vez, sin pasar por la auditoría de altas reales). */
async function getOrCreateSandboxPatient(clinicId: string, phone: string): Promise<Patient> {
  const existente = await prisma.patient.findFirst({ where: { clinicId, phone }, orderBy: { createdAt: "asc" } });
  if (existente) return existente;
  return prisma.patient.create({ data: { clinicId, phone } });
}

async function listSandboxAppointments(clinicId: string, phone: string, timezone: string): Promise<SandboxAppointment[]> {
  const citas = await prisma.appointment.findMany({
    where: { clinicId, patient: { phone } },
    orderBy: { startTime: "asc" },
    include: {
      professional: { select: { name: true } },
      room: { select: { name: true } },
      patient: { select: { name: true } },
    },
  });
  return citas.map((c) => ({
    id: c.id,
    patient: c.patient.name,
    service: c.service,
    professional: c.professional.name,
    room: c.room.name,
    cuando: `${clinicDateKey(c.startTime, timezone)} ${formatWallTime(c.startTime, timezone)}`,
    status: c.status,
  }));
}

/**
 * Un mensaje del chat de pruebas: corre el turno completo del asistente y devuelve lo que habría contestado.
 * `deps` permite reemplazar piezas en los tests (el modelo, sobre todo).
 */
export async function runSandboxTurn(params: {
  clinicId: string;
  userId: string;
  text: string;
  deps?: Partial<AgentTurnDeps>;
}): Promise<SandboxTurnResult> {
  const text = params.text.trim();
  if (!text) throw new SandboxError("mensaje_vacio", "Escribe un mensaje.");
  if (text.length > SANDBOX_MAX_MESSAGE_LENGTH) {
    throw new SandboxError("mensaje_demasiado_largo", `El mensaje puede tener hasta ${SANDBOX_MAX_MESSAGE_LENGTH} caracteres.`);
  }

  const clinic = await prisma.clinic.findFirst({
    where: { id: params.clinicId },
    include: { ...CLINIC_CALENDAR_INCLUDE, plan: true },
  });
  if (!clinic) throw new SandboxError("clinica_no_encontrada", "Clínica no encontrada.");

  const phone = sandboxPhoneFor(params.userId);
  const patient = await getOrCreateSandboxPatient(clinic.id, phone);
  // Igual que el webhook y SIN atajos: si el mensaje trae la frase de una campaña, se atribuye; si no, no. El chat no sabe
  // de antemano qué va a pedir quien escribe, como un mensaje de la calle.
  await recordCampaignContact({ clinicId: clinic.id, phone, text });

  const base: AgentTurnDeps = { ...defaultAgentTurnDeps, ...params.deps };
  const respuestas: string[] = [];
  const decisiones: ClaudeAgentResponse[] = [];
  const collector: SandboxCollector = { notas: [] };

  const deps: AgentTurnDeps = {
    ...base,
    // Nada sale por WhatsApp: se captura.
    send: (async (_creds: unknown, _to: string, body: string) => {
      respuestas.push(body);
    }) as AgentTurnDeps["send"],
    interpret: (async (p: Parameters<AgentTurnDeps["interpret"]>[0]) => {
      const r = await base.interpret(p);
      decisiones.push(r);
      return r;
    }) as AgentTurnDeps["interpret"],
    // La cita se crea con todas sus reglas, pero sin avisos ni espejo.
    book: (async (p: Parameters<AgentTurnDeps["book"]>[0]) => {
      const r = await base.book({ ...p, skipExternalEffects: true });
      if (r.ok) {
        const a = r.appointment;
        collector.notas.push(
          `Se creó una cita en la agenda de pruebas: ${a.service}, ${clinicDateKey(a.startTime, clinic.timezone)} ${formatWallTime(a.startTime, clinic.timezone)} con ${r.professionalName}.` +
            " En producción también se le avisaría al profesional y se reflejaría en su calendario."
        );
      }
      return r;
    }) as AgentTurnDeps["book"],
    // El respaldo del reintento es de la cola real de WhatsApp: acá no hay cola.
    respaldo: undefined,
    sandbox: collector,
  };

  await runAgentTurn({ clinic, patient, from: phone, text }, deps);

  return {
    respuestas,
    notas: collector.notas,
    decisiones: decisiones.map(summarizeDecision),
    citas: await listSandboxAppointments(clinic.id, phone, clinic.timezone),
  };
}

export interface SandboxConversation {
  mensajes: Array<{ role: "patient" | "assistant"; content: string; at: string }>;
  citas: SandboxAppointment[];
  /** La campaña por la que "llegó" la persona de prueba, si la hay. */
  campana: { id: string; name: string } | null;
}

/** La conversación de prueba de este usuario: lo que se habló, las citas que quedaron y su campaña. */
export async function getSandboxConversation(clinicId: string, userId: string): Promise<SandboxConversation> {
  const phone = sandboxPhoneFor(userId);
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { timezone: true } });
  if (!clinic) throw new SandboxError("clinica_no_encontrada", "Clínica no encontrada.");

  const [mensajes, citas, lead] = await Promise.all([
    prisma.conversationMessage.findMany({ where: { clinicId, patientPhone: phone }, orderBy: { createdAt: "asc" }, take: 200 }),
    listSandboxAppointments(clinicId, phone, clinic.timezone),
    prisma.campaignLead.findFirst({
      where: { clinicId, patientPhone: phone },
      orderBy: { firstMessageAt: "desc" },
      include: { campaign: { select: { id: true, name: true } } },
    }),
  ]);
  return {
    mensajes: mensajes.map((m) => ({ role: m.role === "patient" ? "patient" : "assistant", content: m.content, at: m.createdAt.toISOString() })),
    citas,
    campana: lead ? lead.campaign : null,
  };
}

/**
 * Borra TODO lo de una conversación de prueba: la ficha, lo hablado, las citas (con sus eventos) y el contacto de campaña.
 * Solo toca el teléfono reservado que se le pasa: nunca un paciente real.
 */
export async function purgeSandboxPhone(clinicId: string, phone: string): Promise<{ patients: number; appointments: number }> {
  if (!isSandboxPhone(phone)) throw new Error("purgeSandboxPhone solo borra teléfonos de prueba.");
  const pacientes = await prisma.patient.findMany({ where: { clinicId, phone }, select: { id: true } });
  const ids = pacientes.map((p) => p.id);

  return prisma.$transaction(async (tx) => {
    const { count: appointments } = await tx.appointment.deleteMany({ where: { clinicId, patientId: { in: ids } } });
    await tx.campaignLead.deleteMany({ where: { clinicId, patientPhone: phone } });
    await tx.conversationMessage.deleteMany({ where: { clinicId, patientPhone: phone } });
    await tx.pendingInboundMessage.deleteMany({ where: { clinicId, patientPhone: phone } });
    await tx.escalation.deleteMany({ where: { clinicId, patientPhone: phone } });
    await tx.patientComment.deleteMany({ where: { clinicId, patientId: { in: ids } } });
    await tx.package.deleteMany({ where: { clinicId, patientId: { in: ids } } });
    const { count: patients } = await tx.patient.deleteMany({ where: { clinicId, id: { in: ids } } });
    return { patients, appointments };
  });
}

export async function resetSandbox(clinicId: string, userId: string) {
  return purgeSandboxPhone(clinicId, sandboxPhoneFor(userId));
}

/**
 * Borra las conversaciones de prueba que llevan `idleHours` sin actividad, para que una prueba olvidada no le deje citas ni
 * contactos de mentira a la clínica. La actividad es el último mensaje (o la creación de la ficha, si no hubo).
 * Devuelve cuántas conversaciones borró.
 */
export async function purgeIdleSandbox(
  now = new Date(),
  idleHours = SANDBOX_IDLE_HOURS,
  /** Limita el borrado a esas clínicas (los tests lo usan para no tocar las conversaciones de prueba de nadie más). */
  options?: { clinicIds?: string[] }
): Promise<number> {
  const corte = new Date(now.getTime() - idleHours * 3_600_000);
  const pacientes = await prisma.patient.findMany({
    where: { ...SANDBOX_PATIENT_FILTER, ...(options?.clinicIds ? { clinicId: { in: options.clinicIds } } : {}) },
    select: { clinicId: true, phone: true, createdAt: true },
  });

  const conversaciones = new Map<string, { clinicId: string; phone: string; ultima: Date }>();
  for (const p of pacientes) {
    const k = `${p.clinicId}|${p.phone}`;
    const previa = conversaciones.get(k);
    if (!previa || p.createdAt > previa.ultima) conversaciones.set(k, { clinicId: p.clinicId, phone: p.phone, ultima: p.createdAt });
  }
  let borradas = 0;
  for (const c of conversaciones.values()) {
    const ultimoMensaje = await prisma.conversationMessage.findFirst({
      where: { clinicId: c.clinicId, patientPhone: c.phone },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    const ultima = ultimoMensaje && ultimoMensaje.createdAt > c.ultima ? ultimoMensaje.createdAt : c.ultima;
    if (ultima <= corte) {
      await purgeSandboxPhone(c.clinicId, c.phone);
      borradas += 1;
    }
  }
  return borradas;
}
