import { prisma } from "../db/client";
import type { Patient, PatientStage } from "@prisma/client";
import { recordSystemAudit, type AuditOrigin } from "../services/audit";

/**
 * Un WhatsApp puede tener VARIAS fichas de paciente.
 *
 * Es lo normal en una familia: Carlos escribe desde su número para él, para
 * su papá y para su hija. Mientras `Patient` estuvo identificado por
 * teléfono, los tres eran la misma persona: el turno de la hija quedaba a
 * nombre del padre, el CRM los mezclaba en una ficha, y la regla de
 * "primera vez con el profesional principal" no se aplicaba a quien
 * realmente venía por primera vez, porque el teléfono ya tenía turnos.
 *
 * El teléfono sigue identificando la CONVERSACIÓN (el historial se guarda
 * por número, no por paciente). Lo que se resuelve por persona es de quién
 * es cada turno.
 */

/**
 * El titular: de quién es el WhatsApp.
 *
 * Es la ficha más vieja de ese número — la que se crea en el primer
 * mensaje. Es a quien se le atribuye la conversación y lo que se asume
 * cuando no se aclara para quién es el turno.
 */
export async function getOrCreateConversationPatient(
  clinicId: string,
  phone: string
): Promise<Patient> {
  const existente = await prisma.patient.findFirst({
    where: { clinicId, phone },
    orderBy: { createdAt: "asc" },
  });
  if (existente) return existente;

  const creado = await prisma.patient.create({ data: { clinicId, phone } });
  // El alta de una ficha por WhatsApp no pasa por la API, así que el middleware de
  // auditoría no la ve: se registra acá. Sin el teléfono ni nada del paciente: el recurso
  // es la ficha, y de ahí sale todo lo demás.
  await recordSystemAudit({
    origin: "whatsapp",
    clinicId,
    action: "patient.create_whatsapp",
    resourceType: "patients",
    resourceId: creado.id,
    details: { titular: true },
  });
  return creado;
}

/**
 * Todas las personas que ese número puede ver: las registradas en él (`phone`, el titular primero) y las que lo tienen
 * como número autorizado (`authorizedPhones`: un familiar que agendó o que quedó autorizado). Todo lo que el asistente
 * lee de las personas de un número sale de acá, así que lo autorizado es lo único que se suma a lo visible.
 */
export async function findPatientsByPhone(clinicId: string, phone: string): Promise<Patient[]> {
  const todas = await prisma.patient.findMany({
    where: { clinicId, OR: [{ phone }, { authorizedPhones: { has: phone } }] },
    orderBy: { createdAt: "asc" },
  });
  // Las propias primero (el titular es la más vieja de ellas); las autorizadas van después.
  return [...todas.filter((p) => p.phone === phone), ...todas.filter((p) => p.phone !== phone)];
}

/** Cuántos números autorizados puede tener una persona: es un familiar o dos, no una lista de contactos. */
export const MAX_AUTHORIZED_PHONES = 3;

/**
 * Lo que el paciente decidió, al agendar para OTRA persona, sobre qué número la representa (`telefono_registro`: sus
 * avisos van ahí) y quién más queda autorizado a consultar sus citas (`telefono_autorizado`).
 *
 * **Solo se aplica a una ficha nueva, sin ninguna cita**: quien escribe puede definir los datos de contacto de una persona
 * que está dando de alta, no reescribir los de alguien ya registrado. Y nunca a la ficha de quien escribe.
 *
 * Si la persona se registra con OTRO número, quien agendó queda autorizado automáticamente: sigue viendo la cita para
 * poder cambiarla o cancelarla. `sandbox` no mueve el número real (los avisos saldrían a un teléfono verdadero): solo
 * agrega el autorizado.
 *
 * Devuelve la ficha actualizada, o la misma si no hubo nada que cambiar. Audita solo los nombres de los campos.
 */
export async function applyBookingPhones(params: {
  patient: Patient;
  writerPhone: string;
  registro?: string | null;
  autorizado?: string | null;
  sandbox?: boolean;
}): Promise<Patient> {
  const { patient, writerPhone } = params;
  if (patient.phone !== writerPhone) return patient; // ya vive en otro número: no se toca
  const citas = await prisma.appointment.count({ where: { patientId: patient.id } });
  if (citas > 0) return patient;

  const nuevoPhone = !params.sandbox && params.registro && params.registro !== writerPhone ? params.registro : null;
  const autorizados = new Set(patient.authorizedPhones);
  if (nuevoPhone) autorizados.add(writerPhone);
  if (params.autorizado && params.autorizado !== (nuevoPhone ?? patient.phone)) autorizados.add(params.autorizado);
  const lista = [...autorizados].slice(0, MAX_AUTHORIZED_PHONES);

  const cambios: { phone?: string; authorizedPhones?: string[] } = {};
  if (nuevoPhone) cambios.phone = nuevoPhone;
  if (lista.length !== patient.authorizedPhones.length) cambios.authorizedPhones = lista;
  if (Object.keys(cambios).length === 0) return patient;

  const actualizado = await prisma.patient.update({ where: { id: patient.id }, data: cambios });
  await recordSystemAudit({
    origin: "whatsapp",
    clinicId: patient.clinicId,
    action: "patient.phones_set",
    resourceType: "patients",
    resourceId: patient.id,
    // Nunca los números: solo qué campos cambiaron.
    details: { camposModificados: Object.keys(cambios) },
  });
  return actualizado;
}

