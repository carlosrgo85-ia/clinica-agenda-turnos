import {
  Users,
  UserRound,
  ShieldCheck,
  CalendarSearch,
  MessageSquare,
  CalendarDays,
  CalendarCog,
  Clock,
  ClipboardList,
  LifeBuoy,
  PartyPopper,
  Settings,
  Globe,
  Building2,
  Library,
  CreditCard,
  BadgeCheck,
  Shield,
  Stethoscope,
  KeyRound,
  Activity,
  Package,
  ScrollText,
  FileBarChart,
  Megaphone,
  FlaskConical,
  Coins,
  Plus,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
  /** Requiere que el usuario tenga este permiso (ver useAuth().hasPermission). */
  permission?: string;
  /** Solo para usuarios de plataforma (`user.clinicId === null`). */
  superadminOnly?: boolean;
  /** Una línea de contexto. La usan las tarjetas de "Catálogos" y la paleta de búsqueda. */
  description?: string;
  /** En qué sección del menú vive (ver `NAV_GROUPS`). Los `CATALOG_ITEMS` no lo llevan: no están en el menú. */
  group?: NavGroupId;
  /**
   * Cómo la llamaría alguien que no sabe cómo se llama la pantalla ("horario de comida", "precio", "obra social"). El
   * buscador los usa además del título. No repetir el título ni escribir frases: palabras que la persona tipearía.
   */
  keywords?: string[];
}

export type NavGroupId = "plataforma" | "dia" | "seguimiento" | "configuracion" | "accesos" | "sistema";

export interface NavGroup {
  id: NavGroupId;
  title: string;
  /** Plegada de entrada. Igual se abre sola si la pantalla actual está adentro. */
  defaultCollapsed: boolean;
}

/**
 * Las secciones del menú, EN ORDEN. El criterio es la frecuencia de uso: lo que se hace todos los días arriba y siempre
 * a la vista; lo que se configura una vez, plegado más abajo; lo técnico y los catálogos al fondo.
 * Una sección sin ningún ítem visible para el usuario no se dibuja.
 */
export const NAV_GROUPS: NavGroup[] = [
  { id: "plataforma", title: "Plataforma", defaultCollapsed: false },
  { id: "dia", title: "Día a día", defaultCollapsed: false },
  { id: "seguimiento", title: "Seguimiento y resultados", defaultCollapsed: false },
  { id: "configuracion", title: "Configuración de la clínica", defaultCollapsed: true },
  { id: "accesos", title: "Accesos", defaultCollapsed: true },
  { id: "sistema", title: "Sistema", defaultCollapsed: true },
];

/**
 * Agregar una pantalla nueva es una entrada más acá — el sidebar, el menú móvil y el buscador la renderizan solos.
 * Hay que darle su `group` (dónde vive) y, si la gente puede llamarla de otra forma, sus `keywords`.
 *
 * El orden de acá es el de cada sección. Las secciones y su orden están en `NAV_GROUPS`.
 */
