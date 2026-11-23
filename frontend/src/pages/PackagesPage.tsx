import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Package } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "../api/client";
import { useAuth, useEffectiveClinicId } from "../auth/AuthContext";
import { ClinicScopeRequired } from "../components/shell/ClinicScopeRequired";
import { PageContainer } from "../components/shell/PageContainer";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { PageSkeleton } from "../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { formatDate } from "../lib/format";
import { resumenDeSesiones, type PaqueteView, type PlantillaDePaquete } from "../lib/packages";

interface PacienteHallado {
  id: string;
  name: string | null;
  phone: string;
}

interface ServicioOpcion {
  id: string;
  name: string;
}

/**
 * Paquetes de sesiones prepagas (*"6 sesiones de láser"*).
 *
 * Dos cosas separadas a propósito:
 * - **Catálogo**: lo que vende la clínica ("Láser piernas · 6 sesiones"), definido
 *   UNA vez, con su servicio y su cantidad de sesiones.
 * - **Asignados**: el paquete que tiene cada paciente, que sale de asignarle uno del
 *   catálogo. No se arma un paquete nuevo por cada persona.
 *
 * **La sesión se descuenta cuando una persona marca la cita como atendida**, no al
 * agendar: eso se hace desde el aviso de "Citas" o desde la Agenda.
 */
export function PackagesPage() {
  const clinicId = useEffectiveClinicId();
  const { hasPermission } = useAuth();
  const puedeGestionar = hasPermission("paquetes.gestionar");

  const [paquetes, setPaquetes] = useState<PaqueteView[] | null>(null);
  const [plantillas, setPlantillas] = useState<PlantillaDePaquete[]>([]);
  const [servicios, setServicios] = useState<ServicioOpcion[]>([]);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    if (!clinicId) return;
    setError(null);
    try {
      const [ps, ts] = await Promise.all([
        api.get<PaqueteView[]>(`/dashboard/clinics/${clinicId}/packages`),
        api.get<PlantillaDePaquete[]>(`/dashboard/clinics/${clinicId}/package-templates`),
      ]);
      setPaquetes(ps);
      setPlantillas(ts);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudieron cargar los paquetes");
    }
  }, [clinicId]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  useEffect(() => {
    if (!clinicId) return;
    api
      .get<{ servicios: ServicioOpcion[] }>(`/dashboard/clinics/${clinicId}/agenda-options`)
      .then((r) => setServicios(r.servicios))
      .catch(() => setServicios([]));
  }, [clinicId]);

  if (!clinicId) return <ClinicScopeRequired />;
  if (error && !paquetes) return <ErrorState message={error} onRetry={cargar} />;
  if (!paquetes) return <PageSkeleton />;

  return (
    <PageContainer>
      <h1>Paquetes de sesiones</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Defines cada paquete una vez en el catálogo y se lo asignas a quien lo compre. La sesión se descuenta
        cuando marcas la cita como atendida (desde el aviso de "Citas" o desde la Agenda), no al agendarla.
      </p>

      <Tabs defaultValue="asignados">
        <TabsList>
          <TabsTrigger value="asignados">Asignados a pacientes</TabsTrigger>
          <TabsTrigger value="catalogo">Catálogo ({plantillas.filter((t) => t.active).length})</TabsTrigger>
        </TabsList>

        <TabsContent value="asignados">
          <Asignados
            clinicId={clinicId}
            paquetes={paquetes}
            plantillas={plantillas}
            puedeGestionar={puedeGestionar}
            onCambio={cargar}
          />
        </TabsContent>

        <TabsContent value="catalogo">
          <Catalogo
            clinicId={clinicId}
            plantillas={plantillas}
            servicios={servicios}
            puedeGestionar={puedeGestionar}
            onCambio={cargar}
          />
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}

// --- Asignados ---

