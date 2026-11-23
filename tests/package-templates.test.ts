import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import {
  assignPackage,
  createPackageTemplate,
  listPackageTemplates,
  updatePackageTemplate,
} from "../src/services/packages";

/**
 * El catálogo de paquetes: se define UNA vez y se asigna a cada paciente. Asignar
 * COPIA los valores, así que editar la plantilla no mueve lo ya asignado.
 */

const clinicIds: string[] = [];

async function escenario() {
  const clinic = await prisma.clinic.create({
    data: {
      name: `Clínica catálogo ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `pt-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "test@example.com",
      timezone: "UTC",
      services: "x",
    },
  });
  clinicIds.push(clinic.id);
  const laser = await prisma.service.create({ data: { clinicId: clinic.id, name: "Láser", durationMinutes: 30 } });
  const limpieza = await prisma.service.create({ data: { clinicId: clinic.id, name: "Limpieza", durationMinutes: 30 } });
  const maria = await prisma.patient.create({ data: { clinicId: clinic.id, phone: "5491100000001", name: "María López" } });
  const juan = await prisma.patient.create({ data: { clinicId: clinic.id, phone: "5491100000002", name: "Juan Pérez" } });
  return { clinic, laser, limpieza, maria, juan };
}
type E = Awaited<ReturnType<typeof escenario>>;

