import { prisma } from "../db/client";

/**
 * Catálogo formal de servicios de una clínica.
 *
 * Todas las funciones reciben el `clinicId` y lo meten en el `where`, incluso
 * cuando el id del servicio ya sería único: es lo que impide que un usuario de
 * una clínica toque el catálogo de otra si le pasan un id ajeno.
 */

export function listServices(clinicId: string) {
  return prisma.service.findMany({
    where: { clinicId },
    orderBy: { name: "asc" },
    include: {
      _count: { select: { appointments: true } },
      professionals: { select: { id: true, name: true, active: true } },
    },
  });
}

export function createService(
  clinicId: string,
  params: {
    name: string;
    durationMinutes: number;
    requiredResourceType?: string | null;
    active?: boolean;
    priceNote?: string | null;
  }
) {
  return prisma.service.create({
    data: {
      clinicId,
      name: params.name,
      durationMinutes: params.durationMinutes,
      requiredResourceType: params.requiredResourceType ?? null,
      active: params.active ?? true,
      priceNote: params.priceNote ?? null,
    },
  });
}

/** `updateMany` y no `update` para poder devolver 404 sin capturar excepciones. */
export async function updateService(
  id: string,
  clinicId: string,
  data: {
    name?: string;
    durationMinutes?: number;
    requiredResourceType?: string | null;
    active?: boolean;
    priceNote?: string | null;
  }
): Promise<boolean> {
  const { count } = await prisma.service.updateMany({ where: { id, clinicId }, data });
  return count > 0;
}

/**
 * No borra un servicio que ya tenga turnos: esos turnos lo referencian y
 * perderían el dato. Para sacarlo de circulación está `active: false`, que es
 * lo que filtra `findServiceInCatalog()`. Devuelve el motivo para que la
 * interfaz lo explique en vez de un error genérico.
 */
export async function deleteService(
  id: string,
  clinicId: string
): Promise<{ ok: true } | { ok: false; reason: "no_encontrado" | "tiene_turnos" }> {
  const service = await prisma.service.findFirst({
    where: { id, clinicId },
    include: { _count: { select: { appointments: true } } },
  });
  if (!service) return { ok: false, reason: "no_encontrado" };
  if (service._count.appointments > 0) return { ok: false, reason: "tiene_turnos" };

  await prisma.service.delete({ where: { id } });
  return { ok: true };
}

/**
 * Los tipos de equipo que la clínica realmente tiene.
 *
 * Es lo que alimenta el selector de "equipo requerido". Sin esta lista alguien
 * podría escribir un tipo que no existe, y entonces ese servicio no tendría
 * NUNCA un hueco disponible ni se podría agendar — `findAvailableResource()`
 * devolvería null siempre, sin ningún error visible.
 */
export async function listResourceTypes(clinicId: string): Promise<string[]> {
  const rows = await prisma.resource.groupBy({
    by: ["type"],
    where: { clinicId, active: true },
    orderBy: { type: "asc" },
  });
  return rows.map((r) => r.type);
}
