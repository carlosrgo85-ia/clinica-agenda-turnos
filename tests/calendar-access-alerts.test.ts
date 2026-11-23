import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";

// El mail no sale de verdad: se registra para poder contarlo.
const sendMail = vi.fn(async (_params: unknown) => undefined);
vi.mock("../src/services/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/email")>()),
  sendCalendarAccessRevokedAlert: (params: unknown) => sendMail(params),
}));

import { alertClinicsWithRevokedCalendars } from "../src/jobs/calendar-access-alerts";
import { getConfigHealth } from "../src/services/config-health";

/**
 * Aviso de calendario revocado. Contra el Postgres local:
 * docker compose up -d db
 */

const clinicIds: string[] = [];

async function crearClinica(options?: { cuenta?: "revocada" | "activa"; enUso?: boolean }) {
  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica rev ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `rev-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "test@example.com",
      timezone: "America/Argentina/Buenos_Aires",
      services: "Consulta",
      professionals: { create: [{ name: "Profesional 1" }] },
    },
  });
  clinicIds.push(clinic.id);

  const account = await prisma.googleAccount.create({
    data: {
      clinicId: clinic.id,
      email: "cal@example.com",
      refreshTokenEncrypted: encryptToken("r"),
      scope: "x",
      revokedAt: options?.cuenta === "activa" ? null : new Date(),
    },
  });

  if (options?.enUso !== false) {
    await prisma.clinic.update({
      where: { id: clinic.id },
      data: { sharedCalendarId: "c@group.calendar.google.com", sharedCalendarAccountId: account.id },
    });
  }
  return { clinic, account };
}

beforeEach(() => sendMail.mockClear());

afterEach(async () => {
  for (const id of clinicIds) {
    await prisma.clinic.update({
      where: { id },
      data: { sharedCalendarAccountId: null },
    });
    await prisma.googleAccount.deleteMany({ where: { clinicId: id } });
    await prisma.professional.deleteMany({ where: { clinicId: id } });
    await prisma.clinic.delete({ where: { id } });
  }
  clinicIds.length = 0;
});

describe("alertClinicsWithRevokedCalendars", () => {
  it("avisa una vez a la clínica con una cuenta revocada en uso y la marca", async () => {
    const { clinic, account } = await crearClinica();

    const avisadas = await alertClinicsWithRevokedCalendars(new Date(), { clinicIds: [clinic.id] });

    expect(avisadas).toBe(1);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0]?.[0]).toMatchObject({ cuentas: ["cal@example.com (Google)"] });
    const guardada = await prisma.googleAccount.findUnique({ where: { id: account.id } });
    expect(guardada?.revokedAlertSentAt).not.toBeNull();
  });

  it("no repite el aviso dentro de las 24 horas, y sí pasado ese tiempo", async () => {
    const { clinic } = await crearClinica();
    const ahora = new Date();

    await alertClinicsWithRevokedCalendars(ahora, { clinicIds: [clinic.id] });
    const dosHorasDespues = new Date(ahora.getTime() + 2 * 3600_000);
    expect(await alertClinicsWithRevokedCalendars(dosHorasDespues, { clinicIds: [clinic.id] })).toBe(0);

    const manana = new Date(ahora.getTime() + 25 * 3600_000);
    expect(await alertClinicsWithRevokedCalendars(manana, { clinicIds: [clinic.id] })).toBe(1);
  });

  it("no avisa si la cuenta no está revocada", async () => {
    const { clinic } = await crearClinica({ cuenta: "activa" });
    expect(await alertClinicsWithRevokedCalendars(new Date(), { clinicIds: [clinic.id] })).toBe(0);
  });

  it("no avisa de una cuenta revocada que nadie usa", async () => {
    const { clinic } = await crearClinica({ enUso: false });
    expect(await alertClinicsWithRevokedCalendars(new Date(), { clinicIds: [clinic.id] })).toBe(0);
  });

  it("si el mail falla no marca la cuenta, así se reintenta", async () => {
    const { clinic, account } = await crearClinica();
    sendMail.mockRejectedValueOnce(new Error("SMTP caído"));

    expect(await alertClinicsWithRevokedCalendars(new Date(), { clinicIds: [clinic.id] })).toBe(0);
    const guardada = await prisma.googleAccount.findUnique({ where: { id: account.id } });
    expect(guardada?.revokedAlertSentAt).toBeNull();
  });
});

describe("getConfigHealth con un calendario revocado", () => {
  it("lo informa como bloqueante, y deja de informarlo al reconectar", async () => {
    const { clinic, account } = await crearClinica();

    const antes = await getConfigHealth(clinic.id);
    expect(antes?.issues.find((i) => i.code === "calendario_revocado")?.severidad).toBe("bloqueante");

    await prisma.googleAccount.update({ where: { id: account.id }, data: { revokedAt: null } });
    const despues = await getConfigHealth(clinic.id);
    expect(despues?.issues.some((i) => i.code === "calendario_revocado")).toBe(false);
  });
});
