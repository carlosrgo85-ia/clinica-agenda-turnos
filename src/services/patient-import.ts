import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../db/client";
import { normalizeWhatsAppNumber } from "./phone";
import { joinFullName, MAX_NAME_PART } from "./patient-admin";
import { recordSystemAudit } from "./audit";

/**
 * Importación inicial de los pacientes que una clínica ya tenía (un Excel o CSV con
 * nombre, teléfono y fecha de la última visita). Genérica: sirve para cualquier clínica.
 *
 * Decisiones (2026-11-20):
 * - **Solo pacientes, no citas pasadas.** Una cita histórica exige profesional, espacio y servicio
 *   válidos y ensuciaría los reportes y la ocupación. Quien ya venía se marca con
 *   `Patient.priorHistory`: no es de "primera vez" aunque no tenga citas acá.
 * - **Dos pasos**: `analyzeRows()` no escribe nada (simulación) y `applyImport()` carga.
 * - **No pisa a nadie**: el que ya existe (mismo WhatsApp y mismo nombre) se omite, no se actualiza.
 *   Varias personas en un mismo número son válidas (una familia).
 * - **No adivina**: un teléfono sin código de país se avisa (o se completa SOLO si se pidió un
 *   código por defecto); una fecha rara se descarta con aviso y la fila se carga igual.
 * - **Se puede deshacer**: cada carga lleva un `importBatchId` y `rollbackImport()` borra
 *   exactamente ese lote, salvo a quien ya tenga actividad.
 * - **Rastro**: una entrada de auditoría por lote (origen `sistema`) con CANTIDADES y nombres de
 *   columnas, nunca nombres ni teléfonos.
 * - **No avisa a nadie**: importar no dispara ningún mensaje ni cambia la etapa del CRM.
 */

export const MAX_IMPORT_ROWS = 20000;

export interface RawRow {
  /** Número de fila en el archivo original (con la fila de títulos arriba). */
  rowNumber: number;
  name: string;
  firstName: string;
  lastName: string;
  phone: string;
  lastVisit: string;
}

export interface Detected {
  nombre: string | null;
  apellido: string | null;
  telefono: string | null;
  ultimaVisita: string | null;
}

export interface ParsedFile {
  rows: RawRow[];
  /** Qué columna del archivo se entendió como cada dato (para mostrarlo al revisar). */
  detected: Detected;
  /** Lo que impide seguir (falta una columna obligatoria, archivo vacío…). */
  errors: string[];
}

const NOTHING: Detected = { nombre: null, apellido: null, telefono: null, ultimaVisita: null };

// --- Leer el archivo ---

const norm = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const HEADERS = {
  nombre: ["nombre", "nombres", "name", "paciente", "nombre y apellido", "nombre completo", "apellido y nombre", "cliente"],
  apellido: ["apellido", "apellidos", "lastname", "last name", "surname"],
  telefono: ["telefono", "tel", "celular", "movil", "whatsapp", "phone", "numero", "nro", "cel", "telefono celular", "telefono movil"],
  ultimaVisita: [
    "ultima visita", "fecha ultima visita", "ultima cita", "fecha de ultima visita", "ultima atencion",
    "last visit", "fecha ultima cita", "ultima consulta", "ultimo turno",
  ],
};

function findColumn(headers: string[], names: string[]): number {
  const n = headers.map((h) => norm(h ?? ""));
  const exact = n.findIndex((h) => names.includes(h));
  if (exact >= 0) return exact;
  return n.findIndex((h) => h && names.some((x) => h.includes(x) && x.length >= 5));
}

/** Una celda de Excel a texto: las fechas pasan a YYYY-MM-DD, el resto a texto sin espacios de más. */
function cellToText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as { text?: unknown; result?: unknown; richText?: Array<{ text: string }> };
    if (o.richText) return o.richText.map((t) => t.text).join("").trim();
    if (o.text !== undefined) return String(o.text).trim();
    if (o.result !== undefined) return cellToText(o.result);
    return "";
  }
  return String(v).trim();
}

