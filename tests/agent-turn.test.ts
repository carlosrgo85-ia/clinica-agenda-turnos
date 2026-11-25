import { afterEach, describe, expect, it, vi } from "vitest";
import { purgeAuditForClinics } from "./helpers/audit";
import type { Patient, Weekday } from "@prisma/client";
// Para probar que un fallo al leer o registrar la campaña no tumba el turno. No se espía a Prisma: los delegados de Prisma no se
// restauran bien y dejan rotas las queries de los tests siguientes.
const falla = vi.hoisted(() => ({ contexto: false, mencion: false }));
vi.mock("../src/services/campaigns", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/services/campaigns")>();
  return {
    ...original,
    getCampaignContextForPhone: (...a: Parameters<typeof original.getCampaignContextForPhone>) =>
      falla.contexto ? Promise.reject(new Error("base caída")) : original.getCampaignContextForPhone(...a),
    recordCampaignMention: (...a: Parameters<typeof original.recordCampaignMention>) =>
      falla.mencion ? Promise.reject(new Error("base caída")) : original.recordCampaignMention(...a),
  };
});
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import {
  applyAvailabilityGuards,
  AVISO_DE_ESPERA,
  DISCULPA_POR_FALLA,
  runAgentTurn,
  type AgentTurnDeps,
} from "../src/services/agent-turn";
import type { ClinicWithCalendarAccount } from "../src/repositories/clinics.repository";
import { createCampaign, recordCampaignContact } from "../src/services/campaigns";
import { SIN_CAMPANA, SIN_PROMOCIONES } from "../src/prompts/campaign-context";
import { buildSystemPrompt } from "../src/prompts/system-prompt";
import type { ClaudeAgentResponse } from "../src/types";

/**
 * El control de flujo de un turno de conversación: cuántas veces se llama al
 * modelo, con qué contexto, y qué se le termina enviando al paciente.
 *
 * Las dependencias se inyectan con funciones normales — sin `vi.mock` y sin
 * red. Lo que se prueba acá es el flujo, no lo que dice el modelo: que el
 * modelo respete las reglas del prompt no es testeable con mocks (un mock
 * devuelve el JSON que uno mismo escribió), eso es terreno de evals.
 */

const LUNES = "2030-06-17";
const DIAS_DE_SEMANA: Weekday[] = ["lunes", "martes", "miercoles", "jueves", "viernes"];

const clinicIds: string[] = [];

function respuesta(overrides?: Partial<ClaudeAgentResponse>): ClaudeAgentResponse {
  return {
    intent: "agendar",
    servicio: "consulta",
    fecha_solicitada: null,
    hora_solicitada: null,
    nombre_paciente: null,
    turno_a_modificar: null,
    requiere_horarios_disponibles: false,
    confirmacion_explicita: false,
    pidio_ubicacion: false,
    escalar_a_humano: false,
    motivo_escalar: null,
    motivo_cancelacion: null,
    motivo_es_queja: false,
    turno_cancelado: null,
    respuesta_al_paciente: "Hola, te ayudo con el turno.",
    ...overrides,
  };
}

/** Un día con un solo hueco libre a las 09:00. */
function huecosDePrueba(): Awaited<ReturnType<AgentTurnDeps["findSlots"]>> {
  return {
    days: [
      {
        dateKey: LUNES,
        weekday: "lunes" as const,
        slots: [
          {
            start: new Date(`${LUNES}T09:00:00.000Z`),
            end: new Date(`${LUNES}T09:30:00.000Z`),
            dateKey: LUNES,
            time: "09:00",
            professionalId: "p1",
            professionalName: "Dra. Ejemplo",
            professionalTitle: null,
            candidateProfessionalIds: ["p1"],
          },
        ],
        reason: null,
        exceptionReason: null,
      },
    ],
    totalSlots: 1,
    durationMinutes: 30,
    blocker: null,
    restrictedToProfessionalId: null,
  };
}

