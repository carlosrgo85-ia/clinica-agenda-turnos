import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Users } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "../api/client";
import { useAuth, useEffectiveClinicId } from "../auth/AuthContext";
import { ClinicScopeRequired } from "../components/shell/ClinicScopeRequired";
import { PageContainer } from "../components/shell/PageContainer";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { DateField } from "../components/ui/date-field";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { PageSkeleton } from "../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { formatDate } from "../lib/format";
import { cuandoToca, nombreDelPaciente, type PacienteFila } from "../lib/patients";
import { isoADisplay } from "../lib/date-format";

interface ListaDePacientes {
  pacientes: PacienteFila[];
  total: number;
}

const POR_PAGINA = 50;

/**
 * Los pacientes de la clínica: buscar, abrir la ficha, y ver a quién hay que darle
 * cita para una fecha (los que tienen una próxima cita sugerida en ese rango).
 */
export function PatientsPage() {
  const clinicId = useEffectiveClinicId();
  const { hasPermission } = useAuth();
  const puedeEditar = hasPermission("pacientes.editar");
  const navigate = useNavigate();

  const [q, setQ] = useState("");
  const [soloSugeridos, setSoloSugeridos] = useState(false);
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [pagina, setPagina] = useState(0);
  const [data, setData] = useState<ListaDePacientes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [creando, setCreando] = useState(false);

  const cargar = useCallback(async () => {
    if (!clinicId) return;
    setCargando(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(POR_PAGINA), offset: String(pagina * POR_PAGINA) });
      if (q.trim()) params.set("q", q.trim());
      if (desde) params.set("suggestedFrom", desde);
      if (hasta) params.set("suggestedTo", hasta);
      if (soloSugeridos && !desde && !hasta) params.set("withSuggestion", "true");
      setData(await api.get<ListaDePacientes>(`/dashboard/clinics/${clinicId}/patients?${params}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudieron cargar los pacientes");
    } finally {
      setCargando(false);
    }
  }, [clinicId, q, desde, hasta, soloSugeridos, pagina]);

  // Con una pausa al escribir, para no pedir en cada tecla.
  useEffect(() => {
    const espera = setTimeout(cargar, 250);
    return () => clearTimeout(espera);
  }, [cargar]);

  if (!clinicId) return <ClinicScopeRequired />;
  if (error && !data) return <ErrorState message={error} onRetry={cargar} />;
  if (!data) return <PageSkeleton />;

  const hayFiltroDeFecha = soloSugeridos || Boolean(desde) || Boolean(hasta);
  const paginas = Math.max(1, Math.ceil(data.total / POR_PAGINA));

  return (
    <PageContainer>
      <h1>Pacientes</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        La ficha de cada paciente: sus datos, observaciones y comentarios, lo que se le hizo y cuándo conviene su
        próxima cita.
      </p>

      {puedeEditar && (
        <div style={{ marginBottom: 16 }}>
          {creando ? (
            <NuevoPaciente
              clinicId={clinicId}
              onCerrar={() => setCreando(false)}
              onCreado={(id) => navigate(`/patients/${id}`)}
            />
          ) : (
            <Button onClick={() => setCreando(true)}>Nuevo paciente</Button>
          )}
        </div>
      )}

      <div className="card" style={{ marginBottom: 16, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div className="field" style={{ margin: 0, flex: "2 1 240px" }}>
          <Label htmlFor="pacientes-q">Buscar</Label>
          <Input
            id="pacientes-q"
            placeholder="Nombre, apellido o teléfono"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPagina(0);
            }}
          />
        </div>
        <div className="field" style={{ margin: 0, flex: "0 1 170px" }}>
          <Label htmlFor="pacientes-desde">Próxima cita desde</Label>
          <DateField id="pacientes-desde" value={desde} onChange={(v) => { setDesde(v); setPagina(0); }} />
        </div>
        <div className="field" style={{ margin: 0, flex: "0 1 170px" }}>
          <Label htmlFor="pacientes-hasta">Próxima cita hasta</Label>
          <DateField id="pacientes-hasta" value={hasta} onChange={(v) => { setHasta(v); setPagina(0); }} />
        </div>
        <div className="checkbox-field" style={{ margin: 0 }}>
          <Checkbox
            id="pacientes-sugeridos"
            checked={soloSugeridos}
            onCheckedChange={(v) => { setSoloSugeridos(v === true); setPagina(0); }}
          />
          <Label htmlFor="pacientes-sugeridos">Solo con próxima cita sugerida</Label>
        </div>
      </div>

      {hayFiltroDeFecha && (
        <p className="muted" style={{ marginTop: 0 }}>
          Ordenados por la fecha sugerida, la más próxima primero: es la lista de a quién hay que darle cita.
        </p>
      )}

      {data.pacientes.length === 0 ? (
        <EmptyState
          icon={Users}
          title="Sin pacientes"
          description={
            data.total === 0 && !q && !hayFiltroDeFecha
              ? "Todavía no hay pacientes: se cargan cuando escriben por WhatsApp o desde acá."
              : "Ningún paciente coincide con la búsqueda."
          }
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Paciente</TableHead>
                <TableHead>Teléfono</TableHead>
                <TableHead>Última visita</TableHead>
                <TableHead>Próxima cita</TableHead>
                <TableHead>Próxima cita sugerida</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.pacientes.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <Link to={`/patients/${p.id}`}>
                      <strong>{nombreDelPaciente(p)}</strong>
                    </Link>
                    {p.activePackages > 0 && (
                      <div className="muted" style={{ fontSize: "0.85em" }}>
                        {p.activePackages} paquete{p.activePackages === 1 ? "" : "s"} activo{p.activePackages === 1 ? "" : "s"}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>{p.phone}</TableCell>
                  <TableCell>{p.lastVisitAt ? formatDate(p.lastVisitAt) : "—"}</TableCell>
                  <TableCell>{p.nextAppointmentAt ? formatDate(p.nextAppointmentAt) : "—"}</TableCell>
                  <TableCell>
                    {p.suggestedNextVisitDate ? (
                      <>
                        {isoADisplay(p.suggestedNextVisitDate)}{" "}
                        <span className="muted">({cuandoToca(p.suggestedNextVisitDate)})</span>
                        {p.suggestedNextVisitNote && (
                          <div className="muted" style={{ fontSize: "0.85em" }}>{p.suggestedNextVisitNote}</div>
                        )}
                        {p.outreachOptOut ? (
                          <Badge variant="outline">No contactar</Badge>
                        ) : p.outreachSentAt ? (
                          <Badge variant="secondary">Ya se le escribió</Badge>
                        ) : null}
                      </>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12 }}>
            <span className="muted">
              {data.total} paciente{data.total === 1 ? "" : "s"}
              {cargando ? " · actualizando…" : ""}
            </span>
            {paginas > 1 && (
              <>
                <Button size="sm" variant="outline" disabled={pagina === 0} onClick={() => setPagina((n) => n - 1)}>
                  Anterior
                </Button>
                <span>
                  {pagina + 1} de {paginas}
                </span>
                <Button size="sm" variant="outline" disabled={pagina + 1 >= paginas} onClick={() => setPagina((n) => n + 1)}>
                  Siguiente
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </PageContainer>
  );
}

function NuevoPaciente({
  clinicId,
  onCerrar,
  onCreado,
}: {
  clinicId: string;
  onCerrar: () => void;
  onCreado: (id: string) => void;
}) {
  const [nombre, setNombre] = useState("");
  const [apellido, setApellido] = useState("");
  const [telefono, setTelefono] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function crear(e: FormEvent) {
    e.preventDefault();
    setGuardando(true);
    setError(null);
    try {
      const creado = await api.post<{ id: string }>(`/dashboard/clinics/${clinicId}/patients`, {
        firstName: nombre.trim(),
        lastName: apellido.trim(),
        phone: telefono.trim(),
      });
      toast.success("Paciente cargado.");
      onCreado(creado.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo cargar el paciente");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <form className="card" onSubmit={crear}>
      <h2 style={{ marginTop: 0 }}>Nuevo paciente</h2>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div className="field" style={{ flex: "1 1 180px" }}>
          <Label htmlFor="nuevo-nombre">Nombre</Label>
          <Input id="nuevo-nombre" value={nombre} onChange={(e) => setNombre(e.target.value)} />
        </div>
        <div className="field" style={{ flex: "1 1 180px" }}>
          <Label htmlFor="nuevo-apellido">Apellido</Label>
          <Input id="nuevo-apellido" value={apellido} onChange={(e) => setApellido(e.target.value)} />
        </div>
        <div className="field" style={{ flex: "1 1 220px" }}>
          <Label htmlFor="nuevo-telefono">WhatsApp</Label>
          <Input
            id="nuevo-telefono"
            placeholder="Con código de país, ej. 5215512345678"
            value={telefono}
            onChange={(e) => setTelefono(e.target.value)}
          />
        </div>
      </div>
      {error && <p className="error-text">{error}</p>}
      <div style={{ display: "flex", gap: 8 }}>
        <Button type="submit" disabled={guardando || !nombre.trim() || telefono.replace(/\D/g, "").length < 8}>
          {guardando ? "Guardando…" : "Cargar paciente"}
        </Button>
        <Button type="button" variant="outline" onClick={onCerrar}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
