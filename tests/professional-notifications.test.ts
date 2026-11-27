import { beforeEach, describe, expect, it, vi } from "vitest";

const envios = vi.hoisted(() => ({
  correos: [] as Array<Record<string, unknown>>,
  plantillas: [] as Array<{ to: string; plantilla: string; params: string[] }>,
}));

vi.mock("../src/services/email", () => ({
  sendProfessionalAppointmentEmail: async (p: Record<string, unknown>) => {
    envios.correos.push(p);
  },
}));
vi.mock("../src/services/whatsapp", () => ({
  clinicWhatsAppCreds: () => ({ token: "t", phoneNumberId: "p" }),
  sendTemplateMessage: async (_c: unknown, to: string, plantilla: string, _l: string, params: string[]) => {
    envios.plantillas.push({ to, plantilla, params });
  },
}));
vi.mock("../src/services/system-events", () => ({
  describeError: String,
  recordSystemEvent: async () => undefined,
  SYSTEM_EVENT_KINDS: { WHATSAPP_ENVIO: "whatsapp_envio" },
}));

import { notifyProfessionalOfAppointment, PLANTILLAS_PROFESIONAL } from "../src/services/professional-notifications";
import { CLINIC_TEMPLATES } from "../src/services/whatsapp-templates";

const CLINICA = { id: "c1", name: "Clínica", email: "c@x.test", timezone: "UTC", country: "MX" } as never;
const base = {
  clinic: CLINICA,
  appointmentId: "a1",
  startTime: new Date("2030-06-17T15:00:00Z"),
  endTime: new Date("2030-06-17T15:30:00Z"),
  service: "Limpieza",
  patientName: "María López",
  roomName: "Sala 1",
  preferredRoomUnavailable: false,
};
const prof = (o: Record<string, unknown> = {}) =>
  ({ name: "Gómez", contactEmail: "g@x.test", whatsappPhone: "5215511112222", notifyByEmail: true, notifyByWhatsapp: true, ...o }) as never;

beforeEach(() => {
  envios.correos.length = 0;
  envios.plantillas.length = 0;
});

describe("avisos al profesional: canal y tipo de aviso", () => {
  it("cada evento usa su plantilla de WhatsApp y su título de correo", async () => {
    for (const evento of ["agendada", "modificada", "cancelada"] as const) {
      await notifyProfessionalOfAppointment({ ...base, professional: prof(), evento });
    }
    expect(envios.plantillas.map((p) => p.plantilla)).toEqual([
      "cita_asignada_profesional",
      "cita_modificada_profesional",
      "cita_cancelada_profesional",
    ]);
    expect(envios.correos.map((c) => c.evento)).toEqual(["agendada", "modificada", "cancelada"]);
    expect(envios.plantillas[1].params).toHaveLength(5);
  });

  it("sin evento indicado es una cita nueva, como antes", async () => {
    await notifyProfessionalOfAppointment({ ...base, professional: prof() });
    expect(envios.plantillas[0].plantilla).toBe("cita_asignada_profesional");
  });

  it("solo avisa de los tipos que eligió", async () => {
    const p = prof({ notifyOnCreate: true, notifyOnChange: false, notifyOnCancel: false });
    await notifyProfessionalOfAppointment({ ...base, professional: p, evento: "agendada" });
    await notifyProfessionalOfAppointment({ ...base, professional: p, evento: "modificada" });
    await notifyProfessionalOfAppointment({ ...base, professional: p, evento: "cancelada" });
    expect(envios.correos.map((c) => c.evento)).toEqual(["agendada"]);
    expect(envios.plantillas).toHaveLength(1);
  });

  it("sin ningún medio no sale nada, aunque tenga los tres tipos prendidos", async () => {
    const p = prof({ notifyByEmail: false, notifyByWhatsapp: false });
    for (const evento of ["agendada", "modificada", "cancelada"] as const) {
      await notifyProfessionalOfAppointment({ ...base, professional: p, evento });
    }
    expect(envios.correos).toHaveLength(0);
    expect(envios.plantillas).toHaveLength(0);
  });

  it("un solo medio: solo ese", async () => {
    await notifyProfessionalOfAppointment({ ...base, professional: prof({ notifyByWhatsapp: false }), evento: "cancelada" });
    expect(envios.correos).toHaveLength(1);
    expect(envios.plantillas).toHaveLength(0);
  });

  it("las preferencias ausentes cuentan como prendidas (el default de la base)", async () => {
    await notifyProfessionalOfAppointment({ ...base, professional: prof(), evento: "cancelada" });
    expect(envios.correos).toHaveLength(1);
  });

  it("la cancelación por reasignación se le dice al correo", async () => {
    await notifyProfessionalOfAppointment({ ...base, professional: prof(), evento: "cancelada", reasignada: true });
    expect(envios.correos[0].reasignada).toBe(true);
  });

  it("las tres plantillas están en el catálogo con el mismo número de variables que manda el código (5)", () => {
    for (const nombre of Object.values(PLANTILLAS_PROFESIONAL)) {
      const t = CLINIC_TEMPLATES.find((x) => x.name === nombre);
      expect(t, nombre).toBeDefined();
      expect(t!.ejemplos).toHaveLength(5);
      expect(t!.body.match(/\{\{\d+\}\}/g)).toHaveLength(5);
    }
  });
});
