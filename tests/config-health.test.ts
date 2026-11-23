import { afterEach, describe, expect, it } from "vitest";
import type { Clinic, Weekday } from "@prisma/client";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import { getConfigHealth } from "../src/services/config-health";
import {
  applyHolidays,
  countPendingHolidays,
  holidaySuggestionsForClinic,
} from "../src/services/holidays";
import { upsertScheduleException } from "../src/services/working-hours";
import { alertClinicsPendingHolidays } from "../src/jobs/config-alerts";

/**
 * Sugerencias de feriados y salud de configuración. Contra el Postgres
 * local: docker compose up -d db
 */

const DIAS_DE_SEMANA: Weekday[] = ["lunes", "martes", "miercoles", "jueves", "viernes"];
const clinicIds: string[] = [];

async function crearClinica(options?: {
  conHorario?: boolean;
  country?: string | null;
  conCalendario?: boolean;
  sinAviso?: boolean;
}): Promise<Clinic> {
  const conHorario = options?.conHorario ?? true;

  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica cfg ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `cfg-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "test@example.com",
      timezone: "America/Argentina/Buenos_Aires",
      services: "Consulta",
      privacyNoticeUrl: options?.sinAviso ? null : "https://clinica.example.com/privacidad",
      country: options?.country === undefined ? "AR" : options.country,
      ...(options?.conCalendario ? { sharedCalendarId: "test@group.calendar.google.com" } : {}),
      professionals: { create: [{ name: "Profesional 1" }] },
      rooms: { create: [{ name: "Sala 1" }] },
      ...(conHorario
        ? {
            workingHours: {
              create: DIAS_DE_SEMANA.map((weekday) => ({
                weekday,
                startMinute: 9 * 60,
                endMinute: 18 * 60,
              })),
            },
          }
        : {}),
    },
  });

  clinicIds.push(clinic.id);
  return clinic;
}

afterEach(async () => {
  for (const clinicId of clinicIds) {
    await prisma.appointment.deleteMany({ where: { clinicId } });
    await prisma.scheduleException.deleteMany({ where: { clinicId } });
    await prisma.workingHours.deleteMany({ where: { clinicId } });
    await prisma.patient.deleteMany({ where: { clinicId } });
    await prisma.room.deleteMany({ where: { clinicId } });
    await prisma.professional.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
});

describe("sugerencias de feriados", () => {
  it("marca como pendientes los feriados que no están cargados", async () => {
    const clinic = await crearClinica();
    const { country, sugerencias } = await holidaySuggestionsForClinic({
      clinicId: clinic.id,
      year: 2026,
    });

    expect(country).toBe("AR");
    expect(sugerencias.length).toBeGreaterThan(0);
    expect(sugerencias.every((s) => !s.yaCargado)).toBe(true);
  });

  it("marca como cargado el feriado que ya tiene excepción", async () => {
    const clinic = await crearClinica();

    await upsertScheduleException({
      clinicId: clinic.id,
      input: { dateKey: "2026-12-25", reason: "Navidad" },
    });

    const { sugerencias } = await holidaySuggestionsForClinic({
      clinicId: clinic.id,
      year: 2026,
    });

    const navidad = sugerencias.find((s) => s.dateKey === "2026-12-25");
    expect(navidad?.yaCargado).toBe(true);
    // El resto sigue pendiente.
    expect(sugerencias.filter((s) => s.yaCargado)).toHaveLength(1);
  });

  it("la excepción de un profesional no cuenta como feriado cargado", async () => {
    // Que un profesional se tome el 25 no significa que la clínica cierre.
    const clinic = await crearClinica();
    const professional = await prisma.professional.findFirstOrThrow({
      where: { clinicId: clinic.id },
    });

    await upsertScheduleException({
      clinicId: clinic.id,
      input: {
        dateKey: "2026-12-25",
        reason: "Día personal",
        professionalId: professional.id,
      },
    });

    const { sugerencias } = await holidaySuggestionsForClinic({
      clinicId: clinic.id,
      year: 2026,
    });
    expect(sugerencias.find((s) => s.dateKey === "2026-12-25")?.yaCargado).toBe(false);
  });

  it("una clínica sin país no recibe sugerencias", async () => {
    const clinic = await crearClinica({ country: null });
    const { country, sugerencias } = await holidaySuggestionsForClinic({
      clinicId: clinic.id,
      year: 2026,
    });
    expect(country).toBeNull();
    expect(sugerencias).toEqual([]);
  });
});

describe("aplicar feriados", () => {
  it("carga todos los pendientes del año", async () => {
    const clinic = await crearClinica();

    const antes = await countPendingHolidays({ clinicId: clinic.id, year: 2026 });
    expect(antes).toBeGreaterThan(0);

    const { cargados } = await applyHolidays({ clinicId: clinic.id, year: 2026 });
    expect(cargados).toHaveLength(antes);

    const despues = await countPendingHolidays({ clinicId: clinic.id, year: 2026 });
    expect(despues).toBe(0);
  });

  it("los carga como cerrados todo el día, con el nombre del feriado", async () => {
    const clinic = await crearClinica();
    await applyHolidays({ clinicId: clinic.id, year: 2026, dateKeys: ["2026-12-25"] });

    const filas = await prisma.scheduleException.findMany({
      where: { clinicId: clinic.id },
    });

    expect(filas).toHaveLength(1);
    expect(filas[0].reason).toBe("Navidad");
    expect(filas[0].startMinute).toBeNull();
    expect(filas[0].endMinute).toBeNull();
  });

  it("carga solo las fechas pedidas", async () => {
    const clinic = await crearClinica();
    const { cargados } = await applyHolidays({
      clinicId: clinic.id,
      year: 2026,
      dateKeys: ["2026-01-01", "2026-12-25"],
    });

    expect(cargados.map((c) => c.dateKey).sort()).toEqual(["2026-01-01", "2026-12-25"]);
    expect(await countPendingHolidays({ clinicId: clinic.id, year: 2026 })).toBeGreaterThan(0);
  });

  it("no pisa un horario especial cargado a mano para un feriado", async () => {
    // El caso real: la clínica atiende media jornada el 24. Aplicar el
    // calendario no puede convertirlo en cerrado.
    const clinic = await crearClinica();

    await upsertScheduleException({
      clinicId: clinic.id,
      input: {
        dateKey: "2026-12-25",
        reason: "Navidad: atendemos media jornada",
        tramos: [{ startMinute: 9 * 60, endMinute: 12 * 60 }],
      },
    });

    await applyHolidays({ clinicId: clinic.id, year: 2026 });

    const filas = await prisma.scheduleException.findMany({
      where: { clinicId: clinic.id, professionalId: null },
    });
    const navidad = filas.filter((f) => f.date.toISOString().slice(0, 10) === "2026-12-25");

    expect(navidad).toHaveLength(1);
    expect(navidad[0].startMinute).toBe(540);
    expect(navidad[0].reason).toBe("Navidad: atendemos media jornada");
  });

  it("informa las fechas pedidas que no son feriados", async () => {
    const clinic = await crearClinica();
    const { cargados, omitidos } = await applyHolidays({
      clinicId: clinic.id,
      year: 2026,
      dateKeys: ["2026-12-25", "2026-06-17"],
    });

    expect(cargados.map((c) => c.dateKey)).toEqual(["2026-12-25"]);
    expect(omitidos).toEqual(["2026-06-17"]);
  });
});

describe("salud de configuración", () => {
  it("una clínica completa no tiene issues", async () => {
    const clinic = await crearClinica({ conCalendario: true });
    await applyHolidays({ clinicId: clinic.id, year: new Date().getUTCFullYear() });

    const health = await getConfigHealth(clinic.id);
    expect(health?.ok).toBe(true);
    expect(health?.issues).toEqual([]);
  });

  it("la falta del link del aviso de privacidad es una advertencia, no un bloqueo", async () => {
    const clinic = await crearClinica({ conCalendario: true, sinAviso: true });
    await applyHolidays({ clinicId: clinic.id, year: new Date().getUTCFullYear() });
    const health = await getConfigHealth(clinic.id);
    const issue = health?.issues.find((i) => i.code === "sin_aviso_de_privacidad");
    expect(issue?.severidad).toBe("advertencia");
    expect(health?.issues).toHaveLength(1);
  });

  it("marca la falta de horario como bloqueante", async () => {
    const clinic = await crearClinica({ conHorario: false, conCalendario: true });
    await applyHolidays({ clinicId: clinic.id, year: new Date().getUTCFullYear() });

    const health = await getConfigHealth(clinic.id);
    const issue = health?.issues.find((i) => i.code === "sin_horario_de_atencion");

    expect(issue).toBeDefined();
    expect(issue?.severidad).toBe("bloqueante");
    expect(health?.ok).toBe(false);
  });

  it("marca los feriados pendientes como advertencia", async () => {
    const clinic = await crearClinica({ conCalendario: true });

    const health = await getConfigHealth(clinic.id);
    const issue = health?.issues.find((i) => i.code === "feriados_sin_cargar");

    expect(issue?.severidad).toBe("advertencia");
    // No hay bloqueantes: tiene horario cargado.
    expect(health?.issues.some((i) => i.severidad === "bloqueante")).toBe(false);
  });

  it("avisa cuando falta el país", async () => {
    const clinic = await crearClinica({ country: null, conCalendario: true });
    const health = await getConfigHealth(clinic.id);

    expect(health?.issues.map((i) => i.code)).toContain("sin_pais_configurado");
    // Sin país no puede haber además un aviso de feriados pendientes.
    expect(health?.issues.map((i) => i.code)).not.toContain("feriados_sin_cargar");
  });

  it("avisa cuando no hay calendario enlazado", async () => {
    const clinic = await crearClinica();
    const health = await getConfigHealth(clinic.id);
    expect(health?.issues.map((i) => i.code)).toContain("sin_calendario_enlazado");
  });

  it("devuelve null para una clínica que no existe", async () => {
    expect(await getConfigHealth("no-existe")).toBeNull();
  });

  it("en diciembre cuenta también los feriados del año que viene", async () => {
    const clinic = await crearClinica({ conCalendario: true });
    const diciembre = new Date(Date.UTC(2026, 11, 10));

    // Se carga todo 2026, así lo único pendiente es 2027.
    await applyHolidays({ clinicId: clinic.id, year: 2026 });

    const health = await getConfigHealth(clinic.id, diciembre);
    const issue = health?.issues.find((i) => i.code === "feriados_sin_cargar");

    expect(issue).toBeDefined();
    const porAnio = issue?.datos?.pendientesPorAnio as Array<{ year: number }>;
    expect(porAnio.map((a) => a.year)).toEqual([2027]);
    expect(issue?.mensaje).toContain("2027");
  });

  it("en noviembre todavía no pide el año siguiente", async () => {
    const clinic = await crearClinica({ conCalendario: true });
    const noviembre = new Date(Date.UTC(2026, 10, 10));

    await applyHolidays({ clinicId: clinic.id, year: 2026 });

    const health = await getConfigHealth(clinic.id, noviembre);
    expect(health?.issues.find((i) => i.code === "feriados_sin_cargar")).toBeUndefined();
  });

  it("expone los países disponibles cuando falta el país", async () => {
    // Para que el banner pueda armar el selector sin otra llamada.
    const clinic = await crearClinica({ country: null, conCalendario: true });
    const health = await getConfigHealth(clinic.id);
    const issue = health?.issues.find((i) => i.code === "sin_pais_configurado");

    const paises = issue?.datos?.paisesSoportados as Array<{ id: string; name: string }>;
    expect(paises.map((c) => c.id)).toContain("AR");
    // La clínica está en zona de Argentina, así que se propone AR.
    expect(issue?.datos?.sugerido).toBe("AR");
  });
});

describe("aviso de feriados pendientes", () => {
  it("no avisa si no quedan feriados por cargar", async () => {
    const clinic = await crearClinica();
    const ahora = new Date();
    await applyHolidays({ clinicId: clinic.id, year: ahora.getUTCFullYear() });

    const avisadas = await alertClinicsPendingHolidays(ahora, { clinicIds: [clinic.id] });
    expect(avisadas).toBe(0);
  });

  it("no avisa a una clínica sin país", async () => {
    const clinic = await crearClinica({ country: null });
    const avisadas = await alertClinicsPendingHolidays(new Date(), {
      clinicIds: [clinic.id],
    });
    expect(avisadas).toBe(0);
  });

  it("no repite el aviso antes de la semana", async () => {
    const clinic = await crearClinica();
    const ahora = new Date();

    await prisma.clinic.update({
      where: { id: clinic.id },
      // Se avisó ayer.
      data: { holidayAlertSentAt: new Date(ahora.getTime() - 24 * 60 * 60 * 1000) },
    });

    const antes = await prisma.clinic.findUniqueOrThrow({ where: { id: clinic.id } });
    await alertClinicsPendingHolidays(ahora, { clinicIds: [clinic.id] });
    const despues = await prisma.clinic.findUniqueOrThrow({ where: { id: clinic.id } });

    expect(despues.holidayAlertSentAt?.toISOString()).toBe(
      antes.holidayAlertSentAt?.toISOString()
    );
  });
});