function Asignados({
  clinicId,
  paquetes,
  plantillas,
  puedeGestionar,
  onCambio,
}: {
  clinicId: string;
  paquetes: PaqueteView[];
  plantillas: PlantillaDePaquete[];
  puedeGestionar: boolean;
  onCambio: () => Promise<void>;
}) {
  const [soloActivos, setSoloActivos] = useState(true);
  const [filtro, setFiltro] = useState("");
  const [editando, setEditando] = useState<PaqueteView | null>(null);

  const texto = filtro.trim().toLowerCase();
  const visibles = paquetes.filter(
    (p) =>
      (!soloActivos || p.active) &&
      (!texto ||
        (p.patient.name ?? "").toLowerCase().includes(texto) ||
        p.patient.phone.includes(texto) ||
        (p.name ?? "").toLowerCase().includes(texto) ||
        p.serviceName.toLowerCase().includes(texto))
  );

  async function cambiarActivo(p: PaqueteView, active: boolean) {
    try {
      await api.put(`/dashboard/clinics/${clinicId}/packages/${p.id}`, { active });
      toast.success(active ? "Paquete reactivado." : "Paquete desactivado.");
      await onCambio();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo cambiar el paquete");
    }
  }

  return (
    <>
      {puedeGestionar && <AsignarPaquete clinicId={clinicId} plantillas={plantillas} onAsignado={onCambio} />}

      <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", margin: "24px 0 12px" }}>
        <Input
          aria-label="Buscar paquete"
          placeholder="Busca por paciente, teléfono o paquete"
          value={filtro}
          onChange={(e) => setFiltro(e.target.value)}
          style={{ maxWidth: 340 }}
        />
        <div className="checkbox-field" style={{ margin: 0 }}>
          <Checkbox id="solo-activos" checked={soloActivos} onCheckedChange={(v) => setSoloActivos(v === true)} />
          <Label htmlFor="solo-activos">Solo con sesiones disponibles</Label>
        </div>
      </div>

      {visibles.length === 0 ? (
        <EmptyState
          icon={Package}
          title="Sin paquetes"
          description={
            paquetes.length === 0
              ? "Todavía no se asignó ningún paquete a un paciente."
              : "Ningún paquete coincide con el filtro."
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Paciente</TableHead>
              <TableHead>Paquete</TableHead>
              <TableHead>Sesiones</TableHead>
              <TableHead>Asignado</TableHead>
              <TableHead>Estado</TableHead>
              {puedeGestionar && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibles.map((p) => (
              <TableRow key={p.id}>
                <TableCell>
                  <Link to={`/patients/${p.patientId}`}>{p.patient.name || "—"}</Link>
                  <div className="muted">{p.patient.phone}</div>
                </TableCell>
                <TableCell>
                  {p.name ?? p.serviceName}
                  {p.name && (
                    <div className="muted" style={{ fontSize: "0.85em" }}>
                      {p.serviceName}
                    </div>
                  )}
                  {p.notes && (
                    <div className="muted" style={{ fontSize: "0.85em" }}>
                      {p.notes}
                    </div>
                  )}
                </TableCell>
                <TableCell>{resumenDeSesiones(p.capacity)}</TableCell>
                <TableCell>{formatDate(p.purchasedAt)}</TableCell>
                <TableCell>
                  {p.active ? (
                    <Badge>Activo</Badge>
                  ) : p.usedSessions >= p.totalSessions ? (
                    <Badge variant="secondary">Agotado</Badge>
                  ) : (
                    <Badge variant="outline">Desactivado</Badge>
                  )}
                </TableCell>
                {puedeGestionar && (
                  <TableCell style={{ whiteSpace: "nowrap" }}>
                    <Button size="sm" variant="outline" onClick={() => setEditando(p)}>
                      Editar
                    </Button>{" "}
                    {p.active ? (
                      <Button size="sm" variant="ghost" onClick={() => cambiarActivo(p, false)}>
                        Desactivar
                      </Button>
                    ) : (
                      p.usedSessions < p.totalSessions && (
                        <Button size="sm" variant="ghost" onClick={() => cambiarActivo(p, true)}>
                          Reactivar
                        </Button>
                      )
                    )}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {editando && (
        <EditarPaquete
          clinicId={clinicId}
          paquete={editando}
          onCerrar={() => setEditando(null)}
          onGuardado={() => {
            setEditando(null);
            onCambio();
          }}
        />
      )}
    </>
  );
}

function AsignarPaquete({
  clinicId,
  plantillas,
  onAsignado,
}: {
  clinicId: string;
  plantillas: PlantillaDePaquete[];
  onAsignado: () => Promise<void>;
}) {
  const [busqueda, setBusqueda] = useState("");
  const [hallados, setHallados] = useState<PacienteHallado[]>([]);
  const [paciente, setPaciente] = useState<PacienteHallado | null>(null);
  // Empieza vacío a propósito: hay que ELEGIR el paquete, no aceptar uno que venga puesto.
  const [plantilla, setPlantilla] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activas = plantillas.filter((t) => t.active);

  useEffect(() => {
    if (paciente || busqueda.trim().length < 2) {
      setHallados([]);
      return;
    }
    let cancelado = false;
    const espera = setTimeout(() => {
      api
        .get<{ pacientes: PacienteHallado[] }>(
          `/dashboard/clinics/${clinicId}/patients/search?q=${encodeURIComponent(busqueda.trim())}`
        )
        .then((r) => !cancelado && setHallados(r.pacientes))
        .catch(() => !cancelado && setHallados([]));
    }, 250);
    return () => {
      cancelado = true;
      clearTimeout(espera);
    };
  }, [busqueda, clinicId, paciente]);

  async function asignar(e: FormEvent) {
    e.preventDefault();
    if (!paciente) return;
    setGuardando(true);
    setError(null);
    try {
      await api.post(`/dashboard/clinics/${clinicId}/packages`, { patientId: paciente.id, templateId: plantilla });
      toast.success("Paquete asignado.");
      setPaciente(null);
      setBusqueda("");
      setPlantilla("");
      await onAsignado();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo asignar el paquete");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <form className="card" onSubmit={asignar}>
      <h2 style={{ marginTop: 0 }}>Asignar un paquete a un paciente</h2>

      {activas.length === 0 ? (
        <p className="muted" style={{ marginBottom: 0 }}>
          Primero arma el paquete en la pestaña <strong>Catálogo</strong>: define su servicio y cuántas sesiones
          trae, y después se lo asignas a quien lo compre.
        </p>
      ) : (
        <>
          <div className="field">
            <Label htmlFor="paquete-paciente">Paciente</Label>
            {paciente ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span>
                  <strong>{paciente.name ?? "Sin nombre"}</strong>
                  <span className="muted"> · {paciente.phone}</span>
                </span>
                <Button type="button" variant="outline" size="sm" onClick={() => setPaciente(null)}>
                  Cambiar
                </Button>
              </div>
            ) : (
              <>
                <Input
                  id="paquete-paciente"
                  placeholder="Busca por nombre o teléfono"
                  autoComplete="off"
                  value={busqueda}
                  onChange={(e) => setBusqueda(e.target.value)}
                />
                {hallados.length > 0 && (
                  <ul className="agenda-resultados">
                    {hallados.map((p) => (
                      <li key={p.id}>
                        <button type="button" onClick={() => setPaciente(p)}>
                          {p.name ?? "Sin nombre"} <span className="muted">· {p.phone}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="muted" style={{ fontSize: "0.85em", margin: "4px 0 0" }}>
                  El paciente tiene que existir: se carga la primera vez que escribe, o desde <Link to="/patients">Pacientes</Link>.
                </p>
              </>
            )}
          </div>

          <div className="field">
            <Label htmlFor="paquete-plantilla">Paquete del catálogo</Label>
            <select
              id="paquete-plantilla"
              className="input"
              value={plantilla}
              onChange={(e) => setPlantilla(e.target.value)}
            >
              <option value="" disabled>
                Elige un paquete
              </option>
              {activas.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} · {t.serviceName} · {t.totalSessions} sesiones
                </option>
              ))}
            </select>
          </div>

          {error && <p className="error-text">{error}</p>}
          <Button type="submit" disabled={guardando || !paciente || !plantilla}>
            {guardando ? "Asignando…" : "Asignar paquete"}
          </Button>
        </>
      )}
    </form>
  );
}

function EditarPaquete({
  clinicId,
  paquete,
  onCerrar,
  onGuardado,
}: {
  clinicId: string;
  paquete: PaqueteView;
  onCerrar: () => void;
  onGuardado: () => void;
}) {
  const [sesiones, setSesiones] = useState(String(paquete.totalSessions));
  const [notas, setNotas] = useState(paquete.notes ?? "");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const total = Number(sesiones);
  const comprometidas = paquete.capacity.used + paquete.capacity.reserved;
  const valido = Number.isInteger(total) && total >= Math.max(1, comprometidas) && total <= 200;

  async function guardar(e: FormEvent) {
    e.preventDefault();
    setGuardando(true);
    setError(null);
    try {
      await api.put(`/dashboard/clinics/${clinicId}/packages/${paquete.id}`, {
        totalSessions: total,
        notes: notas.trim() || null,
      });
      toast.success("Paquete actualizado.");
      onGuardado();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo guardar");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Dialog open onOpenChange={(abierto) => !abierto && onCerrar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {paquete.name ?? paquete.serviceName} · {paquete.patient.name ?? paquete.patient.phone}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={guardar}>
          <p className="muted" style={{ marginTop: 0 }}>
            {resumenDeSesiones(paquete.capacity)}
          </p>
          <div className="field">
            <Label htmlFor="editar-sesiones">Sesiones de este paquete</Label>
            <Input
              id="editar-sesiones"
              type="number"
              min={Math.max(1, comprometidas)}
              max={200}
              step={1}
              value={sesiones}
              onChange={(e) => setSesiones(e.target.value)}
            />
            <p className="muted" style={{ fontSize: "0.85em", margin: "4px 0 0" }}>
              Mínimo {Math.max(1, comprometidas)}: las ya usadas más las agendadas sin confirmar. Si subes el total
              de un paquete agotado, se reactiva. Solo cambia el de este paciente, no el del catálogo.
            </p>
          </div>
          <div className="field">
            <Label htmlFor="editar-notas">Notas</Label>
            <Input id="editar-notas" value={notas} onChange={(e) => setNotas(e.target.value)} />
          </div>
          {error && <p className="error-text">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCerrar}>
              Cerrar
            </Button>
            <Button type="submit" disabled={guardando || !valido}>
              {guardando ? "Guardando…" : "Guardar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Catálogo ---

function Catalogo({
  clinicId,
  plantillas,
  servicios,
  puedeGestionar,
  onCambio,
}: {
  clinicId: string;
  plantillas: PlantillaDePaquete[];
  servicios: ServicioOpcion[];
  puedeGestionar: boolean;
  onCambio: () => Promise<void>;
}) {
  const [editando, setEditando] = useState<PlantillaDePaquete | null>(null);

  async function cambiarActiva(t: PlantillaDePaquete, active: boolean) {
    try {
      await api.put(`/dashboard/clinics/${clinicId}/package-templates/${t.id}`, { active });
      toast.success(active ? "Paquete reactivado en el catálogo." : "Paquete desactivado: ya no se puede asignar.");
      await onCambio();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo cambiar el paquete");
    }
  }

  return (
    <>
      {puedeGestionar && (
        <FormularioDePlantilla clinicId={clinicId} servicios={servicios} onGuardado={onCambio} />
      )}

      <div style={{ marginTop: 24 }}>
        {plantillas.length === 0 ? (
          <EmptyState
            icon={Package}
            title="Catálogo vacío"
            description="Todavía no hay paquetes en el catálogo. Arma el primero: su servicio y cuántas sesiones trae."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Paquete</TableHead>
                <TableHead>Servicio</TableHead>
                <TableHead>Sesiones</TableHead>
                <TableHead>Asignado a</TableHead>
                <TableHead>Estado</TableHead>
                {puedeGestionar && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {plantillas.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    <strong>{t.name}</strong>
                    {t.notes && (
                      <div className="muted" style={{ fontSize: "0.85em" }}>
                        {t.notes}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>{t.serviceName}</TableCell>
                  <TableCell>{t.totalSessions}</TableCell>
                  <TableCell>
                    {t.asignados} paciente{t.asignados === 1 ? "" : "s"}
                  </TableCell>
                  <TableCell>{t.active ? <Badge>Activo</Badge> : <Badge variant="outline">Desactivado</Badge>}</TableCell>
                  {puedeGestionar && (
                    <TableCell style={{ whiteSpace: "nowrap" }}>
                      <Button size="sm" variant="outline" onClick={() => setEditando(t)}>
                        Editar
                      </Button>{" "}
                      <Button size="sm" variant="ghost" onClick={() => cambiarActiva(t, !t.active)}>
                        {t.active ? "Desactivar" : "Reactivar"}
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {editando && (
        <Dialog open onOpenChange={(abierto) => !abierto && setEditando(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Editar {editando.name}</DialogTitle>
            </DialogHeader>
            <FormularioDePlantilla
              clinicId={clinicId}
              servicios={servicios}
              plantilla={editando}
              onGuardado={async () => {
                setEditando(null);
                await onCambio();
              }}
            />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function FormularioDePlantilla({
  clinicId,
  servicios,
  plantilla,
  onGuardado,
}: {
  clinicId: string;
  servicios: ServicioOpcion[];
  /** Con valor, edita esa; sin él, crea una nueva. */
  plantilla?: PlantillaDePaquete;
  onGuardado: () => Promise<void>;
}) {
  const [nombre, setNombre] = useState(plantilla?.name ?? "");
  // Empieza vacío al crear: hay que ELEGIR el servicio de la lista de la clínica.
  const [servicio, setServicio] = useState(plantilla?.serviceId ?? "");
  const [sesiones, setSesiones] = useState(String(plantilla?.totalSessions ?? 6));
  const [notas, setNotas] = useState(plantilla?.notes ?? "");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const total = Number(sesiones);
  const valido = nombre.trim().length > 0 && Boolean(servicio) && Number.isInteger(total) && total >= 1 && total <= 200;

  async function guardar(e: FormEvent) {
    e.preventDefault();
    setGuardando(true);
    setError(null);
    try {
      const body = { name: nombre.trim(), serviceId: servicio, totalSessions: total, notes: notas.trim() || null };
      if (plantilla) {
        await api.put(`/dashboard/clinics/${clinicId}/package-templates/${plantilla.id}`, body);
        toast.success("Paquete actualizado en el catálogo.");
      } else {
        await api.post(`/dashboard/clinics/${clinicId}/package-templates`, body);
        toast.success("Paquete agregado al catálogo.");
        setNombre("");
        setServicio("");
        setNotas("");
      }
      await onGuardado();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo guardar el paquete");
    } finally {
      setGuardando(false);
    }
  }

  const campos = (
    <>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div className="field" style={{ flex: "2 1 220px" }}>
          <Label htmlFor="plantilla-nombre">Nombre del paquete</Label>
          <Input
            id="plantilla-nombre"
            placeholder="Ej. Láser piernas completas"
            maxLength={80}
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
          />
        </div>
        <div className="field" style={{ flex: "0 1 140px" }}>
          <Label htmlFor="plantilla-sesiones">Sesiones</Label>
          <Input
            id="plantilla-sesiones"
            type="number"
            min={1}
            max={200}
            step={1}
            value={sesiones}
            onChange={(e) => setSesiones(e.target.value)}
          />
        </div>
      </div>

      <div className="field">
        <Label htmlFor="plantilla-servicio">Servicio</Label>
        <select
          id="plantilla-servicio"
          className="input"
          value={servicio}
          disabled={servicios.length === 0}
          onChange={(e) => setServicio(e.target.value)}
        >
          <option value="" disabled>
            Elige un servicio
          </option>
          {servicios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {servicios.length === 0 ? (
          <p className="error-text" style={{ margin: "4px 0 0" }}>
            La clínica no tiene servicios cargados. Cárgalos primero en "Servicios": el paquete tiene que ser de uno de
            ellos.
          </p>
        ) : (
          <p className="muted" style={{ fontSize: "0.85em", margin: "4px 0 0" }}>
            El paquete solo se puede usar en citas de este servicio, y se ata solo a las que agenda el asistente por
            WhatsApp.
          </p>
        )}
      </div>

      <div className="field">
        <Label htmlFor="plantilla-notas">Notas (opcional)</Label>
        <Input id="plantilla-notas" value={notas} onChange={(e) => setNotas(e.target.value)} />
      </div>

      {plantilla && plantilla.asignados > 0 && (
        <p className="muted" style={{ fontSize: "0.85em" }}>
          Los {plantilla.asignados} pacientes que ya lo tienen no cambian: al asignarlo se copiaron sus valores. Lo que
          edites rige para los que se asignen de ahora en adelante.
        </p>
      )}
      {error && <p className="error-text">{error}</p>}
      <Button type="submit" disabled={guardando || !valido}>
        {guardando ? "Guardando…" : plantilla ? "Guardar" : "Agregar al catálogo"}
      </Button>
    </>
  );

  return plantilla ? <form onSubmit={guardar}>{campos}</form> : (
    <form className="card" onSubmit={guardar}>
      <h2 style={{ marginTop: 0 }}>Nuevo paquete del catálogo</h2>
      {campos}
    </form>
  );
}
