import { useEffect, useState, type FormEvent } from "react";
import { CreditCard } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "../auth/AuthContext";
import { api, ApiError } from "../api/client";
import { PageContainer } from "../components/shell/PageContainer";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Checkbox } from "../components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { StatusBadge } from "../components/ui/status-badge";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { PageSkeleton } from "../components/ui/skeleton";
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
} from "../components/ui/alert-dialog";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";

interface PlanFeatureDef {
  id: string;
  description: string;
}

interface PlanRow {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  features: string[];
  clinicas: number;
  /** Celdas de la grilla de precios con valor, sobre los países activos. */
  precios: { cargados: number; paisesActivos: number };
}

/** Una fila de `GET /platform/plans/:id/prices`: un país, sus dos periodicidades. */
interface PriceRow {
  countryId: string;
  countryName: string;
  currency: string;
  countryActive: boolean;
  clinicas: number;
  mensual: { amount: string; updatedAt: string } | null;
  anual: { amount: string; updatedAt: string } | null;
}

export function PlansPage() {
  const { user, hasPermission } = useAuth();
  const canEdit = hasPermission("planes.editar");

  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [catalog, setCatalog] = useState<PlanFeatureDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedFeatures, setSelectedFeatures] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [preciosDe, setPreciosDe] = useState<PlanRow | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [plansData, catalogData] = await Promise.all([
        api.get<PlanRow[]>("/platform/plans"),
        api.get<PlanFeatureDef[]>("/platform/plan-features"),
      ]);
      setPlans(plansData);
      setCatalog(catalogData);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo cargar la lista de planes");
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

  function resetForm() {
    setEditingId(null);
    setName("");
    setDescription("");
    setSelectedFeatures([]);
    setFormError(null);
  }

  function startEdit(plan: PlanRow) {
    setEditingId(plan.id);
    setName(plan.name);
    setDescription(plan.description ?? "");
    setSelectedFeatures(plan.features);
    setFormError(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      if (editingId) {
        await api.put(`/platform/plans/${editingId}`, {
          name,
          description: description || null,
          features: selectedFeatures,
        });
        toast.success(`Plan "${name}" actualizado.`);
      } else {
        await api.post("/platform/plans", { name, description: description || undefined, features: selectedFeatures });
        toast.success(`Plan "${name}" creado.`);
      }
      resetForm();
      await load();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "No se pudo guardar el plan";
      setFormError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(plan: PlanRow) {
    try {
      await api.delete(`/platform/plans/${plan.id}`);
      toast.success(`Plan "${plan.name}" borrado.`);
      if (editingId === plan.id) resetForm();
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo borrar el plan");
    }
  }

  return (
    <div>
      <h1>Planes</h1>
      <p className="muted">
        Qué funcionalidades tiene cada plan y cuánto sale en cada país. Una clínica se asigna a un plan
        —y se le fija el precio— desde su detalle en "Clínicas".
      </p>

      {canEdit && (
        <PageContainer size="form" style={{ margin: "16px 0 24px", padding: 0 }}>
          <form className="card" onSubmit={handleSubmit}>
            <h2>{editingId ? "Editar plan" : "Nuevo plan"}</h2>
            <div className="field">
              <Label htmlFor="plan-name">Nombre</Label>
              <Input id="plan-name" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <Label htmlFor="plan-description">Descripción</Label>
              <Input
                id="plan-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="field">
              <Label>Funcionalidades incluidas</Label>
              {catalog.map((feature) => (
                <div className="checkbox-field" key={feature.id}>
                  <Checkbox
                    id={`feature-${feature.id}`}
                    checked={selectedFeatures.includes(feature.id)}
                    onCheckedChange={(checked) =>
                      setSelectedFeatures((prev) =>
                        checked ? [...prev, feature.id] : prev.filter((id) => id !== feature.id)
                      )
                    }
                  />
                  <Label htmlFor={`feature-${feature.id}`}>{feature.description}</Label>
                </div>
              ))}
            </div>
            {formError && <p className="error-text">{formError}</p>}
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Guardando…" : editingId ? "Guardar cambios" : "Crear plan"}
              </Button>
              {editingId && (
                <Button type="button" variant="outline" onClick={resetForm}>
                  Cancelar edición
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
      ) : plans.length === 0 ? (
        <EmptyState
          icon={CreditCard}
          title="Todavía no hay planes"
          description="Crea el primero con el formulario de arriba."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nombre</TableHead>
              <TableHead>Funcionalidades</TableHead>
              <TableHead>Precios cargados</TableHead>
              <TableHead>Clínicas</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {plans.map((plan) => (
              <TableRow key={plan.id}>
                <TableCell style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {plan.name}
                  {plan.isSystem && <StatusBadge status="system" />}
                </TableCell>
                <TableCell className="muted">{plan.features.length}</TableCell>
                <TableCell className="muted">
                  {/* Un plan sin ningún precio cargado no se puede asignar como
                      "precio de lista" a ninguna clínica, así que el número va
                      en la tabla y no escondido adentro del diálogo. */}
                  {plan.precios.cargados} de {plan.precios.paisesActivos} país(es)
                </TableCell>
                <TableCell className="muted">{plan.clinicas}</TableCell>
                <TableCell style={{ display: "flex", gap: 8 }}>
                  <Button variant="outline" size="sm" onClick={() => setPreciosDe(plan)}>
                    Precios
                  </Button>
                  {canEdit && (
                    <>
                      <Button variant="outline" size="sm" onClick={() => startEdit(plan)}>
                        Editar
                      </Button>
                      {!plan.isSystem && (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="outline" size="sm">
                              Borrar
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>¿Borrar el plan "{plan.name}"?</AlertDialogTitle>
                              <AlertDialogDescription>
                                {plan.clinicas > 0
                                  ? `No se puede: ${plan.clinicas} clínica(s) lo están usando.`
                                  : "No se puede deshacer."}
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancelar</AlertDialogCancel>
                              <AlertDialogAction disabled={plan.clinicas > 0} onClick={() => handleDelete(plan)}>
                                Borrar
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {preciosDe && (
        <PlanPricesDialog
          plan={preciosDe}
          canEdit={canEdit}
          onClose={() => setPreciosDe(null)}
          // Cambiar un precio cambia el "precios cargados" de la tabla de
          // atrás, así que se recarga al cerrar.
          onChanged={load}
        />
      )}
    </div>
  );
}

/**
 * Los precios de lista de un plan: un país por fila, una columna por
 * periodicidad.
 *
 * Lo que la pantalla tiene que dejar clarísimo es que **esto no le cambia el
 * precio a ninguna clínica que ya esté**: cada una tiene el suyo copiado desde
 * el día que se lo fijaron. Sin decirlo, un aumento acá se siente como un
 * aumento a todos los clientes, que es exactamente lo que el diseño evita.
 *
 * Se guarda por fila y no celda por celda: los dos precios de un país se
 * revisan juntos (si sube el mensual, el anual con descuento se recalcula), y
 * un botón por celda serían cuarenta botones.
 */
function PlanPricesDialog(props: {
  plan: PlanRow;
  canEdit: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [filas, setFilas] = useState<PriceRow[]>([]);
  const [edits, setEdits] = useState<Record<string, { mensual: string; anual: string }>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<{ filas: PriceRow[] }>(`/platform/plans/${props.plan.id}/prices`);
      setFilas(data.filas);
      setEdits(
        Object.fromEntries(
          data.filas.map((f) => [
            f.countryId,
            { mensual: f.mensual?.amount ?? "", anual: f.anual?.amount ?? "" },
          ])
        )
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudieron cargar los precios");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.plan.id]);

  /**
   * Guarda los dos precios de un país.
   *
   * Vaciar una celda **borra** ese precio, no lo guarda en cero: cero no es un
   * precio (lo rechaza el backend y un CHECK), y "no hay precio para esta
   * periodicidad" es un estado válido — hay planes que solo se venden por mes.
   */
  async function guardarFila(fila: PriceRow) {
    const edit = edits[fila.countryId];
    if (!edit) return;
    setGuardando(fila.countryId);
    try {
      const periodos = [
        { periodo: "mensual" as const, actual: fila.mensual?.amount ?? "", nuevo: edit.mensual.trim() },
        { periodo: "anual" as const, actual: fila.anual?.amount ?? "", nuevo: edit.anual.trim() },
      ];
      let toco = false;
      for (const { periodo, actual, nuevo } of periodos) {
        const url = `/platform/plans/${props.plan.id}/prices/${fila.countryId}/${periodo}`;
        if (nuevo === actual || (nuevo === "" && actual === "")) continue;
        toco = true;
        if (nuevo === "") {
          const result = await api.delete<{ clinicasSinReferencia: number }>(url);
          toast.success(
            result.clinicasSinReferencia > 0
              ? `Precio ${periodo} de ${fila.countryName} borrado. ${result.clinicasSinReferencia} clínica(s) siguen pagando el suyo, ahora sin referencia con la que compararlo.`
              : `Precio ${periodo} de ${fila.countryName} borrado.`
          );
        } else {
          await api.put(url, { amount: nuevo });
          toast.success(
            `Precio ${periodo} de ${fila.countryName}: ${fila.currency} ${nuevo}. Las clínicas que ya estaban siguen con el suyo.`
          );
        }
      }
      if (!toco) {
        toast.success("No había cambios en esa fila.");
        return;
      }
      await load();
      props.onChanged();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "No se pudo guardar el precio";
      toast.error(message);
      // Se recarga para volver a mostrar lo que realmente quedó: si el
      // backend rechazó una de las dos celdas, la otra pudo haberse guardado.
      await load();
    } finally {
      setGuardando(null);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent style={{ maxWidth: 720 }}>
        <DialogHeader>
          <DialogTitle>Precios de {props.plan.name}</DialogTitle>
          <DialogDescription>
            Es el precio de lista: lo que se le va a ofrecer a una clínica nueva de ese país. Cambiarlo
            <strong> no le cambia el precio a ninguna clínica que ya esté</strong> — cada una tiene el suyo
            copiado desde el día que se lo fijaron.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <PageSkeleton />
        ) : error ? (
          <ErrorState message={error} onRetry={load} />
        ) : filas.length === 0 ? (
          <p className="muted">
            No hay países activos. Carga uno en "Países" para poder ponerle precio a este plan.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>País</TableHead>
                <TableHead>Mensual</TableHead>
                <TableHead>Anual</TableHead>
                <TableHead>Clínicas</TableHead>
                {props.canEdit && <TableHead></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filas.map((fila) => (
                <TableRow key={fila.countryId}>
                  <TableCell>
                    {fila.countryName} <span className="muted">({fila.currency})</span>
                    {/* Un país desactivado se lista solo si ya tenía precio: si no,
                        el precio desaparecería de la pantalla sin explicación. */}
                    {!fila.countryActive && <div className="muted" style={{ fontSize: "0.85em" }}>País desactivado</div>}
                  </TableCell>
                  {(["mensual", "anual"] as const).map((periodo) => (
                    <TableCell key={periodo}>
                      <Input
                        inputMode="decimal"
                        placeholder="Sin precio"
                        aria-label={`Precio ${periodo} en ${fila.countryName}`}
                        disabled={!props.canEdit || guardando === fila.countryId}
                        value={edits[fila.countryId]?.[periodo] ?? ""}
                        onChange={(e) =>
                          setEdits((prev) => ({
                            ...prev,
                            [fila.countryId]: {
                              ...prev[fila.countryId],
                              [periodo]: e.target.value,
                            } as { mensual: string; anual: string },
                          }))
                        }
                        style={{ maxWidth: 130 }}
                      />
                    </TableCell>
                  ))}
                  <TableCell className="muted">{fila.clinicas}</TableCell>
                  {props.canEdit && (
                    <TableCell>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={guardando === fila.countryId}
                        onClick={() => guardarFila(fila)}
                      >
                        {guardando === fila.countryId ? "Guardando…" : "Guardar"}
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <p className="muted" style={{ fontSize: "0.85em", marginTop: 12 }}>
          Vaciar una celda borra ese precio (cero no es un precio: para no cobrarle a una clínica se usa
          "exonerada" en su membresía). Un plan sin precio en un país no se puede asignar ahí como precio
          de lista, pero sí como precio especial.
        </p>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cerrar</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
