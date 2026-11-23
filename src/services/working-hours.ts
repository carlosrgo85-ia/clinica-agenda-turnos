import type { Prisma, ScheduleException, Weekday, WorkingHours } from "@prisma/client";
import { prisma } from "../db/client";
import {
  clinicDateKey,
  clinicMinutesFromMidnight,
  clinicWeekday,
  dateKeyToUtcMidnight,
  minutesToWallTime,
} from "./time";

/**
 * Horario de atención. Es lo que decide si un turno cae en un momento en
 * que la clínica está abierta Y el profesional trabaja.
 *
 * Reglas (ver también el comentario de WorkingHours en el schema):
 *
 * 1. Hay dos niveles: el de la clínica y el de cada profesional, y los DOS
 *    tienen que permitir el turno. Un profesional no puede recibir gente
 *    con la clínica cerrada, incluso si su horario propio dice que sí.
 * 2. Si un profesional no tiene NINGÚN tramo propio, hereda el de la
 *    clínica completo. La herencia es todo o nada.
 * 3. El horario de comida es el hueco entre dos tramos del mismo día. Un
 *    turno tiene que entrar completo dentro de UN tramo: si empieza antes
 *    del corte y termina después, se rechaza.
 */

type Db = Prisma.TransactionClient | typeof prisma;

/** Un tramo de atención, en minutos desde la medianoche local. */
export interface Interval {
  startMinute: number;
  endMinute: number;
}

export const MINUTES_IN_DAY = 24 * 60;

/** Los tramos de un día concreto, y si vinieron de una excepción por fecha. */
export interface DayIntervals {
  intervals: Interval[];
  /** El motivo de la excepción, si ese día tenía una (feriado, etc). */
  exceptionReason: string | null;
}

/**
 * Los tramos que aplican a un profesional en una fecha, y los de la
 * clínica.
 *
 * Se devuelven los dos por separado porque el chequeo necesita validar
 * contra ambos: la intersección es lo que habilita el turno.
 *
 * Para cada nivel, una excepción de esa fecha REEMPLAZA al horario semanal.
 * La herencia del horario semanal (un profesional sin tramos propios usa el
 * de la clínica) es independiente de las excepciones: un profesional que
 * hereda el horario puede igual tener su propia excepción para un día
 * puntual, y viceversa.
 */
export async function getEffectiveIntervals(
  params: {
    clinicId: string;
    professionalId: string;
    weekday: Weekday;
    /** Fecha local de la clínica, "YYYY-MM-DD". Sin esto no se ven las excepciones. */
    dateKey?: string;
  },
  db: Db = prisma
): Promise<{
  clinic: DayIntervals;
  professional: DayIntervals;
  heredado: boolean;
}> {
  // Se traen todos los tramos de la clínica y del profesional en una sola
  // query. Hace falta saber si el profesional tiene tramos en CUALQUIER
  // día, no solo en éste, para decidir si hereda.
  const weeklyRows = await db.workingHours.findMany({
    where: {
      clinicId: params.clinicId,
      OR: [{ professionalId: null }, { professionalId: params.professionalId }],
    },
  });

  // Sin fecha no se pueden evaluar excepciones; con la lista vacía,
  // `resolveDayIntervals` devuelve solo el semanal.
  const date = params.dateKey ? dateKeyToUtcMidnight(params.dateKey) : null;
  const exceptions = date
    ? await db.scheduleException.findMany({
        where: {
          clinicId: params.clinicId,
          date,
          OR: [{ professionalId: null }, { professionalId: params.professionalId }],
        },
      })
    : [];

  return resolveDayIntervals({
    weeklyRows,
    exceptions,
    professionalId: params.professionalId,
    weekday: params.weekday,
  });
}

