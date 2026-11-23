import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clinic, Weekday } from "@prisma/client";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import type { ClaudeAgentResponse } from "../src/types";

// Todo lo que sale hacia afuera se simula, para poder comprobar que el chat de pruebas NO lo usa.
const externo = vi.hoisted(() => ({
  sendText: vi.fn(),
  sendTemplate: vi.fn(),
  notificarProfesional: vi.fn(),
  espejo: vi.fn(),
  mailDerivacion: vi.fn(),
}));
vi.mock("../src/services/whatsapp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/whatsapp")>()),
  sendTextMessage: (...a: unknown[]) => externo.sendText(...a),
  sendTemplateMessage: (...a: unknown[]) => externo.sendTemplate(...a),
}));
vi.mock("../src/services/professional-notifications", () => ({
  notifyProfessionalOfAppointment: (...a: unknown[]) => externo.notificarProfesional(...a),
}));
vi.mock("../src/services/calendar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar")>()),
  mirrorAppointmentToCalendar: (...a: unknown[]) => externo.espejo(...a),
}));
vi.mock("../src/services/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/email")>()),
  sendEscalationAlert: (...a: unknown[]) => externo.mailDerivacion(...a),
}));

import { runCampaignFollowUp } from "../src/jobs/campaign-followup";
import { sendRemindersForWindow } from "../src/jobs/daily-reminders";
import { runPostVisitFollowUp } from "../src/jobs/post-visit-followup";
import { createAppointmentFromRequest } from "../src/services/booking";
import { SIN_CAMPANA } from "../src/prompts/campaign-context";
import { campaignStats, createCampaign, listLeads } from "../src/services/campaigns";
import { findPatientsDueForOutreach } from "../src/services/next-visit";
import {
  getSandboxConversation,
  isSandboxPhone,
  purgeIdleSandbox,
  purgeSandboxPhone,
  resetSandbox,
  runSandboxTurn,
  SandboxError,
  sandboxPhoneFor,
  SANDBOX_MAX_MESSAGE_LENGTH,
  summarizeDecision,
} from "../src/services/sandbox";
import { purgeAuditForClinics } from "./helpers/audit";

/**
 * El chat de pruebas. Lo que más importa es lo que NO hace: no manda nada por WhatsApp, no le avisa a ningún
 * profesional, no escribe en ningún calendario y no deja derivaciones ni citas de mentira dando vueltas.
 * Contra el Postgres local: docker compose up -d db
 */

const LUNES = "2030-06-17";
const DIAS: Weekday[] = ["lunes", "martes", "miercoles", "jueves", "viernes"];
const clinicIds: string[] = [];
let n = 0;

