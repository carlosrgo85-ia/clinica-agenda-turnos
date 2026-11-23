import { useEffect, useState } from "react";
import { LifeBuoy } from "lucide-react";
import { toast } from "sonner";
import { useAuth, useEffectiveClinicId } from "../auth/AuthContext";
import { ClinicScopeRequired } from "../components/shell/ClinicScopeRequired";
import { api, ApiError } from "../api/client";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Label } from "../components/ui/label";
import { Badge } from "../components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { PageSkeleton } from "../components/ui/skeleton";

type Motivo = "urgencia" | "consulta_clinica" | "otro";

interface EscalationRow {
  id: string;
  patientName: string | null;
  patientPhone: string;
  motivo: Motivo;
  mensaje: string;
  creadaEn: string;
  atendidaEn: string | null;
  atendidaPor: string | null;
  avisadaPorMail: boolean;
}

interface EscalationsResponse {
  derivaciones: EscalationRow[];
  pendientes: number;
}

const MOTIVO_LABEL: Record<Motivo, string> = {
  urgencia: "Urgencia",
  consulta_clinica: "Consulta profesional",
  otro: "Otro",
};

/**
 * El locale va fijo en "es" y no `undefined`: con `undefined` se usa el del
 * navegador, así que la misma derivación se leía "15/09" o "09/15" según
 * quién abriera la pantalla. Y entre esas dos, "09/10" es una fecha válida
 * de las dos formas — nadie se da cuenta de que está leyendo otra cosa.
 * Mismo criterio que `lib/format.ts`.
 */
function cuando(iso: string): string {
  return new Date(iso).toLocaleString("es", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function EscalationsPage() {
  const clinicId = useEffectiveClinicId();
  const { hasPermission } = useAuth();
  const canManage = hasPermission("derivaciones.gestionar");

  const [data, setData] = useState<EscalationsResponse | null>(null);
  const [incluirAtendidas, setIncluirAtendidas] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!clinicId) return;
    setLoading(true);
    setError(null);
    try {
      setData(
        await api.get<EscalationsResponse>(
          `/dashboard/clinics/${clinicId}/escalations?incluirResueltas=${incluirAtendidas}`
        )
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo cargar la lista");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinicId, incluirAtendidas]);

  if (!clinicId) return <ClinicScopeRequired />;

  async function cambiarEstado(row: EscalationRow, atender: boolean) {
    try {
      await api.put(
        `/dashboard/clinics/${clinicId}/escalations/${row.id}/${atender ? "resolve" : "reopen"}`,
        {}
      );
      toast.success(atender ? "Marcado como atendido." : "Se reabrió el caso.");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo actualizar");
    }
  }

  return (
    <div>
      <h1>Por atender</h1>
      <p className="muted">
        Cuando el asistente no puede resolver algo solo, le dice al paciente que alguien de la
        clínica lo va a contactar. Esas conversaciones quedan aquí hasta que se marquen como
        atendidas.
      </p>

      <div className="checkbox-field" style={{ margin: "16px 0" }}>
        <Checkbox
          id="incluir-atendidas"
          checked={incluirAtendidas}
          onCheckedChange={(v) => setIncluirAtendidas(v === true)}
        />
        <Label htmlFor="incluir-atendidas">Mostrar también las ya atendidas</Label>
      </div>

      {loading ? (
        <PageSkeleton />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !data || data.derivaciones.length === 0 ? (
        <EmptyState
          icon={LifeBuoy}
          title={incluirAtendidas ? "No hay nada registrado" : "No hay nada por atender"}
          description="Cuando el asistente derive una urgencia o una consulta que necesite criterio profesional, va a aparecer aquí."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Cuándo</TableHead>
              <TableHead>Motivo</TableHead>
              <TableHead>Quién</TableHead>
              <TableHead>Qué escribió</TableHead>
              <TableHead>Estado</TableHead>
              {canManage && <TableHead></TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.derivaciones.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="muted">{cuando(row.creadaEn)}</TableCell>
                <TableCell>
                  <Badge variant={row.motivo === "urgencia" ? "destructive" : "secondary"}>
                    {MOTIVO_LABEL[row.motivo]}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div>{row.patientName ?? "Sin nombre"}</div>
                  <div className="muted">{row.patientPhone}</div>
                </TableCell>
                <TableCell style={{ maxWidth: 320 }}>{row.mensaje}</TableCell>
                <TableCell>
                  {row.atendidaEn ? (
                    <span className="muted">Atendida por {row.atendidaPor ?? "alguien"}</span>
                  ) : (
                    <div>
                      <Badge variant="outline">Pendiente</Badge>
                      {/* Un pendiente sin aviso es el peor caso: nadie se enteró
                          salvo que esté mirando esta pantalla. */}
                      {!row.avisadaPorMail && (
                        <div style={{ color: "var(--destructive)", fontSize: "0.9em", marginTop: 4 }}>
                          No se pudo avisar por mail
                        </div>
                      )}
                    </div>
                  )}
                </TableCell>
                {canManage && (
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => cambiarEstado(row, !row.atendidaEn)}
                    >
                      {row.atendidaEn ? "Reabrir" : "Marcar atendida"}
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
