import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { CheckCircle2 } from "lucide-react";
import { useAuth, useEffectiveClinicId } from "../auth/AuthContext";
import { ClinicScopeRequired } from "../components/shell/ClinicScopeRequired";
import { api, ApiError } from "../api/client";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { ErrorState } from "../components/ui/error-state";
import { PageSkeleton } from "../components/ui/skeleton";

interface ConfigIssue {
  code: "sin_horario_de_atencion" | "feriados_sin_cargar" | "sin_pais_configurado" | "sin_calendario_enlazado" | "calendario_revocado";
  severidad: "bloqueante" | "advertencia";
  mensaje: string;
  accion: string;
  datos?: { paisesSoportados?: Array<{ id: string; name: string }>; sugerido?: string | null };
}

interface ConfigHealth {
  clinicName: string;
  ok: boolean;
  issues: ConfigIssue[];
  country: string | null;
  paisesSoportados: Array<{ id: string; name: string }>;
}

const ISSUE_LINKS: Partial<Record<ConfigIssue["code"], { to: string; label: string }>> = {
  feriados_sin_cargar: { to: "/holidays", label: "Ir a Feriados" },
  sin_horario_de_atencion: { to: "/working-hours", label: "Ir a Horarios" },
  sin_calendario_enlazado: { to: "/calendars", label: "Ir a Calendarios" },
  calendario_revocado: { to: "/calendars", label: "Reconectar en Calendarios" },
};

export function ConfigurationPage() {
  const { hasPermission } = useAuth();
  const clinicId = useEffectiveClinicId();
  const canEdit = hasPermission("configuracion.editar");

  const [health, setHealth] = useState<ConfigHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!clinicId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<ConfigHealth>(`/dashboard/clinics/${clinicId}/config-health`);
      setHealth(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo cargar el estado de configuración");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinicId]);

  if (!clinicId) {
    return <ClinicScopeRequired />;
  }
  if (loading) return <PageSkeleton />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!health) return null;

  async function saveCountry(country: string) {
    try {
      await api.put(`/dashboard/clinics/${clinicId}/country`, { country });
      toast.success("País guardado.");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo guardar el país");
    }
  }

  return (
    <div>
      <h1>Configuración</h1>

      <div className="card" style={{ marginBottom: 16 }}>
        <h4 style={{ marginTop: 0 }}>País de la clínica</h4>
        <p className="muted">Determina qué feriados nacionales se le sugieren en la pantalla de Feriados.</p>
        {canEdit ? (
          <CountrySelector
            options={health.paisesSoportados}
            suggested={health.country}
            onSave={saveCountry}
          />
        ) : (
          <p>{health.paisesSoportados.find((c) => c.id === health.country)?.name ?? health.country ?? "Sin configurar"}</p>
        )}
      </div>

      {health.ok ? (
        <div className="card" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <CheckCircle2 size={20} color="var(--primary)" />
          <span>La configuración de {health.clinicName} está completa.</span>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {health.issues.map((issue) => (
            <div key={issue.code} className="card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                <div>
                  <Badge variant={issue.severidad === "bloqueante" ? "destructive" : "outline"}>
                    {issue.severidad === "bloqueante" ? "Acción requerida" : "Pendiente"}
                  </Badge>
                  <p style={{ marginBottom: 4 }}>{issue.mensaje}</p>
                  <p className="muted">{issue.accion}</p>
                </div>
              </div>

              {ISSUE_LINKS[issue.code] && (
                <Link to={ISSUE_LINKS[issue.code]!.to}>
                  <Button variant="outline" size="sm" style={{ marginTop: 12 }}>
                    {ISSUE_LINKS[issue.code]!.label}
                  </Button>
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CountrySelector({
  options,
  suggested,
  onSave,
}: {
  options: Array<{ id: string; name: string }>;
  suggested: string | null;
  onSave: (country: string) => void;
}) {
  const [value, setValue] = useState(suggested ?? "");

  return (
    <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
      <Select value={value} onValueChange={setValue}>
        <SelectTrigger style={{ width: 220 }}>
          <SelectValue placeholder="Elegir país…" />
        </SelectTrigger>
        <SelectContent>
          {options.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button size="sm" disabled={!value} onClick={() => onSave(value)}>
        Guardar
      </Button>
    </div>
  );
}
