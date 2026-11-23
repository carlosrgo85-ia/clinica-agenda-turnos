import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import {
  addPatientComment,
  createPatient,
  deletePatientComment,
  getPatientDetail,
  joinFullName,
  listPatients,
  parseDateKey,
  patientNameParts,
  splitFullName,
  updatePatient,
} from "../src/services/patient-admin";

/**
 * El módulo de pacientes. `Patient.name` sigue siendo el nombre completo que usa
 * todo el sistema; acá se edita en nombre y apellido y se recalcula.
 */

const clinicIds: string[] = [];

async function clinica() {
  const c = await prisma.clinic.create({
    data: {
      name: `Clínica pacientes ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `pc-${Date.now()}-${Math.random()}`,
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

afterEach(async () => {
  for (const clinicId of clinicIds) {
    await prisma.patientComment.deleteMany({ where: { clinicId } });
    await prisma.appointment.deleteMany({ where: { clinicId } });
    await prisma.package.deleteMany({ where: { clinicId } });
    await prisma.patient.deleteMany({ where: { clinicId } });
    await prisma.room.deleteMany({ where: { clinicId } });
    await prisma.professional.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
});

const alta = (clinicId: string, first = "María", last = "López", phone = "5491100000001") =>
  createPatient({ clinicId, firstName: first, lastName: last, phone });

describe("nombre y apellido", () => {
  it("parte el nombre completo en la primera palabra y el resto", () => {
    expect(splitFullName("María López")).toEqual({ firstName: "María", lastName: "López" });
    expect(splitFullName("Ana María García López")).toEqual({ firstName: "Ana", lastName: "María García López" });
    expect(splitFullName("Cher")).toEqual({ firstName: "Cher", lastName: "" });
    expect(splitFullName("  ")).toEqual({ firstName: "", lastName: "" });
    expect(splitFullName(null)).toEqual({ firstName: "", lastName: "" });
  });

  it("usa las partes guardadas y, si no hay, parte el nombre completo al leer", () => {
    expect(patientNameParts({ name: "Ana María García", firstName: "Ana María", lastName: "García" })).toEqual({
      firstName: "Ana María",
      lastName: "García",
    });
    expect(patientNameParts({ name: "Juan Pérez", firstName: null, lastName: null })).toEqual({
      firstName: "Juan",
      lastName: "Pérez",
    });
  });

  it("joinFullName arma el nombre completo sin espacios de más", () => {
    expect(joinFullName(" María ", "  López ")).toBe("María López");
    expect(joinFullName("Cher", "")).toBe("Cher");
  });

  it("la migración dejó las fichas viejas con nombre y apellido partidos", async () => {
    const huerfanos = await prisma.patient.count({
      where: { name: { not: null }, firstName: null, createdAt: { lt: new Date("2026-11-13T00:00:00Z") } },
    });
    expect(huerfanos).toBe(0);
  });
});

describe("alta de un paciente", () => {
  it("guarda las partes y arma el nombre completo", async () => {
    const c = await clinica();
    const r = await alta(c.id, "María", "López");
    expect(r.ok && r.value).toMatchObject({ name: "María López", firstName: "María", lastName: "López" });
  });

  it("el apellido es opcional", async () => {
    const c = await clinica();
    const r = await alta(c.id, "Cher", "");
    expect(r.ok && r.value).toMatchObject({ name: "Cher", lastName: null });
  });

  it("rechaza sin nombre, con un teléfono corto, o la misma persona en el mismo número", async () => {
    const c = await clinica();
    expect(await createPatient({ clinicId: c.id, firstName: "", phone: "5491100000001" })).toMatchObject({ ok: false, reason: "datos_invalidos" });
    expect(await createPatient({ clinicId: c.id, firstName: "Ana", phone: "123" })).toMatchObject({ ok: false, reason: "telefono_invalido" });
    await alta(c.id, "María", "López");
    // Sin acentos ni mayúsculas es la misma persona.
    expect(await alta(c.id, "MARIA", "LOPEZ")).toMatchObject({ ok: false, reason: "nombre_duplicado" });
    // Otra persona en el mismo número (la familia) sí se puede.
    expect((await alta(c.id, "Pedro", "López")).ok).toBe(true);
  });
});

describe("editar la ficha", () => {
  it("recalcula el nombre completo al cambiar el nombre o el apellido", async () => {
    const c = await clinica();
    const p = await alta(c.id);
    if (!p.ok) throw new Error("fixture");
    const r = await updatePatient({ clinicId: c.id, patientId: p.value.id, changes: { lastName: "Gómez" } });
    expect(r.ok && r.value).toMatchObject({ name: "María Gómez", firstName: "María", lastName: "Gómez" });
  });

  it("una ficha que creó el asistente (solo `name`) se puede completar por partes", async () => {
    const c = await clinica();
    const p = await prisma.patient.create({ data: { clinicId: c.id, phone: "5491100000002", name: "Juan Pérez" } });
    const r = await updatePatient({ clinicId: c.id, patientId: p.id, changes: { firstName: "Juan Carlos" } });
    // El apellido salió de partir `name`, no se perdió.
    expect(r.ok && r.value).toMatchObject({ name: "Juan Carlos Pérez", firstName: "Juan Carlos", lastName: "Pérez" });
  });

  it("no deja dos personas con el mismo nombre en el mismo WhatsApp", async () => {
    const c = await clinica();
    await alta(c.id, "María", "López");
    const otra = await alta(c.id, "Pedro", "López");
    if (!otra.ok) throw new Error("fixture");
    expect(await updatePatient({ clinicId: c.id, patientId: otra.value.id, changes: { firstName: "María" } }))
      .toMatchObject({ ok: false, reason: "nombre_duplicado" });
  });

  it("guarda observaciones y las puede borrar", async () => {
    const c = await clinica();
    const p = await alta(c.id);
    if (!p.ok) throw new Error("fixture");
    const con = await updatePatient({ clinicId: c.id, patientId: p.value.id, changes: { observations: " Prefiere las tardes " } });
    expect(con.ok && con.value.observations).toBe("Prefiere las tardes");
    const sin = await updatePatient({ clinicId: c.id, patientId: p.value.id, changes: { observations: "" } });
    expect(sin.ok && sin.value.observations).toBeNull();
  });

  it("rechaza textos demasiado largos y datos de otro tipo", async () => {
    const c = await clinica();
    const p = await alta(c.id);
    if (!p.ok) throw new Error("fixture");
    for (const changes of [
      { observations: "x".repeat(2001) },
      { suggestedNextVisitNote: "x".repeat(201) },
      { outreachOptOut: "si" },
      { firstName: "" },
    ]) {
      expect(await updatePatient({ clinicId: c.id, patientId: p.value.id, changes })).toMatchObject({ ok: false, reason: "datos_invalidos" });
    }
  });

  it("no toca un paciente de otra clínica", async () => {
    const c = await clinica();
    const ajena = await clinica();
    const p = await alta(ajena.id);
    if (!p.ok) throw new Error("fixture");
    expect(await updatePatient({ clinicId: c.id, patientId: p.value.id, changes: { observations: "x" } })).toMatchObject({ ok: false, reason: "no_encontrado" });
    expect(await getPatientDetail({ clinicId: c.id, patientId: p.value.id })).toMatchObject({ ok: false, reason: "no_encontrado" });
  });
});

describe("próxima cita sugerida", () => {
  it("rechaza los días imposibles en vez de correrlos al mes siguiente", () => {
    expect(parseDateKey("2030-02-31")).toBeNull();
    expect(parseDateKey("2030-13-01")).toBeNull();
    expect(parseDateKey("30-02-2030")).toBeNull();
    expect(parseDateKey("2030-02-28")?.toISOString().slice(0, 10)).toBe("2030-02-28");
  });

  it("se guarda, se lee y se quita", async () => {
    const c = await clinica();
    const p = await alta(c.id);
    if (!p.ok) throw new Error("fixture");
    const con = await updatePatient({
      clinicId: c.id, patientId: p.value.id,
      changes: { suggestedNextVisitDate: "2030-09-10", suggestedNextVisitNote: "control" },
    });
    expect(con.ok && con.value.suggestedNextVisitDate?.toISOString().slice(0, 10)).toBe("2030-09-10");
    expect(await updatePatient({ clinicId: c.id, patientId: p.value.id, changes: { suggestedNextVisitDate: "2030-02-31" } }))
      .toMatchObject({ ok: false, reason: "datos_invalidos" });
    const sin = await updatePatient({ clinicId: c.id, patientId: p.value.id, changes: { suggestedNextVisitDate: null } });
    expect(sin.ok && sin.value.suggestedNextVisitDate).toBeNull();
  });

  it("cambiar la fecha rearma el contacto; repetir la misma no", async () => {
    const c = await clinica();
    const p = await alta(c.id);
    if (!p.ok) throw new Error("fixture");
    await updatePatient({ clinicId: c.id, patientId: p.value.id, changes: { suggestedNextVisitDate: "2030-09-10" } });
    await prisma.patient.update({ where: { id: p.value.id }, data: { nextVisitOutreachSentAt: new Date() } });

    await updatePatient({ clinicId: c.id, patientId: p.value.id, changes: { suggestedNextVisitDate: "2030-09-10", observations: "x" } });
    expect((await prisma.patient.findUniqueOrThrow({ where: { id: p.value.id } })).nextVisitOutreachSentAt).not.toBeNull();

    await updatePatient({ clinicId: c.id, patientId: p.value.id, changes: { suggestedNextVisitDate: "2030-10-01" } });
    expect((await prisma.patient.findUniqueOrThrow({ where: { id: p.value.id } })).nextVisitOutreachSentAt).toBeNull();
  });
});

describe("comentarios", () => {
  it("se agregan con autor y fecha, y salen del más nuevo al más viejo", async () => {
    const c = await clinica();
    const p = await alta(c.id);
    if (!p.ok) throw new Error("fixture");
    await addPatientComment({ clinicId: c.id, patientId: p.value.id, userId: "u1", authorName: "Ana", text: "Primero" });
    await new Promise((r) => setTimeout(r, 5));
    await addPatientComment({ clinicId: c.id, patientId: p.value.id, userId: "u2", authorName: "Luis", text: "Segundo" });
    const d = await getPatientDetail({ clinicId: c.id, patientId: p.value.id });
    expect(d.ok && d.value.comentarios.map((x) => `${x.authorName}: ${x.text}`)).toEqual(["Luis: Segundo", "Ana: Primero"]);
  });

  it("rechaza vacíos y larguísimos, y no comenta fichas ajenas", async () => {
    const c = await clinica();
    const ajena = await clinica();
    const p = await alta(c.id);
    const q = await alta(ajena.id);
    if (!p.ok || !q.ok) throw new Error("fixture");
    for (const text of ["", "   ", "x".repeat(2001), 5]) {
      expect(await addPatientComment({ clinicId: c.id, patientId: p.value.id, userId: "u", authorName: "A", text }))
        .toMatchObject({ ok: false, reason: "datos_invalidos" });
    }
    expect(await addPatientComment({ clinicId: c.id, patientId: q.value.id, userId: "u", authorName: "A", text: "hola" }))
      .toMatchObject({ ok: false, reason: "no_encontrado" });
  });

  it("se borran solo desde su paciente y su clínica", async () => {
    const c = await clinica();
    const otra = await clinica();
    const p = await alta(c.id);
    if (!p.ok) throw new Error("fixture");
    const cm = await addPatientComment({ clinicId: c.id, patientId: p.value.id, userId: "u", authorName: "A", text: "hola" });
    if (!cm.ok) throw new Error("fixture");
    expect(await deletePatientComment({ clinicId: otra.id, patientId: p.value.id, commentId: cm.value.id })).toMatchObject({ ok: false });
    expect(await deletePatientComment({ clinicId: c.id, patientId: p.value.id, commentId: cm.value.id })).toMatchObject({ ok: true });
  });
});

describe("la lista", () => {
  it("busca por nombre, apellido o teléfono, sin acentos ni mayúsculas en lo que Postgres resuelve", async () => {
    const c = await clinica();
    await alta(c.id, "María", "López", "5491100000001");
    await alta(c.id, "Juan", "Pérez", "5491100000002");
    const porApellido = await listPatients({ clinicId: c.id, q: "pérez" });
    expect(porApellido.ok && porApellido.value.pacientes.map((x) => x.name)).toEqual(["Juan Pérez"]);
    const porTelefono = await listPatients({ clinicId: c.id, q: "0001" });
    expect(porTelefono.ok && porTelefono.value.pacientes.map((x) => x.firstName)).toEqual(["María"]);
  });

  it("filtra por fecha sugerida y ordena lo más próximo primero", async () => {
    const c = await clinica();
    const a = await alta(c.id, "Ana", "Uno", "5491100000011");
    const b = await alta(c.id, "Beto", "Dos", "5491100000012");
    const d = await alta(c.id, "Dora", "Tres", "5491100000013");
    if (!a.ok || !b.ok || !d.ok) throw new Error("fixture");
    await updatePatient({ clinicId: c.id, patientId: a.value.id, changes: { suggestedNextVisitDate: "2030-09-20" } });
    await updatePatient({ clinicId: c.id, patientId: b.value.id, changes: { suggestedNextVisitDate: "2030-09-05" } });
    // Dora no tiene sugerencia.
    const r = await listPatients({ clinicId: c.id, suggestedFrom: "2030-09-01", suggestedTo: "2030-09-30" });
    expect(r.ok && r.value.pacientes.map((x) => x.firstName)).toEqual(["Beto", "Ana"]);
    const acotada = await listPatients({ clinicId: c.id, suggestedFrom: "2030-09-10", suggestedTo: "2030-09-30" });
    expect(acotada.ok && acotada.value.pacientes.map((x) => x.firstName)).toEqual(["Ana"]);
    expect(await listPatients({ clinicId: c.id, suggestedFrom: "2030-02-31" })).toMatchObject({ ok: false });
  });

  it("no mezcla clínicas y pagina", async () => {
    const c = await clinica();
    const ajena = await clinica();
    for (let i = 0; i < 3; i++) await alta(c.id, `P${i}`, "X", `549110000010${i}`);
    await alta(ajena.id, "Ajeno", "Y", "5491100000999");
    const r = await listPatients({ clinicId: c.id, limit: 2 });
    expect(r.ok && r.value.total).toBe(3);
    expect(r.ok && r.value.pacientes).toHaveLength(2);
  });

  it("trae la próxima cita, la última visita y los paquetes activos", async () => {
    const c = await clinica();
    const p = await alta(c.id);
    if (!p.ok) throw new Error("fixture");
    const base = { clinicId: c.id, patientId: p.value.id, professionalId: c.professionals[0].id, roomId: c.rooms[0].id, service: "Limpieza" };
    await prisma.appointment.create({ data: { ...base, startTime: new Date("2030-01-10T10:00:00Z"), endTime: new Date("2030-01-10T10:30:00Z"), status: "atendido" } });
    await prisma.appointment.create({ data: { ...base, startTime: new Date("2030-06-10T10:00:00Z"), endTime: new Date("2030-06-10T10:30:00Z") } });
    const r = await listPatients({ clinicId: c.id, now: new Date("2030-03-01T00:00:00Z") });
    const fila = r.ok ? r.value.pacientes[0] : null;
    expect(fila?.lastVisitAt).toBe("2030-01-10T10:00:00.000Z");
    expect(fila?.nextAppointmentAt).toBe("2030-06-10T10:00:00.000Z");
  });
});

describe("la ficha completa", () => {
  it("junta datos, comentarios, historial de citas y paquetes", async () => {
    const c = await clinica();
    const p = await alta(c.id);
    if (!p.ok) throw new Error("fixture");
    await addPatientComment({ clinicId: c.id, patientId: p.value.id, userId: "u", authorName: "Ana", text: "Llamar antes" });
    await prisma.appointment.create({
      data: { clinicId: c.id, patientId: p.value.id, professionalId: c.professionals[0].id, roomId: c.rooms[0].id, service: "Limpieza",
        startTime: new Date("2030-01-10T10:00:00Z"), endTime: new Date("2030-01-10T10:30:00Z"), status: "atendido" },
    });
    const d = await getPatientDetail({ clinicId: c.id, patientId: p.value.id });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.value.paciente).toMatchObject({ name: "María López", firstName: "María", lastName: "López" });
    expect(d.value.comentarios).toHaveLength(1);
    expect(d.value.citas).toMatchObject([{ service: "Limpieza", professional: "Gómez", status: "atendido" }]);
    expect(d.value.paquetes).toEqual([]);
  });
});
