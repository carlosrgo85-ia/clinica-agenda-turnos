import { useEffect, useState, type FormEvent } from "react";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "../auth/AuthContext";
import { api, ApiError } from "../api/client";
import { PageContainer } from "../components/shell/PageContainer";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { Badge } from "../components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { PageSkeleton } from "../components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";

interface InsurerRow {
  id: string;
  name: string;
  active: boolean;
  /** En cuántas clínicas está tomado, activo o dado de baja. */
  clinicas: number;
  /** Solo las que lo tienen activo: es el número que decide si se puede desactivar. */
  clinicasActivas: number;
}

/**
 * El catálogo global de obras sociales y prepagas.
 *
 * Es de la plataforma y no de cada clínica para que "OSDE" no exista escrita
 * de tres formas distintas. Cada clínica elige cuáles toma desde su propia
 * pantalla "Seguros"; acá solo se mantiene la lista compartida.
 *
 * **Desactivar uno que alguna clínica tenga activo está bloqueado**: el
 * asistente dejaría de decir que trabajan con él de un momento a otro, sin
 * que la clínica haya cambiado nada ni se entere.
 */
export function PlatformInsurersPage() {
  const { user, hasPermission } = useAuth();
  const canEdit = hasPermission("seguros.editar");

  const [insurers, setInsurers] = useState<InsurerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [nuevo, setNuevo] = useState("");
  const [editando, setEditando] = useState<InsurerRow | null>(null);
  const [nombreEditado, setNombreEditado] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [bloqueado, setBloqueado] = useState<InsurerRow | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setInsurers(await api.get<InsurerRow[]>("/platform/insurers"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo cargar el catálogo de seguros");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (user && user.clinicId !== null) {
    return (
      <p className="muted">Esta pantalla es de plataforma — un usuario de clínica no tiene acceso.</p>
    );
  }

  async function guardar(accion: () => Promise<unknown>, exito: string) {
    setSubmitting(true);
    try {
      await accion();
      toast.success(exito);
      await load();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "No se pudo guardar";
      toast.error(message);
      // El backend rechaza desactivar uno en uso: se recarga para que el
      // switch vuelva a reflejar lo que quedó guardado.
      await load();
    } finally {
      setSubmitting(false);
    }
  }

  function crear(e: FormEvent) {
    e.preventDefault();
    const name = nuevo.trim();
    if (!name) return;
    guardar(() => api.post("/platform/insurers", { name }), `"${name}" agregado.`).then(() =>
      setNuevo("")
    );
  }

  function renombrar(e: FormEvent) {
    e.preventDefault();
    if (!editando) return;
    const name = nombreEditado.trim();
    if (!name) return;
    // Las clínicas apuntan por id, así que el nombre nuevo se propaga solo.
    guardar(
      () => api.put(`/platform/insurers/${editando.id}`, { name }),
      `Renombrado a "${name}".`
    ).then(() => setEditando(null));
  }

  function cambiarActivo(insurer: InsurerRow, active: boolean) {
    // El mismo número que mira el backend: una clínica que lo dio de baja no
    // bloquea nada.
    if (!active && insurer.clinicasActivas > 0) {
      setBloqueado(insurer);
      return;
    }
    guardar(
      () => api.put(`/platform/insurers/${insurer.id}`, { active }),
      active ? `"${insurer.name}" activado.` : `"${insurer.name}" desactivado.`
    );
  }

  return (
    <div>
      <h1>Catálogo de seguros</h1>
      <p className="muted">
        Las obras sociales y prepagas que existen en toda la plataforma. Cada clínica elige con
        cuáles trabaja desde su propia pantalla "Seguros" — aquí no se decide eso.
      </p>

      {canEdit && (
        <PageContainer size="form" style={{ margin: "16px 0 24px", padding: 0 }}>
          <form className="card" onSubmit={editando ? renombrar : crear}>
            <h2>{editando ? `Renombrar "${editando.name}"` : "Nuevo seguro"}</h2>
            <div className="field">
              <Label htmlFor="seguro-nombre">Nombre</Label>
              <Input
                id="seguro-nombre"
                placeholder="Ej. OSDE, Swiss Medical, GNP"
                value={editando ? nombreEditado : nuevo}
                onChange={(e) =>
                  editando ? setNombreEditado(e.target.value) : setNuevo(e.target.value)
                }
              />
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Guardando…" : editando ? "Guardar nombre" : "Agregar"}
              </Button>
              {editando && (
                <Button type="button" variant="outline" onClick={() => setEditando(null)}>
                  Cancelar
                </Button>
              )}
            </div>
          </form>
        </PageContainer>
      )}

      {loading ? (
        <PageSkeleton />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : insurers.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="Todavía no hay seguros"
          description="Carga el primero con el formulario de arriba. Después cada clínica elige cuáles toma."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nombre</TableHead>
              <TableHead>Clínicas</TableHead>
              <TableHead>Vigente</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {insurers.map((i) => (
              <TableRow key={i.id}>
                <TableCell>{i.name}</TableCell>
                <TableCell>
                  {i.clinicas > 0 ? <Badge variant="outline">{i.clinicas}</Badge> : "—"}
                </TableCell>
                <TableCell>
                  <Switch
                    checked={i.active}
                    disabled={!canEdit}
                    onCheckedChange={(active) => cambiarActivo(i, active)}
                  />
                </TableCell>
                <TableCell>
                  {canEdit && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEditando(i);
                        setNombreEditado(i.name);
                      }}
                    >
                      Renombrar
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <AlertDialog
        open={bloqueado !== null}
        onOpenChange={(abierto) => !abierto && setBloqueado(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>No se puede desactivar "{bloqueado?.name}"</AlertDialogTitle>
            <AlertDialogDescription>
              {bloqueado?.clinicasActivas} clínica(s) lo tienen activo. Si se desactiva, el asistente deja
              de decir que trabajan con él de un momento a otro, sin que ellas hayan cambiado nada
              ni se enteren. Cada clínica tiene que darlo de baja primero desde su pantalla
              "Seguros".
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setBloqueado(null)}>Entendido</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
