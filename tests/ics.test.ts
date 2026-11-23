import { describe, expect, it } from "vitest";
import { buildAppointmentIcs } from "../src/services/ics";

/**
 * El iCalendar que va adjunto al aviso de turno.
 *
 * Los errores de este formato son silenciosos: el mail llega igual y el
 * cliente simplemente no ofrece agregar el evento, o lo importa con los
 * datos cortados. Por eso se prueban el formato de fechas, el escapeo y el
 * plegado de líneas, que es donde se rompe.
 */

function ics(overrides?: Partial<Parameters<typeof buildAppointmentIcs>[0]>) {
  return buildAppointmentIcs({
    appointmentId: "apt-123",
    start: new Date("2026-09-18T14:00:00.000Z"),
    end: new Date("2026-09-18T14:30:00.000Z"),
    summary: "Limpieza",
    description: "Paciente: Ana",
    location: "Consultorio 1",
    organizerName: "Clínica Demo",
    organizerEmail: "recepcion@demo.com",
    attendeeName: "Dra. Gómez",
    attendeeEmail: "gomez@demo.com",
    now: new Date("2026-09-15T10:00:00.000Z"),
    ...overrides,
  });
}

describe("buildAppointmentIcs", () => {
  /** Sin REQUEST, Gmail muestra el archivo pero no ofrece agregar el evento. */
  it("es una invitación, no un archivo suelto", () => {
    expect(ics()).toContain("METHOD:REQUEST");
  });

  it("usa el formato de fecha UTC del RFC", () => {
    const salida = ics();
    expect(salida).toContain("DTSTART:20260918T140000Z");
    expect(salida).toContain("DTEND:20260918T143000Z");
    expect(salida).toContain("DTSTAMP:20260915T100000Z");
  });

  it("usa el id del turno como UID, para poder actualizarlo después", () => {
    expect(ics()).toContain("UID:apt-123@pontic");
  });

  it("pone a la clínica como organizadora y al profesional como invitado", () => {
    const salida = ics();
    expect(salida).toContain("ORGANIZER;CN=Clínica Demo:mailto:recepcion@demo.com");
    expect(salida).toContain("mailto:gomez@demo.com");
  });

  /**
   * El caso que rompe el archivo en silencio: una coma sin escapar corta el
   * campo en dos y el evento llega con el título a la mitad.
   */
  it("escapa las comas, los punto y coma y las barras", () => {
    const salida = ics({ summary: "limpieza, control; profunda \\ completa" });
    expect(salida).toContain("SUMMARY:limpieza\\, control\\; profunda \\\\ completa");
  });

  it("convierte los saltos de línea en \\n literal", () => {
    const salida = ics({ description: "Paciente: Ana\nServicio: Limpieza" });
    expect(salida).toContain("DESCRIPTION:Paciente: Ana\\nServicio: Limpieza");
  });

  it("omite la ubicación si no hay espacio asignado", () => {
    expect(ics({ location: null })).not.toContain("LOCATION:");
  });

  it("usa CRLF, como exige el RFC", () => {
    expect(ics()).toContain("\r\n");
    expect(ics().split("\r\n")[0]).toBe("BEGIN:VCALENDAR");
  });

  it("abre y cierra el evento y el calendario", () => {
    const salida = ics();
    for (const marca of ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "END:VEVENT", "END:VCALENDAR"]) {
      expect(salida).toContain(marca);
    }
  });

  /** El RFC exige 75 octetos por línea; algunos clientes lo hacen valer. */
  it("pliega las líneas largas y las continúa con un espacio", () => {
    const salida = ics({ description: "x".repeat(200) });
    const lineas = salida.split("\r\n");

    for (const linea of lineas) {
      expect(Buffer.from(linea, "utf8").length).toBeLessThanOrEqual(75);
    }
    // La continuación de DESCRIPTION arranca con espacio.
    const i = lineas.findIndex((l) => l.startsWith("DESCRIPTION:"));
    expect(lineas[i + 1].startsWith(" ")).toBe(true);
  });

  /**
   * Se cuenta en bytes, no en caracteres: cortar al medio de un acento deja
   * un byte suelto y el archivo se vuelve ilegible.
   */
  it("no parte un carácter multibyte al plegar", () => {
    const salida = ics({ description: "á".repeat(100) });

    for (const linea of salida.split("\r\n")) {
      expect(Buffer.from(linea, "utf8").length).toBeLessThanOrEqual(75);
      expect(linea).not.toContain("�");
    }
    // Y el texto sobrevive entero al desplegarlo.
    const desplegado = salida.replace(/\r\n /g, "");
    expect(desplegado).toContain(`DESCRIPTION:${"á".repeat(100)}`);
  });
});
