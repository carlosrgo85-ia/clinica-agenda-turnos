import { useEffect, useMemo, useState } from "react";
import { CalendarDays, CalendarRange, ChevronLeft, ChevronRight, Plus, Ban } from "lucide-react";
import { toast } from "sonner";
import { useAuth, useEffectiveClinicId } from "../auth/AuthContext";
import { ClinicScopeRequired } from "../components/shell/ClinicScopeRequired";
import { api, ApiError } from "../api/client";
import { Button } from "../components/ui/button";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { ErrorState } from "../components/ui/error-state";
import { PageSkeleton } from "../components/ui/skeleton";
import {
  CalendarGrid,
  type BloqueoEnGrilla,
  type CitaEnGrilla,
  type Columna,
} from "../components/calendar/CalendarGrid";
import { AppointmentDialog } from "../components/calendar/AppointmentDialog";
import { avisarSiFallo } from "../components/calendar/avisos";
import { BlockDialog } from "../components/calendar/BlockDialog";
import { RulesConfirmDialog } from "../components/calendar/RulesConfirmDialog";
import type { AgendaOpciones, Violacion } from "../lib/agenda-rules";
import { fechaYHoraEnZona } from "../lib/wall-time";
import { WEEKDAY_LABELS, WEEKDAYS, minutesToTime } from "../lib/weekdays";
import { addDaysToDateKey, hoyEnZona, weekdayDeDateKey } from "../lib/date-keys";
import { unirDisponibilidades } from "../lib/closed-bands";
import { etiquetaDeCitas, tituloDeDia, tituloDeRango } from "../lib/date-range-label";

type Cita = CitaEnGrilla & { professionalId: string };

interface DisponibilidadDia {
  professionalId: string;
  dateKey: string;
  tramos: Array<{ startMinute: number; endMinute: number }>;
  cerrado: boolean;
  motivo: string | null;
}

interface RespuestaCalendario {
  timezone: string;
  grilla: { desdeMinuto: number; hastaMinuto: number };
  profesionales: Array<{ id: string; name: string }>;
  citas: Cita[];
  bloqueos: BloqueoEnGrilla[];
  disponibilidad: DisponibilidadDia[];
}

type DialogoCita =
  | { modo: "crear"; inicial: { professionalId?: string; date: string; time: string } }
  | { modo: "editar"; cita: Cita };

type DialogoBloqueo =
  | { bloqueo: BloqueoEnGrilla; inicial?: undefined }
  | { bloqueo?: undefined; inicial: { professionalId?: string; date: string; time: string } };

interface ConfirmacionDeReglas {
  violaciones: Violacion[];
  resumen: string;
  onConfirmar: (avisar: boolean) => void;
}

const TODOS = "__todos__";

/**
 * La agenda de la clínica.
 *
 * Dos vistas, porque responden preguntas distintas:
 *
 * - **Día**: una columna por profesional. Es la de "¿cómo viene hoy la
 *   clínica?" — de un vistazo se ve quién tiene qué a cada hora y dónde
 *   quedaron los huecos.
 * - **Semana**: un profesional, siete columnas. Es la de "¿cómo viene la
 *   semana de la Dra. Uno?".
 *
 * Las dos usan la misma grilla (`CalendarGrid`), que solo sabe de columnas
 * y de citas. Eso es lo que hace que el día en que la clínica tenga
 * sucursales no haya que reescribir nada: hoy las columnas son
 * profesionales o días, mañana pueden ser sucursales, o profesionales de
 * una sucursal elegida.
 */
