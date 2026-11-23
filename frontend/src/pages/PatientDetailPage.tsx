import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "../api/client";
import { useAuth, useEffectiveClinicId } from "../auth/AuthContext";
import { ClinicScopeRequired } from "../components/shell/ClinicScopeRequired";
import { PageContainer } from "../components/shell/PageContainer";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { DateField } from "../components/ui/date-field";
import { ErrorState } from "../components/ui/error-state";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { PageSkeleton } from "../components/ui/skeleton";
import { StatusBadge, type Status } from "../components/ui/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";
import { formatDate, formatDateTime } from "../lib/format";
import { cuandoToca, nombreDelPaciente, type PacienteDetalle } from "../lib/patients";
import { resumenDeSesiones } from "../lib/packages";

interface PlantillaOpcion {
  id: string;
  name: string;
  serviceName: string;
  totalSessions: number;
}

/**
 * La ficha de un paciente: datos, próxima cita sugerida, observaciones,
 * comentarios, historial de citas y paquetes.
 *
 * **Lo que se escribe en observaciones, comentarios y próxima cita sugerida lo lee
 * el asistente de WhatsApp** para tratar con cercanía a quien ya vino, preguntarle
 * cómo le fue y proponerle una nueva cita. Por eso se avisa acá, donde se escribe:
 * el personal no tiene por qué saber que lo lee un modelo.
 */
