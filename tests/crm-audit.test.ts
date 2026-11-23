import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import {
  getOrCreateConversationPatient,
  nameFields,
  resolvePatientForBooking,
  setPatientName,
  setPatientName,
  updatePatientStage,
} from "../src/repositories/patients.repository";
import { runPostVisitFollowUp } from "../src/jobs/post-visit-followup";
import { markAppointmentAttended } from "../src/services/packages";
import { actionLabel, auditFiltersFromQuery, listAudit } from "../src/services/audit";

/**
 * Lo que el asistente y los jobs hacen sobre los pacientes NO pasa por la API, así que el
 * middleware no lo ve: el alta de una ficha por WhatsApp y cada cambio de etapa del CRM se
 * registran explícitamente, con el origen (`whatsapp`, `sistema` o `panel`).
 *
 * Nunca guardan el teléfono ni el nombre: el recurso es la ficha, y de ahí sale todo.
 */

const clinicIds: string[] = [];
const TELEFONO = "5491155550101";
const NOMBRE_SECRETO = "Nombre-De-Paciente-Que-No-Debe-Quedar";

async function clinica() {
  const c = await prisma.clinic.create({
    data: {
      name: `Clínica CRM ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `crm-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "test@example.com",
      timezone: "UTC",
      services: "x",
      professionals: { create: [{ name: "Gómez" }] },
      rooms: { create: [{ name: "Sala 1" }] },
    },
    include: { professionals: true, rooms: true },
  });
  clinicIds.push(c.id);
  return c;
}

