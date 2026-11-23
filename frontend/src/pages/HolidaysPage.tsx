import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { PartyPopper } from "lucide-react";
import { useAuth, useEffectiveClinicId } from "../auth/AuthContext";
import { ClinicScopeRequired } from "../components/shell/ClinicScopeRequired";
import { api, ApiError } from "../api/client";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { StatusBadge } from "../components/ui/status-badge";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { PageSkeleton } from "../components/ui/skeleton";
import { formatDateKey } from "../lib/format";

interface HolidaysResponse {
  year: number;
  aniosRelevantes: number[];
  country: string | null;
  paisSoportado: boolean;
  paisesSoportados: Array<{ id: string; name: string }>;
  pendientes: number;
  feriados: Array<{ dateKey: string; name: string; yaCargado: boolean }>;
}

export function HolidaysPage() {
  const { hasPermission } = useAuth();
  const clinicId = useEffectiveClinicId();
  const canEdit = hasPermission("feriados.editar");

  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [data, setData] = useState<HolidaysResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [applying, setApplying] = useState(false);

  async function load() {
    if (!clinicId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.get<HolidaysResponse>(`/dashboard/clinics/${clinicId}/holidays?year=${year}`);
      setData(result);
      setSelected([]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudieron cargar los feriados");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinicId, year]);

  if (!clinicId) {
    return <ClinicScopeRequired />;
  }
  if (loading) return <PageSkeleton />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return null;

  async function apply(dateKeys?: string[]) {
    setApplying(true);
    try {
      const result = await api.post<{ cargados: string[]; omitidos: string[] }>(
        `/dashboard/clinics/${clinicId}/holidays/apply`,
        { year, dateKeys }
      );
      toast.success(`Se cargaron ${result.cargados.length} feriado(s).`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudieron aplicar los feriados");
    } finally {
      setApplying(false);
    }
  }

  // Siempre el año en curso y el siguiente: `aniosRelevantes` suma el año que viene recién desde diciembre (para el aviso),
  // pero cargar el calendario del año próximo con tiempo tiene que ser posible desde cualquier fecha.
  const thisYear = new Date().getFullYear();
  const years = [...new Set([...data.aniosRelevantes, thisYear, thisYear + 1, year])].sort();
  const countryName = data.paisesSoportados.find((p) => p.id === data.country)?.name;

  return (
    <div>
      <h1>Feriados</h1>

      {data.country && (
        <p className="muted" style={{ marginTop: -8, marginBottom: 16 }}>
          País: {countryName ?? data.country} ({data.country}){" "}
          <Link to="/configuration">cambiar</Link>
        </p>
      )}

      <div style={{ marginBottom: 16 }}>
        <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
          <SelectTrigger style={{ width: 140 }}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {years.map((y) => (
              <SelectItem key={y} value={String(y)}>
                {y}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!data.country || !data.paisSoportado ? (
        <EmptyState
          icon={PartyPopper}
          title="Falta configurar el país"
          description="El catálogo de feriados nacionales depende del país de la clínica."
          action={
            <Link to="/configuration">
              <Button variant="outline" size="sm">
                Ir a Configuración
              </Button>
            </Link>
          }
        />
      ) : data.feriados.length === 0 ? (
        <EmptyState icon={PartyPopper} title="Sin feriados para este año" />
      ) : (
        <>
          {canEdit && data.pendientes > 0 && (
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <Button size="sm" disabled={selected.length === 0 || applying} onClick={() => apply(selected)}>
                Aplicar seleccionados ({selected.length})
              </Button>
              <Button size="sm" variant="outline" disabled={applying} onClick={() => apply(undefined)}>
                Aplicar todos los pendientes ({data.pendientes})
              </Button>
            </div>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                {canEdit && <TableHead></TableHead>}
                <TableHead>Fecha</TableHead>
                <TableHead>Feriado</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.feriados.map((f) => (
                <TableRow key={f.dateKey}>
                  {canEdit && (
                    <TableCell>
                      {!f.yaCargado && (
                        <Checkbox
                          checked={selected.includes(f.dateKey)}
                          onCheckedChange={(checked) =>
                            setSelected((prev) =>
                              checked ? [...prev, f.dateKey] : prev.filter((d) => d !== f.dateKey)
                            )
                          }
                        />
                      )}
                    </TableCell>
                  )}
                  <TableCell>{formatDateKey(f.dateKey)}</TableCell>
                  <TableCell>{f.name}</TableCell>
                  <TableCell>
                    <StatusBadge status={f.yaCargado ? "yaCargado" : "pendiente"} />
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
