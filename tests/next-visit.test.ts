import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import { findPatientsDueForOutreach, sanitizeTemplateParam } from "../src/services/next-visit";
import { PLAN_FEATURES } from "../src/config/plan-features";
import { runNextVisitOutreach, type OutreachDeps } from "../src/jobs/next-visit-outreach";
import { renderTemplateBody } from "../src/services/whatsapp-templates";

/**
 * La próxima cita sugerida es una sugerencia del personal. El proceso busca a
 * quienes ya les toca y todavía no tienen turno, y les escribe por plantilla.
 */

/** Lunes 17 a las 10:00 UTC: dentro del horario de envío (9 a 18) de una clínica UTC. */
const AHORA = new Date("2030-06-17T10:00:00.000Z");
const clinicIds: string[] = [];

async function clinica(over?: { enabled?: boolean; lead?: number; timezone?: string; sinPlan?: boolean }) {
  const c = await prisma.clinic.create({
    data: {
      name: `Clínica contacto ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `nv-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "test@example.com",
      timezone: over?.timezone ?? "UTC",
      services: "x",
      nextVisitOutreachEnabled: over?.enabled ?? true,
      nextVisitOutreachLeadDays: over?.lead ?? 14,
      // El contacto por próxima cita es del plan Plus: sin él, el interruptor prendido no hace nada.
      plan: {
        create: {
          name: `test-plan-${Date.now()}-${Math.random()}`,
          features: over?.sinPlan ? [] : [PLAN_FEATURES.NEXT_VISIT_OUTREACH],
        },
      },
      professionals: { create: [{ name: "Gómez" }] },
      rooms: { create: [{ name: "Sala 1" }] },
    },
    include: { professionals: true, rooms: true },
  });
  clinicIds.push(c.id);
  return c;
}
type C = Awaited<ReturnType<typeof clinica>>;

let n = 0;
async function paciente(c: C, over: { fecha?: string | null; nota?: string; optOut?: boolean; enviado?: boolean; name?: string; first?: string | null }) {
  n += 1;
  return prisma.patient.create({
    data: {
      clinicId: c.id,
      phone: `54911000${String(n).padStart(5, "0")}`,
      name: over.name ?? `Paciente ${n}`,
      firstName: over.first === undefined ? `Paciente${n}` : over.first,
      suggestedNextVisitDate: over.fecha === null ? null : new Date(`${over.fecha ?? "2030-06-20"}T00:00:00Z`),
      suggestedNextVisitNote: over.nota ?? null,
      outreachOptOut: over.optOut ?? false,
      nextVisitOutreachSentAt: over.enviado ? new Date("2030-06-01T00:00:00Z") : null,
    },
  });
}

async function cita(c: C, patientId: string, start: string, status: "confirmado" | "cancelado" | "atendido" = "confirmado") {
  const s = new Date(start);
  return prisma.appointment.create({
    data: {
      clinicId: c.id, patientId, professionalId: c.professionals[0].id, roomId: c.rooms[0].id, service: "Control",
      startTime: s, endTime: new Date(s.getTime() + 30 * 60_000), status,
    },
  });
}

const due = (c: C, now = AHORA, lead = 14) =>
  findPatientsDueForOutreach({ clinicId: c.id, timezone: c.timezone, leadDays: lead, now });

function fakeSend(over?: { falla?: boolean }) {
  const llamadas: Array<{ to: string; template: string; params: string[] }> = [];
  const deps: OutreachDeps = {
    send: (async (_c: unknown, to: string, template: string, _l: string, params: string[]) => {
      if (over?.falla) throw new Error("plantilla no aprobada");
      llamadas.push({ to, template, params });
    }) as OutreachDeps["send"],
  };
  return { deps, llamadas };
}