/** CSV con comillas, coma o punto y coma, y BOM (lo que guarda Excel en español). Conserva las filas vacías para no desfasar los números de fila. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

/** Del contenido ya leído (filas de celdas) a filas entendidas. Separado para poder probarlo sin archivos. */
export function interpretTable(table: string[][]): ParsedFile {
  if (!table.some((r) => r.some((c) => (c ?? "").trim() !== ""))) return { rows: [], detected: { ...NOTHING }, errors: ["El archivo está vacío."] };

  // La fila de títulos es la primera que tiene una columna de teléfono y una de nombre (a veces hay un título arriba).
  let headerIdx = table.findIndex(
    (r) => findColumn(r, HEADERS.telefono) >= 0 && (findColumn(r, HEADERS.nombre) >= 0 || findColumn(r, HEADERS.apellido) >= 0)
  );
  if (headerIdx < 0) headerIdx = table.findIndex((r) => r.some((c) => (c ?? "").trim() !== ""));
  const headers = table[headerIdx];
  const cName = findColumn(headers, HEADERS.nombre);
  const cLast = findColumn(headers, HEADERS.apellido);
  const cPhone = findColumn(headers, HEADERS.telefono);
  const cVisit = findColumn(headers, HEADERS.ultimaVisita);

  const errors: string[] = [];
  if (cPhone < 0) errors.push("No encontré la columna del teléfono (por ejemplo: «Teléfono», «Celular» o «WhatsApp»).");
  if (cName < 0 && cLast < 0) errors.push("No encontré la columna del nombre (por ejemplo: «Nombre» o «Paciente»).");
  if (errors.length) return { rows: [], detected: { ...NOTHING }, errors };

  // Si «Nombre» y «Apellido» son columnas distintas, se guardan separadas; si no, es el nombre completo.
  const separadas = cName >= 0 && cLast >= 0 && cName !== cLast;
  const detected: Detected = {
    nombre: headers[cName >= 0 ? cName : cLast],
    apellido: separadas ? headers[cLast] : null,
    telefono: headers[cPhone],
    ultimaVisita: cVisit >= 0 ? headers[cVisit] : null,
  };

  const rows: RawRow[] = [];
  for (let i = headerIdx + 1; i < table.length; i++) {
    const r = table[i] ?? [];
    const get = (c: number) => (c >= 0 ? (r[c] ?? "").trim() : "");
    const firstName = separadas ? get(cName) : "";
    const lastName = separadas ? get(cLast) : "";
    const name = separadas ? joinFullName(firstName, lastName) : get(cName >= 0 ? cName : cLast).replace(/\s+/g, " ");
    if (!name && !get(cPhone)) continue; // fila vacía
    rows.push({ rowNumber: i + 1, name, firstName, lastName, phone: get(cPhone), lastVisit: get(cVisit) });
  }
  return { rows, detected, errors: [] };
}

/** Lee un .csv o .xlsx del disco. */
export async function readImportFile(filePath: string): Promise<ParsedFile> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".csv" || ext === ".txt") return interpretTable(parseCsv(await readFile(filePath, "utf8")));
  if (ext === ".xlsx") {
    // Según cómo se cargue el módulo (tsx o el build de tsc), `Workbook` está en el módulo o en `default`.
    const mod = (await import("exceljs")) as unknown as { Workbook?: new () => import("exceljs").Workbook; default?: { Workbook: new () => import("exceljs").Workbook } };
    const Workbook = mod.Workbook ?? mod.default!.Workbook;
    const wb = new Workbook();
    await wb.xlsx.readFile(filePath);
    const sheet = wb.worksheets[0];
    if (!sheet) return { rows: [], detected: { ...NOTHING }, errors: ["El Excel no tiene hojas."] };
    const table: string[][] = [];
    sheet.eachRow({ includeEmpty: true }, (row) => {
      const cells: string[] = [];
      for (let c = 1; c <= row.cellCount; c++) cells.push(cellToText(row.getCell(c).value));
      table[row.number - 1] = cells;
    });
    return interpretTable(Array.from(table, (r) => r ?? []));
  }
  return { rows: [], detected: { ...NOTHING }, errors: [`Formato no soportado (${ext || "sin extensión"}). Usa .xlsx o .csv.`] };
}

