import { useEffect, useState, type FormEvent } from "react";
import { Search, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { resumenDeSesiones, type PaqueteView } from "../../lib/packages";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { DateField } from "../ui/date-field";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { fechaYHoraEnZona, minutosEntre } from "../../lib/wall-time";
import {
  REGLAS_FORZADAS,
  nombreProfesional,
  type AgendaOpciones,
  type Violacion,
} from "../../lib/agenda-rules";
import type { CitaEnGrilla } from "./CalendarGrid";
import { avisarSiFallo } from "./avisos";

/** Radix no admite "" como valor: "elegir solo" necesita uno propio. */
const AUTO = "__auto__";
/** Igual para "sin paquete". */
const SIN_PAQUETE = "__sin_paquete__";

interface PacienteHallado {
  id: string;
  name: string | null;
  phone: string;
}

interface Props {
  clinicId: string;
  opciones: AgendaOpciones;
  timezone: string;
  modo: "crear" | "editar";
  /** Solo al editar. */
  cita?: CitaEnGrilla;
  /** Solo al crear: lo que se sabe del lugar donde se hizo clic. */
  inicial?: { professionalId?: string; date: string; time: string };
  onCerrar: () => void;
  /** Se guardó, canceló o creó algo: hay que recargar la agenda. */
  onGuardado: () => void;
}

/**
 * Alta, edición y cancelación de una cita desde la Agenda.
 *
 * Las reglas son las del asistente de WhatsApp. Si algo no se cumple y se
 * puede saltar (sobreturno, fuera de horario, el profesional no hace ese
 * servicio), el backend responde sin haber guardado nada y esta pantalla lo
 * muestra; recién con "Guardar de todos modos" se reenvía con `force`. Lo que
 * no se puede saltar (el espacio ocupado, la misma persona con dos citas a la
 * vez) se muestra como error y no ofrece forzarlo.
 */
export function AppointmentDialog(props: Props) {
  const { clinicId, opciones, timezone, modo, cita } = props;
  const { hasPermission } = useAuth();
  const puedeVerPaquetes = hasPermission("paquetes.ver");
  // Confirmar una asistencia toca el saldo prepago del paciente: es un permiso
  // aparte de `citas.gestionar`, que es el que abre este diálogo.
  const puedeMarcar = hasPermission("paquetes.gestionar");

  const actual = cita ? fechaYHoraEnZona(cita.startTime, timezone) : null;

  const [busqueda, setBusqueda] = useState("");
  const [hallados, setHallados] = useState<PacienteHallado[]>([]);
  const [paciente, setPaciente] = useState<PacienteHallado | null>(null);
  const [nuevo, setNuevo] = useState(false);
  const [nuevoNombre, setNuevoNombre] = useState("");
  const [nuevoApellido, setNuevoApellido] = useState("");
  const [nuevoTelefono, setNuevoTelefono] = useState("");

  const [serviceId, setServiceId] = useState(cita?.serviceId ?? "");
  const [professionalId, setProfessionalId] = useState(
    cita?.professionalId ?? props.inicial?.professionalId ?? ""
  );
  const [date, setDate] = useState(actual?.date ?? props.inicial?.date ?? "");
  const [time, setTime] = useState(actual?.time ?? props.inicial?.time ?? "");
  const [duracion, setDuracion] = useState(
    cita ? String(minutosEntre(cita.startTime, cita.endTime)) : ""
  );
  const [duracionTocada, setDuracionTocada] = useState(modo === "editar");
  const [roomId, setRoomId] = useState(cita?.room?.id ?? AUTO);
  const [avisar, setAvisar] = useState(false);

  // Paquetes de sesiones del paciente. `packageId` es lo elegido; `paqueteTocado`
  // evita pisar con la sugerencia automática algo que la asistente ya decidió.
  const [paquetes, setPaquetes] = useState<PaqueteView[]>([]);
  const [packageId, setPackageId] = useState(cita?.packageId ?? SIN_PAQUETE);
  const [paqueteTocado, setPaqueteTocado] = useState(modo === "editar");
  const [marcando, setMarcando] = useState(false);

  const [violaciones, setViolaciones] = useState<Violacion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [confirmandoCancelar, setConfirmandoCancelar] = useState(false);
  const [avisarCancelacion, setAvisarCancelacion] = useState(false);
  // Por qué se cancela (opcional): alimenta el reporte de cancelaciones.
  const [motivoCancelacion, setMotivoCancelacion] = useState("");

  // Buscar pacientes mientras se escribe (con una pausa, para no pedir en cada tecla).
  useEffect(() => {
    if (modo !== "crear" || nuevo || paciente || busqueda.trim().length < 2) {
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
  }, [busqueda, clinicId, modo, nuevo, paciente]);

  const servicio = opciones.servicios.find((s) => s.id === serviceId);

  // Los paquetes del paciente: se cargan al elegirlo (al crear) o al abrir la
  // cita (al editar). Se traen todos y no solo los activos, porque la cita
  // puede estar atada a uno que ya se agotó y tiene que seguir mostrándose.
  const pacienteId = modo === "crear" ? paciente?.id : cita?.patient.id;
  useEffect(() => {
    if (!puedeVerPaquetes || !pacienteId) {
      setPaquetes([]);
      return;
    }
    let cancelado = false;
    api
      .get<PaqueteView[]>(`/dashboard/clinics/${clinicId}/packages?patientId=${encodeURIComponent(pacienteId)}`)
      .then((r) => !cancelado && setPaquetes(r))
      // Es un complemento: sin él la cita se puede guardar igual.
      .catch(() => !cancelado && setPaquetes([]));
    return () => {
      cancelado = true;
    };
  }, [clinicId, pacienteId, puedeVerPaquetes]);

  // Los que se pueden elegir para este servicio: activos y del mismo servicio
  // (o sin servicio), más el que la cita ya tiene aunque ya no sirva para otras.
  const paquetesElegibles = paquetes.filter(
    (p) =>
      p.id === cita?.packageId ||
      (p.active && (p.serviceId === null || !serviceId || p.serviceId === serviceId))
  );

  // Al crear, se sugiere el primero que tenga sesiones libres. Es una sugerencia:
  // si la asistente elige otro o ninguno, no se vuelve a tocar.
  useEffect(() => {
    if (modo !== "crear" || paqueteTocado) return;
    const sugerido = paquetesElegibles.find((p) => p.capacity.available > 0);
    setPackageId(sugerido ? sugerido.id : SIN_PAQUETE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paquetes, serviceId, modo, paqueteTocado]);

  // Primero los que realizan el servicio; el resto sigue disponible (se puede
  // forzar), pero rotulado, para que elegirlo sea una decisión y no un descuido.
  const profesionales = [...opciones.profesionales]
    .map((p) => ({
      ...p,
      hace: !servicio || servicio.professionalIds.includes(p.id),
    }))
    .sort((a, b) => Number(b.hace) - Number(a.hace));

  function elegirServicio(id: string) {
    setServiceId(id);
    const nuevoServicio = opciones.servicios.find((s) => s.id === id);
    if (nuevoServicio && !duracionTocada) setDuracion(String(nuevoServicio.durationMinutes));
    // Si el profesional elegido no lo realiza, se limpia: lo normal es
    // elegir alguien que sí.
    if (nuevoServicio && professionalId && !nuevoServicio.professionalIds.includes(professionalId)) {
      setProfessionalId("");
    }
    setViolaciones(null);
  }

  const puedeGuardar =
    Boolean(serviceId && professionalId && date && time) &&
    (modo === "editar" || Boolean(paciente) || (nuevo && nuevoNombre.trim() && nuevoApellido.trim() && nuevoTelefono.trim()));

  async function guardar(force: boolean) {
    setError(null);
    setGuardando(true);
    try {
      const duracionNum = Number(duracion);
      if (modo === "crear") {
        await api.post(`/dashboard/clinics/${clinicId}/appointments`, {
          patient: paciente
            ? { id: paciente.id }
            : { firstName: nuevoNombre.trim(), lastName: nuevoApellido.trim(), phone: nuevoTelefono.trim() },
          serviceId,
          professionalId,
          date,
          time,
          ...(duracion && Number.isFinite(duracionNum) ? { durationMinutes: duracionNum } : {}),
          roomId: roomId === AUTO ? null : roomId,
          ...(packageId !== SIN_PAQUETE ? { packageId } : {}),
          force,
        });
        toast.success("Cita creada.");
      } else {
        const r = await api.patch<{ avisoAlPaciente: { enviado: boolean; motivo?: string } | null }>(
          `/dashboard/clinics/${clinicId}/appointments/${cita!.id}`,
          {
            serviceId,
            professionalId,
            date,
            time,
            ...(duracion && Number.isFinite(duracionNum) ? { durationMinutes: duracionNum } : {}),
            roomId: roomId === AUTO ? null : roomId,
            // null desata la cita del paquete; solo se manda si cambió.
            ...(packageId !== (cita!.packageId ?? SIN_PAQUETE)
              ? { packageId: packageId === SIN_PAQUETE ? null : packageId }
              : {}),
            force,
            notifyPatient: avisar,
          }
        );
        toast.success("Cita actualizada.");
        avisarSiFallo(r.avisoAlPaciente);
      }
      props.onGuardado();
    } catch (err) {
      if (err instanceof ApiError && err.body.requiereConfirmacion) {
        setViolaciones(err.body.violaciones as Violacion[]);
      } else {
        setViolaciones(null);
        setError(err instanceof ApiError ? err.message : "No se pudo guardar la cita");
      }
    } finally {
      setGuardando(false);
    }
  }

  async function marcarAtendida() {
    setMarcando(true);
    try {
      const r = await api.post<{ paquete: { totalSessions: number; usedSessions: number } | null }>(
        `/dashboard/clinics/${clinicId}/appointments/${cita!.id}/attended`
      );
      const quedan = r.paquete ? r.paquete.totalSessions - r.paquete.usedSessions : null;
      toast.success(
        quedan === null
          ? "Cita marcada como atendida."
          : `Cita atendida. Al paciente le quedan ${quedan} sesion${quedan === 1 ? "" : "es"} del paquete.`
      );
      props.onGuardado();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo marcar la cita");
    } finally {
      setMarcando(false);
    }
  }

  async function deshacerAtendida() {
    setMarcando(true);
    try {
      await api.delete(`/dashboard/clinics/${clinicId}/appointments/${cita!.id}/attended`);
      toast.success("Listo: la cita vuelve a estar pendiente y se devolvió la sesión.");
      props.onGuardado();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo deshacer");
    } finally {
      setMarcando(false);
    }
  }

  async function cancelarCita() {
    setGuardando(true);
    try {
      const r = await api.post<{ avisoAlPaciente: { enviado: boolean; motivo?: string } | null }>(
        `/dashboard/clinics/${clinicId}/appointments/${cita!.id}/cancel`,
        { notifyPatient: avisarCancelacion, reason: motivoCancelacion.trim() || undefined }
      );
      toast.success("Cita cancelada.");
      avisarSiFallo(r.avisoAlPaciente);
      props.onGuardado();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo cancelar la cita");
    } finally {
      setGuardando(false);
      setConfirmandoCancelar(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    guardar(false);
  }

  const forzadas = (cita?.forcedRules ?? []).map((r) => REGLAS_FORZADAS[r] ?? r);

  return (
    <>
      <Dialog open onOpenChange={(abierto) => !abierto && props.onCerrar()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{modo === "crear" ? "Nueva cita" : "Editar cita"}</DialogTitle>
          </DialogHeader>

          <form onSubmit={submit}>
            {modo === "editar" ? (
              <p style={{ marginTop: 0 }}>
                <strong>{cita!.patient.name ?? cita!.patient.phone}</strong>
                <span className="muted"> · {cita!.patient.phone}</span>
              </p>
            ) : (
              <div className="field">
                <Label htmlFor="cita-paciente">Paciente</Label>
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
                ) : nuevo ? (
                  <>
                    <div style={{ display: "flex", gap: 8 }}>
                      <Input
                        id="cita-paciente"
                        aria-label="Nombre"
                        placeholder="Nombre"
                        autoComplete="off"
                        value={nuevoNombre}
                        onChange={(e) => setNuevoNombre(e.target.value)}
                      />
                      <Input
                        aria-label="Apellido"
                        placeholder="Apellido"
                        autoComplete="off"
                        value={nuevoApellido}
                        onChange={(e) => setNuevoApellido(e.target.value)}
                      />
                    </div>
                    <Input
                      aria-label="Teléfono"
                      style={{ marginTop: 6 }}
                      placeholder="Teléfono con código de país, ej. 5215512345678"
                      value={nuevoTelefono}
                      onChange={(e) => setNuevoTelefono(e.target.value)}
                    />
                    <p className="muted" style={{ fontSize: "0.85em", margin: "4px 0 0" }}>
                      Es el WhatsApp al que llegan los recordatorios.{" "}
                      <button type="button" className="link-button" onClick={() => setNuevo(false)}>
                        <Search size={13} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 4 }} />
                        Buscar uno existente
                      </button>
                    </p>
                  </>
                ) : (
                  <>
                    {/* La lupa avisa que al escribir aparecen las opciones (nombre o teléfono). */}
                    <div className="input-con-icono">
                      <Search className="input-con-icono__icono" size={16} aria-hidden="true" />
                      <Input
                        id="cita-paciente"
                        className="input-con-icono__campo"
                        placeholder="Busca por nombre o teléfono"
                        autoComplete="off"
                        value={busqueda}
                        onChange={(e) => setBusqueda(e.target.value)}
                      />
                    </div>
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
                      ¿No está?{" "}
                      <button type="button" className="link-button" onClick={() => setNuevo(true)}>
                        Cargar un paciente nuevo
                      </button>
                    </p>
                  </>
                )}
              </div>
            )}

            <div className="field">
              <Label htmlFor="cita-servicio">Servicio</Label>
              <Select value={serviceId} onValueChange={(v) => v && elegirServicio(v)}>
                <SelectTrigger id="cita-servicio">
                  <SelectValue>{servicio ? `${servicio.name} (${servicio.durationMinutes} min)` : "Elige un servicio"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {opciones.servicios.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name} ({s.durationMinutes} min)
                      {s.firstVisit ? " · primera vez" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="field">
              <Label htmlFor="cita-profesional">Profesional</Label>
              <Select
                value={professionalId}
                onValueChange={(v) => {
                  if (!v) return;
                  setProfessionalId(v);
                  setViolaciones(null);
                }}
              >
                <SelectTrigger id="cita-profesional">
                  <SelectValue>
                    {professionalId
                      ? nombreProfesional(
                          opciones.profesionales.find((p) => p.id === professionalId) ?? {
                            name: "—",
                            title: null,
                          }
                        )
                      : "Elige un profesional"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {profesionales.map((p) => (
                    // Quien no realiza el servicio no se puede elegir: es obligatorio (la regla también la impone el servidor).
                    <SelectItem key={p.id} value={p.id} disabled={!p.hace}>
                      {nombreProfesional(p)}
                      {p.hace ? "" : " — no realiza este servicio"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <div className="field" style={{ flex: "1 1 160px" }}>
                <Label htmlFor="cita-fecha">Día</Label>
                <DateField
                  id="cita-fecha"
                  value={date}
                  onChange={(v) => {
                    setDate(v);
                    setViolaciones(null);
                  }}
                />
              </div>
              <div className="field" style={{ flex: "0 1 120px" }}>
                <Label htmlFor="cita-hora">Hora</Label>
                <Input
                  id="cita-hora"
                  type="time"
                  step={900}
                  value={time}
                  onChange={(e) => {
                    setTime(e.target.value);
                    setViolaciones(null);
                  }}
                />
              </div>
              <div className="field" style={{ flex: "0 1 120px" }}>
                <Label htmlFor="cita-duracion">Duración (min)</Label>
                <Input
                  id="cita-duracion"
                  type="number"
                  min={5}
                  max={720}
                  step={5}
                  value={duracion}
                  onChange={(e) => {
                    setDuracion(e.target.value);
                    setDuracionTocada(true);
                  }}
                />
              </div>
            </div>

            <div className="field">
              <Label htmlFor="cita-espacio">Espacio</Label>
              <Select value={roomId} onValueChange={(v) => v && setRoomId(v)}>
                <SelectTrigger id="cita-espacio">
                  <SelectValue>
                    {roomId === AUTO
                      ? "Elegir uno libre automáticamente"
                      : opciones.espacios.find((e) => e.id === roomId)?.name}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO}>Elegir uno libre automáticamente</SelectItem>
                  {opciones.espacios.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {paquetesElegibles.length > 0 && (
              <div className="field">
                <Label htmlFor="cita-paquete">Paquete de sesiones</Label>
                <Select
                  value={packageId}
                  onValueChange={(v) => {
                    if (!v) return;
                    setPackageId(v);
                    setPaqueteTocado(true);
                    setViolaciones(null);
                  }}
                >
                  <SelectTrigger id="cita-paquete">
                    <SelectValue>
                      {packageId === SIN_PAQUETE
                        ? "Sin paquete"
                        : (() => {
                            const p = paquetes.find((x) => x.id === packageId);
                            return p ? `${p.serviceName} · ${resumenDeSesiones(p.capacity)}` : "—";
                          })()}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SIN_PAQUETE}>Sin paquete</SelectItem>
                    {paquetesElegibles.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.serviceName} · {resumenDeSesiones(p.capacity)}
                        {p.active ? "" : " (agotado)"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="muted" style={{ fontSize: "0.85em", margin: "4px 0 0" }}>
                  La sesión se descuenta cuando marques la cita como atendida, no al agendarla.
                </p>
              </div>
            )}

            {modo === "editar" && puedeMarcar && cita && (
              <div className="field">
                {cita.attendedAt ? (
                  <p style={{ margin: 0 }}>
                    <strong>Asistencia confirmada.</strong>
                    {cita.package ? " La sesión del paquete ya se descontó." : ""}{" "}
                    <button
                      type="button"
                      className="link-button"
                      disabled={marcando}
                      onClick={deshacerAtendida}
                    >
                      Deshacer
                    </button>
                  </p>
                ) : (
                  <Button type="button" variant="outline" disabled={marcando} onClick={marcarAtendida}>
                    {marcando ? "Marcando…" : "Marcar como atendida"}
                  </Button>
                )}
              </div>
            )}

            {modo === "editar" && (
              <div className="checkbox-field">
                <Checkbox
                  id="cita-avisar"
                  checked={avisar}
                  onCheckedChange={(v) => setAvisar(v === true)}
                />
                <Label htmlFor="cita-avisar">Avisar al paciente por WhatsApp del cambio</Label>
              </div>
            )}

            {forzadas.length > 0 && (
              <p className="muted" style={{ fontSize: "0.85em" }}>
                Esta cita se guardó saltando: {forzadas.join(", ")}.
              </p>
            )}

            {violaciones && (
              <div className="agenda-alerta" role="alert">
                <strong>
                  <TriangleAlert size={14} style={{ verticalAlign: "-2px" }} /> Hay reglas que no se
                  cumplen:
                </strong>
                <ul>
                  {violaciones.map((v) => (
                    <li key={v.rule}>{v.message}</li>
                  ))}
                </ul>
                <p style={{ margin: 0 }}>Puedes guardar igual, y queda registrado.</p>
              </div>
            )}

            {error && <p className="error-text">{error}</p>}

            <DialogFooter>
              {modo === "editar" && (
                <Button
                  type="button"
                  variant="outline"
                  style={{ marginRight: "auto" }}
                  onClick={() => setConfirmandoCancelar(true)}
                >
                  Cancelar cita
                </Button>
              )}
              <Button type="button" variant="outline" onClick={props.onCerrar}>
                Cerrar
              </Button>
              {violaciones ? (
                <Button type="button" disabled={guardando} onClick={() => guardar(true)}>
                  {guardando ? "Guardando…" : "Guardar de todos modos"}
                </Button>
              ) : (
                <Button type="submit" disabled={guardando || !puedeGuardar}>
                  {guardando ? "Guardando…" : modo === "crear" ? "Crear cita" : "Guardar"}
                </Button>
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmandoCancelar} onOpenChange={setConfirmandoCancelar}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Cancelar esta cita?</AlertDialogTitle>
            <AlertDialogDescription>
              Se libera el horario y el espacio, y se borra del calendario del profesional.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="field">
            <Label htmlFor="cita-motivo-cancelacion">Motivo (opcional)</Label>
            <Input
              id="cita-motivo-cancelacion"
              maxLength={200}
              placeholder="Ej. el paciente avisó que no puede venir"
              value={motivoCancelacion}
              onChange={(e) => setMotivoCancelacion(e.target.value)}
            />
            <p className="muted" style={{ fontSize: "0.85em", margin: "4px 0 0" }}>
              Queda registrado y sirve para los reportes de cancelaciones.
            </p>
          </div>
          <div className="checkbox-field">
            <Checkbox
              id="cita-avisar-cancelacion"
              checked={avisarCancelacion}
              onCheckedChange={(v) => setAvisarCancelacion(v === true)}
            />
            <Label htmlFor="cita-avisar-cancelacion">Avisar al paciente por WhatsApp</Label>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Volver</AlertDialogCancel>
            <AlertDialogAction onClick={cancelarCita}>Cancelar cita</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