/**
 * Para comparar nombres escritos a mano: sin acentos, sin mayúsculas y sin
 * espacios de más.
 *
 * "NIEVES DE GARCÍA" y "Nieves de Garcia" tienen que ser la misma persona.
 * Sin esto, cada variante de tipeo crearía una ficha nueva y la familia
 * terminaría con cinco "Nieves".
 */
export function normalizarNombre(nombre: string): string {
  return nombre
    .normalize("NFD")
    // Los diacríticos combinantes que deja NFD, en escape explícito: el
    // carácter literal en el código se pierde en cualquier copy/paste.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Lo que se guarda del nombre de una persona que se presenta por WhatsApp.
 *
 * Con el apellido por separado se guardan las TRES columnas, cada parte en su campo: es lo único
 * que garantiza que "Petra María" / "Romero" no quede partido como "Petra" / "María Romero".
 * Sin apellido (el modelo no lo dio) se guarda solo `name` y la ficha se parte al leer con una
 * heurística (`patientNameParts()`), que la pantalla avisa que hay que revisar.
 */
export function nameFields(
  nombre: string,
  apellido?: string | null
): { name: string; firstName?: string; lastName?: string } {
  const first = nombre.trim().replace(/\s+/g, " ");
  const last = apellido?.trim().replace(/\s+/g, " ");
  if (!last) return { name: first };
  return { name: `${first} ${last}`, firstName: first, lastName: last };
}

/**
 * De quién es el turno que se está por crear.
 *
 * Si el modelo no dijo un nombre, es del titular — el caso normal, alguien
 * que agenda para sí mismo. Si dijo uno, se busca entre las fichas de ese
 * número y, si no está, se crea: es una persona nueva de la misma familia.
 *
 * **Nunca se renombra una ficha existente acá.** Que Carlos agende para
 * Nieves no puede convertir la ficha de Carlos en la de Nieves; eso es
 * exactamente lo que pasaba antes.
 */
export async function resolvePatientForBooking(params: {
  clinicId: string;
  phone: string;
  /** Lo que devolvió el modelo en `paciente_del_turno`. */
  nombre: string | null;
  /** Lo que devolvió en `apellido_paciente_del_turno`, si lo dio por separado. */
  apellido?: string | null;
  titular: Patient;
}): Promise<Patient> {
  const nombrePropio = params.nombre?.trim();
  if (!nombrePropio) return params.titular;
  const datos = nameFields(nombrePropio, params.apellido);
  const nombre = datos.name;

  const buscado = normalizarNombre(nombre);
  const personas = await findPatientsByPhone(params.clinicId, params.phone);

  const existente = personas.find((p) => p.name && normalizarNombre(p.name) === buscado);
  if (existente) return existente;

  // El titular todavía sin nombre: es él mismo presentándose, no alguien
  // nuevo. Sin este caso, el primer turno de cualquiera crearía una ficha
  // duplicada y dejaría la del titular vacía para siempre.
  if (!params.titular.name) {
    const actualizado = await prisma.patient.update({
      where: { id: params.titular.id },
      data: datos,
    });
    await recordSystemAudit({
      origin: "whatsapp",
      clinicId: params.clinicId,
      action: "patient.name_set",
      resourceType: "patients",
      resourceId: actualizado.id,
      // Solo el nombre del campo, nunca el valor.
      details: { camposModificados: Object.keys(datos) },
    });
    return actualizado;
  }

  const creado = await prisma.patient.create({
    data: { clinicId: params.clinicId, phone: params.phone, ...datos },
  });
  // Una persona nueva del mismo WhatsApp (la familia): otra ficha, y queda registrada.
  await recordSystemAudit({
    origin: "whatsapp",
    clinicId: params.clinicId,
    action: "patient.create_whatsapp",
    resourceType: "patients",
    resourceId: creado.id,
    details: { titular: false, personaNuevaDelNumero: true },
  });
  return creado;
}

/**
 * Mueve al paciente a una etapa del embudo. Se llama en distintos puntos
 * del webhook y de los jobs — ver CLAUDE.md para el mapa completo de
 * transiciones (nuevo_contacto → interesado → turno_agendado →
 * turno_confirmado → atendido, o cancelado en cualquier punto).
 */
/**
 * Por qué cambia la etapa. Una lista cerrada y no texto libre: es un dato que se filtra y se
 * cuenta (cuántos pasaron a "cancelado" por una cancelación, y cuántos por otra cosa).
 */
export type StageChangeReason =
  | "primer_mensaje"
  | "turno_agendado"
  | "cancelacion"
  | "asistencia_confirmada"
  | "seguimiento_automatico";

/**
 * Quién y por qué cambia la etapa. **Obligatorio**: cada cambio de etapa del CRM se
 * audita, y exigirlo en la firma es lo que impide que un llamador nuevo lo olvide.
 */
export interface StageChangeContext {
  /** `whatsapp`: el asistente. `sistema`: un job. `panel`: una persona desde la aplicación. */
  origin: AuditOrigin;
  /** Si lo hizo una persona, quién. */
  userId?: string | null;
  motivo: StageChangeReason;
}

/**
 * Mueve al paciente a una etapa del embudo. Se llama en distintos puntos del webhook y
 * de los jobs — ver CLAUDE.md para el mapa completo de transiciones (nuevo_contacto →
 * interesado → turno_agendado → turno_confirmado → atendido, o cancelado en cualquier
 * punto).
 *
 * **Cada cambio se audita**: de qué etapa a cuál, quién lo originó y por qué. Si la etapa
 * ya era esa no se escribe nada ni se registra nada (no hubo cambio): sin esto cada mensaje
 * de un paciente "interesado" llenaría el registro de no-eventos.
 */
export async function updatePatientStage(
  patientId: string,
  stage: PatientStage,
  contexto: StageChangeContext
): Promise<void> {
  const antes = await prisma.patient.findUnique({
    where: { id: patientId },
    select: { stage: true, clinicId: true },
  });
  // Un paciente que no existe: que falle igual que fallaba antes (P2025).
  if (!antes) {
    await prisma.patient.update({ where: { id: patientId }, data: { stage } });
    return;
  }
  if (antes.stage === stage) return;

  await prisma.patient.update({ where: { id: patientId }, data: { stage } });
  await recordSystemAudit({
    origin: contexto.origin,
    userId: contexto.userId ?? null,
    clinicId: antes.clinicId,
    action: "patient.stage_change",
    resourceType: "patients",
    resourceId: patientId,
    details: { desde: antes.stage, hasta: stage, motivo: contexto.motivo },
  });
}

/**
 * Le pone el nombre a una ficha que no tenía (el paciente se presentó por WhatsApp). Se
 * audita: el nombre de una persona es un dato personal que entra al sistema por una vía que
 * no es la API. Registra solo que el campo cambió, nunca el valor.
 */
export async function setPatientName(patientId: string, nombre: string, apellido?: string | null): Promise<void> {
  const datos = nameFields(nombre, apellido);
  const actualizado = await prisma.patient.update({ where: { id: patientId }, data: datos });
  await recordSystemAudit({
    origin: "whatsapp",
    clinicId: actualizado.clinicId,
    action: "patient.name_set",
    resourceType: "patients",
    resourceId: patientId,
    details: { camposModificados: Object.keys(datos) },
  });
}

/**
 * La persona corrige cómo se escribe su nombre ("te di mi nombre mal, es María"). A diferencia de `setPatientName`
 * (que solo llena una ficha vacía o a medias), ESTA reemplaza un nombre ya cargado, y por eso solo la llama el código
 * cuando el modelo marcó `corrige_nombre` y solo sobre la ficha de quien escribe, acotada por clínica. El llamador
 * decide el apellido (si no vino, conserva el de la ficha: corregir "Maía" a "María" no puede borrar "Bolivar"). Se audita con
 * `details.correccion` y solo los nombres de los campos, nunca los valores.
 */
export async function correctPatientName(
  patient: Pick<Patient, "id" | "clinicId">,
  nombre: string,
  apellido?: string | null
): Promise<void> {
  const datos = nameFields(nombre, apellido);
  const { count } = await prisma.patient.updateMany({
    where: { id: patient.id, clinicId: patient.clinicId },
    data: datos,
  });
  if (count === 0) return;
  await recordSystemAudit({
    origin: "whatsapp",
    clinicId: patient.clinicId,
    action: "patient.name_set",
    resourceType: "patients",
    resourceId: patient.id,
    details: { camposModificados: Object.keys(datos), correccion: true },
  });
}
