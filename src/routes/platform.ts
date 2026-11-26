import { Router } from "express";
import { PERMISSIONS } from "../config/permissions";
import { ALL_PLAN_FEATURE_IDS, PLAN_FEATURE_CATALOG, PLAN_FEATURES, planIncludes } from "../config/plan-features";
import { authenticate } from "../middleware/authenticate";
import { requirePermission, requireSuperAdmin } from "../middleware/authorize";
import {
  createClinic,
  findClinicDetail,
  findClinicWithWhatsAppCreds,
  listAllClinics,
  updateClinic,
  withoutWhatsAppToken,
} from "../repositories/clinics.repository";
import { listAgentRequests } from "../services/agent-requests";
import { auditFiltersFromQuery, listAudit } from "../services/audit";
import { getMonitoringSnapshot, listSystemEvents } from "../services/monitoring";
import { isValidLeadMinutes } from "../services/lead-time";
import { normalizeTaxId } from "../services/tax-id";
import { whatsAppTokenError } from "../services/whatsapp-token";
import { normalizePostalCode, postalCodeError } from "../services/postal-code";
import { prisma } from "../db/client";
import { isValidServiceNoun } from "../services/service-noun";
import { isValidPrivacyNoticeUrl } from "../services/privacy-notice";
import { buildConversationCosts, buildCostSummary, buildInventory, parseCostRange, validateRateInput } from "../services/costs";
import { dateKeyToUtcMidnight } from "../services/time";
import { encryptToken } from "../services/crypto";
import { clinicWhatsAppCreds } from "../services/whatsapp";
import {
  CLINIC_TEMPLATES,
  ensureClinicTemplates,
  templateStatuses,
} from "../services/whatsapp-templates";
import { TRACKED_SECRETS, isTrackedSecretKey } from "../config/tracked-secrets";
import { env } from "../config/env";
import {
  clearPlatformSecretExpiry,
  clearPlatformSecretValue,
  listPlatformSecrets,
  savePlatformSecret,
} from "../repositories/platform-secrets.repository";
import {
  describeSecretSource,
  hasEnvFallback,
  invalidatePlatformSecretCache,
  parseSecretValue,
} from "../services/platform-secrets";
import { MicrosoftConfigError, verifyMicrosoftClientSecret } from "../services/microsoft-auth";
import {
  deleteGoogleOAuthApp,
  findGoogleOAuthApp,
  saveGoogleOAuthApp,
} from "../repositories/platform-oauth-apps.repository";
import {
  getGoogleOAuthConfig,
  hasGoogleOAuthEnvFallback,
  invalidateGoogleOAuthConfigCache,
} from "../services/google-oauth-config";
import { verifyGoogleOAuthClient } from "../services/google-auth";
import {
  MAX_YEARS_AHEAD,
  REMINDER_WINDOW_DAYS,
  daysUntil,
  describeDays,
  expiryState,
  isTooFarAhead,
  parseExpiryDate,
} from "../services/secret-expiry";
import { clinicDateKey } from "../services/time";
import { ensureClinicAdminRole } from "../repositories/roles.repository";
import { createUser } from "../repositories/users.repository";
import { trySendUserInvitation } from "../services/invitations";
import { fetchGoogleBusinessData } from "../services/google-places";
import {
  WorkingHoursValidationError,
  replaceWorkingHours,
  validateWorkingHours,
  type WorkingHoursInput,
} from "../services/working-hours";
import {
  createCountry,
  createHolidayRule,
  deleteHolidayRule,
  findCountry,
  isSupportedCountry,
  listCountries,
  listHolidayRules,
  updateCountry,
  updateHolidayRule,
  type HolidayRuleInput,
} from "../repositories/countries.repository";
import {
  createPlan,
  deletePlan,
  findPlan,
  findPlanByName,
  listPlans,
  updatePlan,
} from "../repositories/plans.repository";
import {
  createInsurer,
  findInsurerByName,
  listInsurers,
  updateInsurer,
} from "../repositories/insurers.repository";
import {
  countClinicsByCountry,
  countPricesByPlan,
  deletePlanPrice,
  listPlanPrices,
  upsertPlanPrice,
} from "../repositories/plan-prices.repository";
import {
  getClinicMembership,
  listMembershipChanges,
  setClinicMembership,
} from "../repositories/clinic-membership.repository";
import { parseAmount, parseMembershipInput } from "../services/membership";
import { buildPriceGrid } from "../services/plan-prices";
import {
  createTitle,
  findTitleByName,
  listClinicTitleIds,
  listTitles,
  setClinicTitles,
  updateTitle,
} from "../repositories/professional-titles.repository";

/**
 * Rutas exclusivas del super-admin de plataforma: alta de clínicas nuevas
 * y su primer usuario administrador. La gestión del día a día de usuarios
 * y roles DENTRO de una clínica ya creada vive en routes/users.ts y
 * routes/roles.ts, montadas bajo /dashboard.
 */
export const platformRouter = Router();
platformRouter.use(authenticate, requireSuperAdmin);

platformRouter.get("/clinics", requirePermission(PERMISSIONS.CLINICAS_VER), async (_req, res) => {
  const clinics = await listAllClinics();
  res.json(clinics);
});

platformRouter.post("/clinics", requirePermission(PERMISSIONS.CLINICAS_CREAR), async (req, res) => {
  const {
    name,
    email,
    whatsappPhoneNumberId,
    whatsappToken,
    whatsappWabaId,
    services,
    timezone,
    country,
    adminEmail,
    adminName,
    contactPhone,
    website,
    address,
    googleBusinessUrl,
    workingHours,
    minLeadMinutes,
    serviceNoun,
    privacyNoticeUrl,
  } = req.body ?? {};

  const requiredFields = { name, email, whatsappPhoneNumberId, whatsappToken, services };
  const missing = Object.entries(requiredFields).filter(([, v]) => typeof v !== "string" || !v);
  if (missing.length > 0) {
    res.status(400).json({ error: `Faltan campos: ${missing.map(([k]) => k).join(", ")}` });
    return;
  }

  const problemaToken = whatsAppTokenError(whatsappToken);
  if (problemaToken) {
    res.status(400).json({ error: problemaToken });
    return;
  }

  // Opcional: sin él rige el default de la base (60). Se valida ANTES de
  // crear, por el mismo motivo que el horario: no dejar un alta a medias.
  if (minLeadMinutes !== undefined && !isValidLeadMinutes(minLeadMinutes)) {
    res.status(400).json({
      error: "`minLeadMinutes` tiene que ser un entero entre 0 y 10080 (una semana). 0 = sin mínimo.",
    });
    return;
  }

  if (privacyNoticeUrl !== undefined && privacyNoticeUrl !== null && privacyNoticeUrl !== "" && !isValidPrivacyNoticeUrl(privacyNoticeUrl)) {
    res.status(400).json({ error: "`privacyNoticeUrl` tiene que ser un link https público, sin espacios (hasta 500 caracteres)." });
    return;
  }

  // Opcional: sin él rige el default de la base ("servicio").
  if (serviceNoun !== undefined && !isValidServiceNoun(serviceNoun)) {
    res.status(400).json({
      error: "`serviceNoun` tiene que ser un texto de una línea, de hasta 30 caracteres (ej. \"tratamiento\").",
    });
    return;
  }

  /**
   * El horario ya no es un texto libre: la clínica puede nacer con sus
   * tramos cargados, típicamente los que sugirió "Traer datos de Google".
   *
   * Se valida ANTES de crear: una clínica creada y un horario rechazado
   * después dejaría al alta a medias sin que nadie se entere, y sin horario
   * `booking.ts` rechaza todo turno.
   */
  // **Es obligatorio**: una clínica sin ningún tramo no puede agendar
  // (`booking.ts` la rechaza con `clinica_sin_horario`), así que crearla sin
  // horario la dejaría andando a medias desde el primer día.
  if (!Array.isArray(workingHours)) {
    res.status(400).json({
      error: "`workingHours` es obligatorio: un arreglo con al menos un tramo de horario de atención.",
    });
    return;
  }
  const tramos = workingHours as WorkingHoursInput[];
  if (tramos.length === 0) {
    res.status(400).json({
      error: "Cargá al menos un tramo de horario de atención: sin horario la clínica no puede agendar.",
    });
    return;
  }
  const erroresDeHorario = validateWorkingHours(tramos);
  if (erroresDeHorario.length > 0) {
    res.status(400).json({ error: "Horario inválido", detalles: erroresDeHorario });
    return;
  }

  // Toda clínica nueva arranca en el plan "Base" salvo que no exista
  // (ambiente sin seedear todavía) — no se bloquea el alta por esto.
  const basePlan = await findPlanByName("Base");

  const clinic = await createClinic({
    name,
    email,
    whatsappPhoneNumberId,
    // El token entra en texto plano por el body y se guarda cifrado: la
    // credencial nunca queda legible en la base (services/crypto.ts).
    whatsappTokenEncrypted: encryptToken(whatsappToken),
    ...(typeof whatsappWabaId === "string" && whatsappWabaId ? { whatsappWabaId } : {}),
    services,
    ...(timezone ? { timezone } : {}),
    ...(country ? { country } : {}),
    ...(minLeadMinutes !== undefined ? { minLeadMinutes } : {}),
    ...(serviceNoun !== undefined ? { serviceNoun: serviceNoun.trim() } : {}),
    ...(basePlan ? { plan: { connect: { id: basePlan.id } } } : {}),
    ...(typeof contactPhone === "string" && contactPhone ? { contactPhone } : {}),
    ...(typeof website === "string" && website ? { website } : {}),
    ...(typeof address === "string" && address ? { address } : {}),
    ...(typeof googleBusinessUrl === "string" && googleBusinessUrl ? { googleBusinessUrl } : {}),
    ...(typeof privacyNoticeUrl === "string" && privacyNoticeUrl.trim() ? { privacyNoticeUrl: privacyNoticeUrl.trim() } : {}),
  });

  if (tramos.length > 0) {
    try {
      await replaceWorkingHours({ clinicId: clinic.id, professionalId: null, intervals: tramos });
    } catch (error) {
      // Ya se validó arriba, así que llegar acá es raro. La clínica igual
      // queda creada; lo que falta es el horario, y `config-health` lo marca
      // como bloqueante y manda el aviso diario.
      if (!(error instanceof WorkingHoursValidationError)) throw error;
      console.error(`No se pudo cargar el horario de la clínica ${clinic.id}:`, error.errores);
    }
  }

  const adminRole = await ensureClinicAdminRole(clinic.id);

  let admin = null;
  if (typeof adminEmail === "string" && adminEmail && typeof adminName === "string" && adminName) {
    admin = await createUser({
      clinicId: clinic.id,
      email: adminEmail,
      name: adminName,
      roleIds: [adminRole.id],
    });
    await trySendUserInvitation(admin, clinic.id);
  }

  /**
   * Las plantillas se crean en el WABA de la clínica acá mismo, porque son
   * por WABA y no por plataforma: sin esto, cada alta termina con alguien
   * cargándolas a mano en el WhatsApp Manager del cliente.
   *
   * No puede hacer fallar el alta —mismo criterio que el espejo en Calendar
   * de `booking.ts`—: la clínica ya está creada y sirve para todo lo demás.
   * Quedan en `PENDING` hasta que Meta las apruebe.
   */
  let plantillas = null;
  if (clinic.whatsappWabaId) {
    plantillas = await ensureClinicTemplates({
      wabaId: clinic.whatsappWabaId,
      token: clinicWhatsAppCreds(clinic).token,
    });
  }

  res.status(201).json({ clinic: withoutWhatsAppToken(clinic), admin, plantillas });
});

