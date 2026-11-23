import { trackedCron } from "./tracked-cron";
import { prisma } from "../db/client";
import type { CalendarBlockInput, CalendarTarget } from "../services/calendar";
import {
  CLINIC_CALENDAR_INCLUDE,
  handleCalendarAccessError,
  listCalendarBlocks,
  PROFESSIONAL_CALENDAR_INCLUDE,
  resolveCalendarTargetForProfessional,
} from "../services/calendar";
import { listActiveClinics } from "../repositories/clinics.repository";

/**
 * Cuántos días hacia adelante se importan bloqueos. Alcanza con cubrir la
 * ventana en la que el bot puede ofrecer turnos; traer un año entero sería
 * gastar cuota de la API para nada.
 */
const SYNC_WINDOW_DAYS = 60;

/**
 * Importa a Postgres el tiempo ocupado de las agendas personales de los
 * profesionales, para que services/availability.ts no ofrezca horarios
 * encima de algo que el profesional ya tenía.
 *
 * Es la única parte del sistema que LEE Google Calendar, y lo hace acá, en
 * un job aparte, justamente para que la decisión de disponibilidad siga
 * siendo 100% Postgres (ver CLAUDE.md). Si Google está caído, el peor caso
 * es trabajar con bloqueos algo desactualizados; agendar sigue funcionando.
 *
 * Corre cada 15 minutos: si un profesional se bloquea un rato a la mañana,
 * el bot lo respeta al ratito, sin que nadie tenga que cargar nada a mano.
 */
export function scheduleCalendarSync(): void {
  trackedCron("calendar-sync", "*/15 * * * *", async () => {
    await syncAllClinics();
  });
}

/** Clínicas con un sync inmediato en curso en ESTE proceso. */
const syncsEnCurso = new Set<string>();

/**
 * Sincroniza los bloqueos de una clínica YA, sin esperar al próximo cron de
 * 15 minutos. Se llama cuando alguien conecta una cuenta o enlaza un
 * calendario: es justo el momento en que esperar es más caro, porque quien
 * acaba de configurarlo quiere ver que anda, y mientras tanto el asistente
 * ofrece horarios sin conocer los bloqueos (pasó el 2026-11-04: se reconectó
 * la cuenta y el asistente siguió ofreciendo un horario ocupado).
 *
 * **No espera ni propaga errores**: quien lo llama es un endpoint que ya
 * tiene su respuesta lista, y que falle el sync no puede romperla. El cron
 * lo reintenta de todos modos. Corre en el proceso web, pero no es una
 * decisión de disponibilidad: sigue siendo copiar bloqueos a Postgres, y
 * `availability.ts` sigue leyendo solo Postgres.
 *
 * Si ya hay uno corriendo para esa clínica en este proceso, no arranca otro.
 */
export function syncClinicBlocksNow(clinicId: string, motivo: string): void {
  if (syncsEnCurso.has(clinicId)) return;
  syncsEnCurso.add(clinicId);

  void syncClinicBlocks(clinicId)
    .catch((error) => {
      console.error(`Sync inmediato de bloqueos falló (clínica ${clinicId}, ${motivo}):`, error);
    })
    .finally(() => syncsEnCurso.delete(clinicId));
}

export async function syncAllClinics(): Promise<void> {
  const clinics = await listActiveClinics();
  for (const clinic of clinics) {
    try {
      await syncClinicBlocks(clinic.id);
    } catch (error) {
      console.error(`Error sincronizando bloqueos de la clínica ${clinic.id}:`, error);
    }
  }
}

/**
 * Sincroniza los bloqueos de todos los profesionales de una clínica.
 *
 * Si la clínica usa un calendario compartido, ese calendario se lee una
 * sola vez y el bloqueo se aplica a TODOS los profesionales que lo usan:
 * en una agenda compartida no hay forma de saber a quién pertenece un
 * evento ajeno, así que se asume que ocupa a todo el equipo. Es el criterio
 * conservador — puede rechazar algún horario que en realidad estaba libre,
 * pero nunca agenda encima de algo ocupado.
 */
