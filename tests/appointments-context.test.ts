import { describe, expect, it } from "vitest";
import {
  SIN_TURNOS,
  describeAppointments,
  describePeople,
  type AppointmentForPrompt,
} from "../src/prompts/appointments-context";

/**
 * El texto de turnos existentes que lee Claude. Es función pura, sin base ni
 * red.
 *
 * Importa que salga el id textual (es lo que el modelo tiene que copiar a
 * `turno_a_modificar` para que la cancelación llegue a ejecutarse) y que la
 * fecha y la hora salgan en la zona de la clínica, no en la del servidor.
 */

function turno(overrides?: Partial<AppointmentForPrompt>): AppointmentForPrompt {
  return {
    id: "apt-1",
    startTime: new Date("2030-06-17T13:00:00.000Z"),
    service: "Limpieza",
    professional: { name: "Dra. García", title: null },
    ...overrides,
  };
}

describe("describeAppointments", () => {
  it("dice 'ninguno' cuando el paciente no tiene turnos", () => {
    expect(describeAppointments([], "UTC")).toBe(SIN_TURNOS);
  });

  it("incluye el id textual, para que el modelo lo pueda copiar", () => {
    const texto = describeAppointments([turno({ id: "cmu1o5cno001canarjnvngmrf" })], "UTC");

    expect(texto).toContain("cmu1o5cno001canarjnvngmrf");
  });

  it("muestra fecha, día de la semana, hora, servicio y profesional", () => {
    const texto = describeAppointments([turno()], "UTC");

    expect(texto).toContain("2030-06-17");
    expect(texto).toContain("lunes");
    expect(texto).toContain("13:00");
    expect(texto).toContain("Limpieza");
    expect(texto).toContain("Dra. García");
  });

  it("antepone el título del profesional cuando la clínica lo cargó", () => {
    const texto = describeAppointments(
      [turno({ professional: { name: "Rojas", title: { name: "Psicóloga" } } })],
      "UTC"
    );

    expect(texto).toContain("con Psicóloga Rojas");
  });

  it("usa la hora de pared de la clínica, no la del servidor", () => {
    // 13:00 UTC son las 07:00 en México — y el día sigue siendo el mismo.
    const texto = describeAppointments([turno()], "America/Mexico_City");

    expect(texto).toContain("07:00");
    expect(texto).toContain("2030-06-17");
  });

  it("corre el día cuando la zona de la clínica lo cambia", () => {
    // 02:00 UTC del martes es todavía lunes por la noche en México.
    const texto = describeAppointments(
      [turno({ startTime: new Date("2030-06-18T02:00:00.000Z") })],
      "America/Mexico_City"
    );

    expect(texto).toContain("2030-06-17");
    expect(texto).toContain("lunes");
    expect(texto).toContain("20:00");
  });

  it("lista un turno por línea", () => {
    const texto = describeAppointments(
      [turno({ id: "apt-1" }), turno({ id: "apt-2" })],
      "UTC"
    );

    expect(texto.split("\n")).toHaveLength(2);
  });
});


describe("describePeople: primera vez por persona", () => {
  it("marca a quien nunca tuvo una cita, y solo a esa persona", () => {
    const texto = describePeople(
      [
        { id: "a", name: "Carlos", esTitular: true, appointments: [], primeraVez: false },
        { id: "b", name: "Eva María", esTitular: false, appointments: [], primeraVez: true },
      ],
      "UTC"
    );
    expect(texto).toContain("- Carlos (quien escribe):");
    expect(texto).not.toMatch(/Carlos.*PRIMERA VEZ/);
    expect(texto).toContain("Eva María [PRIMERA VEZ: nunca tuvo una cita]");
  });
});
