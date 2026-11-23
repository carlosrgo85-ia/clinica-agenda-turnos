import { useEffect, useState, type FormEvent } from "react";
import { BadgeCheck } from "lucide-react";
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

interface TitleRow {
  id: string;
  name: string;
  active: boolean;
  /** Cuántos profesionales lo tienen puesto, en toda la plataforma. */
  profesionales: number;
  /** En cuántas clínicas está habilitado. */
  clinicas: number;
}

/**
 * El catálogo de títulos de profesional ("Dr.", "Lic.", "Manicurista").
 *
 * Es global de la plataforma: acá se cargan y se dan de baja, y con cuáles
 * trabaja cada clínica se elige en el detalle de esa clínica. Una clínica no
 * carga títulos propios — si cada una lo hiciera, la misma "Dra." existiría
 * escrita de tres formas distintas.
 *
 * **Un título que algún profesional tenga puesto no se puede desactivar.** La
 * ficha que ya lo tiene lo seguiría mostrando, pero el desplegable no lo
 * ofrecería más, así que no habría forma de corregirla desde la interfaz. El
 * camino es cambiarle el título a esos profesionales primero. La pantalla lo
 * frena antes de llamar a la API, y el backend lo rechaza igual.
 */
export function TitlesPage() {
  const { user, hasPermission } = useAuth();
  const canEdit = hasPermission("titulos.editar");

  const [titles, setTitles] = useState<TitleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [nuevo, setNuevo] = useState("");
  const [editando, setEditando] = useState<TitleRow | null>(null);
  const [nombreEditado, setNombreEditado] = useState("");
  const [submitting, setSubmitting] = useState(false);
  /** El título que se intentó desactivar estando en uso. */
  const [bloqueado, setBloqueado] = useState<TitleRow | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setTitles(await api.get<TitleRow[]>("/platform/titles"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo cargar el catálogo de títulos");
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
      toast.error(err instanceof ApiError ? err.message : "No se pudo guardar");
    } finally {
      setSubmitting(false);
    }
  }

  function crear(e: FormEvent) {
    e.preventDefault();
    const name = nuevo.trim();
    if (!name) return;
    guardar(() => api.post("/platform/titles", { name }), `Título "${name}" creado.`).then(() =>
      setNuevo("")
    );
  }

  function renombrar(e: FormEvent) {
    e.preventDefault();
    if (!editando) return;
    const name = nombreEditado.trim();
    if (!name) return;
    // Renombrar está permitido incluso en uso: las fichas apuntan por id, así
    // que el cambio se propaga solo.
    guardar(
      () => api.put(`/platform/titles/${editando.id}`, { name }),
      `Título renombrado a "${name}".`
    ).then(() => setEditando(null));
  }

  function cambiarActivo(title: TitleRow, active: boolean) {
    if (!active && title.profesionales > 0) {
      setBloqueado(title);
      return;
    }
    guardar(
      () => api.put(`/platform/titles/${title.id}`, { active }),
      active ? `"${title.name}" activado.` : `"${title.name}" desactivado.`
    );
  }

  return (
    <div>
      <h1>Títulos</h1>
      <p className="muted">
        Con qué se nombra a un profesional antes del nombre. El catálogo es de la plataforma; con
        cuáles trabaja cada clínica se elige en su detalle, en "Clínicas".
      </p>

      {canEdit && (
        <PageContainer size="form" style={{ margin: "16px 0 24px", padding: 0 }}>
          <form className="card" onSubmit={editando ? renombrar : crear}>
            <h2>{editando ? `Renombrar "${editando.name}"` : "Nuevo título"}</h2>
            <div className="field">
              <Label htmlFor="titulo-nombre">Nombre</Label>
              <Input
                id="titulo-nombre"
                placeholder="Ej. Dra., Lic., Manicurista"
                value={editando ? nombreEditado : nuevo}
                onChange={(e) =>
                  editando ? setNombreEditado(e.target.value) : setNuevo(e.target.value)
                }
              />
            </div>
            {editando && editando.profesionales > 0 && (
              <p className="muted" style={{ fontSize: "0.85em" }}>
                Se renombra en las {editando.profesionales} ficha(s) que lo usan: apuntan al título,
                no a su texto.
              </p>
            )}
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
      ) : titles.length === 0 ? (
        <EmptyState
          icon={BadgeCheck}
          title="Todavía no hay títulos"
          description="Carga el primero con el formulario de arriba. Después se habilitan por clínica."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nombre</TableHead>
              <TableHead>Profesionales</TableHead>
              <TableHead>Clínicas habilitadas</TableHead>
              <TableHead>Activo</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {titles.map((t) => (
              <TableRow key={t.id}>
                <TableCell>{t.name}</TableCell>
                <TableCell>
                  {t.profesionales > 0 ? <Badge variant="outline">{t.profesionales}</Badge> : "—"}
                </TableCell>
                <TableCell className="muted">{t.clinicas}</TableCell>
                <TableCell>
                  <Switch
                    checked={t.active}
                    disabled={!canEdit}
                    onCheckedChange={(active) => cambiarActivo(t, active)}
                  />
                </TableCell>
                <TableCell>
                  {canEdit && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEditando(t);
                        setNombreEditado(t.name);
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

      <AlertDialog open={bloqueado !== null} onOpenChange={(abierto) => !abierto && setBloqueado(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>No se puede desactivar "{bloqueado?.name}"</AlertDialogTitle>
            <AlertDialogDescription>
              {bloqueado?.profesionales} profesional(es) lo tienen puesto. Un título inactivo no se
              ofrece en ningún desplegable, así que esas fichas quedarían mostrando algo que no se
              puede volver a elegir. Cámbiales el título primero y después desactívalo.
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
