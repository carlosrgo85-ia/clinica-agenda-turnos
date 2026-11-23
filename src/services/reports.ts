import type { Prisma } from "@prisma/client";
import { prisma } from "../db/client";
import { toCsv, type CsvCell } from "./csv";
import { parseDateKey } from "./patient-admin";
import { campaignStats, campaignStatus } from "./campaigns";
import { getEffectiveIntervalsForRange, intersectIntervals, intervalsKey } from "./working-hours";
import {
  addDaysToDateKey,
  clinicDateKey,
  clinicMinutesFromMidnight,
  clinicWallTimeToUtc,
  clinicWeekday,
  formatWallTime,
  weekdayFromDateKey,
} from "./time";

/**
 * Reportes de la clínica: citas canceladas, reagendadas, atendidas por profesional y
 * sin confirmar, más un resumen del período.
 *
 * Todos devuelven la MISMA estructura (`ReportResult`: indicadores, tablas de resumen y un
 * detalle), así la pantalla y la exportación sirven para cualquiera, y agregar un reporte
 * nuevo es escribir su consulta.
 *
 * **Fuentes, y por qué cada reporte usa la suya:**
 * - Las **cancelaciones** y las **atendidas** salen de la propia cita (`Appointment`):
 *   funciona con lo histórico, porque una cita cancelada antes de que existieran los
 *   eventos igual está cancelada. Las anteriores al 2026-11-13 no tienen fecha de
 *   cancelación ni quién la hizo, y se cuentan como "sin dato".
 * - Las **reagendadas** salen de los eventos (`AppointmentEvent`): es el único lugar donde
 *   queda la hora original, porque mover una cita pisa la fila. Solo hay desde el
 *   2026-11-13 (`desdeDatos`).
 *
 * **Definiciones que el reporte da por buenas:**
 * - Una cancelación **real** no incluye las que se dieron de baja porque el paciente movió la
 *   cita a otra hora (`cancelledByKind: "reprogramacion"`): esa cita no se perdió.
 * - "Atendida confirmada" es la que una PERSONA marcó (`attendedAt`); "automática" es la que
 *   el sistema dio por atendida a las 24 horas, que no prueba que el paciente fue.
 * - "Sin confirmar" es una cita ya pasada que nadie marcó ni canceló.
 *
 * Los períodos y el día de la semana son los de la **zona de la clínica**, no los del
 * servidor: "el lunes 17" son las 24 horas del 17 en hora local.
 */

export type ReportKind = "resumen" | "ocupacion" | "pacientes" | "servicios" | "origen" | "campanas" | "derivaciones" | "motivos" | "cancelaciones" | "reagendadas" | "atendidos" | "sin-confirmar";
export const REPORT_KINDS: ReportKind[] = ["resumen", "ocupacion", "pacientes", "servicios", "origen", "campanas", "derivaciones", "motivos", "cancelaciones", "reagendadas", "atendidos", "sin-confirmar"];

/** `evento`: cuándo pasó (se canceló, se reagendó). `cita`: de qué día era la cita. */
export type ReportBase = "evento" | "cita";

export interface ReportFilters {
  /** YYYY-MM-DD, el día local de la clínica, inclusive. */
  fromKey: string;
  toKey: string;
  from: Date;
  /** Exclusivo: la medianoche local del día siguiente a `toKey`. */
  toExclusive: Date;
  base: ReportBase;
  professionalId?: string;
  serviceId?: string;
}

export const MAX_RANGE_DAYS = 366;
export const DEFAULT_RANGE_DAYS = 30;
const MAX_DETAIL_ROWS_JSON = 500;
const MAX_DETAIL_ROWS_CSV = 10_000;

type Cell = string | number | null;

export interface ReportKpi {
  clave: string;
  etiqueta: string;
  valor: number | null;
  formato: "numero" | "porcentaje";
  /** Qué cuenta exactamente: las definiciones importan en un reporte. */
  ayuda?: string;
}

export interface ReportTable {
  clave: string;
  titulo: string;
  columnas: string[];
  filas: Cell[][];
  /** Cómo dibujarla: por defecto una tabla; "barras" si es una etiqueta y un conteo (2 columnas, la 2ª numérica). */
  visual?: "barras" | "calor";
  /** Unidad del valor de una tabla en barras ("%"): con ella la escala va de 0 a 100. */
  unidad?: "%";
}

export interface ReportResult {
  informe: ReportKind;
  titulo: string;
  periodo: { desde: string; hasta: string; base: ReportBase };
  /** Desde cuándo hay eventos de cita (YYYY-MM-DD en la zona de la clínica), o null si no hay. */
  desdeDatos: string | null;
  kpis: ReportKpi[];
  tablas: ReportTable[];
  detalle: { titulo: string; columnas: string[]; filas: Cell[][]; total: number; truncado: boolean };
  notas: string[];
}

// --- Filtros ---

export function parseReportFilters(
  query: Record<string, unknown>,
  clinic: { timezone: string },
  now: Date = new Date()
): { ok: true; filters: ReportFilters } | { ok: false; error: string } {
  const hoy = clinicDateKey(now, clinic.timezone);
  const toKey = typeof query.hasta === "string" && query.hasta ? query.hasta : hoy;
  const fromKey =
    typeof query.desde === "string" && query.desde ? query.desde : (addDaysToDateKey(toKey, -(DEFAULT_RANGE_DAYS - 1)) ?? hoy);

  // Estrictas: `2030-02-31` no se corre en silencio al mes siguiente.
  if (!parseDateKey(fromKey) || !parseDateKey(toKey)) {
    return { ok: false, error: "Las fechas tienen que ser reales y con el formato AAAA-MM-DD." };
  }
  if (fromKey > toKey) return { ok: false, error: "La fecha 'desde' no puede ser posterior a 'hasta'." };

  const diasDelRango = Math.round((parseDateKey(toKey)!.getTime() - parseDateKey(fromKey)!.getTime()) / 86_400_000) + 1;
  if (diasDelRango > MAX_RANGE_DAYS) {
    return { ok: false, error: `El período no puede superar ${MAX_RANGE_DAYS} días.` };
  }

  const siguiente = addDaysToDateKey(toKey, 1);
  const from = clinicWallTimeToUtc(fromKey, "00:00", clinic.timezone);
  const toExclusive = siguiente ? clinicWallTimeToUtc(siguiente, "00:00", clinic.timezone) : null;
  if (!from || !toExclusive) return { ok: false, error: "No se pudo interpretar el período en la zona de la clínica." };

  const base: ReportBase = query.base === "cita" ? "cita" : "evento";
  const texto = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

  return {
    ok: true,
    filters: {
      fromKey,
      toKey,
      from,
      toExclusive,
      base,
      professionalId: texto(query.professionalId),
      serviceId: texto(query.serviceId),
    },
  };
}

// --- Piezas comunes ---

const DIAS_ES: Record<string, string> = {
  lunes: "Lunes", martes: "Martes", miercoles: "Miércoles", jueves: "Jueves", viernes: "Viernes", sabado: "Sábado", domingo: "Domingo",
};
const ORDEN_DIAS = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"];

function cuando(instante: Date | null, timezone: string): string | null {
  return instante ? `${clinicDateKey(instante, timezone)} ${formatWallTime(instante, timezone)}` : null;
}

