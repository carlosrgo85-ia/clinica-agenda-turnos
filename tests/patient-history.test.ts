import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import {
  describePatientHistories,
  MAX_COMMENT_IN_PROMPT,
  MAX_COMMENTS,
  MAX_OBSERVATIONS_IN_PROMPT,
  MAX_TREATMENTS,
  SIN_HISTORIAL,
  type PatientHistoryForPrompt,
} from "../src/prompts/patient-history-context";
import { loadPatientHistories } from "../src/services/patient-history";
import { buildSystemPrompt } from "../src/prompts/system-prompt";

/**
 * Lo que el asistente sabe de quien ya vino: qué se le hizo, su próxima cita
 * sugerida y las notas internas. Todo esto va a la API del modelo, así que está
 * acotado y solo incluye a las personas de ese número.
 */

const clinicIds: string[] = [];

function historia(over?: Partial<PatientHistoryForPrompt>): PatientHistoryForPrompt {
  return {
    nombre: "María López",
    nombreDePila: "María",
    tratamientos: [],
    proximaCitaSugerida: null,
    observaciones: null,
    comentarios: [],
    ...over,
  };
}

describe("describePatientHistories", () => {
  it("sin nada que contar lo dice explícitamente", () => {
    expect(describePatientHistories([])).toBe(SIN_HISTORIAL);
    expect(describePatientHistories([historia()])).toBe(SIN_HISTORIAL);
  });

  it("incluye lo que se le hizo, la próxima cita sugerida, las observaciones y los comentarios", () => {
    const texto = describePatientHistories([
      historia({
        tratamientos: [
          { fecha: "2030-05-10", servicio: "Limpieza", profesional: "Gómez" },
          { fecha: "2030-01-12", servicio: "Blanqueamiento", profesional: "Ruiz" },
        ],
        proximaCitaSugerida: { fecha: "2030-11-10", nota: "control" },
        observaciones: "Prefiere las tardes",
        comentarios: [{ fecha: "2030-05-11", texto: "Quedó conforme" }],
      }),
    ]);
    expect(texto).toContain('María López — se la trata por "María"');
    expect(texto).toContain("2030-05-10 Limpieza con Gómez; 2030-01-12 Blanqueamiento con Ruiz");
    expect(texto).toContain("Próxima cita sugerida por el personal: 2030-11-10 (control)");
    expect(texto).toContain("Observaciones del personal: Prefiere las tardes");
    expect(texto).toContain("[2030-05-11] Quedó conforme");
  });

  it("acota los largos y la cantidad: es lo que se manda a un servicio externo", () => {
    const muchos = Array.from({ length: 10 }, (_, i) => ({ fecha: `2030-01-${10 + i}`, servicio: `S${i}`, profesional: "G" }));
    const comentarios = Array.from({ length: 10 }, (_, i) => ({ fecha: "2030-02-01", texto: `C${i}` }));
    const texto = describePatientHistories([
      historia({
        tratamientos: muchos,
        comentarios,
        observaciones: "o".repeat(5000),
      }),
    ]);
    expect((texto.match(/ con G/g) ?? []).length).toBe(MAX_TREATMENTS);
    expect((texto.match(/\[2030-02-01\]/g) ?? []).length).toBe(MAX_COMMENTS);
    expect(texto).not.toContain("o".repeat(MAX_OBSERVATIONS_IN_PROMPT + 1));

    const largo = describePatientHistories([historia({ comentarios: [{ fecha: "2030-02-01", texto: "z".repeat(1000) }] })]);
    expect(largo).not.toContain("z".repeat(MAX_COMMENT_IN_PROMPT + 1));
    expect(largo).toContain("…");
  });

  it("una persona sin nombre se nombra por su rol y no se inventa uno", () => {
    const texto = describePatientHistories([historia({ nombre: "", nombreDePila: "", observaciones: "algo" })]);
    expect(texto).toContain("(quien escribe, nombre no registrado)");
  });

  it("omite a las personas sin nada que contar pero muestra a las demás", () => {
    const texto = describePatientHistories([historia({ nombre: "Sin nada" }), historia({ nombre: "Con nota", observaciones: "x" })]);
    expect(texto).not.toContain("Sin nada");
    expect(texto).toContain("Con nota");
  });
});