/**
 * El núcleo de `getEffectiveIntervals`, sin nada de base de datos.
 *
 * Está separado para que la versión por rango de días
 * (`getEffectiveIntervalsForRange`) aplique EXACTAMENTE las mismas reglas de
 * herencia y de excepciones con una sola lectura, en vez de reimplementarlas.
 *
 * `exceptions` son las de esa única fecha, de los dos niveles. Con la lista
 * vacía el resultado es el horario semanal puro.
 */
function resolveDayIntervals(args: {
  weeklyRows: WorkingHours[];
  exceptions: ScheduleException[];
  professionalId: string;
  weekday: Weekday;
}): { clinic: DayIntervals; professional: DayIntervals; heredado: boolean } {
  const clinicWeekly = args.weeklyRows
    .filter((r) => r.professionalId === null && r.weekday === args.weekday)
    .map(toInterval);

  const tieneTramosPropios = args.weeklyRows.some(
    (r) => r.professionalId === args.professionalId
  );
  const professionalWeekly = tieneTramosPropios
    ? args.weeklyRows
        .filter((r) => r.professionalId === args.professionalId && r.weekday === args.weekday)
        .map(toInterval)
    : clinicWeekly;

  const clinicDay = applyExceptions(
    clinicWeekly,
    args.exceptions.filter((e) => e.professionalId === null)
  );

  const propias = args.exceptions.filter((e) => e.professionalId === args.professionalId);

  let professionalDay: DayIntervals;
  if (propias.length > 0) {
    // La excepción propia del profesional siempre gana para él: se tomó el
    // día, o ese día atiende en otro horario.
    professionalDay = applyExceptions(professionalWeekly, propias);
  } else if (tieneTramosPropios) {
    professionalDay = { intervals: professionalWeekly, exceptionReason: null };
  } else {
    // Hereda el horario EFECTIVO de la clínica, con sus excepciones
    // incluidas. Si heredara solo el semanal, una clínica que abre un
    // sábado por excepción no tendría a nadie para atender: el sábado no
    // existe en el horario semanal que el profesional hereda.
    professionalDay = clinicDay;
  }

  return { clinic: clinicDay, professional: professionalDay, heredado: !tieneTramosPropios };
}

/** Clave de `getEffectiveIntervalsForRange`. */
export function intervalsKey(dateKey: string, professionalId: string): string {
  return `${dateKey}::${professionalId}`;
}

/**
 * Los tramos efectivos de varios profesionales a lo largo de varios días, en
 * dos queries.
 *
 * `getEffectiveIntervals` hace dos queries por (profesional, fecha): para
 * enumerar huecos de dos semanas con cinco profesionales serían 140 idas a la
 * base trayendo una y otra vez las mismas filas. Acá se traen todas juntas y
 * se resuelve en memoria con la misma función pura, así las reglas de
 * herencia y excepciones siguen teniendo un solo dueño.
 */
export async function getEffectiveIntervalsForRange(
  params: {
    clinicId: string;
    professionalIds: string[];
    /** Los días del rango, en orden. */
    days: Array<{ dateKey: string; weekday: Weekday }>;
  },
  db: Db = prisma
): Promise<Map<string, { clinic: DayIntervals; professional: DayIntervals }>> {
  const resultado = new Map<string, { clinic: DayIntervals; professional: DayIntervals }>();
  if (params.professionalIds.length === 0 || params.days.length === 0) return resultado;

  const weeklyRows = await db.workingHours.findMany({
    where: {
      clinicId: params.clinicId,
      OR: [{ professionalId: null }, { professionalId: { in: params.professionalIds } }],
    },
  });

  const fechas = params.days
    .map((d) => dateKeyToUtcMidnight(d.dateKey))
    .filter((d): d is Date => d !== null);

  const exceptions = await db.scheduleException.findMany({
    where: {
      clinicId: params.clinicId,
      date: { in: fechas },
      OR: [{ professionalId: null }, { professionalId: { in: params.professionalIds } }],
    },
  });

  for (const day of params.days) {
    const date = dateKeyToUtcMidnight(day.dateKey);
    const delDia = date
      ? exceptions.filter((e) => e.date.getTime() === date.getTime())
      : [];

    for (const professionalId of params.professionalIds) {
      // Se le pasa solo lo de ESE profesional (más lo de nivel clínica) para
      // que la función pura vea lo mismo que vería en el camino de a uno.
      const { clinic, professional } = resolveDayIntervals({
        weeklyRows: weeklyRows.filter(
          (r) => r.professionalId === null || r.professionalId === professionalId
        ),
        exceptions: delDia.filter(
          (e) => e.professionalId === null || e.professionalId === professionalId
        ),
        professionalId,
        weekday: day.weekday,
      });
      resultado.set(intervalsKey(day.dateKey, professionalId), { clinic, professional });
    }
  }

  return resultado;
}