export function CalendarPage() {
  const clinicId = useEffectiveClinicId();
  const { hasPermission } = useAuth();
  // Crear, mover, editar y cancelar. Sin el permiso la agenda es de solo lectura.
  const puedeGestionar = hasPermission("citas.gestionar");

  const [vista, setVista] = useState<"dia" | "semana">("dia");
  const [ancla, setAncla] = useState(() => hoyEnZona());
  const [profesionalId, setProfesionalId] = useState(TODOS);
  const [data, setData] = useState<RespuestaCalendario | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Cada cambio hecho desde la agenda suma uno: es lo que dispara recargarla.
  const [version, setVersion] = useState(0);
  const recargar = () => setVersion((v) => v + 1);
  const [opciones, setOpciones] = useState<AgendaOpciones | null>(null);
  const [dialogoCita, setDialogoCita] = useState<DialogoCita | null>(null);
  const [dialogoBloqueo, setDialogoBloqueo] = useState<DialogoBloqueo | null>(null);
  const [confirmacion, setConfirmacion] = useState<ConfirmacionDeReglas | null>(null);

  // En vista semana el rango es la semana de la fecha ancla; en día, el día.
  const { desde, hasta } = useMemo(() => {
    if (vista === "dia") return { desde: ancla, hasta: ancla };
    const indice = WEEKDAYS.indexOf(weekdayDeDateKey(ancla));
    const lunes = addDaysToDateKey(ancla, -indice);
    return { desde: lunes, hasta: addDaysToDateKey(lunes, 6) };
  }, [vista, ancla]);

  useEffect(() => {
    if (!clinicId) return;
    let cancelado = false;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ desde, hasta });
    if (vista === "semana" && profesionalId !== TODOS) {
      params.set("professionalIds", profesionalId);
    }

    api
      .get<RespuestaCalendario>(`/dashboard/clinics/${clinicId}/calendar?${params.toString()}`)
      .then((r) => !cancelado && setData(r))
      .catch((err) => {
        if (cancelado) return;
        setError(err instanceof ApiError ? err.message : "No se pudo cargar el calendario");
      })
      .finally(() => !cancelado && setLoading(false));

    // Evita que una respuesta vieja pise a una nueva cuando se cambia de día
    // rápido con las flechas.
    return () => {
      cancelado = true;
    };
  }, [clinicId, desde, hasta, vista, profesionalId, version]);

  // Lo que necesitan los diálogos: servicios (con quiénes los hacen), profesionales
  // y espacios. Solo se pide si la persona puede editar.
  useEffect(() => {
    if (!clinicId || !puedeGestionar) return;
    api
      .get<AgendaOpciones>(`/dashboard/clinics/${clinicId}/agenda-options`)
      .then(setOpciones)
      .catch(() => setOpciones(null));
  }, [clinicId, puedeGestionar, version]);

  if (!clinicId) return <ClinicScopeRequired />;

  const profesionales = data?.profesionales ?? [];
  const timezone = data?.timezone ?? "UTC";
  // El día de una cita en la zona de la clínica (no el día UTC del ISO).
  const diaDe = (iso: string) => fechaYHoraEnZona(iso, timezone).date;

  /*
   * Las columnas son lo único que cambia entre las dos vistas. La grilla no
   * sabe si representan personas o días.
   *
   * La disponibilidad se busca por (profesional, día) en las dos: en la de
   * día varía el profesional con el día fijo, y en la de semana al revés.
   */
  const disponibilidadDe = (profId: string, dateKey: string) =>
    (data?.disponibilidad ?? []).find(
      (d) => d.professionalId === profId && d.dateKey === dateKey
    );

  const columnas: Columna[] =
    vista === "dia"
      ? profesionales
          .filter((p) => profesionalId === TODOS || p.id === profesionalId)
          .map((p) => ({
            id: p.id,
            titulo: p.name,
            citas: (data?.citas ?? []).filter((c) => c.professionalId === p.id),
            bloqueos: (data?.bloqueos ?? []).filter((b) => b.professionalId === p.id),
            disponibilidad: disponibilidadDe(p.id, desde),
          }))
      : diasDeLaSemana(desde).map((dateKey) => ({
          id: dateKey,
          titulo: `${WEEKDAY_LABELS[weekdayDeDateKey(dateKey)]} ${dateKey.slice(8)}`,
          citas: (data?.citas ?? []).filter((c) => diaDe(c.startTime) === dateKey),
          bloqueos: (data?.bloqueos ?? []).filter(
            (b) =>
              (profesionalId === TODOS || b.professionalId === profesionalId) &&
              diaDe(b.startTime) === dateKey
          ),
          // Con un profesional elegido, su horario. En "Todos", la unión de los de todos: el día se pinta cerrado solo si NADIE
          // atiende (un feriado de la clínica), no porque uno solo esté de vacaciones.
          disponibilidad:
            profesionalId === TODOS
              ? unirDisponibilidades(
                  profesionales
                    .map((p) => disponibilidadDe(p.id, dateKey))
                    .filter((d): d is NonNullable<typeof d> => d !== undefined)
                )
              : disponibilidadDe(profesionalId, dateKey),
        }));

  /** Dónde cayó algo que se soltó: otro profesional (día) u otro día (semana). */
  function destinoDe(columnaId: string, minuto: number) {
    const time = minutesToTime(minuto);
    return vista === "dia"
      ? { professionalId: columnaId, date: desde, time }
      : { date: columnaId, time };
  }

  function alHacerClicEnVacio(columnaId: string, minuto: number) {
    const d = destinoDe(columnaId, minuto);
    setDialogoCita({
      modo: "crear",
      inicial: {
        professionalId:
          "professionalId" in d ? d.professionalId : profesionalId !== TODOS ? profesionalId : undefined,
        date: d.date,
        time: d.time,
      },
    });
  }

  async function aplicarMovimiento(
    cita: Cita,
    cambios: { professionalId?: string; date?: string; time: string },
    force: boolean,
    avisar: boolean
  ) {
    try {
      const r = await api.patch<{ avisoAlPaciente: { enviado: boolean; motivo?: string } | null }>(
        `/dashboard/clinics/${clinicId}/appointments/${cita.id}`,
        { ...cambios, force, notifyPatient: avisar }
      );
      toast.success("Cita movida.", {
        // El aviso al paciente es opcional en cada cambio: si no se pidió antes,
        // queda a un clic. Reenvía el mismo destino, con `force` porque ya se aceptó.
        action: avisar
          ? undefined
          : {
              label: "Avisar al paciente",
              onClick: async () => {
                try {
                  const a = await api.patch<{
                    avisoAlPaciente: { enviado: boolean; motivo?: string } | null;
                  }>(`/dashboard/clinics/${clinicId}/appointments/${cita.id}`, {
                    ...cambios,
                    force: true,
                    notifyPatient: true,
                  });
                  if (a.avisoAlPaciente?.enviado) toast.success("Paciente avisado.");
                  else avisarSiFallo(a.avisoAlPaciente);
                } catch (err) {
                  toast.error(err instanceof ApiError ? err.message : "No se pudo avisar");
                }
              },
            },
      });
      avisarSiFallo(r.avisoAlPaciente);
      recargar();
    } catch (err) {
      if (err instanceof ApiError && err.body.requiereConfirmacion) {
        setConfirmacion({
          violaciones: err.body.violaciones as Violacion[],
          resumen: `Mover la cita de ${cita.patient.name ?? cita.patient.phone} a las ${cambios.time}.`,
          onConfirmar: (avisarAhora) => {
            setConfirmacion(null);
            aplicarMovimiento(cita, cambios, true, avisarAhora);
          },
        });
      } else {
        toast.error(err instanceof ApiError ? err.message : "No se pudo mover la cita");
        // Se vuelve a pedir la agenda: la cita no se movió, y no puede
        // quedar dibujada donde no está.
        recargar();
      }
    }
  }

  function moverCita(cita: CitaEnGrilla, columnaId: string, minuto: number) {
    const completa = (data?.citas ?? []).find((c) => c.id === cita.id);
    if (!completa) return;
    const destino = destinoDe(columnaId, minuto);
    const hoy = fechaYHoraEnZona(completa.startTime, timezone);
    const mismo =
      destino.date === hoy.date &&
      destino.time === hoy.time &&
      (!("professionalId" in destino) || destino.professionalId === completa.professionalId);
    if (mismo) return;
    aplicarMovimiento(completa, destino, false, false);
  }

  async function moverBloqueo(bloqueo: BloqueoEnGrilla, columnaId: string, minuto: number) {
    const destino = destinoDe(columnaId, minuto);
    try {
      await api.patch(`/dashboard/clinics/${clinicId}/blocks/${bloqueo.id}`, destino);
      toast.success("Bloqueo movido.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo mover el bloqueo");
    }
    recargar();
  }

  function mover(pasos: number) {
    setAncla((actual) => addDaysToDateKey(actual, vista === "dia" ? pasos : pasos * 7));
  }

  return (
    <div>
      <h1>Agenda</h1>

      <div
        className="card"
        style={{ marginBottom: 16, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}
      >
        <div className="field" style={{ marginBottom: 0 }}>
          <Label htmlFor="vista">Vista</Label>
          <Select value={vista} onValueChange={(v) => v && setVista(v as "dia" | "semana")}>
            <SelectTrigger id="vista" style={{ minWidth: 120 }}>
              <SelectValue>{vista === "dia" ? "Día" : "Semana"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="dia">Día</SelectItem>
              <SelectItem value="semana">Semana</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="field" style={{ marginBottom: 0, flex: "1 1 200px" }}>
          <Label htmlFor="profesional">Profesional</Label>
          <Select value={profesionalId} onValueChange={(v) => v && setProfesionalId(v)}>
            <SelectTrigger id="profesional">
              <SelectValue>
                {profesionalId === TODOS
                  ? "Todos"
                  : profesionales.find((p) => p.id === profesionalId)?.name}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {/* En semana no tiene sentido "Todos": las columnas son los días. */}
              {vista === "dia" && <SelectItem value={TODOS}>Todos</SelectItem>}
              {profesionales.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {puedeGestionar && opciones && (
          <div style={{ display: "flex", gap: 8 }}>
            <Button
              type="button"
              onClick={() =>
                setDialogoCita({
                  modo: "crear",
                  inicial: {
                    professionalId: profesionalId !== TODOS ? profesionalId : undefined,
                    date: desde,
                    time: "",
                  },
                })
              }
            >
              <Plus size={16} /> Nueva cita
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                setDialogoBloqueo({
                  inicial: {
                    professionalId: profesionalId !== TODOS ? profesionalId : undefined,
                    date: desde,
                    time: "",
                  },
                })
              }
            >
              <Ban size={16} /> Bloquear horario
            </Button>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, alignItems: "center", marginLeft: "auto" }}>
          <Button type="button" variant="outline" onClick={() => mover(-1)} aria-label="Anterior">
            <ChevronLeft size={16} />
          </Button>
          <Button type="button" variant="outline" onClick={() => setAncla(hoyEnZona())}>
            Hoy
          </Button>
          <Button type="button" variant="outline" onClick={() => mover(1)} aria-label="Siguiente">
            <ChevronRight size={16} />
          </Button>
        </div>
      </div>

      <div className="agenda-periodo">
        {/* Decorativo: el texto del título ya dice el período. Un día y una semana llevan íconos distintos. */}
        <span className="agenda-periodo__icono" aria-hidden="true">
          {vista === "dia" ? <CalendarDays size={22} /> : <CalendarRange size={22} />}
        </span>
        <h2 className="agenda-periodo__titulo">
          {vista === "dia" ? tituloDeDia(desde) : tituloDeRango(desde, hasta)}
        </h2>
        {data && <span className="agenda-periodo__citas">{etiquetaDeCitas(data.citas.length)}</span>}
      </div>

      {loading ? (
        <PageSkeleton />
      ) : error ? (
        <ErrorState message={error} onRetry={recargar} />
      ) : (
        <CalendarGrid
          columnas={columnas}
          desdeMinuto={data?.grilla.desdeMinuto ?? 8 * 60}
          hastaMinuto={data?.grilla.hastaMinuto ?? 20 * 60}
          timezone={timezone}
          onCrear={puedeGestionar && opciones ? alHacerClicEnVacio : undefined}
          onAbrirCita={
            puedeGestionar && opciones
              ? (cita) => {
                  // Solo las vigentes se editan: una atendida es historia.
                  const completa = (data?.citas ?? []).find((c) => c.id === cita.id);
                  if (completa?.status === "confirmado") {
                    setDialogoCita({ modo: "editar", cita: completa });
                  }
                }
              : undefined
          }
          onMoverCita={puedeGestionar && opciones ? moverCita : undefined}
          onAbrirBloqueo={
            puedeGestionar && opciones ? (bloqueo) => setDialogoBloqueo({ bloqueo }) : undefined
          }
          onMoverBloqueo={puedeGestionar && opciones ? moverBloqueo : undefined}
          vacio={
            vista === "semana" && profesionalId === TODOS
              ? "Elige un profesional para ver su semana."
              : "No hay citas en este período."
          }
        />
      )}

      {(data?.citas ?? []).some((c) => c.preferredRoomUnavailable) && (
        <p className="muted" style={{ fontSize: "0.85em", marginTop: 12 }}>
          <span style={{ color: "var(--destructive)", fontWeight: 700 }}>*</span> el espacio
          habitual del profesional estaba ocupado a esa hora, así que se le asignó otro.
        </p>
      )}

      {(data?.citas ?? []).some((c) => (c.forcedRules ?? []).length > 0) && (
        <p className="muted" style={{ fontSize: "0.85em", marginTop: 12 }}>
          <span style={{ color: "var(--destructive)", fontWeight: 700 }}>!</span> la cita se guardó
          saltando alguna regla (sobreturno, fuera de horario…). Ábrela para ver cuál.
        </p>
      )}

      {puedeGestionar && (
        <p className="muted" style={{ fontSize: "0.85em", marginTop: 12 }}>
          Haz clic en un lugar vacío para crear una cita, en una cita para editarla o cancelarla, y
          arrástrala a otro horario, a otro profesional (vista día) o a otro día (vista semana).
          Los bloqueos de color rayado frenan al asistente; los que cargas a mano también se mueven.
        </p>
      )}

      <p className="muted" style={{ fontSize: "0.85em", marginTop: 12 }}>
        La grilla va de {minutesToTime(data?.grilla.desdeMinuto ?? 480)} a{" "}
        {minutesToTime(data?.grilla.hastaMinuto ?? 1200)}, que es el horario de atención cargado en
        "Horarios". Las citas canceladas no se muestran.
      </p>

      {dialogoCita && opciones && (
        <AppointmentDialog
          clinicId={clinicId}
          opciones={opciones}
          timezone={timezone}
          modo={dialogoCita.modo}
          cita={dialogoCita.modo === "editar" ? dialogoCita.cita : undefined}
          inicial={dialogoCita.modo === "crear" ? dialogoCita.inicial : undefined}
          onCerrar={() => setDialogoCita(null)}
          onGuardado={() => {
            setDialogoCita(null);
            recargar();
          }}
        />
      )}

      {dialogoBloqueo && opciones && (
        <BlockDialog
          clinicId={clinicId}
          opciones={opciones}
          timezone={timezone}
          bloqueo={dialogoBloqueo.bloqueo}
          inicial={dialogoBloqueo.inicial}
          onCerrar={() => setDialogoBloqueo(null)}
          onGuardado={() => {
            setDialogoBloqueo(null);
            recargar();
          }}
        />
      )}

      {confirmacion && (
        <RulesConfirmDialog
          violaciones={confirmacion.violaciones}
          resumen={confirmacion.resumen}
          onConfirmar={confirmacion.onConfirmar}
          onCancelar={() => {
            setConfirmacion(null);
            // La cita no se movió: se vuelve a dibujar donde estaba.
            recargar();
          }}
        />
      )}
    </div>
  );
}

function diasDeLaSemana(lunes: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDaysToDateKey(lunes, i));
}
