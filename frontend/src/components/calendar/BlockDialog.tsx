import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api, ApiError } from "../../api/client";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { DateField } from "../ui/date-field";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { CheckList } from "../CheckList";
import { fechaYHoraEnZona } from "../../lib/wall-time";
import { nombreProfesional, type AgendaOpciones } from "../../lib/agenda-rules";
import type { BloqueoEnGrilla } from "./CalendarGrid";

interface Props {
  clinicId: string;
  opciones: AgendaOpciones;
  timezone: string;
  /** Con `bloqueo` se edita; sin él se crea. */
  bloqueo?: BloqueoEnGrilla;
  inicial?: { professionalId?: string; date: string; time: string };
  onCerrar: () => void;
  onGuardado: () => void;
}

/**
 * Un bloqueo de la agenda de uno o más profesionales (reunión, almuerzo,
 * vacaciones). Frena al asistente de WhatsApp igual que un evento importado de
 * Google Calendar. No cancela las citas que ya existan en ese rato: solo evita
 * que se agenden nuevas.
 */
export function BlockDialog(props: Props) {
  const { clinicId, opciones, timezone, bloqueo } = props;
  const edita = Boolean(bloqueo);

  const inicio = bloqueo ? fechaYHoraEnZona(bloqueo.startTime, timezone) : null;
  const fin = bloqueo ? fechaYHoraEnZona(bloqueo.endTime, timezone) : null;

  const [title, setTitle] = useState(bloqueo?.title ?? "");
  const [professionalIds, setProfessionalIds] = useState<string[]>(
    bloqueo ? [bloqueo.professionalId] : props.inicial?.professionalId ? [props.inicial.professionalId] : []
  );
  const [professionalId, setProfessionalId] = useState(bloqueo?.professionalId ?? "");
  const [date, setDate] = useState(inicio?.date ?? props.inicial?.date ?? "");
  const [allDay, setAllDay] = useState(bloqueo?.isAllDay ?? false);
  const [startTime, setStartTime] = useState(inicio?.time ?? props.inicial?.time ?? "");
  const [endTime, setEndTime] = useState(
    fin?.time ?? (props.inicial ? sumarUnaHora(props.inicial.time) : "")
  );
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const valido =
    title.trim() &&
    date &&
    (allDay || (startTime && endTime && endTime > startTime)) &&
    (edita ? professionalId : professionalIds.length > 0);

  async function guardar(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setGuardando(true);
    try {
      if (edita) {
        await api.patch(`/dashboard/clinics/${clinicId}/blocks/${bloqueo!.id}`, {
          title,
          date,
          professionalId,
          ...(allDay ? {} : { startTime, endTime }),
        });
        toast.success("Bloqueo actualizado.");
      } else {
        await api.post(`/dashboard/clinics/${clinicId}/blocks`, {
          title,
          date,
          professionalIds,
          allDay,
          ...(allDay ? {} : { startTime, endTime }),
        });
        toast.success("Bloqueo creado.");
      }
      props.onGuardado();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo guardar el bloqueo");
    } finally {
      setGuardando(false);
    }
  }

  async function borrar() {
    setGuardando(true);
    try {
      await api.delete(`/dashboard/clinics/${clinicId}/blocks/${bloqueo!.id}`);
      toast.success("Bloqueo borrado.");
      props.onGuardado();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo borrar el bloqueo");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Dialog open onOpenChange={(abierto) => !abierto && props.onCerrar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{edita ? "Editar bloqueo" : "Nuevo bloqueo"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={guardar}>
          <div className="field">
            <Label htmlFor="bloqueo-titulo">Motivo</Label>
            <Input
              id="bloqueo-titulo"
              maxLength={120}
              placeholder="Reunión, almuerzo, vacaciones…"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          {edita ? (
            <div className="field">
              <Label htmlFor="bloqueo-prof">Profesional</Label>
              <Select value={professionalId} onValueChange={(v) => v && setProfessionalId(v)}>
                <SelectTrigger id="bloqueo-prof">
                  <SelectValue>
                    {nombreProfesional(
                      opciones.profesionales.find((p) => p.id === professionalId) ?? {
                        name: "—",
                        title: null,
                      }
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {opciones.profesionales.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {nombreProfesional(p)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="field">
              <Label>Profesionales</Label>
              <CheckList
                idPrefix="bloqueo-prof"
                items={opciones.profesionales.map((p) => ({ id: p.id, label: nombreProfesional(p) }))}
                value={professionalIds}
                onChange={setProfessionalIds}
              />
            </div>
          )}

          <div className="field">
            <Label htmlFor="bloqueo-fecha">Día</Label>
            <DateField id="bloqueo-fecha" value={date} onChange={setDate} />
          </div>

          <div className="checkbox-field">
            <Checkbox id="bloqueo-todo" checked={allDay} onCheckedChange={(v) => setAllDay(v === true)} />
            <Label htmlFor="bloqueo-todo">Todo el día</Label>
          </div>

          {!allDay && (
            <div style={{ display: "flex", gap: 12 }}>
              <div className="field" style={{ flex: 1 }}>
                <Label htmlFor="bloqueo-desde">Desde</Label>
                <Input
                  id="bloqueo-desde"
                  type="time"
                  step={900}
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <Label htmlFor="bloqueo-hasta">Hasta</Label>
                <Input
                  id="bloqueo-hasta"
                  type="time"
                  step={900}
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                />
              </div>
            </div>
          )}

          <p className="muted" style={{ fontSize: "0.85em" }}>
            El asistente no ofrece ni agenda citas en ese rato. Las citas que ya estén ahí no se
            cancelan.
          </p>

          {error && <p className="error-text">{error}</p>}

          <DialogFooter>
            {edita && (
              <Button
                type="button"
                variant="outline"
                style={{ marginRight: "auto" }}
                disabled={guardando}
                onClick={borrar}
              >
                Borrar
              </Button>
            )}
            <Button type="button" variant="outline" onClick={props.onCerrar}>
              Cerrar
            </Button>
            <Button type="submit" disabled={guardando || !valido}>
              {guardando ? "Guardando…" : edita ? "Guardar" : "Crear bloqueo"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "10:30" → "11:30", sin pasar de las 23:59. */
function sumarUnaHora(hora: string): string {
  const [h, m] = hora.split(":").map(Number);
  if (Number.isNaN(h)) return "";
  return `${String(Math.min(h + 1, 23)).padStart(2, "0")}:${String(h + 1 > 23 ? 59 : m).padStart(2, "0")}`;
}