/**
 * Detalle completo de una clínica: datos generales, de contacto, de
 * facturación, redes sociales, membresía (plan + costo + periodicidad), y
 * un resumen operativo (cantidad de usuarios/profesionales, si tiene
 * horario cargado) para la pantalla de plataforma "Clínicas". El horario,
 * los usuarios y las métricas en detalle se ven entrando a esas pantallas
 * normales — ver `frontend/src/auth/AuthContext.tsx` → `viewingClinic`.
 */
platformRouter.get("/clinics/:id", requirePermission(PERMISSIONS.CLINICAS_VER), async (req, res) => {
  const clinic = await findClinicDetail(req.params.id);
  if (!clinic) {
    res.status(404).json({ error: "Clínica no encontrada" });
    return;
  }
  res.json(clinic);
});

/**
 * Todo lo de la clínica MENOS la membresía.
 *
 * El plan, el costo y la periodicidad **no se escriben acá**: van por
 * `PUT /clinics/:id/membership`, que es el único que sabe que los cuatro
 * campos se validan juntos (modalidad ↔ monto ↔ moneda ↔ motivo). Con los dos
 * caminos abiertos, este formulario podía dejar una clínica con costo y sin
 * moneda —que la base rechaza con un CHECK, o sea un 500— o cambiarle el plan
 * sin volver a fijar el precio, dejándole copiado el de otro plan.
 */