async function crearClinica(): Promise<{
  clinic: ClinicWithCalendarAccount;
  patient: Patient;
}> {
  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica agente ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `agent-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "test@example.com",
      timezone: "UTC",
      services: "Consulta",
      professionals: { create: [{ name: "Dra. Ejemplo" }] },
      rooms: { create: [{ name: "Sala 1" }] },
      workingHours: {
        create: DIAS_DE_SEMANA.map((weekday) => ({
          weekday,
          startMinute: 9 * 60,
          endMinute: 18 * 60,
        })),
      },
    },
    include: { sharedCalendarAccount: true },
  });

  clinicIds.push(clinic.id);

  const patient = await prisma.patient.create({
    data: {
      clinicId: clinic.id,
      phone: `5491${Math.floor(Math.random() * 1e9)}`,
      name: "Paciente Test",
      // Ya se le avisó que lo atiende un asistente virtual: así estas pruebas hablan de lo suyo y no cuentan el aviso.
      // Los tests de "aviso de privacidad" lo ponen en null a propósito.
      privacyNoticeSentAt: new Date(),
      assistantIntroSentAt: new Date(),
    },
  });

  return { clinic, patient };
}

/**
 * Un turno ya existente del paciente. Se crea directo con Prisma a propósito:
 * es un fixture, no el camino de reserva — eso se prueba en `booking.test.ts`.
 */
async function crearTurno(params: {
  clinic: ClinicWithCalendarAccount;
  patient: Patient;
  startTime: Date;
  status?: "confirmado" | "cancelado" | "atendido";
  service?: string;
}): Promise<string> {
  const professional = await prisma.professional.findFirstOrThrow({
    where: { clinicId: params.clinic.id },
  });
  const room = await prisma.room.findFirstOrThrow({ where: { clinicId: params.clinic.id } });

  const appointment = await prisma.appointment.create({
    data: {
      clinicId: params.clinic.id,
      patientId: params.patient.id,
      professionalId: professional.id,
      roomId: room.id,
      service: params.service ?? "Limpieza",
      startTime: params.startTime,
      endTime: new Date(params.startTime.getTime() + 30 * 60 * 1000),
      status: params.status ?? "confirmado",
    },
  });

  return appointment.id;
}

/** Dependencias falsas que registran cómo fueron llamadas. */
function fakeDeps(options?: {
  respuestas?: ClaudeAgentResponse[];
  interpretThrows?: number | number[];
  slotsThrows?: boolean;
  /** El turno se crea bien, en vez del fallo que se devuelve por default. */
  bookOk?: boolean;
}): {
  deps: AgentTurnDeps;
  llamadas: {
    interpret: Array<{ horariosDisponibles?: string; turnosPaciente?: string; campana?: string; promociones?: string }>;
    enviados: string[];
    slots: number;
    slotsParams: Array<{ requestedProfessionalId?: string | null; campaignId?: string | null }>;
    bookParams: Array<{ requestedProfessionalId?: string | null; campaignId?: string | null }>;
  };
} {
  const llamadas = {
    interpret: [] as Array<{ horariosDisponibles?: string; turnosPaciente?: string; campana?: string; promociones?: string }>,
    enviados: [] as string[],
    slots: 0,
    slotsParams: [] as Array<{ requestedProfessionalId?: string | null; campaignId?: string | null }>,
    bookParams: [] as Array<{ requestedProfessionalId?: string | null; campaignId?: string | null }>,
  };
  const respuestas = options?.respuestas ?? [respuesta()];

  const deps: AgentTurnDeps = {
    interpret: (async (params: { horariosDisponibles?: string; turnosPaciente?: string; campana?: string; promociones?: string }) => {
      const indice = llamadas.interpret.length;
      llamadas.interpret.push({
        horariosDisponibles: params.horariosDisponibles,
        turnosPaciente: params.turnosPaciente,
        campana: params.campana,
        promociones: params.promociones,
      });
      if ([options?.interpretThrows ?? []].flat().includes(indice)) throw new Error("modelo caído");
      return respuestas[Math.min(indice, respuestas.length - 1)];
    }) as AgentTurnDeps["interpret"],

    findSlots: (async (params: { requestedProfessionalId?: string | null; campaignId?: string | null }) => {
      llamadas.slots += 1;
      llamadas.slotsParams.push(params);
      if (options?.slotsThrows) throw new Error("base caída");
      return huecosDePrueba();
    }) as AgentTurnDeps["findSlots"],

    send: (async (_creds: unknown, _to: string, body: string) => {
      llamadas.enviados.push(body);
    }) as AgentTurnDeps["send"],

    retryDelayMs: 0,

    book: (async (params: { requestedProfessionalId?: string | null; campaignId?: string | null }) => {
      llamadas.bookParams.push(params);
      return options?.bookOk
        ? {
            ok: true,
            appointment: { id: "apt-creado" },
            professionalName: "Dra. Ejemplo",
            googleEventId: null,
            mirrorError: null,
          }
        : { ok: false, reason: "sin_profesional_disponible" };
    }) as AgentTurnDeps["book"],
  };

  return { deps, llamadas };
}

afterEach(async () => {
  falla.contexto = false;
  falla.mencion = false;
  await purgeAuditForClinics(clinicIds);
  for (const clinicId of clinicIds) {
    await prisma.systemEvent.deleteMany({ where: { clinicId } });
    await prisma.agentRequest.deleteMany({ where: { clinicId } });
    await prisma.campaignLead.deleteMany({ where: { clinicId } });
    await prisma.campaign.deleteMany({ where: { clinicId } });
    await prisma.patientComment.deleteMany({ where: { clinicId } });
    await prisma.conversationMessage.deleteMany({ where: { clinicId } });
    await prisma.escalation.deleteMany({ where: { clinicId } });
    await prisma.appointment.deleteMany({ where: { clinicId } });
    await prisma.workingHours.deleteMany({ where: { clinicId } });
    await prisma.patient.deleteMany({ where: { clinicId } });
    await prisma.service.deleteMany({ where: { clinicId } });
    await prisma.room.deleteMany({ where: { clinicId } });
    await prisma.professional.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
});

describe("consulta de horarios", () => {
  it("no consulta la agenda si el modelo no la pidió", async () => {
    const { clinic, patient } = await crearClinica();
    const { deps, llamadas } = fakeDeps();

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Hola" }, deps);

    expect(llamadas.interpret).toHaveLength(1);
    expect(llamadas.slots).toBe(0);
  });

  it("consulta la agenda y vuelve a llamar al modelo con los horarios", async () => {
    const { clinic, patient } = await crearClinica();
    const { deps, llamadas } = fakeDeps({
      respuestas: [
        respuesta({ requiere_horarios_disponibles: true }),
        respuesta({ respuesta_al_paciente: "Tengo el lunes a las 9." }),
      ],
    });

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Quiero un turno" }, deps);

    expect(llamadas.interpret).toHaveLength(2);
    expect(llamadas.slots).toBe(1);
    expect(llamadas.interpret[0].horariosDisponibles).toBeUndefined();
    expect(llamadas.interpret[1].horariosDisponibles).toContain("09:00 con Dra. Ejemplo");
    expect(llamadas.enviados).toEqual(["Tengo el lunes a las 9."]);
  });

  it("no vuelve a consultar aunque la segunda respuesta pida horarios de nuevo", async () => {
    const { clinic, patient } = await crearClinica();
    const { deps, llamadas } = fakeDeps({
      respuestas: [
        respuesta({ requiere_horarios_disponibles: true }),
        respuesta({ requiere_horarios_disponibles: true }),
      ],
    });

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Quiero un turno" }, deps);

    expect(llamadas.interpret).toHaveLength(2);
    expect(llamadas.slots).toBe(1);
  });

  it("no consulta la agenda si hay que escalar a un humano", async () => {
    const { clinic, patient } = await crearClinica();
    const { deps, llamadas } = fakeDeps({
      respuestas: [
        respuesta({
          requiere_horarios_disponibles: true,
          escalar_a_humano: true,
          motivo_escalar: "urgencia",
        }),
      ],
    });

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Me duele mucho" }, deps);

    expect(llamadas.slots).toBe(0);
    expect(llamadas.interpret).toHaveLength(1);
  });
});

describe("el paciente siempre recibe una respuesta", () => {
  it("responde igual si falla el cálculo de huecos", async () => {
    const { clinic, patient } = await crearClinica();
    const { deps, llamadas } = fakeDeps({
      slotsThrows: true,
      respuestas: [
        respuesta({ requiere_horarios_disponibles: true }),
        respuesta({ respuesta_al_paciente: "Perdón, no pude ver la agenda." }),
      ],
    });

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Quiero un turno" }, deps);

    expect(llamadas.interpret[1].horariosDisponibles).toBe(
      "no se pudo consultar la agenda en este momento"
    );
    expect(llamadas.enviados).toEqual(["Perdón, no pude ver la agenda."]);
  });

  it("envía la primera respuesta si falla la segunda llamada al modelo", async () => {
    const { clinic, patient } = await crearClinica();
    const { deps, llamadas } = fakeDeps({
      interpretThrows: 1,
      respuestas: [
        respuesta({
          requiere_horarios_disponibles: true,
          respuesta_al_paciente: "Dejame ver la agenda.",
        }),
      ],
    });

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Quiero un turno" }, deps);

    expect(llamadas.enviados).toEqual(["Dejame ver la agenda."]);
  });
});

describe("el historial que recibe el asistente", () => {
  it("le llega lo que se le hizo a las personas de ese número, y nada de otros pacientes", async () => {
    const { clinic, patient } = await crearClinica();
    const otro = await prisma.patient.create({
      data: { clinicId: clinic.id, phone: "5491199999999", name: "Otro Número", observations: "SECRETO-AJENO" },
    });
    await prisma.patient.update({
      where: { id: patient.id },
      data: { observations: "Prefiere las tardes", suggestedNextVisitDate: new Date("2030-11-10T00:00:00Z"), suggestedNextVisitNote: "control" },
    });
    await prisma.patientComment.create({ data: { clinicId: clinic.id, patientId: patient.id, authorName: "Ana", text: "Quedó conforme" } });

    const { deps } = fakeDeps();
    let recibido = "";
    const interpretOriginal = deps.interpret;
    deps.interpret = (async (params: { historialPersonas: string }) => {
      recibido = params.historialPersonas;
      return interpretOriginal(params as never);
    }) as AgentTurnDeps["interpret"];

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Hola" }, deps);

    expect(recibido).toContain("Prefiere las tardes");
    expect(recibido).toContain("Quedó conforme");
    expect(recibido).toContain("2030-11-10");
    expect(recibido).not.toContain("SECRETO-AJENO");
    expect(otro.id).toBeTruthy();
    await prisma.patient.delete({ where: { id: otro.id } });
  });

  it("sin nada registrado le dice que no hay historial", async () => {
    const { clinic, patient } = await crearClinica();
    const { deps } = fakeDeps();
    let recibido = "";
    const interpretOriginal = deps.interpret;
    deps.interpret = (async (params: { historialPersonas: string }) => {
      recibido = params.historialPersonas;
      return interpretOriginal(params as never);
    }) as AgentTurnDeps["interpret"];
    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Hola" }, deps);
    expect(recibido).toContain("no hay nada que recordarles");
  });
});

describe("servicio que no matchea el catálogo", () => {
  it("deriva y deja un evento con el texto que devolvió el modelo, para medir los falsos positivos", async () => {
    const { clinic, patient } = await crearClinica();
    const { deps } = fakeDeps({
      respuestas: [
        respuesta({
          servicio: "limpieza dental",
          requiere_horarios_disponibles: true,
          respuesta_al_paciente: "Dejame ver la agenda.",
        }),
      ],
    });
    deps.findSlots = (async () => ({
      ...huecosDePrueba(),
      days: [],
      totalSlots: 0,
      blocker: "servicio_no_ofrecido",
    })) as AgentTurnDeps["findSlots"];

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Quiero una limpieza dental" }, deps);

    expect(await prisma.escalation.count({ where: { clinicId: clinic.id } })).toBe(1);
    const eventos = await prisma.systemEvent.findMany({
      where: { clinicId: clinic.id, kind: "servicio_sin_match" },
    });
    expect(eventos).toHaveLength(1);
    expect(eventos[0].severity).toBe("warning");
    expect(eventos[0].message).toContain("limpieza dental");
    // Es un nombre de servicio, no el mensaje del paciente.
    expect(eventos[0].message).not.toContain("Quiero");
  });

  it("si el motivo es otro (nadie lo realiza), no cuenta como falta de match", async () => {
    const { clinic, patient } = await crearClinica();
    const { deps } = fakeDeps({
      respuestas: [respuesta({ servicio: "Limpieza", requiere_horarios_disponibles: true })],
    });
    deps.findSlots = (async () => ({
      ...huecosDePrueba(),
      days: [],
      totalSlots: 0,
      blocker: "servicio_sin_profesional",
    })) as AgentTurnDeps["findSlots"];

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Una limpieza" }, deps);

    expect(
      await prisma.systemEvent.count({ where: { clinicId: clinic.id, kind: "servicio_sin_match" } })
    ).toBe(0);
  });
});

describe("si falla la primera llamada al modelo", () => {
  it("reintenta una vez y contesta normal si la segunda sale bien", async () => {
    const { clinic, patient } = await crearClinica();
    const { deps, llamadas } = fakeDeps({
      interpretThrows: 0,
      respuestas: [respuesta({ respuesta_al_paciente: "Hola, te ayudo." })],
    });

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Hola" }, deps);

    expect(llamadas.interpret).toHaveLength(2);
    expect(llamadas.enviados).toEqual([AVISO_DE_ESPERA, "Hola, te ayudo."]);
    expect(await prisma.escalation.count({ where: { clinicId: clinic.id } })).toBe(0);
  });

  it("si falla dos veces, pide disculpas y deriva a una persona", async () => {
    const { clinic, patient } = await crearClinica();
    const { deps, llamadas } = fakeDeps({ interpretThrows: [0, 1] });

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Quiero un turno" }, deps);

    expect(llamadas.interpret).toHaveLength(2);
    expect(llamadas.enviados).toEqual([AVISO_DE_ESPERA, DISCULPA_POR_FALLA]);
    const derivaciones = await prisma.escalation.findMany({ where: { clinicId: clinic.id } });
    expect(derivaciones).toHaveLength(1);
    expect(derivaciones[0].patientMessage).toBe("Quiero un turno");
    // Y queda a la vista en Monitoreo: un aviso del primer intento y el error final.
    const eventos = await prisma.systemEvent.findMany({
      where: { clinicId: clinic.id, kind: "modelo_fallo" },
      orderBy: { createdAt: "asc" },
    });
    expect(eventos.map((e) => e.severity).sort()).toEqual(["error", "warning"]);
    // Queda en el historial lo que se le contestó.
    expect(await prisma.conversationMessage.count({ where: { clinicId: clinic.id } })).toBe(2);
  });

  it("deja un respaldo del mensaje antes de esperar y lo reclama al volver", async () => {
    const { clinic, patient } = await crearClinica();
    const { deps, llamadas } = fakeDeps({ interpretThrows: 0, respuestas: [respuesta({ respuesta_al_paciente: "Hola, te ayudo." })] });
    const pasos: string[] = [];
    deps.respaldo = {
      guardar: (async (p: { text: string; patientPhone: string }) => {
        pasos.push(`guardar:${p.text}:${p.patientPhone}`);
        return "respaldo-1";
      }) as never,
      reclamar: (async (id: string) => {
        pasos.push(`reclamar:${id}`);
        return true;
      }) as never,
    };

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Hola" }, deps);

    expect(pasos).toEqual([`guardar:Hola:${patient.phone}`, "reclamar:respaldo-1"]);
    expect(llamadas.interpret).toHaveLength(2);
    expect(llamadas.enviados).toEqual([AVISO_DE_ESPERA, "Hola, te ayudo."]);
  });

  it("si el respaldo ya lo tomó otro turno, este no reintenta ni contesta: lo contesta el otro", async () => {
    const { clinic, patient } = await crearClinica();
    const { deps, llamadas } = fakeDeps({ interpretThrows: 0 });
    deps.respaldo = { guardar: (async () => "respaldo-1") as never, reclamar: (async () => false) as never };

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Hola" }, deps);

    expect(llamadas.interpret).toHaveLength(1); // no hubo segundo intento
    expect(llamadas.enviados).toEqual([AVISO_DE_ESPERA]); // solo el aviso de espera, ninguna respuesta duplicada
    expect(await prisma.escalation.count({ where: { clinicId: clinic.id } })).toBe(0);
    expect(await prisma.conversationMessage.count({ where: { clinicId: clinic.id } })).toBe(0);
  });

  it("si no se puede guardar el respaldo, reintenta igual (como antes)", async () => {
    const { clinic, patient } = await crearClinica();
    const { deps, llamadas } = fakeDeps({ interpretThrows: 0, respuestas: [respuesta({ respuesta_al_paciente: "Hola, te ayudo." })] });
    let reclamado = false;
    deps.respaldo = {
      guardar: (async () => {
        throw new Error("base caída");
      }) as never,
      reclamar: (async () => {
        reclamado = true;
        return true;
      }) as never,
    };

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Hola" }, deps);

    expect(reclamado).toBe(false); // no había nada que reclamar
    expect(llamadas.interpret).toHaveLength(2);
    expect(llamadas.enviados).toEqual([AVISO_DE_ESPERA, "Hola, te ayudo."]);
  });

  it("si no se puede confirmar el respaldo, contesta igual: duplicar es mejor que no contestar", async () => {
    const { clinic, patient } = await crearClinica();
    const { deps, llamadas } = fakeDeps({ interpretThrows: 0, respuestas: [respuesta({ respuesta_al_paciente: "Hola, te ayudo." })] });
    deps.respaldo = {
      guardar: (async () => "respaldo-1") as never,
      reclamar: (async () => {
        throw new Error("base caída");
      }) as never,
    };

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Hola" }, deps);

    expect(llamadas.interpret).toHaveLength(2);
    expect(llamadas.enviados).toEqual([AVISO_DE_ESPERA, "Hola, te ayudo."]);
  });

  it("sin falla del modelo no toca la cola", async () => {
    const { clinic, patient } = await crearClinica();
    const { deps } = fakeDeps();
    let toco = false;
    deps.respaldo = {
      guardar: (async () => {
        toco = true;
        return "x";
      }) as never,
      reclamar: (async () => {
        toco = true;
        return true;
      }) as never,
    };
    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Hola" }, deps);
    expect(toco).toBe(false);
  });

  it("no agenda ni cancela nada al fallar", async () => {
    const { clinic, patient } = await crearClinica();
    const { deps, llamadas } = fakeDeps({ interpretThrows: [0, 1] });

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Cancela mi turno" }, deps);

    expect(llamadas.bookParams).toHaveLength(0);
  });
});

describe("historial de conversación", () => {
  it("guarda un solo par de mensajes, con la respuesta final", async () => {
    const { clinic, patient } = await crearClinica();
    const { deps } = fakeDeps({
      respuestas: [
        respuesta({
          requiere_horarios_disponibles: true,
          respuesta_al_paciente: "Dejame ver la agenda.",
        }),
        respuesta({ respuesta_al_paciente: "Tengo el lunes a las 9." }),
      ],
    });

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Quiero un turno" }, deps);

    const mensajes = await prisma.conversationMessage.findMany({
      where: { clinicId: clinic.id },
      orderBy: { createdAt: "asc" },
    });

    expect(mensajes.map((m) => m.role)).toEqual(["patient", "assistant"]);
    // La primera interpretación nunca le llegó al paciente: si quedara en el
    // historial, el modelo vería en el próximo mensaje una respuesta que no
    // existió.
    expect(mensajes[1].content).toBe("Tengo el lunes a las 9.");
  });
});

describe("turnos existentes del paciente", () => {
  const FUTURO = new Date("2030-06-17T13:00:00.000Z");
  const PASADO = new Date("2020-06-15T13:00:00.000Z");

  it("le informa al modelo el turno que el paciente ya tiene", async () => {
    const { clinic, patient } = await crearClinica();
    const turnoId = await crearTurno({ clinic, patient, startTime: FUTURO });
    const { deps, llamadas } = fakeDeps();

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Hola" }, deps);

    expect(llamadas.interpret[0].turnosPaciente).toContain(turnoId);
    expect(llamadas.interpret[0].turnosPaciente).toContain("13:00");
  });

  it("dice 'sin turnos' cuando la persona no tiene ninguno", async () => {
    const { clinic, patient } = await crearClinica();
    const { deps, llamadas } = fakeDeps();

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Hola" }, deps);

    expect(llamadas.interpret[0].turnosPaciente).toContain("sin citas");
  });

  it("no informa un turno que ya pasó", async () => {
    const { clinic, patient } = await crearClinica();
    await crearTurno({ clinic, patient, startTime: PASADO });
    const { deps, llamadas } = fakeDeps();

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Hola" }, deps);

    expect(llamadas.interpret[0].turnosPaciente).toContain("sin citas");
  });

  it("no informa un turno cancelado", async () => {
    const { clinic, patient } = await crearClinica();
    await crearTurno({ clinic, patient, startTime: FUTURO, status: "cancelado" });
    const { deps, llamadas } = fakeDeps();

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Hola" }, deps);

    expect(llamadas.interpret[0].turnosPaciente).toContain("sin citas");
  });

  it("también se los pasa a la segunda llamada", async () => {
    const { clinic, patient } = await crearClinica();
    const turnoId = await crearTurno({ clinic, patient, startTime: FUTURO });
    const { deps, llamadas } = fakeDeps({
      respuestas: [respuesta({ requiere_horarios_disponibles: true }), respuesta()],
    });

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Quiero otro turno" }, deps);

    expect(llamadas.interpret).toHaveLength(2);
    expect(llamadas.interpret[1].turnosPaciente).toContain(turnoId);
  });
});

describe("turnos para otra persona del mismo WhatsApp", () => {
  /**
   * El bug del 2026-09-14: Carlos pidió un turno "para Nieves de García" y
   * quedó a su nombre, porque el paciente se identificaba por teléfono.
   */
  it("agenda a nombre de la otra persona, no del titular", async () => {
    const { clinic, patient } = await crearClinica();
    await prisma.patient.update({ where: { id: patient.id }, data: { name: "Carlos" } });
    const { deps } = fakeDeps({
      bookOk: true,
      respuestas: [
        respuesta({
          intent: "confirmar",
          confirmacion_explicita: true,
          fecha_solicitada: LUNES,
          hora_solicitada: "09:00",
          paciente_del_turno: "Nieves de García",
        }),
      ],
    });

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "sí, las 9" }, deps);

    const personas = await prisma.patient.findMany({
      where: { clinicId: clinic.id, phone: patient.phone },
      orderBy: { createdAt: "asc" },
    });
    expect(personas.map((p) => p.name)).toEqual(["Carlos", "Nieves de García"]);
    // El titular no se renombró ni cambió de etapa por un turno ajeno.
    expect(personas[0].stage).not.toBe("turno_agendado");
    expect(personas[1].stage).toBe("turno_agendado");
  });

  it("sin nombre, el turno sigue siendo del titular", async () => {
    const { clinic, patient } = await crearClinica();
    await prisma.patient.update({ where: { id: patient.id }, data: { name: "Carlos Gómez" } });
    const { deps } = fakeDeps({
      bookOk: true,
      respuestas: [
        respuesta({
          intent: "confirmar",
          confirmacion_explicita: true,
          fecha_solicitada: LUNES,
          hora_solicitada: "09:00",
        }),
      ],
    });

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "sí, las 9" }, deps);

    const personas = await prisma.patient.findMany({
      where: { clinicId: clinic.id, phone: patient.phone },
    });
    expect(personas).toHaveLength(1);
    expect(personas[0].stage).toBe("turno_agendado");
  });

  it("el prompt ve a todas las personas del número, con sus turnos", async () => {
    const { clinic, patient } = await crearClinica();
    await prisma.patient.update({ where: { id: patient.id }, data: { name: "Carlos" } });
    const nieves = await prisma.patient.create({
      data: { clinicId: clinic.id, phone: patient.phone, name: "Nieves de García" },
    });
    await crearTurno({ clinic, patient: nieves, startTime: new Date("2030-06-17T13:00:00.000Z") });
    const { deps, llamadas } = fakeDeps();

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "hola" }, deps);

    const bloque = llamadas.interpret[0].turnosPaciente ?? "";
    expect(bloque).toContain("Carlos (quien escribe)");
    expect(bloque).toContain("Nieves de García");
    // El turno de Nieves se ve aunque escriba Carlos.
    expect(bloque).toContain("13:00");
  });
});

describe("cancelación", () => {
  const FUTURO = new Date("2030-06-17T13:00:00.000Z");

  describe("el motivo de la cancelación", () => {
    /** Una cancelación del paciente por WhatsApp, sin motivo, de hace una hora. */
    async function canceladaSinMotivo(clinic: ClinicWithCalendarAccount, patient: Patient, over?: { hace?: number; kind?: string }) {
      const id = await crearTurno({ clinic, patient, startTime: FUTURO, status: "cancelado" });
      const cancelledAt = new Date(Date.now() - (over?.hace ?? 1) * 60 * 60 * 1000);
      await prisma.appointment.update({
        where: { id },
        data: { cancelledAt, cancelledByKind: over?.kind ?? "paciente" },
      });
      await prisma.appointmentEvent.create({
        data: { clinicId: clinic.id, appointmentId: id, type: "cancelada", actorKind: "paciente" },
      });
      return id;
    }

    it("si lo dice al cancelar, se guarda en la cita y en su evento", async () => {
      const { clinic, patient } = await crearClinica();
      const turnoId = await crearTurno({ clinic, patient, startTime: FUTURO });
      const { deps } = fakeDeps({
        respuestas: [respuesta({ intent: "cancelar", turno_a_modificar: turnoId, motivo_cancelacion: "  Me salió un viaje  " })],
      });

      await runAgentTurn({ clinic, patient, from: patient.phone, text: "Cancelalo, me salió un viaje" }, deps);

      const turno = await prisma.appointment.findUniqueOrThrow({ where: { id: turnoId } });
      expect(turno).toMatchObject({ status: "cancelado", cancelledByKind: "paciente", cancelReason: "Me salió un viaje" });
      const evento = await prisma.appointmentEvent.findFirstOrThrow({ where: { appointmentId: turnoId } });
      expect(evento.reason).toBe("Me salió un viaje");
      // Un motivo que no es una queja no escala.
      expect(await prisma.escalation.count({ where: { clinicId: clinic.id } })).toBe(0);
    });

    it("si no lo dice, cancela igual y queda en blanco: preguntarlo nunca frena la cancelación", async () => {
      const { clinic, patient } = await crearClinica();
      const turnoId = await crearTurno({ clinic, patient, startTime: FUTURO });
      const { deps } = fakeDeps({
        respuestas: [respuesta({ intent: "cancelar", turno_a_modificar: turnoId, respuesta_al_paciente: "Listo. Si querés contarme el motivo, nos ayuda a mejorar." })],
      });
      await runAgentTurn({ clinic, patient, from: patient.phone, text: "Cancelalo" }, deps);
      const turno = await prisma.appointment.findUniqueOrThrow({ where: { id: turnoId } });
      expect(turno).toMatchObject({ status: "cancelado", cancelReason: null });
    });

    it("le muestra al modelo las cancelaciones recientes sin motivo, con su id", async () => {
      const { clinic, patient } = await crearClinica();
      const id = await canceladaSinMotivo(clinic, patient);
      const { deps } = fakeDeps();
      let recibido = "";
      const original = deps.interpret;
      deps.interpret = (async (params: { canceladasSinMotivo: string }) => {
        recibido = params.canceladasSinMotivo;
        return original(params as never);
      }) as AgentTurnDeps["interpret"];
      await runAgentTurn({ clinic, patient, from: patient.phone, text: "Hola" }, deps);
      expect(recibido).toContain(`id ${id}`);
      expect(recibido).toContain("2030-06-17");
    });

    it("si no hay ninguna, se lo dice (para que no invente un id)", async () => {
      const { clinic, patient } = await crearClinica();
      const { deps } = fakeDeps();
      let recibido = "";
      const original = deps.interpret;
      deps.interpret = (async (params: { canceladasSinMotivo: string }) => {
        recibido = params.canceladasSinMotivo;
        return original(params as never);
      }) as AgentTurnDeps["interpret"];
      await runAgentTurn({ clinic, patient, from: patient.phone, text: "Hola" }, deps);
      expect(recibido).toContain("no hay una cancelación reciente");
    });

    it("el motivo que llega DESPUÉS se le pone a esa cancelación, sin cancelar nada otra vez", async () => {
      const { clinic, patient } = await crearClinica();
      const id = await canceladaSinMotivo(clinic, patient);
      const otraVigente = await crearTurno({ clinic, patient, startTime: new Date("2030-06-18T13:00:00.000Z") });
      const { deps } = fakeDeps({
        respuestas: [respuesta({ intent: "otro", turno_cancelado: id, motivo_cancelacion: "Se me complicó el trabajo" })],
      });
      await runAgentTurn({ clinic, patient, from: patient.phone, text: "Es que se me complicó el trabajo" }, deps);

      const turno = await prisma.appointment.findUniqueOrThrow({ where: { id } });
      expect(turno.cancelReason).toBe("Se me complicó el trabajo");
      const evento = await prisma.appointmentEvent.findFirstOrThrow({ where: { appointmentId: id, type: "cancelada" } });
      expect(evento.reason).toBe("Se me complicó el trabajo");
      expect(evento.details).toMatchObject({ motivoDespues: true });
      // No cancela nada otra vez.
      expect((await prisma.appointment.findUniqueOrThrow({ where: { id: otraVigente } })).status).toBe("confirmado");
    });

    it("no pisa un motivo que ya estaba", async () => {
      const { clinic, patient } = await crearClinica();
      const id = await canceladaSinMotivo(clinic, patient);
      await prisma.appointment.update({ where: { id }, data: { cancelReason: "El original" } });
      const { deps } = fakeDeps({ respuestas: [respuesta({ turno_cancelado: id, motivo_cancelacion: "Otro distinto" })] });
      await runAgentTurn({ clinic, patient, from: patient.phone, text: "x" }, deps);
      expect((await prisma.appointment.findUniqueOrThrow({ where: { id } })).cancelReason).toBe("El original");
    });

    it("el id lo escribe el modelo: uno ajeno, viejo, de una reprogramación o de una cita vigente no sirve", async () => {
      const { clinic, patient } = await crearClinica();
      const otra = await crearClinica();
      const ajena = await canceladaSinMotivo(otra.clinic, otra.patient);
      const vieja = await canceladaSinMotivo(clinic, patient, { hace: 72 });
      const reprogramada = await canceladaSinMotivo(clinic, patient, { kind: "reprogramacion" });
      const vigente = await crearTurno({ clinic, patient, startTime: FUTURO });

      for (const id of [ajena, vieja, reprogramada, vigente, "id-inventado"]) {
        const { deps } = fakeDeps({ respuestas: [respuesta({ turno_cancelado: id, motivo_cancelacion: "No debería quedar" })] });
        await runAgentTurn({ clinic, patient, from: patient.phone, text: "x" }, deps);
      }
      for (const id of [ajena, vieja, reprogramada, vigente]) {
        expect((await prisma.appointment.findUniqueOrThrow({ where: { id } })).cancelReason).toBeNull();
      }
    });

    it("una QUEJA al cancelar llega siempre a una persona, aunque el modelo no haya marcado escalar", async () => {
      const { clinic, patient } = await crearClinica();
      const turnoId = await crearTurno({ clinic, patient, startTime: FUTURO });
      const { deps } = fakeDeps({
        respuestas: [
          respuesta({
            intent: "cancelar",
            turno_a_modificar: turnoId,
            motivo_cancelacion: "Esperé una hora la última vez",
            motivo_es_queja: true,
            escalar_a_humano: false, // el modelo se olvidó
          }),
        ],
      });
      await runAgentTurn({ clinic, patient, from: patient.phone, text: "Cancelalo, la última vez esperé una hora" }, deps);

      const evento = await prisma.appointmentEvent.findFirstOrThrow({ where: { appointmentId: turnoId } });
      expect(evento).toMatchObject({ type: "cancelada", reason: "Esperé una hora la última vez" });
      expect(evento.details).toMatchObject({ queja: true });
      const derivaciones = await prisma.escalation.findMany({ where: { clinicId: clinic.id } });
      expect(derivaciones).toHaveLength(1);
      expect(derivaciones[0].summary).toContain("Queja al cancelar una cita");
      expect(derivaciones[0].summary).toContain("Esperé una hora la última vez");
    });

    it("una queja contada DESPUÉS también se registra y se deriva", async () => {
      const { clinic, patient } = await crearClinica();
      const id = await canceladaSinMotivo(clinic, patient);
      const { deps } = fakeDeps({
        respuestas: [respuesta({ turno_cancelado: id, motivo_cancelacion: "Me trataron mal en recepción", motivo_es_queja: true })],
      });
      await runAgentTurn({ clinic, patient, from: patient.phone, text: "Me trataron mal en recepción" }, deps);
      const evento = await prisma.appointmentEvent.findFirstOrThrow({ where: { appointmentId: id, type: "cancelada" } });
      expect(evento.details).toMatchObject({ queja: true, motivoDespues: true });
      expect(await prisma.escalation.count({ where: { clinicId: clinic.id } })).toBe(1);
    });
  });

  it("cancela el turno cuando el modelo devuelve su id", async () => {
    const { clinic, patient } = await crearClinica();
    const turnoId = await crearTurno({ clinic, patient, startTime: FUTURO });
    const { deps } = fakeDeps({
      respuestas: [respuesta({ intent: "cancelar", turno_a_modificar: turnoId })],
    });

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Cancelalo" }, deps);

    const turno = await prisma.appointment.findUniqueOrThrow({ where: { id: turnoId } });
    expect(turno.status).toBe("cancelado");

    const actualizado = await prisma.patient.findUniqueOrThrow({ where: { id: patient.id } });
    expect(actualizado.stage).toBe("cancelado");
  });

  it("deja registrado que canceló el paciente por WhatsApp, y cuándo", async () => {
    const { clinic, patient } = await crearClinica();
    const turnoId = await crearTurno({ clinic, patient, startTime: FUTURO });
    const { deps } = fakeDeps({
      respuestas: [respuesta({ intent: "cancelar", turno_a_modificar: turnoId })],
    });

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Cancelalo" }, deps);

    const turno = await prisma.appointment.findUniqueOrThrow({ where: { id: turnoId } });
    expect(turno.cancelledByKind).toBe("paciente");
    expect(turno.cancelledByUserId).toBeNull();
    expect(turno.cancelledAt).toBeTruthy();
    const eventos = await prisma.appointmentEvent.findMany({ where: { appointmentId: turnoId } });
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({ type: "cancelada", actorKind: "paciente", actorUserId: null, clinicId: clinic.id });
  });

  /**
   * El id lo devuelve el modelo, así que puede venir alucinado o dictado por
   * el paciente. Si se buscara por id solo, alcanzaría con nombrar el id
   * ajeno para cancelarle el turno a otra persona.
   */
  it("no cancela el turno de otro paciente", async () => {
    const { clinic, patient } = await crearClinica();
    const otro = await prisma.patient.create({
      data: { clinicId: clinic.id, phone: `549${Math.floor(Math.random() * 1e9)}` },
    });
    const turnoAjeno = await crearTurno({ clinic, patient: otro, startTime: FUTURO });
    const { deps } = fakeDeps({
      respuestas: [respuesta({ intent: "cancelar", turno_a_modificar: turnoAjeno })],
    });

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Cancelalo" }, deps);

    const turno = await prisma.appointment.findUniqueOrThrow({ where: { id: turnoAjeno } });
    expect(turno.status).toBe("confirmado");
  });

  it("no cancela un turno de otra clínica", async () => {
    const { clinic, patient } = await crearClinica();
    const otraClinica = await crearClinica();
    const turnoAjeno = await crearTurno({
      clinic: otraClinica.clinic,
      patient: otraClinica.patient,
      startTime: FUTURO,
    });
    const { deps } = fakeDeps({
      respuestas: [respuesta({ intent: "cancelar", turno_a_modificar: turnoAjeno })],
    });

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Cancelalo" }, deps);

    const turno = await prisma.appointment.findUniqueOrThrow({ where: { id: turnoAjeno } });
    expect(turno.status).toBe("confirmado");
  });
});

describe("presentación del asistente y aviso de privacidad", () => {
  const URL = "https://clinica.example.com/aviso-de-privacidad";

  /** Una ficha nueva: todavía no se le mandó ni la presentación ni el aviso. */
  async function fichaNueva(url: string | null) {
    const { clinic, patient } = await crearClinica();
    await prisma.clinic.update({ where: { id: clinic.id }, data: { privacyNoticeUrl: url } });
    await prisma.patient.update({ where: { id: patient.id }, data: { privacyNoticeSentAt: null, assistantIntroSentAt: null } });
    return {
      clinic: (await prisma.clinic.findUniqueOrThrow({ where: { id: clinic.id }, include: { sharedCalendarAccount: true } })) as ClinicWithCalendarAccount,
      patient: await prisma.patient.findUniqueOrThrow({ where: { id: patient.id } }),
    };
  }
  const turno = async (c: Awaited<ReturnType<typeof fichaNueva>>, text: string, resp = "Claro.") => {
    const f = fakeDeps({ respuestas: [respuesta({ respuesta_al_paciente: resp })] });
    await runAgentTurn({ clinic: c.clinic, patient: c.patient, from: c.patient.phone, text }, f.deps);
    return f.llamadas.enviados;
  };

  it("el primer mensaje: UN solo mensaje, con quién lo atiende al comienzo y luego la respuesta; NO el link todavía", async () => {
    const c = await fichaNueva(URL);
    const enviados = await turno(c, "Hola", "Hola, ¿en qué le ayudo?");
    expect(enviados).toHaveLength(1);
    expect(enviados[0]).toBe(`Le atiende el asistente virtual de ${c.clinic.name}.\n\nHola, ¿en qué le ayudo?`);
    expect(enviados.join(" ")).not.toContain(URL);
    const f = await prisma.patient.findUniqueOrThrow({ where: { id: c.patient.id } });
    expect(f.assistantIntroSentAt).not.toBeNull();
    expect(f.privacyNoticeSentAt).toBeNull();
  });

  it("el segundo mensaje: la respuesta y después el aviso de privacidad; del tercero en adelante, nada", async () => {
    const c = await fichaNueva(URL);
    await turno(c, "Hola");
    const segundo = await turno(c, "Quiero una cita", "Con gusto, reviso la agenda.");
    expect(segundo).toHaveLength(2);
    expect(segundo[0]).toBe("Con gusto, reviso la agenda.");
    expect(segundo[1]).toBe(`Mientras tanto, le dejamos el aviso de privacidad de ${c.clinic.name}: ${URL}`);
    expect(await turno(c, "Gracias")).toEqual(["Claro."]);
  });

  it("queda en el historial y en la auditoría, sin el link ni el teléfono", async () => {
    const c = await fichaNueva(URL);
    await turno(c, "Hola");
    await turno(c, "Quiero una cita");
    const hist = await prisma.conversationMessage.findMany({ where: { clinicId: c.clinic.id }, orderBy: { createdAt: "asc" } });
    expect(hist.map((m) => m.role)).toEqual(["patient", "assistant", "patient", "assistant", "assistant"]);
    expect(hist[1].content).toMatch(/asistente virtual/);
    expect(hist[4].content).toContain(URL);

    const filas = await prisma.auditLog.findMany({
      where: { clinicId: c.clinic.id, action: { in: ["patient.assistant_intro_sent", "patient.privacy_notice_sent"] } },
    });
    expect(filas.map((f) => f.action).sort()).toEqual(["patient.assistant_intro_sent", "patient.privacy_notice_sent"]);
    for (const f of filas) {
      expect(f).toMatchObject({ origin: "whatsapp", resourceType: "patient", resourceId: c.patient.id, outcome: "ok" });
      expect(JSON.stringify(f)).not.toContain(URL);
      expect(JSON.stringify(f)).not.toContain(c.patient.phone);
    }
  });

  it("sin link cargado: se presenta, pero no manda ningún aviso ni marca el envío (lo recibirá cuando se cargue)", async () => {
    const c = await fichaNueva(null);
    await turno(c, "Hola");
    expect(await turno(c, "Quiero una cita")).toEqual(["Claro."]);
    expect((await prisma.patient.findUniqueOrThrow({ where: { id: c.patient.id } })).privacyNoticeSentAt).toBeNull();
    await prisma.clinic.update({ where: { id: c.clinic.id }, data: { privacyNoticeUrl: URL } });
    const c2 = { ...c, clinic: { ...c.clinic, privacyNoticeUrl: URL } };
    const tercero = await turno(c2, "¿Sigue ahí?");
    expect(tercero[1]).toContain(URL);
  });

  it("dos mensajes a la vez de la misma persona: la presentación sale una sola vez", async () => {
    const c = await fichaNueva(URL);
    const a = fakeDeps();
    const b = fakeDeps();
    await Promise.all([
      runAgentTurn({ clinic: c.clinic, patient: c.patient, from: c.patient.phone, text: "Hola" }, a.deps),
      runAgentTurn({ clinic: c.clinic, patient: c.patient, from: c.patient.phone, text: "¿Hay lugar?" }, b.deps),
    ]);
    const presentaciones = [...a.llamadas.enviados, ...b.llamadas.enviados].filter((m) => /asistente virtual/.test(m));
    expect(presentaciones).toHaveLength(1);
  });

  it("si falla el envío, la marca de la presentación se libera y la próxima respuesta la lleva", async () => {
    const c = await fichaNueva(URL);
    const { deps, llamadas } = fakeDeps();
    deps.send = (async () => {
      throw new Error("Meta caído");
    }) as AgentTurnDeps["send"];
    await expect(runAgentTurn({ clinic: c.clinic, patient: c.patient, from: c.patient.phone, text: "Hola" }, deps)).rejects.toThrow("Meta caído");
    expect(llamadas.enviados).toHaveLength(0);
    expect((await prisma.patient.findUniqueOrThrow({ where: { id: c.patient.id } })).assistantIntroSentAt).toBeNull();
    expect((await turno(c, "Hola otra vez"))[0]).toMatch(/^Le atiende el asistente virtual/);
  });

  it("el chat de pruebas no manda nada por WhatsApp, pero lo muestra como notas (y explica por qué falta el aviso si no hay link)", async () => {
    const c = await fichaNueva(URL);
    const f = fakeDeps();
    const notas: string[] = [];
    f.deps.sandbox = { notas };
    await runAgentTurn({ clinic: c.clinic, patient: c.patient, from: c.patient.phone, text: "Hola" }, f.deps);
    await runAgentTurn({ clinic: c.clinic, patient: c.patient, from: c.patient.phone, text: "Quiero una cita" }, f.deps);
    expect(f.llamadas.enviados.filter((m) => /asistente virtual|aviso de privacidad/.test(m))).toHaveLength(0);
    expect(notas.some((n) => /al comienzo de la primera respuesta: «Le atiende el asistente virtual/.test(n))).toBe(true);
    expect(notas.some((n) => n.includes(URL) && /después de esta respuesta/.test(n))).toBe(true);
    // Nada queda en el historial como si se hubiera mandado.
    const hist = await prisma.conversationMessage.findMany({ where: { clinicId: c.clinic.id, role: "assistant" } });
    expect(hist.some((m) => /asistente virtual|aviso de privacidad/.test(m.content))).toBe(false);

    const sin = await fichaNueva(null);
    const notas2: string[] = [];
    const g = fakeDeps();
    g.deps.sandbox = { notas: notas2 };
    await runAgentTurn({ clinic: sin.clinic, patient: sin.patient, from: sin.patient.phone, text: "Hola" }, g.deps);
    await runAgentTurn({ clinic: sin.clinic, patient: sin.patient, from: sin.patient.phone, text: "Quiero una cita" }, g.deps);
    expect(notas2.some((n) => /no cargó el link/.test(n))).toBe(true);
  });
});

describe("ubicación en el primer turno", () => {
  const FUTURO = new Date("2030-06-17T13:00:00.000Z");

  /** La respuesta con la que el paciente confirma un horario ofrecido. */
  function confirmacion(): ClaudeAgentResponse {
    return respuesta({
      intent: "confirmar",
      confirmacion_explicita: true,
      fecha_solicitada: LUNES,
      hora_solicitada: "09:00",
      respuesta_al_paciente: "Listo, quedó agendado.",
    });
  }

  async function conDireccion(clinic: ClinicWithCalendarAccount, datos: {
    address?: string | null;
    googleBusinessUrl?: string | null;
  }) {
    await prisma.clinic.update({ where: { id: clinic.id }, data: datos });
    return prisma.clinic.findUniqueOrThrow({
      where: { id: clinic.id },
      include: { sharedCalendarAccount: true },
    }) as Promise<ClinicWithCalendarAccount>;
  }

  it("manda la dirección después de confirmar el primer turno", async () => {
    const { clinic, patient } = await crearClinica();
    const conDatos = await conDireccion(clinic, { address: "Av. Siempreviva 742" });
    const { deps, llamadas } = fakeDeps({ bookOk: true, respuestas: [confirmacion()] });

    await runAgentTurn({ clinic: conDatos, patient, from: patient.phone, text: "Sí, las 9" }, deps);

    expect(llamadas.enviados).toHaveLength(2);
    // Segundo, no primero: lo que el paciente espera leer es la confirmación.
    expect(llamadas.enviados[0]).toBe("Listo, quedó agendado.");
    expect(llamadas.enviados[1]).toContain("Av. Siempreviva 742");
    expect(llamadas.enviados[1]).toContain("https://www.google.com/maps/search/");
  });

  it("no la manda si el paciente ya tenía un turno", async () => {
    const { clinic, patient } = await crearClinica();
    const conDatos = await conDireccion(clinic, { address: "Av. Siempreviva 742" });
    await crearTurno({ clinic: conDatos, patient, startTime: FUTURO });
    const { deps, llamadas } = fakeDeps({ bookOk: true, respuestas: [confirmacion()] });

    await runAgentTurn({ clinic: conDatos, patient, from: patient.phone, text: "Sí, las 9" }, deps);

    expect(llamadas.enviados).toEqual(["Listo, quedó agendado."]);
  });

  it("no la manda si el turno no se pudo crear", async () => {
    const { clinic, patient } = await crearClinica();
    const conDatos = await conDireccion(clinic, { address: "Av. Siempreviva 742" });
    const { deps, llamadas } = fakeDeps({ bookOk: false, respuestas: [confirmacion()] });

    await runAgentTurn({ clinic: conDatos, patient, from: patient.phone, text: "Sí, las 9" }, deps);

    expect(llamadas.enviados).toHaveLength(1);
  });

  it("no la manda si la clínica no cargó dirección ni link", async () => {
    const { clinic, patient } = await crearClinica();
    const { deps, llamadas } = fakeDeps({ bookOk: true, respuestas: [confirmacion()] });

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Sí, las 9" }, deps);

    expect(llamadas.enviados).toHaveLength(1);
  });

  it("la manda cuando el paciente la pide, sin que haya turno de por medio", async () => {
    const { clinic, patient } = await crearClinica();
    const conDatos = await conDireccion(clinic, { address: "Av. Siempreviva 742" });
    const { deps, llamadas } = fakeDeps({
      respuestas: [
        respuesta({
          intent: "consultar_info",
          pidio_ubicacion: true,
          respuesta_al_paciente: "Estamos en Av. Siempreviva 742.",
        }),
      ],
    });

    await runAgentTurn(
      { clinic: conDatos, patient, from: patient.phone, text: "¿dónde quedan?" },
      deps
    );

    expect(llamadas.enviados).toHaveLength(2);
    expect(llamadas.enviados[1]).toContain("Av. Siempreviva 742");
    expect(llamadas.enviados[1]).toContain("https://www.google.com/maps/search/");
  });

  it("no la duplica si además es su primer turno", async () => {
    const { clinic, patient } = await crearClinica();
    const conDatos = await conDireccion(clinic, { address: "Av. Siempreviva 742" });
    const { deps, llamadas } = fakeDeps({
      bookOk: true,
      respuestas: [{ ...confirmacion(), pidio_ubicacion: true }],
    });

    await runAgentTurn({ clinic: conDatos, patient, from: patient.phone, text: "Sí, las 9" }, deps);

    // Una sola vez, no dos.
    expect(llamadas.enviados).toHaveLength(2);
  });

  it("no manda nada si la pide y la clínica no la tiene cargada", async () => {
    const { clinic, patient } = await crearClinica();
    const { deps, llamadas } = fakeDeps({
      respuestas: [respuesta({ intent: "consultar_info", pidio_ubicacion: true })],
    });

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "¿dónde quedan?" }, deps);

    expect(llamadas.enviados).toHaveLength(1);
  });

  it("queda en el historial, como todo lo que recibe el paciente", async () => {
    const { clinic, patient } = await crearClinica();
    const conDatos = await conDireccion(clinic, { address: "Av. Siempreviva 742" });
    const { deps } = fakeDeps({ bookOk: true, respuestas: [confirmacion()] });

    await runAgentTurn({ clinic: conDatos, patient, from: patient.phone, text: "Sí, las 9" }, deps);

    const mensajes = await prisma.conversationMessage.findMany({
      where: { clinicId: clinic.id },
      orderBy: { createdAt: "asc" },
    });
    expect(mensajes.map((m) => m.role)).toEqual(["patient", "assistant", "assistant"]);
    expect(mensajes[2].content).toContain("Av. Siempreviva 742");
  });
});

describe("applyAvailabilityGuards", () => {
  const HUECOS = huecosDePrueba();

  it("no confirma si el modelo no dijo qué horario eligió el paciente", () => {
    const guardada = applyAvailabilityGuards(
      respuesta({ requiere_horarios_disponibles: true }),
      respuesta({ confirmacion_explicita: true }),
      HUECOS
    );
    expect(guardada.confirmacion_explicita).toBe(false);
  });

  it("no confirma un horario que no estaba entre los libres", () => {
    // El modelo podría inventarlo, y agendar a ciegas lo dejaría entrar.
    const guardada = applyAvailabilityGuards(
      respuesta({ requiere_horarios_disponibles: true }),
      respuesta({
        confirmacion_explicita: true,
        fecha_solicitada: LUNES,
        hora_solicitada: "23:00",
      }),
      HUECOS
    );
    expect(guardada.confirmacion_explicita).toBe(false);
  });

  it("confirma si el paciente eligió un hueco que estaba libre", () => {
    // Pasa cuando el paciente elige una opción y el modelo, de paso, vuelve a
    // pedir la agenda: no se le puede negar la confirmación.
    const guardada = applyAvailabilityGuards(
      respuesta({ requiere_horarios_disponibles: true }),
      respuesta({
        confirmacion_explicita: true,
        fecha_solicitada: LUNES,
        hora_solicitada: "09:00",
      }),
      HUECOS
    );
    expect(guardada.confirmacion_explicita).toBe(true);
  });

  it("corta el pedido de horarios de la segunda respuesta", () => {
    const guardada = applyAvailabilityGuards(
      respuesta({ requiere_horarios_disponibles: true }),
      respuesta({ requiere_horarios_disponibles: true }),
      HUECOS
    );
    expect(guardada.requiere_horarios_disponibles).toBe(false);
  });

  it("conserva el pedido de ubicación de la primera respuesta", () => {
    // "Quiero un turno, ¿dónde quedan?": lo marca la primera, y la segunda
    // —que solo ve los horarios— no tiene por qué repetirlo.
    const resultado = applyAvailabilityGuards(
      respuesta({ pidio_ubicacion: true }),
      respuesta({ pidio_ubicacion: false }),
      HUECOS
    );

    expect(resultado.pidio_ubicacion).toBe(true);
  });

  it("conserva el escalamiento de la primera respuesta", () => {
    const guardada = applyAvailabilityGuards(
      respuesta({ escalar_a_humano: true, motivo_escalar: "urgencia" }),
      respuesta({ escalar_a_humano: false, motivo_escalar: null }),
      HUECOS
    );
    expect(guardada.escalar_a_humano).toBe(true);
    expect(guardada.motivo_escalar).toBe("urgencia");
  });

  it("toma el escalamiento que detecta recién la segunda", () => {
    const guardada = applyAvailabilityGuards(
      respuesta(),
      respuesta({ escalar_a_humano: true, motivo_escalar: "otro" }),
      HUECOS
    );
    expect(guardada.escalar_a_humano).toBe(true);
    expect(guardada.motivo_escalar).toBe("otro");
  });
});

describe("el profesional que pide el paciente", () => {
  async function conDosProfesionales() {
    const { clinic, patient } = await crearClinica();
    const cyntia = await prisma.professional.create({
      data: { clinicId: clinic.id, name: "Cyntia Trujullo" },
    });
    return { clinic, patient, cyntia };
  }

  it("busca los horarios de ese profesional y no de cualquiera", async () => {
    const { clinic, patient, cyntia } = await conDosProfesionales();
    const { deps, llamadas } = fakeDeps({
      respuestas: [
        respuesta({ requiere_horarios_disponibles: true, profesional_solicitado: "Cyntia Trujullo" }),
        respuesta({ respuesta_al_paciente: "Con Cyntia tengo el lunes a las 9." }),
      ],
    });

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Con Cynthia por favor" }, deps);

    expect(llamadas.slotsParams[0].requestedProfessionalId).toBe(cyntia.id);
  });

  it("al confirmar, agenda con ese profesional y no con el primero libre", async () => {
    const { clinic, patient, cyntia } = await conDosProfesionales();
    const { deps, llamadas } = fakeDeps({
      bookOk: true,
      respuestas: [
        respuesta({ requiere_horarios_disponibles: true, profesional_solicitado: "Cyntia Trujullo" }),
        respuesta({
          confirmacion_explicita: true,
          fecha_solicitada: LUNES,
          hora_solicitada: "09:00",
          profesional_solicitado: "Cyntia Trujullo",
        }),
      ],
    });

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Con Cyntia, a las 9" }, deps);

    expect(llamadas.bookParams[0].requestedProfessionalId).toBe(cyntia.id);
  });

  it("si la segunda respuesta no repite el profesional, no se pierde el del primer mensaje", async () => {
    const primera = respuesta({ profesional_solicitado: "Cyntia Trujullo" });
    const segunda = respuesta({ profesional_solicitado: null });

    expect(applyAvailabilityGuards(primera, segunda, huecosDePrueba()).profesional_solicitado).toBe(
      "Cyntia Trujullo"
    );
  });

  it("sin pedido o con un nombre que no existe, no filtra: rige el primero libre", async () => {
    const { clinic, patient } = await conDosProfesionales();
    const { deps, llamadas } = fakeDeps({
      respuestas: [
        respuesta({ requiere_horarios_disponibles: true, profesional_solicitado: "Dr. Inexistente" }),
        respuesta(),
      ],
    });

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Quiero un turno" }, deps);

    expect(llamadas.slotsParams[0].requestedProfessionalId).toBeNull();
  });
});


describe("reprogramar y fallos de reserva", () => {
  const FUTURO = new Date("2030-06-17T13:00:00.000Z");

  it("al confirmar una reprogramación, agenda reemplazando la cita vieja (no solo lo dice)", async () => {
    const { clinic, patient } = await crearClinica();
    const turnoId = await crearTurno({ clinic, patient, startTime: FUTURO, service: "Limpieza" });
    const { deps, llamadas } = fakeDeps({
      bookOk: true,
      respuestas: [
        respuesta({
          intent: "reprogramar",
          turno_a_modificar: turnoId,
          servicio: null,
          fecha_solicitada: LUNES,
          hora_solicitada: "09:30",
          confirmacion_explicita: true,
        }),
      ],
    });

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "A las 9:30 está bien" }, deps);

    expect(llamadas.bookParams).toHaveLength(1);
    const params = llamadas.bookParams[0] as unknown as {
      replaceAppointmentId: string;
      requestedService: string;
      patient: { id: string };
    };
    expect(params.replaceAppointmentId).toBe(turnoId);
    // Sin servicio del modelo, rige el de la cita que se mueve.
    expect(params.requestedService).toBe("Limpieza");
    expect(params.patient.id).toBe(patient.id);
  });

  it("al buscar horarios para reprogramar, la cita que se mueve no cuenta como ocupada", async () => {
    const { clinic, patient } = await crearClinica();
    const turnoId = await crearTurno({ clinic, patient, startTime: FUTURO });
    const { deps, llamadas } = fakeDeps({
      respuestas: [
        respuesta({
          intent: "reprogramar",
          turno_a_modificar: turnoId,
          requiere_horarios_disponibles: true,
        }),
        respuesta({ intent: "reprogramar", turno_a_modificar: turnoId }),
      ],
    });

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Mejor más tarde" }, deps);

    expect(llamadas.slotsParams[0]).toMatchObject({ excludeAppointmentId: turnoId });
  });

  it("un id que no es una cita vigente de este número no reprograma ni agenda otra", async () => {
    const { clinic, patient } = await crearClinica();
    const otra = await crearClinica();
    const ajeno = await crearTurno({ clinic: otra.clinic, patient: otra.patient, startTime: FUTURO });
    const { deps, llamadas } = fakeDeps({
      bookOk: true,
      respuestas: [
        respuesta({
          intent: "reprogramar",
          turno_a_modificar: ajeno,
          fecha_solicitada: LUNES,
          hora_solicitada: "09:30",
          confirmacion_explicita: true,
          respuesta_al_paciente: "Listo, cambié tu cita.",
        }),
        respuesta({ respuesta_al_paciente: "Disculpa, no pude cambiarla todavía." }),
      ],
    });

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Sí" }, deps);

    expect(llamadas.bookParams).toHaveLength(0);
    const turno = await prisma.appointment.findUniqueOrThrow({ where: { id: ajeno } });
    expect(turno.status).toBe("confirmado");
    expect(llamadas.enviados[0]).toBe("Disculpa, no pude cambiarla todavía.");
  });

  it("si la reserva falla, el paciente NO recibe la confirmación que ya había redactado el modelo", async () => {
    const { clinic, patient } = await crearClinica();
    const { deps, llamadas } = fakeDeps({
      // bookOk apagado: el booking devuelve `sin_profesional_disponible`.
      respuestas: [
        respuesta({
          intent: "confirmar",
          fecha_solicitada: LUNES,
          hora_solicitada: "09:00",
          confirmacion_explicita: true,
          respuesta_al_paciente: "Perfecto, quedó agendado.",
        }),
        respuesta({
          respuesta_al_paciente: "Disculpa, ese horario ya no está. ¿Te sirve otro?",
          confirmacion_explicita: true,
          turno_a_modificar: "x",
        }),
      ],
    });

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Sí, ese" }, deps);

    expect(llamadas.enviados).toEqual(["Disculpa, ese horario ya no está. ¿Te sirve otro?"]);
    // La segunda llamada recibe el motivo y los horarios que sí hay.
    expect(llamadas.interpret[1].horariosDisponibles).toMatch(/NO se pudo agendar la cita/);
    expect(llamadas.interpret[1].horariosDisponibles).toMatch(/NO digas que quedó agendada/);
    expect(llamadas.interpret[1].horariosDisponibles).toMatch(/Horarios que sí hay/);
    // Solo redacción: no se vuelve a intentar agendar.
    expect(llamadas.bookParams).toHaveLength(1);
  });

  it("si además falla la explicación, sale un mensaje de disculpa en vez de la confirmación falsa", async () => {
    const { clinic, patient } = await crearClinica();
    const { deps, llamadas } = fakeDeps({
      interpretThrows: 1,
      respuestas: [
        respuesta({
          intent: "confirmar",
          fecha_solicitada: LUNES,
          hora_solicitada: "09:00",
          confirmacion_explicita: true,
          respuesta_al_paciente: "Perfecto, quedó agendado.",
        }),
      ],
    });

    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Sí" }, deps);

    expect(llamadas.enviados).toHaveLength(1);
    expect(llamadas.enviados[0]).not.toMatch(/quedó agendado/);
    expect(llamadas.enviados[0]).toMatch(/no pude concretar/);
  });
});

describe("la auditoría del CRM en el turno del asistente", () => {
  const FUTURO = new Date("2030-06-17T13:00:00.000Z");
  const etapas = (clinicId: string) =>
    prisma.auditLog.findMany({ where: { clinicId, action: "patient.stage_change" }, orderBy: { occurredAt: "asc" } });

  it("el primer mensaje de un contacto nuevo lo pasa a 'interesado' y queda registrado, con origen 'whatsapp'", async () => {
    const { clinic, patient } = await crearClinica();
    const { deps } = fakeDeps();
    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Hola" }, deps);

    const [fila] = await etapas(clinic.id);
    expect(fila).toMatchObject({ origin: "whatsapp", resourceId: patient.id, userId: null, outcome: "ok" });
    expect(fila.details).toEqual({ desde: "nuevo_contacto", hasta: "interesado", motivo: "primer_mensaje" });
  });

  it("un segundo mensaje del mismo paciente no vuelve a registrar nada", async () => {
    const { clinic, patient } = await crearClinica();
    const { deps } = fakeDeps();
    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Hola" }, deps);
    const actualizado = await prisma.patient.findUniqueOrThrow({ where: { id: patient.id } });
    await runAgentTurn({ clinic, patient: actualizado, from: patient.phone, text: "Gracias" }, deps);
    expect(await etapas(clinic.id)).toHaveLength(1);
  });

  it("cancelar por WhatsApp pasa al paciente a 'cancelado' y lo registra con su motivo", async () => {
    const { clinic, patient } = await crearClinica();
    const turnoId = await crearTurno({ clinic, patient, startTime: FUTURO });
    const { deps } = fakeDeps({
      respuestas: [respuesta({ intent: "cancelar", turno_a_modificar: turnoId })],
    });
    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Cancelalo" }, deps);

    const filas = await etapas(clinic.id);
    const cancelacion = filas.find((f) => (f.details as { hasta: string }).hasta === "cancelado");
    expect(cancelacion).toMatchObject({ origin: "whatsapp" });
    expect(cancelacion?.details).toMatchObject({ motivo: "cancelacion" });
  });

  it("no guarda nada del mensaje ni del paciente en esos registros", async () => {
    const { clinic, patient } = await crearClinica();
    const { deps } = fakeDeps();
    await runAgentTurn({ clinic, patient, from: patient.phone, text: "MENSAJE-QUE-NO-DEBE-QUEDAR" }, deps);
    const todo = JSON.stringify(await etapas(clinic.id));
    expect(todo).not.toContain("MENSAJE-QUE-NO-DEBE-QUEDAR");
    expect(todo).not.toContain(patient.phone);
  });
});


describe("la campaña por la que llegó el paciente", () => {
  async function conCampana(options?: { endsOn?: string; description?: string | null; serviceName?: string }) {
    const base = await crearClinica();
    // El servicio de la promoción es obligatorio y tiene que tener quién lo atienda.
    const profesional = await prisma.professional.findFirstOrThrow({ where: { clinicId: base.clinic.id } });
    const servicio = await prisma.service.create({
      data: { clinicId: base.clinic.id, name: options?.serviceName ?? "Consulta", durationMinutes: 30, professionals: { connect: [{ id: profesional.id }] } },
    });
    const c = await createCampaign(base.clinic.id, {
      name: "Limpieza de verano",
      channel: "Instagram",
      description: options?.description === undefined ? "20 % de descuento" : options.description,
      endsOn: options?.endsOn,
      serviceId: servicio.id,
      triggers: [{ kind: "texto", value: "promo de verano" }],
    });
    if (!c.ok) throw new Error(c.message);
    const lead = (await recordCampaignContact({ clinicId: base.clinic.id, phone: base.patient.phone, text: "hola, la promo de verano" })).lead!;
    return { ...base, campana: c.value, lead };
  }

  it("sin campaña, el asistente recibe que no llegó por ninguna", async () => {
    const { clinic, patient } = await crearClinica();
    const { deps, llamadas } = fakeDeps();
    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Hola" }, deps);
    expect(llamadas.interpret[0].campana).toBe(SIN_CAMPANA);
  });

  it("con una campaña vigente, el asistente sabe cuál es, qué es la promoción y qué servicio", async () => {
    const { clinic, patient } = await conCampana({ serviceName: "Limpieza" });
    const { deps, llamadas } = fakeDeps();
    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Hola, la promo de verano" }, deps);

    const t = llamadas.interpret[0].campana!;
    expect(t).toContain('"Limpieza de verano"');
    expect(t).toContain("canal: Instagram");
    expect(t).toContain("VIGENTE");
    expect(t).toContain("20 % de descuento");
    expect(t).toContain("Servicio de la promoción: Limpieza.");
  });

  it("una campaña vencida sigue conocida, pero el asistente la recibe como que ya no rige y sin el detalle", async () => {
    const { clinic, patient } = await conCampana({ endsOn: "2020-01-01" });
    const { deps, llamadas } = fakeDeps();
    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Hola" }, deps);
    const t = llamadas.interpret[0].campana!;
    expect(t).toMatch(/YA NO ESTÁ VIGENTE/);
    expect(t).not.toContain("20 % de descuento");
  });

  it("todas las llamadas al modelo del mismo mensaje reciben la campaña", async () => {
    const { clinic, patient } = await conCampana();
    const { deps, llamadas } = fakeDeps({ respuestas: [respuesta({ requiere_horarios_disponibles: true }), respuesta()] });
    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Quiero turno" }, deps);
    expect(llamadas.interpret).toHaveLength(2);
    expect(llamadas.interpret.every((x) => x.campana?.includes("Limpieza de verano"))).toBe(true);
  });

  it("la campaña viaja a la consulta de horarios y a la reserva, y al agendar el contacto pasa a convertido", async () => {
    const { clinic, patient, campana, lead } = await conCampana();
    const { deps, llamadas } = fakeDeps({
      bookOk: true,
      respuestas: [
        respuesta({ requiere_horarios_disponibles: true, fecha_solicitada: LUNES, hora_solicitada: "09:00" }),
        respuesta({ intent: "confirmar", confirmacion_explicita: true, fecha_solicitada: LUNES, hora_solicitada: "09:00" }),
      ],
    });
    await runAgentTurn({ clinic, patient, from: patient.phone, text: "El lunes a las 9" }, deps);

    expect(llamadas.slotsParams[0].campaignId).toBe(campana.id);
    expect(llamadas.bookParams[0].campaignId).toBe(campana.id);
    expect(await prisma.campaignLead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({ status: "convertido" });
  });

  it("si la reserva falla, el contacto sigue abierto (no agendó)", async () => {
    const { clinic, patient, lead } = await conCampana();
    const { deps } = fakeDeps({
      bookOk: false,
      respuestas: [respuesta({ intent: "confirmar", confirmacion_explicita: true, fecha_solicitada: LUNES, hora_solicitada: "09:00" })],
    });
    await runAgentTurn({ clinic, patient, from: patient.phone, text: "El lunes a las 9" }, deps);
    expect((await prisma.campaignLead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe("abierto");
  });

  it("si no se puede leer la campaña, el turno sigue como cualquier mensaje", async () => {
    const { clinic, patient } = await conCampana();
    // No se espía a Prisma (sus delegados no se restauran y rompen los tests siguientes): se rompe la lectura de la campaña.
    falla.contexto = true;
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { deps, llamadas } = fakeDeps();
      await runAgentTurn({ clinic, patient, from: patient.phone, text: "Hola" }, deps);
      expect(llamadas.interpret[0].campana).toBe(SIN_CAMPANA);
      expect(llamadas.enviados).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });
});


describe("reconocer la promoción por lo que dice la persona", () => {
  /** Una clínica con una promoción vigente y SIN ningún contacto: nadie escribió todavía la frase de un formato. */
  async function conPromocion(over: { endsOn?: string; active?: boolean; description?: string } = {}) {
    const base = await crearClinica();
    const profesional = await prisma.professional.findFirstOrThrow({ where: { clinicId: base.clinic.id } });
    const servicio = await prisma.service.create({
      data: { clinicId: base.clinic.id, name: "Diagnóstico inicial", durationMinutes: 30, professionals: { connect: [{ id: profesional.id }] } },
    });
    const c = await createCampaign(base.clinic.id, {
      name: "Implantes", description: over.description ?? "20 % de descuento en cada implante", serviceId: servicio.id,
      endsOn: over.endsOn, active: over.active, triggers: [{ kind: "texto", value: "frase exacta del flyer" }],
    });
    if (!c.ok) throw new Error(c.message);
    return { ...base, campana: c.value };
  }
  const lead = (clinicId: string) => prisma.campaignLead.findFirst({ where: { clinicId } });

  it("el asistente recibe las promociones vigentes de la clínica en cada llamada, con su detalle", async () => {
    const { clinic, patient } = await conPromocion();
    const { deps, llamadas } = fakeDeps({ respuestas: [respuesta({ requiere_horarios_disponibles: true }), respuesta()] });
    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Hola, ¿tienen promociones?" }, deps);
    expect(llamadas.interpret).toHaveLength(2);
    for (const l of llamadas.interpret) {
      expect(l.promociones).toContain('"Implantes"');
      expect(l.promociones).toContain("20 % de descuento en cada implante");
      expect(l.promociones).toContain("Servicio: Diagnóstico inicial.");
      expect(l.promociones).toContain("Lo atienden: Dra. Ejemplo.");
    }
  });

  it("nunca le muestra una promoción vencida, desactivada o sin vigencia; sin ninguna, lo dice", async () => {
    for (const over of [{ endsOn: "2020-01-01" }, { active: false }]) {
      const { clinic, patient } = await conPromocion(over);
      const { deps, llamadas } = fakeDeps();
      await runAgentTurn({ clinic, patient, from: patient.phone, text: "Hola" }, deps);
      expect(llamadas.interpret[0].promociones, JSON.stringify(over)).toBe(SIN_PROMOCIONES);
    }
    const sin = await crearClinica();
    const { deps, llamadas } = fakeDeps();
    await runAgentTurn({ clinic: sin.clinic, patient: sin.patient, from: sin.patient.phone, text: "Hola" }, deps);
    expect(llamadas.interpret[0].promociones).toBe(SIN_PROMOCIONES);
  });

  it("si el asistente reconoce la promoción, se crea el contacto con el origen 'asistente' y como contacto nuevo", async () => {
    const { clinic, patient, campana } = await conPromocion();
    expect(await lead(clinic.id)).toBeNull();
    const { deps } = fakeDeps({ respuestas: [respuesta({ campana_mencionada: "Implantes", respuesta_al_paciente: "Sí, tenemos esa promoción." })] });
    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Hola, escribo por la promoción en implantes dentales" }, deps);

    expect(await lead(clinic.id)).toMatchObject({ campaignId: campana.id, triggerKind: "asistente", isNewContact: true, status: "abierto", patientPhone: patient.phone });
    expect(await prisma.auditLog.count({ where: { clinicId: clinic.id, action: "campaign.lead_create" } })).toBe(1);
  });

  it("no es un contacto nuevo si ya había conversado antes", async () => {
    const { clinic, patient } = await conPromocion();
    await prisma.conversationMessage.create({ data: { clinicId: clinic.id, patientPhone: patient.phone, role: "patient", content: "hola" } });
    const { deps } = fakeDeps({ respuestas: [respuesta({ campana_mencionada: "Implantes" })] });
    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Vengo por la promo de implantes" }, deps);
    expect((await lead(clinic.id))?.isNewContact).toBe(false);
  });

  it("el resto del MISMO turno ya tiene la campaña: el contexto, los horarios y la reserva", async () => {
    const { clinic, patient, campana } = await conPromocion();
    const { deps, llamadas } = fakeDeps({
      bookOk: true,
      respuestas: [
        respuesta({ campana_mencionada: "Implantes", requiere_horarios_disponibles: true, fecha_solicitada: LUNES, hora_solicitada: "09:00" }),
        respuesta({ intent: "confirmar", confirmacion_explicita: true, fecha_solicitada: LUNES, hora_solicitada: "09:00" }),
      ],
    });
    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Vengo por la promo de implantes, el lunes a las 9" }, deps);

    expect(llamadas.interpret[0].campana).toBe(SIN_CAMPANA); // todavía no se había reconocido
    expect(llamadas.interpret[1].campana).toContain('"Implantes"');
    expect(llamadas.interpret[1].campana).toContain("VIGENTE");
    expect(llamadas.slotsParams[0].campaignId).toBe(campana.id);
    expect(llamadas.bookParams[0].campaignId).toBe(campana.id);
    expect(await lead(clinic.id)).toMatchObject({ status: "convertido" });
  });

  it("un nombre que no es el de una promoción vigente no atribuye nada", async () => {
    const { clinic, patient } = await conPromocion();
    const { deps } = fakeDeps({ respuestas: [respuesta({ campana_mencionada: "Ortodoncia gratis", respuesta_al_paciente: "Eso lo confirma alguien." })] });
    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Vengo por la promo de ortodoncia" }, deps);
    expect(await lead(clinic.id)).toBeNull();
  });

  it("si la persona ya llegó por un formato, lo que diga después no la cambia de campaña", async () => {
    const { clinic, patient, campana, servicio } = Object.assign(await conPromocion(), {});
    const otra = await createCampaign(clinic.id, { name: "Limpieza", serviceId: campana.serviceId!, triggers: [{ kind: "texto", value: "frase de limpieza" }] });
    if (!otra.ok) throw new Error(otra.message);
    await recordCampaignContact({ clinicId: clinic.id, phone: patient.phone, text: "frase exacta del flyer" }); // llegó por Implantes
    const { deps, llamadas } = fakeDeps({ respuestas: [respuesta({ campana_mencionada: "Limpieza" })] });
    await runAgentTurn({ clinic, patient, from: patient.phone, text: "Y la de limpieza?" }, deps);

    expect(await prisma.campaignLead.findMany({ where: { clinicId: clinic.id } })).toHaveLength(1);
    expect(llamadas.interpret[0].campana).toContain('"Implantes"');
    expect(servicio).toBeUndefined(); // (el fixture no lo expone: solo se verifica que no rompa)
  });

  it("si falla el registro de la promoción, el turno sigue y el paciente recibe su respuesta", async () => {
    const { clinic, patient } = await conPromocion();
    falla.mencion = true;
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { deps, llamadas } = fakeDeps({ respuestas: [respuesta({ campana_mencionada: "Implantes", respuesta_al_paciente: "Sí, tenemos esa promoción." })] });
      await runAgentTurn({ clinic, patient, from: patient.phone, text: "Vengo por la promo de implantes" }, deps);
      expect(llamadas.enviados).toEqual(["Sí, tenemos esa promoción."]);
    } finally {
      log.mockRestore();
    }
  });
});


describe("no se agenda sin el nombre y el apellido", () => {
  const confirmar = (over: Partial<ClaudeAgentResponse> = {}) =>
    respuesta({ intent: "confirmar", confirmacion_explicita: true, fecha_solicitada: LUNES, hora_solicitada: "09:00", ...over });
  const conNombre = (clinic: { id: string }, patientId: string, name: string | null, parts?: { firstName: string; lastName: string }) =>
    prisma.patient.update({ where: { id: patientId }, data: { name, firstName: parts?.firstName ?? null, lastName: parts?.lastName ?? null } });
  const citas = (clinicId: string) => prisma.appointment.count({ where: { clinicId } });

  it("elegir el horario sin haber dado el nombre NO agenda: el asistente pide nombre y apellido, sin decir que quedó agendada", async () => {
    const { clinic, patient } = await crearClinica();
    await conNombre(clinic, patient.id, null);
    const { deps, llamadas } = fakeDeps({
      bookOk: true,
      respuestas: [confirmar({ respuesta_al_paciente: "Listo, quedó agendado." }), respuesta({ respuesta_al_paciente: "¿Me compartes tu nombre y apellido para dejarla agendada?" })],
    });
    await runAgentTurn({ clinic, patient, from: patient.phone, text: "las 9" }, deps);

    expect(llamadas.bookParams).toHaveLength(0); // no se intentó agendar
    expect(llamadas.enviados).toEqual(["¿Me compartes tu nombre y apellido para dejarla agendada?"]); // no la confirmación que ya había redactado
    expect(await citas(clinic.id)).toBe(0);
    // Al modelo se le explicó por qué, sin ofrecerle horarios alternativos.
    expect(llamadas.interpret).toHaveLength(2);
    expect(llamadas.interpret[1].horariosDisponibles).toMatch(/falta el nombre y el apellido/);
    expect(llamadas.interpret[1].horariosDisponibles).toMatch(/horario elegido: 2030-06-17 09:00/);
    expect(llamadas.interpret[1].horariosDisponibles).not.toMatch(/Horarios que sí hay/);
    expect(llamadas.slots).toBe(0); // y no se fue a buscar otros horarios
  });

  it("si el nombre llega en el mismo mensaje en que confirma, agenda", async () => {
    const { clinic, patient } = await crearClinica();
    await conNombre(clinic, patient.id, null);
    const { deps, llamadas } = fakeDeps({ bookOk: true, respuestas: [confirmar({ nombre_paciente: "Juana", apellido_paciente: "Petronila" })] });
    await runAgentTurn({ clinic, patient, from: patient.phone, text: "juana petronila" }, deps);

    expect(llamadas.bookParams).toHaveLength(1);
    expect(await prisma.patient.findUniqueOrThrow({ where: { id: patient.id } })).toMatchObject({ name: "Juana Petronila", firstName: "Juana", lastName: "Petronila" });
  });

  it("el nombre que llega recién en la segunda llamada al modelo también cuenta", async () => {
    const { clinic, patient } = await crearClinica();
    await conNombre(clinic, patient.id, null);
    const { deps, llamadas } = fakeDeps({
      bookOk: true,
      respuestas: [respuesta({ requiere_horarios_disponibles: true, fecha_solicitada: LUNES, hora_solicitada: "09:00" }), confirmar({ nombre_paciente: "Juana", apellido_paciente: "Pérez" })],
    });
    await runAgentTurn({ clinic, patient, from: patient.phone, text: "las 9, soy Juana Pérez" }, deps);
    expect(llamadas.bookParams).toHaveLength(1);
  });

  it("con solo el nombre de pila sigue pidiendo el apellido; cuando lo da, se completa la ficha y agenda", async () => {
    const { clinic, patient } = await crearClinica();
    await conNombre(clinic, patient.id, "Juana");
    const primero = fakeDeps({ bookOk: true, respuestas: [confirmar({ nombre_paciente: "Juana" }), respuesta({ respuesta_al_paciente: "¿Y tu apellido?" })] });
    await runAgentTurn({ clinic, patient, from: patient.phone, text: "las 9, soy Juana" }, primero.deps);
    expect(primero.llamadas.bookParams).toHaveLength(0);
    expect(primero.llamadas.enviados).toEqual(["¿Y tu apellido?"]);

    const siguiente = fakeDeps({ bookOk: true, respuestas: [confirmar({ nombre_paciente: "Juana", apellido_paciente: "Petronila" })] });
    await runAgentTurn({ clinic, patient: await prisma.patient.findUniqueOrThrow({ where: { id: patient.id } }), from: patient.phone, text: "Petronila" }, siguiente.deps);
    expect(siguiente.llamadas.bookParams).toHaveLength(1);
    expect(await prisma.patient.findUniqueOrThrow({ where: { id: patient.id } })).toMatchObject({ name: "Juana Petronila", lastName: "Petronila" });
  });

  it("una ficha que ya tiene nombre y apellido (partido o completo) agenda sin pedir nada", async () => {
    for (const ficha of [{ name: "Juana Petronila", parts: undefined }, { name: "Juana Petronila", parts: { firstName: "Juana", lastName: "Petronila" } }, { name: "Ana María García López", parts: undefined }]) {
      const { clinic, patient } = await crearClinica();
      await conNombre(clinic, patient.id, ficha.name, ficha.parts);
      const { deps, llamadas } = fakeDeps({ bookOk: true, respuestas: [confirmar()] });
      await runAgentTurn({ clinic, patient, from: patient.phone, text: "las 9" }, deps);
      expect(llamadas.bookParams, ficha.name).toHaveLength(1);
    }
  });

  it("no pisa un nombre completo ya cargado con lo que diga el modelo", async () => {
    const { clinic, patient } = await crearClinica();
    await conNombre(clinic, patient.id, "Juana Petronila");
    const { deps } = fakeDeps({ bookOk: true, respuestas: [confirmar({ nombre_paciente: "Otro", apellido_paciente: "Nombre" })] });
    await runAgentTurn({ clinic, patient, from: patient.phone, text: "las 9" }, deps);
    expect((await prisma.patient.findUniqueOrThrow({ where: { id: patient.id } })).name).toBe("Juana Petronila");
  });

  it("para otra persona del número: con nombre y apellido agenda; con solo el nombre, pide el apellido", async () => {
    const completo = await crearClinica();
    await conNombre(completo.clinic, completo.patient.id, "Carlos Gómez");
    const a = fakeDeps({ bookOk: true, respuestas: [confirmar({ paciente_del_turno: "Nieves García" })] });
    await runAgentTurn({ clinic: completo.clinic, patient: completo.patient, from: completo.patient.phone, text: "para Nieves García, las 9" }, a.deps);
    expect(a.llamadas.bookParams).toHaveLength(1);

    const sinApellido = await crearClinica();
    await conNombre(sinApellido.clinic, sinApellido.patient.id, "Carlos Gómez");
    const b = fakeDeps({ bookOk: true, respuestas: [confirmar({ paciente_del_turno: "Nieves" }), respuesta({ respuesta_al_paciente: "¿Cuál es el apellido de Nieves?" })] });
    await runAgentTurn({ clinic: sinApellido.clinic, patient: sinApellido.patient, from: sinApellido.patient.phone, text: "para Nieves, las 9" }, b.deps);
    expect(b.llamadas.bookParams).toHaveLength(0);
    expect(b.llamadas.enviados).toEqual(["¿Cuál es el apellido de Nieves?"]);
  });

  it("si falla incluso la redacción del asistente, sale una frase fija que pide los datos (no 'no pude concretar ese horario')", async () => {
    const { clinic, patient } = await crearClinica();
    await conNombre(clinic, patient.id, null);
    const { deps, llamadas } = fakeDeps({ bookOk: true, respuestas: [confirmar()], interpretThrows: 1 });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await runAgentTurn({ clinic, patient, from: patient.phone, text: "las 9" }, deps);
    } finally {
      log.mockRestore();
    }
    expect(llamadas.enviados).toEqual(["Para dejar su cita agendada necesito su nombre y apellido. ¿Me los indica?"]);
    expect(await citas(clinic.id)).toBe(0);
  });

  it("reprogramar una cita que ya tiene no pide el nombre de nuevo", async () => {
    const { clinic, patient } = await crearClinica();
    await conNombre(clinic, patient.id, null); // ficha vieja, de antes de esta regla
    const turnoId = await crearTurno({ clinic, patient, startTime: new Date("2030-06-18T13:00:00.000Z") });
    const { deps, llamadas } = fakeDeps({
      bookOk: true,
      respuestas: [respuesta({ intent: "reprogramar", confirmacion_explicita: true, turno_a_modificar: turnoId, fecha_solicitada: LUNES, hora_solicitada: "09:00" })],
    });
    await runAgentTurn({ clinic, patient, from: patient.phone, text: "mejor el lunes a las 9" }, deps);
    expect(llamadas.bookParams).toHaveLength(1);
  });

  it("la regla del prompt le pide al modelo confirmar el nombre antes, y repetir fecha y hora cuando lo da", () => {
    const prompt = buildSystemPrompt({ name: "C", customerNoun: "paciente", escalationCriteria: "x", country: "MX", timezone: "UTC", address: null, minLeadMinutes: 0, services: "x" } as never, { esPrimeraVez: false });
    expect(prompt).toContain("Antes de agendar necesitas el NOMBRE y el APELLIDO");
    expect(prompt).toMatch(/NO marques "confirmacion_explicita"\s+aunque ya haya elegido horario/);
    expect(prompt).toContain("repitiendo la\n   fecha y la hora que había elegido");
    expect(prompt).toContain('Nunca digas\n   "quedó agendada" ni "le agendé" mientras te falten el nombre y el apellido');
  });
});

describe("corregir el nombre de quien escribe", () => {
  const conFicha = (patientId: string, name: string, firstName: string, lastName: string) =>
    prisma.patient.update({ where: { id: patientId }, data: { name, firstName, lastName } });
  const leer = (id: string) => prisma.patient.findUniqueOrThrow({ where: { id } });

  it("con corrige_nombre reemplaza el nombre de la ficha y conserva el apellido si no vino", async () => {
    const { clinic, patient } = await crearClinica();
    const ficha = await conFicha(patient.id, "Maía Bolivar", "Maía", "Bolivar");
    const { deps } = fakeDeps({ respuestas: [respuesta({ corrige_nombre: true, nombre_paciente: "María", apellido_paciente: null })] });
    await runAgentTurn({ clinic, patient: ficha, from: patient.phone, text: "te di mi nombre mal, es María" }, deps);
    expect(await leer(patient.id)).toMatchObject({ name: "María Bolivar", firstName: "María", lastName: "Bolivar" });
  });

  it("si la corrección trae también el apellido, se usa", async () => {
    const { clinic, patient } = await crearClinica();
    const ficha = await conFicha(patient.id, "Maía Bolivar", "Maía", "Bolivar");
    const { deps } = fakeDeps({ respuestas: [respuesta({ corrige_nombre: true, nombre_paciente: "María", apellido_paciente: "Bolívar" })] });
    await runAgentTurn({ clinic, patient: ficha, from: patient.phone, text: "es María Bolívar" }, deps);
    expect(await leer(patient.id)).toMatchObject({ name: "María Bolívar", firstName: "María", lastName: "Bolívar" });
  });

  it("sin la marca, un nombre ya cargado NO se pisa (otra persona hablando, o un nombre suelto)", async () => {
    const { clinic, patient } = await crearClinica();
    const ficha = await conFicha(patient.id, "Maía Bolivar", "Maía", "Bolivar");
    const { deps } = fakeDeps({ respuestas: [respuesta({ nombre_paciente: "Pedro", apellido_paciente: "Gómez" })] });
    await runAgentTurn({ clinic, patient: ficha, from: patient.phone, text: "hola" }, deps);
    expect(await leer(patient.id)).toMatchObject({ name: "Maía Bolivar", firstName: "Maía", lastName: "Bolivar" });
  });

  it("la corrección queda auditada sin guardar el nombre", async () => {
    const { clinic, patient } = await crearClinica();
    const ficha = await conFicha(patient.id, "Maía Bolivar", "Maía", "Bolivar");
    const { deps } = fakeDeps({ respuestas: [respuesta({ corrige_nombre: true, nombre_paciente: "María" })] });
    await runAgentTurn({ clinic, patient: ficha, from: patient.phone, text: "es María" }, deps);
    const fila = await prisma.auditLog.findFirst({ where: { clinicId: clinic.id, action: "patient.name_set", resourceId: patient.id }, orderBy: { occurredAt: "desc" } });
    expect(fila?.origin).toBe("whatsapp");
    expect(JSON.stringify(fila?.details)).toContain("correccion");
    expect(JSON.stringify(fila)).not.toMatch(/María|Bolivar/);
  });
});
