import { prisma } from "../db/client";

/**
 * Qué servicio realiza cada profesional (la relación N-N `ProfessionalServices`).
 *
 * La regla que ordena este archivo: **un profesional sin ningún servicio "no
 * hace nada"** — no se ofrece ni se le asigna. Por eso no se lo deja dar de alta,
 * activar ni dejar sin servicios cuando la clínica tiene catálogo; el control
 * está acá y no en la ruta para que el próximo endpoint no se lo salte.
 *
 * Sin catálogo (clínicas que todavía usan `Clinic.services` en texto libre) la
 * regla no aplica: no hay servicios que asignar, y `resolveServiceForRequest()`
 * tampoco restringe nada.
 */

/** ¿La clínica tiene servicios activos cargados? Es lo que activa la regla. */
export async function clinicHasCatalog(clinicId: string): Promise<boolean> {
  return (await prisma.service.count({ where: { clinicId, active: true } })) > 0;
}

/**
 * Los ids que llegaron, validados contra la clínica. Devuelve null si alguno no
 * es de ella: un id ajeno asignado a un profesional no daría ningún error
 * visible, pero esa clínica ofrecería un servicio que no es suyo.
 */
export async function validServiceIds(
  clinicId: string,
  ids: string[]
): Promise<string[] | null> {
  const unicos = [...new Set(ids)];
  if (unicos.length === 0) return [];
  const encontrados = await prisma.service.count({ where: { clinicId, id: { in: unicos } } });
  return encontrados === unicos.length ? unicos : null;
}

export async function validProfessionalIds(
  clinicId: string,
  ids: string[]
): Promise<string[] | null> {
  const unicos = [...new Set(ids)];
  if (unicos.length === 0) return [];
  const encontrados = await prisma.professional.count({
    where: { clinicId, id: { in: unicos } },
  });
  return encontrados === unicos.length ? unicos : null;
}

export async function countProfessionalServices(
  clinicId: string,
  professionalId: string
): Promise<number> {
  return prisma.service.count({
    where: { clinicId, professionals: { some: { id: professionalId } } },
  });
}

/**
 * Pisa los servicios de un profesional. Devuelve false si el profesional no es
 * de esa clínica. La validación de "al menos uno" la hace quien llama con
 * `clinicHasCatalog()`, porque depende de contexto que acá no está.
 */
export async function setProfessionalServices(
  clinicId: string,
  professionalId: string,
  serviceIds: string[]
): Promise<boolean> {
  const existe = await prisma.professional.findFirst({
    where: { id: professionalId, clinicId },
    select: { id: true },
  });
  if (!existe) return false;

  await prisma.professional.update({
    where: { id: professionalId },
    data: { services: { set: serviceIds.map((id) => ({ id })) } },
  });
  return true;
}

export type SetServiceProfessionalsResult =
  | { ok: true }
  | { ok: false; reason: "no_encontrado" }
  | {
      ok: false;
      reason: "quedarian_sin_servicios";
      /** Los profesionales que se quedarían sin ningún servicio. */
      professionals: string[];
    };

/**
 * Pisa los profesionales de un servicio.
 *
 * Quitarle un servicio a alguien que no tiene otro lo dejaría "sin hacer nada",
 * que es justo lo que no se permite al dar de alta o editar al profesional: si
 * acá se pudiera, la regla se esquivaría por el otro lado. Se rechaza con los
 * nombres para que la interfaz diga a quién hay que reasignarle algo primero.
 */
export async function setServiceProfessionals(
  clinicId: string,
  serviceId: string,
  professionalIds: string[]
): Promise<SetServiceProfessionalsResult> {
  const service = await prisma.service.findFirst({
    where: { id: serviceId, clinicId },
    select: { professionals: { select: { id: true, name: true, active: true } } },
  });
  if (!service) return { ok: false, reason: "no_encontrado" };

  const quedan = new Set(professionalIds);
  const quitados = service.professionals.filter((p) => !quedan.has(p.id) && p.active);

  const sinNada: string[] = [];
  for (const p of quitados) {
    const otros = await prisma.service.count({
      where: {
        clinicId,
        id: { not: serviceId },
        professionals: { some: { id: p.id } },
      },
    });
    if (otros === 0) sinNada.push(p.name);
  }
  if (sinNada.length > 0) {
    return { ok: false, reason: "quedarian_sin_servicios", professionals: sinNada };
  }

  await prisma.service.update({
    where: { id: serviceId },
    data: { professionals: { set: professionalIds.map((id) => ({ id })) } },
  });
  return { ok: true };
}

/**
 * Marca un servicio como el de primera vez. Es uno solo por clínica: dos
 * "diagnósticos iniciales" no tendrían un criterio para elegir entre ellos, así
 * que marcar uno desmarca el anterior en la misma transacción.
 */
export async function setFirstVisitService(
  clinicId: string,
  serviceId: string,
  firstVisit: boolean
): Promise<boolean> {
  const service = await prisma.service.findFirst({ where: { id: serviceId, clinicId } });
  if (!service) return false;

  await prisma.$transaction(async (tx) => {
    if (firstVisit) {
      await tx.service.updateMany({
        where: { clinicId, id: { not: serviceId } },
        data: { firstVisit: false },
      });
    }
    await tx.service.update({ where: { id: serviceId }, data: { firstVisit } });
  });
  return true;
}
