import type { HolidayRule } from "@prisma/client";
import { prisma } from "../db/client";
import { isSupportedCountry, listHolidayRules } from "../repositories/countries.repository";
import { dateKeyToUtcMidnight } from "./time";
import { upsertScheduleException } from "./working-hours";

/**
 * Feriados nacionales: se calculan a partir del catálogo y se le SUGIEREN a
 * la clínica, que confirma cuáles carga.
 *
 * No se cargan solos a propósito. Hay clínicas que atienden algunos
 * feriados, y cerrar un día sin que lo confirmen les haría perder turnos
 * reales. El objetivo del catálogo es que no se olviden, no decidir por
 * ellas.
 */

export interface Holiday {
  /** "YYYY-MM-DD" */
  dateKey: string;
  name: string;
}

/**
 * Domingo de Pascua de un año, en el calendario gregoriano.
 *
 * Es el "algoritmo anónimo gregoriano" (Meeus/Jones/Butcher). Hace falta
 * porque varios feriados se definen relativos a la Pascua (Viernes Santo,
 * Carnaval) y su fecha se mueve todos los años.
 */
export function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/**
 * El enésimo día de la semana de un mes (ej. el tercer lunes de marzo).
 *
 * `ordinal: -1` es **el último** de ese mes. Hace falta porque hay feriados
 * definidos así y no como un ordinal fijo — el Memorial Day de Estados
 * Unidos es el último lunes de mayo, que según el año es el cuarto o el
 * quinto. Sin esto, la única forma de cargarlo era una fecha fija, que estaría
 * mal en la mitad de los años.
 */
function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
  ordinal: number
): number | null {
  // Se trabaja en UTC para que no intervenga la zona del servidor.
  const primero = new Date(Date.UTC(year, month - 1, 1));
  const diaDeLaSemanaDelPrimero = primero.getUTCDay();

  // Cuántos días hay que avanzar desde el día 1 para llegar al primer
  // `weekday` del mes.
  const offset = (weekday - diaDeLaSemanaDelPrimero + 7) % 7;

  if (ordinal === -1) {
    // Se cuenta hacia atrás desde el último día del mes: el día 0 del mes
    // siguiente es el último del actual.
    const ultimoDelMes = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const primerDia = 1 + offset;
    // Cuántas semanas completas caben desde el primero de esos días.
    const semanas = Math.floor((ultimoDelMes - primerDia) / 7);
    return primerDia + semanas * 7;
  }

  if (ordinal < 1) return null;

  const day = 1 + offset + (ordinal - 1) * 7;

  // Se verifica que siga dentro del mes: no todos los meses tienen un
  // quinto lunes.
  const resultado = new Date(Date.UTC(year, month - 1, day));
  if (resultado.getUTCMonth() !== month - 1) return null;

  return day;
}

