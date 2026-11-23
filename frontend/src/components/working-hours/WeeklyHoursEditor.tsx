import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "../ui/button";
import { minutesToTime, timeToMinutes, WEEKDAY_LABELS, WEEKDAYS, type Weekday } from "../../lib/weekdays";

export interface TramoInput {
  weekday: Weekday;
  startMinute: number;
  endMinute: number;
}

interface Tramo {
  start: string;
  end: string;
}

/**
 * Editor de horario semanal, reusado para la clínica y para cada
 * profesional (mismo contrato que `PUT working-hours`: se manda el set
 * completo de tramos, no un diff). El corte de mediodía es simplemente dos
 * tramos en el mismo día — "Agregar tramo" es lo que permite cargarlo.
 */
export function WeeklyHoursEditor({
  initialTramos,
  readOnly,
  saving,
  onSave,
  saveLabel = "Guardar horario",
}: {
  initialTramos: TramoInput[];
  readOnly?: boolean;
  saving?: boolean;
  onSave: (tramos: TramoInput[]) => void;
  /** Para cuando se embebe en otro formulario ("Usar este horario"). */
  saveLabel?: string;
}) {
  const [byDay, setByDay] = useState<Record<Weekday, Tramo[]>>(() => groupByDay(initialTramos));

  function addTramo(day: Weekday) {
    setByDay((prev) => ({ ...prev, [day]: [...prev[day], { start: "09:00", end: "18:00" }] }));
  }

  function removeTramo(day: Weekday, index: number) {
    setByDay((prev) => ({ ...prev, [day]: prev[day].filter((_, i) => i !== index) }));
  }

  function updateTramo(day: Weekday, index: number, field: "start" | "end", value: string) {
    setByDay((prev) => ({
      ...prev,
      [day]: prev[day].map((t, i) => (i === index ? { ...t, [field]: value } : t)),
    }));
  }

  function handleSave() {
    const tramos: TramoInput[] = [];
    for (const day of WEEKDAYS) {
      for (const t of byDay[day]) {
        tramos.push({ weekday: day, startMinute: timeToMinutes(t.start), endMinute: timeToMinutes(t.end) });
      }
    }
    onSave(tramos);
  }

  return (
    <div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {WEEKDAYS.map((day) => (
          <div key={day} style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <span style={{ width: 90, flexShrink: 0, paddingTop: 8 }}>{WEEKDAY_LABELS[day]}</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
              {byDay[day].length === 0 && <span className="muted">Cerrado</span>}
              {byDay[day].map((tramo, index) => (
                <div key={index} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    className="input"
                    type="time"
                    value={tramo.start}
                    disabled={readOnly}
                    onChange={(e) => updateTramo(day, index, "start", e.target.value)}
                    style={{ width: 150 }}
                  />
                  <span className="muted">a</span>
                  <input
                    className="input"
                    type="time"
                    value={tramo.end}
                    disabled={readOnly}
                    onChange={(e) => updateTramo(day, index, "end", e.target.value)}
                    style={{ width: 150 }}
                  />
                  {!readOnly && (
                    <Button type="button" variant="ghost" size="icon" onClick={() => removeTramo(day, index)} aria-label="Quitar tramo">
                      <Trash2 size={14} />
                    </Button>
                  )}
                </div>
              ))}
              {!readOnly && (
                <Button type="button" variant="outline" size="sm" onClick={() => addTramo(day)} style={{ alignSelf: "flex-start" }}>
                  <Plus size={14} /> Agregar tramo
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      {!readOnly && (
        <Button type="button" onClick={handleSave} disabled={saving} style={{ marginTop: 16 }}>
          {saving ? "Guardando…" : saveLabel}
        </Button>
      )}
    </div>
  );
}

function groupByDay(tramos: TramoInput[]): Record<Weekday, Tramo[]> {
  const result = Object.fromEntries(WEEKDAYS.map((d) => [d, [] as Tramo[]])) as Record<Weekday, Tramo[]>;
  for (const t of tramos) {
    result[t.weekday].push({ start: minutesToTime(t.startMinute), end: minutesToTime(t.endMinute) });
  }
  return result;
}