platformRouter.put("/clinics/:id", requirePermission(PERMISSIONS.CLINICAS_EDITAR), async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;

  /*
   * Se rechaza en vez de ignorarlo en silencio: el que manda esto es una
   * pestaña vieja con el formulario de antes, y "guardó bien pero el plan no
   * cambió" es peor que un error.
   */
  const deMembresia = ["planId", "membershipCost", "membershipBillingPeriod", "membershipPricing"].filter(
    (campo) => b[campo] !== undefined
  );
  if (deMembresia.length > 0) {
    res.status(400).json({
      error:
        `La membresía (${deMembresia.join(", ")}) no se edita aquí: va por ` +
        "PUT /platform/clinics/:id/membership, que valida la modalidad, el monto, la moneda y el " +
        "motivo juntos. Recargá la pantalla.",
    });
    return;
  }

  if (typeof b.country === "string" && b.country && !(await isSupportedCountry(b.country))) {
    res.status(400).json({ error: `Todavía no hay calendario de feriados para "${b.country}".` });
    return;
  }

  const camposTexto = [
    "name",
    "email",
    "timezone",
    "contactPhone",
    "adminPhone",
    "urgencyNotifyEmail",
    "urgencyNotifyPhone",
    "website",
    "address",
    "googleBusinessUrl",
    "privacyNoticeUrl",
    "whatsappWabaId",
    "facebookUrl",
    "instagramUrl",
    "tiktokUrl",
    "billingLegalName",
    "billingTaxId",
    "billingAddress",
    "billingPostalCode",
    "billingEmail",
  ] as const;
  for (const campo of camposTexto) {
    if (b[campo] !== undefined && b[campo] !== null && typeof b[campo] !== "string") {
      res.status(400).json({ error: `\`${campo}\` tiene que ser un string.` });
      return;
    }
  }
  if (b.active !== undefined && typeof b.active !== "boolean") {
    res.status(400).json({ error: "`active` tiene que ser booleano." });
    return;
  }
  if (b.minLeadMinutes !== undefined && !isValidLeadMinutes(b.minLeadMinutes)) {
    res.status(400).json({
      error: "`minLeadMinutes` tiene que ser un entero entre 0 y 10080 (una semana). 0 = sin mínimo.",
    });
    return;
  }
  if (b.privacyNoticeUrl !== undefined && b.privacyNoticeUrl !== null && b.privacyNoticeUrl !== "" && !isValidPrivacyNoticeUrl(b.privacyNoticeUrl)) {
    res.status(400).json({ error: "`privacyNoticeUrl` tiene que ser un link https público, sin espacios (hasta 500 caracteres)." });
    return;
  }
  if (b.serviceNoun !== undefined && !isValidServiceNoun(b.serviceNoun)) {
    res.status(400).json({
      error: "`serviceNoun` tiene que ser un texto de una línea, de hasta 30 caracteres (ej. \"tratamiento\").",
    });
    return;
  }
  // Un token con espacios (se copió el rótulo de Meta junto al token) se rechaza al guardar, no al primer envío.
  if (typeof b.whatsappToken === "string" && b.whatsappToken.trim()) {
    const problemaToken = whatsAppTokenError(b.whatsappToken);
    if (problemaToken) {
      res.status(400).json({ error: problemaToken });
      return;
    }
  }
  // El código postal se valida según el país de la clínica (en México, 5 dígitos): el del body, o el que ya tiene.
  if (b.billingPostalCode !== undefined && b.billingPostalCode !== null && b.billingPostalCode !== "") {
    const pais = typeof b.country === "string" && b.country ? b.country : (await findClinicDetail(req.params.id))?.country;
    const problema = postalCodeError(b.billingPostalCode, pais);
    if (problema) {
      res.status(400).json({ error: problema });
      return;
    }
  }
  if (b.assistantDisclosedInProfile !== undefined && typeof b.assistantDisclosedInProfile !== "boolean") {
    res.status(400).json({ error: "`assistantDisclosedInProfile` tiene que ser booleano." });
    return;
  }
  // El contacto por próxima cita sugerida: lo prende el super-admin porque va por
  // una plantilla que Meta tiene que aprobar en el WABA de la clínica.
  if (b.nextVisitOutreachEnabled !== undefined && typeof b.nextVisitOutreachEnabled !== "boolean") {
    res.status(400).json({ error: "`nextVisitOutreachEnabled` tiene que ser booleano." });
    return;
  }
  // El seguimiento de quienes llegaron por una campaña y no agendaron: también lo prende el super-admin,
  // por el mismo motivo (plantilla de Meta, y escribirle primero a alguien).
  if (b.campaignFollowUpEnabled !== undefined && typeof b.campaignFollowUpEnabled !== "boolean") {
    res.status(400).json({ error: "`campaignFollowUpEnabled` tiene que ser booleano." });
    return;
  }
  if (
    b.nextVisitOutreachLeadDays !== undefined &&
    !(Number.isInteger(b.nextVisitOutreachLeadDays) &&
      (b.nextVisitOutreachLeadDays as number) >= 0 &&
      (b.nextVisitOutreachLeadDays as number) <= 90)
  ) {
    res.status(400).json({ error: "`nextVisitOutreachLeadDays` tiene que ser un entero entre 0 y 90." });
    return;
  }
  // `services` no es nullable en el schema (es el texto que lee el prompt),
  // a diferencia del resto de `camposTexto`: mandarlo en null reventaría
  // contra Prisma con un 500.
  if (b.services !== undefined && (typeof b.services !== "string" || !b.services.trim())) {
    res.status(400).json({ error: "`services` tiene que ser un string no vacío." });
    return;
  }

  // Prender un interruptor cuyo plan no lo incluye no haría nada y nadie se enteraría: se rechaza explícito.
  // (Apagarlo siempre se puede.) El plan se cambia en la membresía de la clínica, no acá.
  if (b.nextVisitOutreachEnabled === true || b.campaignFollowUpEnabled === true) {
    const actual = await prisma.clinic.findUnique({ where: { id: req.params.id }, select: { plan: { select: { name: true, features: true } } } });
    const pedidas: Array<[boolean, (typeof PLAN_FEATURES)[keyof typeof PLAN_FEATURES], string]> = [
      [b.nextVisitOutreachEnabled === true, PLAN_FEATURES.NEXT_VISIT_OUTREACH, "El contacto por próxima cita"],
      [b.campaignFollowUpEnabled === true, PLAN_FEATURES.CAMPAIGN_FOLLOWUP, "El seguimiento de campañas"],
    ];
    const sinPlan = pedidas.filter(([quiere, feature]) => quiere && !planIncludes(actual ?? {}, feature));
    if (sinPlan.length > 0) {
      res.status(409).json({
        error:
          `${sinPlan.map(([, , nombre]) => nombre).join(" y ")} no está incluido en el plan ` +
          `${actual?.plan ? `«${actual.plan.name}»` : "(la clínica no tiene plan)"} de esta clínica. ` +
          "Cámbiala a un plan que lo incluya (por ejemplo Plus) en su membresía y vuelve a prenderlo.",
        code: "funcionalidad_fuera_del_plan",
      });
      return;
    }
  }

  const data: Record<string, unknown> = {};
  for (const campo of camposTexto) {
    if (b[campo] !== undefined) data[campo] = b[campo];
  }
  // El identificador fiscal se guarda normalizado (mayúsculas, sin espacios de más): ver services/tax-id.ts.
  if (b.billingTaxId !== undefined) data.billingTaxId = normalizeTaxId(b.billingTaxId);
  if (b.billingPostalCode !== undefined) {
    data.billingPostalCode = normalizePostalCode(b.billingPostalCode);
  }
  if (b.services !== undefined) data.services = b.services;
  if (b.active !== undefined) data.active = b.active;
  if (b.minLeadMinutes !== undefined) data.minLeadMinutes = b.minLeadMinutes;
  if (b.serviceNoun !== undefined) data.serviceNoun = (b.serviceNoun as string).trim();
  if (b.nextVisitOutreachEnabled !== undefined) data.nextVisitOutreachEnabled = b.nextVisitOutreachEnabled;
  if (b.campaignFollowUpEnabled !== undefined) data.campaignFollowUpEnabled = b.campaignFollowUpEnabled;
  if (b.assistantDisclosedInProfile !== undefined) data.assistantDisclosedInProfile = b.assistantDisclosedInProfile;
  if (b.nextVisitOutreachLeadDays !== undefined) data.nextVisitOutreachLeadDays = b.nextVisitOutreachLeadDays;
  if (b.country !== undefined) data.country = b.country;

  /**
   * Rotar el token de WhatsApp: entra en texto plano y se guarda cifrado,
   * igual que en el alta. Un string vacío se ignora en vez de borrar la
   * credencial — es lo que manda un formulario donde el campo quedó en
   * blanco porque no se quiso cambiar.
   */
  if (typeof b.whatsappToken === "string" && b.whatsappToken.trim()) {
    data.whatsappTokenEncrypted = encryptToken(b.whatsappToken.trim());
  }

  /*
   * Un body sin ningún campo conocido no llega a la base: `updateMany` con
   * `data: {}` devuelve 0 filas afectadas, y eso se reportaba como "clínica no
   * encontrada" — un 404 que manda a buscar el problema donde no está.
   */
  if (Object.keys(data).length === 0) {
    res.status(400).json({ error: "No vino ningún campo para actualizar." });
    return;
  }

  const updated = await updateClinic(req.params.id, data);
  if (!updated) {
    res.status(404).json({ error: "Clínica no encontrada" });
    return;
  }
  res.json(await findClinicDetail(req.params.id));
});

/**
 * Estado de las plantillas de WhatsApp en el WABA de la clínica.
 *
 * Son por WABA, así que cada clínica tiene las suyas y hay que poder ver si
 * Meta ya las aprobó: una en `REJECTED` o `PENDING` es la causa típica de
 * "los recordatorios no le llegan a nadie", y desde afuera se ve igual que
 * un bug nuestro.
 */
platformRouter.get(
  "/clinics/:id/whatsapp/templates",
  requirePermission(PERMISSIONS.CLINICAS_VER),
  async (req, res) => {
    const clinic = await findClinicWithWhatsAppCreds(req.params.id);
    if (!clinic) {
      res.status(404).json({ error: "Clínica no encontrada" });
      return;
    }
    if (!clinic.whatsappWabaId) {
      res.status(400).json({
        error:
          "La clínica no tiene cargado el WABA ID. Sin él no se pueden consultar ni crear sus plantillas.",
      });
      return;
    }

    try {
      const enMeta = await templateStatuses({
        wabaId: clinic.whatsappWabaId,
        token: clinicWhatsAppCreds(clinic).token,
      });

      // Se devuelve el catálogo que la plataforma necesita, cruzado con lo
      // que hay en Meta: lo que importa no es qué plantillas tiene la
      // clínica, sino si tiene las que el código manda.
      res.json(
        CLINIC_TEMPLATES.map((t) => {
          const encontrada = enMeta.find((m) => m.name === t.name);
          return {
            name: t.name,
            descripcion: t.descripcion,
            status: encontrada?.status ?? "NO_CREADA",
            // La categoría que Meta aplicó de verdad, y la que espera el catálogo (de ella sale el costo).
            categoriaEnMeta: encontrada?.category ?? null,
            categoriaEsperada: t.categoria,
          };
        })
      );
    } catch (error) {
      res.status(502).json({
        error: error instanceof Error ? error.message : "No se pudieron leer las plantillas.",
      });
    }
  }
);

/**
 * Crea en el WABA de la clínica las plantillas que le falten. Idempotente:
 * las que ya existen se informan como `ya_existia`. Se corre solo en el alta
 * (`POST /clinics`), y esto es para reintentar —Meta caído, WABA cargado
 * después, una plantilla rechazada que se corrigió—.
 */
platformRouter.post(
  "/clinics/:id/whatsapp/templates",
  requirePermission(PERMISSIONS.CLINICAS_EDITAR),
  async (req, res) => {
    const clinic = await findClinicWithWhatsAppCreds(req.params.id);
    if (!clinic) {
      res.status(404).json({ error: "Clínica no encontrada" });
      return;
    }
    if (!clinic.whatsappWabaId) {
      res.status(400).json({
        error:
          "La clínica no tiene cargado el WABA ID. Sin él no se pueden crear sus plantillas.",
      });
      return;
    }

    const resultados = await ensureClinicTemplates({
      wabaId: clinic.whatsappWabaId,
      token: clinicWhatsAppCreds(clinic).token,
    });
    res.json(resultados);
  }
);

/**
 * Trae dirección, teléfono, sitio web y horario sugeridos desde la ficha
 * de Google de un negocio (`services/google-places.ts`). NO guarda nada —
 * el admin revisa la sugerencia y la guarda con `POST /clinics` (alta) o
 * `PUT /clinics/:id` (edición) de siempre, igual que un feriado sugerido
 * no se carga solo. No cuelga de una clínica en particular (no hace falta
 * que exista todavía) — la usan tanto el form de alta como el detalle.
 */
platformRouter.post("/google-business/preview", async (req, res) => {
  if (!req.user!.permissions.has(PERMISSIONS.CLINICAS_CREAR) && !req.user!.permissions.has(PERMISSIONS.CLINICAS_EDITAR)) {
    res.status(403).json({ error: "No tienes permiso para esta acción" });
    return;
  }

  const { url } = req.body ?? {};
  if (typeof url !== "string" || !url.trim()) {
    res.status(400).json({ error: "Hace falta `url`." });
    return;
  }

  try {
    const suggestion = await fetchGoogleBusinessData(url.trim());
    res.json(suggestion);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "No se pudo traer los datos de Google." });
  }
});

