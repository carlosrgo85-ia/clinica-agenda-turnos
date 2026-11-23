import type { PaqueteView } from "./packages";

/** Una fila de `GET .../patients`. */
export interface PacienteFila {
  id: string;
  phone: string;
  name: string | null;
  firstName: string;
  lastName: string;
  /** El nombre y el apellido se dedujeron al partir el nombre completo: conviene revisarlos. */
  nameInferred?: boolean;
  stage: string;
  /** YYYY-MM-DD. */
  suggestedNextVisitDate: string | null;
  suggestedNextVisitNote: string | null;
  outreachOptOut: boolean;
  /** Otros WhatsApp autorizados a consultar sus citas. */
  authorizedPhones: string[];
  /** Cuándo se le escribió por esta sugerencia. */
  outreachSentAt: string | null;
  nextAppointmentAt: string | null;
  lastVisitAt: string | null;
  activePackages: number;
}

/** `GET .../patients/:id`. */
export interface PacienteDetalle {
  paciente: PacienteFila & { observations: string | null; createdAt: string };
  comentarios: Array<{ id: string; authorName: string; text: string; createdAt: string }>;
  citas: Array<{
    id: string;
    startTime: string;
    service: string;
    status: string;
    professional: string;
    attendedAt: string | null;
    package: { serviceName: string } | null;
  }>;
  paquetes: PaqueteView[];
}

/** "María López", o el teléfono si la ficha todavía no tiene nombre. */
export function nombreDelPaciente(p: Pick<PacienteFila, "name" | "phone">): string {
  return p.name?.trim() || p.phone;
}

/** Cuenta regresiva en palabras para una fecha sugerida (YYYY-MM-DD) respecto de hoy. */
export function cuandoToca(fecha: string | null, hoy = new Date()): string | null {
  if (!fecha) return null;
  const objetivo = new Date(`${fecha}T00:00:00`);
  const base = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
  const dias = Math.round((objetivo.getTime() - base.getTime()) / 86_400_000);
  if (dias === 0) return "es hoy";
  if (dias === 1) return "es mañana";
  if (dias > 1) return `en ${dias} días`;
  if (dias === -1) return "venció ayer";
  return `venció hace ${Math.abs(dias)} días`;
}
