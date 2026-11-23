import { prisma } from "../db/client";

/**
 * Las obras sociales / prepagas / aseguradoras con las que trabaja una
 * clínica, para que el agente pueda contestar "¿trabajan con OSDE?".
 *
 * Dos niveles, igual que los títulos de profesional:
 *
 * - **Catálogo global** (`Insurer`), del super-admin. Si cada clínica cargara
 *   el suyo, la misma "OSDE" existiría escrita de tres formas.
 * - **Lista de cada clínica** (`ClinicInsurer`), que administra la clínica:
 *   empezar o dejar de trabajar con una aseguradora es una decisión
 *   operativa suya, y cambia seguido.
 *
 * Lo que el agente dice sale de la intersección: la aseguradora tiene que
 * estar activa en el catálogo **y** activa para esa clínica.
 */

/**
 * El catálogo con dos contadores: cuántas clínicas lo tienen tomado y
 * cuántas lo tienen **activo**. Son distintos y los dos importan: el segundo
 * es el que decide si se puede desactivar, así que la pantalla tiene que
 * mirar el mismo número que el backend.
 */
export async function listInsurers() {
  const insurers = await prisma.insurer.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: { clinics: { select: { active: true } } },
  });

  return insurers.map(({ clinics, ...insurer }) => ({
    ...insurer,
    clinicas: clinics.length,
    clinicasActivas: clinics.filter((c) => c.active).length,
  }));
}

/** Para avisar "ya existe" en vez de dejar que explote el índice único. */
export function findInsurerByName(name: string) {
  return prisma.insurer.findUnique({ where: { name } });
}

export function createInsurer(params: { name: string }) {
  return prisma.insurer.create({ data: { name: params.name } });
}

/**
 * Renombrar está permitido siempre: las clínicas apuntan por id, así que el
 * cambio se propaga solo.
 *
 * Desactivar en el catálogo, en cambio, se bloquea si alguna clínica la tiene
 * activa: de un momento a otro el agente dejaría de decir que trabajan con
 * ella, sin que la clínica haya cambiado nada ni se entere. Primero la
 * clínica la da de baja de su lista.
 */
export async function updateInsurer(
  id: string,
  data: { name?: string; active?: boolean }
): Promise<
  | { ok: true }
  | { ok: false; reason: "no_encontrado" }
  | { ok: false; reason: "en_uso"; clinicas: number }
> {
  const insurer = await prisma.insurer.findUnique({ where: { id }, select: { id: true } });
  if (!insurer) return { ok: false, reason: "no_encontrado" };

  if (data.active === false) {
    const clinicas = await prisma.clinicInsurer.count({ where: { insurerId: id, active: true } });
    if (clinicas > 0) return { ok: false, reason: "en_uso", clinicas };
  }

  await prisma.insurer.update({ where: { id }, data });
  return { ok: true };
}

/**
 * El catálogo completo con el estado de esta clínica en cada fila, para la
 * pantalla: se muestran también las que no tiene tomadas, porque elegir una
 * nueva es la acción principal de esa pantalla.
 *
 * Una aseguradora inactiva en el catálogo solo aparece si esta clínica la
 * tiene; si no, desaparecería de la lista sin explicación.
 */
export async function listInsurersForClinic(clinicId: string) {
  const [catalogo, propias] = await Promise.all([
    prisma.insurer.findMany({ orderBy: { name: "asc" } }),
    prisma.clinicInsurer.findMany({ where: { clinicId }, select: { insurerId: true, active: true } }),
  ]);

  const estado = new Map(propias.map((p) => [p.insurerId, p.active]));

  return catalogo
    .filter((i) => i.active || estado.has(i.id))
    .map((i) => ({
      id: i.id,
      name: i.name,
      /** Si la aseguradora sigue vigente en el catálogo de la plataforma. */
      enCatalogo: i.active,
      /** `true` activa, `false` dada de baja, `null` nunca tomada. */
      active: estado.get(i.id) ?? null,
    }));
}

/**
 * Las que el agente puede mencionar: activas en el catálogo Y activas para
 * esta clínica. Es la única lista que ve el prompt.
 */
export async function listActiveInsurersForClinic(clinicId: string): Promise<string[]> {
  const filas = await prisma.clinicInsurer.findMany({
    where: { clinicId, active: true, insurer: { active: true } },
    orderBy: { insurer: { name: "asc" } },
    select: { insurer: { select: { name: true } } },
  });
  return filas.map((f) => f.insurer.name);
}

/**
 * Toma una aseguradora o cambia su estado en una clínica.
 *
 * De a una y no reemplazando el set completo —a diferencia de los títulos—
 * porque acá el estado no es "está o no está en la lista" sino un flag por
 * fila: mandar el set completo obligaría a distinguir "la saqué" de "la
 * desactivé", que son cosas distintas.
 */
export async function setClinicInsurer(params: {
  clinicId: string;
  insurerId: string;
  active: boolean;
}): Promise<{ ok: true } | { ok: false; reason: "aseguradora_inexistente" }> {
  const insurer = await prisma.insurer.findUnique({
    where: { id: params.insurerId },
    select: { active: true },
  });
  // Una aseguradora dada de baja del catálogo no se puede tomar de nuevo,
  // pero sí dar de baja: si no, una clínica que la tiene activa no podría
  // sacársela.
  if (!insurer || (!insurer.active && params.active)) {
    return { ok: false, reason: "aseguradora_inexistente" };
  }

  await prisma.clinicInsurer.upsert({
    where: { clinicId_insurerId: { clinicId: params.clinicId, insurerId: params.insurerId } },
    update: { active: params.active },
    create: { clinicId: params.clinicId, insurerId: params.insurerId, active: params.active },
  });
  return { ok: true };
}
