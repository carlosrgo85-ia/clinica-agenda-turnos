import { useCallback, useEffect, useState } from "react";
import { Package } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { Button } from "../ui/button";
import type { CitaPendienteDePaquete, PendientesDePaquete } from "../../lib/packages";

/** La hora de la cita en la zona del navegador: alcanza para "a qué hora llega". */
function hora(iso: string): string {
  return new Date(iso).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
}

function dia(iso: string): string {
  return new Date(iso).toLocaleDateString("es", { day: "2-digit", month: "2-digit" });
}

/**
 * El recordatorio de la asistente: quién llega hoy por un paquete y qué citas de
 * días anteriores nadie marcó como atendidas.
 *
 * Existe porque la sesión se descuenta SOLO cuando una persona marca la cita
 * como atendida (no al agendar ni de forma automática): si se olvida, el
 * paciente cree que le quedan más sesiones de las que le quedan. Por eso las
 * atrasadas se muestran aparte y no desaparecen al día siguiente.
 *
 * No muestra nada si no hay nada pendiente, y solo a quien tiene
 * `paquetes.ver`: es un panel, no una pantalla, y no tiene que ocupar lugar en
 * una clínica que no usa paquetes.
 */
export function PendingPackagesPanel({ clinicId }: { clinicId: string }) {
  const { hasPermission } = useAuth();
  const puedeVer = hasPermission("paquetes.ver");
  const puedeMarcar = hasPermission("paquetes.gestionar");

  const [data, setData] = useState<PendientesDePaquete | null>(null);
  const [marcando, setMarcando] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      setData(await api.get<PendientesDePaquete>(`/dashboard/clinics/${clinicId}/packages/pending`));
    } catch {
      // Es un recordatorio: si no carga, la pantalla sigue sirviendo igual.
      setData(null);
    }
  }, [clinicId]);

  useEffect(() => {
    if (puedeVer) cargar();
  }, [puedeVer, cargar]);

  if (!puedeVer || !data || data.hoy.length + data.atrasadas.length === 0) return null;

  async function marcar(cita: CitaPendienteDePaquete) {
    setMarcando(cita.id);
    try {
      const r = await api.post<{ paquete: { totalSessions: number; usedSessions: number } | null }>(
        `/dashboard/clinics/${clinicId}/appointments/${cita.id}/attended`
      );
      const quedan = r.paquete ? r.paquete.totalSessions - r.paquete.usedSessions : null;
      toast.success(
        quedan === null
          ? "Cita marcada como atendida."
          : `Cita atendida. Al paciente le quedan ${quedan} sesion${quedan === 1 ? "" : "es"} del paquete.`
      );
      await cargar();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo marcar la cita");
    } finally {
      setMarcando(null);
    }
  }

  function fila(cita: CitaPendienteDePaquete, conDia: boolean) {
    const restantes = cita.package.totalSessions - cita.package.usedSessions;
    return (
      <li
        key={cita.id}
        style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", padding: "6px 0", flexWrap: "wrap" }}
      >
        <span>
          <strong>
            {conDia ? `${dia(cita.startTime)} ` : ""}
            {hora(cita.startTime)}
          </strong>{" "}
          {cita.patient.name ?? cita.patient.phone}
          <span className="muted">
            {" "}
            · {cita.service} · {cita.professional.name} · le quedan {restantes} de {cita.package.totalSessions}
          </span>
        </span>
        {puedeMarcar && (
          <Button size="sm" variant="outline" disabled={marcando === cita.id} onClick={() => marcar(cita)}>
            {marcando === cita.id ? "Marcando…" : "Marcar como atendida"}
          </Button>
        )}
      </li>
    );
  }

  return (
    <section className="card" style={{ marginBottom: 24 }} aria-label="Citas por paquete pendientes">
      <h2 style={{ marginTop: 0, display: "flex", alignItems: "center", gap: 8 }}>
        <Package size={18} aria-hidden /> Citas por paquete
      </h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Marca cada cita como atendida cuando el paciente venga: es lo que descuenta la sesión de su paquete.
      </p>

      {data.atrasadas.length > 0 && (
        <div role="alert" style={{ marginBottom: 12 }}>
          <strong>Sin marcar de días anteriores ({data.atrasadas.length})</strong>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{data.atrasadas.map((c) => fila(c, true))}</ul>
        </div>
      )}

      {data.hoy.length > 0 && (
        <div>
          <strong>Hoy ({data.hoy.length})</strong>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{data.hoy.map((c) => fila(c, false))}</ul>
        </div>
      )}
    </section>
  );
}