export async function syncClinicBlocks(clinicId: string): Promise<void> {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    include: {
      ...CLINIC_CALENDAR_INCLUDE,
      professionals: {
        where: { active: true, blockSyncEnabled: true },
        include: PROFESSIONAL_CALENDAR_INCLUDE,
      },
    },
  });
  if (!clinic) return;

  const from = new Date();
  const to = new Date();
  to.setDate(to.getDate() + SYNC_WINDOW_DAYS);

  // Agrupamos por calendario: varios profesionales pueden compartir uno
  // (sea por Clinic.sharedCalendarId o porque tienen el mismo id cargado),
  // y no tiene sentido pedirle a Google el mismo calendario N veces. La
  // clave incluye la credencial, porque el mismo calendario accedido con
  // dos cuentas distintas son dos llamadas distintas.
  const groups = new Map<
    string,
    { target: CalendarTarget; professionalIds: string[] }
  >();

  for (const professional of clinic.professionals) {
    const target = resolveCalendarTargetForProfessional(clinic, professional);
    if (!target) continue; // sin calendario enlazado no hay nada que importar

    const key = `${target.provider}::${target.calendarId}::${target.account?.id ?? "servicio"}`;
    const group = groups.get(key) ?? { target, professionalIds: [] };
    group.professionalIds.push(professional.id);
    groups.set(key, group);
  }

  for (const { target, professionalIds } of groups.values()) {
    let blocks;
    try {
      blocks = await listCalendarBlocks(target, from, to);
    } catch (error) {
      // Si el refresh token dejó de servir, se marca la cuenta para que la
      // interfaz pida reconectar en vez de reintentar cada 15 minutos para
      // siempre. Cada proveedor sabe reconocer su propio error.
      const revoked = await handleCalendarAccessError(target, error).catch((markError) => {
        console.error(`No se pudo marcar la cuenta como revocada (clínica ${clinicId}):`, markError);
        return null;
      });
      if (revoked) {
        console.error(
          `El acceso de ${revoked.email} (${target.provider}) fue revocado (clínica ${clinicId}). Hay que reconectar la cuenta.`
        );
        continue;
      }

      // Un calendario mal compartido o un id inválido no tiene que frenar
      // el sync de los demás profesionales de la clínica.
      console.error(
        `No se pudieron leer los bloqueos del calendario ${target.calendarId} (clínica ${clinicId}):`,
        error
      );
      continue;
    }

    for (const professionalId of professionalIds) {
      await replaceBlocksForProfessional(clinicId, professionalId, blocks, from, to);
    }
  }
}

/**
 * Deja en la base exactamente los bloqueos que hoy tiene el calendario en
 * la ventana sincronizada. Se borra lo que había y se reinserta, porque un
 * evento borrado o movido en Google tiene que dejar de frenar turnos — si
 * solo hiciéramos upsert, un bloqueo cancelado quedaría vivo para siempre.
 *
 * Se limita el borrado a lo que todavía no terminó y cae en la ventana, para
 * no tocar el historial anterior a hoy.
 */
async function replaceBlocksForProfessional(
  clinicId: string,
  professionalId: string,
  blocks: CalendarBlockInput[],
  from: Date,
  to: Date
): Promise<void> {
  await prisma.$transaction([
    prisma.calendarBlock.deleteMany({
      where: {
        clinicId,
        professionalId,
        // Todo lo importado que todavía no terminó y empieza antes del fin de la ventana. Por
        // `endTime` y no por `startTime`: un evento EN CURSO empezó antes de `from`, y filtrando por
        // el inicio quedaba fuera del borrado: si se alargaba o se borraba en el calendario, el
        // bloqueo viejo seguía vivo (y `skipDuplicates` descartaba la versión nueva). El historial ya
        // terminado (`endTime <= from`) sigue sin tocarse.
        endTime: { gt: from },
        startTime: { lt: to },
        // Solo los importados: los que cargó una persona desde la Agenda no
        // existen en el calendario externo, y borrarlos acá los perdería.
        source: "calendario",
      },
    }),
    prisma.calendarBlock.createMany({
      data: blocks.map((block) => ({
        clinicId,
        professionalId,
        // La columna se llama `googleEventId` por historia; guarda el id del
        // evento en cualquier proveedor. Renombrarla pide migración: va junto
        // con el segundo proveedor.
        googleEventId: block.externalEventId,
        startTime: block.startTime,
        endTime: block.endTime,
        isAllDay: block.isAllDay,
      })),
      skipDuplicates: true,
    }),
  ]);
}
