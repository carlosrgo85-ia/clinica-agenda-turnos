import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CalendarOff, Trash2 } from "lucide-react";
import { api, ApiError } from "../../api/client";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { DateField } from "../ui/date-field";
import { Label } from "../ui/label";
import { Checkbox } from "../ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { EmptyState } from "../ui/empty-state";
import { ErrorState } from "../ui/error-state";
import { Skeleton } from "../ui/skeleton";
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
} from "../ui/alert-dialog";

interface Exception {
  dateKey: string;
  professionalId: string | null;
  alcance: "clinica" | "profesional";
  reason: string;
  cerradoTodoElDia: boolean;
  tramos: Array<{ desde: string; hasta: string }>;
}

const CLINIC = "__clinica__";

export function ScheduleExceptions({
  clinicId,
  professionals,
  canEdit,
}: {
  clinicId: string;
  professionals: Array<{ id: string; name: string }>;
  canEdit: boolean;
}) {
  const [exceptions, setExceptions] = useState<Exception[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [dateKey, setDateKey] = useState("");
  const [reason, setReason] = useState("");
  const [scope, setScope] = useState(CLINIC);
  const [closedAllDay, setClosedAllDay] = useState(true);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("18:00");
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    setError(null);
    try {
      const data = await api.get<{ excepciones: Exception[] }>(
        `/dashboard/clinics/${clinicId}/schedule-exceptions`
      );
      setExceptions(data.excepciones);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudieron cargar las excepciones");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinicId]);

  async function handleSubmit() {
    setSubmitting(true);
    try {
      await api.put(`/dashboard/clinics/${clinicId}/schedule-exceptions`, {
        dateKey,
        reason,
        professionalId: scope === CLINIC ? null : scope,
        tramos: closedAllDay ? [] : [{ startMinute: toMinutes(start), endMinute: toMinutes(end) }],
      });
      toast.success("Excepción guardada.");
      setDateKey("");
      setReason("");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo guardar la excepción");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(exception: Exception) {
    try {
      const params = exception.professionalId ? `?professionalId=${exception.professionalId}` : "";
      await api.delete(`/dashboard/clinics/${clinicId}/schedule-exceptions/${exception.dateKey}${params}`);
      toast.success("Excepción borrada.");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo borrar");
    }
  }

  return (
    <section className="card">
      <h2>Excepciones (feriados, jornadas especiales)</h2>

      {canEdit && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 20 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <Label htmlFor="exc-date">Fecha</Label>
            <DateField id="exc-date" value={dateKey} onChange={setDateKey} />
          </div>
          <div className="field" style={{ marginBottom: 0, flex: "1 1 200px" }}>
            <Label htmlFor="exc-reason">Motivo</Label>
            <Input
              id="exc-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ej. Feriado nacional"
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <Label>Alcance</Label>
            <Select value={scope} onValueChange={setScope}>
              <SelectTrigger style={{ minWidth: 180 }}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={CLINIC}>Toda la clínica</SelectItem>
                {professionals.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="checkbox-field" style={{ marginBottom: 8 }}>
            <Checkbox
              id="exc-closed"
              checked={closedAllDay}
              onCheckedChange={(checked) => setClosedAllDay(checked === true)}
            />
            <Label htmlFor="exc-closed">Cerrado todo el día</Label>
          </div>
          {!closedAllDay && (
            <>
              <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} style={{ width: 110 }} />
              <span className="muted">a</span>
              <Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} style={{ width: 110 }} />
            </>
          )}
          <Button onClick={handleSubmit} disabled={submitting || !dateKey || !reason.trim()}>
            {submitting ? "Guardando…" : "Agregar"}
          </Button>
        </div>
      )}

      {error ? (
        <ErrorState message={error} onRetry={load} compact />
      ) : exceptions === null ? (
        <Skeleton style={{ height: 100 }} />
      ) : exceptions.length === 0 ? (
        <EmptyState icon={CalendarOff} title="Sin excepciones cargadas" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Fecha</TableHead>
              <TableHead>Alcance</TableHead>
              <TableHead>Motivo</TableHead>
              <TableHead>Horario</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {exceptions.map((exc) => (
              <TableRow key={`${exc.dateKey}-${exc.professionalId ?? "clinica"}`}>
                <TableCell>{exc.dateKey}</TableCell>
                <TableCell>
                  {exc.alcance === "clinica"
                    ? "Toda la clínica"
                    : professionals.find((p) => p.id === exc.professionalId)?.name ?? "Profesional"}
                </TableCell>
                <TableCell>{exc.reason}</TableCell>
                <TableCell>
                  {exc.cerradoTodoElDia
                    ? "Cerrado todo el día"
                    : exc.tramos.map((t) => `${t.desde}–${t.hasta}`).join(", ")}
                </TableCell>
                <TableCell>
                  {canEdit && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label="Borrar">
                          <Trash2 size={16} />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>¿Borrar la excepción del {exc.dateKey}?</AlertDialogTitle>
                          <AlertDialogDescription>Ese día vuelve al horario semanal habitual.</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancelar</AlertDialogCancel>
                          <AlertDialogAction onClick={() => handleDelete(exc)}>Borrar</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}
