/**
 * Script de alta de una clínica nueva. Correr con:
 *   npx tsx scripts/add-clinic.ts
 *
 * Deja dos ejemplos comentados — uno dental, uno de spa estético — para
 * mostrar que es el mismo modelo de datos, solo cambian los valores.
 *
 * Para probar la integración con Google Calendar sin editar el archivo,
 * se puede pasar un calendar ID por variable de entorno:
 *
 *   TEST_CALENDAR_ID=xxxx@group.calendar.google.com npx tsx scripts/add-clinic.ts
 *
 * Ese calendario tiene que estar compartido con GOOGLE_CLIENT_EMAIL con
 * permiso de "Hacer cambios en los eventos" — ver docs/onboarding-clinica.md.
 */
import type { Weekday } from "@prisma/client";
import { prisma } from "../src/db/client";
import { ensureClinicAdminRole } from "../src/repositories/roles.repository";
import { encryptToken } from "../src/services/crypto";

/**
 * Calendario de pruebas. Si está definido, los dos profesionales del
 * ejemplo comparten el MISMO calendario — que es también la forma de
 * probar el caso "toda la clínica en una sola agenda".
 */
const testCalendarId = process.env.TEST_CALENDAR_ID ?? null;

async function main() {
  // Toda clínica nueva arranca en el plan "Base" (sin features Plus). Se
  // le puede cambiar el plan después desde la pantalla de plataforma
  // "Clínicas". Ver src/config/plan-features.ts.
  const basePlan = await prisma.plan.findUnique({ where: { name: "Base" } });

  // --- Ejemplo 1: clínica dental ---
  const clinic = await prisma.clinic.create({
    data: {
      name: "Clínica dental Ejemplo",
      whatsappPhoneNumberId: "COMPLETAR_ID_DE_META",
      // El WABA de la clínica. Hace falta para crear sus plantillas — son
      // por WABA, no por plataforma (ver services/whatsapp-templates.ts).
      whatsappWabaId: "COMPLETAR_WABA_ID_DE_META",
      // Se guarda cifrado: `encryptToken` acá, nunca el valor pelado.
      whatsappTokenEncrypted: encryptToken("COMPLETAR_TOKEN_DE_META"),
      email: "recepcion@clinicaejemplo.com",
      timezone: "America/Mexico_City",

      // Habilita las sugerencias de feriados nacionales (ver
      // src/data/holidays.ts). Los feriados NO se cargan solos: la clínica
      // confirma cuáles no atiende con
      // POST /dashboard/clinics/:id/holidays/apply
      country: "MX",

      // Número interno de quien administra el sistema del lado de la
      // clínica — NO de un paciente. Ahí van los avisos de configuración
      // incompleta, que son más visibles que el email. Si queda en null, el
      // aviso va solo por mail.
      adminPhone: null,
      services: "Limpieza, control, extracción, endodoncia, blanqueamiento",
      customerNoun: "paciente",
      serviceNoun: "tratamiento",
      escalationCriteria:
        "Dolor intenso, sangrado abundante, hinchazón severa, o traumatismo.",

      planId: basePlan?.id ?? null,

      // Calendario único para toda la clínica. Si queda en null, cada
      // profesional usa su propio googleCalendarId (ver más abajo).
      sharedCalendarId: testCalendarId,

      // Con qué títulos trabaja esta clínica. Salen del catálogo global
      // (`ProfessionalTitle`, lo siembra prisma/seed.ts y lo administra el
      // super-admin en "Títulos"): acá solo se habilitan los que este rubro
      // usa. Sin esto, el selector de "Recursos" no ofrece ninguno.
      professionalTitles: {
        connect: [{ name: "Dr." }, { name: "Dra." }, { name: "Odontólogo" }, { name: "Odontóloga" }],
      },

      professionals: {
        create: [
          // googleCalendarId puede quedar en null: significa "todavía no
          // enlazado". Se completa después desde la pantalla de
          // configuración (PUT /dashboard/clinics/:id/professionals/:id/calendar)
          // y hasta entonces el turno vive en Postgres sin espejo.
          //
          // El título se conecta por nombre y tiene que estar habilitado
          // arriba: es el mismo requisito que aplica la interfaz.
          { name: "Ejemplo Uno", title: { connect: { name: "Dra." } }, googleCalendarId: null },
          { name: "Ejemplo Dos", title: { connect: { name: "Dr." } }, googleCalendarId: null },
        ],
      },
      rooms: {
        create: [{ name: "Consultorio 1" }, { name: "Consultorio 2" }],
      },

      // Horario de atención estructurado. Es la ÚNICA fuente: de acá sale
      // tanto la validación al agendar como el texto que el bot le cuenta
      // al paciente.
      //
      // El corte del mediodía es el HUECO entre dos tramos del mismo día:
      // lunes a viernes de 9 a 13 y de 14 a 18 son dos tramos, y de 13 a 14
      // no se agenda nada. Los minutos son desde la medianoche local de la
      // clínica (540 = 09:00).
      workingHours: {
        create: [
          ...["lunes", "martes", "miercoles", "jueves", "viernes"].flatMap((weekday) => [
            { weekday: weekday as Weekday, startMinute: 9 * 60, endMinute: 13 * 60 },
            { weekday: weekday as Weekday, startMinute: 14 * 60, endMinute: 18 * 60 },
          ]),
          // El sábado se atiende corrido, sin corte.
          { weekday: "sabado" as Weekday, startMinute: 9 * 60, endMinute: 13 * 60 },
        ],
      },
    },
  });

  // Toda clínica nueva tiene su rol "Admin de clínica" (todos los permisos
  // salvo los de plataforma) desde el arranque, para no dejarla sin nadie
  // que la pueda administrar por el dashboard.
  await ensureClinicAdminRole(clinic.id);

  console.log("Clínica creada:", clinic.id);
  console.log(
    testCalendarId
      ? `Calendario compartido: ${testCalendarId}`
      : "Sin calendario enlazado (pasa TEST_CALENDAR_ID para probar el espejo)."
  );

  /* --- Ejemplo 2: spa estético, con equipo compartido y catálogo de servicios ---

  const spa = await prisma.clinic.create({
    data: {
      name: "Spa estético Ejemplo",
      whatsappPhoneNumberId: "COMPLETAR_ID_DE_META",
      whatsappWabaId: "COMPLETAR_WABA_ID_DE_META",
      whatsappTokenEncrypted: encryptToken("COMPLETAR_TOKEN_DE_META"),
      email: "recepcion@spaejemplo.com",
      timezone: "America/Mexico_City",
      services: "Depilación láser, limpieza facial, radiofrecuencia, masajes",
      customerNoun: "cliente",
      escalationCriteria:
        "Reacción alérgica, quemadura, dolor fuera de lo esperado, o cualquier duda sobre contraindicaciones (embarazo, medicación, piel sensibilizada).",

      // Un spa habilita otros títulos que un consultorio dental: el catálogo
      // es el mismo para toda la plataforma, la lista habilitada no.
      professionalTitles: {
        connect: [{ name: "Esteticista" }, { name: "Cosmetóloga" }, { name: "Manicurista" }],
      },

      professionals: {
        create: [
          {
            name: "Uno",
            title: { connect: { name: "Esteticista" } },
            googleCalendarId: "COMPLETAR_CALENDAR_ID_1",
          },
          {
            name: "Dos",
            title: { connect: { name: "Cosmetóloga" } },
            googleCalendarId: "COMPLETAR_CALENDAR_ID_2",
          },
        ],
      },
      rooms: {
        create: [{ name: "Sala 1" }, { name: "Sala 2" }, { name: "Sala 3" }],
      },
      resources: {
        create: [
          { name: "Láser diodo #1", type: "laser_diodo" },
          { name: "Láser diodo #2", type: "laser_diodo" },
        ],
      },
      serviceCatalog: {
        create: [
          { name: "Depilación láser", durationMinutes: 30, requiredResourceType: "laser_diodo" },
          { name: "Limpieza facial", durationMinutes: 45 },
          { name: "Radiofrecuencia", durationMinutes: 40 },
        ],
      },
    },
  });

  console.log("Spa creado:", spa.id);
  */
}

main().finally(() => prisma.$disconnect());