/** Cuenta por una clave y devuelve [clave, cantidad] ordenado de más a menos. */
function contar<T>(items: T[], clave: (i: T) => string): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const i of items) m.set(clave(i), (m.get(clave(i)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const porcentaje = (parte: number, total: number): number | null => (total === 0 ? null : Math.round((parte / total) * 1000) / 10);

/**
 * Las citas que NO se perdieron sino que se movieron: no cuentan como citas del período.
 *
 * **Escrito con `OR` y un `null` explícito, no con `NOT`**: en SQL, `NOT (status = 'cancelado'
 * AND cancelledByKind = 'reprogramacion')` con `cancelledByKind` nulo da NULL —no verdadero—
 * y la fila se descarta. Con un `NOT` esto hacía desaparecer del resumen justo las
 * cancelaciones anteriores al registro, que tienen `cancelledByKind` nulo.
 */
const NO_ES_REPROGRAMACION: Prisma.AppointmentWhereInput = {
  OR: [{ status: { not: "cancelado" } }, { cancelledByKind: null }, { cancelledByKind: { not: "reprogramacion" } }],
};

function scope(f: ReportFilters): Prisma.AppointmentWhereInput {
  return {
    ...(f.professionalId ? { professionalId: f.professionalId } : {}),
    ...(f.serviceId ? { serviceId: f.serviceId } : {}),
  };
}

async function desdeDatos(clinicId: string, timezone: string): Promise<string | null> {
  const primero = await prisma.appointmentEvent.aggregate({ where: { clinicId }, _min: { occurredAt: true } });
  return primero._min.occurredAt ? clinicDateKey(primero._min.occurredAt, timezone) : null;
}

function armarDetalle(titulo: string, columnas: string[], filas: Cell[][]): ReportResult["detalle"] {
  return {
    titulo,
    columnas,
    filas: filas.slice(0, MAX_DETAIL_ROWS_CSV),
    total: filas.length,
    truncado: filas.length > MAX_DETAIL_ROWS_CSV,
  };
}

// --- Los reportes ---

interface Contexto {
  clinic: { id: string; timezone: string };
  filters: ReportFilters;
  now: Date;
}

/**
 * El resultado de las citas del período (por la fecha de la cita): cuántas hubo, cuántas se
 * atendieron, cuántas se cancelaron y por quién, cuántas están sin confirmar. Funciona con
 * lo histórico porque sale de la propia cita.
 */
const ETAPAS = ["nuevo_contacto", "interesado", "turno_agendado", "turno_confirmado", "atendido", "cancelado"] as const;
const ETAPA_LABELS: Record<(typeof ETAPAS)[number], string> = {
  nuevo_contacto: "Nuevo contacto",
  interesado: "Interesado",
  turno_agendado: "Cita agendada",
  turno_confirmado: "Cita confirmada",
  atendido: "Cita cumplida (automático)",
  cancelado: "Cancelado",
};

async function resumen(ctx: Contexto): Promise<ReportResult> {
  const { clinic, filters: f, now } = ctx;
  const citas = await prisma.appointment.findMany({
    where: { clinicId: clinic.id, startTime: { gte: f.from, lt: f.toExclusive }, ...scope(f), ...NO_ES_REPROGRAMACION },
    select: { status: true, attendedAt: true, cancelledByKind: true, startTime: true },
  });

  const futuras = citas.filter((c) => c.status === "confirmado" && c.startTime > now).length;
  const confirmadas = citas.filter((c) => c.status === "atendido" && c.attendedAt).length;
  const automaticas = citas.filter((c) => c.status === "atendido" && !c.attendedAt).length;
  const sinConfirmar = citas.filter((c) => c.status === "confirmado" && c.startTime <= now).length;
  const canceladas = citas.filter((c) => c.status === "cancelado");
  const porPaciente = canceladas.filter((c) => c.cancelledByKind === "paciente").length;
  const porClinica = canceladas.filter((c) => c.cancelledByKind === "clinica").length;
  const total = citas.length;
  const yaOcurridas = total - futuras;

  // Reagendadas: de los eventos, las de citas que caen en el período.
  const reagendadas = await prisma.appointmentEvent.count({
    where: {
      clinicId: clinic.id,
      type: "reagendada",
      appointment: { startTime: { gte: f.from, lt: f.toExclusive }, ...scope(f) },
    },
  });

  // Foto de HOY de dónde está cada paciente en el CRM (lo que mostraba la pantalla de Métricas).
  // No depende del período ni de los filtros: una etapa es el estado actual de la persona.
  const porEtapa = await prisma.patient.groupBy({ by: ["stage"], where: { clinicId: clinic.id }, _count: true });

  return {
    informe: "resumen",
    titulo: "Resumen del período",
    periodo: { desde: f.fromKey, hasta: f.toKey, base: "cita" },
    desdeDatos: await desdeDatos(clinic.id, clinic.timezone),
    kpis: [
      { clave: "citas", etiqueta: "Citas del período", valor: total, formato: "numero", ayuda: "Las citas cuyo día cae en el período. No incluye las que se dieron de baja porque el paciente las movió a otra hora." },
      { clave: "atendidas", etiqueta: "Atendidas", valor: confirmadas + automaticas, formato: "numero" },
      { clave: "atendidas_confirmadas", etiqueta: "Atendidas confirmadas", valor: confirmadas, formato: "numero", ayuda: "Una persona de la clínica marcó que el paciente vino." },
      { clave: "atendidas_automaticas", etiqueta: "Atendidas automáticas", valor: automaticas, formato: "numero", ayuda: "El sistema las dio por atendidas a las 24 horas sin que nadie las confirmara: no prueba que el paciente fue." },
      { clave: "canceladas", etiqueta: "Canceladas", valor: canceladas.length, formato: "numero" },
      { clave: "sin_confirmar", etiqueta: "Sin confirmar", valor: sinConfirmar, formato: "numero", ayuda: "Citas ya pasadas que nadie marcó como atendidas ni canceló." },
      { clave: "futuras", etiqueta: "Todavía por venir", valor: futuras, formato: "numero" },
      { clave: "reagendadas", etiqueta: "Reagendadas", valor: reagendadas, formato: "numero", ayuda: "Citas del período que se movieron de hora o de profesional. Solo cuenta desde que se registran los eventos." },
      { clave: "tasa_cancelacion", etiqueta: "Tasa de cancelación", valor: porcentaje(canceladas.length, total), formato: "porcentaje", ayuda: "Canceladas sobre todas las citas del período." },
      { clave: "tasa_atencion", etiqueta: "Tasa de atención", valor: porcentaje(confirmadas + automaticas, yaOcurridas), formato: "porcentaje", ayuda: "Atendidas sobre las citas que ya pasaron (no cuenta las que todavía no llegaron)." },
    ],
    tablas: [
      {
        clave: "canceladas_por_quien",
        visual: "barras",
        titulo: "Cancelaciones por quién",
        columnas: ["Quién canceló", "Cantidad"],
        filas: [
          ["El paciente (por WhatsApp)", porPaciente],
          ["La clínica (desde el panel)", porClinica],
          ["Sin dato (anteriores al registro)", canceladas.length - porPaciente - porClinica],
        ],
      },
      {
        clave: "pacientes_por_etapa",
        visual: "barras",
        titulo: "Pacientes por etapa (hoy)",
        columnas: ["Etapa", "Pacientes"],
        filas: ETAPAS.map((e) => [ETAPA_LABELS[e], porEtapa.find((x) => x.stage === e)?._count ?? 0]),
      },
    ],
    detalle: armarDetalle("", [], []),
    notas: [
      "Las citas del resumen son por la fecha de la cita; los pacientes por etapa son el estado de hoy y no cambian con el período.",
      "'Sin dato' son cancelaciones anteriores al 13/11/2026, cuando todavía no se guardaba quién cancelaba.",
    ],
  };
}

const QUIEN_CANCELO: Record<string, string> = {
  paciente: "El paciente (WhatsApp)",
  clinica: "La clínica (panel)",
};

async function cancelaciones(ctx: Contexto): Promise<ReportResult> {
  const { clinic, filters: f } = ctx;
  const where: Prisma.AppointmentWhereInput = {
    clinicId: clinic.id,
    status: "cancelado",
    // Una cancelación REAL: la dada de baja por reprogramación no es una cita perdida.
    OR: [{ cancelledByKind: null }, { cancelledByKind: { not: "reprogramacion" } }],
    ...(f.base === "cita"
      ? { startTime: { gte: f.from, lt: f.toExclusive } }
      : { cancelledAt: { gte: f.from, lt: f.toExclusive } }),
    ...scope(f),
  };
  const citas = await prisma.appointment.findMany({
    where,
    orderBy: [{ cancelledAt: "desc" }, { startTime: "desc" }],
    select: {
      id: true, startTime: true, cancelledAt: true, cancelledByKind: true, cancelReason: true, service: true,
      professional: { select: { name: true } },
      patient: { select: { name: true, phone: true } },
    },
  });

  // La queja se marca en el evento: es lo que permite separar "no pudo" de "se fue molesto".
  const quejas = new Set(
    (
      await prisma.appointmentEvent.findMany({
        where: { appointmentId: { in: citas.map((c) => c.id) }, type: "cancelada" },
        select: { appointmentId: true, details: true },
      })
    )
      .filter((e) => (e.details as { queja?: boolean } | null)?.queja === true)
      .map((e) => e.appointmentId)
  );

  const horasDeAnticipacion = (c: (typeof citas)[number]) =>
    c.cancelledAt ? Math.round(((c.startTime.getTime() - c.cancelledAt.getTime()) / 3_600_000) * 10) / 10 : null;
  const tardias = citas.filter((c) => {
    const h = horasDeAnticipacion(c);
    return h !== null && h < 24;
  }).length;
  const conMotivo = citas.filter((c) => c.cancelReason).length;
  const porDia = new Map<string, number>();
  for (const c of citas) {
    const d = clinicWeekday(c.startTime, clinic.timezone);
    porDia.set(d, (porDia.get(d) ?? 0) + 1);
  }
  const sinDato = citas.filter((c) => !c.cancelledByKind).length;

  const filas: Cell[][] = citas.map((c) => [
    cuando(c.cancelledAt, clinic.timezone),
    cuando(c.startTime, clinic.timezone),
    c.patient.name ?? c.patient.phone,
    c.service,
    c.professional.name,
    c.cancelledByKind ? (QUIEN_CANCELO[c.cancelledByKind] ?? c.cancelledByKind) : "Sin dato",
    c.cancelReason,
    quejas.has(c.id) ? "Sí" : "No",
    horasDeAnticipacion(c),
  ]);

  return {
    informe: "cancelaciones",
    titulo: "Citas canceladas",
    periodo: { desde: f.fromKey, hasta: f.toKey, base: f.base },
    desdeDatos: await desdeDatos(clinic.id, clinic.timezone),
    kpis: [
      { clave: "canceladas", etiqueta: "Canceladas", valor: citas.length, formato: "numero", ayuda: "No incluye las citas que el paciente movió a otra hora." },
      { clave: "por_paciente", etiqueta: "Las canceló el paciente", valor: citas.filter((c) => c.cancelledByKind === "paciente").length, formato: "numero" },
      { clave: "por_clinica", etiqueta: "Las canceló la clínica", valor: citas.filter((c) => c.cancelledByKind === "clinica").length, formato: "numero" },
      { clave: "tardias", etiqueta: "Con menos de 24 h de aviso", valor: tardias, formato: "numero", ayuda: "Canceladas con menos de un día de anticipación a la cita: las que más cuestan." },
      { clave: "con_motivo", etiqueta: "Con motivo registrado", valor: conMotivo, formato: "numero" },
      { clave: "quejas", etiqueta: "Por una queja", valor: citas.filter((c) => quejas.has(c.id)).length, formato: "numero", ayuda: "El paciente canceló por una molestia con la clínica y el caso se derivó a una persona." },
    ],
    tablas: [
      { clave: "por_profesional", titulo: "Por profesional", columnas: ["Profesional", "Canceladas"], filas: contar(citas, (c) => c.professional.name) },
      { clave: "por_servicio", titulo: "Por servicio", columnas: ["Servicio", "Canceladas"], filas: contar(citas, (c) => c.service) },
      {
        clave: "por_dia",
        titulo: "Por día de la semana de la cita",
        columnas: ["Día", "Canceladas"],
        filas: ORDEN_DIAS.map((d) => [DIAS_ES[d], porDia.get(d) ?? 0] as Cell[]),
      },
    ],
    detalle: armarDetalle(
      "Detalle de las cancelaciones",
      ["Cuándo se canceló", "Día de la cita", "Paciente", "Servicio", "Profesional", "Quién canceló", "Motivo", "Queja", "Horas de aviso"],
      filas
    ),
    notas: [
      ...(sinDato > 0
        ? [`${sinDato} cancelación(es) son anteriores al 13/11/2026: no tienen fecha de cancelación ni quién la hizo, y solo aparecen cuando el reporte es por el día de la cita.`]
        : []),
      ...(f.base === "evento" ? ["Por 'cuándo se canceló': se cuentan las canceladas dentro del período, sea cual sea el día de la cita."] : []),
    ],
  };
}

async function reagendadas(ctx: Contexto): Promise<ReportResult> {
  const { clinic, filters: f } = ctx;
  const eventos = await prisma.appointmentEvent.findMany({
    where: {
      clinicId: clinic.id,
      type: "reagendada",
      ...(f.base === "evento" ? { occurredAt: { gte: f.from, lt: f.toExclusive } } : {}),
      appointment: {
        ...(f.base === "cita" ? { startTime: { gte: f.from, lt: f.toExclusive } } : {}),
        ...scope(f),
      },
    },
    orderBy: { occurredAt: "desc" },
    select: {
      occurredAt: true, actorKind: true, fromStartTime: true, toStartTime: true, fromProfessionalId: true, toProfessionalId: true,
      appointment: { select: { service: true, professional: { select: { name: true } }, patient: { select: { name: true, phone: true } } } },
    },
  });

  const profesionales = new Map(
    (await prisma.professional.findMany({ where: { clinicId: clinic.id }, select: { id: true, name: true } })).map((p) => [p.id, p.name])
  );
  const nombre = (id: string | null) => (id ? (profesionales.get(id) ?? "—") : "—");
  const QUIEN: Record<string, string> = { paciente: "El paciente (WhatsApp)", usuario: "La clínica (panel)", sistema: "El sistema" };

  const conFechas = eventos.filter((e) => e.fromStartTime && e.toStartTime);
  const dias = (e: (typeof eventos)[number]) => (e.toStartTime!.getTime() - e.fromStartTime!.getTime()) / 86_400_000;
  const cambiaronProfesional = eventos.filter((e) => e.fromProfessionalId && e.toProfessionalId && e.fromProfessionalId !== e.toProfessionalId).length;
  const adelantadas = conFechas.filter((e) => dias(e) < 0).length;
  const atrasadas = conFechas.filter((e) => dias(e) > 0).length;
  const corrimiento = conFechas.length
    ? Math.round((conFechas.reduce((s, e) => s + Math.abs(dias(e)), 0) / conFechas.length) * 10) / 10
    : null;

  const filas: Cell[][] = eventos.map((e) => [
    cuando(e.occurredAt, clinic.timezone),
    cuando(e.fromStartTime, clinic.timezone),
    cuando(e.toStartTime, clinic.timezone),
    nombre(e.fromProfessionalId),
    nombre(e.toProfessionalId),
    QUIEN[e.actorKind] ?? e.actorKind,
    e.appointment.patient.name ?? e.appointment.patient.phone,
    e.appointment.service,
  ]);
  const primerDato = await desdeDatos(clinic.id, clinic.timezone);

  return {
    informe: "reagendadas",
    titulo: "Citas reagendadas",
    periodo: { desde: f.fromKey, hasta: f.toKey, base: f.base },
    desdeDatos: primerDato,
    kpis: [
      { clave: "reagendadas", etiqueta: "Reagendadas", valor: eventos.length, formato: "numero", ayuda: "Citas que cambiaron de hora o de profesional. Mover una cita no es cancelarla." },
      { clave: "por_paciente", etiqueta: "Las movió el paciente", valor: eventos.filter((e) => e.actorKind === "paciente").length, formato: "numero" },
      { clave: "por_clinica", etiqueta: "Las movió la clínica", valor: eventos.filter((e) => e.actorKind === "usuario").length, formato: "numero" },
      { clave: "cambio_profesional", etiqueta: "Cambiaron de profesional", valor: cambiaronProfesional, formato: "numero" },
      { clave: "adelantadas", etiqueta: "Se adelantaron", valor: adelantadas, formato: "numero" },
      { clave: "atrasadas", etiqueta: "Se atrasaron", valor: atrasadas, formato: "numero" },
      { clave: "corrimiento", etiqueta: "Corrimiento medio (días)", valor: corrimiento, formato: "numero", ayuda: "Cuántos días se movió la cita, en promedio, hacia adelante o hacia atrás." },
    ],
    tablas: [
      { clave: "por_profesional", titulo: "Por profesional (al que quedó)", columnas: ["Profesional", "Reagendadas"], filas: contar(eventos, (e) => nombre(e.toProfessionalId)) },
      { clave: "por_servicio", titulo: "Por servicio", columnas: ["Servicio", "Reagendadas"], filas: contar(eventos, (e) => e.appointment.service) },
    ],
    detalle: armarDetalle(
      "Detalle de las reagendadas",
      ["Cuándo se cambió", "Era el", "Pasó al", "Profesional antes", "Profesional ahora", "Quién la movió", "Paciente", "Servicio"],
      filas
    ),
    notas: [
      primerDato
        ? `Hay datos desde el ${primerDato.split("-").reverse().join("/")}: lo reagendado antes no se guardaba y no se puede recuperar.`
        : "Todavía no hay reagendados registrados.",
    ],
  };
}

async function atendidos(ctx: Contexto): Promise<ReportResult> {
  const { clinic, filters: f } = ctx;
  const citas = await prisma.appointment.findMany({
    where: { clinicId: clinic.id, status: "atendido", startTime: { gte: f.from, lt: f.toExclusive }, ...scope(f) },
    orderBy: { startTime: "desc" },
    select: {
      startTime: true, attendedAt: true, service: true, patientId: true,
      professional: { select: { id: true, name: true } },
      patient: { select: { name: true, phone: true } },
    },
  });

  const confirmada = (c: (typeof citas)[number]) => Boolean(c.attendedAt);
  const resumenPor = (clave: (c: (typeof citas)[number]) => string) =>
    [...new Set(citas.map(clave))]
      .map((k) => {
        const delGrupo = citas.filter((c) => clave(c) === k);
        return [
          k,
          delGrupo.filter(confirmada).length,
          delGrupo.filter((c) => !confirmada(c)).length,
          delGrupo.length,
          new Set(delGrupo.map((c) => c.patientId)).size,
        ] as Cell[];
      })
      .sort((a, b) => (b[3] as number) - (a[3] as number) || String(a[0]).localeCompare(String(b[0])));

  const filas: Cell[][] = citas.map((c) => [
    cuando(c.startTime, clinic.timezone),
    c.patient.name ?? c.patient.phone,
    c.service,
    c.professional.name,
    confirmada(c) ? "Sí, la confirmó una persona" : "No, la dio por atendida el sistema",
  ]);

  return {
    informe: "atendidos",
    titulo: "Atendidos por profesional",
    periodo: { desde: f.fromKey, hasta: f.toKey, base: "cita" },
    desdeDatos: await desdeDatos(clinic.id, clinic.timezone),
    kpis: [
      { clave: "atendidas", etiqueta: "Citas atendidas", valor: citas.length, formato: "numero" },
      { clave: "pacientes", etiqueta: "Pacientes distintos atendidos", valor: new Set(citas.map((c) => c.patientId)).size, formato: "numero", ayuda: "Cada persona cuenta una vez aunque haya venido varias veces en el período." },
      { clave: "confirmadas", etiqueta: "Confirmadas por una persona", valor: citas.filter(confirmada).length, formato: "numero", ayuda: "Alguien de la clínica marcó que el paciente vino." },
      { clave: "automaticas", etiqueta: "Dadas por atendidas por el sistema", valor: citas.filter((c) => !confirmada(c)).length, formato: "numero", ayuda: "El sistema las dio por atendidas a las 24 horas: no prueba que el paciente fue." },
    ],
    tablas: [
      {
        clave: "por_profesional",
        titulo: "Por profesional",
        columnas: ["Profesional", "Confirmadas", "Automáticas", "Total", "Pacientes distintos"],
        filas: resumenPor((c) => c.professional.name),
      },
      {
        clave: "por_servicio",
        titulo: "Por servicio",
        columnas: ["Servicio", "Confirmadas", "Automáticas", "Total", "Pacientes distintos"],
        filas: resumenPor((c) => c.service),
      },
    ],
    detalle: armarDetalle("Detalle de las citas atendidas", ["Día de la cita", "Paciente", "Servicio", "Profesional", "¿Confirmada?"], filas),
    notas: ["Siempre es por el día de la cita. Una cita que se movió cuenta con el profesional que la atendió."],
  };
}

async function sinConfirmar(ctx: Contexto): Promise<ReportResult> {
  const { clinic, filters: f, now } = ctx;
  const citas = await prisma.appointment.findMany({
    where: { clinicId: clinic.id, status: "confirmado", startTime: { gte: f.from, lt: f.toExclusive, lte: now }, ...scope(f) },
    orderBy: { startTime: "desc" },
    select: {
      startTime: true, service: true,
      professional: { select: { name: true } },
      patient: { select: { name: true, phone: true } },
    },
  });
  const diasDesde = (c: (typeof citas)[number]) => Math.floor((now.getTime() - c.startTime.getTime()) / 86_400_000);
  const filas: Cell[][] = citas.map((c) => [
    cuando(c.startTime, clinic.timezone),
    c.patient.name ?? c.patient.phone,
    c.service,
    c.professional.name,
    diasDesde(c),
  ]);

  return {
    informe: "sin-confirmar",
    titulo: "Citas sin confirmar",
    periodo: { desde: f.fromKey, hasta: f.toKey, base: "cita" },
    desdeDatos: await desdeDatos(clinic.id, clinic.timezone),
    kpis: [
      { clave: "sin_confirmar", etiqueta: "Sin confirmar", valor: citas.length, formato: "numero", ayuda: "Citas ya pasadas que nadie marcó como atendidas ni canceló: pueden ser pacientes que no vinieron, o asistencias que se olvidaron." },
      { clave: "mas_de_7_dias", etiqueta: "Con más de 7 días", valor: citas.filter((c) => diasDesde(c) > 7).length, formato: "numero" },
    ],
    tablas: [
      { clave: "por_profesional", titulo: "Por profesional", columnas: ["Profesional", "Sin confirmar"], filas: contar(citas, (c) => c.professional.name) },
    ],
    detalle: armarDetalle("Citas para revisar", ["Día de la cita", "Paciente", "Servicio", "Profesional", "Días desde la cita"], filas),
    notas: [
      "Cada una es una cita que el sistema todavía no sabe si se cumplió: se marca como atendida desde la Agenda o desde 'Citas', o se cancela.",
      "Las que lleven más de 24 horas el sistema las da por atendidas solo (aparecen como 'automáticas' en el reporte de atendidos).",
    ],
  };
}

// --- Ocupación ---

const redondear1 = (n: number) => Math.round(n * 10) / 10;
const horas = (minutos: number) => redondear1(minutos / 60);

interface Tramo {
  startMinute: number;
  endMinute: number;
}

/** Minutos de [a, b) que caen dentro de cada hora del día (0-23). */
function repartirPorHora(startMinute: number, endMinute: number): Map<number, number> {
  const m = new Map<number, number>();
  const fin = Math.min(endMinute, 24 * 60);
  for (let h = Math.floor(startMinute / 60); h * 60 < fin; h += 1) {
    const solape = Math.min(fin, (h + 1) * 60) - Math.max(startMinute, h * 60);
    if (solape > 0) m.set(h, (m.get(h) ?? 0) + solape);
  }
  return m;
}

/** Une los tramos que se tocan o se pisan. */
function unirTramos(tramos: Array<[number, number]>): Array<[number, number]> {
  const orden = [...tramos].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of orden) {
    const ultimo = out[out.length - 1];
    if (ultimo && a <= ultimo[1]) ultimo[1] = Math.max(ultimo[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Lo que queda libre de los tramos abiertos al sacar lo ocupado: los "huecos". */
function huecosLibres(abiertos: Tramo[], ocupados: Array<[number, number]>): number[] {
  const mezclados = unirTramos(ocupados);
  const huecos: number[] = [];
  for (const t of abiertos) {
    let cursor = t.startMinute;
    for (const [a, b] of mezclados) {
      if (b <= cursor || a >= t.endMinute) continue;
      if (a > cursor) huecos.push(a - cursor);
      cursor = Math.max(cursor, b);
    }
    if (cursor < t.endMinute) huecos.push(t.endMinute - cursor);
  }
  return huecos;
}

/**
 * Cuánto se usa cada espacio, equipo y profesional, y dónde quedan los tiempos muertos.
 *
 * **Uso = minutos con una cita ÷ minutos que la clínica estuvo abierta** en el período. El
 * "abierto" sale de `getEffectiveIntervalsForRange()`, la misma función que valida los turnos
 * (horario semanal, excepciones y feriados ya resueltos): si se calculara aparte, un feriado
 * contaría como capacidad perdida. Cada espacio y cada equipo tiene la misma capacidad (la
 * clínica abierta, que es lo que un espacio puede dar); cada profesional, la suya (su horario
 * dentro del de la clínica).
 *
 * **Tiempos muertos**: lo libre no es todo aprovechable. Un hueco entre dos citas solo sirve si
 * cabe el servicio más corto de la clínica; de 10 minutos sueltos no se saca una cita. Por eso
 * se separan las horas libres "aprovechables" (huecos que caben una cita) de las "sueltas", y se
 * informa el hueco más largo de cada espacio. El mapa de calor (día × hora) muestra dónde están.
 *
 * **Solo cuenta lo transcurrido**: un período que llega al futuro se corta en este instante;
 * contar lo que todavía no pasó bajaría el porcentaje sin que nadie haya dejado de usar nada. Lo
 * que ocupa es lo agendado (confirmadas y atendidas); las canceladas liberaron el lugar.
 *
 * Si se filtra por profesional o servicio, la capacidad no cambia: es el uso POR ESAS citas.
 */
async function ocupacion(ctx: Contexto): Promise<ReportResult> {
  const { clinic, filters: f, now } = ctx;
  const hoy = clinicDateKey(now, clinic.timezone);
  const hastaKey = f.toKey < hoy ? f.toKey : hoy;
  const corte = now < f.toExclusive ? now : f.toExclusive;

  const [rooms, resources, profesionales, servicios, clinicRow] = await Promise.all([
    prisma.room.findMany({ where: { clinicId: clinic.id }, select: { id: true, name: true, active: true }, orderBy: { name: "asc" } }),
    prisma.resource.findMany({ where: { clinicId: clinic.id }, select: { id: true, name: true, type: true, active: true }, orderBy: { name: "asc" } }),
    prisma.professional.findMany({ where: { clinicId: clinic.id }, select: { id: true, name: true, active: true }, orderBy: { name: "asc" } }),
    prisma.service.findMany({ where: { clinicId: clinic.id, active: true }, select: { durationMinutes: true } }),
    prisma.clinic.findUnique({ where: { id: clinic.id }, select: { defaultAppointmentMinutes: true } }),
  ]);
  // El hueco más chico en el que entra una cita.
  const minHueco = servicios.length > 0 ? Math.min(...servicios.map((x) => x.durationMinutes)) : clinicRow?.defaultAppointmentMinutes ?? 30;

  // Los días del período que ya empezaron.
  const dias: Array<{ dateKey: string; weekday: NonNullable<ReturnType<typeof weekdayFromDateKey>> }> = [];
  for (let key: string | null = f.fromKey; key && key <= hastaKey && dias.length <= MAX_RANGE_DAYS; key = addDaysToDateKey(key, 1)) {
    const weekday = weekdayFromDateKey(key);
    if (weekday) dias.push({ dateKey: key, weekday });
  }

  // Capacidad: minutos abiertos de la clínica (total, por día de la semana, por hora y por día×hora),
  // los tramos abiertos de cada día y la capacidad de cada profesional.
  let capacidad = 0;
  const abiertoPorDia = new Map<string, Tramo[]>();
  const capPorDiaSemana = new Map<string, number>();
  const capPorHora = new Map<number, number>();
  const capPorDiaHora = new Map<string, number>();
  const capProfesional = new Map<string, number>();
  if (profesionales.length > 0 && dias.length > 0) {
    const tramos = await getEffectiveIntervalsForRange({
      clinicId: clinic.id,
      professionalIds: profesionales.map((p) => p.id),
      days: dias.map((d) => ({ dateKey: d.dateKey, weekday: d.weekday as never })),
    });
    const minutoActual = clinicMinutesFromMidnight(now, clinic.timezone);
    // Hoy se corta a la hora actual.
    const cortar = (dateKey: string, ts: Tramo[]): Tramo[] =>
      ts
        .map((t) => ({ startMinute: t.startMinute, endMinute: dateKey === hoy ? Math.min(t.endMinute, minutoActual) : t.endMinute }))
        .filter((t) => t.endMinute > t.startMinute);

    for (const d of dias) {
      const delDia = cortar(d.dateKey, tramos.get(intervalsKey(d.dateKey, profesionales[0].id))?.clinic.intervals ?? []);
      abiertoPorDia.set(d.dateKey, delDia);
      for (const t of delDia) {
        capacidad += t.endMinute - t.startMinute;
        capPorDiaSemana.set(d.weekday, (capPorDiaSemana.get(d.weekday) ?? 0) + (t.endMinute - t.startMinute));
        for (const [h, min] of repartirPorHora(t.startMinute, t.endMinute)) {
          capPorHora.set(h, (capPorHora.get(h) ?? 0) + min);
          capPorDiaHora.set(`${d.weekday}|${h}`, (capPorDiaHora.get(`${d.weekday}|${h}`) ?? 0) + min);
        }
      }
      // La de cada profesional: lo que la clínica atiende Y él trabaja.
      for (const p of profesionales) {
        const efectivo = tramos.get(intervalsKey(d.dateKey, p.id))?.professional.intervals ?? [];
        const propios = cortar(d.dateKey, intersectIntervals(delDia, efectivo));
        capProfesional.set(p.id, (capProfesional.get(p.id) ?? 0) + propios.reduce((s, t) => s + (t.endMinute - t.startMinute), 0));
      }
    }
  }

  const citas = dias.length === 0
    ? []
    : await prisma.appointment.findMany({
        where: { clinicId: clinic.id, status: { in: ["confirmado", "atendido"] }, startTime: { gte: f.from, lt: corte }, ...scope(f) },
        select: { roomId: true, resourceId: true, professionalId: true, startTime: true, endTime: true },
      });
  type Cita = (typeof citas)[number];

  // Lo que ocupa cada cita, cortado en este instante (una en curso cuenta lo que lleva).
  const ocupada = (c: Cita) => Math.max(0, (Math.min(c.endTime.getTime(), now.getTime()) - c.startTime.getTime()) / 60_000);

  interface Uso { citas: number; minutos: number; dias: Set<string>; ocupadosPorDia: Map<string, Array<[number, number]>> }
  const usoDe = (idDe: (c: Cita) => string | null) => {
    const m = new Map<string, Uso>();
    for (const c of citas) {
      const id = idDe(c);
      if (!id) continue;
      const u = m.get(id) ?? { citas: 0, minutos: 0, dias: new Set<string>(), ocupadosPorDia: new Map() };
      const min = ocupada(c);
      const dia = clinicDateKey(c.startTime, clinic.timezone);
      const ini = clinicMinutesFromMidnight(c.startTime, clinic.timezone);
      u.citas += 1;
      u.minutos += min;
      u.dias.add(dia);
      u.ocupadosPorDia.set(dia, [...(u.ocupadosPorDia.get(dia) ?? []), [ini, ini + min]]);
      m.set(id, u);
    }
    return m;
  };
  const usoEspacios = usoDe((c) => c.roomId);
  const usoEquipos = usoDe((c) => c.resourceId);
  const usoProfesionales = usoDe((c) => c.professionalId);

  // Un desactivado solo se muestra si tuvo citas en el período: si no, es ruido.
  const espacios = rooms.filter((r) => r.active || usoEspacios.has(r.id));
  const equipos = resources.filter((r) => r.active || usoEquipos.has(r.id));
  const profs = profesionales.filter((p) => (p.active || usoProfesionales.has(p.id)) && (!f.professionalId || p.id === f.professionalId));

  const pct = (minutos: number, cap: number) => (cap > 0 ? redondear1((minutos / cap) * 100) : 0);
  const barras = <T extends { name: string }>(items: T[], uso: Map<string, Uso>, idDe: (i: T) => string, cap: (i: T) => number) =>
    items.map((i) => [i.name, pct(uso.get(idDe(i))?.minutos ?? 0, cap(i))] as Cell[]).sort((a, b) => (b[1] as number) - (a[1] as number));

  // Los huecos de cada espacio: lo libre dentro del horario, entre cita y cita.
  const huecosDe = (id: string) => {
    const u = usoEspacios.get(id);
    let aprovechable = 0;
    let suelto = 0;
    let mayor = 0;
    for (const [dateKey, abiertos] of abiertoPorDia) {
      for (const h of huecosLibres(abiertos, u?.ocupadosPorDia.get(dateKey) ?? [])) {
        mayor = Math.max(mayor, h);
        if (h >= minHueco) aprovechable += h;
        else suelto += h;
      }
    }
    return { aprovechable, suelto, mayor };
  };

  // Todo junto: por día de la semana, por hora y el mapa de calor (sobre la capacidad de TODOS los espacios).
  const nEspacios = espacios.length;
  const porDiaMin = new Map<string, number>();
  const porHoraMin = new Map<number, number>();
  const porDiaHoraMin = new Map<string, number>();
  for (const c of citas) {
    const min = ocupada(c);
    const dia = clinicWeekday(c.startTime, clinic.timezone);
    porDiaMin.set(dia, (porDiaMin.get(dia) ?? 0) + min);
    const ini = clinicMinutesFromMidnight(c.startTime, clinic.timezone);
    for (const [h, m] of repartirPorHora(ini, ini + min)) {
      porHoraMin.set(h, (porHoraMin.get(h) ?? 0) + m);
      porDiaHoraMin.set(`${dia}|${h}`, (porDiaHoraMin.get(`${dia}|${h}`) ?? 0) + m);
    }
  }
  const diasConCapacidad = ORDEN_DIAS.filter((d) => (capPorDiaSemana.get(d) ?? 0) > 0);
  const horasConCapacidad = [...capPorHora.keys()].sort((a, b) => a - b);
  const etiquetaHora = (h: number) => `${String(h).padStart(2, "0")}:00`;
  const porDia = diasConCapacidad.map((d) => [DIAS_ES[d], pct(porDiaMin.get(d) ?? 0, (capPorDiaSemana.get(d) ?? 0) * nEspacios)] as Cell[]);
  const porHora = horasConCapacidad.map((h) => [etiquetaHora(h), pct(porHoraMin.get(h) ?? 0, (capPorHora.get(h) ?? 0) * nEspacios)] as Cell[]);
  // Mapa de calor: una fila por día y una columna por hora; vacío (null) donde la clínica estaba cerrada.
  const calor = diasConCapacidad.map(
    (d) =>
      [
        DIAS_ES[d],
        ...horasConCapacidad.map((h) => {
          const cap = capPorDiaHora.get(`${d}|${h}`) ?? 0;
          return cap > 0 ? pct(porDiaHoraMin.get(`${d}|${h}`) ?? 0, cap * nEspacios) : null;
        }),
      ] as Cell[]
  );

  const minutosTotales = espacios.reduce((s, r) => s + (usoEspacios.get(r.id)?.minutos ?? 0), 0);
  const capacidadTotal = capacidad * nEspacios;
  const sinUso = espacios.filter((r) => r.active && !usoEspacios.has(r.id)).length;
  const huecos = new Map(espacios.map((r) => [r.id, huecosDe(r.id)]));
  const aprovechableTotal = [...huecos.values()].reduce((s, h) => s + h.aprovechable, 0);

  const detalleFilas: Cell[][] = espacios
    .map((r) => {
      const u = usoEspacios.get(r.id);
      const minutos = u?.minutos ?? 0;
      const h = huecos.get(r.id)!;
      return [
        r.name,
        r.active ? "Activo" : "Desactivado",
        u?.citas ?? 0,
        horas(minutos),
        horas(capacidad),
        horas(Math.max(0, capacidad - minutos)),
        pct(minutos, capacidad),
        u?.dias.size ?? 0,
        [...abiertoPorDia.entries()].filter(([k, t]) => t.length > 0 && !(u?.dias.has(k))).length,
        horas(h.aprovechable),
        h.mayor,
      ] as Cell[];
    })
    .sort((a, b) => (b[6] as number) - (a[6] as number));

  const profFilas: Cell[][] = profs
    .map((p) => {
      const cap = capProfesional.get(p.id) ?? 0;
      const u = usoProfesionales.get(p.id);
      const minutos = u?.minutos ?? 0;
      return [p.name, u?.citas ?? 0, horas(minutos), horas(cap), horas(Math.max(0, cap - minutos)), pct(minutos, cap)] as Cell[];
    })
    .sort((a, b) => (b[5] as number) - (a[5] as number));

  const notas = [
    "El uso es el tiempo con una cita (confirmadas y atendidas) sobre el tiempo que la clínica estuvo abierta. Los feriados y los cierres no cuentan como capacidad.",
    `Una hora libre es "aprovechable" si está en un hueco donde entra el servicio más corto (${minHueco} min); los huecos más chicos quedan sueltos y no se pueden vender.`,
    "Solo cuenta lo que ya pasó: si el período llega al futuro, se corta en este momento.",
  ];
  if (profesionales.length === 0 || capacidad === 0) notas.push("La clínica no tiene horario de atención cargado para este período, así que no hay capacidad contra la cual medir el uso.");
  if (f.professionalId || f.serviceId) notas.push("Con un filtro de profesional o servicio se mide el uso POR ESAS citas: la capacidad no cambia.");
  if (rooms.some((r) => !r.active)) notas.push("Los espacios desactivados solo aparecen si tuvieron citas en el período.");

  return {
    informe: "ocupacion",
    titulo: "Uso de espacios, equipos y profesionales",
    periodo: { desde: f.fromKey, hasta: f.toKey, base: "cita" },
    desdeDatos: null,
    kpis: [
      { clave: "ocupacion", etiqueta: "Uso de los espacios", valor: capacidadTotal > 0 ? pct(minutosTotales, capacidadTotal) : null, formato: "porcentaje", ayuda: "Tiempo con una cita sobre el tiempo que la clínica estuvo abierta, sumando todos los espacios." },
      { clave: "espacios_en_uso", etiqueta: "Espacios con citas", valor: espacios.filter((r) => usoEspacios.has(r.id)).length, formato: "numero" },
      { clave: "espacios_sin_uso", etiqueta: "Espacios sin ninguna cita", valor: sinUso, formato: "numero", ayuda: "Espacios activos que no tuvieron ni una cita en todo el período." },
      { clave: "horas_libres", etiqueta: "Horas libres", valor: horas(Math.max(0, capacidadTotal - minutosTotales)), formato: "numero", ayuda: "Horas en que la clínica estuvo abierta y el espacio no tuvo ninguna cita, sumando todos los espacios. Incluye los huecos chicos donde no entra una cita: los que sí sirven están en \"Horas libres aprovechables\"." },
      { clave: "horas_aprovechables", etiqueta: "Horas libres aprovechables", valor: horas(aprovechableTotal), formato: "numero", ayuda: `No toda hora libre sirve para dar una cita: si entre dos citas quedan solo 10 minutos, nadie se puede atender ahí.\nEsta cifra suma solo las horas libres que están en huecos donde SÍ cabe una cita, es decir, de al menos ${minHueco} minutos (lo que dura el servicio más corto de la clínica).\nEjemplo: de 9:30 a 11:00 hay libre, y es un hueco de 90 min: cuenta. Entre las 9:30 y las 9:40 hay libre, pero son 10 min: no cuenta.\nEs el tiempo muerto que la clínica puede llenar.` },
      { clave: "citas", etiqueta: "Citas en el período", valor: citas.length, formato: "numero" },
    ],
    tablas: [
      { clave: "uso_espacios", titulo: "Uso de cada espacio", columnas: ["Espacio", "Uso"], filas: barras(espacios, usoEspacios, (r) => r.id, () => capacidad), visual: "barras", unidad: "%" },
      ...(equipos.length > 0
        ? [{ clave: "uso_equipos", titulo: "Uso de cada equipo", columnas: ["Equipo", "Uso"], filas: barras(equipos, usoEquipos, (r) => r.id, () => capacidad), visual: "barras" as const, unidad: "%" as const }]
        : []),
      ...(profs.length > 0
        ? [{ clave: "uso_profesionales", titulo: "Uso de cada profesional", columnas: ["Profesional", "Uso"], filas: profFilas.map((x) => [x[0], x[5]] as Cell[]), visual: "barras" as const, unidad: "%" as const }]
        : []),
      { clave: "mapa_calor", titulo: "Mapa de calor: uso por día y hora (todos los espacios)", columnas: ["Día", ...horasConCapacidad.map(etiquetaHora)], filas: calor, visual: "calor", unidad: "%" },
      { clave: "uso_por_dia", titulo: "Uso por día de la semana", columnas: ["Día", "Uso"], filas: porDia, visual: "barras", unidad: "%" },
      { clave: "uso_por_hora", titulo: "Uso por franja horaria", columnas: ["Hora", "Uso"], filas: porHora, visual: "barras", unidad: "%" },
      ...(profs.length > 0
        ? [{ clave: "horas_profesionales", titulo: "Horas por profesional", columnas: ["Profesional", "Citas", "Horas con citas", "Horas disponibles", "Horas libres", "Uso (%)"], filas: profFilas }]
        : []),
    ],
    detalle: armarDetalle(
      "Detalle por espacio",
      ["Espacio", "Estado", "Citas", "Horas usadas", "Horas abiertas", "Horas libres", "Uso (%)", "Días con citas", "Días abiertos sin citas", "Horas libres aprovechables", "Hueco libre más largo (min)"],
      detalleFilas
    ),
    notas,
  };
}

// --- Pacientes: nuevos, recurrentes y los que no volvieron ---

const DIAS_SIN_VOLVER = 60;
const MS_DIA = 86_400_000;

/**
 * Cuántos pacientes son nuevos y cuántos vuelven, y a quién hay que ir a buscar porque hace
 * tiempo que no viene.
 *
 * - **Nuevo**: su primera cita (confirmada o atendida, la más antigua que tenga) cae en el período.
 *   **Recurrente**: vino en el período y ya tenía una anterior. Es por PERSONA (una ficha), no por
 *   WhatsApp: una familia con un número son varios pacientes.
 * - **No volvió**: su última visita cumplida (marcada por una persona o dada por atendida por el
 *   sistema) fue hace 60 días o más y NO tiene una cita futura. Es la lista de contacto, y no
 *   depende del período ni de los filtros: se mide contra hoy.
 *
 * Los filtros de profesional y servicio no se aplican: "primera cita" con un profesional no es lo
 * mismo que paciente nuevo de la clínica, y mezclarlos llevaría a contar mal.
 */
async function pacientes(ctx: Contexto): Promise<ReportResult> {
  const { clinic, filters: f, now } = ctx;
  const corte = now < f.toExclusive ? now : f.toExclusive;
  const vigente = { in: ["confirmado", "atendido"] as Array<"confirmado" | "atendido"> };

  const [primeras, delPeriodo, ultimas, conFutura] = await Promise.all([
    prisma.appointment.groupBy({ by: ["patientId"], where: { clinicId: clinic.id, status: vigente }, _min: { startTime: true } }),
    prisma.appointment.groupBy({ by: ["patientId"], where: { clinicId: clinic.id, status: vigente, startTime: { gte: f.from, lt: corte } }, _count: true }),
    prisma.appointment.groupBy({
      by: ["patientId"],
      where: { clinicId: clinic.id, startTime: { lt: now }, OR: [{ status: "atendido" }, { attendedAt: { not: null } }] },
      _max: { startTime: true },
    }),
    prisma.appointment.groupBy({ by: ["patientId"], where: { clinicId: clinic.id, status: "confirmado", startTime: { gte: now } }, _count: true }),
  ]);

  const primera = new Map(primeras.map((p) => [p.patientId, p._min.startTime]));
  // Quien ya era paciente antes de la plataforma (importación inicial) es recurrente aunque su primera cita acá caiga en el período.
  const conHistoriaPrevia = new Set(
    (await prisma.patient.findMany({
      where: { clinicId: clinic.id, priorHistory: true, id: { in: delPeriodo.map((p) => p.patientId) } },
      select: { id: true },
    })).map((p) => p.id)
  );
  const nuevos = delPeriodo.filter(
    (p) => !conHistoriaPrevia.has(p.patientId) && (primera.get(p.patientId)?.getTime() ?? 0) >= f.from.getTime()
  ).length;
  const recurrentes = delPeriodo.length - nuevos;

  const futura = new Set(conFutura.map((p) => p.patientId));
  const dias = (d: Date) => Math.floor((now.getTime() - d.getTime()) / MS_DIA);
  const sinVolver = ultimas
    .filter((u) => u._max.startTime && dias(u._max.startTime) >= DIAS_SIN_VOLVER && !futura.has(u.patientId))
    .map((u) => ({ patientId: u.patientId, ultima: u._max.startTime as Date, dias: dias(u._max.startTime as Date) }))
    .sort((a, b) => a.dias - b.dias);

  const datos = await prisma.patient.findMany({
    where: { clinicId: clinic.id, id: { in: sinVolver.map((s) => s.patientId) } },
    select: { id: true, name: true, phone: true, suggestedNextVisitDate: true, outreachOptOut: true },
  });
  const porId = new Map(datos.map((p) => [p.id, p]));
  const tramo = (d: number) => (d >= 180 ? "6 meses o más" : d >= 90 ? "3 a 6 meses" : "2 a 3 meses");
  const filas: Cell[][] = sinVolver.map((s) => {
    const p = porId.get(s.patientId);
    return [
      p?.name ?? "Sin nombre",
      p?.phone ?? "",
      clinicDateKey(s.ultima, clinic.timezone),
      s.dias,
      tramo(s.dias),
      p?.suggestedNextVisitDate ? p.suggestedNextVisitDate.toISOString().slice(0, 10) : null,
      p?.outreachOptOut ? "Sí" : "No",
    ] as Cell[];
  });
  const ordenTramos = ["2 a 3 meses", "3 a 6 meses", "6 meses o más"];

  return {
    informe: "pacientes",
    titulo: "Pacientes nuevos, recurrentes y los que no volvieron",
    periodo: { desde: f.fromKey, hasta: f.toKey, base: "cita" },
    desdeDatos: null,
    kpis: [
      { clave: "pacientes_periodo", etiqueta: "Pacientes con cita en el período", valor: delPeriodo.length, formato: "numero", ayuda: "Personas distintas con al menos una cita confirmada o atendida en el período." },
      { clave: "nuevos", etiqueta: "Nuevos", valor: nuevos, formato: "numero", ayuda: "Su primera cita en la clínica cae en el período." },
      { clave: "recurrentes", etiqueta: "Recurrentes", valor: recurrentes, formato: "numero", ayuda: "Ya habían tenido una cita antes del período." },
      { clave: "tasa_recurrentes", etiqueta: "Recurrentes sobre el total", valor: porcentaje(recurrentes, delPeriodo.length), formato: "porcentaje" },
      { clave: "sin_volver", etiqueta: "Sin volver hace 2 meses o más", valor: sinVolver.length, formato: "numero", ayuda: "Última visita cumplida hace 60 días o más y sin una cita futura. Se mide contra hoy, no contra el período." },
      { clave: "sin_volver_90", etiqueta: "Sin volver hace 3 meses o más", valor: sinVolver.filter((s) => s.dias >= 90).length, formato: "numero" },
      { clave: "sin_volver_180", etiqueta: "Sin volver hace 6 meses o más", valor: sinVolver.filter((s) => s.dias >= 180).length, formato: "numero" },
    ],
    tablas: [
      { clave: "nuevos_vs_recurrentes", titulo: "Nuevos y recurrentes", columnas: ["Tipo", "Pacientes"], filas: [["Nuevos", nuevos], ["Recurrentes", recurrentes]], visual: "barras" },
      { clave: "sin_volver_por_tramo", titulo: "Cuánto hace que no vuelven", columnas: ["Tiempo sin volver", "Pacientes"], filas: ordenTramos.map((t) => [t, filas.filter((x) => x[4] === t).length] as Cell[]), visual: "barras" },
    ],
    detalle: armarDetalle(
      "Pacientes a quienes contactar",
      ["Paciente", "Teléfono", "Última visita", "Días sin volver", "Tiempo sin volver", "Próxima cita sugerida", "No contactar"],
      filas
    ),
    notas: [
      "La lista de 'sin volver' se mide contra hoy y no usa el período ni los filtros de profesional y servicio. Los más recientes van primero: son los más fáciles de recuperar.",
      "Quienes están marcados 'No contactar' no deben recibir mensajes de la clínica por iniciativa propia.",
      "Es por persona (una ficha): una familia que comparte un WhatsApp son varios pacientes.",
    ],
  };
}

// --- Origen de las citas ---

/** El lunes de la semana de un día (YYYY-MM-DD), para agrupar por semana. */
function lunesDe(dateKey: string, instante: Date, timezone: string): string {
  const idx = ORDEN_DIAS.indexOf(clinicWeekday(instante, timezone));
  return (idx > 0 ? addDaysToDateKey(dateKey, -idx) : dateKey) ?? dateKey;
}

/**
 * De dónde vienen las reservas: el asistente de WhatsApp o la asistente desde el panel.
 *
 * Una reserva es una cita CREADA en el período (por su fecha de creación, no la de la cita). **No
 * cuenta las nuevas que son un reagendado** (`rescheduledFromId`): ahí el paciente movió una cita que
 * ya había reservado. El origen sale de `Appointment.createdByUserId`: con un usuario, la cargó
 * alguien de la clínica desde el panel; sin usuario, la agendó el asistente de WhatsApp. Funciona con
 * lo histórico, pero las anteriores a que existiera la Agenda editable (2026-11-07) no tienen usuario
 * y se leen como del asistente.
 *
 * Además mide lo que el asistente le suma a la clínica: cuántas reservas entraron **con la clínica
 * cerrada**, que sin él se habrían perdido o esperado a la mañana siguiente.
 */
async function origen(ctx: Contexto): Promise<ReportResult> {
  const { clinic, filters: f } = ctx;
  const citas = await prisma.appointment.findMany({
    where: { clinicId: clinic.id, createdAt: { gte: f.from, lt: f.toExclusive }, rescheduledFromId: null, ...scope(f) },
    orderBy: { createdAt: "desc" },
    select: {
      createdAt: true, startTime: true, status: true, service: true, createdByUserId: true,
      professional: { select: { name: true } },
      patient: { select: { name: true, phone: true } },
    },
  });
  type C = (typeof citas)[number];
  const delPanel = (c: C) => c.createdByUserId !== null;
  const porWhatsapp = citas.filter((c) => !delPanel(c));
  const porPanel = citas.filter(delPanel);

  const usuarios = new Map(
    (await prisma.user.findMany({
      where: { id: { in: [...new Set(porPanel.map((c) => c.createdByUserId as string))] } },
      select: { id: true, name: true },
    })).map((u) => [u.id, u.name])
  );

  // Las del asistente que entraron con la clínica cerrada.
  let fueraDeHorario: number | null = null;
  const unProfesional = await prisma.professional.findFirst({ where: { clinicId: clinic.id }, select: { id: true } });
  if (unProfesional && porWhatsapp.length > 0) {
    const dias = new Map<string, { dateKey: string; weekday: NonNullable<ReturnType<typeof weekdayFromDateKey>> }>();
    for (const c of porWhatsapp) {
      const dateKey = clinicDateKey(c.createdAt, clinic.timezone);
      const weekday = weekdayFromDateKey(dateKey);
      if (weekday) dias.set(dateKey, { dateKey, weekday });
    }
    const tramos = await getEffectiveIntervalsForRange({
      clinicId: clinic.id,
      professionalIds: [unProfesional.id],
      days: [...dias.values()].map((d) => ({ dateKey: d.dateKey, weekday: d.weekday as never })),
    });
    const hayHorario = [...tramos.values()].some((t) => t.clinic.intervals.length > 0);
    if (hayHorario) {
      fueraDeHorario = porWhatsapp.filter((c) => {
        const dateKey = clinicDateKey(c.createdAt, clinic.timezone);
        const minuto = clinicMinutesFromMidnight(c.createdAt, clinic.timezone);
        const abierto = tramos.get(intervalsKey(dateKey, unProfesional.id))?.clinic.intervals ?? [];
        return !abierto.some((t) => minuto >= t.startMinute && minuto < t.endMinute);
      }).length;
    }
  }

  const etiqueta = (c: C) => (delPanel(c) ? "Panel (la clínica)" : "Asistente de WhatsApp");
  const porSemana = new Map<string, { w: number; p: number }>();
  for (const c of citas) {
    const k = lunesDe(clinicDateKey(c.createdAt, clinic.timezone), c.createdAt, clinic.timezone);
    const v = porSemana.get(k) ?? { w: 0, p: 0 };
    if (delPanel(c)) v.p += 1;
    else v.w += 1;
    porSemana.set(k, v);
  }
  const porProfesional = new Map<string, { w: number; p: number }>();
  for (const c of citas) {
    const v = porProfesional.get(c.professional.name) ?? { w: 0, p: 0 };
    if (delPanel(c)) v.p += 1;
    else v.w += 1;
    porProfesional.set(c.professional.name, v);
  }
  const tasaCancel = (items: C[]) => porcentaje(items.filter((c) => c.status === "cancelado").length, items.length);

  return {
    informe: "origen",
    titulo: "Origen de las reservas",
    periodo: { desde: f.fromKey, hasta: f.toKey, base: "evento" },
    desdeDatos: null,
    kpis: [
      { clave: "reservas", etiqueta: "Reservas del período", valor: citas.length, formato: "numero", ayuda: "Citas creadas en el período. No cuenta las que son un reagendado: ahí el paciente movió una cita que ya tenía." },
      { clave: "whatsapp", etiqueta: "Las agendó el asistente", valor: porWhatsapp.length, formato: "numero", ayuda: "Reservas sin un usuario de la clínica detrás: las agendó el asistente por WhatsApp." },
      { clave: "panel", etiqueta: "Las cargó la clínica", valor: porPanel.length, formato: "numero", ayuda: "Reservas cargadas desde la Agenda por alguien de la clínica." },
      { clave: "pct_whatsapp", etiqueta: "Parte del asistente", valor: porcentaje(porWhatsapp.length, citas.length), formato: "porcentaje" },
      { clave: "fuera_de_horario", etiqueta: "Del asistente con la clínica cerrada", valor: fueraDeHorario, formato: "numero", ayuda: "Reservas que el asistente tomó cuando la clínica estaba cerrada (de noche, fines de semana, feriados): las que sin él esperarían al día siguiente." },
      { clave: "cancel_whatsapp", etiqueta: "Cancelación de las del asistente", valor: tasaCancel(porWhatsapp), formato: "porcentaje", ayuda: "Qué parte de las reservas del asistente terminó cancelada (sin contar reagendados)." },
      { clave: "cancel_panel", etiqueta: "Cancelación de las de la clínica", valor: tasaCancel(porPanel), formato: "porcentaje" },
    ],
    tablas: [
      { clave: "por_origen", titulo: "Reservas por origen", columnas: ["Origen", "Reservas"], filas: [["Asistente de WhatsApp", porWhatsapp.length], ["Panel (la clínica)", porPanel.length]], visual: "barras" },
      ...(porPanel.length > 0
        ? [{ clave: "por_persona", titulo: "Cargadas desde el panel, por persona", columnas: ["Persona", "Reservas"], filas: contar(porPanel, (c) => usuarios.get(c.createdByUserId as string) ?? "Usuario eliminado"), visual: "barras" as const }]
        : []),
      { clave: "por_semana", titulo: "Por semana (lunes de cada una)", columnas: ["Semana", "Asistente", "Panel", "Total"], filas: [...porSemana.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [k, v.w, v.p, v.w + v.p] as Cell[]) },
      { clave: "por_profesional", titulo: "Por profesional", columnas: ["Profesional", "Asistente", "Panel", "Total"], filas: [...porProfesional.entries()].sort((a, b) => b[1].w + b[1].p - (a[1].w + a[1].p)).map(([k, v]) => [k, v.w, v.p, v.w + v.p] as Cell[]) },
    ],
    detalle: armarDetalle(
      "Detalle de las reservas",
      ["Reservada", "Día de la cita", "Paciente", "Servicio", "Profesional", "Origen", "Cargada por", "Estado"],
      citas.map((c) => [
        cuando(c.createdAt, clinic.timezone),
        cuando(c.startTime, clinic.timezone),
        c.patient.name ?? c.patient.phone,
        c.service,
        c.professional.name,
        etiqueta(c),
        delPanel(c) ? usuarios.get(c.createdByUserId as string) ?? "Usuario eliminado" : null,
        c.status,
      ] as Cell[])
    ),
    notas: [
      "El período es el de la reserva (cuándo se creó la cita), no el de la cita. Una cita que el paciente movió por WhatsApp no cuenta como reserva nueva.",
      "Sin un usuario registrado se lee como del asistente: las reservas anteriores al 07/11/2026 (antes de que se pudiera cargar desde la Agenda) también.",
    ],
  };
}

// --- Campañas y promociones ---

const ESTADO_CAMPANA: Record<string, string> = { vigente: "Vigente", programada: "Programada", vencida: "Vencida", inactiva: "Desactivada" };

/**
 * Las campañas y cuántas personas llegaron por cada una.
 *
 * Un **contacto** es un WhatsApp que llegó por la campaña (por el anuncio de Meta o por la frase del texto
 * prellenado) en el período, contado por la fecha en que llegó. **Nuevo** es el que nunca había escrito.
 * **Agendó** es el que sacó una cita después (la marca el asistente al reservar, o el seguimiento si la
 * clínica se la cargó a mano). **En seguimiento** son los que siguen abiertos: preguntaron y todavía no
 * agendaron. **Cerrados sin respuesta** son los que agotaron los intentos del seguimiento sin contestar.
 *
 * Las campañas se listan todas (también las vigentes que todavía no tuvieron un contacto: es lo que se
 * quiere ver). El filtro por servicio deja las campañas de ese servicio; el de profesional no aplica.
 */
async function campanas(ctx: Contexto): Promise<ReportResult> {
  const { clinic, filters: f, now } = ctx;
  const hoy = clinicDateKey(now, clinic.timezone);
  const [todas, stats] = await Promise.all([
    prisma.campaign.findMany({
      where: { clinicId: clinic.id, ...(f.serviceId ? { serviceId: f.serviceId } : {}) },
      include: { service: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    }),
    campaignStats({ clinicId: clinic.id, from: f.from, toExclusive: f.toExclusive }),
  ]);

  const filas = todas.map((c) => {
    const s = stats.get(c.id);
    const contactos = s?.contacts ?? 0;
    return {
      c,
      estado: campaignStatus(c, hoy),
      contactos,
      nuevos: s?.newContacts ?? 0,
      agendaron: s?.converted ?? 0,
      abiertos: s?.open ?? 0,
      sinRespuesta: s?.closedNoReply ?? 0,
      seguimientos: s?.followUpsSent ?? 0,
      citas: s?.appointments ?? 0,
      viaAd: s?.viaAd ?? 0,
      viaText: s?.viaText ?? 0,
      viaAssistant: s?.viaAssistant ?? 0,
    };
  });
  const suma = (k: "contactos" | "nuevos" | "agendaron" | "abiertos" | "sinRespuesta" | "seguimientos" | "citas" | "viaAd" | "viaText" | "viaAssistant") =>
    filas.reduce((a, x) => a + x[k], 0);
  const contactos = suma("contactos");

  const porCanal = new Map<string, number>();
  for (const x of filas) {
    if (x.contactos === 0) continue;
    const canal = x.c.channel ?? "Sin canal";
    porCanal.set(canal, (porCanal.get(canal) ?? 0) + x.contactos);
  }

  return {
    informe: "campanas",
    titulo: "Campañas y promociones",
    periodo: { desde: f.fromKey, hasta: f.toKey, base: "evento" },
    desdeDatos: null,
    kpis: [
      { clave: "campanas_vigentes", etiqueta: "Campañas vigentes", valor: filas.filter((x) => x.estado === "vigente").length, formato: "numero", ayuda: "Activas y dentro de su fecha de inicio y fin. Hoy, no en el período." },
      { clave: "contactos", etiqueta: "Personas que llegaron por campañas", valor: contactos, formato: "numero", ayuda: "WhatsApps que escribieron por primera vez en el período a través de una campaña (anuncio de Meta o frase del mensaje)." },
      { clave: "nuevos", etiqueta: "Contactos nuevos", valor: suma("nuevos"), formato: "numero", ayuda: "Nunca habían escrito a la clínica: no eran pacientes ni habían conversado antes." },
      { clave: "agendaron", etiqueta: "Agendaron una cita", valor: suma("agendaron"), formato: "numero", ayuda: "Llegaron por la campaña y sacaron un turno." },
      { clave: "conversion", etiqueta: "Conversión", valor: porcentaje(suma("agendaron"), contactos), formato: "porcentaje", ayuda: "Los que agendaron sobre los que llegaron." },
      { clave: "en_seguimiento", etiqueta: "En seguimiento", valor: suma("abiertos"), formato: "numero", ayuda: "Preguntaron y todavía no agendaron: la clínica puede hacerles seguimiento." },
      { clave: "seguimientos", etiqueta: "Seguimientos enviados", valor: suma("seguimientos"), formato: "numero", ayuda: "Mensajes de seguimiento mandados a quienes no agendaron (con un tope de intentos por campaña)." },
      { clave: "sin_respuesta", etiqueta: "Cerrados sin respuesta", valor: suma("sinRespuesta"), formato: "numero", ayuda: "Agotaron los intentos del seguimiento y no contestaron: no se les escribe más." },
      { clave: "citas", etiqueta: "Citas de campañas", valor: suma("citas"), formato: "numero", ayuda: "Citas (no canceladas) creadas en el período por personas que llegaron por una campaña." },
    ],
    tablas: [
      { clave: "contactos_por_campana", titulo: "Contactos por campaña", columnas: ["Campaña", "Contactos"], filas: filas.filter((x) => x.contactos > 0).sort((a, b) => b.contactos - a.contactos).map((x) => [x.c.name, x.contactos] as Cell[]), visual: "barras" },
      { clave: "por_canal", titulo: "Por canal", columnas: ["Canal", "Contactos"], filas: [...porCanal.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v] as Cell[]), visual: "barras" },
      { clave: "por_formato", titulo: "Cómo llegaron", columnas: ["Formato", "Contactos"], filas: [["Anuncio de Meta", suma("viaAd")], ["Frase en el mensaje", suma("viaText")], ["Lo reconoció el asistente", suma("viaAssistant")]], visual: "barras" },
    ],
    detalle: armarDetalle(
      "Detalle por campaña",
      ["Campaña", "Estado", "Canal", "Servicio", "Contactos", "Nuevos", "Agendaron", "Conversión (%)", "En seguimiento", "Seguimientos enviados", "Cerrados sin respuesta", "Citas"],
      filas.map((x) => [
        x.c.name, ESTADO_CAMPANA[x.estado] ?? x.estado, x.c.channel, x.c.service?.name ?? null, x.contactos, x.nuevos, x.agendaron,
        porcentaje(x.agendaron, x.contactos), x.abiertos, x.seguimientos, x.sinRespuesta, x.citas,
      ] as Cell[])
    ),
    notas: [
      "Un contacto se cuenta por la fecha en que llegó, y una sola vez por campaña aunque escriba muchas veces.",
      "Se reconoce por el anuncio de Meta (Click-to-WhatsApp), por la frase que cada campaña tenga cargada o, si no coincide ninguna, porque el asistente entendió que la persona hablaba de una promoción vigente (\"Lo reconoció el asistente\": depende de lo que dijo y es menos exacto que un formato).",
      "Una campaña desactivada o vencida se sigue listando: los contactos que ya llegaron por ella se conservan.",
      ...(f.professionalId ? ["El filtro por profesional no se aplica a este reporte."] : []),
    ],
  };
}

// --- Servicios más pedidos ---

/**
 * Qué servicios se piden y cuáles no se pueden dar. Las citas se cuentan por su fecha (como el
 * resumen), sin las que el paciente movió. Se agrupa por el NOMBRE (`Appointment.service`): cuando
 * hay catálogo es exactamente el del servicio, y las citas sin match con el catálogo igual lo tienen.
 *
 * Además muestra la demanda que NO se pudo agendar: los pedidos de servicios que la clínica no
 * ofrece (`servicio_sin_match`), que es información de qué podría sumar. Solo hay los últimos 30
 * días: los eventos de monitoreo se limpian.
 */
async function servicios(ctx: Contexto): Promise<ReportResult> {
  const { clinic, filters: f } = ctx;
  const [citas, catalogo, sinMatch] = await Promise.all([
    prisma.appointment.findMany({
      where: { clinicId: clinic.id, startTime: { gte: f.from, lt: f.toExclusive }, ...scope(f), ...NO_ES_REPROGRAMACION },
      select: { service: true, status: true, startTime: true, endTime: true },
    }),
    prisma.service.findMany({ where: { clinicId: clinic.id, active: true }, select: { name: true } }),
    prisma.systemEvent.findMany({
      where: { clinicId: clinic.id, kind: "servicio_sin_match", createdAt: { gte: f.from, lt: f.toExclusive } },
      select: { message: true },
    }),
  ]);

  interface Acum { citas: number; atendidas: number; canceladas: number; minutos: number }
  const por = new Map<string, Acum>();
  for (const c of citas) {
    const a = por.get(c.service) ?? { citas: 0, atendidas: 0, canceladas: 0, minutos: 0 };
    a.citas += 1;
    if (c.status === "atendido") a.atendidas += 1;
    if (c.status === "cancelado") a.canceladas += 1;
    else a.minutos += (c.endTime.getTime() - c.startTime.getTime()) / 60_000;
    por.set(c.service, a);
  }
  const ordenados = [...por.entries()].sort((a, b) => b[1].citas - a[1].citas || a[0].localeCompare(b[0]));

  const sinCitas = catalogo.map((x) => x.name).filter((n) => !por.has(n)).sort((a, b) => a.localeCompare(b, "es"));
  // El nombre que devolvió el modelo está entre comillas en el mensaje del evento.
  const pedidos = new Map<string, number>();
  for (const e of sinMatch) {
    const nombre = /"(.+?)"/.exec(e.message)?.[1]?.trim().toLowerCase() ?? "(sin nombre)";
    pedidos.set(nombre, (pedidos.get(nombre) ?? 0) + 1);
  }
  const pedidosOrdenados = [...pedidos.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  return {
    informe: "servicios",
    titulo: "Servicios más pedidos",
    periodo: { desde: f.fromKey, hasta: f.toKey, base: "cita" },
    desdeDatos: null,
    kpis: [
      { clave: "citas", etiqueta: "Citas del período", valor: citas.length, formato: "numero" },
      { clave: "servicios_con_citas", etiqueta: "Servicios con citas", valor: por.size, formato: "numero" },
      { clave: "servicios_sin_citas", etiqueta: "Servicios del catálogo sin ninguna cita", valor: sinCitas.length, formato: "numero", ayuda: "Servicios activos que nadie agendó en el período: o no se piden, o el asistente no los está ofreciendo." },
      { clave: "pedidos_sin_agendar", etiqueta: "Pedidos que no se pudieron agendar", valor: sinMatch.length, formato: "numero", ayuda: "Veces que alguien pidió un servicio que la clínica no tiene cargado. Solo hay datos de los últimos 30 días." },
    ],
    tablas: [
      { clave: "mas_pedidos", titulo: "Servicios más pedidos", columnas: ["Servicio", "Citas"], filas: ordenados.slice(0, 10).map(([n, a]) => [n, a.citas] as Cell[]), visual: "barras" },
      ...(sinCitas.length > 0 ? [{ clave: "sin_citas", titulo: "Servicios del catálogo sin citas", columnas: ["Servicio"], filas: sinCitas.map((n) => [n] as Cell[]) }] : []),
      ...(pedidosOrdenados.length > 0
        ? [{ clave: "pedidos_sin_match", titulo: "Pedidos de servicios que la clínica no ofrece", columnas: ["Lo que pidieron", "Veces"], filas: pedidosOrdenados.map(([n, v]) => [n, v] as Cell[]) }]
        : []),
    ],
    detalle: armarDetalle(
      "Detalle por servicio",
      ["Servicio", "Citas", "Parte del total (%)", "Atendidas", "Canceladas", "Cancelación (%)", "Horas agendadas"],
      ordenados.map(([n, a]) => [n, a.citas, porcentaje(a.citas, citas.length), a.atendidas, a.canceladas, porcentaje(a.canceladas, a.citas), horas(a.minutos)] as Cell[])
    ),
    notas: [
      "Las citas se cuentan por su fecha. Las que el paciente movió a otra hora no cuentan dos veces.",
      "Las horas agendadas no incluyen las canceladas.",
      "'Pedidos que la clínica no ofrece' son los casos en que alguien pidió un servicio que no está en el catálogo; el nombre es el que interpretó el asistente. Solo hay los últimos 30 días.",
    ],
  };
}

// --- Derivaciones a una persona ---

const MOTIVO_DERIVACION: Record<string, string> = { urgencia: "Urgencia", consulta_clinica: "Consulta clínica", otro: "Otro motivo" };

/**
 * Cuántas veces el asistente pasó la conversación a una persona, por qué y cuánto tardó la
 * clínica en atenderlas. Sale de `Escalation`: la cola de trabajo de "Por atender".
 *
 * **No incluye el mensaje del paciente ni el resumen**: es texto libre que puede tener datos de
 * salud, y para verlos está "Por atender". El reporte mide el volumen y el tiempo de respuesta.
 */
async function derivaciones(ctx: Contexto): Promise<ReportResult> {
  const { clinic, filters: f, now } = ctx;
  const items = await prisma.escalation.findMany({
    where: { clinicId: clinic.id, createdAt: { gte: f.from, lt: f.toExclusive } },
    orderBy: { createdAt: "desc" },
    select: { reason: true, createdAt: true, resolvedAt: true, notifiedByEmail: true, patientName: true, patientPhone: true },
  });
  type E = (typeof items)[number];
  const pendientes = items.filter((e) => !e.resolvedAt);
  const atendidas = items.filter((e) => e.resolvedAt);
  const horasHasta = (e: E) => (e.resolvedAt ? (e.resolvedAt.getTime() - e.createdAt.getTime()) / 3_600_000 : null);
  const tiempos = atendidas.map((e) => horasHasta(e) as number);
  const media = tiempos.length > 0 ? redondear1(tiempos.reduce((s, h) => s + h, 0) / tiempos.length) : null;
  const sinAvisar = pendientes.filter((e) => !e.notifiedByEmail).length;
  const masVieja = pendientes.length > 0 ? Math.floor((now.getTime() - Math.min(...pendientes.map((e) => e.createdAt.getTime()))) / MS_DIA) : null;

  const tramo = (e: E): string => {
    const h = horasHasta(e);
    if (h === null) return "Todavía sin atender";
    return h < 1 ? "En menos de 1 hora" : h < 4 ? "Entre 1 y 4 horas" : h < 24 ? "Entre 4 y 24 horas" : "Más de 24 horas";
  };
  const ordenTramos = ["En menos de 1 hora", "Entre 1 y 4 horas", "Entre 4 y 24 horas", "Más de 24 horas", "Todavía sin atender"];
  const porDia = new Map<string, number>();
  for (const e of items) {
    const d = clinicWeekday(e.createdAt, clinic.timezone);
    porDia.set(d, (porDia.get(d) ?? 0) + 1);
  }

  return {
    informe: "derivaciones",
    titulo: "Derivaciones a una persona",
    periodo: { desde: f.fromKey, hasta: f.toKey, base: "evento" },
    desdeDatos: null,
    kpis: [
      { clave: "derivaciones", etiqueta: "Derivaciones", valor: items.length, formato: "numero", ayuda: "Veces que el asistente pasó la conversación a una persona de la clínica." },
      { clave: "pendientes", etiqueta: "Pendientes de atender", valor: pendientes.length, formato: "numero", ayuda: "Todavía nadie las marcó como atendidas en 'Por atender'." },
      { clave: "atendidas", etiqueta: "Atendidas", valor: atendidas.length, formato: "numero" },
      { clave: "horas_media", etiqueta: "Horas hasta atenderlas", valor: media, formato: "numero", ayuda: "Promedio entre que el asistente derivó y alguien la marcó como atendida (solo las ya atendidas)." },
      { clave: "mas_vieja", etiqueta: "Días de la pendiente más vieja", valor: masVieja, formato: "numero", ayuda: "Hace cuántos días espera la derivación pendiente más antigua." },
      { clave: "sin_avisar", etiqueta: "Pendientes que no llegaron a nadie", valor: sinAvisar, formato: "numero", ayuda: "Pendientes cuyo aviso por mail no salió: nadie de la clínica se enteró, hay que ir a buscarlas." },
    ],
    tablas: [
      { clave: "por_motivo", titulo: "Por motivo", columnas: ["Motivo", "Derivaciones"], filas: Object.entries(MOTIVO_DERIVACION).map(([k, v]) => [v, items.filter((e) => e.reason === k).length] as Cell[]), visual: "barras" },
      { clave: "tiempo_de_atencion", titulo: "Cuánto tardó la clínica en atenderlas", columnas: ["Tiempo", "Derivaciones"], filas: ordenTramos.map((t) => [t, items.filter((e) => tramo(e) === t).length] as Cell[]), visual: "barras" },
      { clave: "por_dia", titulo: "Por día de la semana", columnas: ["Día", "Derivaciones"], filas: ORDEN_DIAS.map((d) => [DIAS_ES[d], porDia.get(d) ?? 0] as Cell[]), visual: "barras" },
    ],
    detalle: armarDetalle(
      "Detalle de las derivaciones",
      ["Cuándo", "Paciente", "Teléfono", "Motivo", "Estado", "Horas hasta atenderla", "Aviso por mail"],
      items.map((e) => [
        cuando(e.createdAt, clinic.timezone),
        e.patientName ?? "Sin nombre",
        e.patientPhone,
        MOTIVO_DERIVACION[e.reason] ?? e.reason,
        e.resolvedAt ? "Atendida" : "Pendiente",
        horasHasta(e) === null ? null : redondear1(horasHasta(e) as number),
        e.notifiedByEmail ? "Sí" : "No",
      ] as Cell[])
    ),
    notas: [
      "No incluye el mensaje del paciente ni el resumen: pueden tener datos de salud. Se leen en 'Por atender'.",
      "El tiempo se cuenta hasta que alguien la marcó como atendida en 'Por atender'; si no se marca, figura como pendiente aunque ya se haya resuelto por otro medio.",
    ],
  };
}

// --- Motivos de cancelación ---

/**
 * Las categorías en las que se agrupan los motivos que escribe el paciente. **Es una clasificación por
 * palabras clave: aproximada.** Un texto libre no tiene una categoría única y se puede equivocar;
 * por eso el detalle muestra el texto de cada uno junto a su categoría, y lo que no encaja queda en
 * "Otro motivo" para leerlo a mano. El orden importa: la primera que coincide gana.
 */
const CATEGORIAS_MOTIVO: Array<{ categoria: string; patron: RegExp }> = [
  { categoria: "Salud", patron: /enferm|gripe|gripa|fiebre|covid|resfri|malest|salud|medic|internad|operacion|virus|cuarentena|descompu|infecc|migra/ },
  { categoria: "Trabajo", patron: /trabaj|laboral|reunion|jefe|oficina|guardia|turno de trabajo|me llamaron del trabajo/ },
  { categoria: "Viaje", patron: /viaj|vacacion|fuera de la ciudad|aeropuerto|vuelo|de paseo|no estoy en la ciudad/ },
  { categoria: "Dinero", patron: /dinero|plata|econom|precio|costo|caro|presupuesto|pagar|sin fondos/ },
  { categoria: "Familia", patron: /famil|hij[oa]|mama|papa|esposo|esposa|pareja|bebe|abuel[oa]|fallec/ },
  { categoria: "Transporte o clima", patron: /transporte|trafico|lluvia|clima|tormenta|paro|bloqueo|colectivo|\bbus\b|\bauto\b|se me descompuso el auto/ },
  { categoria: "Quiere otra fecha", patron: /reprogram|otro dia|mas adelante|otra fecha|otro horario|cambiar la cita|mover la cita|no puedo ese dia|no me queda bien/ },
  { categoria: "Cambió de idea o se atiende en otro lado", patron: /ya no (quiero|necesito|me hace falta)|cambie de (idea|opinion|planes)|decidi no|otra clinica|otro dentista|otro lugar|ya me atend|lo resolvi/ },
  { categoria: "Olvido o imprevisto", patron: /olvid|se me cruz|cruce|superpon|otro compromiso|compromiso|imprevisto|contratiempo|emergencia|urgencia/ },
];
const SIN_MOTIVO = "Sin motivo registrado";
const OTRO_MOTIVO = "Otro motivo";

/** A qué categoría pertenece un motivo, por palabras clave (sin acentos ni mayúsculas). */
export function categorizarMotivo(texto: string | null | undefined): string {
  const limpio = (texto ?? "").trim();
  if (!limpio) return SIN_MOTIVO;
  const normal = limpio.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return CATEGORIAS_MOTIVO.find((c) => c.patron.test(normal))?.categoria ?? OTRO_MOTIVO;
}

/**
 * Por qué se cancelan las citas, agrupado. Parte de las mismas canceladas que el reporte de
 * cancelaciones (reales, sin las que el paciente movió) y las agrupa por motivo.
 *
 * Una **queja** (`details.queja` del evento) va aparte de cualquier categoría: es lo que más importa
 * y no es lo mismo que "no pudo ese día". Y se informa qué parte de las cancelaciones del paciente
 * trae motivo, que mide si el asistente lo está preguntando.
 */
async function motivos(ctx: Contexto): Promise<ReportResult> {
  const { clinic, filters: f } = ctx;
  const citas = await prisma.appointment.findMany({
    where: {
      clinicId: clinic.id,
      status: "cancelado",
      OR: [{ cancelledByKind: null }, { cancelledByKind: { not: "reprogramacion" } }],
      ...(f.base === "cita" ? { startTime: { gte: f.from, lt: f.toExclusive } } : { cancelledAt: { gte: f.from, lt: f.toExclusive } }),
      ...scope(f),
    },
    orderBy: [{ cancelledAt: "desc" }, { startTime: "desc" }],
    select: { id: true, startTime: true, cancelledByKind: true, cancelReason: true, service: true },
  });
  const quejas = new Set(
    (await prisma.appointmentEvent.findMany({
      where: { appointmentId: { in: citas.map((c) => c.id) }, type: "cancelada" },
      select: { appointmentId: true, details: true },
    }))
      .filter((e) => (e.details as { queja?: boolean } | null)?.queja === true)
      .map((e) => e.appointmentId)
  );

  const categoriaDe = (c: (typeof citas)[number]) => (quejas.has(c.id) ? "Queja" : categorizarMotivo(c.cancelReason));
  const delPaciente = citas.filter((c) => c.cancelledByKind === "paciente");
  const conMotivo = citas.filter((c) => c.cancelReason?.trim());
  const conMotivoPaciente = delPaciente.filter((c) => c.cancelReason?.trim());
  const sinClasificar = citas.filter((c) => !quejas.has(c.id) && categorizarMotivo(c.cancelReason) === OTRO_MOTIVO).length;

  const orden = ["Queja", ...CATEGORIAS_MOTIVO.map((c) => c.categoria), OTRO_MOTIVO, SIN_MOTIVO];
  const porCategoria = orden.map((cat) => [cat, citas.filter((c) => categoriaDe(c) === cat).length] as [string, number]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);

  return {
    informe: "motivos",
    titulo: "Motivos de cancelación",
    periodo: { desde: f.fromKey, hasta: f.toKey, base: f.base },
    desdeDatos: await desdeDatos(clinic.id, clinic.timezone),
    kpis: [
      { clave: "canceladas", etiqueta: "Canceladas", valor: citas.length, formato: "numero", ayuda: "No incluye las citas que el paciente movió a otra hora." },
      { clave: "con_motivo", etiqueta: "Con motivo registrado", valor: conMotivo.length, formato: "numero" },
      { clave: "pct_motivo_paciente", etiqueta: "Del paciente con motivo", valor: porcentaje(conMotivoPaciente.length, delPaciente.length), formato: "porcentaje", ayuda: "De las cancelaciones que hizo el paciente, cuántas traen el motivo. Mide si el asistente lo está preguntando y si el paciente contesta." },
      { clave: "quejas", etiqueta: "Por una queja", valor: citas.filter((c) => quejas.has(c.id)).length, formato: "numero", ayuda: "El paciente canceló por una molestia con la clínica (la atención, la espera, el trato, el precio) y el caso se derivó a una persona." },
      { clave: "sin_clasificar", etiqueta: "Motivos sin clasificar", valor: sinClasificar, formato: "numero", ayuda: "Tienen motivo pero ninguna categoría coincide: están como 'Otro motivo'. Léelos en el detalle: si se repite algo, conviene sumarle una categoría." },
    ],
    tablas: [
      { clave: "por_categoria", titulo: "Por motivo", columnas: ["Motivo", "Canceladas"], filas: porCategoria, visual: "barras" },
      { clave: "por_quien", titulo: "Quién canceló", columnas: ["Quién", "Canceladas"], filas: [["El paciente", delPaciente.length], ["La clínica", citas.filter((c) => c.cancelledByKind === "clinica").length], ["Sin dato", citas.filter((c) => !c.cancelledByKind).length]], visual: "barras" },
    ],
    detalle: armarDetalle(
      "Los motivos, uno por uno",
      ["Motivo (lo que se escribió)", "Categoría", "Quién canceló", "Día de la cita", "Servicio", "Queja"],
      conMotivo.concat(citas.filter((c) => !c.cancelReason?.trim() && quejas.has(c.id))).map((c) => [
        c.cancelReason,
        categoriaDe(c),
        c.cancelledByKind ? (QUIEN_CANCELO[c.cancelledByKind] ?? c.cancelledByKind) : "Sin dato",
        cuando(c.startTime, clinic.timezone)?.slice(0, 10) ?? null,
        c.service,
        quejas.has(c.id) ? "Sí" : "No",
      ] as Cell[])
    ),
    notas: [
      "La agrupación es por palabras clave y es aproximada: un texto libre no siempre tiene una sola causa. Por eso el detalle muestra lo que se escribió junto a su categoría.",
      "'Sin motivo registrado' es lo normal en las cancelaciones anteriores al 13/11/2026 y en las que el paciente no quiso contar.",
      "El detalle no incluye el nombre del paciente: el reporte es de los motivos, no de las personas.",
    ],
  };
}

const GENERADORES: Record<ReportKind, (ctx: Contexto) => Promise<ReportResult>> = {
  resumen,
  ocupacion,
  pacientes,
  servicios,
  origen,
  campanas,
  derivaciones,
  motivos,
  cancelaciones,
  reagendadas,
  atendidos,
  "sin-confirmar": sinConfirmar,
};

export async function buildReport(params: {
  kind: ReportKind;
  clinic: { id: string; timezone: string };
  filters: ReportFilters;
  now?: Date;
}): Promise<ReportResult> {
  const ctx: Contexto = { clinic: params.clinic, filters: params.filters, now: params.now ?? new Date() };
  return GENERADORES[params.kind](ctx);
}

/** Lo que se limita para mandar por JSON: la pantalla no necesita 10.000 filas de golpe. */
export function forScreen(result: ReportResult): ReportResult {
  return {
    ...result,
    detalle: {
      ...result.detalle,
      filas: result.detalle.filas.slice(0, MAX_DETAIL_ROWS_JSON),
      truncado: result.detalle.total > MAX_DETAIL_ROWS_JSON,
    },
  };
}

/**
 * El CSV de un reporte: su detalle, o —si no tiene detalle, como el resumen— sus
 * indicadores. Abre en Excel (BOM) y neutraliza las fórmulas (`services/csv.ts`).
 */
export function reportToCsv(result: ReportResult): string {
  if (result.detalle.columnas.length > 0) {
    return toCsv(result.detalle.columnas, result.detalle.filas as CsvCell[][]);
  }
  return toCsv(
    ["Indicador", "Valor"],
    result.kpis.map((k) => [k.etiqueta, k.valor === null ? "" : k.formato === "porcentaje" ? `${k.valor}%` : k.valor])
  );
}