/** El registro de auditoría está protegido por un trigger: la limpieza declara mantenimiento. */
async function purgarAuditoria(clinicId: string) {
  await prisma.$transaction([
    prisma.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`,
    prisma.auditLog.deleteMany({ where: { clinicId } }),
  ]);
}

afterEach(async () => {
  for (const clinicId of clinicIds) {
    await purgarAuditoria(clinicId);
    await prisma.systemEvent.deleteMany({ where: { clinicId } });
    await prisma.conversationMessage.deleteMany({ where: { clinicId } });
    await prisma.appointment.deleteMany({ where: { clinicId } });
    await prisma.patient.deleteMany({ where: { clinicId } });
    await prisma.room.deleteMany({ where: { clinicId } });
    await prisma.professional.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  await prisma.plan.deleteMany({ where: { name: { startsWith: "test-plan-" } } });
  clinicIds.length = 0;
});

describe("a quién le toca", () => {
  it("a quien su fecha sugerida es hoy, ya pasó, o cae dentro de los días de anticipación", async () => {
    const c = await clinica();
    const hoy = await paciente(c, { fecha: "2030-06-17" });
    const vencida = await paciente(c, { fecha: "2030-05-01" });
    const pronto = await paciente(c, { fecha: "2030-07-01" }); // 14 días justo
    const lejos = await paciente(c, { fecha: "2030-07-02" }); // 15 días: todavía no
    const sin = await paciente(c, { fecha: null });
    const ids = (await due(c)).map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([hoy.id, vencida.id, pronto.id]));
    expect(ids).not.toContain(lejos.id);
    expect(ids).not.toContain(sin.id);
  });

  it("el más próximo primero", async () => {
    const c = await clinica();
    const b = await paciente(c, { fecha: "2030-06-25" });
    const a = await paciente(c, { fecha: "2030-06-10" });
    expect((await due(c)).map((p) => p.id)).toEqual([a.id, b.id]);
  });

  it("no a quien pidió que no lo contacten, ni a quien ya se le escribió por esta sugerencia", async () => {
    const c = await clinica();
    await paciente(c, { optOut: true });
    await paciente(c, { enviado: true });
    const ok = await paciente(c, {});
    expect((await due(c)).map((p) => p.id)).toEqual([ok.id]);
  });

  it("no a quien ya tiene un turno confirmado a futuro; sí si es pasado o está cancelado", async () => {
    const c = await clinica();
    const conTurno = await paciente(c, {});
    const turnoViejo = await paciente(c, {});
    const turnoCancelado = await paciente(c, {});
    await cita(c, conTurno.id, "2030-06-25T10:00:00Z");
    await cita(c, turnoViejo.id, "2030-05-01T10:00:00Z", "atendido");
    await cita(c, turnoCancelado.id, "2030-06-25T10:00:00Z", "cancelado");
    const ids = (await due(c)).map((p) => p.id);
    expect(ids).not.toContain(conTurno.id);
    expect(ids).toEqual(expect.arrayContaining([turnoViejo.id, turnoCancelado.id]));
  });

  it("no mezcla clínicas y respeta el tope", async () => {
    const c = await clinica();
    const otra = await clinica();
    await paciente(otra, {});
    for (let i = 0; i < 4; i++) await paciente(c, {});
    expect(await due(c)).toHaveLength(4);
    expect(await findPatientsDueForOutreach({ clinicId: c.id, timezone: "UTC", leadDays: 14, now: AHORA, limit: 2 })).toHaveLength(2);
  });

  it("'hoy' es el día de la clínica", async () => {
    const c = await clinica({ timezone: "America/Mexico_City" });
    // 03:00 UTC del 18 es el 17 a las 21:00 en México: hoy es el 17.
    const p = await paciente(c, { fecha: "2030-07-01" });
    const justo = await due(c, new Date("2030-06-18T03:00:00Z"), 14);
    expect(justo.map((x) => x.id)).toContain(p.id);
    // Con 13 días de anticipación (17 + 13 = 30 de junio) todavía no.
    expect((await due(c, new Date("2030-06-18T03:00:00Z"), 13)).map((x) => x.id)).not.toContain(p.id);
  });
});

describe("el texto que se manda", () => {
  it("limpia saltos de línea y largos que Meta rechaza", () => {
    expect(sanitizeTemplateParam("control\nde   ortodoncia\t", "control")).toBe("control de ortodoncia");
    expect(sanitizeTemplateParam("   ", "control")).toBe("control");
    expect(sanitizeTemplateParam("x".repeat(100), "control", 10)).toHaveLength(10);
  });

  it("la plantilla se rellena con los parámetros en su lugar", () => {
    const t = renderTemplateBody("proximo_control", ["María", "Clínica Demo", "control"]);
    expect(t).toContain("Hola María, te escribimos de Clínica Demo.");
    expect(t).toContain("tu próximo control");
    expect(renderTemplateBody("no_existe", [])).toBeNull();
  });
});

describe("el proceso de contacto", () => {
  it("manda la plantilla con nombre, clínica y motivo, y marca la sugerencia como avisada", async () => {
    const c = await clinica();
    const p = await paciente(c, { first: "María", nota: "control de ortodoncia" });
    const { deps, llamadas } = fakeSend();

    expect(await runNextVisitOutreach(AHORA, deps, { clinicIds: [c.id] })).toBe(1);

    expect(llamadas).toEqual([{
      to: p.phone,
      template: "proximo_control",
      params: ["María", c.name, "control de ortodoncia"],
    }]);
    expect((await prisma.patient.findUniqueOrThrow({ where: { id: p.id } })).nextVisitOutreachSentAt).not.toBeNull();
  });

  it("el aviso queda registrado en la auditoría, con origen 'sistema' y sin datos del paciente", async () => {
    const c = await clinica();
    const p = await paciente(c, { first: "María", nota: "control de ortodoncia" });
    const { deps } = fakeSend();
    await runNextVisitOutreach(AHORA, deps, { clinicIds: [c.id] });
    const filas = await prisma.auditLog.findMany({ where: { clinicId: c.id, action: "patient.outreach_sent" } });
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ origin: "sistema", resourceId: p.id, userId: null, outcome: "ok" });
    expect(filas[0].details).toEqual({ plantilla: "proximo_control" });
    const todo = JSON.stringify(filas[0]);
    expect(todo).not.toContain("control de ortodoncia");
    expect(todo).not.toContain(p.phone);
    await purgarAuditoria(c.id);
  });

  it("si el envío falla no queda registro de que se le escribió", async () => {
    const c = await clinica();
    await paciente(c, {});
    const roto = fakeSend({ falla: true });
    await runNextVisitOutreach(AHORA, roto.deps, { clinicIds: [c.id] });
    expect(await prisma.auditLog.count({ where: { clinicId: c.id, action: "patient.outreach_sent" } })).toBe(0);
  });

  it("sin nota habla de un 'control', y sin nombre de pila lo parte del nombre completo", async () => {
    const c = await clinica();
    await paciente(c, { first: null, name: "Juan Pérez" });
    const { deps, llamadas } = fakeSend();
    await runNextVisitOutreach(AHORA, deps, { clinicIds: [c.id] });
    expect(llamadas[0].params[0]).toBe("Juan");
    expect(llamadas[0].params[2]).toBe("control");
  });

  it("deja lo mandado en el historial, para que el asistente sepa a qué le contestan", async () => {
    const c = await clinica();
    const p = await paciente(c, { first: "María" });
    const { deps } = fakeSend();
    await runNextVisitOutreach(AHORA, deps, { clinicIds: [c.id] });
    const msgs = await prisma.conversationMessage.findMany({ where: { clinicId: c.id, patientPhone: p.phone } });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].content).toContain("Hola María, te escribimos de");
  });

  it("un solo mensaje por sugerencia, aunque el proceso corra de nuevo", async () => {
    const c = await clinica();
    await paciente(c, {});
    const { deps, llamadas } = fakeSend();
    await runNextVisitOutreach(AHORA, deps, { clinicIds: [c.id] });
    await runNextVisitOutreach(new Date("2030-06-17T11:00:00Z"), deps, { clinicIds: [c.id] });
    expect(llamadas).toHaveLength(1);
  });

  it("está apagado por defecto: sin el interruptor no escribe a nadie", async () => {
    const c = await clinica({ enabled: false });
    await paciente(c, {});
    const { deps, llamadas } = fakeSend();
    expect(await runNextVisitOutreach(AHORA, deps, { clinicIds: [c.id] })).toBe(0);
    expect(llamadas).toHaveLength(0);
    // El default de la base, sin elegir nada, es apagado.
    const recien = await prisma.clinic.create({
      data: { name: `x ${Math.random()}`, whatsappPhoneNumberId: `d-${Math.random()}`, whatsappTokenEncrypted: encryptToken("t"), email: "a@b.com", services: "x" },
    });
    clinicIds.push(recien.id);
    expect(recien.nextVisitOutreachEnabled).toBe(false);
  });

  it("con el interruptor prendido pero un plan que no lo incluye (Base), no escribe a nadie", async () => {
    const c = await clinica({ enabled: true, sinPlan: true });
    await paciente(c, {});
    const { deps, llamadas } = fakeSend();
    expect(await runNextVisitOutreach(AHORA, deps, { clinicIds: [c.id] })).toBe(0);
    expect(llamadas).toHaveLength(0);
  });

  it("solo en el horario de la clínica", async () => {
    const c = await clinica();
    await paciente(c, {});
    const { deps, llamadas } = fakeSend();
    await runNextVisitOutreach(new Date("2030-06-17T08:30:00Z"), deps, { clinicIds: [c.id] }); // 08:30
    await runNextVisitOutreach(new Date("2030-06-17T19:30:00Z"), deps, { clinicIds: [c.id] }); // 19:30
    expect(llamadas).toHaveLength(0);
    await runNextVisitOutreach(new Date("2030-06-17T09:30:00Z"), deps, { clinicIds: [c.id] });
    expect(llamadas).toHaveLength(1);
  });

  it("si el envío falla libera al paciente, corta la tanda y deja UN solo evento", async () => {
    const c = await clinica();
    const a = await paciente(c, { fecha: "2030-06-10" });
    const b = await paciente(c, { fecha: "2030-06-11" });
    const roto = fakeSend({ falla: true });

    expect(await runNextVisitOutreach(AHORA, roto.deps, { clinicIds: [c.id] })).toBe(0);

    // Liberados: se reintentan cuando la plantilla esté aprobada.
    for (const p of [a, b]) {
      expect((await prisma.patient.findUniqueOrThrow({ where: { id: p.id } })).nextVisitOutreachSentAt).toBeNull();
    }
    const eventos = await prisma.systemEvent.findMany({ where: { clinicId: c.id, kind: "whatsapp_envio" } });
    expect(eventos).toHaveLength(1);
    expect(eventos[0].message).toContain("proximo_control");

    const sano = fakeSend();
    expect(await runNextVisitOutreach(new Date("2030-06-17T11:00:00Z"), sano.deps, { clinicIds: [c.id] })).toBe(2);
  });

  it("no le escribe a quien ya sacó turno ni a quien pidió que no lo contacten", async () => {
    const c = await clinica();
    const conTurno = await paciente(c, {});
    await cita(c, conTurno.id, "2030-06-25T10:00:00Z");
    await paciente(c, { optOut: true });
    const { deps, llamadas } = fakeSend();
    await runNextVisitOutreach(AHORA, deps, { clinicIds: [c.id] });
    expect(llamadas).toHaveLength(0);
  });
});
