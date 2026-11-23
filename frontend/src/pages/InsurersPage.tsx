import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useAuth, useEffectiveClinicId } from "../auth/AuthContext";
import { ClinicScopeRequired } from "../components/shell/ClinicScopeRequired";
import { api, ApiError } from "../api/client";
import { Switch } from "../components/ui/switch";
import { Badge } from "../components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { PageSkeleton } from "../components/ui/skeleton";

interface Seguro {
  id: string;
  name: string;
  /** Si sigue vigente en el catálogo de la plataforma. */
  enCatalogo: boolean;
  /** `true` activo, `false` dado de baja, `null` nunca tomado. */
  active: boolean | null;
}

/**
 * Con qué obras sociales y prepagas trabaja la clínica.
 *
 * Es lo único que el asistente contesta sobre seguros: si trabajan con uno o
 * no. **Qué cubre cada plan no se carga y el bot nunca lo afirma**, porque la
 * cobertura depende del plan del paciente y no de la aseguradora (OSDE 210 y
 * OSDE 450 no cubren lo mismo), así que cualquier dato a nivel clínica sería
 * falso para alguien — y equivocarse acá significa que el paciente llega y
 * tiene que pagar algo que le dijimos que estaba cubierto. Esas preguntas se
 * derivan a una persona.
 *
 * El catálogo lo administra la plataforma para que "OSDE" no exista escrito
 * de tres formas; acá se elige cuáles de esos se toman.
 */
export function InsurersPage() {
  const clinicId = useEffectiveClinicId();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("seguros.editar");

  const [seguros, setSeguros] = useState<Seguro[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!clinicId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<{ seguros: Seguro[] }>(`/dashboard/clinics/${clinicId}/insurers`);
      setSeguros(data.seguros);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudieron cargar los seguros");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinicId]);

  if (!clinicId) return <ClinicScopeRequired />;
  if (loading) return <PageSkeleton />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  async function cambiar(seguro: Seguro, active: boolean) {
    try {
      await api.put(`/dashboard/clinics/${clinicId}/insurers/${seguro.id}`, { active });
      toast.success(active ? `Trabajan con ${seguro.name}.` : `${seguro.name} dado de baja.`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo guardar");
    }
  }

  const activos = seguros.filter((s) => s.active === true).length;

  return (
    <div>
      <h1>Seguros</h1>
      <p className="muted">
        Con qué obras sociales y prepagas trabaja la clínica. El asistente usa esta lista para
        contestar "¿trabajan con tal seguro?" — y solo eso: nunca dice qué cubre un plan ni cuánto
        va a pagar el paciente, porque eso depende del plan de cada persona. Esas preguntas se
        derivan a alguien de la clínica.
      </p>

      {seguros.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="Todavía no hay seguros en el catálogo"
          description="El catálogo lo administra el equipo de la plataforma. Pídeles que carguen los que necesitas y después actívalos aquí."
        />
      ) : (
        <>
          <p className="muted" style={{ fontSize: "0.85em" }}>
            {activos === 0
              ? "No hay ninguno activo: ante la pregunta, el asistente no va a afirmar ni negar nada y va a derivar la consulta a una persona."
              : `${activos} activo(s). Los que estén en gris no se mencionan.`}
          </p>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Seguro</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Trabajan con él</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {seguros.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>{s.name}</TableCell>
                  <TableCell>
                    {s.active === true ? (
                      <Badge variant="outline">Activo</Badge>
                    ) : s.active === false ? (
                      <span className="muted">Dado de baja</span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                    {!s.enCatalogo && (
                      <div className="muted" style={{ fontSize: "0.85em" }}>
                        Ya no está vigente en el catálogo de la plataforma
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={s.active === true}
                      // Uno que salió del catálogo se puede dar de baja pero no
                      // volver a tomar: ya no existe para la plataforma.
                      disabled={!canEdit || (!s.enCatalogo && s.active !== true)}
                      onCheckedChange={(active) => cambiar(s, active)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </div>
  );
}
