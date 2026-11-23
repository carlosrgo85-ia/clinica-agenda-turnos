import { Link } from "react-router-dom";
import { Building2 } from "lucide-react";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";

/**
 * Lo que ve un super-admin en cualquier pantalla por clínica (Turnos,
 * Horarios, Usuarios, etc.) cuando todavía no eligió una clínica para
 * mirar — `useEffectiveClinicId()` devuelve `null` hasta que entra a una
 * desde "Clínicas". No es un permiso que le falte: el acceso está, pero
 * hay que elegir A CUÁL clínica antes de poder mostrar sus datos.
 */
export function ClinicScopeRequired() {
  return (
    <EmptyState
      icon={Building2}
      title="Elige una clínica para ver esto"
      description="Esta pantalla muestra datos de una clínica en particular. Entra a una desde Clínicas."
      action={
        <Link to="/platform/clinics">
          <Button variant="outline" size="sm">
            Ir a Clínicas
          </Button>
        </Link>
      }
    />
  );
}
