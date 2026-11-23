import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";

// El calendario externo NO se llama de verdad: se simula lo que "devuelve Google".
const listCalendarBlocks = vi.fn();
const handleCalendarAccessError = vi.fn();
vi.mock("../src/services/calendar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar")>()),
  listCalendarBlocks: (...args: unknown[]) => listCalendarBlocks(...args),
  handleCalendarAccessError: (...args: unknown[]) => handleCalendarAccessError(...args),
}));

// `syncAllClinics` recorre las clínicas activas: que sean solo las de este test, no las de la base de desarrollo.
const clinicasActivas = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock("../src/repositories/clinics.repository", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/repositories/clinics.repository")>();
  return {
    ...original,
    listActiveClinics: async () => (await original.listActiveClinics()).filter((c) => clinicasActivas.ids.includes(c.id)),
  };
});

import { syncAllClinics, syncClinicBlocks, syncClinicBlocksNow } from "../src/jobs/calendar-sync";

/**
 * El job de bloqueos: copia a Postgres el tiempo ocupado de las agendas personales para que
 * `availability.ts` no ofrezca horarios encima. Es la ÚNICA lectura de Google Calendar y el
 * único lugar donde un error agenda pacientes sobre un horario bloqueado, o borra los bloqueos
 * que cargó una persona. Contra el Postgres local: docker compose up -d db
 */

const clinicIds: string[] = [];
const HORA = 3_600_000;