export function PatientDetailPage() {
  const { patientId } = useParams<{ patientId: string }>();
  const clinicId = useEffectiveClinicId();
  const { hasPermission } = useAuth();
  const puedeEditar = hasPermission("pacientes.editar");
  const puedeGestionarPaquetes = hasPermission("paquetes.gestionar");
  const puedeVerPaquetes = hasPermission("paquetes.ver");

  const [detalle, setDetalle] = useState<PacienteDetalle | null>(null);
  const [plantillas, setPlantillas] = useState<PlantillaOpcion[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [nombre, setNombre] = useState("");
  const [apellido, setApellido] = useState("");
  const [observaciones, setObservaciones] = useState("");
  const [fecha, setFecha] = useState("");
  const [nota, setNota] = useState("");
  const [noContactar, setNoContactar] = useState(false);
  const [autorizados, setAutorizados] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [errorGuardar, setErrorGuardar] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    if (!clinicId || !patientId) return;
    setError(null);
    try {
      const d = await api.get<PacienteDetalle>(`/dashboard/clinics/${clinicId}/patients/${patientId}`);
      setDetalle(d);
      setNombre(d.paciente.firstName);
      setApellido(d.paciente.lastName);
      setObservaciones(d.paciente.observations ?? "");
      setFecha(d.paciente.suggestedNextVisitDate ?? "");
      setNota(d.paciente.suggestedNextVisitNote ?? "");
      setNoContactar(d.paciente.outreachOptOut);
      setAutorizados(d.paciente.authorizedPhones.join(", "));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo cargar el paciente");
    }
  }, [clinicId, patientId]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  useEffect(() => {
    if (!clinicId || !puedeVerPaquetes) return;
    api
      .get<PlantillaOpcion[]>(`/dashboard/clinics/${clinicId}/package-templates?onlyActive=true`)
      .then(setPlantillas)
      .catch(() => setPlantillas([]));
  }, [clinicId, puedeVerPaquetes]);

  if (!clinicId) return <ClinicScopeRequired />;
  if (error && !detalle) return <ErrorState message={error} onRetry={cargar} />;
  if (!detalle) return <PageSkeleton />;

  const { paciente } = detalle;
  const cambios =
    paciente.nameInferred ||
    nombre !== paciente.firstName ||
    apellido !== paciente.lastName ||
    observaciones !== (paciente.observations ?? "") ||
    fecha !== (paciente.suggestedNextVisitDate ?? "") ||
    nota !== (paciente.suggestedNextVisitNote ?? "") ||
    noContactar !== paciente.outreachOptOut ||
    autorizados.trim() !== paciente.authorizedPhones.join(", ");

  async function guardar(e: FormEvent) {
    e.preventDefault();
    setGuardando(true);
    setErrorGuardar(null);
    try {
      await api.put(`/dashboard/clinics/${clinicId}/patients/${patientId}`, {
        firstName: nombre.trim(),
        lastName: apellido.trim(),
        observations: observaciones.trim() || null,
        // `DateField` entrega "" mientras la fecha está incompleta: se manda null
        // solo si de verdad se vació.
        suggestedNextVisitDate: fecha || null,
        suggestedNextVisitNote: nota.trim() || null,
        outreachOptOut: noContactar,
        authorizedPhones: autorizados
          .split(/[,;\n]/)
          .map((n) => n.trim())
          .filter(Boolean),
      });
      toast.success("Ficha guardada.");
      await cargar();
    } catch (err) {
      setErrorGuardar(err instanceof ApiError ? err.message : "No se pudo guardar la ficha");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <PageContainer>
      <p style={{ margin: 0 }}>
        <Link to="/patients">← Pacientes</Link>
      </p>
      <h1 style={{ marginTop: 8 }}>{nombreDelPaciente(paciente)}</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        {paciente.phone} · alta el {formatDate(paciente.createdAt)}
      </p>

      <form className="card" style={{ marginBottom: 24 }} onSubmit={guardar}>
        <h2 style={{ marginTop: 0 }}>Datos</h2>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div className="field" style={{ flex: "1 1 200px" }}>
            <Label htmlFor="ficha-nombre">Nombre</Label>
            <Input id="ficha-nombre" disabled={!puedeEditar} value={nombre} onChange={(e) => setNombre(e.target.value)} />
          </div>
          <div className="field" style={{ flex: "1 1 200px" }}>
            <Label htmlFor="ficha-apellido">Apellido</Label>
            <Input id="ficha-apellido" disabled={!puedeEditar} value={apellido} onChange={(e) => setApellido(e.target.value)} />
          </div>
        </div>
        {paciente.nameInferred && (
          <p className="muted" role="note" style={{ margin: "4px 0 12px" }}>
            El nombre y el apellido se separaron automáticamente a partir de "{paciente.name}": con nombres
            compuestos (por ejemplo "Petra María") puede quedar mal repartido. Revísalos y guarda para
            confirmarlos.
          </p>
        )}

        <h2>Próxima cita sugerida</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Cuándo conviene que vuelva. No reserva ningún horario: es un recordatorio para el equipo y lo que usa el
          proceso que contacta a los pacientes.
        </p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div className="field" style={{ flex: "0 1 190px" }}>
            <Label htmlFor="ficha-fecha">Fecha</Label>
            <DateField id="ficha-fecha" disabled={!puedeEditar} value={fecha} onChange={setFecha} />
          </div>
          <div className="field" style={{ flex: "1 1 260px" }}>
            <Label htmlFor="ficha-nota">De qué</Label>
            <Input
              id="ficha-nota"
              disabled={!puedeEditar}
              placeholder="Ej. control de ortodoncia"
              maxLength={200}
              value={nota}
              onChange={(e) => setNota(e.target.value)}
            />
          </div>
        </div>
        {paciente.suggestedNextVisitDate && (
          <p className="muted" style={{ margin: "0 0 8px" }}>
            Fecha sugerida: {cuandoToca(paciente.suggestedNextVisitDate)}.{" "}
            {paciente.nextAppointmentAt
              ? `Ya tiene una cita agendada el ${formatDate(paciente.nextAppointmentAt)}.`
              : paciente.outreachSentAt
                ? `Se le escribió el ${formatDateTime(paciente.outreachSentAt)}.`
                : ""}
          </p>
        )}
        <div className="checkbox-field">
          <Checkbox
            id="ficha-nocontactar"
            disabled={!puedeEditar}
            checked={noContactar}
            onCheckedChange={(v) => setNoContactar(v === true)}
          />
          <Label htmlFor="ficha-nocontactar">No contactar por iniciativa de la clínica (pidió que no le escribamos)</Label>
        </div>

        <h2>Números autorizados</h2>
        <div className="field">
          <Label htmlFor="ficha-autorizados">Otros WhatsApp que pueden consultar las citas de esta persona</Label>
          <Input
            id="ficha-autorizados"
            disabled={!puedeEditar}
            placeholder="Ej. 5215512345678, 5215587654321"
            value={autorizados}
            onChange={(e) => setAutorizados(e.target.value)}
          />
        </div>
        <p className="muted" style={{ fontSize: "0.85em", margin: "4px 0 12px" }}>
          Con código de país y separados por coma (hasta 3). Quien escriba desde uno de estos números verá las citas de esta
          persona en el asistente y podrá consultarlas, cambiarlas o cancelarlas; los avisos siguen yendo al número de la
          ficha. Los carga el asistente cuando alguien agenda para un familiar. Agrega solo números de personas de confianza.
        </p>

        <h2>Observaciones</h2>
        <Textarea
          rows={4}
          maxLength={2000}
          disabled={!puedeEditar}
          placeholder="Preferencias, indicaciones, algo que conviene tener presente"
          value={observaciones}
          onChange={(e) => setObservaciones(e.target.value)}
        />
        <p className="muted" style={{ fontSize: "0.85em", margin: "4px 0 12px" }}>
          <strong>El asistente de WhatsApp lee las observaciones, los comentarios y la próxima cita sugerida</strong>{" "}
          para tratar con cercanía a quien ya vino, preguntarle cómo le fue y proponerle una cita. Lo que escribas acá se
          envía a un servicio externo: evita datos que no hagan falta. Nunca se las cita al paciente.
        </p>

        {errorGuardar && <p className="error-text">{errorGuardar}</p>}
        {puedeEditar && (
          <Button type="submit" disabled={guardando || !cambios || !nombre.trim()}>
            {guardando ? "Guardando…" : "Guardar ficha"}
          </Button>
        )}
      </form>

      <Comentarios
        clinicId={clinicId}
        patientId={paciente.id}
        comentarios={detalle.comentarios}
        puedeEditar={puedeEditar}
        onCambio={cargar}
      />

      {puedeVerPaquetes && (
        <section className="card" style={{ marginBottom: 24 }}>
          <h2 style={{ marginTop: 0 }}>Paquetes</h2>
          {detalle.paquetes.length === 0 ? (
            <p className="muted">No tiene paquetes.</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {detalle.paquetes.map((p) => (
                <li key={p.id}>
                  <strong>{p.name ?? p.serviceName}</strong> · {resumenDeSesiones(p.capacity)}{" "}
                  {!p.active && <Badge variant="secondary">{p.usedSessions >= p.totalSessions ? "Agotado" : "Desactivado"}</Badge>}
                </li>
              ))}
            </ul>
          )}
          {puedeGestionarPaquetes && (
            <AsignarPaquete clinicId={clinicId} patientId={paciente.id} plantillas={plantillas} onAsignado={cargar} />
          )}
        </section>
      )}

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Historial de citas</h2>
        {detalle.citas.length === 0 ? (
          <p className="muted">Todavía no tiene citas.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Servicio</TableHead>
                <TableHead>Profesional</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detalle.citas.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>{formatDateTime(c.startTime)}</TableCell>
                  <TableCell>
                    {c.service}
                    {c.package && (
                      <div className="muted" style={{ fontSize: "0.85em" }}>
                        Paquete: {c.package.serviceName}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>{c.professional}</TableCell>
                  <TableCell>
                    <StatusBadge status={c.status as Status} />
                    {c.attendedAt && (
                      <div className="muted" style={{ fontSize: "0.85em" }}>
                        Asistencia confirmada
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </PageContainer>
  );
}

function Comentarios({
  clinicId,
  patientId,
  comentarios,
  puedeEditar,
  onCambio,
}: {
  clinicId: string;
  patientId: string;
  comentarios: PacienteDetalle["comentarios"];
  puedeEditar: boolean;
  onCambio: () => Promise<void>;
}) {
  const [texto, setTexto] = useState("");
  const [guardando, setGuardando] = useState(false);

  async function agregar(e: FormEvent) {
    e.preventDefault();
    setGuardando(true);
    try {
      await api.post(`/dashboard/clinics/${clinicId}/patients/${patientId}/comments`, { text: texto.trim() });
      setTexto("");
      await onCambio();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo agregar el comentario");
    } finally {
      setGuardando(false);
    }
  }

  async function borrar(id: string) {
    try {
      await api.delete(`/dashboard/clinics/${clinicId}/patients/${patientId}/comments/${id}`);
      await onCambio();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo borrar el comentario");
    }
  }

  return (
    <section className="card" style={{ marginBottom: 24 }}>
      <h2 style={{ marginTop: 0 }}>Comentarios</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        El registro con fecha de lo que se fue hablando. Se agregan y se pueden borrar, pero no se editan.
      </p>

      {puedeEditar && (
        <form onSubmit={agregar} style={{ marginBottom: 12 }}>
          <Textarea
            rows={2}
            maxLength={2000}
            aria-label="Nuevo comentario"
            placeholder="Escribe un comentario sobre este paciente"
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
          />
          <Button type="submit" size="sm" style={{ marginTop: 6 }} disabled={guardando || !texto.trim()}>
            {guardando ? "Agregando…" : "Agregar comentario"}
          </Button>
        </form>
      )}

      {comentarios.length === 0 ? (
        <p className="muted">Todavía no hay comentarios.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {comentarios.map((c) => (
            <li key={c.id} style={{ padding: "8px 0", borderTop: "1px solid var(--border, #e5e5e5)" }}>
              <div className="muted" style={{ fontSize: "0.85em" }}>
                {c.authorName} · {formatDateTime(c.createdAt)}
              </div>
              <div style={{ whiteSpace: "pre-wrap" }}>{c.text}</div>
              {puedeEditar && (
                <button type="button" className="link-button" onClick={() => borrar(c.id)}>
                  Borrar
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AsignarPaquete({
  clinicId,
  patientId,
  plantillas,
  onAsignado,
}: {
  clinicId: string;
  patientId: string;
  plantillas: PlantillaOpcion[];
  onAsignado: () => Promise<void>;
}) {
  const [plantilla, setPlantilla] = useState("");
  const [guardando, setGuardando] = useState(false);

  async function asignar(e: FormEvent) {
    e.preventDefault();
    setGuardando(true);
    try {
      await api.post(`/dashboard/clinics/${clinicId}/packages`, { patientId, templateId: plantilla });
      toast.success("Paquete asignado.");
      setPlantilla("");
      await onAsignado();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo asignar el paquete");
    } finally {
      setGuardando(false);
    }
  }

  if (plantillas.length === 0) {
    return (
      <p className="muted" style={{ marginBottom: 0 }}>
        No hay paquetes en el catálogo para asignar. Se arman en <Link to="/packages">Paquetes</Link>.
      </p>
    );
  }

  return (
    <form onSubmit={asignar} style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", marginTop: 12 }}>
      <div className="field" style={{ margin: 0, flex: "1 1 260px" }}>
        <Label htmlFor="asignar-paquete">Asignar un paquete del catálogo</Label>
        <select id="asignar-paquete" className="input" value={plantilla} onChange={(e) => setPlantilla(e.target.value)}>
          <option value="" disabled>
            Elige un paquete
          </option>
          {plantillas.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.totalSessions} sesiones
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" disabled={guardando || !plantilla}>
        {guardando ? "Asignando…" : "Asignar"}
      </Button>
    </form>
  );
}
