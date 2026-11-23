import { useRef, useState, type DragEvent, type MouseEvent } from "react";
import { minutesToTime } from "../../lib/weekdays";
import { bandasCerradas, type Disponibilidad } from "../../lib/closed-bands";
import { repartirEnCarriles } from "../../lib/appointment-lanes";

/**
 * La grilla horaria del calendario.
 *
 * **No sabe qué representan sus columnas.** En la vista de día son
 * profesionales, en la de semana son días, y el día en que la clínica tenga
 * sucursales pueden ser sucursales sin tocar este archivo. Recibe columnas
 * con citas y las ubica por hora; nada más.
 *
 * Las citas se posicionan en píxeles absolutos calculados desde los minutos
 * —no con filas de tabla— porque una cita de 15 minutos tiene que ocupar un
 * cuarto de la altura de una hora, y las que se solapan tienen que poder
 * convivir en la misma franja.
 *
 * **Editable** (si se le pasan los callbacks): clic en un lugar vacío para
 * crear, clic en una cita para abrirla, y arrastrar una cita o un bloqueo a
 * otra hora o a otra columna para moverlo. Tampoco sabe qué significa mover:
 * avisa "esto, a esta columna y a este minuto" y quien la usa decide si la
 * columna es otro profesional o es otro día. Lo que se suelta no se aplica
 * acá: el backend valida y puede pedir confirmación.
 */

export interface CitaEnGrilla {
  id: string;
  service: string;
  startTime: string;
  endTime: string;
  status: string;
  professionalId?: string;
  serviceId?: string | null;
  /** Al profesional no le tocó su espacio habitual porque estaba ocupado. */
  preferredRoomUnavailable?: boolean;
  /** Reglas que se saltaron al guardarla desde la Agenda. */
  forcedRules?: string[];
  /** Viene por un paquete de sesiones: la sesión se descuenta al marcarla atendida. */
  packageId?: string | null;
  /** Cuándo una persona confirmó que se cumplió (es lo que descuenta la sesión). */
  attendedAt?: string | null;
  package?: { serviceName: string; totalSessions: number; usedSessions: number } | null;
  patient: { id?: string; name: string | null; phone: string };
  room: { id: string; name: string } | null;
}

export interface BloqueoEnGrilla {
  id: string;
  professionalId: string;
  startTime: string;
  endTime: string;
  isAllDay: boolean;
  /** `manual` se puede mover y borrar; `calendario` viene de un calendario externo. */
  source: "calendario" | "manual";
  title: string | null;
}

export type { Disponibilidad };

export interface Columna {
  id: string;
  titulo: string;
  citas: CitaEnGrilla[];
  bloqueos?: BloqueoEnGrilla[];
  disponibilidad?: Disponibilidad;
}

interface Props {
  columnas: Columna[];
  desdeMinuto: number;
  hastaMinuto: number;
  timezone: string;
  vacio: string;
  /** Clic en un lugar vacío: columna y minuto (redondeado hacia abajo al paso). */
  onCrear?: (columnaId: string, minuto: number) => void;
  onAbrirCita?: (cita: CitaEnGrilla, columnaId: string) => void;
  onMoverCita?: (cita: CitaEnGrilla, columnaId: string, minuto: number) => void;
  onAbrirBloqueo?: (bloqueo: BloqueoEnGrilla, columnaId: string) => void;
  onMoverBloqueo?: (bloqueo: BloqueoEnGrilla, columnaId: string, minuto: number) => void;
}

/**
 * Alto de una hora.
 *
 * Calibrado para que una cita de 30' —la duración por default— entre con
 * sus DOS líneas (paciente y servicio + espacio) sin recortarse. Con 56px
 * el renglón del servicio quedaba cortado al medio.
 */
const PX_POR_HORA = 72;

/** Al soltar o hacer clic, el minuto se ajusta a cuartos de hora: como se habla de los turnos. */
export const PASO_MINUTOS = 15;

interface Arrastre {
  tipo: "cita" | "bloqueo";
  id: string;
  /** Cuánto dura lo que se arrastra, para dibujar dónde va a quedar. */
  duracion: number;
  /** Dónde lo agarró la persona, en minutos desde el borde de arriba. */
  agarre: number;
}

interface VistaPrevia {
  columnaId: string;
  minuto: number;
  duracion: number;
}