/**
 * Catálogo de planes (ver `repositories/plans.repository.ts` y
 * `config/plan-features.ts`). Reemplaza los booleanos sueltos que tenía
 * `Clinic` para features Plus — mismo criterio que el catálogo de países:
 * infraestructura compartida, editable desde la plataforma.
 */
platformRouter.get("/plan-features", requirePermission(PERMISSIONS.PLANES_VER), (_req, res) => {
  res.json(PLAN_FEATURE_CATALOG);
});

platformRouter.get("/plans", requirePermission(PERMISSIONS.PLANES_VER), async (_req, res) => {
  const [plans, preciosPorPlan, paisesActivos] = await Promise.all([
    listPlans(),
    countPricesByPlan(),
    listCountries().then((cs) => cs.filter((c) => c.active).length),
  ]);
  res.json(
    plans.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      isSystem: p.isSystem,
      features: p.features,
      clinicas: p._count.clinics,
      // Celdas de la grilla con precio, sobre el total posible: un plan sin
      // precios no se puede asignar como "precio de lista" en ningún lado.
      precios: { cargados: preciosPorPlan.get(p.id) ?? 0, paisesActivos },
    }))
  );
});

platformRouter.post("/plans", requirePermission(PERMISSIONS.PLANES_EDITAR), async (req, res) => {
  const { name, description, features } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "Hace falta `name`." });
    return;
  }
  const parsedFeatures = parseFeatures(features);
  if ("error" in parsedFeatures) {
    res.status(400).json({ error: parsedFeatures.error });
    return;
  }

  const plan = await createPlan({ name: name.trim(), description, features: parsedFeatures.features });
  res.status(201).json(plan);
});

platformRouter.put("/plans/:id", requirePermission(PERMISSIONS.PLANES_EDITAR), async (req, res) => {
  const { name, description, features } = req.body ?? {};
  if (name !== undefined && (typeof name !== "string" || !name.trim())) {
    res.status(400).json({ error: "`name` tiene que ser un string no vacío." });
    return;
  }

  let parsedFeatures: string[] | undefined;
  if (features !== undefined) {
    const parsed = parseFeatures(features);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    parsedFeatures = parsed.features;
  }

  const updated = await updatePlan(req.params.id, { name, description, features: parsedFeatures });
  if (!updated) {
    res.status(404).json({ error: "Plan no encontrado" });
    return;
  }
  res.json({ ok: true });
});

platformRouter.delete("/plans/:id", requirePermission(PERMISSIONS.PLANES_EDITAR), async (req, res) => {
  const result = await deletePlan(req.params.id);
  if (!result.ok) {
    const mensajes = {
      no_encontrado: "Plan no encontrado",
      es_de_sistema: "No se puede borrar un plan de sistema (Base/Plus).",
      tiene_clinicas: "No se puede borrar: hay clínicas usando este plan.",
    };
    res.status(result.reason === "no_encontrado" ? 404 : 409).json({ error: mensajes[result.reason] });
    return;
  }
  res.status(204).end();
});

function parseFeatures(features: unknown): { features: string[] } | { error: string } {
  if (!Array.isArray(features) || features.some((f) => typeof f !== "string")) {
    return { error: "`features` tiene que ser un arreglo de strings." };
  }
  const desconocida = features.find((f) => !ALL_PLAN_FEATURE_IDS.includes(f as never));
  if (desconocida) {
    return { error: `Feature desconocida: "${desconocida}".` };
  }
  return { features };
}

/**
 * Catálogo de títulos de profesional ("Dr.", "Lic.", "Manicurista") y qué
 * títulos tiene habilitados cada clínica.
 *
 * Vive acá y no en `routes/dashboard.ts` porque las dos cosas son de la
 * plataforma: el catálogo es compartido, y con cuáles trabaja una clínica lo
 * decide el super-admin (la clínica no lo elige, solo usa los habilitados
 * cuando carga un profesional en "Recursos").
 */
platformRouter.get("/titles", requirePermission(PERMISSIONS.TITULOS_VER), async (_req, res) => {
  const titles = await listTitles();
  res.json(
    titles.map((t) => ({
      id: t.id,
      name: t.name,
      active: t.active,
      profesionales: t._count.professionals,
      clinicas: t._count.clinics,
    }))
  );
});

platformRouter.post("/titles", requirePermission(PERMISSIONS.TITULOS_EDITAR), async (req, res) => {
  const name = tituloDelBody(req.body);
  if (!name) {
    res.status(400).json({ error: "Hace falta `name`." });
    return;
  }

  // El nombre es único en toda la plataforma: dos "Dra." no se distinguen
  // entre sí. Se traduce a un mensaje y no a un 500 de Prisma.
  const existente = await findTitleByName(name);
  if (existente) {
    res.status(409).json({ error: `Ya existe un título "${name}".` });
    return;
  }

  const title = await createTitle({ name });
  res.status(201).json(title);
});

platformRouter.put("/titles/:id", requirePermission(PERMISSIONS.TITULOS_EDITAR), async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const data: { name?: string; active?: boolean } = {};

  if (b.name !== undefined) {
    const name = tituloDelBody(b);
    if (!name) {
      res.status(400).json({ error: "`name` tiene que ser un string no vacío." });
      return;
    }
    const existente = await findTitleByName(name);
    if (existente && existente.id !== req.params.id) {
      res.status(409).json({ error: `Ya existe un título "${name}".` });
      return;
    }
    data.name = name;
  }
  if (b.active !== undefined) {
    if (typeof b.active !== "boolean") {
      res.status(400).json({ error: "`active` tiene que ser booleano." });
      return;
    }
    data.active = b.active;
  }

  const result = await updateTitle(req.params.id, data);
  if (!result.ok) {
    if (result.reason === "no_encontrado") {
      res.status(404).json({ error: "Título no encontrado" });
      return;
    }
    res.status(409).json({
      error:
        `No se puede desactivar: ${result.profesionales} profesional(es) lo tienen puesto. ` +
        "Cámbiales el título primero.",
    });
    return;
  }
  res.json({ ok: true });
});

platformRouter.get(
  "/clinics/:id/titles",
  requirePermission(PERMISSIONS.TITULOS_VER),
  async (req, res) => {
    res.json({ habilitados: await listClinicTitleIds(req.params.id) });
  }
);

platformRouter.put(
  "/clinics/:id/titles",
  requirePermission(PERMISSIONS.TITULOS_EDITAR),
  async (req, res) => {
    const { titleIds } = (req.body ?? {}) as { titleIds?: unknown };
    if (!Array.isArray(titleIds) || titleIds.some((t) => typeof t !== "string")) {
      res.status(400).json({ error: "`titleIds` tiene que ser un arreglo de strings." });
      return;
    }

    const result = await setClinicTitles(req.params.id, titleIds as string[]);
    if (!result.ok) {
      if (result.reason === "no_encontrado") {
        res.status(404).json({ error: "Clínica no encontrada" });
        return;
      }
      if (result.reason === "titulo_inexistente") {
        res.status(400).json({ error: "Alguno de los títulos indicados no existe." });
        return;
      }
      const detalle = result.enUso
        .map((t) => `"${t.name}" (${t.profesionales} profesional/es)`)
        .join(", ");
      res.status(409).json({
        error:
          `No se puede quitar: esta clínica está usando ${detalle}. ` +
          "Cámbiales el título a esos profesionales primero.",
      });
      return;
    }
    res.json({ ok: true });
  }
);

