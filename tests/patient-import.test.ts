import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client";
import { encryptToken } from "../src/services/crypto";
import { isFirstTimePatient } from "../src/services/availability";
import {
  analyzeRows, applyImport, interpretTable, parseCsv, parseVisitDate, rollbackImport,
} from "../src/services/patient-import";
import { purgeAuditForClinics } from "./helpers/audit";

/**
 * Importación inicial de pacientes (2026-11-20). Lo que importa: no inventar datos, no pisar a
 * nadie, que quien ya venía NO sea de "primera vez", que se pueda deshacer, y que la auditoría
 * no guarde nombres ni teléfonos.
 */

const clinicIds: string[] = [];
async function crearClinica(): Promise<string> {
  const c = await prisma.clinic.create({
    data: {
      name: `Clínica import ${Date.now()}-${Math.random()}`,
      whatsappPhoneNumberId: `imp-${Date.now()}-${Math.random()}`,
      whatsappTokenEncrypted: encryptToken("test"),
      email: "imp@example.com",
      timezone: "UTC",
      services: "Consulta",
    },
  });
  clinicIds.push(c.id);
  return c.id;
}
afterEach(async () => {
  await purgeAuditForClinics(clinicIds);
  for (const clinicId of clinicIds) {
    await prisma.patientComment.deleteMany({ where: { clinicId } });
    await prisma.appointment.deleteMany({ where: { clinicId } });
    await prisma.patient.deleteMany({ where: { clinicId } });
    await prisma.clinic.delete({ where: { id: clinicId } });
  }
  clinicIds.length = 0;
});

const NOW = new Date("2026-11-20T12:00:00Z");

describe("leer el archivo", () => {
  it("entiende títulos distintos, con acentos y mayúsculas, y detecta las columnas", () => {
    const t = interpretTable([
      ["Pacientes de la clínica", "", ""],
      ["PACIENTE", "Teléfono Celular", "Fecha última visita"],
      ["Ana Pérez", "55 1234 5678", "14/03/2025"],
    ]);
    expect(t.errors).toEqual([]);
    expect(t.detected).toEqual({ nombre: "PACIENTE", apellido: null, telefono: "Teléfono Celular", ultimaVisita: "Fecha última visita" });
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toMatchObject({ name: "Ana Pérez", rowNumber: 3 });
  });

  it("si hay columnas Nombre y Apellido separadas, las guarda separadas", () => {
    const t = interpretTable([["Nombre", "Apellido", "Celular"], ["Ana María", "García", "5215512345678"]]);
    expect(t.rows[0]).toMatchObject({ name: "Ana María García", firstName: "Ana María", lastName: "García" });
  });

  it("sin columna de teléfono avisa en vez de cargar a medias", () => {
    const t = interpretTable([["Nombre", "Edad"], ["Ana", "30"]]);
    expect(t.rows).toEqual([]);
    expect(t.errors.join(" ")).toMatch(/teléfono/);
  });

  it("un archivo vacío se rechaza", () => {
    expect(interpretTable([]).errors).toHaveLength(1);
  });

  it("parsea un CSV con punto y coma, comillas, BOM y filas en blanco sin desfasar los números de fila", () => {
    const csv = '﻿Nombre;Teléfono;Última visita\r\n"Pérez; Ana";5215512345678;2025-03-14\r\n\r\nLuis Gómez;5215598765432;\r\n';
    const t = interpretTable(parseCsv(csv));
    expect(t.rows.map((r) => [r.rowNumber, r.name])).toEqual([[2, "Pérez; Ana"], [4, "Luis Gómez"]]);
  });
});

describe("fechas", () => {
  it("día/mes por defecto, mes/día si se pide, ISO siempre", () => {
    expect(parseVisitDate("14/03/2025")).toBe("2025-03-14");
    expect(parseVisitDate("03/14/2025", "mdy")).toBe("2025-03-14");
    expect(parseVisitDate("2025-03-14")).toBe("2025-03-14");
    expect(parseVisitDate("14/03/25")).toBe("2025-03-14");
  });
  it("rechaza días imposibles y basura en vez de correrlos al mes siguiente", () => {
    expect(parseVisitDate("31/02/2025")).toBeNull();
    expect(parseVisitDate("2025-13-01")).toBeNull();
    expect(parseVisitDate("ayer")).toBeNull();
    expect(parseVisitDate("")).toBeNull();
  });
});

