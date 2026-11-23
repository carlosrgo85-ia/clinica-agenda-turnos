import { prisma } from "../db/client";
import type { Clinic, Prisma } from "@prisma/client";
import { CLINIC_CALENDAR_INCLUDE } from "../services/calendar";

/**
 * Clínica con la cuenta de Google del calendario compartido ya cargada.
 * Se trae junto porque el webhook necesita la credencial para espejar o
 * borrar el evento del turno, y sin la relación
 * `resolveCalendarTargetForProfessional()` se caería en silencio a la
 * cuenta de servicio.
 */
export type ClinicWithCalendarAccount = Prisma.ClinicGetPayload<{
  include: typeof CLINIC_CALENDAR_INCLUDE;
}>;

/** Busca la clínica dueña de un número de WhatsApp (usado en el webhook). */
export function findClinicByPhoneNumberId(
  phoneNumberId: string
): Promise<ClinicWithCalendarAccount | null> {
  return prisma.clinic.findUnique({
    where: { whatsappPhoneNumberId: phoneNumberId },
    include: CLINIC_CALENDAR_INCLUDE,
  });
}

/**
 * Todas las clínicas activas, para los cron jobs (reporte y
 * recordatorios). Incluye `plan` porque los jobs de features Plus
 * (recordatorio a 2hs, seguimiento post-visita) necesitan
 * `clinic.plan?.features` para decidir si les corresponde.
 */
export function listActiveClinics() {
  return prisma.clinic.findMany({ where: { active: true }, include: { plan: true } });
}

/**
 * Saca el token de WhatsApp de una clínica antes de que salga hacia afuera.
 *
 * Va acá y no en la ruta a propósito: lo que devuelven `listAllClinics()` y
 * `findClinicDetail()` termina en el navegador de quien abre la pantalla
 * "Clínicas", y desde ahí en su DevTools y en cualquier proxy del medio. Si
 * el filtro dependiera de que cada handler se acuerde de aplicarlo, el día
 * que se agregue un endpoint nuevo se filtra. El token solo lo leen
 * `findClinicByPhoneNumberId()` y `listActiveClinics()`, que son para mandar
 * mensajes, no para mostrar.
 */
export function withoutWhatsAppToken<T extends { whatsappTokenEncrypted?: string }>(
  clinic: T
): Omit<T, "whatsappTokenEncrypted"> {
  const { whatsappTokenEncrypted: _omitido, ...resto } = clinic;
  return resto;
}

/** Todas las clínicas, para el panel de plataforma (routes/platform.ts). */
export async function listAllClinics() {
  const clinics = await prisma.clinic.findMany({
    orderBy: { createdAt: "desc" },
    include: { plan: true },
  });
  return clinics.map(withoutWhatsAppToken);
}

/** Detalle completo de una clínica para la pantalla de plataforma "Clínicas". */
export async function findClinicDetail(id: string) {
  const clinic = await prisma.clinic.findUnique({
    where: { id },
    include: {
      plan: true,
      _count: { select: { users: true, professionals: true, workingHours: true } },
    },
  });
  return clinic ? withoutWhatsAppToken(clinic) : null;
}

/**
 * La clínica con su token, para los flujos que necesitan hablarle a la API
 * de WhatsApp en su nombre (crear plantillas, por ejemplo). Separada de
 * `findClinicDetail()` justamente para que traer el token sea una decisión
 * explícita de quien la llama.
 */
export function findClinicWithWhatsAppCreds(id: string) {
  return prisma.clinic.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      country: true,
      whatsappWabaId: true,
      whatsappPhoneNumberId: true,
      whatsappTokenEncrypted: true,
      reminderTemplateName: true,
      configAlertTemplateName: true,
    },
  });
}

export function createClinic(data: Prisma.ClinicCreateInput): Promise<Clinic> {
  return prisma.clinic.create({ data });
}

/** Edita los datos generales/de contacto/facturación/membresía de una clínica. */
export async function updateClinic(id: string, data: Prisma.ClinicUpdateInput): Promise<boolean> {
  const { count } = await prisma.clinic.updateMany({ where: { id }, data });
  return count > 0;
}

export function appendConversationMessage(params: {
  clinicId: string;
  patientPhone: string;
  role: "patient" | "assistant";
  content: string;
}) {
  return prisma.conversationMessage.create({ data: params });
}

/** Últimos N mensajes de un paciente en una clínica, en orden cronológico. */
export async function getRecentConversation(
  clinicId: string,
  patientPhone: string,
  limit = 10
) {
  const messages = await prisma.conversationMessage.findMany({
    where: { clinicId, patientPhone },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return messages.reverse();
}
