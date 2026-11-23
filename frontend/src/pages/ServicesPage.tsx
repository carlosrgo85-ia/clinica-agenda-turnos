import { useEffect, useState, type FormEvent } from "react";
import { ClipboardList } from "lucide-react";
import { toast } from "sonner";
import { useAuth, useEffectiveClinicId } from "../auth/AuthContext";
import { ClinicScopeRequired } from "../components/shell/ClinicScopeRequired";
import { api, ApiError } from "../api/client";
import { PageContainer } from "../components/shell/PageContainer";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Checkbox } from "../components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { StatusBadge } from "../components/ui/status-badge";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { PageSkeleton } from "../components/ui/skeleton";
import { Badge } from "../components/ui/badge";
import { CheckList } from "../components/CheckList";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../components/ui/alert-dialog";

interface ServiceRow {
  id: string;
  name: string;
  durationMinutes: number;
  requiredResourceType: string | null;
  active: boolean;
  /** Lo que el asistente puede decir del precio. Null = no cargado. */
  priceNote: string | null;
  /** Es el diagnóstico de primera vez: el paciente nuevo parte por este. */
  firstVisit: boolean;
  turnos: number;
  /** Quiénes lo realizan. Vacío = nadie: el asistente deriva a una persona. */
  profesionales: Array<{ id: string; name: string; active: boolean }>;
}

interface ServicesResponse {
  /** Los profesionales activos, para el selector de quiénes lo realizan. */
  profesionalesDisponibles: Array<{ id: string; name: string }>;
  servicios: ServiceRow[];
  textoDelPrompt: string;
  descripcion: string;
  usaCatalogo: boolean;
}

/** Valor del Select cuando el servicio no ocupa ningún equipo. */
const SIN_EQUIPO = "__sin_equipo__";