export const NAV_ITEMS: NavItem[] = [
  // --- Plataforma (solo super-admin) ---
  // Clínicas va suelta y los catálogos agrupados, aunque todas sean pantallas de plataforma: Clínicas es la única
  // operativa —es la puerta de entrada a "entrar a una clínica", que es como el super-admin hace todo lo demás, y el
  // banner y el cartel de "elegí una clínica" mandan de vuelta ahí—.
  { title: "Clínicas", href: "/platform/clinics", icon: Building2, permission: "clinicas.ver", superadminOnly: true, group: "plataforma", description: "Alta y datos de cada clínica; desde acá se entra a una.", keywords: ["listado", "membresía", "plan", "whatsapp de la clínica", "activar", "desactivar"] },
  // El alta va en su propia pantalla: el listado de Clínicas quedaba larguísimo con el formulario adentro.
  { title: "Crear clínica", href: "/platform/clinics/new", icon: Plus, permission: "clinicas.crear", superadminOnly: true, group: "plataforma", description: "Dar de alta una clínica cliente.", keywords: ["alta", "nueva clínica", "agregar clínica", "nuevo cliente", "onboarding"] },
  // Salud del sistema: worker, colas y errores de todas las clínicas. Se mira seguido, no se carga una vez.
  { title: "Monitoreo", href: "/platform/monitoring", icon: Activity, permission: "monitoreo.ver", superadminOnly: true, group: "plataforma", description: "Salud del sistema: tareas, colas y errores.", keywords: ["errores", "worker", "cola", "salud", "fallas"] },
  // Cuánto gasta cada clínica (modelo de IA, WhatsApp, integraciones) y las tarifas con que se calcula.
  { title: "Costos", href: "/platform/costs", icon: Coins, permission: "costos.ver", superadminOnly: true, group: "plataforma", description: "Consumo y costo por clínica; tarifas.", keywords: ["gastos", "tokens", "precio", "tarifas", "facturación", "consumo"] },

  // --- Día a día ---
  { title: "Agenda", href: "/calendar", icon: CalendarDays, permission: "turnos.ver", group: "dia", description: "Las citas del día o de la semana, por profesional.", keywords: ["calendario", "turnos", "agendar", "crear cita", "mover cita", "bloquear horario"] },
  { title: "Citas", href: "/appointments", icon: CalendarSearch, permission: "turnos.ver", group: "dia", description: "Buscar y revisar citas.", keywords: ["turnos", "buscar cita", "cancelar", "listado", "historial de citas"] },
  { title: "Pacientes", href: "/patients", icon: UserRound, permission: "pacientes.ver", group: "dia", description: "Fichas, observaciones e historial.", keywords: ["clientes", "ficha", "historial", "observaciones", "teléfono", "próxima cita"] },
  { title: "Por atender", href: "/escalations", icon: LifeBuoy, permission: "derivaciones.ver", group: "dia", description: "Casos que el asistente pasó a una persona.", keywords: ["derivaciones", "urgencias", "pendientes", "escalamientos", "quejas"] },
  { title: "Conversaciones", href: "/conversations", icon: MessageSquare, permission: "conversaciones.ver", group: "dia", description: "Lo que se habló con cada paciente por WhatsApp.", keywords: ["whatsapp", "chats", "mensajes", "asistente"] },

  // --- Seguimiento y resultados ---
  { title: "Paquetes", href: "/packages", icon: Package, permission: "paquetes.ver", group: "seguimiento", description: "Sesiones prepagas y citas por marcar como atendidas.", keywords: ["sesiones", "marcar atendida", "asistencia", "prepago", "saldo"] },
  { title: "Campañas", href: "/campaigns", icon: Megaphone, permission: "campanas.ver", group: "seguimiento", description: "Promociones y de dónde llegan los pacientes.", keywords: ["promociones", "anuncios", "publicidad", "redes", "sitio web", "cortesía"] },
  { title: "Reportes", href: "/reports", icon: FileBarChart, permission: "reportes.ver", group: "seguimiento", description: "Informes de citas, ocupación, cancelaciones y más.", keywords: ["informes", "métricas", "estadísticas", "cancelaciones", "ocupación", "atendidos", "exportar", "csv"] },

  // --- Configuración de la clínica ---
  { title: "Servicios", href: "/services", icon: ClipboardList, permission: "servicios.ver", group: "configuracion", description: "Qué se ofrece, cuánto dura, cuánto cuesta y quién lo hace.", keywords: ["tratamientos", "precio", "costo", "duración", "diagnóstico inicial", "catálogo"] },
  { title: "Recursos", href: "/resources", icon: Stethoscope, permission: "recursos.ver", group: "configuracion", description: "Profesionales, espacios y equipos.", keywords: ["profesionales", "doctores", "consultorios", "espacios", "equipos", "cabinas", "título"] },
  { title: "Horarios", href: "/working-hours", icon: Clock, permission: "horarios.ver", group: "configuracion", description: "Horario de atención de la clínica y de cada profesional.", keywords: ["horario de atención", "horario de comida", "descanso", "días y horas", "abrir", "cerrar"] },
  { title: "Feriados", href: "/holidays", icon: PartyPopper, permission: "feriados.ver", group: "configuracion", description: "Días en que no se atiende.", keywords: ["días no laborables", "vacaciones", "cerrado", "excepciones"] },
  { title: "Seguros", href: "/insurers", icon: Shield, permission: "seguros.ver", group: "configuracion", description: "Con qué obras sociales y prepagas trabaja la clínica.", keywords: ["obra social", "prepagas", "cobertura", "aseguradoras", "convenios"] },
  // Es la configuración de la integración con Google (a qué calendario se espeja cada profesional), no la vista de
  // citas — esa es "Agenda".
  { title: "Calendarios", href: "/calendars", icon: CalendarCog, permission: "calendarios.ver", group: "configuracion", description: "Conectar Google o Outlook y elegir el calendario de cada profesional.", keywords: ["google calendar", "outlook", "microsoft", "sincronizar", "conectar cuenta", "bloqueos"] },
  { title: "Configuración", href: "/configuration", icon: Settings, permission: "configuracion.ver", group: "configuracion", description: "Datos de la clínica y avisos de lo que falta cargar.", keywords: ["datos de la clínica", "dirección", "whatsapp", "contacto", "avisos", "urgencias"] },
  { title: "Chat de pruebas", href: "/test-chat", icon: FlaskConical, permission: "chat_pruebas.usar", group: "configuracion", description: "Hablar con el asistente sin usar WhatsApp.", keywords: ["probar asistente", "simulador", "probar mensajes", "simulación"] },

  // --- Accesos ---
  { title: "Usuarios", href: "/users", icon: Users, permission: "usuarios.ver", group: "accesos", description: "Quién entra al panel de la clínica.", keywords: ["equipo", "personal", "contraseña", "alta de usuario", "invitar"] },
  { title: "Roles", href: "/roles", icon: ShieldCheck, permission: "roles.ver", group: "accesos", description: "Qué puede hacer cada rol.", keywords: ["permisos", "accesos", "perfiles", "autorización"] },

  // --- Sistema (al fondo: se usan poco y son técnicos) ---
  { title: "Catálogos", href: "/platform/catalogs", icon: Library, superadminOnly: true, group: "sistema", description: "Planes, títulos, seguros, países y secretos de la plataforma.", keywords: ["planes", "países", "títulos", "secretos", "obras sociales", "feriados nacionales"] },
  { title: "Auditoría", href: "/platform/audit", icon: ScrollText, permission: "auditoria.ver", superadminOnly: true, group: "sistema", description: "Quién hizo qué en el sistema.", keywords: ["registro", "quién hizo", "seguridad", "historial de cambios", "logs"] },
];

