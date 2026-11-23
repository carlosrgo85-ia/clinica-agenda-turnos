/**
 * El inventario de lo que consume y puede costar: cada integración y cada operación que se mide en
 * `UsageEvent` / `AgentRequest`, y cómo se tarifa. Vive en el código (como `tracked-secrets.ts`): sumar
 * una integración es una entrada más acá y su punto de registro en el código.
 *
 * **No trae precios.** Las tarifas son datos (`CostRate`) que carga el super-admin desde la tarifa vigente de
 * cada proveedor: un precio escrito acá se desactualiza sin que nadie se entere.
 */

export type RateUnit = "usd_por_millon_tokens" | "usd_por_mensaje" | "usd_por_llamada";

export interface CostCatalogEntry {
  /** Clave estable: `<provider>:<kind>`. Es la que une el evento con su fila del inventario. */
  key: string;
  provider: string;
  providerLabel: string;
  /** Qué operación es, en palabras de la pantalla. */
  label: string;
  /** Cómo se cobra, para explicarlo en la pantalla. */
  billing: string;
  unit: RateUnit | null;
  /** Gratis por definición del proveedor (dentro de cuota): el costo es 0, no "sin tarifa". */
  free: boolean;
  /** Dónde se registra, para quien tenga que sumar o auditar un punto. */
  recordedIn: string;
}

export const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Modelo de IA (Anthropic)",
  whatsapp: "WhatsApp (Meta)",
  google_places: "Google Places",
  google_calendar: "Google Calendar",
  microsoft_graph: "Microsoft Graph (Outlook)",
};

export const COST_CATALOG: CostCatalogEntry[] = [
  {
    key: "anthropic:llamada",
    provider: "anthropic",
    providerLabel: PROVIDER_LABELS.anthropic,
    label: "Llamada al modelo (interpretar, reinterpretar, explicar un fallo)",
    billing: "Por tokens de entrada, de salida y de caché, según el modelo. Una tarifa por modelo y por tipo de token.",
    unit: "usd_por_millon_tokens",
    free: false,
    recordedIn: "services/agent-requests.ts → recordAgentRequest()",
  },
  {
    key: "whatsapp:plantilla",
    provider: "whatsapp",
    providerLabel: PROVIDER_LABELS.whatsapp,
    label: "Mensaje de plantilla (lo inicia la clínica: recordatorios, avisos, seguimientos)",
    billing: "Meta cobra por mensaje de plantilla según su categoría (utilidad, marketing, autenticación) y el país del destinatario.",
    unit: "usd_por_mensaje",
    free: false,
    recordedIn: "services/whatsapp.ts → sendTemplateMessage()",
  },
  {
    key: "whatsapp:texto",
    provider: "whatsapp",
    providerLabel: PROVIDER_LABELS.whatsapp,
    label: "Mensaje de texto libre (respuesta dentro de la ventana de 24 h)",
    billing: "Mensaje de servicio. Meta hoy no lo cobra; si cambia, se carga la tarifa 'whatsapp:service:*'.",
    unit: "usd_por_mensaje",
    free: true,
    recordedIn: "services/whatsapp.ts → sendTextMessage()",
  },
  {
    key: "google_places:text_search",
    provider: "google_places",
    providerLabel: PROVIDER_LABELS.google_places,
    label: "Buscar el negocio por nombre (Text Search)",
    billing: "Google cobra por llamada según los campos pedidos. Solo se usa al dar de alta o editar una clínica con 'Traer datos de Google'.",
    unit: "usd_por_llamada",
    free: false,
    recordedIn: "services/google-places.ts → findPlaceId()",
  },
  {
    key: "google_places:place_details",
    provider: "google_places",
    providerLabel: PROVIDER_LABELS.google_places,
    label: "Traer el detalle del negocio (Place Details)",
    billing: "Google cobra por llamada según los campos pedidos (aquí: dirección, teléfono, sitio, horario y zona horaria).",
    unit: "usd_por_llamada",
    free: false,
    recordedIn: "services/google-places.ts → fetchPlaceDetails()",
  },
  {
    key: "google_calendar:crear_evento",
    provider: "google_calendar",
    providerLabel: PROVIDER_LABELS.google_calendar,
    label: "Crear el evento espejo de una cita",
    billing: "Gratis dentro de la cuota de la API. Se cuenta el volumen, no el costo.",
    unit: null,
    free: true,
    recordedIn: "services/calendar.ts → mirrorAppointmentToCalendar()",
  },
  {
    key: "google_calendar:borrar_evento",
    provider: "google_calendar",
    providerLabel: PROVIDER_LABELS.google_calendar,
    label: "Borrar el evento espejo de una cita",
    billing: "Gratis dentro de la cuota de la API. Se cuenta el volumen, no el costo.",
    unit: null,
    free: true,
    recordedIn: "services/calendar.ts → removeMirroredEvent()",
  },
  {
    key: "microsoft_graph:crear_evento",
    provider: "microsoft_graph",
    providerLabel: PROVIDER_LABELS.microsoft_graph,
    label: "Crear el evento espejo de una cita (Outlook)",
    billing: "Sin costo por llamada. Se cuenta el volumen.",
    unit: null,
    free: true,
    recordedIn: "services/calendar.ts → mirrorAppointmentToCalendar()",
  },
  {
    key: "microsoft_graph:borrar_evento",
    provider: "microsoft_graph",
    providerLabel: PROVIDER_LABELS.microsoft_graph,
    label: "Borrar el evento espejo de una cita (Outlook)",
    billing: "Sin costo por llamada. Se cuenta el volumen.",
    unit: null,
    free: true,
    recordedIn: "services/calendar.ts → removeMirroredEvent()",
  },
];

/**
 * Lo que NO se registra fila por fila, para que nadie lo busque: el sync de bloqueos
 * (`jobs/calendar-sync.ts`) lee cada calendario cada 15 minutos —cientos de llamadas por día por
 * calendario— y es gratis; una fila por lectura llenaría la tabla sin decir nada útil.
 */
export const UNMETERED_NOTES: string[] = [
  "Lectura de bloqueos de Google Calendar / Outlook (cada 15 minutos por calendario): gratis, no se registra fila por llamada.",
  "Servidor, base de datos, dominio y correo: costos fijos, todavía no se cargan (pendiente).",
];