export function CalendarGrid(props: Props) {
  const { columnas, desdeMinuto, hastaMinuto, timezone, vacio } = props;
  const editable = Boolean(props.onCrear || props.onMoverCita || props.onMoverBloqueo);

  // En un ref y no en estado: cambia en cada `dragstart` y no necesita volver a
  // dibujar nada. Lo que sí se dibuja es la vista previa.
  const arrastre = useRef<Arrastre | null>(null);
  const [vistaPrevia, setVistaPrevia] = useState<VistaPrevia | null>(null);
  const [arrastrandoId, setArrastrandoId] = useState<string | null>(null);

  if (columnas.length === 0) {
    return <p className="muted">{vacio}</p>;
  }

  const horas = horasDeLaGrilla(desdeMinuto, hastaMinuto);
  const alto = ((hastaMinuto - desdeMinuto) / 60) * PX_POR_HORA;

  // Citas que se pisan en una columna (un sobreturno): cada una en su carril,
  // lado a lado, para que la de abajo no quede tapada por la de arriba.
  const carrilesPorColumna = new Map(
    columnas.map((c) => [
      c.id,
      repartirEnCarriles(
        c.citas.map((cita) => ({
          id: cita.id,
          inicio: minutosDelDia(cita.startTime, timezone),
          fin: minutosDelDia(cita.endTime, timezone),
        }))
      ),
    ])
  );

  /** Minuto del día bajo el puntero, ajustado al paso y dentro de la grilla. */
  function minutoBajoElPuntero(e: { clientY: number }, col: HTMLElement, agarre = 0, duracion = 0) {
    const rect = col.getBoundingClientRect();
    const crudo = desdeMinuto + ((e.clientY - rect.top) / PX_POR_HORA) * 60 - agarre;
    const ajustado = Math.round(crudo / PASO_MINUTOS) * PASO_MINUTOS;
    return Math.min(Math.max(ajustado, desdeMinuto), Math.max(hastaMinuto - duracion, desdeMinuto));
  }

  function alEmpezar(
    e: DragEvent<HTMLElement>,
    tipo: Arrastre["tipo"],
    id: string,
    inicio: number,
    fin: number
  ) {
    const rect = e.currentTarget.getBoundingClientRect();
    arrastre.current = {
      tipo,
      id,
      duracion: fin - inicio,
      agarre: ((e.clientY - rect.top) / PX_POR_HORA) * 60,
    };
    // Firefox no arranca el arrastre sin datos.
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.effectAllowed = "move";
    setArrastrandoId(id);
  }

  function alTerminar() {
    arrastre.current = null;
    setArrastrandoId(null);
    setVistaPrevia(null);
  }

  function alPasarPor(e: DragEvent<HTMLElement>, columnaId: string) {
    const a = arrastre.current;
    if (!a) return;
    // Sin esto el navegador no deja soltar.
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const minuto = minutoBajoElPuntero(e, e.currentTarget, a.agarre, a.duracion);
    setVistaPrevia((previa) =>
      previa?.columnaId === columnaId && previa.minuto === minuto
        ? previa
        : { columnaId, minuto, duracion: a.duracion }
    );
  }

  function alSoltar(e: DragEvent<HTMLElement>, columna: Columna) {
    const a = arrastre.current;
    if (!a) return;
    e.preventDefault();
    const minuto = minutoBajoElPuntero(e, e.currentTarget, a.agarre, a.duracion);
    alTerminar();

    if (a.tipo === "cita") {
      const cita = columnasTodas(columnas).citas.find((c) => c.id === a.id);
      if (cita) props.onMoverCita?.(cita, columna.id, minuto);
    } else {
      const bloqueo = columnasTodas(columnas).bloqueos.find((b) => b.id === a.id);
      if (bloqueo) props.onMoverBloqueo?.(bloqueo, columna.id, minuto);
    }
  }

  function alHacerClic(e: MouseEvent<HTMLElement>, columna: Columna) {
    if (!props.onCrear) return;
    // Solo un lugar vacío: un clic en una cita o un bloqueo lo atiende su propio manejador.
    if ((e.target as HTMLElement).closest(".calendar-cita, .calendar-bloqueo")) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const crudo = desdeMinuto + ((e.clientY - rect.top) / PX_POR_HORA) * 60;
    const minuto = Math.floor(crudo / PASO_MINUTOS) * PASO_MINUTOS;
    props.onCrear(columna.id, Math.min(Math.max(minuto, desdeMinuto), hastaMinuto - PASO_MINUTOS));
  }

  return (
    <div className="card" style={{ overflowX: "auto" }}>
      <div className="calendar-grid" style={{ minWidth: 120 + columnas.length * 160 }}>
        <div className="calendar-grid__header">
          <div className="calendar-grid__gutter" />
          {columnas.map((c) => (
            <div key={c.id} className="calendar-grid__col-title">
              {c.titulo}
            </div>
          ))}
        </div>

        <div className="calendar-grid__body" style={{ height: alto }}>
          <div className="calendar-grid__gutter">
            {horas.map((minuto) => (
              <div
                key={minuto}
                className="calendar-grid__hour-label"
                style={{ top: posicion(minuto, desdeMinuto) }}
              >
                {minutesToTime(minuto)}
              </div>
            ))}
          </div>

          {columnas.map((columna) => (
            <div
              key={columna.id}
              className={`calendar-grid__col${editable ? " calendar-grid__col--editable" : ""}`}
              onClick={(e) => alHacerClic(e, columna)}
              onDragOver={editable ? (e) => alPasarPor(e, columna.id) : undefined}
              onDrop={editable ? (e) => alSoltar(e, columna) : undefined}
            >
              {horas.map((minuto) => (
                <div
                  key={minuto}
                  className="calendar-grid__line"
                  style={{ top: posicion(minuto, desdeMinuto) }}
                />
              ))}

              {/*
                * Lo cerrado va ANTES de las citas en el DOM para que quede
                * por debajo: un turno que caiga en una franja bloqueada
                * —no debería, pero puede haber quedado de antes— tiene que
                * verse igual.
                */}
              {bandasCerradas(columna.disponibilidad, desdeMinuto, hastaMinuto).map((banda) => (
                <div
                  key={`${banda.startMinute}-${banda.endMinute}`}
                  className="calendar-grid__cerrado"
                  style={{
                    top: posicion(banda.startMinute, desdeMinuto),
                    height: ((banda.endMinute - banda.startMinute) / 60) * PX_POR_HORA,
                  }}
                />
              ))}

              {columna.disponibilidad?.cerrado && (
                <div className="calendar-grid__cerrado-rotulo">
                  {columna.disponibilidad.motivo ?? "Cerrado"}
                </div>
              )}

              {(columna.bloqueos ?? []).map((bloqueo) => {
                const { inicio, fin } = rangoVisible(bloqueo, timezone, desdeMinuto, hastaMinuto);
                if (fin <= inicio) return null;
                const manual = bloqueo.source === "manual";
                const movible = manual && Boolean(props.onMoverBloqueo);
                return (
                  <div
                    key={bloqueo.id}
                    className={[
                      "calendar-bloqueo",
                      manual ? "calendar-bloqueo--manual" : "",
                      arrastrandoId === bloqueo.id ? "calendar-cita--arrastrando" : "",
                    ].join(" ")}
                    style={{
                      top: posicion(inicio, desdeMinuto),
                      height: Math.max(((fin - inicio) / 60) * PX_POR_HORA - 2, 18),
                    }}
                    draggable={movible}
                    onDragStart={
                      movible ? (e) => alEmpezar(e, "bloqueo", bloqueo.id, inicio, fin) : undefined
                    }
                    onDragEnd={movible ? alTerminar : undefined}
                    onClick={
                      manual && props.onAbrirBloqueo
                        ? () => props.onAbrirBloqueo!(bloqueo, columna.id)
                        : undefined
                    }
                    title={
                      manual
                        ? `${bloqueo.title ?? "Bloqueado"} · ${minutesToTime(inicio)}–${minutesToTime(fin)}`
                        : "Bloqueado: evento importado del calendario del profesional"
                    }
                  >
                    {bloqueo.isAllDay ? "Todo el día · " : `${minutesToTime(inicio)} `}
                    {manual ? bloqueo.title ?? "Bloqueado" : "Bloqueado"}
                  </div>
                );
              })}

              {columna.citas.map((cita) => {
                const inicio = minutosDelDia(cita.startTime, timezone);
                const { carril, carriles } = carrilesPorColumna.get(columna.id)?.get(cita.id) ?? { carril: 0, carriles: 1 };
                const fin = minutosDelDia(cita.endTime, timezone);
                const movible = Boolean(props.onMoverCita) && cita.status === "confirmado";
                const forzada = (cita.forcedRules ?? []).length > 0;
                return (
                  <div
                    key={cita.id}
                    className={[
                      "calendar-cita",
                      `calendar-cita--${cita.status}`,
                      movible ? "calendar-cita--editable" : "",
                      forzada ? "calendar-cita--forzada" : "",
                      arrastrandoId === cita.id ? "calendar-cita--arrastrando" : "",
                    ].join(" ")}
                    style={{
                      top: posicion(inicio, desdeMinuto),
                      // Con más de una cita a la vez, cada una toma su parte del ancho.
                      ...(carriles > 1
                        ? {
                            left: `calc(${(carril / carriles) * 100}% + 3px)`,
                            right: "auto",
                            width: `calc(${100 / carriles}% - 6px)`,
                          }
                        : {}),
                      // Mínimo de 18px: una cita de 15' sin esto queda
                      // ilegible, y es la duración de media pantalla de
                      // servicios cortos.
                      height: Math.max(((fin - inicio) / 60) * PX_POR_HORA - 2, 18),
                    }}
                    draggable={movible}
                    onDragStart={movible ? (e) => alEmpezar(e, "cita", cita.id, inicio, fin) : undefined}
                    onDragEnd={movible ? alTerminar : undefined}
                    onClick={props.onAbrirCita ? () => props.onAbrirCita!(cita, columna.id) : undefined}
                    title={[
                      `${minutesToTime(inicio)}–${minutesToTime(fin)}`,
                      cita.service,
                      cita.patient.name ?? cita.patient.phone,
                      cita.room?.name,
                      cita.preferredRoomUnavailable
                        ? "Su espacio habitual estaba ocupado, se le asignó este"
                        : null,
                      forzada ? "Se guardó saltando reglas (ver al abrirla)" : null,
                      cita.package
                        ? `Paquete: ${cita.package.usedSessions} de ${cita.package.totalSessions} sesiones usadas${
                            cita.attendedAt ? " (esta ya se descontó)" : ""
                          }`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  >
                    <div className="calendar-cita__titulo">
                      <strong>{minutesToTime(inicio)}</strong>{" "}
                      {cita.patient.name ?? cita.patient.phone}
                    </div>
                    <div className="calendar-cita__detalle">
                      {cita.service}
                      {cita.room ? ` · ${cita.room.name}` : ""}
                      {cita.packageId ? (cita.attendedAt ? " · paquete ✓" : " · paquete") : ""}
                      {/* El detalle completo está en el `title`: acá no
                          entra, y una cita de 15' ya viene justa. */}
                      {cita.preferredRoomUnavailable && (
                        <span className="calendar-cita__marca">*</span>
                      )}
                      {forzada && <span className="calendar-cita__marca">!</span>}
                    </div>
                  </div>
                );
              })}

              {vistaPrevia?.columnaId === columna.id && (
                <div
                  className="calendar-grid__vista-previa"
                  style={{
                    top: posicion(vistaPrevia.minuto, desdeMinuto),
                    height: Math.max((vistaPrevia.duracion / 60) * PX_POR_HORA - 2, 18),
                  }}
                >
                  {minutesToTime(vistaPrevia.minuto)}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Todas las citas y bloqueos de todas las columnas, para encontrar el que se soltó. */
function columnasTodas(columnas: Columna[]) {
  return {
    citas: columnas.flatMap((c) => c.citas),
    bloqueos: columnas.flatMap((c) => c.bloqueos ?? []),
  };
}

/**
 * El tramo de un bloqueo que cae dentro de la grilla de ESE día. Un bloqueo de
 * todo el día ocupa toda la columna; uno que cruza la medianoche se corta en el
 * borde, porque `minutosDelDia()` del fin daría un número chico y lo dibujaría
 * al revés.
 */
function rangoVisible(
  bloqueo: BloqueoEnGrilla,
  timezone: string,
  desdeMinuto: number,
  hastaMinuto: number
): { inicio: number; fin: number } {
  if (bloqueo.isAllDay) return { inicio: desdeMinuto, fin: hastaMinuto };
  const inicio = minutosDelDia(bloqueo.startTime, timezone);
  let fin = minutosDelDia(bloqueo.endTime, timezone);
  if (fin <= inicio) fin = hastaMinuto;
  return { inicio: Math.max(inicio, desdeMinuto), fin: Math.min(fin, hastaMinuto) };
}

/** Las horas en punto que entran en el rango, para las líneas y los rótulos. */
function horasDeLaGrilla(desdeMinuto: number, hastaMinuto: number): number[] {
  const primera = Math.floor(desdeMinuto / 60) * 60;
  const horas: number[] = [];
  for (let m = primera; m <= hastaMinuto; m += 60) {
    if (m >= desdeMinuto) horas.push(m);
  }
  return horas;
}

function posicion(minuto: number, desdeMinuto: number): number {
  return ((minuto - desdeMinuto) / 60) * PX_POR_HORA;
}

/**
 * Minutos desde la medianoche **en la zona de la clínica**.
 *
 * Nunca con `getHours()`: eso usa la zona del navegador, así que una
 * recepcionista mirando desde otro huso vería las citas corridas.
 */
function minutosDelDia(iso: string, timeZone: string): number {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));

  const valor = (type: string) => Number(partes.find((p) => p.type === type)?.value ?? 0);
  // A medianoche en punto `hour` puede venir como 24 en algunos entornos.
  return (valor("hour") % 24) * 60 + valor("minute");
}