describe("analizar (simulación)", () => {
  const row = (n: number, name: string, phone: string, lastVisit = "") => ({ rowNumber: n, name, firstName: "", lastName: "", phone, lastVisit });

  it("no escribe nada en la base", async () => {
    const clinicId = await crearClinica();
    await analyzeRows(clinicId, [row(2, "Ana Pérez", "5215512345678")], { now: NOW });
    expect(await prisma.patient.count({ where: { clinicId } })).toBe(0);
  });

  it("omite lo inválido y lo repetido, y avisa lo dudoso sin adivinar", async () => {
    const clinicId = await crearClinica();
    const a = await analyzeRows(clinicId, [
      row(2, "Ana Pérez", "5215512345678", "14/03/2025"),
      row(3, "", "5215512345678"),
      row(4, "Luis Gómez", "123"),
      row(5, "ana  PÉREZ", "+52 1 55 1234 5678"), // la misma persona, escrita distinto
      row(6, "Hijo Pérez", "5215512345678"), // otra persona en el mismo número: válida
      row(7, "Sofía Ruiz", "5512345678", "31/02/2025"), // sin código de país y fecha imposible
      row(8, "Mario Díaz", "5215511112222", "2030-01-01"), // fecha futura
    ], { now: NOW });
    expect(a.valid.map((r) => r.rowNumber)).toEqual([2, 6, 7, 8]);
    expect(a.skipped).toEqual([
      { rowNumber: 3, reason: "sin_nombre" },
      { rowNumber: 4, reason: "telefono_invalido" },
      { rowNumber: 5, reason: "duplicado_en_archivo" },
    ]);
    const w = (n: number) => a.warnings.filter((x) => x.rowNumber === n).map((x) => x.warning).sort();
    expect(w(7)).toEqual(["fecha_descartada", "sin_codigo_de_pais"]);
    expect(w(8)).toEqual(["fecha_futura"]);
    expect(a.valid.find((r) => r.rowNumber === 7)!.phone).toBe("5512345678"); // no se inventó el código
    expect(a.valid.find((r) => r.rowNumber === 7)!.priorLastVisitOn).toBeNull();
    expect(a.valid.find((r) => r.rowNumber === 8)!.priorLastVisitOn).toBeNull();
    expect(a.valid.find((r) => r.rowNumber === 2)!.priorLastVisitOn).toBe("2025-03-14");
  });

  it("completa el código de país solo si se pidió", async () => {
    const clinicId = await crearClinica();
    const a = await analyzeRows(clinicId, [row(2, "Sofía Ruiz", "5512345678")], { defaultCountryCode: "+52", now: NOW });
    expect(a.valid[0].phone).toBe("525512345678");
    expect(a.warnings).toEqual([]);
  });

  it("no pisa a quien ya existe en la clínica, y no mira otras clínicas", async () => {
    const clinicId = await crearClinica();
    const otra = await crearClinica();
    await prisma.patient.create({ data: { clinicId, phone: "5215512345678", name: "Ana Pérez" } });
    await prisma.patient.create({ data: { clinicId: otra, phone: "5215598760000", name: "Luis Gómez" } });
    const a = await analyzeRows(clinicId, [row(2, "Ana Pérez", "5215512345678"), row(3, "Luis Gómez", "5215598760000")], { now: NOW });
    expect(a.skipped).toEqual([{ rowNumber: 2, reason: "ya_existe" }]);
    expect(a.valid.map((r) => r.rowNumber)).toEqual([3]);
  });
});

describe("cargar y deshacer", () => {
  const rows = [
    { rowNumber: 2, name: "Ana Pérez", firstName: "", lastName: "", phone: "5215512345678", lastVisit: "2025-03-14" },
    { rowNumber: 3, name: "Luis Gómez", firstName: "", lastName: "", phone: "5215598765432", lastVisit: "" },
  ];

  it("carga el lote, marca a todos como con historia previa y deja auditoría SIN nombres ni teléfonos", async () => {
    const clinicId = await crearClinica();
    const analysis = await analyzeRows(clinicId, rows, { now: NOW });
    const r = await applyImport(clinicId, analysis, { columnas: ["Paciente", "Celular"] });
    expect(r.created).toBe(2);
    const ps = await prisma.patient.findMany({ where: { clinicId }, orderBy: { name: "asc" } });
    expect(ps.every((p) => p.priorHistory && p.importBatchId === r.batchId && p.stage === "nuevo_contacto")).toBe(true);
    expect(ps[0].priorLastVisitOn?.toISOString().slice(0, 10)).toBe("2025-03-14");

    const audit = await prisma.auditLog.findMany({ where: { clinicId, action: "patient.import" } });
    expect(audit).toHaveLength(1);
    expect(audit[0].origin).toBe("sistema");
    const texto = JSON.stringify(audit[0]);
    for (const secreto of ["Ana", "Pérez", "Luis", "5215512345678", "5215598765432"]) expect(texto).not.toContain(secreto);
    expect(texto).toContain(r.batchId);
  });

  it("quien ya venía no es de primera vez aunque no tenga citas; uno nuevo sí", async () => {
    const clinicId = await crearClinica();
    const r = await applyImport(clinicId, await analyzeRows(clinicId, rows, { now: NOW }), { columnas: [] });
    expect(r.created).toBe(2);
    const importado = (await prisma.patient.findFirst({ where: { clinicId, name: "Ana Pérez" } }))!;
    const nuevo = await prisma.patient.create({ data: { clinicId, phone: "5215500000001", name: "Nuevo Paciente" } });
    expect(await isFirstTimePatient(clinicId, importado.id)).toBe(false);
    expect(await isFirstTimePatient(clinicId, nuevo.id)).toBe(true);
  });

  it("deshacer borra solo el lote y conserva a quien ya tiene actividad", async () => {
    const clinicId = await crearClinica();
    const r = await applyImport(clinicId, await analyzeRows(clinicId, rows, { now: NOW }), { columnas: [] });
    const propio = await prisma.patient.create({ data: { clinicId, phone: "5215500000002", name: "Propio Paciente" } });
    const conActividad = (await prisma.patient.findFirst({ where: { clinicId, name: "Ana Pérez" } }))!;
    await prisma.patientComment.create({ data: { clinicId, patientId: conActividad.id, authorName: "t", text: "nota" } });

    const rb = await rollbackImport(clinicId, r.batchId);
    expect(rb).toEqual({ deleted: 1, kept: 1 });
    const quedan = (await prisma.patient.findMany({ where: { clinicId }, select: { name: true } })).map((p) => p.name).sort();
    expect(quedan).toEqual(["Ana Pérez", "Propio Paciente"]);
    expect(propio.id).toBeTruthy();
  });

  it("el lote de una clínica no se puede deshacer desde otra", async () => {
    const a = await crearClinica();
    const b = await crearClinica();
    const r = await applyImport(a, await analyzeRows(a, rows, { now: NOW }), { columnas: [] });
    expect(await rollbackImport(b, r.batchId)).toEqual({ deleted: 0, kept: 0 });
    expect(await prisma.patient.count({ where: { clinicId: a } })).toBe(2);
  });
});