async function crearClinica(options?: {
  profesionales?: Array<{ name: string; googleCalendarId?: string | null; blockSyncEnabled?: boolean; active?: boolean }>;
  sharedCalendarId?: string | null;
  active?: boolean;
}) {
  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica sync ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `sync-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "test@example.com",
      timezone: "UTC",
      services: "Consulta",
      active: options?.active ?? true,
      sharedCalendarId: options?.sharedCalendarId ?? null,
      professionals: {
        create: (options?.profesionales ?? [{ name: "Gómez", googleCalendarId: "gomez@cal" }]).map((p) => ({
          name: p.name,
          googleCalendarId: p.googleCalendarId === undefined ? null : p.googleCalendarId,
          blockSyncEnabled: p.blockSyncEnabled ?? true,
          active: p.active ?? true,
        })),
      },
    },
    include: { professionals: { orderBy: { name: "asc" } } },
  });
  clinicIds.push(clinic.id);
  clinicasActivas.ids.push(clinic.id);
  return clinic;
}

/** Un evento ocupado que empieza dentro de `inicioHoras` horas y dura `duracionHoras`. */
const evento = (id: string, inicioHoras: number, duracionHoras = 1, isAllDay = false) => ({
  externalEventId: id,
  startTime: new Date(Date.now() + inicioHoras * HORA),
  endTime: new Date(Date.now() + (inicioHoras + duracionHoras) * HORA),
  isAllDay,
});

const bloquesDe = (professionalId: string) =>
  prisma.calendarBlock.findMany({ where: { professionalId }, orderBy: { startTime: "asc" } });

beforeEach(() => {
  listCalendarBlocks.mockReset();
  handleCalendarAccessError.mockReset();
  listCalendarBlocks.mockResolvedValue([]);
  handleCalendarAccessError.mockResolvedValue(null);
});

afterEach(async () => {
  for (const id of clinicIds) {
    await prisma.calendarBlock.deleteMany({ where: { clinicId: id } });
    await prisma.professional.deleteMany({ where: { clinicId: id } });
    await prisma.clinic.delete({ where: { id: id } });
  }
  clinicIds.length = 0;
  clinicasActivas.ids.length = 0;
});

describe("syncClinicBlocks: qué copia", () => {
  it("copia a Postgres los eventos del calendario del profesional, solo con el rango horario", async () => {
    const clinic = await crearClinica();
    listCalendarBlocks.mockResolvedValue([evento("ev-1", 2), evento("ev-2", 26, 24, true)]);

    await syncClinicBlocks(clinic.id);

    const [a, b] = await bloquesDe(clinic.professionals[0].id);
    expect(a).toMatchObject({ googleEventId: "ev-1", isAllDay: false, source: "calendario", title: null });
    expect(b).toMatchObject({ googleEventId: "ev-2", isAllDay: true, source: "calendario", title: null });
    // Sin título ni descripción: el evento personal de un profesional no es un dato que se necesite.
    expect(Object.keys(a)).not.toContain("summary");
    expect(listCalendarBlocks).toHaveBeenCalledTimes(1);
    expect(listCalendarBlocks.mock.calls[0][0]).toMatchObject({ provider: "google", calendarId: "gomez@cal" });
  });

  it("pide una ventana de unos 60 días hacia adelante, no un año", async () => {
    const clinic = await crearClinica();
    await syncClinicBlocks(clinic.id);
    const [, from, to] = listCalendarBlocks.mock.calls[0] as [unknown, Date, Date];
    expect(Math.round((to.getTime() - from.getTime()) / (24 * HORA))).toBe(60);
    expect(Math.abs(from.getTime() - Date.now())).toBeLessThan(5_000);
  });

  it("un evento que se borró o se movió en el calendario deja de frenar turnos", async () => {
    const clinic = await crearClinica();
    const profesionalId = clinic.professionals[0].id;
    listCalendarBlocks.mockResolvedValue([evento("ev-1", 2), evento("ev-2", 5)]);
    await syncClinicBlocks(clinic.id);

    // Ahora el calendario ya no tiene ev-1 y tiene ev-2 en otro horario.
    listCalendarBlocks.mockResolvedValue([evento("ev-2", 9)]);
    await syncClinicBlocks(clinic.id);

    const filas = await bloquesDe(profesionalId);
    expect(filas.map((f) => f.googleEventId)).toEqual(["ev-2"]);
    expect(filas[0].startTime.getTime()).toBeGreaterThan(Date.now() + 8 * HORA);
  });

  it("si el calendario quedó vacío, borra los bloqueos importados", async () => {
    const clinic = await crearClinica();
    listCalendarBlocks.mockResolvedValue([evento("ev-1", 2)]);
    await syncClinicBlocks(clinic.id);
    listCalendarBlocks.mockResolvedValue([]);
    await syncClinicBlocks(clinic.id);
    expect(await bloquesDe(clinic.professionals[0].id)).toHaveLength(0);
  });

  it("es idempotente: sincronizar dos veces lo mismo no duplica nada", async () => {
    const clinic = await crearClinica();
    listCalendarBlocks.mockResolvedValue([evento("ev-1", 2), evento("ev-2", 4)]);
    await syncClinicBlocks(clinic.id);
    await syncClinicBlocks(clinic.id);
    expect(await bloquesDe(clinic.professionals[0].id)).toHaveLength(2);
  });

  it("un evento repetido dos veces en la respuesta se guarda una sola vez", async () => {
    const clinic = await crearClinica();
    const e = evento("ev-1", 2);
    listCalendarBlocks.mockResolvedValue([e, e]);
    await syncClinicBlocks(clinic.id);
    expect(await bloquesDe(clinic.professionals[0].id)).toHaveLength(1);
  });
});

describe("syncClinicBlocks: lo que NO se toca", () => {
  it("nunca borra los bloqueos manuales que cargó una persona", async () => {
    const clinic = await crearClinica();
    const profesionalId = clinic.professionals[0].id;
    await prisma.calendarBlock.create({
      data: {
        clinicId: clinic.id, professionalId: profesionalId, googleEventId: "manual-1", source: "manual", title: "Almuerzo",
        startTime: new Date(Date.now() + 3 * HORA), endTime: new Date(Date.now() + 4 * HORA),
      },
    });
    listCalendarBlocks.mockResolvedValue([evento("ev-1", 2)]);

    await syncClinicBlocks(clinic.id);
    listCalendarBlocks.mockResolvedValue([]);
    await syncClinicBlocks(clinic.id);

    const filas = await bloquesDe(profesionalId);
    expect(filas.map((f) => [f.googleEventId, f.source, f.title])).toEqual([["manual-1", "manual", "Almuerzo"]]);
  });

  it("no toca el historial anterior a hoy", async () => {
    const clinic = await crearClinica();
    const profesionalId = clinic.professionals[0].id;
    await prisma.calendarBlock.create({
      data: {
        clinicId: clinic.id, professionalId: profesionalId, googleEventId: "viejo", source: "calendario",
        startTime: new Date(Date.now() - 48 * HORA), endTime: new Date(Date.now() - 47 * HORA),
      },
    });
    await syncClinicBlocks(clinic.id);
    expect((await bloquesDe(profesionalId)).map((f) => f.googleEventId)).toEqual(["viejo"]);
  });

  it("un evento en curso que se alargó en el calendario se actualiza, no queda con el fin viejo", async () => {
    const clinic = await crearClinica();
    const profesionalId = clinic.professionals[0].id;
    // Empezó hace 2 horas y terminaba en 1; ya estaba importado.
    const viejo = { externalEventId: "en-curso", startTime: new Date(Date.now() - 2 * HORA), endTime: new Date(Date.now() + HORA), isAllDay: false };
    listCalendarBlocks.mockResolvedValue([viejo]);
    await syncClinicBlocks(clinic.id);

    // El profesional lo alargó 3 horas más: el calendario lo devuelve (sigue en curso) con el fin nuevo.
    listCalendarBlocks.mockResolvedValue([{ ...viejo, endTime: new Date(Date.now() + 4 * HORA) }]);
    await syncClinicBlocks(clinic.id);

    const [fila] = await bloquesDe(profesionalId);
    expect(fila.endTime.getTime()).toBeGreaterThan(Date.now() + 3 * HORA);
  });

  it("un evento en curso que se borró del calendario deja de bloquear", async () => {
    const clinic = await crearClinica();
    const viejo = { externalEventId: "en-curso", startTime: new Date(Date.now() - HORA), endTime: new Date(Date.now() + HORA), isAllDay: false };
    listCalendarBlocks.mockResolvedValue([viejo]);
    await syncClinicBlocks(clinic.id);
    listCalendarBlocks.mockResolvedValue([]);
    await syncClinicBlocks(clinic.id);
    expect(await bloquesDe(clinic.professionals[0].id)).toHaveLength(0);
  });

  it("no mezcla los bloqueos de una clínica con los de otra", async () => {
    const a = await crearClinica();
    const b = await crearClinica({ profesionales: [{ name: "Ruiz", googleCalendarId: "ruiz@cal" }] });
    listCalendarBlocks.mockResolvedValue([evento("ev-a", 2)]);
    await syncClinicBlocks(a.id);
    listCalendarBlocks.mockResolvedValue([]);
    await syncClinicBlocks(b.id);
    expect(await bloquesDe(a.professionals[0].id)).toHaveLength(1);
  });
});

describe("syncClinicBlocks: a quién se le aplica", () => {
  it("un profesional sin calendario enlazado no genera ninguna lectura", async () => {
    const clinic = await crearClinica({ profesionales: [{ name: "Gómez", googleCalendarId: null }] });
    await syncClinicBlocks(clinic.id);
    expect(listCalendarBlocks).not.toHaveBeenCalled();
  });

  it("no sincroniza al profesional con la importación apagada ni al desactivado, pero sí a los demás", async () => {
    const clinic = await crearClinica({
      profesionales: [
        { name: "A", googleCalendarId: "a@cal", blockSyncEnabled: false },
        { name: "B", googleCalendarId: "b@cal", active: false },
        { name: "C", googleCalendarId: "c@cal" },
      ],
    });
    listCalendarBlocks.mockResolvedValue([evento("ev-1", 2)]);
    await syncClinicBlocks(clinic.id);

    expect(listCalendarBlocks).toHaveBeenCalledTimes(1);
    expect(listCalendarBlocks.mock.calls[0][0]).toMatchObject({ calendarId: "c@cal" });
    const [a, b, c] = clinic.professionals;
    expect(await bloquesDe(a.id)).toHaveLength(0);
    expect(await bloquesDe(b.id)).toHaveLength(0);
    expect(await bloquesDe(c.id)).toHaveLength(1);
  });

  it("con calendario compartido lo lee UNA vez y el bloqueo se aplica a todo el equipo", async () => {
    const clinic = await crearClinica({
      sharedCalendarId: "equipo@cal",
      profesionales: [{ name: "A" }, { name: "B", googleCalendarId: "b-propio@cal" }, { name: "C" }],
    });
    listCalendarBlocks.mockResolvedValue([evento("ev-1", 2)]);
    await syncClinicBlocks(clinic.id);

    expect(listCalendarBlocks).toHaveBeenCalledTimes(1);
    // Tiene prioridad sobre el calendario personal de cada uno.
    expect(listCalendarBlocks.mock.calls[0][0]).toMatchObject({ calendarId: "equipo@cal" });
    for (const p of clinic.professionals) expect(await bloquesDe(p.id)).toHaveLength(1);
  });

  it("dos profesionales con el mismo calendario enlazado lo leen una sola vez", async () => {
    const clinic = await crearClinica({
      profesionales: [{ name: "A", googleCalendarId: "mismo@cal" }, { name: "B", googleCalendarId: "mismo@cal" }],
    });
    listCalendarBlocks.mockResolvedValue([evento("ev-1", 2)]);
    await syncClinicBlocks(clinic.id);
    expect(listCalendarBlocks).toHaveBeenCalledTimes(1);
    for (const p of clinic.professionals) expect(await bloquesDe(p.id)).toHaveLength(1);
  });

  it("una clínica que no existe no hace nada ni falla", async () => {
    await expect(syncClinicBlocks("no-existe")).resolves.toBeUndefined();
    expect(listCalendarBlocks).not.toHaveBeenCalled();
  });
});

describe("syncClinicBlocks: cuando Google falla", () => {
  it("si no se puede leer un calendario conserva los bloqueos que ya tenía, no los borra", async () => {
    const clinic = await crearClinica();
    listCalendarBlocks.mockResolvedValue([evento("ev-1", 2)]);
    await syncClinicBlocks(clinic.id);

    listCalendarBlocks.mockRejectedValue(new Error("Google caído"));
    await expect(syncClinicBlocks(clinic.id)).resolves.toBeUndefined();

    // Si Google está caído, el peor caso es trabajar con bloqueos desactualizados; nunca sin ninguno.
    expect(await bloquesDe(clinic.professionals[0].id)).toHaveLength(1);
  });

  it("un calendario que falla no frena el de los demás profesionales", async () => {
    const clinic = await crearClinica({
      profesionales: [{ name: "A", googleCalendarId: "roto@cal" }, { name: "B", googleCalendarId: "sano@cal" }],
    });
    listCalendarBlocks.mockImplementation(async (target: { calendarId: string }) => {
      if (target.calendarId === "roto@cal") throw new Error("mal compartido");
      return [evento("ev-1", 2)];
    });
    await syncClinicBlocks(clinic.id);
    const [a, b] = clinic.professionals;
    expect(await bloquesDe(a.id)).toHaveLength(0);
    expect(await bloquesDe(b.id)).toHaveLength(1);
  });

  it("una cuenta revocada se marca, no se borran sus bloqueos y se sigue con el resto", async () => {
    const clinic = await crearClinica({
      profesionales: [{ name: "A", googleCalendarId: "revocado@cal" }, { name: "B", googleCalendarId: "sano@cal" }],
    });
    listCalendarBlocks.mockResolvedValue([evento("previo", 2)]);
    await syncClinicBlocks(clinic.id);

    listCalendarBlocks.mockImplementation(async (target: { calendarId: string }) => {
      if (target.calendarId === "revocado@cal") throw new Error("invalid_grant");
      return [evento("nuevo", 3)];
    });
    handleCalendarAccessError.mockImplementation(async (target: { calendarId: string }) =>
      target.calendarId === "revocado@cal" ? { email: "cuenta@example.com" } : null
    );
    await syncClinicBlocks(clinic.id);

    expect(handleCalendarAccessError).toHaveBeenCalledTimes(1);
    const [a, b] = clinic.professionals;
    expect((await bloquesDe(a.id)).map((f) => f.googleEventId)).toEqual(["previo"]); // sin tocar
    expect((await bloquesDe(b.id)).map((f) => f.googleEventId)).toEqual(["nuevo"]);
  });

  it("si falla incluso el marcar la cuenta como revocada, no se cae el sync", async () => {
    const clinic = await crearClinica();
    listCalendarBlocks.mockRejectedValue(new Error("invalid_grant"));
    handleCalendarAccessError.mockRejectedValue(new Error("base caída"));
    await expect(syncClinicBlocks(clinic.id)).resolves.toBeUndefined();
  });
});

describe("syncAllClinics y el sync inmediato", () => {
  it("una clínica con un problema no deja sin sincronizar a las demás", async () => {
    const rota = await crearClinica({ profesionales: [{ name: "A", googleCalendarId: "rota@cal" }] });
    const sana = await crearClinica({ profesionales: [{ name: "B", googleCalendarId: "sana@cal" }] });
    // Que reviente algo que NO está dentro del manejo de errores de lectura: la escritura (una fecha inválida).
    listCalendarBlocks.mockImplementation(async (target: { calendarId: string }) =>
      target.calendarId === "rota@cal"
        ? [{ externalEventId: "mal", startTime: new Date("no es una fecha"), endTime: new Date("tampoco"), isAllDay: false }]
        : [evento("ev-1", 2)]
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(syncAllClinics()).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith(expect.stringContaining(rota.id), expect.anything());
    } finally {
      log.mockRestore();
    }
    expect(await bloquesDe(sana.professionals[0].id)).toHaveLength(1);
  });

  it("no recorre las clínicas dadas de baja", async () => {
    const baja = await crearClinica({ active: false });
    await syncAllClinics();
    expect(await bloquesDe(baja.professionals[0].id)).toHaveLength(0);
  });

  it("el sync inmediato no espera ni propaga errores, y no arranca un segundo sync de la misma clínica", async () => {
    const clinic = await crearClinica();
    let liberar!: () => void;
    listCalendarBlocks.mockImplementation(() => new Promise((resolve) => { liberar = () => resolve([evento("ev-1", 2)]); }));

    syncClinicBlocksNow(clinic.id, "prueba");
    syncClinicBlocksNow(clinic.id, "prueba"); // ya hay uno en curso
    await new Promise((r) => setTimeout(r, 50));
    expect(listCalendarBlocks).toHaveBeenCalledTimes(1);

    liberar();
    await vi.waitFor(async () => expect(await bloquesDe(clinic.professionals[0].id)).toHaveLength(1));

    // Terminado el primero, uno nuevo sí arranca.
    listCalendarBlocks.mockResolvedValue([]);
    syncClinicBlocksNow(clinic.id, "prueba");
    await vi.waitFor(() => expect(listCalendarBlocks).toHaveBeenCalledTimes(2));
  });

  it("si el sync inmediato falla, no lanza", async () => {
    const clinic = await crearClinica();
    listCalendarBlocks.mockRejectedValue(new Error("Google caído"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() => syncClinicBlocksNow(clinic.id, "prueba")).not.toThrow();
      await vi.waitFor(() => expect(listCalendarBlocks).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      log.mockRestore();
    }
  });
});
