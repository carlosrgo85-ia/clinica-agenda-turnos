import { prisma } from "../db/client";

/**
 * Los recursos con los que atiende una clínica: profesionales, espacios y
 * equipos.
 *
 * Hasta acá no existía ninguna forma de cargarlos que no fuera
 * `scripts/add-clinic.ts` o SQL directo: una clínica que contrataba un
 * profesional no podía darlo de alta, y sin ningún espacio cargado
 * `checkAvailability()` rechaza TODOS los turnos.
 *
 * **Nada se borra, se desactiva** — mismo criterio que `Service`: los turnos
 * históricos referencian al profesional, al espacio y al equipo, y borrarlos
 * dejaría la agenda pasada sin poder explicarse. `active: false` los saca de
 * lo que se puede asignar sin tocar lo ya agendado.
 */

export function listProfessionals(clinicId: string) {
  return prisma.professional.findMany({
    where: { clinicId },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: {
      preferredRoom: { select: { id: true, name: true } },
      title: { select: { id: true, name: true } },
      services: { select: { id: true, name: true, active: true } },
    },
  });
}

export interface ProfessionalInput {
  name?: string;
  titleId?: string | null;
  active?: boolean;
  preferredRoomId?: string | null;
  contactEmail?: string | null;
  whatsappPhone?: string | null;
  notifyByEmail?: boolean;
  notifyByWhatsapp?: boolean;
  calendarColorId?: string | null;
}

export function createProfessional(
  params: ProfessionalInput & { clinicId: string; name: string; serviceIds?: string[] }
) {
  const { serviceIds, ...data } = params;
  return prisma.professional.create({
    data: {
      ...data,
      ...(serviceIds?.length ? { services: { connect: serviceIds.map((id) => ({ id })) } } : {}),
    },
  });
}

export function updateProfessional(clinicId: string, id: string, data: ProfessionalInput) {
  // `updateMany` y no `update` para poder acotar por clínica en el mismo
  // where: con `update` haría falta leer primero y verificar a mano.
  return prisma.professional.updateMany({ where: { id, clinicId }, data });
}

export function listRooms(clinicId: string) {
  return prisma.room.findMany({
    where: { clinicId },
    orderBy: [{ active: "desc" }, { name: "asc" }],
  });
}

export function createRoom(params: { clinicId: string; name: string }) {
  return prisma.room.create({ data: params });
}

export function updateRoom(
  clinicId: string,
  id: string,
  data: { name?: string; active?: boolean }
) {
  return prisma.room.updateMany({ where: { id, clinicId }, data });
}

export function listResources(clinicId: string) {
  return prisma.resource.findMany({
    where: { clinicId },
    orderBy: [{ active: "desc" }, { type: "asc" }, { name: "asc" }],
  });
}

export function createResource(params: {
  clinicId: string;
  name: string;
  type: string;
}) {
  return prisma.resource.create({ data: params });
}

export function updateResource(
  clinicId: string,
  id: string,
  data: { name?: string; type?: string; active?: boolean; inactiveReason?: string | null }
) {
  return prisma.resource.updateMany({ where: { id, clinicId }, data });
}

/**
 * Cuántos turnos tiene cada profesional, espacio y equipo.
 *
 * Se muestra antes de desactivar: no es lo mismo dar de baja a alguien que
 * nunca atendió que a quien tiene doce turnos por delante.
 */
export async function countFutureAppointments(clinicId: string) {
  const ahora = new Date();
  const turnos = await prisma.appointment.findMany({
    where: { clinicId, status: "confirmado", startTime: { gte: ahora } },
    select: { professionalId: true, roomId: true, resourceId: true },
  });

  const contar = (ids: Array<string | null>) => {
    const mapa = new Map<string, number>();
    for (const id of ids) {
      if (id) mapa.set(id, (mapa.get(id) ?? 0) + 1);
    }
    return mapa;
  };

  return {
    professionals: contar(turnos.map((t) => t.professionalId)),
    rooms: contar(turnos.map((t) => t.roomId)),
    resources: contar(turnos.map((t) => t.resourceId)),
  };
}