// --- Validar ---

export type DateOrder = "dmy" | "mdy";

/** "2025-03-14", "14/03/2025" (o "03/14/2025" con `mdy`) a YYYY-MM-DD; null si no es una fecha real. */
export function parseVisitDate(raw: string, order: DateOrder = "dmy"): string | null {
  const t = raw.trim();
  if (!t) return null;
  let y: number, m: number, d: number;
  let match = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (match) {
    y = +match[1]; m = +match[2]; d = +match[3];
  } else if ((match = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) {
    const a = +match[1], b = +match[2];
    y = +match[3];
    if (y < 100) y += 2000;
    [d, m] = order === "dmy" ? [a, b] : [b, a];
  } else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

export interface ImportOptions {
  /** Código de país a anteponer a números nacionales (≤ 10 dígitos). Sin esto no se adivina nada. */
  defaultCountryCode?: string;
  dateOrder?: DateOrder;
  /** "Hoy" para rechazar visitas en el futuro (inyectable para pruebas). */
  now?: Date;
}

export type SkipReason = "sin_nombre" | "telefono_invalido" | "duplicado_en_archivo" | "ya_existe";
export type WarningKind = "sin_codigo_de_pais" | "fecha_descartada" | "fecha_futura" | "nombre_sin_apellido";

export interface ValidRow {
  rowNumber: number;
  name: string;
  firstName: string | null;
  lastName: string | null;
  phone: string;
  priorLastVisitOn: string | null;
}

export interface Analysis {
  valid: ValidRow[];
  skipped: Array<{ rowNumber: number; reason: SkipReason }>;
  warnings: Array<{ rowNumber: number; warning: WarningKind }>;
  totals: { leidas: number; aCargar: number; omitidas: number; avisos: number };
}

const keyOf = (phone: string, name: string) => `${phone}|${norm(name)}`;

/** Simulación: no escribe nada. Decide qué se cargaría, qué se omite y qué merece revisión. */
export async function analyzeRows(clinicId: string, rows: RawRow[], opts: ImportOptions = {}): Promise<Analysis> {
  const now = opts.now ?? new Date();
  const hoy = now.toISOString().slice(0, 10);
  const existing = await prisma.patient.findMany({ where: { clinicId }, select: { phone: true, name: true } });
  const yaExisten = new Set(existing.map((p) => keyOf(p.phone, p.name ?? "")));

  const valid: ValidRow[] = [];
  const skipped: Analysis["skipped"] = [];
  const warnings: Analysis["warnings"] = [];
  const vistos = new Set<string>();

  for (const r of rows) {
    if (!r.name || r.name.length < 2 || r.firstName.length > MAX_NAME_PART || r.lastName.length > MAX_NAME_PART || r.name.length > 2 * MAX_NAME_PART + 1) {
      skipped.push({ rowNumber: r.rowNumber, reason: "sin_nombre" });
      continue;
    }
    let phone = normalizeWhatsAppNumber(r.phone);
    if (!phone) { skipped.push({ rowNumber: r.rowNumber, reason: "telefono_invalido" }); continue; }
    if (phone.length <= 10) {
      if (opts.defaultCountryCode) phone = opts.defaultCountryCode.replace(/\D/g, "") + phone;
      else warnings.push({ rowNumber: r.rowNumber, warning: "sin_codigo_de_pais" });
    }

    const k = keyOf(phone, r.name);
    if (vistos.has(k)) { skipped.push({ rowNumber: r.rowNumber, reason: "duplicado_en_archivo" }); continue; }
    vistos.add(k);
    if (yaExisten.has(k)) { skipped.push({ rowNumber: r.rowNumber, reason: "ya_existe" }); continue; }

    let visit: string | null = null;
    if (r.lastVisit) {
      visit = parseVisitDate(r.lastVisit, opts.dateOrder);
      if (!visit) warnings.push({ rowNumber: r.rowNumber, warning: "fecha_descartada" });
      else if (visit > hoy) { warnings.push({ rowNumber: r.rowNumber, warning: "fecha_futura" }); visit = null; }
    }
    if (!r.firstName && !r.lastName && r.name.trim().split(/\s+/).length < 2) {
      warnings.push({ rowNumber: r.rowNumber, warning: "nombre_sin_apellido" });
    }

    valid.push({
      rowNumber: r.rowNumber,
      name: r.name,
      firstName: r.firstName || null,
      lastName: r.lastName || null,
      phone,
      priorLastVisitOn: visit,
    });
  }
  return {
    valid, skipped, warnings,
    totals: { leidas: rows.length, aCargar: valid.length, omitidas: skipped.length, avisos: warnings.length },
  };
}

// --- Cargar y deshacer ---

export interface ApplyResult { batchId: string; created: number }

/** Carga las filas válidas en UNA transacción: o entra todo el lote o no entra nada. */
export async function applyImport(
  clinicId: string,
  analysis: Analysis,
  meta: { columnas: string[] }
): Promise<ApplyResult> {
  if (analysis.valid.length > MAX_IMPORT_ROWS) throw new Error(`Demasiadas filas (máximo ${MAX_IMPORT_ROWS}).`);
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { id: true } });
  if (!clinic) throw new Error("La clínica no existe.");

  const batchId = `imp_${randomUUID()}`;
  const created = await prisma.$transaction(async (tx) => {
    const { count } = await tx.patient.createMany({
      data: analysis.valid.map((r) => ({
        clinicId,
        phone: r.phone,
        name: r.name,
        firstName: r.firstName,
        lastName: r.lastName,
        priorHistory: true,
        priorLastVisitOn: r.priorLastVisitOn ? new Date(`${r.priorLastVisitOn}T00:00:00.000Z`) : null,
        importBatchId: batchId,
      })),
    });
    return count;
  });

  await recordSystemAudit({
    origin: "sistema",
    clinicId,
    action: "patient.import",
    resourceType: "clinic",
    resourceId: clinicId,
    // Solo cantidades y nombres de columnas: nunca nombres ni teléfonos de pacientes.
    details: {
      lote: batchId,
      leidas: analysis.totals.leidas,
      creados: created,
      omitidas: analysis.totals.omitidas,
      avisos: analysis.totals.avisos,
      columnas: meta.columnas,
    },
  });
  return { batchId, created };
}

export interface RollbackResult { deleted: number; kept: number }

/**
 * Borra los pacientes de UN lote de importación. Conserva (y cuenta) a quien ya tiene
 * actividad en la plataforma —citas, paquetes, comentarios o derivaciones—: deshacer la
 * carga no puede llevarse la historia que se generó después.
 */
export async function rollbackImport(clinicId: string, batchId: string): Promise<RollbackResult> {
  const withActivity = {
    OR: [{ appointments: { some: {} } }, { packages: { some: {} } }, { comments: { some: {} } }, { escalations: { some: {} } }],
  };
  const where = { clinicId, importBatchId: batchId };
  const kept = await prisma.patient.count({ where: { ...where, ...withActivity } });
  const { count } = await prisma.patient.deleteMany({ where: { ...where, NOT: withActivity } });
  await recordSystemAudit({
    origin: "sistema",
    clinicId,
    action: "patient.import_rollback",
    resourceType: "clinic",
    resourceId: clinicId,
    details: { lote: batchId, borrados: count, conservados: kept },
  });
  return { deleted: count, kept };
}