/**
 * Si hay excepciones para esa fecha, reemplazan al horario semanal.
 *
 * Los tramos de la excepción son las filas que traen minutos. Si hay
 * excepciones pero ninguna trae minutos, el día queda CERRADO — es el
 * feriado. La validación al cargarlas impide mezclar una fila de "cerrado"
 * con filas de tramos, así que no hay caso contradictorio.
 */
function applyExceptions(weekly: Interval[], exceptions: ScheduleException[]): DayIntervals {
  if (exceptions.length === 0) {
    return { intervals: weekly, exceptionReason: null };
  }

  const intervals = exceptions
    .filter((e) => e.startMinute !== null && e.endMinute !== null)
    .map((e) => ({ startMinute: e.startMinute as number, endMinute: e.endMinute as number }));

  return { intervals, exceptionReason: exceptions[0].reason };
}

function toInterval(row: WorkingHours): Interval {
  return { startMinute: row.startMinute, endMinute: row.endMinute };
}

/**
 * ¿El rango [start, end) entra completo dentro de alguno de los tramos?
 *
 * Tiene que caber en UNO solo. Un turno de 12:30 a 14:30, con tramos de
 * 09:00–13:00 y 14:00–18:00, no entra en ninguno: pasaría por encima del
 * horario de comida.
 */
export function fitsInSomeInterval(
  intervals: Interval[],
  startMinute: number,
  endMinute: number
): boolean {
  return intervals.some(
    (interval) => startMinute >= interval.startMinute && endMinute <= interval.endMinute
  );
}

/**
 * Los tramos en los que atienden los DOS niveles a la vez.
 *
 * `fitsInSomeInterval` alcanza para validar un turno puntual contra cada
 * nivel por separado, pero para ENUMERAR huecos hace falta la lista de los
 * ratos realmente hábiles. Las dos formas son equivalentes: si un turno entra
 * completo en un tramo de la clínica y en uno del profesional, entra en la
 * intersección de esos dos, y viceversa — siempre que dentro de cada nivel los
 * tramos no se solapen, que es lo que garantiza `validateWorkingHours()`.
 *
 * Dos tramos que apenas se tocan (13:00–14:00 y 14:00–18:00) no dejan
 * intersección: un turno no puede durar cero.
 */
export function intersectIntervals(a: Interval[], b: Interval[]): Interval[] {
  const left = [...a].sort((x, y) => x.startMinute - y.startMinute);
  const right = [...b].sort((x, y) => x.startMinute - y.startMinute);

  const result: Interval[] = [];
  let i = 0;
  let j = 0;

  while (i < left.length && j < right.length) {
    const startMinute = Math.max(left[i].startMinute, right[j].startMinute);
    const endMinute = Math.min(left[i].endMinute, right[j].endMinute);
    if (startMinute < endMinute) result.push({ startMinute, endMinute });

    // Avanza el que termina antes: el otro todavía puede cruzarse con el
    // siguiente tramo de esta lista.
    if (left[i].endMinute <= right[j].endMinute) i += 1;
    else j += 1;
  }

  return result;
}