/** Un título no vacío y sin espacios de sobra. */
function tituloDelBody(body: unknown): string | null {
  const name = (body as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

/**
 * Precios de lista de un plan, por país y periodicidad.
 *
 * **Editar acá no le cambia el precio a ninguna clínica que ya esté.** Cada
 * una tiene el suyo copiado; esto es lo que se le va a ofrecer a las nuevas.
 */
platformRouter.get(
  "/plans/:id/prices",
  requirePermission(PERMISSIONS.PLANES_VER),
  async (req, res) => {
    const plan = await findPlan(req.params.id);
    if (!plan) {
      res.status(404).json({ error: "Plan no encontrado" });
      return;
    }

    const [countries, prices, clinicasPorPais] = await Promise.all([
      listCountries(),
      listPlanPrices(plan.id),
      countClinicsByCountry(plan.id),
    ]);

    res.json({
      plan: { id: plan.id, name: plan.name },
      filas: buildPriceGrid({ countries, prices, clinicasPorPais }),
    });
  }
);

platformRouter.put(
  "/plans/:id/prices/:countryId/:period",
  requirePermission(PERMISSIONS.PLANES_EDITAR),
  async (req, res) => {
    const period = req.params.period;
    if (period !== "mensual" && period !== "anual") {
      res.status(400).json({ error: 'La periodicidad tiene que ser "mensual" o "anual".' });
      return;
    }

    const amount = parseAmount((req.body ?? {}).amount);
    if (!amount.ok) {
      res.status(400).json({ error: amount.error });
      return;
    }

    const result = await upsertPlanPrice({
      planId: req.params.id,
      countryId: req.params.countryId,
      billingPeriod: period,
      amount: amount.amount,
      changedById: req.user?.id ?? null,
    });

    if (!result.ok) {
      const mensajes = {
        plan_no_encontrado: "Plan no encontrado",
        pais_no_encontrado: "País no encontrado",
        pais_inactivo:
          "Ese país está desactivado y no tenía precio cargado. Actívalo en Países primero.",
      };
      res.status(result.reason === "pais_inactivo" ? 409 : 404).json({
        error: mensajes[result.reason],
      });
      return;
    }

    // Las clínicas del plan siguen con su precio: se devuelve el número para
    // poder decirlo en pantalla, que es donde el admin vive la regla.
    const clinicasPorPais = await countClinicsByCountry(req.params.id);
    res.json({
      ok: true,
      clinicasEnEstePlan: [...clinicasPorPais.values()].reduce((a, b) => a + b, 0),
    });
  }
);

platformRouter.delete(
  "/plans/:id/prices/:countryId/:period",
  requirePermission(PERMISSIONS.PLANES_EDITAR),
  async (req, res) => {
    const period = req.params.period;
    if (period !== "mensual" && period !== "anual") {
      res.status(400).json({ error: 'La periodicidad tiene que ser "mensual" o "anual".' });
      return;
    }

    const result = await deletePlanPrice({
      planId: req.params.id,
      countryId: req.params.countryId,
      billingPeriod: period,
      changedById: req.user?.id ?? null,
    });

    if (!result.ok) {
      res.status(404).json({ error: "Ese precio no estaba cargado." });
      return;
    }
    res.json({ ok: true, clinicasSinReferencia: result.clinicasSinReferencia });
  }
);

/**
 * La membresía de una clínica: con qué criterio se le cobra y cuánto.
 *
 * Tiene endpoint propio y no viaja en el `PUT` general de la clínica porque
 * sus reglas son cruzadas (modalidad ↔ monto ↔ motivo ↔ periodicidad ↔ país ↔
 * existencia de precio de lista): un rechazo por el motivo faltante no puede
 * bloquear el guardado de la dirección.
 */
platformRouter.get(
  "/clinics/:id/membership",
  requirePermission(PERMISSIONS.CLINICAS_VER),
  async (req, res) => {
    const membership = await getClinicMembership(req.params.id);
    if (!membership) {
      res.status(404).json({ error: "Clínica no encontrada" });
      return;
    }

    const historial = await listMembershipChanges(req.params.id);
    res.json({
      ...membership,
      historial: historial.map((h) => ({
        id: h.id,
        changedAt: h.changedAt.toISOString(),
        fromPricing: h.fromPricing,
        toPricing: h.toPricing,
        fromAmount: h.fromAmount?.toFixed(2) ?? null,
        toAmount: h.toAmount?.toFixed(2) ?? null,
        currency: h.currency,
        reason: h.reason,
        changedBy: h.changedBy?.name ?? h.changedBy?.email ?? null,
      })),
    });
  }
);

platformRouter.put(
  "/clinics/:id/membership",
  requirePermission(PERMISSIONS.CLINICAS_EDITAR),
  async (req, res) => {
    const parsed = parseMembershipInput(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const result = await setClinicMembership({
      clinicId: req.params.id,
      input: parsed.input,
      changedById: req.user?.id ?? null,
    });

    if (!result.ok) {
      const mensajes = {
        clinica_no_encontrada: "Clínica no encontrada",
        plan_no_encontrado: "El plan indicado no existe.",
        sin_pais:
          "La clínica no tiene país cargado, así que no hay moneda en la que expresar el precio. " +
          "Carga el país primero.",
        pais_no_encontrado: "El país de la clínica no está en el catálogo.",
        sin_precio_de_lista:
          "No hay precio de lista de ese plan para el país y la periodicidad elegidos. " +
          "Cárgalo en Catálogos → Planes → Precios, o elige un precio especial.",
      };
      const status =
        result.reason === "clinica_no_encontrada"
          ? 404
          : result.reason === "plan_no_encontrado" || result.reason === "pais_no_encontrado"
            ? 400
            : 409;
      res.status(status).json({ error: mensajes[result.reason] });
      return;
    }

    // Se devuelve el estado nuevo para que la tarjeta se refresque sin una
    // segunda llamada.
    res.json(await getClinicMembership(req.params.id));
  }
);

/**
 * Catálogo global de obras sociales / prepagas. Cada clínica elige con cuáles
 * trabaja desde su propia pantalla "Seguros" (`routes/dashboard.ts`): acá solo
 * se administra la lista compartida, para que "OSDE" no exista escrita de tres
 * formas distintas.
 */
platformRouter.get("/insurers", requirePermission(PERMISSIONS.SEGUROS_VER), async (_req, res) => {
  const insurers = await listInsurers();
  res.json(
    insurers.map((i) => ({
      id: i.id,
      name: i.name,
      active: i.active,
      clinicas: i.clinicas,
      clinicasActivas: i.clinicasActivas,
    }))
  );
});

platformRouter.post("/insurers", requirePermission(PERMISSIONS.SEGUROS_EDITAR), async (req, res) => {
  const name = tituloDelBody(req.body);
  if (!name) {
    res.status(400).json({ error: "Hace falta `name`." });
    return;
  }

  if (await findInsurerByName(name)) {
    res.status(409).json({ error: `Ya existe un seguro "${name}".` });
    return;
  }

  res.status(201).json(await createInsurer({ name }));
});

platformRouter.put(
  "/insurers/:id",
  requirePermission(PERMISSIONS.SEGUROS_EDITAR),
  async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const data: { name?: string; active?: boolean } = {};

    if (b.name !== undefined) {
      const name = tituloDelBody(b);
      if (!name) {
        res.status(400).json({ error: "`name` tiene que ser un string no vacío." });
        return;
      }
      const existente = await findInsurerByName(name);
      if (existente && existente.id !== req.params.id) {
        res.status(409).json({ error: `Ya existe un seguro "${name}".` });
        return;
      }
      data.name = name;
    }
    if (b.active !== undefined) {
      if (typeof b.active !== "boolean") {
        res.status(400).json({ error: "`active` tiene que ser booleano." });
        return;
      }
      data.active = b.active;
    }

    const result = await updateInsurer(req.params.id, data);
    if (!result.ok) {
      if (result.reason === "no_encontrado") {
        res.status(404).json({ error: "Seguro no encontrado" });
        return;
      }
      res.status(409).json({
        error:
          `No se puede desactivar: ${result.clinicas} clínica(s) lo tienen activo. ` +
          "Si se desactiva, el asistente deja de decir que trabajan con él sin que ellas se enteren.",
      });
      return;
    }
    res.json({ ok: true });
  }
);

/**
 * Catálogo de países y sus reglas de feriados (ver
 * `repositories/countries.repository.ts` y `services/holidays.ts`). Es
 * infraestructura compartida por todas las clínicas — por eso vive acá, no
 * en `routes/dashboard.ts` — y reemplaza lo que antes era
 * `HOLIDAYS_BY_COUNTRY` hardcodeado en `src/data/holidays.ts`.
 */
platformRouter.get("/countries", requirePermission(PERMISSIONS.PAISES_VER), async (_req, res) => {
  const countries = await listCountries();
  res.json(
    countries.map((c) => ({
      id: c.id,
      name: c.name,
      currency: c.currency,
      timezones: c.timezones,
      active: c.active,
      reglas: c._count.holidayRules,
    }))
  );
});

/** `timezones` llega como arreglo de strings; `undefined` = no tocar, cualquier otra cosa que no sea un arreglo de strings es error. */
function parseTimezones(value: unknown): string[] | undefined | { error: string } {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((tz) => typeof tz !== "string" || !tz.trim())) {
    return { error: "`timezones` tiene que ser un arreglo de strings no vacíos." };
  }
  return value.map((tz) => tz.trim());
}

platformRouter.post("/countries", requirePermission(PERMISSIONS.PAISES_EDITAR), async (req, res) => {
  const { id, name, currency, timezones } = req.body ?? {};
  if (
    typeof id !== "string" ||
    !id.trim() ||
    typeof name !== "string" ||
    !name.trim() ||
    typeof currency !== "string" ||
    !currency.trim()
  ) {
    res.status(400).json({ error: 'Hace falta `id` (código ISO, ej. "VE"), `name` y `currency` (ej. "VES").' });
    return;
  }
  const parsedTimezones = parseTimezones(timezones);
  if (parsedTimezones && "error" in parsedTimezones) {
    res.status(400).json({ error: parsedTimezones.error });
    return;
  }

  const existing = await findCountry(id);
  if (existing) {
    res.status(409).json({ error: `Ya existe el país "${id.toUpperCase()}".` });
    return;
  }

  const country = await createCountry({ id, name: name.trim(), currency: currency.trim(), timezones: parsedTimezones });
  res.status(201).json(country);
});

platformRouter.put("/countries/:id", requirePermission(PERMISSIONS.PAISES_EDITAR), async (req, res) => {
  const { name, currency, active, timezones } = req.body ?? {};
  if (name !== undefined && typeof name !== "string") {
    res.status(400).json({ error: "`name` tiene que ser un string." });
    return;
  }
  if (currency !== undefined && typeof currency !== "string") {
    res.status(400).json({ error: "`currency` tiene que ser un string." });
    return;
  }
  if (active !== undefined && typeof active !== "boolean") {
    res.status(400).json({ error: "`active` tiene que ser booleano." });
    return;
  }
  const parsedTimezones = parseTimezones(timezones);
  if (parsedTimezones && "error" in parsedTimezones) {
    res.status(400).json({ error: parsedTimezones.error });
    return;
  }

  const updated = await updateCountry(req.params.id, { name, currency, active, timezones: parsedTimezones });
  if (!updated) {
    res.status(404).json({ error: "País no encontrado" });
    return;
  }
  res.json({ ok: true });
});

platformRouter.get(
  "/countries/:id/holiday-rules",
  requirePermission(PERMISSIONS.PAISES_VER),
  async (req, res) => {
    const rules = await listHolidayRules(req.params.id);
    res.json(rules);
  }
);

platformRouter.post(
  "/countries/:id/holiday-rules",
  requirePermission(PERMISSIONS.PAISES_EDITAR),
  async (req, res) => {
    const country = await findCountry(req.params.id);
    if (!country) {
      res.status(404).json({ error: "País no encontrado" });
      return;
    }

    const parsed = parseHolidayRuleBody(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const rule = await createHolidayRule(req.params.id, parsed);
    res.status(201).json(rule);
  }
);

platformRouter.put(
  "/countries/:id/holiday-rules/:ruleId",
  requirePermission(PERMISSIONS.PAISES_EDITAR),
  async (req, res) => {
    const parsed = parseHolidayRuleBody(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const updated = await updateHolidayRule(req.params.ruleId, req.params.id, parsed);
    if (!updated) {
      res.status(404).json({ error: "Regla no encontrada en este país" });
      return;
    }
    res.json({ ok: true });
  }
);

platformRouter.delete(
  "/countries/:id/holiday-rules/:ruleId",
  requirePermission(PERMISSIONS.PAISES_EDITAR),
  async (req, res) => {
    const deleted = await deleteHolidayRule(req.params.ruleId, req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "Regla no encontrada en este país" });
      return;
    }
    res.status(204).end();
  }
);

/** Valida la forma del body antes de tocar la capa de datos — mismo estilo que `parseTramos` en dashboard.ts. */
function parseHolidayRuleBody(body: unknown): HolidayRuleInput | { error: string } {
  const b = (body ?? {}) as {
    name?: unknown;
    kind?: unknown;
    month?: unknown;
    day?: unknown;
    weekday?: unknown;
    ordinal?: unknown;
    offsetDays?: unknown;
  };

  if (typeof b.name !== "string" || !b.name.trim()) {
    return { error: "Hace falta `name`." };
  }
  if (b.kind !== "fixed" && b.kind !== "nthWeekday" && b.kind !== "easter") {
    return { error: 'kind tiene que ser "fixed", "nthWeekday" o "easter".' };
  }

  const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
  const name = b.name.trim();

  if (b.kind === "fixed") {
    const month = int(b.month);
    const day = int(b.day);
    if (month === null || day === null) {
      return { error: '"fixed" necesita `month` y `day` (números enteros).' };
    }
    return { name, kind: "fixed", month, day, weekday: null, ordinal: null, offsetDays: null };
  }

  if (b.kind === "nthWeekday") {
    const month = int(b.month);
    const weekday = int(b.weekday);
    const ordinal = int(b.ordinal);
    if (month === null || weekday === null || ordinal === null) {
      return { error: '"nthWeekday" necesita `month`, `weekday` y `ordinal` (números enteros).' };
    }
    return { name, kind: "nthWeekday", month, weekday, ordinal, day: null, offsetDays: null };
  }

  const offsetDays = int(b.offsetDays);
  if (offsetDays === null) {
    return { error: '"easter" necesita `offsetDays` (número entero, puede ser negativo).' };
  }
  return { name, kind: "easter", offsetDays, month: null, day: null, weekday: null, ordinal: null };
}

/**
 * Secretos de las integraciones de la plataforma (hoy el de la app de
 * Microsoft): cuándo vencen y, opcionalmente, su valor. El recordatorio por
 * mail lo manda `jobs/secret-expiry-alerts.ts`.
 *
 * **El valor es de solo escritura**: se guarda cifrado y ninguna respuesta de
 * esta API lo devuelve, ni cifrado. Se informa SI hay uno guardado y DE DÓNDE
 * sale hoy (`origen`), nunca cuál es.
 *
 * Devuelve siempre todas las entradas del catálogo, con o sin fecha, para que
 * la pantalla muestre también las que todavía no se registraron.
 */
platformRouter.get("/secrets", requirePermission(PERMISSIONS.SECRETOS_VER), async (_req, res) => {
  const today = clinicDateKey(new Date(), env.platformTimezone);
  const registered = new Map((await listPlatformSecrets()).map((r) => [r.key, r]));

  const secretos = await Promise.all(
    Object.entries(TRACKED_SECRETS).map(async ([key, definition]) => {
      const record = registered.get(key);
      const days = record?.expiresOn ? daysUntil(record.expiresOn, today) : null;
      return {
        key,
        label: definition.label,
        description: definition.description,
        impact: definition.impact,
        renewal: definition.renewal,
        envVar: definition.envVar,
        expiresOn: record?.expiresOn ?? null,
        note: record?.note ?? null,
        daysLeft: days,
        // null = todavía no se registró: el aviso no puede salir sin fecha.
        state: days === null ? null : expiryState(days),
        resumen: days === null ? null : describeDays(days),
        lastReminderOn: record?.lastReminderOn ?? null,
        valorGuardado: record?.hasStoredValue ?? false,
        // De dónde sale el valor que se usa hoy: la base, el .env, o ninguno.
        origen: await describeSecretSource(key as keyof typeof TRACKED_SECRETS),
      };
    })
  );

  res.json({ hoy: today, diasDeAviso: REMINDER_WINDOW_DAYS, secretos });
});

/**
 * Cómo se prueba cada secreto contra su proveedor antes de guardarlo. Es un
 * `Record` y no un `if` para que sumar un secreto al catálogo obligue a
 * decidir cómo se verifica (o a decir explícitamente que no se puede).
 */
const SECRET_VERIFIERS: Record<keyof typeof TRACKED_SECRETS, (value: string) => Promise<"valido" | "invalido">> = {
  microsoft_oauth_client_secret: verifyMicrosoftClientSecret,
};

/**
 * Registra el vencimiento y, si viene `value`, guarda el secreto nuevo. Sin
 * `value` el que ya había no se toca.
 */
platformRouter.put("/secrets/:key", requirePermission(PERMISSIONS.SECRETOS_EDITAR), async (req, res) => {
  const { key } = req.params;
  if (!isTrackedSecretKey(key)) {
    res.status(404).json({ error: "Ese secreto no está en el catálogo." });
    return;
  }

  const expiresOn = parseExpiryDate(req.body?.expiresOn);
  if (!expiresOn) {
    res.status(400).json({ error: "`expiresOn` tiene que ser una fecha válida con formato YYYY-MM-DD." });
    return;
  }

  // Una fecha de años adelante casi seguro es un typo, y apagaría los avisos
  // hasta entonces sin que nadie se entere.
  const today = clinicDateKey(new Date(), env.platformTimezone);
  if (isTooFarAhead(expiresOn, today)) {
    res.status(400).json({
      error: `El vencimiento no puede estar a más de ${MAX_YEARS_AHEAD} años. Revisa el año.`,
    });
    return;
  }

  const rawNote = req.body?.note;
  if (rawNote !== undefined && rawNote !== null && typeof rawNote !== "string") {
    res.status(400).json({ error: "`note` tiene que ser texto." });
    return;
  }
  const note = typeof rawNote === "string" && rawNote.trim() ? rawNote.trim().slice(0, 500) : null;

  let value: string | undefined;
  if (req.body?.value !== undefined && req.body?.value !== null && req.body?.value !== "") {
    const parsed = parseSecretValue(req.body.value);
    if (!parsed) {
      res.status(400).json({ error: "El secreto no es válido: tiene entre 8 y 512 caracteres y no lleva espacios." });
      return;
    }
    value = parsed;

    // Un secreto mal pegado desconectaría a todas las clínicas de golpe, así
    // que se prueba contra el proveedor ANTES de guardarlo.
    try {
      if ((await SECRET_VERIFIERS[key](value)) === "invalido") {
        res.status(400).json({
          error: "Microsoft rechazó ese secreto. Revisa que sea el VALOR (no el ID del secreto) y que sea de esta app.",
        });
        return;
      }
    } catch (error) {
      // La app no está configurada: no se puede probar el secreto contra una
      // app que no existe. Es un problema de configuración, no de red.
      if (error instanceof MicrosoftConfigError) {
        res.status(409).json({ error: error.message });
        return;
      }
      // No se pudo verificar (red, Microsoft caído): no prueba nada sobre el
      // secreto, pero tampoco se guarda a ciegas.
      console.error("No se pudo verificar el secreto con Microsoft:", error);
      res.status(502).json({ error: "No se pudo verificar el secreto con Microsoft. Prueba de nuevo en unos minutos." });
      return;
    }
  }

  const record = await savePlatformSecret(key, { expiresOn, note, value });
  invalidatePlatformSecretCache(key);
  res.json({ ...record, origen: await describeSecretSource(key) });
});

/**
 * Deja de seguir el vencimiento: apaga los recordatorios. **No toca el valor
 * guardado** — quitar el aviso no puede dejar a la integración sin secreto.
 */
platformRouter.delete("/secrets/:key", requirePermission(PERMISSIONS.SECRETOS_EDITAR), async (req, res) => {
  const { key } = req.params;
  if (!isTrackedSecretKey(key)) {
    res.status(404).json({ error: "Ese secreto no está en el catálogo." });
    return;
  }
  await clearPlatformSecretExpiry(key);
  res.json({ eliminado: true });
});

/**
 * Quita el valor guardado en la base: desde ahí se usa la variable del `.env`.
 * Si no hay variable que lo respalde, la integración se queda sin secreto, así
 * que se rechaza salvo `?forzar=true`.
 */
platformRouter.delete("/secrets/:key/value", requirePermission(PERMISSIONS.SECRETOS_EDITAR), async (req, res) => {
  const { key } = req.params;
  if (!isTrackedSecretKey(key)) {
    res.status(404).json({ error: "Ese secreto no está en el catálogo." });
    return;
  }

  if (!hasEnvFallback(key) && req.query.forzar !== "true") {
    res.status(409).json({
      error: `Sin el secreto guardado y sin ${TRACKED_SECRETS[key].envVar} en el .env, la integración se queda sin secreto: ninguna clínica podría conectar ni refrescar su cuenta.`,
    });
    return;
  }

  await clearPlatformSecretValue(key);
  invalidatePlatformSecretCache(key);
  res.json({ eliminado: true, origen: await describeSecretSource(key) });
});

/**
 * La app de OAuth de Google de la plataforma: la que usan TODAS las clínicas
 * para conectar su calendario. Vive en la base, así que cargarla o rotarla no
 * pide reiniciar el servidor web ni el worker (ver `PlatformOAuthApp`).
 *
 * **El secreto es de solo escritura**: ninguna respuesta lo devuelve, ni
 * cifrado. Se informa si hay uno guardado y de dónde sale hoy (`origen`).
 */
platformRouter.get("/google-oauth", requirePermission(PERMISSIONS.SECRETOS_VER), async (_req, res) => {
  const stored = await findGoogleOAuthApp();
  const active = await getGoogleOAuthConfig();
  res.json({
    guardado: stored ? { clientId: stored.clientId, redirectUri: stored.redirectUri } : null,
    origen: active?.source ?? "ninguno",
    respaldoEnEnv: hasGoogleOAuthEnvFallback(),
    redirectUriSugerida: `${env.publicBaseUrl}/oauth/google/callback`,
  });
});

/**
 * Comprueba AHORA, contra Google, que la app que está en uso sirve (la guardada o la del
 * `.env`). Es la misma prueba que se hace antes de guardar: un `code` inventado, y Google
 * contesta `invalid_grant` si el par es bueno e `invalid_client` si no. No cambia nada ni
 * necesita una cuenta: sirve para ver "esto sigue funcionando" sin esperar a que una
 * clínica falle al conectar. Una falla de red NO prueba nada sobre el secreto: 502.
 */
platformRouter.post("/google-oauth/verify", requirePermission(PERMISSIONS.SECRETOS_VER), async (_req, res) => {
  const active = await getGoogleOAuthConfig();
  if (!active) {
    res.status(409).json({ error: "No hay ninguna app de Google configurada para verificar." });
    return;
  }
  try {
    const estado = await verifyGoogleOAuthClient({
      clientId: active.clientId,
      clientSecret: active.clientSecret,
      redirectUri: active.redirectUri,
    });
    res.json({ estado, origen: active.source, verificadoEn: new Date().toISOString() });
  } catch (error) {
    res.status(502).json({
      error: `No se pudo hablar con Google para verificarlo (${error instanceof Error ? error.message : "error desconocido"}). Eso no dice nada sobre el secreto: reintenta en un momento.`,
    });
  }
});

/** Guarda la app entera. Sin `clientSecret` se conserva el que ya había. */
platformRouter.put("/google-oauth", requirePermission(PERMISSIONS.SECRETOS_EDITAR), async (req, res) => {
  const clientId = typeof req.body?.clientId === "string" ? req.body.clientId.trim() : "";
  if (clientId.length < 8 || clientId.length > 256 || /\s/.test(clientId)) {
    res.status(400).json({ error: "El ID de cliente no es válido: no puede estar vacío ni llevar espacios." });
    return;
  }

  const redirectUri = typeof req.body?.redirectUri === "string" ? req.body.redirectUri.trim() : "";
  let parsedUri: URL | null = null;
  try {
    parsedUri = new URL(redirectUri);
  } catch {
    parsedUri = null;
  }
  if (!parsedUri || !["http:", "https:"].includes(parsedUri.protocol)) {
    res.status(400).json({ error: "La URI de redirección tiene que ser una URL http(s) completa." });
    return;
  }

  let clientSecret: string | undefined;
  if (req.body?.clientSecret !== undefined && req.body?.clientSecret !== null && req.body?.clientSecret !== "") {
    const parsed = parseSecretValue(req.body.clientSecret);
    if (!parsed) {
      res.status(400).json({ error: "El secreto no es válido: tiene entre 8 y 512 caracteres y no lleva espacios." });
      return;
    }
    clientSecret = parsed;
  }

  // Sin secreto nuevo se prueba con el guardado: cambiar el ID por uno de otra
  // app dejaría el par roto igual que pegar mal el secreto.
  const current = await getGoogleOAuthConfig();
  const secretToVerify = clientSecret ?? (current?.source === "base" ? current.clientSecret : undefined);
  if (!secretToVerify) {
    res.status(400).json({ error: "Falta el secreto del cliente: es obligatorio la primera vez." });
    return;
  }

  // Un par mal pegado desconectaría a todas las clínicas de golpe, así que se
  // prueba contra Google ANTES de guardarlo.
  try {
    if ((await verifyGoogleOAuthClient({ clientId, clientSecret: secretToVerify, redirectUri })) === "invalido") {
      res.status(400).json({
        error: "Google rechazó esas credenciales. Revisa que el ID y el secreto sean del mismo cliente OAuth (tipo \"Aplicación web\").",
      });
      return;
    }
  } catch (error) {
    // No se pudo verificar (red, Google caído): no prueba nada sobre las
    // credenciales, pero tampoco se guardan a ciegas.
    console.error("No se pudo verificar el cliente OAuth con Google:", error);
    res.status(502).json({ error: "No se pudo verificar con Google. Prueba de nuevo en unos minutos." });
    return;
  }

  const record = await saveGoogleOAuthApp({ clientId, redirectUri, clientSecret });
  invalidateGoogleOAuthConfigCache();
  res.json({ guardado: record, origen: (await getGoogleOAuthConfig())?.source ?? "ninguno" });
});

/**
 * Borra la app guardada: desde ahí se usan las variables `GOOGLE_OAUTH_*` del
 * `.env`. Si no hay un respaldo completo, ninguna clínica podría conectar su
 * calendario, así que se rechaza salvo `?forzar=true`. Las cuentas ya
 * conectadas dejan de poder refrescarse sin una app: de ahí el candado.
 */
platformRouter.delete("/google-oauth", requirePermission(PERMISSIONS.SECRETOS_EDITAR), async (req, res) => {
  if (!hasGoogleOAuthEnvFallback() && req.query.forzar !== "true") {
    res.status(409).json({
      error:
        "Sin la app guardada y sin GOOGLE_OAUTH_* completo en el .env, ninguna clínica podría conectar ni refrescar su cuenta de Google.",
    });
    return;
  }
  await deleteGoogleOAuthApp();
  invalidateGoogleOAuthConfigCache();
  res.json({ eliminado: true, origen: (await getGoogleOAuthConfig())?.source ?? "ninguno" });
});

/**
 * Salud del sistema: si el worker está vivo, cuándo corrió cada tarea, qué hay
 * en la cola de mensajes, qué derivaciones no avisaron y cuántos errores hubo
 * en las últimas 24 horas, por tipo y por clínica. Todo sale de Postgres.
 */
platformRouter.get("/monitoring", requirePermission(PERMISSIONS.MONITOREO_VER), async (_req, res) => {
  res.json(await getMonitoringSnapshot());
});

/**
 * Los eventos, del más nuevo al más viejo. `before` (ISO) es el cursor:
 * pasar el `siguiente` de la respuesta anterior trae la página que sigue.
 */
platformRouter.get("/monitoring/events", requirePermission(PERMISSIONS.MONITOREO_VER), async (req, res) => {
  const before = typeof req.query.before === "string" ? new Date(req.query.before) : undefined;
  if (before && Number.isNaN(before.getTime())) {
    res.status(400).json({ error: "`before` tiene que ser una fecha ISO." });
    return;
  }
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;

  res.json(
    await listSystemEvents({
      clinicId: typeof req.query.clinicId === "string" ? req.query.clinicId : undefined,
      kind: typeof req.query.kind === "string" ? req.query.kind : undefined,
      before,
      limit: Number.isFinite(limit) ? limit : undefined,
    })
  );
});

/**
 * Las solicitudes al agente (las llamadas al modelo): cuánto tardó, cuánto costó, cómo
 * terminó y qué decidió, sin el texto. `?turnId=` trae todas las de un mismo mensaje.
 */
platformRouter.get("/monitoring/agent-requests", requirePermission(PERMISSIONS.MONITOREO_VER), async (req, res) => {
  const before = typeof req.query.before === "string" ? new Date(req.query.before) : undefined;
  if (before && Number.isNaN(before.getTime())) {
    res.status(400).json({ error: "`before` tiene que ser una fecha ISO." });
    return;
  }
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  res.json(
    await listAgentRequests({
      clinicId: typeof req.query.clinicId === "string" ? req.query.clinicId : undefined,
      outcome: typeof req.query.outcome === "string" ? req.query.outcome : undefined,
      turnId: typeof req.query.turnId === "string" ? req.query.turnId : undefined,
      before,
      limit: Number.isFinite(limit) ? limit : undefined,
    })
  );
});

/**
 * La auditoría de TODA la plataforma: lo de cada clínica y lo que no es de ninguna
 * (el login, la plataforma). `?clinicId=` acota a una. Solo lectura; consultarla
 * también queda registrado.
 */
platformRouter.get("/audit", requirePermission(PERMISSIONS.AUDITORIA_VER), async (req, res) => {
  const parsed = auditFiltersFromQuery(req.query);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const clinicId = typeof req.query.clinicId === "string" && req.query.clinicId ? req.query.clinicId : undefined;
  res.json(await listAudit({ ...parsed.filters, clinicId }));
});


// --- Costos: consumo y tarifas (solo super-admin; ver services/costs.ts) ---

function rangeFromQuery(req: { query: Record<string, unknown> }, res: { status: (n: number) => { json: (b: unknown) => void } }) {
  const range = parseCostRange({ desde: req.query.desde, hasta: req.query.hasta });
  if ("error" in range) {
    res.status(400).json({ error: range.error });
    return null;
  }
  return range;
}

/** El resumen del rango, global o de una clínica (`?clinicId=`). Las pruebas del chat van aparte. */
platformRouter.get("/costs/summary", requirePermission(PERMISSIONS.COSTOS_VER), async (req, res) => {
  const range = rangeFromQuery(req, res);
  if (!range) return;
  const clinicId = typeof req.query.clinicId === "string" && req.query.clinicId ? req.query.clinicId : undefined;
  res.json(await buildCostSummary(range, clinicId));
});

/** Tokens, mensajes y costo por conversación y por día de UNA clínica. Sin teléfono ni nombre. */
platformRouter.get("/costs/conversations", requirePermission(PERMISSIONS.COSTOS_VER), async (req, res) => {
  const range = rangeFromQuery(req, res);
  if (!range) return;
  const clinicId = typeof req.query.clinicId === "string" ? req.query.clinicId : "";
  if (!clinicId) {
    res.status(400).json({ error: "`clinicId` es obligatorio." });
    return;
  }
  res.json({ filas: await buildConversationCosts(range, clinicId) });
});

/** Cada integración y operación que se mide, con su volumen, su costo y si tiene tarifa. */
platformRouter.get("/costs/inventory", requirePermission(PERMISSIONS.COSTOS_VER), async (req, res) => {
  const range = rangeFromQuery(req, res);
  if (!range) return;
  res.json(await buildInventory(range));
});

platformRouter.get("/costs/rates", requirePermission(PERMISSIONS.COSTOS_VER), async (_req, res) => {
  const [tarifas, cambios] = await Promise.all([
    prisma.costRate.findMany({ orderBy: [{ provider: "asc" }, { item: "asc" }, { effectiveFrom: "desc" }] }),
    prisma.fxRate.findMany({ orderBy: [{ currency: "asc" }, { effectiveFrom: "desc" }] }),
  ]);
  res.json({
    tarifas: tarifas.map((t) => ({
      id: t.id, provider: t.provider, item: t.item, unit: t.unit, priceUsd: Number(t.priceUsd),
      effectiveFrom: t.effectiveFrom.toISOString().slice(0, 10), note: t.note,
    })),
    cambios: cambios.map((c) => ({
      id: c.id, currency: c.currency, unitsPerUsd: Number(c.unitsPerUsd), effectiveFrom: c.effectiveFrom.toISOString().slice(0, 10),
    })),
  });
});

/** Carga una tarifa. Cargar otra para el mismo ítem y fecha la reemplaza; con otra fecha, rige desde ahí. */
platformRouter.put("/costs/rates", requirePermission(PERMISSIONS.COSTOS_EDITAR), async (req, res) => {
  const parsed = validateRateInput((req.body ?? {}) as Record<string, unknown>);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const v = parsed.value;
  const tarifa = await prisma.costRate.upsert({
    where: { item_effectiveFrom: { item: v.item, effectiveFrom: v.effectiveFrom } },
    create: v,
    update: { provider: v.provider, unit: v.unit, priceUsd: v.priceUsd, note: v.note },
  });
  res.json({ id: tarifa.id });
});

platformRouter.delete("/costs/rates/:id", requirePermission(PERMISSIONS.COSTOS_EDITAR), async (req, res) => {
  const { count } = await prisma.costRate.deleteMany({ where: { id: req.params.id } });
  if (count === 0) {
    res.status(404).json({ error: "Tarifa no encontrada." });
    return;
  }
  res.status(204).end();
});

/** Tipo de cambio manual: cuántas unidades de la moneda local vale 1 USD, desde una fecha. */
platformRouter.put("/costs/fx-rates", requirePermission(PERMISSIONS.COSTOS_EDITAR), async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const currency = typeof b.currency === "string" ? b.currency.trim().toUpperCase() : "";
  const fecha = typeof b.effectiveFrom === "string" ? dateKeyToUtcMidnight(b.effectiveFrom) : null;
  if (!/^[A-Z]{3}$/.test(currency)) {
    res.status(400).json({ error: "`currency` tiene que ser un código de 3 letras (ej. MXN)." });
    return;
  }
  if (typeof b.unitsPerUsd !== "number" || !Number.isFinite(b.unitsPerUsd) || b.unitsPerUsd <= 0 || b.unitsPerUsd > 1_000_000) {
    res.status(400).json({ error: "`unitsPerUsd` tiene que ser un número mayor a 0." });
    return;
  }
  if (!fecha) {
    res.status(400).json({ error: "`effectiveFrom` tiene que ser una fecha real AAAA-MM-DD." });
    return;
  }
  const cambio = await prisma.fxRate.upsert({
    where: { currency_effectiveFrom: { currency, effectiveFrom: fecha } },
    create: { currency, unitsPerUsd: b.unitsPerUsd, effectiveFrom: fecha },
    update: { unitsPerUsd: b.unitsPerUsd },
  });
  res.json({ id: cambio.id });
});

platformRouter.delete("/costs/fx-rates/:id", requirePermission(PERMISSIONS.COSTOS_EDITAR), async (req, res) => {
  const { count } = await prisma.fxRate.deleteMany({ where: { id: req.params.id } });
  if (count === 0) {
    res.status(404).json({ error: "Tipo de cambio no encontrado." });
    return;
  }
  res.status(204).end();
});