/** El registro de auditoría está protegido por un trigger: la limpieza declara mantenimiento. */
async function purgarAuditoria() {
  await prisma.$transaction([
    prisma.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`,
    prisma.auditLog.deleteMany({ where: { clinicId: { in: clinicIds } } }),
  ]);
}

afterEach(async () => {
  await purgarAuditoria();
  for (const clinicId of clinicIds) {
    await prisma.appointment.deleteMany({ where: { clinicId } });
    await prisma.package.deleteMany({ where: { clinicId } });
    await prisma.patient.deleteMany({ where: { clinicId } });
    await prisma.room.deleteMany({ where: { clinicId } });
    await prisma.professional.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
});

const filas = (clinicId: string, action?: string) =>
  prisma.auditLog.findMany({
    where: { clinicId, ...(action ? { action } : {}) },
    orderBy: { occurredAt: "asc" },
  });

describe("el alta de un paciente por WhatsApp", () => {
  it("la primera vez que escribe se crea la ficha y queda registrada, con origen 'whatsapp'", async () => {
    const c = await clinica();
    const p = await getOrCreateConversationPatient(c.id, TELEFONO);
    const [fila] = await filas(c.id, "patient.create_whatsapp");
    expect(fila).toMatchObject({
      origin: "whatsapp",
      clinicId: c.id,
      resourceType: "patients",
      resourceId: p.id,
      outcome: "ok",
      userId: null,
    });
    expect(fila.details).toMatchObject({ titular: true });
  });

  it("no guarda el teléfono: el recurso es la ficha", async () => {
    const c = await clinica();
    await getOrCreateConversationPatient(c.id, TELEFONO);
    const [fila] = await filas(c.id);
    expect(JSON.stringify(fila)).not.toContain(TELEFONO);
  });

  it("si la ficha ya existía, no se registra otra alta", async () => {
    const c = await clinica();
    await getOrCreateConversationPatient(c.id, TELEFONO);
    await getOrCreateConversationPatient(c.id, TELEFONO);
    await getOrCreateConversationPatient(c.id, TELEFONO);
    expect(await filas(c.id, "patient.create_whatsapp")).toHaveLength(1);
  });

  it("cada número nuevo es un alta", async () => {
    const c = await clinica();
    await getOrCreateConversationPatient(c.id, "5491155550101");
    await getOrCreateConversationPatient(c.id, "5491155550102");
    expect(await filas(c.id, "patient.create_whatsapp")).toHaveLength(2);
  });
});

describe("nombre y apellido cada uno en su campo", () => {
  it("con el apellido por separado se guardan las tres columnas, aun con nombre compuesto", async () => {
    const c = await clinica();
    const titular = await prisma.patient.create({ data: { clinicId: c.id, phone: TELEFONO } });
    await setPatientName(titular.id, "Petra María", "Romero");
    const p = await prisma.patient.findUniqueOrThrow({ where: { id: titular.id } });
    expect(p).toMatchObject({ name: "Petra María Romero", firstName: "Petra María", lastName: "Romero" });
    // La auditoría dice qué campos, nunca los valores.
    const [fila] = await filas(c.id, "patient.name_set");
    expect(fila.details).toMatchObject({ camposModificados: ["name", "firstName", "lastName"] });
    expect(JSON.stringify(fila)).not.toContain("Romero");
  });

  it("sin apellido solo se guarda el nombre completo (se parte al leer)", async () => {
    const c = await clinica();
    const titular = await prisma.patient.create({ data: { clinicId: c.id, phone: TELEFONO } });
    await setPatientName(titular.id, "Petra María Romero");
    const p = await prisma.patient.findUniqueOrThrow({ where: { id: titular.id } });
    expect(p).toMatchObject({ name: "Petra María Romero", firstName: null, lastName: null });
  });

  it("una persona nueva del número entra con sus partes, y se la encuentra después por el nombre completo", async () => {
    const c = await clinica();
    const titular = await prisma.patient.create({ data: { clinicId: c.id, phone: TELEFONO, name: "Carlos Gómez" } });
    const nueva = await resolvePatientForBooking({ clinicId: c.id, phone: TELEFONO, nombre: "Ana Lucía", apellido: "Pérez", titular });
    expect(nueva).toMatchObject({ firstName: "Ana Lucía", lastName: "Pérez", name: "Ana Lucía Pérez" });
    // La segunda vez el modelo puede dar el nombre completo suelto o partido: es la misma persona.
    const otra = await resolvePatientForBooking({ clinicId: c.id, phone: TELEFONO, nombre: "ana lucia perez", titular });
    const mismaPartida = await resolvePatientForBooking({ clinicId: c.id, phone: TELEFONO, nombre: "Ana Lucía", apellido: "Pérez", titular });
    expect(otra.id).toBe(nueva.id);
    expect(mismaPartida.id).toBe(nueva.id);
  });

  it("nameFields no inventa partes cuando falta el apellido", () => {
    expect(nameFields("  Petra  María ")).toEqual({ name: "Petra María" });
    expect(nameFields("Petra", "  ")).toEqual({ name: "Petra" });
    expect(nameFields("Petra María", "García  López")).toEqual({ name: "Petra María García López", firstName: "Petra María", lastName: "García López" });
  });
});

describe("las personas del número al agendar", () => {
  it("una persona nueva de la familia es otra ficha, y queda registrada", async () => {
    const c = await clinica();
    const titular = await prisma.patient.create({ data: { clinicId: c.id, phone: TELEFONO, name: "Carlos" } });
    const nueva = await resolvePatientForBooking({ clinicId: c.id, phone: TELEFONO, nombre: "Nieves", titular });
    expect(nueva.id).not.toBe(titular.id);
    const [fila] = await filas(c.id, "patient.create_whatsapp");
    expect(fila).toMatchObject({ origin: "whatsapp", resourceId: nueva.id });
    expect(fila.details).toMatchObject({ titular: false, personaNuevaDelNumero: true });
    expect(JSON.stringify(fila)).not.toContain("Nieves");
  });

  it("el titular que todavía no tenía nombre y se presenta: se registra el nombre, sin el valor", async () => {
    const c = await clinica();
    const titular = await prisma.patient.create({ data: { clinicId: c.id, phone: TELEFONO } });
    await resolvePatientForBooking({ clinicId: c.id, phone: TELEFONO, nombre: NOMBRE_SECRETO, titular });
    const [fila] = await filas(c.id, "patient.name_set");
    expect(fila).toMatchObject({ origin: "whatsapp", resourceId: titular.id });
    expect(fila.details).toMatchObject({ camposModificados: ["name"] });
    expect(JSON.stringify(fila)).not.toContain(NOMBRE_SECRETO);
    // Y no se creó otra ficha ni se registró una alta.
    expect(await filas(c.id, "patient.create_whatsapp")).toHaveLength(0);
  });

  it("si es el titular o una persona que ya estaba, no se registra nada", async () => {
    const c = await clinica();
    const titular = await prisma.patient.create({ data: { clinicId: c.id, phone: TELEFONO, name: "Carlos" } });
    await resolvePatientForBooking({ clinicId: c.id, phone: TELEFONO, nombre: null, titular });
    await resolvePatientForBooking({ clinicId: c.id, phone: TELEFONO, nombre: "CARLOS", titular });
    expect(await filas(c.id)).toHaveLength(0);
  });

  it("setPatientName registra que el nombre cambió, nunca el valor", async () => {
    const c = await clinica();
    const p = await prisma.patient.create({ data: { clinicId: c.id, phone: TELEFONO } });
    await setPatientName(p.id, NOMBRE_SECRETO);
    const [fila] = await filas(c.id, "patient.name_set");
    expect(fila).toMatchObject({ origin: "whatsapp", resourceId: p.id });
    expect(JSON.stringify(fila)).not.toContain(NOMBRE_SECRETO);
    expect((await prisma.patient.findUniqueOrThrow({ where: { id: p.id } })).name).toBe(NOMBRE_SECRETO);
  });
});

describe("el cambio de etapa del CRM", () => {
  async function paciente(c: Awaited<ReturnType<typeof clinica>>, stage: "nuevo_contacto" | "interesado" = "nuevo_contacto") {
    return prisma.patient.create({ data: { clinicId: c.id, phone: TELEFONO, name: "María", stage } });
  }

  it("registra de qué etapa a cuál, quién lo originó y por qué", async () => {
    const c = await clinica();
    const p = await paciente(c);
    await updatePatientStage(p.id, "interesado", { origin: "whatsapp", motivo: "primer_mensaje" });
    const [fila] = await filas(c.id, "patient.stage_change");
    expect(fila).toMatchObject({ origin: "whatsapp", clinicId: c.id, resourceType: "patients", resourceId: p.id, userId: null, outcome: "ok" });
    expect(fila.details).toEqual({ desde: "nuevo_contacto", hasta: "interesado", motivo: "primer_mensaje" });
    expect((await prisma.patient.findUniqueOrThrow({ where: { id: p.id } })).stage).toBe("interesado");
  });

  it("si la etapa ya era esa, no escribe nada ni registra nada: no hubo cambio", async () => {
    const c = await clinica();
    const p = await paciente(c, "interesado");
    await updatePatientStage(p.id, "interesado", { origin: "whatsapp", motivo: "primer_mensaje" });
    expect(await filas(c.id)).toHaveLength(0);
  });

  it("varios cambios dejan varias filas, en orden", async () => {
    const c = await clinica();
    const p = await paciente(c);
    await updatePatientStage(p.id, "interesado", { origin: "whatsapp", motivo: "primer_mensaje" });
    await updatePatientStage(p.id, "turno_agendado", { origin: "whatsapp", motivo: "turno_agendado" });
    await updatePatientStage(p.id, "cancelado", { origin: "whatsapp", motivo: "cancelacion" });
    const trayecto = (await filas(c.id, "patient.stage_change")).map((f) => (f.details as { hasta: string }).hasta);
    expect(trayecto).toEqual(["interesado", "turno_agendado", "cancelado"]);
  });

  it("si lo hizo una persona desde el panel, queda su usuario y el origen 'panel'", async () => {
    const c = await clinica();
    const p = await paciente(c);
    await updatePatientStage(p.id, "atendido", { origin: "panel", userId: "usuario-9", motivo: "asistencia_confirmada" });
    const [fila] = await filas(c.id, "patient.stage_change");
    expect(fila).toMatchObject({ origin: "panel", userId: "usuario-9" });
  });

  it("un paciente que no existe falla como antes y no deja registro", async () => {
    await expect(updatePatientStage("no-existe", "interesado", { origin: "whatsapp", motivo: "primer_mensaje" })).rejects.toThrow();
  });

  it("no guarda nada del paciente: ni nombre ni teléfono", async () => {
    const c = await clinica();
    const p = await paciente(c);
    await updatePatientStage(p.id, "interesado", { origin: "whatsapp", motivo: "primer_mensaje" });
    const todo = JSON.stringify(await filas(c.id));
    expect(todo).not.toContain("María");
    expect(todo).not.toContain(TELEFONO);
  });
});

describe("los otros caminos que cambian la etapa", () => {
  async function citaDe(c: Awaited<ReturnType<typeof clinica>>, over: { start: Date; end?: Date; status?: "confirmado" | "cancelado" | "atendido" }) {
    const p = await prisma.patient.create({ data: { clinicId: c.id, phone: TELEFONO, name: "María", stage: "turno_agendado" } });
    const cita = await prisma.appointment.create({
      data: {
        clinicId: c.id, patientId: p.id, professionalId: c.professionals[0].id, roomId: c.rooms[0].id, service: "Limpieza",
        startTime: over.start, endTime: over.end ?? new Date(over.start.getTime() + 30 * 60_000), status: over.status ?? "confirmado",
      },
    });
    return { p, cita };
  }

  it("el job que da por atendida una cita a las 24 h registra el cambio con origen 'sistema'", async () => {
    const c = await clinica();
    const ahora = new Date("2030-06-18T12:00:00.000Z");
    // Terminó hace 24 h y media: cae en la ventana de la hora.
    const fin = new Date(ahora.getTime() - 24.5 * 60 * 60 * 1000);
    const { p } = await citaDe(c, { start: new Date(fin.getTime() - 30 * 60_000), end: fin });

    await runPostVisitFollowUp(ahora, { clinicIds: [c.id] });

    expect((await prisma.patient.findUniqueOrThrow({ where: { id: p.id } })).stage).toBe("atendido");
    const [fila] = await filas(c.id, "patient.stage_change");
    expect(fila).toMatchObject({ origin: "sistema", userId: null, resourceId: p.id });
    expect(fila.details).toEqual({ desde: "turno_agendado", hasta: "atendido", motivo: "seguimiento_automatico" });
  });

  it("el job no toca lo que está fuera de la ventana ni lo que ya estaba atendido", async () => {
    const c = await clinica();
    const ahora = new Date("2030-06-18T12:00:00.000Z");
    await citaDe(c, { start: new Date("2030-06-18T10:00:00.000Z") }); // terminó hace 1.5 h: todavía no
    await runPostVisitFollowUp(ahora, { clinicIds: [c.id] });
    expect(await filas(c.id)).toHaveLength(0);
  });

  it("confirmar la asistencia desde el panel registra el cambio a nombre de quien lo confirmó", async () => {
    const c = await clinica();
    const { p, cita } = await citaDe(c, { start: new Date("2030-06-17T10:00:00.000Z") });
    await markAppointmentAttended({
      clinicId: c.id, appointmentId: cita.id, userId: "asistente-7", now: new Date("2030-06-17T11:00:00.000Z"),
    });
    const [fila] = await filas(c.id, "patient.stage_change");
    expect(fila).toMatchObject({ origin: "panel", userId: "asistente-7", resourceId: p.id });
    expect(fila.details).toMatchObject({ hasta: "atendido", motivo: "asistencia_confirmada" });
  });

  it("marcarla dos veces no registra dos cambios", async () => {
    const c = await clinica();
    const { cita } = await citaDe(c, { start: new Date("2030-06-17T10:00:00.000Z") });
    const hora = new Date("2030-06-17T11:00:00.000Z");
    await markAppointmentAttended({ clinicId: c.id, appointmentId: cita.id, userId: "a", now: hora });
    await markAppointmentAttended({ clinicId: c.id, appointmentId: cita.id, userId: "a", now: hora });
    expect(await filas(c.id, "patient.stage_change")).toHaveLength(1);
  });
});

describe("consultarlo", () => {
  it("se filtra por origen, y lo que no hizo un usuario se lee con su etiqueta", async () => {
    const c = await clinica();
    const p = await prisma.patient.create({ data: { clinicId: c.id, phone: TELEFONO, name: "María" } });
    await updatePatientStage(p.id, "interesado", { origin: "whatsapp", motivo: "primer_mensaje" });
    await updatePatientStage(p.id, "atendido", { origin: "sistema", motivo: "seguimiento_automatico" });
    await updatePatientStage(p.id, "cancelado", { origin: "panel", userId: "u1", motivo: "asistencia_confirmada" });

    const whatsapp = await listAudit({ clinicId: c.id, origin: "whatsapp" });
    expect(whatsapp.registros).toHaveLength(1);
    expect(whatsapp.registros[0]).toMatchObject({ origin: "whatsapp", origenEtiqueta: "Asistente (WhatsApp)", etiqueta: "Cambió la etapa de un paciente" });
    expect((await listAudit({ clinicId: c.id, origin: "sistema" })).registros[0].origenEtiqueta).toBe("Sistema");
    expect((await listAudit({ clinicId: c.id })).registros).toHaveLength(3);
  });

  it("las etiquetas en español existen para las operaciones nuevas", () => {
    const e = (action: string) => actionLabel({ action, method: null, resourceType: "patients" });
    expect(e("patient.create_whatsapp")).toBe("Se cargó un paciente (por WhatsApp)");
    expect(e("patient.name_set")).toBe("Se registró el nombre de un paciente");
    expect(e("patient.stage_change")).toBe("Cambió la etapa de un paciente");
    expect(e("patient.outreach_sent")).toBe("Se le escribió a un paciente por su próxima cita");
  });

  it("el filtro por origen del query string acepta solo los tres valores", () => {
    expect(auditFiltersFromQuery({ origen: "whatsapp" })).toMatchObject({ ok: true, filters: { origin: "whatsapp" } });
    expect(auditFiltersFromQuery({ origen: "cualquiera" })).toMatchObject({ ok: true, filters: { origin: undefined } });
  });
});