export type WorkingHoursVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: "clinica_cerrada" | "profesional_fuera_de_horario";
      /** El motivo de la excepción, si el rechazo vino de un feriado o similar. */
      exceptionReason?: string;
    };

/** El rango del turno expresado en el día y los minutos locales de la clínica. */
function toLocalWindow(
  start: Date,
  end: Date,
  timeZone: string
): { weekday: Weekday; dateKey: string; startMinute: number; endMinute: number } {
  const weekday = clinicWeekday(start, timeZone) as Weekday;
  const startMinute = clinicMinutesFromMidnight(start, timeZone);
  const durationMinutes = Math.round((end.getTime() - start.getTime()) / 60_000);
  return {
    weekday,
    dateKey: clinicDateKey(start, timeZone),
    startMinute,
    endMinute: startMinute + durationMinutes,
  };
}

/**
 * ¿La clínica está abierta en ese rango?
 *
 * Se chequea aparte del profesional y ANTES que él, por dos razones: no
 * depende de quién atienda, y el motivo es mucho más útil. Si se resolviera
 * primero el profesional, una clínica cerrada devolvería
 * "ningún profesional disponible" — engañoso para explicarle al paciente
 * que ese día no se atiende.
 */
export async function checkClinicHours(
  params: {
    clinicId: string;
    clinicTimezone: string;
    start: Date;
    end: Date;
  },
  db: Db = prisma
): Promise<WorkingHoursVerdict> {
  const { weekday, dateKey, startMinute, endMinute } = toLocalWindow(
    params.start,
    params.end,
    params.clinicTimezone
  );

  if (endMinute > MINUTES_IN_DAY) {
    return { ok: false, reason: "clinica_cerrada" };
  }

  // Una excepción de esa fecha (feriado, jornada especial) reemplaza al
  // horario semanal de la clínica.
  const date = dateKeyToUtcMidnight(dateKey);
  const exceptions = date
    ? await db.scheduleException.findMany({
        where: { clinicId: params.clinicId, professionalId: null, date },
      })
    : [];

  const weekly = await db.workingHours.findMany({
    where: { clinicId: params.clinicId, professionalId: null, weekday },
  });

  const day = applyExceptions(weekly.map(toInterval), exceptions);

  if (!fitsInSomeInterval(day.intervals, startMinute, endMinute)) {
    return {
      ok: false,
      reason: "clinica_cerrada",
      ...(day.exceptionReason ? { exceptionReason: day.exceptionReason } : {}),
    };
  }
  return { ok: true };
}

/**
 * Valida un turno concreto contra el horario de la clínica y el del
 * profesional.
 *
 * El día de la semana y los minutos se calculan en la zona de la clínica,
 * no en la del servidor: un turno a las 02:00 UTC del martes es lunes por
 * la noche para una clínica en UTC-6.
 */
export async function checkWorkingHours(
  params: {
    clinicId: string;
    clinicTimezone: string;
    professionalId: string;
    start: Date;
    end: Date;
  },
  db: Db = prisma
): Promise<WorkingHoursVerdict> {
  const { weekday, dateKey, startMinute, endMinute } = toLocalWindow(
    params.start,
    params.end,
    params.clinicTimezone
  );

  // Un turno que cruza la medianoche no puede entrar en ningún tramo (los
  // tramos son de un día). Se rechaza como "cerrada" en vez de intentar
  // partirlo.
  if (endMinute > MINUTES_IN_DAY) {
    return { ok: false, reason: "clinica_cerrada" };
  }

  const { clinic, professional } = await getEffectiveIntervals(
    {
      clinicId: params.clinicId,
      professionalId: params.professionalId,
      weekday,
      dateKey,
    },
    db
  );

  if (!fitsInSomeInterval(clinic.intervals, startMinute, endMinute)) {
    return {
      ok: false,
      reason: "clinica_cerrada",
      ...(clinic.exceptionReason ? { exceptionReason: clinic.exceptionReason } : {}),
    };
  }

  if (!fitsInSomeInterval(professional.intervals, startMinute, endMinute)) {
    return {
      ok: false,
      reason: "profesional_fuera_de_horario",
      ...(professional.exceptionReason
        ? { exceptionReason: professional.exceptionReason }
        : {}),
    };
  }

  return { ok: true };
}

