/** Lo que devuelve `GET .../packages`: un paquete con lo que le queda. */
export interface PaqueteView {
  id: string;
  patientId: string;
  /** El nombre con el que se vendió (copia del del catálogo); null en los anteriores al catálogo. */
  name: string | null;
  serviceName: string;
  serviceId: string | null;
  totalSessions: number;
  usedSessions: number;
  purchasedAt: string;
  active: boolean;
  notes: string | null;
  patient: { name: string | null; phone: string };
  capacity: {
    total: number;
    /** Ya descontadas: una persona confirmó que se cumplieron. */
    used: number;
    /** Agendadas sin confirmar: van a consumir una sesión. */
    reserved: number;
    /** total − used − reserved. Negativo si se agendó de más. */
    available: number;
  };
}

/** Una cita que viene por un paquete y nadie marcó como atendida. */
export interface CitaPendienteDePaquete {
  id: string;
  startTime: string;
  endTime: string;
  service: string;
  patient: { id: string; name: string | null; phone: string };
  professional: { name: string };
  package: { id: string; serviceName: string; totalSessions: number; usedSessions: number };
}

export interface PendientesDePaquete {
  hoy: CitaPendienteDePaquete[];
  atrasadas: CitaPendienteDePaquete[];
}

/** "Le quedan 3 de 6" — sin contar las ya agendadas, que se muestran aparte. */
export function resumenDeSesiones(c: PaqueteView["capacity"]): string {
  const libres = Math.max(c.available, 0);
  const partes = [`${c.used} de ${c.total} usadas`];
  if (c.reserved > 0) partes.push(`${c.reserved} agendada${c.reserved === 1 ? "" : "s"}`);
  partes.push(`${libres} libre${libres === 1 ? "" : "s"}`);
  if (c.available < 0) partes.push("agendadas de más");
  return partes.join(" · ");
}

/** Un paquete del catálogo de la clínica (`GET .../package-templates`). */
export interface PlantillaDePaquete {
  id: string;
  name: string;
  serviceId: string;
  serviceName: string;
  totalSessions: number;
  active: boolean;
  notes: string | null;
  /** A cuántos pacientes se asignó. */
  asignados: number;
}