describe("loadPatientHistories", () => {
  async function escenario() {
    const c = await prisma.clinic.create({
      data: {
        name: `Clínica historial ${Date.now()}-${Math.random()}`,
        whatsappPhoneNumberId: `ph-${Date.now()}-${Math.random()}`,
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
  type C = Awaited<ReturnType<typeof escenario>>;

  const cita = (c: C, patientId: string, start: string, over: { status?: "confirmado" | "cancelado" | "atendido"; attended?: boolean; service?: string } = {}) =>
    prisma.appointment.create({
      data: {
        clinicId: c.id, patientId, professionalId: c.professionals[0].id, roomId: c.rooms[0].id,
        service: over.service ?? "Limpieza",
        startTime: new Date(start), endTime: new Date(new Date(start).getTime() + 30 * 60_000),
        status: over.status ?? "atendido", attendedAt: over.attended ? new Date(start) : null,
      },
    });

  afterEach(async () => {
    for (const clinicId of clinicIds) {
      await prisma.patientComment.deleteMany({ where: { clinicId } });
      await prisma.appointment.deleteMany({ where: { clinicId } });
      await prisma.patient.deleteMany({ where: { clinicId } });
      await prisma.room.deleteMany({ where: { clinicId } });
      await prisma.professional.deleteMany({ where: { clinicId } });
      await prisma.clinic.delete({ where: { id: clinicId } });
    }
    clinicIds.length = 0;
  });

  it("trae lo que se le hizo (solo lo cumplido), lo sugerido, las observaciones y los comentarios", async () => {
    const c = await escenario();
    const p = await prisma.patient.create({
      data: {
        clinicId: c.id, phone: "5491100000001", name: "María López", firstName: "María", lastName: "López",
        observations: "Prefiere las tardes", suggestedNextVisitDate: new Date("2030-11-10T00:00:00Z"), suggestedNextVisitNote: "control",
      },
    });
    await cita(c, p.id, "2030-05-10T10:00:00Z", { service: "Limpieza" }); // atendida
    await cita(c, p.id, "2030-06-10T10:00:00Z", { status: "confirmado", attended: true, service: "Control" }); // confirmada por una persona
    await cita(c, p.id, "2030-07-10T10:00:00Z", { status: "cancelado", service: "Cancelada" });
    await cita(c, p.id, "2031-01-10T10:00:00Z", { status: "confirmado", service: "Futura" });
    await prisma.patientComment.create({ data: { clinicId: c.id, patientId: p.id, authorName: "Ana", text: "Quedó conforme" } });

    const [h] = await loadPatientHistories({ clinicId: c.id, patientIds: [p.id], timezone: "UTC" });
    expect(h.nombreDePila).toBe("María");
    expect(h.tratamientos.map((t) => t.servicio)).toEqual(["Control", "Limpieza"]);
    expect(h.tratamientos[0]).toMatchObject({ fecha: "2030-06-10", profesional: "Gómez" });
    expect(h.proximaCitaSugerida).toEqual({ fecha: "2030-11-10", nota: "control" });
    expect(h.observaciones).toBe("Prefiere las tardes");
    expect(h.comentarios.map((x) => x.texto)).toEqual(["Quedó conforme"]);
  });

  it("solo las personas pedidas y de esa clínica: nunca otro paciente", async () => {
    const c = await escenario();
    const ajena = await escenario();
    const propia = await prisma.patient.create({ data: { clinicId: c.id, phone: "5491100000001", name: "Propia", observations: "mía" } });
    const otraDelNumero = await prisma.patient.create({ data: { clinicId: c.id, phone: "5491100000009", name: "Otro Número", observations: "secreto" } });
    const deOtraClinica = await prisma.patient.create({ data: { clinicId: ajena.id, phone: "5491100000001", name: "De Otra", observations: "ajeno" } });

    const hs = await loadPatientHistories({ clinicId: c.id, patientIds: [propia.id, deOtraClinica.id], timezone: "UTC" });
    expect(hs.map((h) => h.nombre)).toEqual(["Propia"]);
    const texto = describePatientHistories(hs);
    expect(texto).not.toContain("secreto");
    expect(texto).not.toContain("ajeno");
    expect(otraDelNumero.id).toBeTruthy();
    expect(await loadPatientHistories({ clinicId: c.id, patientIds: [], timezone: "UTC" })).toEqual([]);
  });

  it("los comentarios llegan del más nuevo al más viejo y acotados", async () => {
    const c = await escenario();
    const p = await prisma.patient.create({ data: { clinicId: c.id, phone: "5491100000001", name: "María" } });
    for (let i = 0; i < 8; i++) {
      await prisma.patientComment.create({
        data: { clinicId: c.id, patientId: p.id, authorName: "A", text: `c${i}`, createdAt: new Date(`2030-02-0${i + 1}T10:00:00Z`) },
      });
    }
    const [h] = await loadPatientHistories({ clinicId: c.id, patientIds: [p.id], timezone: "UTC" });
    expect(h.comentarios.map((x) => x.texto)).toEqual(["c7", "c6", "c5", "c4", "c3"]);
  });
});

describe("la regla del prompt para quien ya vino", () => {
  const clinic = {
    name: "Clínica Demo", customerNoun: "paciente", escalationCriteria: "x", country: "AR", timezone: "UTC",
    address: null, minLeadMinutes: 0, services: "Limpieza",
  } as unknown as Parameters<typeof buildSystemPrompt>[0];

  it("pide calidez, preguntar cómo le fue una sola vez y proponer la próxima cita", () => {
    const prompt = buildSystemPrompt(clinic, { esPrimeraVez: false });
    expect(prompt).toContain("Personas que ya vinieron");
    expect(prompt).toContain("cómo le fue");
    expect(prompt).toContain("UNA sola");
    expect(prompt).toContain("próxima cita sugerida");
    expect(prompt).toContain("por su nombre de pila");
  });

  it("prohíbe recitar las notas internas, dar consejos médicos o inventar", () => {
    const prompt = buildSystemPrompt(clinic, { esPrimeraVez: false });
    expect(prompt).toContain("NUNCA las cites");
    expect(prompt).toContain("No des consejos médicos");
    expect(prompt).toContain("no lo inventes");
  });

  it("si lo que cuenta es preocupante, escala según los criterios de la clínica", () => {
    const prompt = buildSystemPrompt(clinic, { esPrimeraVez: false });
    expect(prompt).toContain("escala según los criterios de la clínica");
  });

  it("reconoce que quien escribe puede estar contestando un aviso de la clínica", () => {
    const prompt = buildSystemPrompt(clinic, { esPrimeraVez: false });
    expect(prompt).toContain("fue la clínica quien le escribió primero");
  });
});