/**
 * ¿La clínica tiene horario estructurado cargado?
 *
 * Sin ningún tramo la clínica no puede agendar: `booking.ts` rechaza con
 * `clinica_sin_horario` y el enumerador de huecos no ofrece nada. Antes esto
 * decidía si se saltaba el chequeo de horario (compatibilidad con las clínicas
 * anteriores a `WorkingHours`); ya no.
 */
export async function hasStructuredHours(clinicId: string, db: Db = prisma): Promise<boolean> {
  const count = await db.workingHours.count({
    where: { clinicId, professionalId: null },
  });
  return count > 0;
}

// --- Validación de lo que se carga desde la interfaz ---

export interface WorkingHoursInput {
  weekday: Weekday;
  startMinute: number;
  endMinute: number;
}

/**
 * Valida un set completo de tramos antes de guardarlo. Devuelve la lista de
 * problemas; vacía si está todo bien.
 *
 * Se valida el set entero y no fila por fila porque el solapamiento solo se
 * puede ver comparando entre sí: dos tramos válidos por separado pueden
 * pisarse.
 */
export function validateWorkingHours(intervals: WorkingHoursInput[]): string[] {
  const errores: string[] = [];

  for (const interval of intervals) {
    const tramo = `${interval.weekday} ${minutesToWallTime(interval.startMinute)}-${minutesToWallTime(interval.endMinute)}`;

    if (!Number.isInteger(interval.startMinute) || !Number.isInteger(interval.endMinute)) {
      errores.push(`${tramo}: los minutos tienen que ser enteros.`);
      continue;
    }
    if (interval.startMinute < 0 || interval.endMinute > MINUTES_IN_DAY) {
      errores.push(`${tramo}: fuera del rango de un día (0 a ${MINUTES_IN_DAY}).`);
    }
    if (interval.startMinute >= interval.endMinute) {
      errores.push(`${tramo}: el fin tiene que ser posterior al inicio.`);
    }
  }

  // Solapamientos dentro del mismo día.
  const porDia = new Map<Weekday, WorkingHoursInput[]>();
  for (const interval of intervals) {
    const delDia = porDia.get(interval.weekday) ?? [];
    delDia.push(interval);
    porDia.set(interval.weekday, delDia);
  }

  for (const [weekday, delDia] of porDia) {
    const ordenados = [...delDia].sort((a, b) => a.startMinute - b.startMinute);
    for (let i = 1; i < ordenados.length; i++) {
      if (ordenados[i].startMinute < ordenados[i - 1].endMinute) {
        errores.push(
          `${weekday}: los tramos ${minutesToWallTime(ordenados[i - 1].startMinute)}-${minutesToWallTime(ordenados[i - 1].endMinute)} y ${minutesToWallTime(ordenados[i].startMinute)}-${minutesToWallTime(ordenados[i].endMinute)} se solapan.`
        );
      }
    }
  }

  return errores;
}

/**
 * Reemplaza el set de tramos de una clínica o de un profesional.
 *
 * Se reemplaza todo en vez de editar fila por fila porque el set es la
 * unidad con sentido: "el horario de los lunes" son sus tramos juntos, y
 * validar solapamientos requiere verlos todos.
 *
 * Pasar una lista vacía para un profesional lo devuelve a heredar el
 * horario de la clínica.
 */
