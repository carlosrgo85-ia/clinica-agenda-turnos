/**
 * Catálogo fijo de funcionalidades que un `Plan` puede incluir. Es la
 * única fuente de verdad, igual que `PERMISSIONS`/`PERMISSION_CATALOG` en
 * `permissions.ts`: los super-admins arman planes combinando estas
 * features desde la pantalla de plataforma "Planes", pero no pueden crear
 * una feature nueva ahí — una feature nueva requiere código real detrás,
 * así que se agrega acá.
 */

export const PLAN_FEATURES = {
  DEPOSIT: "deposito_sena",
  REMINDER_2H: "recordatorio_2h",
  POST_VISIT_FOLLOWUP: "seguimiento_post_visita",
  NEXT_VISIT_OUTREACH: "contacto_proxima_cita",
  CAMPAIGN_FOLLOWUP: "seguimiento_campanas",
} as const;

export type PlanFeatureKey = (typeof PLAN_FEATURES)[keyof typeof PLAN_FEATURES];

interface PlanFeatureDefinition {
  id: PlanFeatureKey;
  description: string;
}

export const PLAN_FEATURE_CATALOG: PlanFeatureDefinition[] = [
  { id: PLAN_FEATURES.DEPOSIT, description: "Cobro de seña/adelanto al agendar" },
  { id: PLAN_FEATURES.REMINDER_2H, description: "Recordatorio adicional a las 2 horas" },
  { id: PLAN_FEATURES.POST_VISIT_FOLLOWUP, description: "Seguimiento post-consulta" },
  { id: PLAN_FEATURES.NEXT_VISIT_OUTREACH, description: "Contactar al paciente cuando se acerca su próxima cita sugerida" },
  { id: PLAN_FEATURES.CAMPAIGN_FOLLOWUP, description: "Seguimiento de quienes llegaron por una campaña y no agendaron" },
];

export const ALL_PLAN_FEATURE_IDS: PlanFeatureKey[] = PLAN_FEATURE_CATALOG.map((f) => f.id);

/**
 * ¿El plan de la clínica incluye la funcionalidad? Es la ÚNICA forma de preguntarlo: los jobs y las
 * rutas no leen `plan.features` por su cuenta. `plan` tiene que venir en la consulta
 * (`include: { plan: true }`); sin él la respuesta es "no", que es el lado seguro.
 */
export function planIncludes(
  clinic: { plan?: { features: string[] } | null },
  feature: PlanFeatureKey
): boolean {
  return clinic.plan?.features.includes(feature) ?? false;
}
