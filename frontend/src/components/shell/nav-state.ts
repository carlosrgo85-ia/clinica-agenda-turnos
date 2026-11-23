/**
 * Lo que el menú recuerda en el navegador de cada persona: qué secciones dejó abiertas o plegadas y las últimas
 * pantallas que visitó. Es una comodidad por usuario, nunca algo que tenga que persistir: cada acceso al
 * `localStorage` va envuelto, porque puede fallar o estar vacío (ventana privada, datos bloqueados).
 */

const GROUPS_KEY = "pontic-nav-groups";
const RECENTS_KEY = "pontic-nav-recents";
export const MAX_RECENTS = 5;
/** El evento con que cualquier botón abre el buscador (⌘K, la lupa del menú, la barra móvil). */
export const OPEN_PALETTE_EVENT = "open-command-palette";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // sin almacenamiento: el menú funciona igual, solo no recuerda
  }
}

/** `true` = abierta, `false` = plegada; ausente = rige el `defaultCollapsed` de la sección. */
export function readGroupState(): Record<string, boolean> {
  const v = read<unknown>(GROUPS_KEY, {});
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, boolean>) : {};
}

export function writeGroupState(state: Record<string, boolean>): void {
  write(GROUPS_KEY, state);
}

export function readRecents(): string[] {
  const v = read<unknown>(RECENTS_KEY, []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, MAX_RECENTS) : [];
}

/** Anota una pantalla como la más reciente: sin repetir, la última primero, hasta `MAX_RECENTS`. */
export function pushRecent(href: string, current: string[] = readRecents()): string[] {
  const next = [href, ...current.filter((h) => h !== href)].slice(0, MAX_RECENTS);
  write(RECENTS_KEY, next);
  return next;
}

export function openCommandPalette(): void {
  window.dispatchEvent(new Event(OPEN_PALETTE_EVENT));
}