export async function replaceWorkingHours(params: {
  clinicId: string;
  /** null = el horario de la clínica. */
  professionalId: string | null;
  intervals: WorkingHoursInput[];
}): Promise<WorkingHours[]> {
  const errores = validateWorkingHours(params.intervals);
  if (errores.length > 0) {
    throw new WorkingHoursValidationError(errores);
  }

  return prisma.$transaction(async (tx) => {
    await tx.workingHours.deleteMany({
      where: { clinicId: params.clinicId, professionalId: params.professionalId },
    });

    if (params.intervals.length === 0) return [];

    await tx.workingHours.createMany({
      data: params.intervals.map((interval) => ({
        clinicId: params.clinicId,
        professionalId: params.professionalId,
        weekday: interval.weekday,
        startMinute: interval.startMinute,
        endMinute: interval.endMinute,
      })),
    });

    return tx.workingHours.findMany({
      where: { clinicId: params.clinicId, professionalId: params.professionalId },
      orderBy: [{ weekday: "asc" }, { startMinute: "asc" }],
    });
  });
}

export class WorkingHoursValidationError extends Error {
  constructor(public readonly errores: string[]) {
    super(errores.join(" "));
    this.name = "WorkingHoursValidationError";
  }
}

// --- Excepciones por fecha (feriados, jornadas especiales) ---

export interface ScheduleExceptionInput {
  /** Fecha local de la clínica, "YYYY-MM-DD". */
  dateKey: string;
  reason: string;
  /** null = toda la clínica. */
  professionalId?: string | null;
  /**
   * Vacío = cerrado todo el día (el feriado). Con tramos = ese es el
   * horario de ese día, reemplazando el semanal (media jornada).
   */
  tramos?: Array<{ startMinute: number; endMinute: number }>;
}

/**
 * Carga una excepción de fecha, reemplazando la que hubiera para esa misma
 * fecha y ese mismo nivel.
 *
 * Se reemplaza en vez de acumular porque dos excepciones para el mismo día
 * no tienen un significado claro: si una dice "cerrado" y otra dice "de 9 a
 * 12", ¿cuál gana? Cargar la fecha de nuevo sobrescribe, y así el estado
 * siempre es explícito.
 */
export async function upsertScheduleException(params: {
  clinicId: string;
  input: ScheduleExceptionInput;
}): Promise<ScheduleException[]> {
  const { clinicId, input } = params;

  const date = dateKeyToUtcMidnight(input.dateKey);
  if (!date) {
    throw new WorkingHoursValidationError([
      `Fecha inválida: "${input.dateKey}". El formato es YYYY-MM-DD.`,
    ]);
  }
  if (!input.reason?.trim()) {
    throw new WorkingHoursValidationError([
      "Hace falta un motivo (ej. \"Feriado nacional\", \"Jornada de capacitación\").",
    ]);
  }

  const tramos = input.tramos ?? [];
  if (tramos.length > 0) {
    // Se reutiliza la validación del horario semanal metiendo todos los
    // tramos en un mismo día ficticio: los chequeos son los mismos
    // (rangos válidos, sin solapamientos).
    const errores = validateWorkingHours(
      tramos.map((t) => ({ weekday: "lunes" as Weekday, ...t }))
    );
    if (errores.length > 0) {
      throw new WorkingHoursValidationError(errores);
    }
  }

  const professionalId = input.professionalId ?? null;

  return prisma.$transaction(async (tx) => {
    await tx.scheduleException.deleteMany({ where: { clinicId, professionalId, date } });

    if (tramos.length === 0) {
      // Cerrado todo el día: una sola fila sin minutos.
      await tx.scheduleException.create({
        data: {
          clinicId,
          professionalId,
          date,
          reason: input.reason.trim(),
          startMinute: null,
          endMinute: null,
        },
      });
    } else {
      await tx.scheduleException.createMany({
        data: tramos.map((tramo) => ({
          clinicId,
          professionalId,
          date,
          reason: input.reason.trim(),
          startMinute: tramo.startMinute,
          endMinute: tramo.endMinute,
        })),
      });
    }

    return tx.scheduleException.findMany({
      where: { clinicId, professionalId, date },
      orderBy: { startMinute: "asc" },
    });
  });
}