async function plantilla(e: E, over?: { name?: string; sessions?: number; serviceId?: string }) {
  const r = await createPackageTemplate({
    clinicId: e.clinic.id,
    name: over?.name ?? "Láser piernas",
    serviceId: over?.serviceId ?? e.laser.id,
    totalSessions: over?.sessions ?? 6,
    notes: "Incluye retoque",
  });
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

afterEach(async () => {
  for (const clinicId of clinicIds) {
    await prisma.package.deleteMany({ where: { clinicId } });
    await prisma.packageTemplate.deleteMany({ where: { clinicId } });
    await prisma.patient.deleteMany({ where: { clinicId } });
    await prisma.service.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
});

describe("el catálogo", () => {
  it("crea una plantilla con su servicio y sus sesiones", async () => {
    const e = await escenario();
    const t = await plantilla(e);
    expect(t).toMatchObject({ name: "Láser piernas", serviceName: "Láser", totalSessions: 6, active: true, asignados: 0 });
  });

  it("el servicio es obligatorio y tiene que ser uno activo de la clínica", async () => {
    const e = await escenario();
    const ajena = await escenario();
    expect(await createPackageTemplate({ clinicId: e.clinic.id, name: "X", serviceId: undefined, totalSessions: 3 }))
      .toMatchObject({ ok: false, reason: "servicio_requerido" });
    expect(await createPackageTemplate({ clinicId: e.clinic.id, name: "X", serviceId: ajena.laser.id, totalSessions: 3 }))
      .toMatchObject({ ok: false, reason: "servicio_no_encontrado" });
    await prisma.service.update({ where: { id: e.laser.id }, data: { active: false } });
    expect(await createPackageTemplate({ clinicId: e.clinic.id, name: "X", serviceId: e.laser.id, totalSessions: 3 }))
      .toMatchObject({ ok: false, reason: "servicio_no_encontrado" });
  });

  it("rechaza nombres vacíos, cantidades inválidas y nombres repetidos", async () => {
    const e = await escenario();
    for (const [name, sessions] of [["", 3], ["  ", 3], ["X", 0], ["X", 201], ["X", 2.5]] as const) {
      expect(await createPackageTemplate({ clinicId: e.clinic.id, name, serviceId: e.laser.id, totalSessions: sessions }))
        .toMatchObject({ ok: false, reason: "datos_invalidos" });
    }
    await plantilla(e);
    expect(await createPackageTemplate({ clinicId: e.clinic.id, name: "Láser piernas", serviceId: e.laser.id, totalSessions: 3 }))
      .toMatchObject({ ok: false, reason: "nombre_duplicado" });
  });

  it("el mismo nombre puede existir en otra clínica", async () => {
    const e = await escenario();
    const otra = await escenario();
    await plantilla(e);
    expect((await createPackageTemplate({ clinicId: otra.clinic.id, name: "Láser piernas", serviceId: otra.laser.id, totalSessions: 3 })).ok).toBe(true);
  });

  it("lista las activas primero, con a cuántos pacientes se asignó", async () => {
    const e = await escenario();
    const a = await plantilla(e, { name: "A pack" });
    await plantilla(e, { name: "B pack" });
    await updatePackageTemplate({ clinicId: e.clinic.id, templateId: a.id, active: false });
    await assignPackage({ clinicId: e.clinic.id, userId: "u", patientId: e.maria.id, templateId: (await listPackageTemplates({ clinicId: e.clinic.id, onlyActive: true }))[0].id });
    const todas = await listPackageTemplates({ clinicId: e.clinic.id });
    expect(todas.map((t) => `${t.name}:${t.active}:${t.asignados}`)).toEqual(["B pack:true:1", "A pack:false:0"]);
    expect(await listPackageTemplates({ clinicId: e.clinic.id, onlyActive: true })).toHaveLength(1);
  });
});

describe("asignar un paquete del catálogo a un paciente", () => {
  it("copia el nombre, el servicio y las sesiones, y registra de dónde salió", async () => {
    const e = await escenario();
    const t = await plantilla(e);
    const r = await assignPackage({ clinicId: e.clinic.id, userId: "u1", patientId: e.maria.id, templateId: t.id });
    expect(r.ok && r.value).toMatchObject({
      name: "Láser piernas",
      serviceId: e.laser.id,
      serviceName: "Láser",
      totalSessions: 6,
      usedSessions: 0,
      notes: "Incluye retoque",
      templateId: t.id,
      patientId: e.maria.id,
    });
  });

  it("el mismo paquete del catálogo se asigna a varios pacientes, cada uno con el suyo", async () => {
    const e = await escenario();
    const t = await plantilla(e);
    const a = await assignPackage({ clinicId: e.clinic.id, userId: "u", patientId: e.maria.id, templateId: t.id });
    const b = await assignPackage({ clinicId: e.clinic.id, userId: "u", patientId: e.juan.id, templateId: t.id });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.value.id).not.toBe(b.value.id);
    expect((await listPackageTemplates({ clinicId: e.clinic.id }))[0].asignados).toBe(2);
  });

  it("editar la plantilla NO cambia lo que ya se asignó", async () => {
    const e = await escenario();
    const t = await plantilla(e);
    const a = await assignPackage({ clinicId: e.clinic.id, userId: "u", patientId: e.maria.id, templateId: t.id });
    if (!a.ok) throw new Error("fixture");

    await updatePackageTemplate({ clinicId: e.clinic.id, templateId: t.id, name: "Láser piernas (nuevo)", totalSessions: 10, serviceId: e.limpieza.id });

    const despues = await prisma.package.findUniqueOrThrow({ where: { id: a.value.id } });
    expect(despues).toMatchObject({ name: "Láser piernas", totalSessions: 6, serviceId: e.laser.id, serviceName: "Láser" });
    // Lo que se asigne de ahora en más sí sale con los valores nuevos.
    const b = await assignPackage({ clinicId: e.clinic.id, userId: "u", patientId: e.juan.id, templateId: t.id });
    expect(b.ok && b.value).toMatchObject({ name: "Láser piernas (nuevo)", totalSessions: 10, serviceName: "Limpieza" });
  });

  it("una plantilla desactivada o de otra clínica no se puede asignar", async () => {
    const e = await escenario();
    const ajena = await escenario();
    const t = await plantilla(e);
    const deOtra = await plantilla(ajena);
    expect(await assignPackage({ clinicId: e.clinic.id, userId: "u", patientId: e.maria.id, templateId: deOtra.id }))
      .toMatchObject({ ok: false, reason: "plantilla_no_encontrada" });
    await updatePackageTemplate({ clinicId: e.clinic.id, templateId: t.id, active: false });
    expect(await assignPackage({ clinicId: e.clinic.id, userId: "u", patientId: e.maria.id, templateId: t.id }))
      .toMatchObject({ ok: false, reason: "plantilla_no_encontrada" });
    expect(await assignPackage({ clinicId: e.clinic.id, userId: "u", patientId: e.maria.id, templateId: undefined }))
      .toMatchObject({ ok: false, reason: "plantilla_no_encontrada" });
    expect(await prisma.package.count({ where: { clinicId: e.clinic.id } })).toBe(0);
  });

  it("no se le asigna a un paciente de otra clínica", async () => {
    const e = await escenario();
    const ajena = await escenario();
    const t = await plantilla(e);
    expect(await assignPackage({ clinicId: e.clinic.id, userId: "u", patientId: ajena.maria.id, templateId: t.id }))
      .toMatchObject({ ok: false, reason: "paciente_no_encontrado" });
  });

  it("desactivar una plantilla no toca lo asignado", async () => {
    const e = await escenario();
    const t = await plantilla(e);
    const a = await assignPackage({ clinicId: e.clinic.id, userId: "u", patientId: e.maria.id, templateId: t.id });
    if (!a.ok) throw new Error("fixture");
    await updatePackageTemplate({ clinicId: e.clinic.id, templateId: t.id, active: false });
    expect((await prisma.package.findUniqueOrThrow({ where: { id: a.value.id } })).active).toBe(true);
  });
});