export function ServicesPage() {
  const clinicId = useEffectiveClinicId();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("servicios.editar");

  const [data, setData] = useState<ServicesResponse | null>(null);
  const [tipos, setTipos] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("30");
  const [requiredResourceType, setRequiredResourceType] = useState(SIN_EQUIPO);
  const [active, setActive] = useState(true);
  const [priceNote, setPriceNote] = useState("");
  const [firstVisit, setFirstVisit] = useState(false);
  const [professionalIds, setProfessionalIds] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    if (!clinicId) return;
    setLoading(true);
    setError(null);
    try {
      const [servicios, equipos] = await Promise.all([
        api.get<ServicesResponse>(`/dashboard/clinics/${clinicId}/services`),
        api.get<{ tipos: string[] }>(`/dashboard/clinics/${clinicId}/resource-types`),
      ]);
      setData(servicios);
      setTipos(equipos.tipos);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo cargar el catálogo de servicios");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinicId]);

  if (!clinicId) return <ClinicScopeRequired />;

  function resetForm() {
    setEditingId(null);
    setName("");
    setDurationMinutes("30");
    setRequiredResourceType(SIN_EQUIPO);
    setActive(true);
    setPriceNote("");
    setFirstVisit(false);
    setProfessionalIds([]);
    setFormError(null);
  }

  function startEdit(servicio: ServiceRow) {
    setEditingId(servicio.id);
    setName(servicio.name);
    setDurationMinutes(String(servicio.durationMinutes));
    setRequiredResourceType(servicio.requiredResourceType ?? SIN_EQUIPO);
    setActive(servicio.active);
    setPriceNote(servicio.priceNote ?? "");
    setFirstVisit(servicio.firstVisit);
    setProfessionalIds(servicio.profesionales.map((p) => p.id));
    setFormError(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);

    const body = {
      name,
      durationMinutes: Number(durationMinutes),
      requiredResourceType: requiredResourceType === SIN_EQUIPO ? null : requiredResourceType,
      active,
      priceNote: priceNote.trim() || null,
      firstVisit,
      professionalIds,
    };

    try {
      if (editingId) {
        await api.put(`/dashboard/clinics/${clinicId}/services/${editingId}`, body);
        toast.success(`Servicio "${name}" actualizado.`);
      } else {
        await api.post(`/dashboard/clinics/${clinicId}/services`, body);
        toast.success(`Servicio "${name}" creado.`);
      }
      resetForm();
      await load();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "No se pudo guardar el servicio";
      setFormError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(servicio: ServiceRow) {
    try {
      await api.delete(`/dashboard/clinics/${clinicId}/services/${servicio.id}`);
      toast.success(`Servicio "${servicio.name}" borrado.`);
      if (editingId === servicio.id) resetForm();
      await load();
    } catch (err) {
      // El 409 de "ya tiene turnos" trae la sugerencia de desactivarlo.
      toast.error(err instanceof ApiError ? err.message : "No se pudo borrar el servicio");
    }
  }

  return (
    <div>
      <h1>Servicios</h1>
      <p className="muted">
        El catálogo define cuánto dura cada cita, qué equipo ocupa, y es lo que el asistente le
        cuenta al paciente.
      </p>

      {canEdit && (
        <PageContainer size="form" style={{ margin: "16px 0 24px", padding: 0 }}>
          <form className="card" onSubmit={handleSubmit}>
            <h2>{editingId ? "Editar servicio" : "Nuevo servicio"}</h2>

            <div className="field">
              <Label htmlFor="service-name">Nombre</Label>
              <Input
                id="service-name"
                required
                maxLength={80}
                placeholder="Diagnóstico inicial"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <p className="muted" style={{ fontSize: "0.9em", margin: 0 }}>
                Escríbalo como lo diría un paciente, con mayúscula solo en la primera palabra ("Diagnóstico
                inicial", no "Diagnóstico Inicial"). Al guardar se ajustan los espacios y la primera letra; el
                asistente usa este nombre tal cual, así que revise la ortografía.
              </p>
            </div>

            <div className="field">
              <Label htmlFor="service-duration">Duración (minutos)</Label>
              <Input
                id="service-duration"
                type="number"
                required
                min={5}
                max={480}
                step={5}
                style={{ width: 120 }}
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(e.target.value)}
              />
            </div>

            <div className="field">
              <Label htmlFor="service-price">Precio que informa el asistente (opcional)</Label>
              <Input
                id="service-price"
                maxLength={200}
                placeholder='Ej.: $500. Sin costo si llega por redes o nuestro sitio web'
                value={priceNote}
                onChange={(e) => setPriceNote(e.target.value)}
              />
              <p className="muted" style={{ fontSize: "0.9em", margin: 0 }}>
                Texto libre de una línea: puede ser un precio fijo, "desde…", o una condición (por ejemplo, de
                cortesía si el paciente llega por una campaña; para eso, cargue también la promoción en
                Campañas). El asistente lo dice tal cual. Si lo deja vacío, no afirma ningún precio: dice que
                el costo se confirma en la consulta.
              </p>
            </div>

            <div className="field">
              <Label htmlFor="service-resource">Equipo requerido</Label>
              {tipos.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  Esta clínica no tiene equipos cargados, así que ningún servicio puede pedir uno.
                  Es lo normal cuando no hay aparatos que se compartan entre profesionales.
                </p>
              ) : (
                <Select
                  value={requiredResourceType}
                  onValueChange={(v) => {
                    // Radix dispara onValueChange con "" cuando el valor todavía
                    // no matchea ningún SelectItem montado; ningún tipo real es
                    // una cadena vacía.
                    if (v === "") return;
                    setRequiredResourceType(v);
                  }}
                >
                  <SelectTrigger id="service-resource">
                    {/* El texto como hijo explícito: si no, Radix no muestra un
                        valor seteado por código hasta que el usuario abre el
                        desplegable. */}
                    <SelectValue>
                      {requiredResourceType === SIN_EQUIPO
                        ? "No requiere equipo"
                        : requiredResourceType}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SIN_EQUIPO}>No requiere equipo</SelectItem>
                    {tipos.map((tipo) => (
                      <SelectItem key={tipo} value={tipo}>
                        {tipo}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="checkbox-field" style={{ marginTop: 20 }}>
              <Checkbox
                id="service-active"
                checked={active}
                onCheckedChange={(v) => setActive(v === true)}
              />
              <Label htmlFor="service-active">Activo (se ofrece a los pacientes)</Label>
            </div>

            <div
              className="field"
              style={{ marginTop: 20, paddingTop: 20, borderTop: "1px solid var(--border)" }}
            >
              <Label>Quiénes lo realizan</Label>
              {(data?.profesionalesDisponibles ?? []).length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  Todavía no hay profesionales activos. Cárgalos en Recursos y vuelve para
                  asignarles este servicio.
                </p>
              ) : (
                <CheckList
                  idPrefix="service-prof"
                  items={(data?.profesionalesDisponibles ?? []).map((p) => ({
                    id: p.id,
                    label: p.name,
                  }))}
                  value={professionalIds}
                  onChange={setProfessionalIds}
                />
              )}
              <p className="muted" style={{ fontSize: "0.85em", marginTop: 8, marginBottom: 0 }}>
                No todos hacen lo mismo: el asistente solo ofrece y agenda este servicio con los
                marcados. Si no marcas a nadie, no se puede agendar y el asistente deriva a una
                persona de la clínica.
              </p>
            </div>

            <div
              className="checkbox-field"
              style={{ marginTop: 20, paddingTop: 20, borderTop: "1px solid var(--border)" }}
            >
              <Checkbox
                id="service-first"
                checked={firstVisit}
                onCheckedChange={(v) => setFirstVisit(v === true)}
              />
              <Label htmlFor="service-first">
                Es el diagnóstico de primera vez (el paciente nuevo empieza siempre por este)
              </Label>
            </div>
            {firstVisit && (
              <p className="muted" style={{ fontSize: "0.85em", margin: "4px 0 0" }}>
                Solo puede haber uno: marcarlo desmarca el anterior. Quien lo realiza atiende a
                todos los pacientes nuevos; las urgencias no pasan por acá.
              </p>
            )}

            {formError && <p className="error-text">{formError}</p>}

            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <Button type="submit" disabled={submitting || !name.trim()}>
                {submitting ? "Guardando…" : editingId ? "Guardar cambios" : "Agregar servicio"}
              </Button>
              {editingId && (
                <Button type="button" variant="outline" onClick={resetForm}>
                  Cancelar edición
                </Button>
              )}
            </div>
          </form>
        </PageContainer>
      )}

      {loading ? (
        <PageSkeleton />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !data || data.servicios.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="Todavía no hay servicios cargados"
          description={
            canEdit
              ? "Mientras el catálogo esté vacío, el asistente usa el texto libre de la clínica y todas las citas duran lo mismo."
              : "Pedile a un administrador que cargue el catálogo de servicios de la clínica."
          }
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre</TableHead>
                <TableHead>Duración</TableHead>
                <TableHead>Equipo</TableHead>
                <TableHead>Lo realizan</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Citas</TableHead>
                {canEdit && <TableHead></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.servicios.map((servicio) => (
                <TableRow key={servicio.id}>
                  <TableCell>
                    {servicio.name}
                    {servicio.firstVisit && (
                      <Badge variant="outline" style={{ marginLeft: 6 }}>
                        Primera vez
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{servicio.durationMinutes} min</TableCell>
                  <TableCell className={servicio.requiredResourceType ? undefined : "muted"}>
                    {servicio.requiredResourceType ?? "—"}
                  </TableCell>
                  <TableCell>
                    {servicio.profesionales.filter((p) => p.active).length > 0 ? (
                      servicio.profesionales
                        .filter((p) => p.active)
                        .map((p) => (
                          <Badge key={p.id} variant="outline" style={{ marginRight: 4 }}>
                            {p.name}
                          </Badge>
                        ))
                    ) : servicio.active ? (
                      <span className="error-text">Nadie: no se puede agendar</span>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={servicio.active ? "active" : "inactive"} />
                  </TableCell>
                  <TableCell className="muted">{servicio.turnos}</TableCell>
                  {canEdit && (
                    <TableCell style={{ display: "flex", gap: 8 }}>
                      <Button variant="outline" size="sm" onClick={() => startEdit(servicio)}>
                        Editar
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="outline" size="sm">
                            Borrar
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>¿Borrar "{servicio.name}"?</AlertDialogTitle>
                            <AlertDialogDescription>
                              {servicio.turnos > 0
                                ? `Este servicio ya tiene ${servicio.turnos} cita(s), así que no se puede borrar. Desactívalo para dejar de ofrecerlo sin perder el historial.`
                                : "El asistente deja de ofrecerlo. No se puede deshacer."}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancelar</AlertDialogCancel>
                            <AlertDialogAction onClick={() => handleDelete(servicio)}>
                              Borrar
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <section className="card" style={{ marginTop: 24 }}>
            <h2>Qué está leyendo el asistente</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              {data.usaCatalogo
                ? "Está usando el catálogo de arriba."
                : "El catálogo no tiene servicios activos, así que sigue usando el texto libre de la clínica."}
            </p>
            <h4 style={{ margin: "8px 0 4px" }}>Servicios que menciona hoy</h4>
            <p style={{ marginTop: 0 }}>{data.descripcion}</p>
            <h4 style={{ margin: "8px 0 4px" }}>Texto libre cargado en la clínica</h4>
            <p className="muted" style={{ marginTop: 0 }}>{data.textoDelPrompt}</p>
          </section>
        </>
      )}
    </div>
  );
}