function toDateKey(year: number, month: number, day: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Resuelve una regla del catálogo a una fecha concreta de un año.
 *
 * Las filas de `HolidayRule` tienen todos los campos opcionales (uno solo
 * modelo para los tres `kind`, ver el schema) — si a la regla le falta el
 * campo que su `kind` necesita, se descarta en vez de reventar: pudo
 * quedar mal cargada desde la pantalla de países, y sugerir de menos es
 * preferible a una fecha inventada.
 */
function resolveRule(rule: HolidayRule, year: number): Holiday | null {
  switch (rule.kind) {
    case "fixed":
      if (rule.month == null || rule.day == null) return null;
      return { dateKey: toDateKey(year, rule.month, rule.day), name: rule.name };

    case "nthWeekday": {
      if (rule.month == null || rule.weekday == null || rule.ordinal == null) return null;
      const day = nthWeekdayOfMonth(year, rule.month, rule.weekday, rule.ordinal);
      return day === null ? null : { dateKey: toDateKey(year, rule.month, day), name: rule.name };
    }

    case "easter": {
      if (rule.offsetDays == null) return null;
      const { month, day } = easterSunday(year);
      // Se suma el offset sobre la fecha en UTC, así el cruce de mes o de
      // año lo resuelve Date.
      const fecha = new Date(Date.UTC(year, month - 1, day + rule.offsetDays));
      return {
        dateKey: toDateKey(
          fecha.getUTCFullYear(),
          fecha.getUTCMonth() + 1,
          fecha.getUTCDate()
        ),
        name: rule.name,
      };
    }
  }
}

/** Los feriados nacionales de un país en un año, ordenados por fecha. */
export async function holidaysForCountry(country: string, year: number): Promise<Holiday[]> {
  const rules = await listHolidayRules(country);

  return rules
    .map((rule) => resolveRule(rule, year))
    .filter((h): h is Holiday => h !== null)
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}

export interface HolidaySuggestion extends Holiday {
  /** Si la clínica ya tiene una excepción cargada para esa fecha. */
  yaCargado: boolean;
}

/**
 * Los feriados del año para una clínica, marcando cuáles ya tiene cargados.
 *
 * Se marcan en vez de filtrarse para que la interfaz pueda mostrar el
 * calendario completo con los tildes puestos, en lugar de una lista que se
 * va vaciando sin dejar ver qué se hizo.
 */
export async function holidaySuggestionsForClinic(params: {
  clinicId: string;
  year: number;
}): Promise<{ country: string | null; sugerencias: HolidaySuggestion[] }> {
  const clinic = await prisma.clinic.findUnique({
    where: { id: params.clinicId },
    select: { country: true },
  });
  if (!clinic?.country || !(await isSupportedCountry(clinic.country))) {
    return { country: clinic?.country ?? null, sugerencias: [] };
  }

  const feriados = await holidaysForCountry(clinic.country, params.year);
  if (feriados.length === 0) return { country: clinic.country, sugerencias: [] };

  const desde = dateKeyToUtcMidnight(`${params.year}-01-01`);
  const hasta = dateKeyToUtcMidnight(`${params.year}-12-31`);

  const existentes = await prisma.scheduleException.findMany({
    where: {
      clinicId: params.clinicId,
      // Solo las de la clínica entera: la excepción de un profesional no
      // significa que el feriado esté cargado.
      professionalId: null,
      ...(desde && hasta ? { date: { gte: desde, lte: hasta } } : {}),
    },
    select: { date: true },
  });

  const cargadas = new Set(existentes.map((e) => e.date.toISOString().slice(0, 10)));

  return {
    country: clinic.country,
    sugerencias: feriados.map((feriado) => ({
      ...feriado,
      yaCargado: cargadas.has(feriado.dateKey),
    })),
  };
}

/** Cuántos feriados del año le faltan cargar a una clínica. */
export async function countPendingHolidays(params: {
  clinicId: string;
  year: number;
}): Promise<number> {
  const { sugerencias } = await holidaySuggestionsForClinic(params);
  return sugerencias.filter((s) => !s.yaCargado).length;
}

/**
 * A partir de qué mes se empieza a pedir el calendario del año siguiente.
 * 12 = diciembre.
 */
const MES_DE_PRECARGA = 12;

/**
 * Los años cuyos feriados hay que tener cargados ahora.
 *
 * Desde diciembre se suma el año siguiente, para que el calendario esté
 * confirmado antes del 1 de enero. Si no, el 2 de enero la clínica tiene
 * feriados sin cargar y el asistente ofrece turnos el Año Nuevo.
 *
 * Se suma a las sugerencias y a los avisos, NO se carga solo: la clínica
 * sigue confirmando cuáles no atiende (ver `applyHolidays`).
 */
export function relevantHolidayYears(now = new Date()): number[] {
  const year = now.getUTCFullYear();
  return now.getUTCMonth() + 1 >= MES_DE_PRECARGA ? [year, year + 1] : [year];
}

/**
 * Feriados pendientes por año, para los años que hoy importan. Solo se
 * devuelven los años que tienen algo pendiente.
 */
export async function pendingHolidaysByYear(params: {
  clinicId: string;
  now?: Date;
}): Promise<Array<{ year: number; pendientes: number }>> {
  const resultado = [];
  for (const year of relevantHolidayYears(params.now)) {
    const pendientes = await countPendingHolidays({ clinicId: params.clinicId, year });
    if (pendientes > 0) resultado.push({ year, pendientes });
  }
  return resultado;
}

/**
 * Carga como días cerrados las fechas que la clínica confirmó.
 *
 * Si no se pasan fechas, se cargan TODOS los feriados del año que falten —
 * el caso "confirmo el calendario completo". Las que ya estaban cargadas no
 * se tocan, para no sobrescribir un horario especial que la clínica haya
 * definido a mano para un feriado (ej. atiende media jornada el 24).
 */
export async function applyHolidays(params: {
  clinicId: string;
  year: number;
  /** Fechas "YYYY-MM-DD" a cargar. Si se omite, todas las que falten. */
  dateKeys?: string[];
}): Promise<{ cargados: Holiday[]; omitidos: string[] }> {
  const { sugerencias } = await holidaySuggestionsForClinic({
    clinicId: params.clinicId,
    year: params.year,
  });

  const pedidas = params.dateKeys ? new Set(params.dateKeys) : null;

  const aCargar = sugerencias.filter((s) => {
    if (s.yaCargado) return false;
    return pedidas === null || pedidas.has(s.dateKey);
  });

  // Fechas que se pidieron pero no son feriados del catálogo, o ya estaban.
  const omitidos = pedidas
    ? [...pedidas].filter((dateKey) => !aCargar.some((s) => s.dateKey === dateKey))
    : [];

  for (const feriado of aCargar) {
    await upsertScheduleException({
      clinicId: params.clinicId,
      // Sin tramos = cerrado todo el día.
      input: { dateKey: feriado.dateKey, reason: feriado.name },
    });
  }

  return { cargados: aCargar.map(({ dateKey, name }) => ({ dateKey, name })), omitidos };
}
