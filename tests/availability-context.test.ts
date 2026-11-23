import { describe, expect, it } from "vitest";
import {
  NO_SE_PUDO_CONSULTAR,
  formatAvailableSlots,
} from "../src/prompts/availability-context";
import type { AvailableSlotsResult, DaySlots, Slot } from "../src/services/availability-slots";

/**
 * El texto de horarios que lee Claude. Es función pura, sin base ni red.
 *
 * Importa que la fecha salga en ISO textual: es lo que el modelo tiene que
 * copiar a `fecha_solicitada`, y `clinicWallTimeToUtc` rechaza cualquier otro
 * formato.
 */

function slot(
  dateKey: string,
  time: string,
  professionalName = "Dra. García",
  professionalTitle: string | null = null
): Slot {
  return {
    start: new Date(`${dateKey}T${time}:00.000Z`),
    end: new Date(`${dateKey}T${time}:00.000Z`),
    dateKey,
    time,
    professionalId: "p1",
    professionalName,
    professionalTitle,
    candidateProfessionalIds: ["p1"],
  };
}

function day(overrides: Partial<DaySlots> & { dateKey: string }): DaySlots {
  return {
    weekday: "lunes",
    slots: [],
    reason: null,
    exceptionReason: null,
    ...overrides,
  };
}

function resultado(days: DaySlots[], blocker: AvailableSlotsResult["blocker"] = null): AvailableSlotsResult {
  return {
    days,
    totalSlots: days.reduce((acc, d) => acc + d.slots.length, 0),
    durationMinutes: 30,
    blocker,
    restrictedToProfessionalId: null,
  };
}

describe("formatAvailableSlots", () => {
  it("lista los horarios por día con la fecha ISO y el profesional", () => {
    const texto = formatAvailableSlots(
      resultado([
        day({
          dateKey: "2030-06-17",
          slots: [slot("2030-06-17", "09:00"), slot("2030-06-17", "10:30", "Dr. Pérez")],
        }),
      ])
    );

    expect(texto).toBe("2030-06-17 (lunes): 09:00 con Dra. García; 10:30 con Dr. Pérez");
  });

  it("antepone el título del profesional cuando la clínica lo cargó", () => {
    const texto = formatAvailableSlots(
      resultado([
        day({
          dateKey: "2030-06-17",
          slots: [
            slot("2030-06-17", "09:00", "García", "Dra."),
            slot("2030-06-17", "10:30", "Rojas", "Manicurista"),
            slot("2030-06-17", "11:00", "Sin Título"),
          ],
        }),
      ])
    );

    expect(texto).toBe(
      "2030-06-17 (lunes): 09:00 con Dra. García; 10:30 con Manicurista Rojas; 11:00 con Sin Título"
    );
  });

  it("muestra el motivo de un día cerrado que queda en el medio", () => {
    const texto = formatAvailableSlots(
      resultado([
        day({ dateKey: "2030-06-17", slots: [slot("2030-06-17", "09:00")] }),
        day({
          dateKey: "2030-06-18",
          weekday: "martes",
          reason: "clinica_cerrada",
          exceptionReason: "Feriado nacional",
        }),
        day({
          dateKey: "2030-06-19",
          weekday: "miercoles",
          slots: [slot("2030-06-19", "11:00")],
        }),
      ])
    );

    expect(texto).toContain("2030-06-18 (martes): cerrado (Feriado nacional)");
  });

  it("no arrastra los días cerrados del final", () => {
    const texto = formatAvailableSlots(
      resultado([
        day({ dateKey: "2030-06-17", slots: [slot("2030-06-17", "09:00")] }),
        day({ dateKey: "2030-06-22", weekday: "sabado", reason: "clinica_cerrada" }),
        day({ dateKey: "2030-06-23", weekday: "domingo", reason: "clinica_cerrada" }),
      ])
    );

    expect(texto).toBe("2030-06-17 (lunes): 09:00 con Dra. García");
  });

  it("lista TODOS los horarios del día, sin recortar ni repartir", () => {
    // Regresión 2026-11-05: con 6 huecos libres se mostraban 4 y el modelo
    // contestó "a las 12 no tengo lugar" estando libre.
    const texto = formatAvailableSlots(
      resultado([
        day({
          dateKey: "2030-06-17",
          slots: ["11:00", "11:15", "11:30", "11:45", "12:00", "14:00"].map((t) =>
            slot("2030-06-17", t)
          ),
        }),
      ])
    );

    expect(texto).toBe(
      "2030-06-17 (lunes): 11:00, 11:15, 11:30, 11:45, 12:00, 14:00 con Dra. García"
    );
    expect(texto).not.toContain("parcial");
  });

  it("agrupa los horarios por profesional, en el orden en que aparecen", () => {
    const texto = formatAvailableSlots(
      resultado([
        day({
          dateKey: "2030-06-17",
          slots: [
            slot("2030-06-17", "09:00"),
            slot("2030-06-17", "09:15", "Dr. Pérez"),
            slot("2030-06-17", "10:00"),
          ],
        }),
      ])
    );

    expect(texto).toBe("2030-06-17 (lunes): 09:00, 10:00 con Dra. García; 09:15 con Dr. Pérez");
  });

  it("recorta la cantidad de días", () => {
    const texto = formatAvailableSlots(
      resultado(
        ["2030-06-17", "2030-06-18", "2030-06-19"].map((dateKey) =>
          day({ dateKey, slots: [slot(dateKey, "09:00")] })
        )
      ),
      { maxDias: 2 }
    );

    expect(texto).toContain("2030-06-17");
    expect(texto).toContain("2030-06-18");
    expect(texto).not.toContain("2030-06-19");
    expect(texto).toContain("(hay más días disponibles después de estos)");
  });

  it("no avisa de más días si entraron todos", () => {
    const texto = formatAvailableSlots(
      resultado([day({ dateKey: "2030-06-17", slots: [slot("2030-06-17", "09:00")] })])
    );

    expect(texto).not.toContain("hay más días");
  });

  it("distingue no haber encontrado nada de no haber podido consultar", () => {
    const agendaLlena = resultado([
      day({ dateKey: "2030-06-17", reason: "completo" }),
      day({ dateKey: "2030-06-18", weekday: "martes", reason: "completo" }),
    ]);
    expect(formatAvailableSlots(agendaLlena)).toBe(
      "sin horarios disponibles en los próximos 2 días"
    );

    expect(formatAvailableSlots(resultado([], "sin_horario_de_atencion"))).toBe(
      NO_SE_PUDO_CONSULTAR
    );
  });
});

describe("varios profesionales libres en el mismo horario", () => {
  it("los nombra a todos: mostrar solo al primero hacía creer que los demás no tenían lugar", () => {
    const hueco: Slot = {
      ...slot("2030-06-17", "11:00", "Liliana Mungiga", "Dra."),
      candidateProfessionals: [
        { id: "p1", name: "Liliana Mungiga", title: "Dra." },
        { id: "p2", name: "Cyntia Trujullo", title: null },
      ],
      candidateProfessionalIds: ["p1", "p2"],
    };
    const texto = formatAvailableSlots(resultado([day({ dateKey: "2030-06-17", slots: [hueco] })]));

    expect(texto).toContain("11:00 con Dra. Liliana Mungiga o Cyntia Trujullo");
  });

  it("con uno solo se ve igual que siempre", () => {
    const texto = formatAvailableSlots(
      resultado([day({ dateKey: "2030-06-17", slots: [slot("2030-06-17", "09:00")] })])
    );
    expect(texto).toContain("09:00 con Dra. García");
    expect(texto).not.toContain(" o ");
  });
});