/** Borra la excepción de una fecha y un nivel, volviendo al horario semanal. */
export async function deleteScheduleException(params: {
  clinicId: string;
  dateKey: string;
  professionalId?: string | null;
}): Promise<number> {
  const date = dateKeyToUtcMidnight(params.dateKey);
  if (!date) {
    throw new WorkingHoursValidationError([`Fecha inválida: "${params.dateKey}".`]);
  }

  const { count } = await prisma.scheduleException.deleteMany({
    where: {
      clinicId: params.clinicId,
      professionalId: params.professionalId ?? null,
      date,
    },
  });
  return count;
}

/**
 * Las excepciones de una clínica en un rango de fechas, agrupadas por fecha
 * y nivel. Es lo que muestra la pantalla de configuración.
 */
export async function listScheduleExceptions(params: {
  clinicId: string;
  desde?: string;
  hasta?: string;
}): Promise<
  Array<{
    dateKey: string;
    professionalId: string | null;
    reason: string;
    cerradoTodoElDia: boolean;
    tramos: Interval[];
  }>
> {
  const desde = params.desde ? dateKeyToUtcMidnight(params.desde) : null;
  const hasta = params.hasta ? dateKeyToUtcMidnight(params.hasta) : null;

  const rows = await prisma.scheduleException.findMany({
    where: {
      clinicId: params.clinicId,
      ...(desde || hasta
        ? { date: { ...(desde ? { gte: desde } : {}), ...(hasta ? { lte: hasta } : {}) } }
        : {}),
    },
    orderBy: [{ date: "asc" }, { startMinute: "asc" }],
  });

  // Se agrupa por fecha + nivel, que es la unidad con la que se cargan.
  const grupos = new Map<string, ScheduleException[]>();
  for (const row of rows) {
    const key = `${row.date.toISOString().slice(0, 10)}::${row.professionalId ?? "clinica"}`;
    const grupo = grupos.get(key) ?? [];
    grupo.push(row);
    grupos.set(key, grupo);
  }

  return [...grupos.values()].map((grupo) => {
    const tramos = grupo
      .filter((r) => r.startMinute !== null && r.endMinute !== null)
      .map((r) => ({ startMinute: r.startMinute as number, endMinute: r.endMinute as number }));

    return {
      dateKey: grupo[0].date.toISOString().slice(0, 10),
      professionalId: grupo[0].professionalId,
      reason: grupo[0].reason,
      cerradoTodoElDia: tramos.length === 0,
      tramos,
    };
  });
}

/**
 * Texto legible de un set de tramos, para reportes, para la interfaz y para
 * el system prompt.
 *
 * Es lo que el bot le cuenta al paciente, y sale del MISMO dato que se
 * valida al agendar. Antes el prompt leía un campo de texto libre
 * (`Clinic.businessHours`) que podía decir cualquier otra cosa: en la
 * clínica piloto el texto anunciaba comida de 15:00 a 16:00 mientras el
 * horario real la tenía de 13:00 a 14:00, así que el bot agendaba a las
 * 15:00 —correctamente, según el dato— y después le daba la razón al
 * paciente cuando protestaba. Ese campo ya no existe.
 */
export function describeWorkingHours(rows: WorkingHours[]): string {
  const orden: Weekday[] = [
    "lunes",
    "martes",
    "miercoles",
    "jueves",
    "viernes",
    "sabado",
    "domingo",
  ];

  return orden
    .map((weekday) => {
      const tramos = rows
        .filter((r) => r.weekday === weekday)
        .sort((a, b) => a.startMinute - b.startMinute)
        .map((r) => `${minutesToWallTime(r.startMinute)} a ${minutesToWallTime(r.endMinute)}`);
      if (tramos.length === 0) return null;
      return `${weekday}: ${tramos.join(" y ")}`;
    })
    .filter(Boolean)
    .join("; ");
}