/**
 * Los catálogos de la plataforma: lo que se administra una vez y vale para
 * todas las clínicas. Con esto la portada (`CatalogsHubPage`) arma su grilla
 * de tarjetas.
 *
 * Están acá y no dentro de la página por dos motivos: cada uno sigue siendo
 * una opción con su propio permiso —un usuario de plataforma puede tener
 * acceso a unos y no a otros, y se filtran con el MISMO `filterNavItems` que
 * el menú—, y la paleta de comandos los suma a su búsqueda para que agrupar
 * no los deje a dos clicks de distancia.
 *
 * **Las rutas cuelgan de `/platform/catalogs/` y no de `/platform/`**: si
 * colgaran de `/platform`, "Catálogos" se marcaría activo también en
 * Clínicas, que ahora es un ítem aparte — `isActiveRoute` mira el prefijo.
 */
export const CATALOG_ITEMS: NavItem[] = [
  {
    title: "Planes",
    href: "/platform/catalogs/plans",
    icon: CreditCard,
    permission: "planes.ver",
    superadminOnly: true,
    description: "Qué funcionalidades incluye cada plan.",
  },
  {
    title: "Títulos",
    href: "/platform/catalogs/titles",
    icon: BadgeCheck,
    permission: "titulos.ver",
    superadminOnly: true,
    description: "Cómo se nombra a un profesional: Dr., Lic., Manicurista.",
  },
  // "Seguros" acá es el catálogo de la plataforma; la pantalla "Seguros" del
  // menú es con cuáles trabaja UNA clínica. Las separa el contexto: esta vive
  // dentro de Catálogos. Mismo cuidado que con "Agenda" y "Calendarios".
  {
    title: "Seguros",
    href: "/platform/catalogs/insurers",
    icon: Shield,
    permission: "seguros.ver",
    superadminOnly: true,
    description: "Catálogo de obras sociales y prepagas de toda la plataforma.",
  },
  {
    title: "Países",
    href: "/platform/catalogs/countries",
    icon: Globe,
    permission: "paises.ver",
    superadminOnly: true,
    description: "Países, su moneda, sus zonas horarias y sus feriados.",
  },
  {
    title: "Secretos",
    href: "/platform/catalogs/secrets",
    icon: KeyRound,
    permission: "secretos.ver",
    superadminOnly: true,
    description: "Cuándo vencen los secretos de las integraciones, con aviso por mail.",
  },
];

/** Activo = la ruta actual es exactamente el href, o un descendiente de él (ej. "/users/123"). */
export function isActiveRoute(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Filtro único que usan Sidebar, MobileNav y CommandPalette — así los tres
 * ven siempre la misma lista de opciones para un usuario dado.
 */
export function filterNavItems(
  items: NavItem[],
  user: { clinicId: string | null; hasPermission: (permission: string) => boolean }
): NavItem[] {
  return items.filter((item) => {
    if (item.superadminOnly && user.clinicId !== null) return false;
    if (item.permission && !user.hasPermission(item.permission)) return false;
    return true;
  });
}

export interface GroupedNav {
  group: NavGroup;
  items: NavItem[];
}

/**
 * El menú ya agrupado y filtrado: las secciones en el orden de `NAV_GROUPS`, cada una con SUS ítems visibles para ese
 * usuario, y sin las que quedaron vacías. Usa el mismo `filterNavItems` que la paleta, así los dos muestran lo mismo.
 */
export function groupNavItems(
  items: NavItem[],
  user: { clinicId: string | null; hasPermission: (permission: string) => boolean }
): GroupedNav[] {
  const visibles = filterNavItems(items, user);
  return NAV_GROUPS.map((group) => ({ group, items: visibles.filter((i) => i.group === group.id) })).filter((g) => g.items.length > 0);
}

/**
 * De varios ítems cuyo `href` es prefijo de la ruta actual, el más específico: "/platform/clinics/new" enciende
 * "Nueva clínica" y no también "Clínicas", cuyo prefijo "/platform/clinics" también coincide. Un solo ítem activo a la vez.
 */
export function activeHref(items: NavItem[], pathname: string): string | null {
  const activos = items.filter((i) => isActiveRoute(pathname, i.href));
  return activos.sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null;
}

/** Si la pantalla actual es de esta sección: es lo que la abre sola aunque el usuario la haya plegado. */
export function groupHasActiveRoute(items: NavItem[], pathname: string): boolean {
  return items.some((i) => isActiveRoute(pathname, i.href));
}
