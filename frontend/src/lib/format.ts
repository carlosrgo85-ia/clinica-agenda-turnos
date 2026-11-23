export function formatDate(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toLocaleDateString("es", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function formatDateTime(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toLocaleString("es", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Formatea un "dateKey" YYYY-MM-DD (una fecha pura, sin hora ni huso) por
 * texto plano — NUNCA pasarlo por `new Date(...)`: eso lo interpreta como
 * medianoche UTC, y `toLocaleDateString` lo vuelve a convertir a la zona
 * del navegador, corriendo la fecha un día para cualquier huso negativo
 * (ej. Argentina). Mismo criterio que `services/time.ts` en el backend.
 */
export function formatDateKey(dateKey: string): string {
  const [year, month, day] = dateKey.split("-");
  return `${day}/${month}/${year}`;
}

export function formatTime(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
}
