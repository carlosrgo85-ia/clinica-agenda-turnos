import { useEffect, useState, type FormEvent } from "react";
import { CalendarSearch } from "lucide-react";
import { useEffectiveClinicId } from "../auth/AuthContext";
import { ClinicScopeRequired } from "../components/shell/ClinicScopeRequired";
import { api, ApiError } from "../api/client";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { DateField } from "../components/ui/date-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Label } from "../components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { StatusBadge, type Status } from "../components/ui/status-badge";
import { Badge } from "../components/ui/badge";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { PageSkeleton } from "../components/ui/skeleton";
import { formatDateTime } from "../lib/format";
import { PendingPackagesPanel } from "../components/packages/PendingPackagesPanel";

interface AppointmentRow {
  id: string;
  service: string;
  startTime: string;
  endTime: string;
  status: string;
  depositPaid: boolean;
  /** Al profesional no le tocó su espacio habitual porque estaba ocupado. */
  preferredRoomUnavailable?: boolean;
  patient: { name: string | null; phone: string };
  professional: { name: string };
  room: { name: string };
  resource: { name: string; type: string } | null;
  /** Viene por un paquete; la sesión se descontó si `attendedAt` tiene fecha. */
  package?: { serviceName: string; totalSessions: number; usedSessions: number } | null;
  attendedAt?: string | null;
}

/** Lo que devuelve `GET .../appointments/filters`. */
interface OpcionesDeFiltro {
  estados: string[];
  servicios: string[];
  profesionales: Array<{ id: string; name: string }>;
  espacios: Array<{ id: string; name: string }>;
}

/**
 * "Todos" no puede ser "" como valor: Radix Select usa el string vacío
 * internamente para "sin selección" y la opción no se podría elegir.
 */
const TODOS = "__todos__";

const ESTADO_LABELS: Record<string, string> = {
  confirmado: "Confirmado",
  cancelado: "Cancelado",
  atendido: "Cita cumplida (automático)",
};

