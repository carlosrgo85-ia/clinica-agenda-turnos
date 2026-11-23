import { useState } from "react";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";
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
import type { Violacion } from "../../lib/agenda-rules";

/**
 * Se arrastró una cita a un lugar que rompe reglas que se pueden saltar: se
 * muestran, y recién al confirmar se reenvía el cambio con `force`. Cancelar
 * deja la cita donde estaba (el backend no guardó nada).
 */
export function RulesConfirmDialog(props: {
  violaciones: Violacion[];
  /** Qué se estaba por hacer, en una línea ("Mover la cita de María a las 11:30"). */
  resumen: string;
  onConfirmar: (avisarAlPaciente: boolean) => void;
  onCancelar: () => void;
}) {
  const [avisar, setAvisar] = useState(false);

  return (
    <AlertDialog open onOpenChange={(abierto) => !abierto && props.onCancelar()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Hay reglas que no se cumplen</AlertDialogTitle>
          <AlertDialogDescription>{props.resumen}</AlertDialogDescription>
        </AlertDialogHeader>

        <ul style={{ margin: "0 0 12px", paddingLeft: 18 }}>
          {props.violaciones.map((v) => (
            <li key={v.rule}>{v.message}</li>
          ))}
        </ul>

        <div className="checkbox-field">
          <Checkbox id="mover-avisar" checked={avisar} onCheckedChange={(v) => setAvisar(v === true)} />
          <Label htmlFor="mover-avisar">Avisar al paciente por WhatsApp del cambio</Label>
        </div>
        <p className="muted" style={{ fontSize: "0.85em" }}>
          Si confirmas, la cita queda registrada como guardada saltando estas reglas.
        </p>

        <AlertDialogFooter>
          <AlertDialogCancel>Dejarla donde estaba</AlertDialogCancel>
          <AlertDialogAction onClick={() => props.onConfirmar(avisar)}>Mover igual</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
