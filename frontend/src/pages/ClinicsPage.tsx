import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Building2, Plus } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "../auth/AuthContext";
import { api, ApiError } from "../api/client";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { PageSkeleton } from "../components/ui/skeleton";

interface ClinicRow {
  id: string;
  name: string;
  email: string;
  active: boolean;
  country: string | null;
  plan: { id: string; name: string } | null;
}

export function ClinicsPage() {
  const { user, hasPermission } = useAuth();
  const canCreate = hasPermission("clinicas.crear");
  const canEdit = hasPermission("clinicas.editar");

  const [clinics, setClinics] = useState<ClinicRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setClinics(await api.get<ClinicRow[]>("/platform/clinics"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo cargar la lista de clínicas");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (user && user.clinicId !== null) {
    return <p className="muted">Esta pantalla es de plataforma — un usuario de clínica no tiene acceso.</p>;
  }

  async function handleToggleActive(clinic: ClinicRow, active: boolean) {
    try {
      await api.put(`/platform/clinics/${clinic.id}`, { active });
      toast.success(`Clínica "${clinic.name}" ${active ? "activada" : "desactivada"}.`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo actualizar la clínica");
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h1>Clínicas</h1>
          <p className="muted">Todas las clínicas clientes de la plataforma, con su país, plan y estado.</p>
        </div>
        {canCreate && (
          <Link to="/platform/clinics/new">
            <Button>
              <Plus size={16} /> Crear clínica
            </Button>
          </Link>
        )}
      </div>

      {loading ? (
        <PageSkeleton />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : clinics.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="Todavía no hay clínicas"
          description={canCreate ? "Crea la primera con el botón \"Crear clínica\"." : "Todavía no se cargó ninguna."}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nombre</TableHead>
              <TableHead>País</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Activa</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {clinics.map((clinic) => (
              <TableRow key={clinic.id}>
                <TableCell>{clinic.name}</TableCell>
                <TableCell className="muted">{clinic.country ?? "sin configurar"}</TableCell>
                <TableCell className="muted">{clinic.plan?.name ?? "sin plan"}</TableCell>
                <TableCell>
                  <Switch
                    checked={clinic.active}
                    disabled={!canEdit}
                    onCheckedChange={(checked) => handleToggleActive(clinic, checked)}
                  />
                </TableCell>
                <TableCell>
                  <Link to={`/platform/clinics/${clinic.id}`}>
                    <Button variant="outline" size="sm">
                      Ver detalle
                    </Button>
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