export function AppointmentsPage() {
  const clinicId = useEffectiveClinicId();

  const [q, setQ] = useState("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [estado, setEstado] = useState(TODOS);
  const [servicio, setServicio] = useState(TODOS);
  const [professionalId, setProfessionalId] = useState(TODOS);
  const [roomId, setRoomId] = useState(TODOS);
  const [opciones, setOpciones] = useState<OpcionesDeFiltro | null>(null);
  const [results, setResults] = useState<AppointmentRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * Va antes del `return` de abajo porque un hook no puede quedar detrás de
   * un return condicional. Si la clínica todavía no está resuelta no se
   * pide nada, y los desplegables quedan solo con "Todos".
   */
  useEffect(() => {
    if (!clinicId) return;
    api
      .get<OpcionesDeFiltro>(`/dashboard/clinics/${clinicId}/appointments/filters`)
      .then(setOpciones)
      // No se muestra un error: sin opciones la pantalla sigue sirviendo
      // para buscar por texto y por fecha.
      .catch(() => setOpciones(null));
  }, [clinicId]);

  if (!clinicId) {
    return <ClinicScopeRequired />;
  }

  async function runSearch() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (desde) params.set("desde", desde);
      if (hasta) params.set("hasta", hasta);
      if (estado !== TODOS) params.set("estado", estado);
      if (servicio !== TODOS) params.set("servicio", servicio);
      if (professionalId !== TODOS) params.set("professionalId", professionalId);
      if (roomId !== TODOS) params.set("roomId", roomId);
      const data = await api.get<AppointmentRow[]>(
        `/dashboard/clinics/${clinicId}/appointments/search?${params.toString()}`
      );
      setResults(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo buscar");
    } finally {
      setLoading(false);
    }
  }

  function handleSearch(e: FormEvent) {
    e.preventDefault();
    runSearch();
  }

  return (
    <div>
      <h1>Citas</h1>

      {/* El recordatorio de la asistente: quién llega hoy por un paquete y qué
          citas quedaron sin marcar como atendidas. */}
      <PendingPackagesPanel clinicId={clinicId} />

      <form className="card" onSubmit={handleSearch} style={{ marginBottom: 24, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div className="field" style={{ marginBottom: 0, flex: "1 1 220px" }}>
          <Label htmlFor="q">Id, teléfono o nombre</Label>
          <Input id="q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ej. 54911..." />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <Label htmlFor="desde">Desde</Label>
          <DateField id="desde" value={desde} onChange={setDesde} />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <Label htmlFor="hasta">Hasta</Label>
          <DateField id="hasta" value={hasta} onChange={setHasta} />
        </div>
        <div className="field" style={{ marginBottom: 0, flex: "1 1 150px" }}>
          <Label htmlFor="estado">Estado</Label>
          <Select value={estado} onValueChange={(v) => v && setEstado(v)}>
            <SelectTrigger id="estado">
              <SelectValue>{estado === TODOS ? "Todos" : ESTADO_LABELS[estado] ?? estado}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TODOS}>Todos</SelectItem>
              {(opciones?.estados ?? []).map((e) => (
                <SelectItem key={e} value={e}>
                  {ESTADO_LABELS[e] ?? e}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="field" style={{ marginBottom: 0, flex: "1 1 170px" }}>
          <Label htmlFor="servicio">Servicio</Label>
          <Select value={servicio} onValueChange={(v) => v && setServicio(v)}>
            <SelectTrigger id="servicio">
              <SelectValue>{servicio === TODOS ? "Todos" : servicio}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TODOS}>Todos</SelectItem>
              {(opciones?.servicios ?? []).map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="field" style={{ marginBottom: 0, flex: "1 1 170px" }}>
          <Label htmlFor="profesional">Profesional</Label>
          <Select value={professionalId} onValueChange={(v) => v && setProfessionalId(v)}>
            <SelectTrigger id="profesional">
              <SelectValue>
                {professionalId === TODOS
                  ? "Todos"
                  : opciones?.profesionales.find((p) => p.id === professionalId)?.name}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TODOS}>Todos</SelectItem>
              {(opciones?.profesionales ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="field" style={{ marginBottom: 0, flex: "1 1 150px" }}>
          <Label htmlFor="espacio">Espacio</Label>
          <Select value={roomId} onValueChange={(v) => v && setRoomId(v)}>
            <SelectTrigger id="espacio">
              <SelectValue>
                {roomId === TODOS ? "Todos" : opciones?.espacios.find((r) => r.id === roomId)?.name}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TODOS}>Todos</SelectItem>
              {(opciones?.espacios ?? []).map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button type="submit" disabled={loading}>
          <CalendarSearch size={16} />
          {loading ? "Buscando…" : "Buscar"}
        </Button>
      </form>

      {loading ? (
        <PageSkeleton />
      ) : error ? (
        <ErrorState message={error} onRetry={runSearch} />
      ) : results === null ? (
        <EmptyState
          icon={CalendarSearch}
          title="Busca una cita"
          description="Filtrá por id, teléfono o nombre del paciente, y/o por rango de fechas."
        />
      ) : results.length === 0 ? (
        <EmptyState icon={CalendarSearch} title="Sin resultados" description="No hay citas que coincidan con la búsqueda." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Fecha</TableHead>
              <TableHead>Paciente</TableHead>
              <TableHead>Servicio</TableHead>
              <TableHead>Profesional</TableHead>
              <TableHead>Espacio</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead>Seña</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.map((a) => (
              <TableRow key={a.id}>
                <TableCell>{formatDateTime(a.startTime)}</TableCell>
                <TableCell>
                  {a.patient.name || "—"}
                  <div className="muted">{a.patient.phone}</div>
                </TableCell>
                <TableCell>
                  {a.service}
                  {a.package && (
                    <div className="muted" style={{ fontSize: "0.85em" }}>
                      Paquete: {a.package.usedSessions} de {a.package.totalSessions} usadas
                    </div>
                  )}
                </TableCell>
                <TableCell>{a.professional.name}</TableCell>
                <TableCell>
                  {a.room.name}
                  {a.resource && <div className="muted">{a.resource.name}</div>}
                  {/* Sin esta nota, ver al profesional en un espacio que no
                      es el suyo parece un error de carga. */}
                  {a.preferredRoomUnavailable && (
                    <div className="muted" style={{ fontSize: "0.85em" }}>
                      Su espacio habitual estaba ocupado
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <StatusBadge status={a.status as Status} />
                  {/* "Cita cumplida (automático)" no prueba que el paciente fue:
                      esto sí, lo confirmó una persona. */}
                  {a.attendedAt && (
                    <div className="muted" style={{ fontSize: "0.85em" }}>
                      Asistencia confirmada
                    </div>
                  )}
                </TableCell>
                <TableCell>{a.depositPaid ? <Badge variant="default">Sí</Badge> : "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
