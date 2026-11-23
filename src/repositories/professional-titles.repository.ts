import { prisma } from "../db/client";

/**
 * El catálogo de títulos de profesional ("Dr.", "Lic.", "Manicurista").
 *
 * Es **global de la plataforma**: lo carga el super-admin una vez y después
 * habilita, clínica por clínica, con cuáles trabaja cada una. Ver el
 * comentario de `ProfessionalTitle` en el schema.
 *
 * Dos reglas de baja, y las dos devuelven un motivo en vez de tirar una
 * excepción, para que la interfaz pueda explicar por qué no se pudo:
 *
 * - **Desactivar** un título que algún profesional tenga puesto: no se
 *   permite. Un título inactivo no se ofrece en ningún selector, así que la
 *   ficha que ya lo tiene quedaría mostrando algo que no se puede volver a
 *   elegir ni corregir desde el desplegable.
 * - **Deshabilitarlo de una clínica** cuyos profesionales lo usan: tampoco.
 *   Es la misma situación, acotada a esa clínica.
 *
 * En los dos casos el camino es primero cambiarle el título a esos
 * profesionales, y después dar de baja el título.
 */

/** Un título que ya no se puede tocar, y por qué. */
export type TitleBlocked =
  | { ok: false; reason: "no_encontrado" }
  | { ok: false; reason: "en_uso"; profesionales: number };

export function listTitles() {
  return prisma.professionalTitle.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: { _count: { select: { professionals: true, clinics: true } } },
  });
}

export function createTitle(params: { name: string }) {
  return prisma.professionalTitle.create({ data: { name: params.name } });
}

/** Para avisar "ya existe" en vez de dejar que explote el índice único. */
export function findTitleByName(name: string) {
  return prisma.professionalTitle.findUnique({ where: { name } });
}

/**
 * Renombrar está permitido incluso con el título en uso: la ficha apunta por
 * id, así que el cambio se propaga solo y no hay nada que pueda quedar
 * inconsistente. Desactivar, en cambio, se bloquea si alguien lo tiene.
 */
export async function updateTitle(
  id: string,
  data: { name?: string; active?: boolean }
): Promise<{ ok: true } | TitleBlocked> {
  const title = await prisma.professionalTitle.findUnique({
    where: { id },
    include: { _count: { select: { professionals: true } } },
  });
  if (!title) return { ok: false, reason: "no_encontrado" };

  if (data.active === false && title._count.professionals > 0) {
    return { ok: false, reason: "en_uso", profesionales: title._count.professionals };
  }

  await prisma.professionalTitle.update({ where: { id }, data });
  return { ok: true };
}

/** Los ids habilitados para una clínica, para la pantalla que los asigna. */
export async function listClinicTitleIds(clinicId: string): Promise<string[]> {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { professionalTitles: { select: { id: true } } },
  });
  return clinic?.professionalTitles.map((t) => t.id) ?? [];
}

/**
 * Los que puede elegir esta clínica al cargar un profesional: habilitados
 * **y** activos. Es la lista que ofrece el selector, y la misma contra la que
 * el backend valida el `titleId` que llega — si fueran dos listas distintas,
 * el selector ofrecería algo que después se rechaza.
 */
export function listTitlesForClinic(clinicId: string) {
  return prisma.professionalTitle.findMany({
    where: { active: true, clinics: { some: { id: clinicId } } },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}

/**
 * Reemplaza el set de títulos habilitados de una clínica.
 *
 * Se manda el set completo y no de a uno, por el mismo motivo que los tramos
 * de `WorkingHours`: para saber qué se está quitando hay que ver la lista
 * entera.
 */
export async function setClinicTitles(
  clinicId: string,
  titleIds: string[]
): Promise<
  | { ok: true }
  | { ok: false; reason: "no_encontrado" }
  | { ok: false; reason: "titulo_inexistente" }
  | { ok: false; reason: "en_uso"; enUso: Array<{ name: string; profesionales: number }> }
> {
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { id: true } });
  if (!clinic) return { ok: false, reason: "no_encontrado" };

  const pedidos = [...new Set(titleIds)];
  const existentes = await prisma.professionalTitle.findMany({
    where: { id: { in: pedidos } },
    select: { id: true },
  });
  if (existentes.length !== pedidos.length) return { ok: false, reason: "titulo_inexistente" };

  // Los títulos que esta clínica está usando y que quedarían fuera del set
  // nuevo. Se agrupa por título para poder decir cuál y cuántos.
  const enUso = await prisma.professionalTitle.findMany({
    where: {
      id: { notIn: pedidos.length > 0 ? pedidos : ["__ninguno__"] },
      professionals: { some: { clinicId } },
    },
    select: {
      name: true,
      _count: { select: { professionals: { where: { clinicId } } } },
    },
  });
  if (enUso.length > 0) {
    return {
      ok: false,
      reason: "en_uso",
      enUso: enUso.map((t) => ({ name: t.name, profesionales: t._count.professionals })),
    };
  }

  await prisma.clinic.update({
    where: { id: clinicId },
    data: { professionalTitles: { set: pedidos.map((id) => ({ id })) } },
  });
  return { ok: true };
}