async function crearClinica() {
  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica pruebas ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `sb-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "test@example.com",
      timezone: "UTC",
      services: "x",
      // Con calendario enlazado y avisos prendidos: sin el aislamiento, el espejo y el aviso saldrían.
      professionals: { create: [{ name: "Gómez", googleCalendarId: "gomez@cal", contactEmail: "g@x.test", notifyByEmail: true }] },
      rooms: { create: [{ name: "Sala 1" }] },
      workingHours: { create: DIAS.map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 18 * 60 })) },
    },
    include: { professionals: true, rooms: true },
  });
  clinicIds.push(clinic.id);
  const servicio = await prisma.service.create({
    data: { clinicId: clinic.id, name: "Limpieza", durationMinutes: 30, professionals: { connect: [{ id: clinic.professionals[0].id }] } },
  });
  return { clinic, gomez: clinic.professionals[0], sala: clinic.rooms[0], servicio };
}
type F = Awaited<ReturnType<typeof crearClinica>>;

function respuesta(over: Partial<ClaudeAgentResponse> = {}): ClaudeAgentResponse {
  return {
    intent: "otro", servicio: null, fecha_solicitada: null, hora_solicitada: null, nombre_paciente: null, paciente_del_turno: null,
    turno_a_modificar: null, requiere_horarios_disponibles: false, confirmacion_explicita: false, pidio_ubicacion: false,
    escalar_a_humano: false, motivo_escalar: null, motivo_cancelacion: null, motivo_es_queja: false, turno_cancelado: null,
    respuesta_al_paciente: "Hola, ¿en qué te ayudo?", ...over,
  } as ClaudeAgentResponse;
}

/** Un modelo falso que devuelve las respuestas en orden y registra con qué se lo llamó. */
function modelo(respuestas: ClaudeAgentResponse[]) {
  const llamadas: Array<{ campana: string; patientMessage: string }> = [];
  const interpret = (async (p: { campana: string; patientMessage: string }) => {
    llamadas.push({ campana: p.campana, patientMessage: p.patientMessage });
    return respuestas[Math.min(llamadas.length - 1, respuestas.length - 1)];
  }) as never;
  return { llamadas, deps: { interpret, retryDelayMs: 0 } };
}

// El asistente no agenda sin nombre y apellido: la persona los da en el mismo mensaje en que confirma.
const reservar = [
  respuesta({ intent: "agendar", servicio: "limpieza", fecha_solicitada: LUNES, hora_solicitada: "10:00", requiere_horarios_disponibles: true }),
  respuesta({ intent: "confirmar", servicio: "limpieza", fecha_solicitada: LUNES, hora_solicitada: "10:00", confirmacion_explicita: true, nombre_paciente: "Ana", apellido_paciente: "Pérez", respuesta_al_paciente: "Listo, quedó agendado." }),
];

beforeEach(() => {
  for (const f of Object.values(externo)) f.mockReset();
  externo.espejo.mockResolvedValue("evento-externo-1");
  externo.sendText.mockResolvedValue(undefined);
});

afterEach(async () => {
  await purgeAuditForClinics(clinicIds);
  for (const clinicId of clinicIds) {
    await prisma.systemEvent.deleteMany({ where: { clinicId } });
    await prisma.agentRequest.deleteMany({ where: { clinicId } });
    await prisma.campaignLead.deleteMany({ where: { clinicId } });
    await prisma.campaign.deleteMany({ where: { clinicId } });
    await prisma.escalation.deleteMany({ where: { clinicId } });
    await prisma.conversationMessage.deleteMany({ where: { clinicId } });
    await prisma.appointment.deleteMany({ where: { clinicId } });
    await prisma.patient.deleteMany({ where: { clinicId } });
    await prisma.service.deleteMany({ where: { clinicId } });
    await prisma.room.deleteMany({ where: { clinicId } });
    await prisma.workingHours.deleteMany({ where: { clinicId } });
    await prisma.professional.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
});

describe("un mensaje del chat de pruebas", () => {
  it("devuelve lo que el asistente habría contestado, y no manda NADA por WhatsApp", async () => {
    const f = await crearClinica();
    const m = modelo([respuesta({ respuesta_al_paciente: "Hola, te ayudo con tu turno." })]);
    const r = await runSandboxTurn({ clinicId: f.clinic.id, userId: "u1", text: "Hola", deps: m.deps });

    expect(r.respuestas).toEqual(["Hola, te ayudo con tu turno."]);
    expect(externo.sendText).not.toHaveBeenCalled();
    expect(externo.sendTemplate).not.toHaveBeenCalled();
  });

  it("usa un teléfono reservado por usuario, y la conversación queda guardada como en producción", async () => {
    const f = await crearClinica();
    const m = modelo([respuesta()]);
    await runSandboxTurn({ clinicId: f.clinic.id, userId: "u1", text: "Hola", deps: m.deps });

    const phone = sandboxPhoneFor("u1");
    expect(isSandboxPhone(phone)).toBe(true);
    expect(isSandboxPhone("5491100000000")).toBe(false);
    expect((await prisma.patient.findMany({ where: { clinicId: f.clinic.id } })).map((p) => p.phone)).toEqual([phone]);
    const msgs = await prisma.conversationMessage.findMany({ where: { clinicId: f.clinic.id, patientPhone: phone }, orderBy: { createdAt: "asc" } });
    expect(msgs.map((x) => [x.role, x.content])).toEqual([["patient", "Hola"], ["assistant", "Hola, ¿en qué te ayudo?"]]);
  });

  it("la conversación sigue entre mensajes: el asistente ve el historial", async () => {
    const f = await crearClinica();
    const historiales: string[] = [];
    const deps = {
      retryDelayMs: 0,
      interpret: (async (p: { conversationHistory: string }) => {
        historiales.push(p.conversationHistory);
        return respuesta({ respuesta_al_paciente: `Respuesta ${historiales.length}` });
      }) as never,
    };
    await runSandboxTurn({ clinicId: f.clinic.id, userId: "u1", text: "Primero", deps });
    await runSandboxTurn({ clinicId: f.clinic.id, userId: "u1", text: "Segundo", deps });
    expect(historiales[1]).toContain("Paciente: Primero");
    expect(historiales[1]).toContain("Asistente: Respuesta 1");
  });

  it("cada usuario tiene su propia conversación", async () => {
    const f = await crearClinica();
    const m = modelo([respuesta()]);
    await runSandboxTurn({ clinicId: f.clinic.id, userId: "ana", text: "Soy Ana", deps: m.deps });
    await runSandboxTurn({ clinicId: f.clinic.id, userId: "luis", text: "Soy Luis", deps: m.deps });
    expect((await getSandboxConversation(f.clinic.id, "ana")).mensajes.map((x) => x.content)).toContain("Soy Ana");
    expect((await getSandboxConversation(f.clinic.id, "ana")).mensajes.map((x) => x.content)).not.toContain("Soy Luis");
  });

  it("devuelve qué entendió el asistente, sin el texto de la respuesta", async () => {
    const f = await crearClinica();
    const m = modelo([respuesta({ intent: "consultar_horarios", servicio: "limpieza", fecha_solicitada: LUNES, profesional_solicitado: "Gómez" })]);
    const r = await runSandboxTurn({ clinicId: f.clinic.id, userId: "u1", text: "¿Hay turno el lunes?", deps: m.deps });
    expect(r.decisiones[0]).toMatchObject({ intent: "consultar_horarios", servicio: "limpieza", fecha: LUNES, profesional: "Gómez", derivar: false });
    expect(JSON.stringify(r.decisiones)).not.toContain("Hola, ¿en qué te ayudo?");
    expect(summarizeDecision(respuesta({ escalar_a_humano: true, motivo_escalar: "urgencia" }))).toMatchObject({ derivar: true, motivoDerivar: "urgencia" });
  });

  it("rechaza lo inválido", async () => {
    const f = await crearClinica();
    const base = { clinicId: f.clinic.id, userId: "u1", deps: modelo([respuesta()]).deps };
    await expect(runSandboxTurn({ ...base, text: "   " })).rejects.toMatchObject({ reason: "mensaje_vacio" });
    await expect(runSandboxTurn({ ...base, text: "x".repeat(SANDBOX_MAX_MESSAGE_LENGTH + 1) })).rejects.toMatchObject({ reason: "mensaje_demasiado_largo" });
    await expect(runSandboxTurn({ ...base, clinicId: "no-existe", text: "hola" })).rejects.toMatchObject({ reason: "clinica_no_encontrada" });
    await expect(runSandboxTurn({ ...base, text: "hola", clinicId: "no-existe" })).rejects.toBeInstanceOf(SandboxError);
    expect(await prisma.patient.count({ where: { clinicId: f.clinic.id } })).toBeLessThanOrEqual(1);
  });
});

describe("agendar en el chat de pruebas: la cita se crea, pero nada sale a la calle", () => {
  it("crea la cita con todas sus reglas, sin avisarle al profesional ni escribir en su calendario", async () => {
    const f = await crearClinica();
    const m = modelo(reservar);
    const r = await runSandboxTurn({ clinicId: f.clinic.id, userId: "u1", text: "El lunes a las 10", deps: m.deps });

    expect(r.respuestas).toEqual(["Listo, quedó agendado."]);
    expect(r.citas).toHaveLength(1);
    expect(r.citas[0]).toMatchObject({ service: "Limpieza", professional: "Gómez", room: "Sala 1", cuando: `${LUNES} 10:00`, status: "confirmado" });
    expect(r.citas[0].patient).toBe("Ana Pérez"); // el nombre que dio en ese turno
    expect(r.notas.join(" ")).toMatch(/Se creó una cita en la agenda de pruebas/);

    const cita = await prisma.appointment.findFirstOrThrow({ where: { clinicId: f.clinic.id }, include: { patient: true } });
    expect(cita.patient.phone).toBe(sandboxPhoneFor("u1"));
    expect(cita.googleEventId).toBeNull();
    expect(externo.notificarProfesional).not.toHaveBeenCalled();
    expect(externo.espejo).not.toHaveBeenCalled();
    expect(externo.sendText).not.toHaveBeenCalled();
    expect(externo.sendTemplate).not.toHaveBeenCalled();
  });

  it("(control) la misma reserva fuera del chat de pruebas SÍ avisa y espeja: los espías funcionan", async () => {
    const f = await crearClinica();
    const paciente = await prisma.patient.create({ data: { clinicId: f.clinic.id, phone: "5491100000001", name: "Real" } });
    const r = await createAppointmentFromRequest({
      clinic: await prisma.clinic.findUniqueOrThrow({ where: { id: f.clinic.id }, include: { sharedCalendarAccount: true, sharedCalendarMicrosoftAccount: true } }) as Clinic,
      patient: paciente, requestedDate: LUNES, requestedTime: "10:00", requestedService: "limpieza",
    });
    expect(r.ok).toBe(true);
    expect(externo.notificarProfesional).toHaveBeenCalledTimes(1);
    expect(externo.espejo).toHaveBeenCalledTimes(1);
  });

  it("la cita de prueba ocupa la agenda: otro usuario no puede agendar encima, con las reglas de siempre", async () => {
    const f = await crearClinica();
    await runSandboxTurn({ clinicId: f.clinic.id, userId: "u1", text: "El lunes a las 10", deps: modelo(reservar).deps });
    // Con un solo profesional y un solo espacio, las 10:00 ya no están libres para otra persona.
    const r = await runSandboxTurn({ clinicId: f.clinic.id, userId: "u2", text: "El lunes a las 10", deps: modelo(reservar).deps });
    expect(r.citas).toHaveLength(0);
    expect(await prisma.appointment.count({ where: { clinicId: f.clinic.id } })).toBe(1);
  });
});

describe("derivar a una persona en el chat de pruebas: se muestra, no se hace", () => {
  it("no crea la derivación, no manda el mail y deja una nota en el chat", async () => {
    const f = await crearClinica();
    const m = modelo([respuesta({ intent: "otro", escalar_a_humano: true, motivo_escalar: "urgencia", respuesta_al_paciente: "Ya aviso a alguien de la clínica." })]);
    const r = await runSandboxTurn({ clinicId: f.clinic.id, userId: "u1", text: "Me duele muchísimo una muela", deps: m.deps });

    expect(r.respuestas).toEqual(["Ya aviso a alguien de la clínica."]);
    expect(r.notas.join(" ")).toMatch(/derivó la conversación a una persona/);
    expect(r.notas.join(" ")).toMatch(/Urgencia/i);
    expect(await prisma.escalation.count({ where: { clinicId: f.clinic.id } })).toBe(0);
    expect(externo.mailDerivacion).not.toHaveBeenCalled();
    expect(externo.sendTemplate).not.toHaveBeenCalled();
    expect(await prisma.systemEvent.count({ where: { clinicId: f.clinic.id, kind: "servicio_sin_match" } })).toBe(0);
  });

  it("un servicio que la clínica no ofrece tampoco deja una derivación ni un evento de monitoreo", async () => {
    const f = await crearClinica();
    const m = modelo([
      respuesta({ intent: "agendar", servicio: "masaje", fecha_solicitada: LUNES, hora_solicitada: "10:00", requiere_horarios_disponibles: true }),
      respuesta({ intent: "agendar", servicio: "masaje" }),
    ]);
    const r = await runSandboxTurn({ clinicId: f.clinic.id, userId: "u1", text: "Quiero un masaje el lunes", deps: m.deps });
    expect(r.notas.join(" ")).toMatch(/servicio que la clínica no ofrece/);
    expect(await prisma.escalation.count({ where: { clinicId: f.clinic.id } })).toBe(0);
    expect(await prisma.systemEvent.count({ where: { clinicId: f.clinic.id, kind: "servicio_sin_match" } })).toBe(0);
    expect(externo.sendTemplate).not.toHaveBeenCalled();
  });
});

describe("campañas en el chat de pruebas: como un mensaje de la calle, sin atajos", () => {
  async function campana(f: F, name = "Limpieza de verano") {
    const r = await createCampaign(f.clinic.id, { name, description: "20 % de descuento", serviceId: f.servicio.id, triggers: [{ kind: "texto", value: "promo de verano" }] });
    if (!r.ok) throw new Error(r.message);
    return r.value;
  }

  it("sin la frase de la campaña, el asistente NO sabe de ella: no hay forma de adelantarle qué va a pedir quien escribe", async () => {
    const f = await crearClinica();
    await campana(f);
    const m = modelo([respuesta()]);
    await runSandboxTurn({ clinicId: f.clinic.id, userId: "u1", text: "Hola, quiero un turno", deps: m.deps });
    expect(m.llamadas[0].campana).toBe(SIN_CAMPANA);
    expect((await getSandboxConversation(f.clinic.id, "u1")).campana).toBeNull();
    expect(await prisma.campaignLead.count({ where: { clinicId: f.clinic.id } })).toBe(0);
  });

  it("escribir la frase de la campaña la detecta, igual que por WhatsApp: el asistente recibe su contexto", async () => {
    const f = await crearClinica();
    const c = await campana(f);
    const m = modelo([respuesta()]);
    await runSandboxTurn({ clinicId: f.clinic.id, userId: "u1", text: "Hola, vi la promo de verano", deps: m.deps });
    expect(m.llamadas[0].campana).toContain('"Limpieza de verano"');
    expect(m.llamadas[0].campana).toContain("20 % de descuento");
    expect((await getSandboxConversation(f.clinic.id, "u1")).campana).toEqual({ id: c.id, name: "Limpieza de verano" });
  });

  it("un mensaje parecido pero sin el formato exacto no se reconoce (como en producción)", async () => {
    const f = await crearClinica();
    await campana(f);
    const m = modelo([respuesta()]);
    await runSandboxTurn({ clinicId: f.clinic.id, userId: "u1", text: "escribo por la promoción del verano", deps: m.deps });
    expect(m.llamadas[0].campana).toBe(SIN_CAMPANA);
  });

  it("si el asistente reconoce la promoción por lo que dijo la persona (sin la frase), queda como la campaña de la conversación", async () => {
    const f = await crearClinica();
    const c = await campana(f);
    const m = modelo([respuesta({ campana_mencionada: "Limpieza de verano", respuesta_al_paciente: "Sí, tenemos esa promoción." })]);
    const r = await runSandboxTurn({ clinicId: f.clinic.id, userId: "u1", text: "vengo por la promo del verano, la de limpieza", deps: m.deps });

    expect(r.decisiones[0].campanaMencionada).toBe("Limpieza de verano");
    expect(m.llamadas[0].campana).toBe(SIN_CAMPANA); // todavía no se había reconocido al empezar
    expect((await getSandboxConversation(f.clinic.id, "u1")).campana).toEqual({ id: c.id, name: "Limpieza de verano" });
    expect(await listLeads({ clinicId: f.clinic.id })).toEqual([]); // y sigue sin contar como un contacto real
  });

  it("el asistente recibe las promociones vigentes también en el chat de pruebas", async () => {
    const f = await crearClinica();
    await campana(f);
    const promociones: string[] = [];
    const deps = { retryDelayMs: 0, interpret: (async (p: { promociones: string }) => { promociones.push(p.promociones); return respuesta(); }) as never };
    await runSandboxTurn({ clinicId: f.clinic.id, userId: "u1", text: "¿Tienen promociones?", deps });
    expect(promociones[0]).toContain('"Limpieza de verano"');
    expect(promociones[0]).toContain("20 % de descuento");
  });

  it("los contactos de prueba NO aparecen en las estadísticas ni en la lista de contactos de la clínica", async () => {
    const f = await crearClinica();
    await campana(f);
    await runSandboxTurn({ clinicId: f.clinic.id, userId: "u1", text: "promo de verano", deps: modelo(reservar).deps });

    expect(await prisma.campaignLead.count({ where: { clinicId: f.clinic.id } })).toBe(1);
    expect(await listLeads({ clinicId: f.clinic.id })).toEqual([]);
    const stats = await campaignStats({ clinicId: f.clinic.id, from: new Date(0), toExclusive: new Date(Date.now() + 86_400_000) });
    expect(stats.size).toBe(0);
  });

  it("el seguimiento no le escribe a un contacto de prueba", async () => {
    const f = await crearClinica();
    await prisma.clinic.update({ where: { id: f.clinic.id }, data: { campaignFollowUpEnabled: true } });
    await campana(f);
    await runSandboxTurn({ clinicId: f.clinic.id, userId: "u1", text: "promo de verano", deps: modelo([respuesta()]).deps });
    await prisma.campaignLead.updateMany({ where: { clinicId: f.clinic.id }, data: { lastInboundAt: new Date("2030-06-10T00:00:00Z") } });
    const send = vi.fn();
    expect(await runCampaignFollowUp(new Date("2030-06-20T12:00:00Z"), { send: send as never }, { clinicIds: [f.clinic.id] })).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("reiniciar y borrar", () => {
  async function conversacionConDatos(f: F, userId: string) {
    const frase = `frase ${userId} ${n++}`;
    const c = await createCampaign(f.clinic.id, { name: `Camp ${userId} ${n++}`, serviceId: f.servicio.id, triggers: [{ kind: "texto", value: frase }] });
    if (!c.ok) throw new Error(c.message);
    // La campaña se reconoce por la frase en el mensaje, como en producción.
    await runSandboxTurn({ clinicId: f.clinic.id, userId, text: `${frase}. El lunes a las 10`, deps: modelo(reservar).deps });
  }
  const cuenta = (f: F) => Promise.all([
    prisma.patient.count({ where: { clinicId: f.clinic.id } }),
    prisma.appointment.count({ where: { clinicId: f.clinic.id } }),
    prisma.conversationMessage.count({ where: { clinicId: f.clinic.id } }),
    prisma.campaignLead.count({ where: { clinicId: f.clinic.id } }),
  ]);

  it("borra la ficha de prueba, lo hablado, las citas y el contacto de campaña", async () => {
    const f = await crearClinica();
    await conversacionConDatos(f, "u1");
    expect(await cuenta(f)).toEqual([1, 1, 2, 1]);
    expect(await resetSandbox(f.clinic.id, "u1")).toEqual({ patients: 1, appointments: 1 });
    expect(await cuenta(f)).toEqual([0, 0, 0, 0]);
    const c = await getSandboxConversation(f.clinic.id, "u1");
    expect(c).toEqual({ mensajes: [], citas: [], campana: null });
  });

  it("solo borra lo de ese usuario: no toca a pacientes reales ni a otras pruebas", async () => {
    const f = await crearClinica();
    const real = await prisma.patient.create({ data: { clinicId: f.clinic.id, phone: "5491100000002", name: "Real" } });
    await prisma.appointment.create({
      data: { clinicId: f.clinic.id, patientId: real.id, professionalId: f.gomez.id, roomId: f.sala.id, service: "Limpieza", startTime: new Date("2030-06-18T10:00:00Z"), endTime: new Date("2030-06-18T10:30:00Z") },
    });
    await prisma.conversationMessage.create({ data: { clinicId: f.clinic.id, patientPhone: real.phone, role: "patient", content: "hola" } });
    await conversacionConDatos(f, "ana");
    await prisma.appointment.deleteMany({ where: { patient: { phone: sandboxPhoneFor("ana") } } }); // libera el horario para la de Luis
    await conversacionConDatos(f, "luis");

    await resetSandbox(f.clinic.id, "ana");

    expect(await prisma.patient.findMany({ where: { clinicId: f.clinic.id }, orderBy: { phone: "asc" }, select: { phone: true } })).toEqual(
      [{ phone: "5491100000002" }, { phone: sandboxPhoneFor("luis") }].sort((a, b) => a.phone.localeCompare(b.phone))
    );
    expect(await prisma.appointment.count({ where: { clinicId: f.clinic.id } })).toBe(2); // la real y la de Luis
    expect(await prisma.conversationMessage.count({ where: { clinicId: f.clinic.id, patientPhone: real.phone } })).toBe(1);
  });

  it("no se puede usar para borrar a un paciente real: solo acepta teléfonos de prueba", async () => {
    const f = await crearClinica();
    const real = await prisma.patient.create({ data: { clinicId: f.clinic.id, phone: "5491100000003", name: "Real" } });
    await expect(purgeSandboxPhone(f.clinic.id, real.phone)).rejects.toThrow(/teléfonos de prueba/);
    expect(await prisma.patient.count({ where: { id: real.id } })).toBe(1);
  });

  it("reiniciar sin haber hablado no falla", async () => {
    const f = await crearClinica();
    expect(await resetSandbox(f.clinic.id, "nadie")).toEqual({ patients: 0, appointments: 0 });
  });
});

describe("la limpieza automática de pruebas olvidadas", () => {
  const haceHoras = (h: number) => new Date(Date.now() - h * 3_600_000);

  it("borra las conversaciones sin actividad hace 2 horas o más, y deja las recientes", async () => {
    const f = await crearClinica();
    await runSandboxTurn({ clinicId: f.clinic.id, userId: "vieja", text: "El lunes a las 10", deps: modelo(reservar).deps });
    await runSandboxTurn({ clinicId: f.clinic.id, userId: "reciente", text: "Hola", deps: modelo([respuesta()]).deps });
    const vieja = sandboxPhoneFor("vieja");
    await prisma.conversationMessage.updateMany({ where: { clinicId: f.clinic.id, patientPhone: vieja }, data: { createdAt: haceHoras(3) } });
    await prisma.patient.updateMany({ where: { clinicId: f.clinic.id, phone: vieja }, data: { createdAt: haceHoras(3) } });

    expect(await purgeIdleSandbox(new Date(), 2, { clinicIds: [f.clinic.id] })).toBe(1);

    expect((await prisma.patient.findMany({ where: { clinicId: f.clinic.id } })).map((p) => p.phone)).toEqual([sandboxPhoneFor("reciente")]);
    expect(await prisma.appointment.count({ where: { clinicId: f.clinic.id } })).toBe(0);
  });

  it("no cuenta como inactiva una conversación cuya ficha es vieja pero habló hace poco", async () => {
    const f = await crearClinica();
    await runSandboxTurn({ clinicId: f.clinic.id, userId: "u1", text: "Hola", deps: modelo([respuesta()]).deps });
    await prisma.patient.updateMany({ where: { clinicId: f.clinic.id }, data: { createdAt: haceHoras(10) } });
    await purgeIdleSandbox(new Date(), 2, { clinicIds: [f.clinic.id] });
    expect(await prisma.patient.count({ where: { clinicId: f.clinic.id } })).toBe(1);
  });

  it("nunca toca a los pacientes reales, por viejos que sean", async () => {
    const f = await crearClinica();
    await prisma.patient.create({ data: { clinicId: f.clinic.id, phone: "5491100000004", name: "Real", createdAt: haceHoras(500) } });
    // Acotado a esta clínica: con 0 horas, sin acotar, borraría las conversaciones de prueba de cualquiera en la base.
    await purgeIdleSandbox(new Date(), 0, { clinicIds: [f.clinic.id] });
    expect(await prisma.patient.count({ where: { clinicId: f.clinic.id } })).toBe(1);
  });
});

describe("los jobs ignoran a los pacientes de prueba", () => {
  it("el recordatorio no le escribe a un paciente de prueba, pero sí a uno real", async () => {
    const f = await crearClinica();
    const base = new Date("2030-06-12T10:00:00.000Z");
    const inicio = new Date(base.getTime() + 23.5 * 3_600_000);
    const mk = async (phone: string) => {
      const p = await prisma.patient.create({ data: { clinicId: f.clinic.id, phone, name: "X" } });
      await prisma.appointment.create({
        data: { clinicId: f.clinic.id, patientId: p.id, professionalId: f.gomez.id, roomId: f.sala.id, service: "Limpieza", startTime: inicio, endTime: new Date(inicio.getTime() + 1_800_000) },
      });
    };
    await mk(sandboxPhoneFor("u1"));
    await mk("5491100000005");
    const r = await sendRemindersForWindow(f.clinic.id, { token: "t", phoneNumberId: "p" }, "recordatorio_turno", 24, "UTC", new Date("2030-06-12T10:20:00Z"));
    expect(r.sent).toBe(1);
    expect(externo.sendTemplate.mock.calls.map((c) => c[1])).toEqual(["5491100000005"]);
  });

  it("la próxima cita sugerida de un paciente de prueba no genera un contacto", async () => {
    const f = await crearClinica();
    const sug = new Date("2030-06-20T00:00:00Z");
    await prisma.patient.create({ data: { clinicId: f.clinic.id, phone: sandboxPhoneFor("u1"), name: "Prueba", suggestedNextVisitDate: sug } });
    await prisma.patient.create({ data: { clinicId: f.clinic.id, phone: "5491100000006", name: "Real", suggestedNextVisitDate: sug } });
    const due = await findPatientsDueForOutreach({ clinicId: f.clinic.id, timezone: "UTC", leadDays: 14, now: new Date("2030-06-15T12:00:00Z") });
    expect(due.map((p) => p.phone)).toEqual(["5491100000006"]);
  });

  it("el seguimiento post-visita no marca como atendida ni le escribe a una cita de prueba", async () => {
    const f = await crearClinica();
    await prisma.clinic.update({ where: { id: f.clinic.id }, data: { active: true } });
    const ahora = new Date("2030-06-12T12:30:00Z");
    const fin = new Date(ahora.getTime() - 24.5 * 3_600_000);
    const p = await prisma.patient.create({ data: { clinicId: f.clinic.id, phone: sandboxPhoneFor("u1"), name: "Prueba" } });
    const cita = await prisma.appointment.create({
      data: { clinicId: f.clinic.id, patientId: p.id, professionalId: f.gomez.id, roomId: f.sala.id, service: "Limpieza", startTime: new Date(fin.getTime() - 1_800_000), endTime: fin },
    });
    await runPostVisitFollowUp(ahora, { clinicIds: [f.clinic.id] });
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: cita.id } })).status).toBe("confirmado");
    expect(externo.sendTemplate).not.toHaveBeenCalled();
  });
});

describe("el listado de citas del chat de pruebas muestra la persona del turno", () => {
  it("devuelve el nombre de la ficha de prueba cuando ya se presentó", async () => {
    const f = await crearClinica();
    const m = modelo(reservar);
    await runSandboxTurn({ clinicId: f.clinic.id, userId: "u1", text: "El lunes a las 10", deps: m.deps });
    await prisma.patient.updateMany({ where: { clinicId: f.clinic.id, phone: sandboxPhoneFor("u1") }, data: { name: "María Bolívar" } });
    const conv = await getSandboxConversation(f.clinic.id, "u1");
    expect(conv.citas[0].patient).toBe("María Bolívar");
  });
});
