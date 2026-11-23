import { useEffect, useState, type FormEvent } from "react";
import { Globe } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "../auth/AuthContext";
import { api, ApiError } from "../api/client";
import { PageContainer } from "../components/shell/PageContainer";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { PageSkeleton } from "../components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
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

interface CountryRow {
  id: string;
  name: string;
  currency: string;
  timezones: string[];
  active: boolean;
  reglas: number;
}

type HolidayRuleKind = "fixed" | "nthWeekday" | "easter";

interface HolidayRule {
  id: string;
  countryId: string;
  name: string;
  kind: HolidayRuleKind;
  month: number | null;
  day: number | null;
  weekday: number | null;
  ordinal: number | null;
  offsetDays: number | null;
}

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const DIAS_SEMANA = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const ORDINALES = ["", "1er", "2do", "3er", "4to", "5to"];
/** -1 es "el último del mes": según el año cae cuarto o quinto. */
const ULTIMO = -1;

function describeOrdinal(ordinal: number): string {
  return ordinal === ULTIMO ? "último" : ORDINALES[ordinal] ?? "";
}

/** "a, b,c" → ["a", "b", "c"] — mismo formato para mostrar y para editar. */
function parseTimezonesInput(text: string): string[] {
  return text
    .split(",")
    .map((tz) => tz.trim())
    .filter(Boolean);
}

function describeRule(rule: HolidayRule): string {
  if (rule.kind === "fixed") return `${rule.day} de ${MESES[(rule.month ?? 1) - 1]}`;
  if (rule.kind === "nthWeekday") {
    return `${describeOrdinal(rule.ordinal ?? 1)} ${DIAS_SEMANA[rule.weekday ?? 0]} de ${MESES[(rule.month ?? 1) - 1]}`;
  }
  const offset = rule.offsetDays ?? 0;
  if (offset === 0) return "Domingo de Pascua";
  return offset < 0 ? `${-offset} días antes de Pascua` : `${offset} días después de Pascua`;
}

export function CountriesPage() {
  const { user, hasPermission } = useAuth();
  const canEdit = hasPermission("paises.editar");

  const [countries, setCountries] = useState<CountryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  const [newCurrency, setNewCurrency] = useState("");
  const [newTimezones, setNewTimezones] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [rulesCountry, setRulesCountry] = useState<CountryRow | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setCountries(await api.get<CountryRow[]>("/platform/countries"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo cargar la lista de países");
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

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setCreating(true);
    try {
      await api.post("/platform/countries", {
        id: newId,
        name: newName,
        currency: newCurrency,
        timezones: parseTimezonesInput(newTimezones),
      });
      toast.success(`País "${newName}" creado.`);
      setNewId("");
      setNewName("");
      setNewCurrency("");
      setNewTimezones("");
      await load();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "No se pudo crear el país";
      setCreateError(message);
      toast.error(message);
    } finally {
      setCreating(false);
    }
  }

  async function handleToggleActive(country: CountryRow, active: boolean) {
    try {
      await api.put(`/platform/countries/${country.id}`, { active });
      toast.success(`País "${country.name}" ${active ? "activado" : "desactivado"}.`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo actualizar el país");
    }
  }

  async function handleSaveCurrency(country: CountryRow, currency: string) {
    try {
      await api.put(`/platform/countries/${country.id}`, { currency });
      toast.success(`Moneda de "${country.name}" actualizada.`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo actualizar la moneda");
    }
  }

  async function handleSaveTimezones(country: CountryRow, timezonesText: string) {
    try {
      await api.put(`/platform/countries/${country.id}`, { timezones: parseTimezonesInput(timezonesText) });
      toast.success(`Zonas horarias de "${country.name}" actualizadas.`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudieron actualizar las zonas horarias");
    }
  }

  return (
    <div>
      <h1>Países</h1>
      <p className="muted">
        Catálogo de países y sus reglas de feriados nacionales, compartido por todas las clínicas.
        Un país desactivado deja de ofrecerse como opción nueva, pero no afecta a las clínicas que ya lo tengan
        configurado.
      </p>

      {canEdit && (
        <PageContainer size="form" style={{ margin: "16px 0 24px", padding: 0 }}>
          <form className="card" onSubmit={handleCreate}>
            <h2>Nuevo país</h2>
            <div className="field">
              <Label htmlFor="country-id">Código ISO (2 letras)</Label>
              <Input
                id="country-id"
                required
                maxLength={2}
                placeholder="ej. VE"
                value={newId}
                onChange={(e) => setNewId(e.target.value.toUpperCase())}
              />
            </div>
            <div className="field">
              <Label htmlFor="country-name">Nombre</Label>
              <Input id="country-name" required value={newName} onChange={(e) => setNewName(e.target.value)} />
            </div>
            <div className="field">
              <Label htmlFor="country-currency">Moneda (ISO 4217, ej. "ARS")</Label>
              <Input
                id="country-currency"
                required
                maxLength={3}
                placeholder="ej. VES"
                value={newCurrency}
                onChange={(e) => setNewCurrency(e.target.value.toUpperCase())}
              />
            </div>
            <div className="field">
              <Label htmlFor="country-timezones">Zonas horarias (separadas por coma)</Label>
              <Input
                id="country-timezones"
                placeholder="ej. America/Caracas"
                value={newTimezones}
                onChange={(e) => setNewTimezones(e.target.value)}
              />
            </div>
            {createError && <p className="error-text">{createError}</p>}
            <Button type="submit" disabled={creating} style={{ marginTop: 12 }}>
              {creating ? "Creando…" : "Crear país"}
            </Button>
          </form>
        </PageContainer>
      )}

      {loading ? (
        <PageSkeleton />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : countries.length === 0 ? (
        <EmptyState
          icon={Globe}
          title="Todavía no hay países cargados"
          description="Crea el primero con el formulario de arriba para poder sugerir sus feriados a una clínica."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Código</TableHead>
              <TableHead>Nombre</TableHead>
              <TableHead>Moneda</TableHead>
              <TableHead>Zonas horarias</TableHead>
              <TableHead>Feriados</TableHead>
              <TableHead>Activo</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {countries.map((country) => (
              <TableRow key={country.id}>
                <TableCell>{country.id}</TableCell>
                <TableCell>{country.name}</TableCell>
                <TableCell>
                  <CurrencyCell
                    country={country}
                    canEdit={canEdit}
                    onSave={(currency) => handleSaveCurrency(country, currency)}
                  />
                </TableCell>
                <TableCell>
                  <TimezonesCell
                    country={country}
                    canEdit={canEdit}
                    onSave={(timezones) => handleSaveTimezones(country, timezones)}
                  />
                </TableCell>
                <TableCell>{country.reglas}</TableCell>
                <TableCell>
                  <Switch
                    checked={country.active}
                    disabled={!canEdit}
                    onCheckedChange={(checked) => handleToggleActive(country, checked)}
                  />
                </TableCell>
                <TableCell>
                  <Button variant="outline" size="sm" onClick={() => setRulesCountry(country)}>
                    Ver feriados
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {rulesCountry && (
        <HolidayRulesDialog country={rulesCountry} canEdit={canEdit} onClose={() => setRulesCountry(null)} />
      )}
    </div>
  );
}

function HolidayRulesDialog({
  country,
  canEdit,
  onClose,
}: {
  country: CountryRow;
  canEdit: boolean;
  onClose: () => void;
}) {
  const [rules, setRules] = useState<HolidayRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<HolidayRuleKind>("fixed");
  const [month, setMonth] = useState("1");
  const [day, setDay] = useState("1");
  const [weekday, setWeekday] = useState("1");
  const [ordinal, setOrdinal] = useState("1");
  const [offsetDays, setOffsetDays] = useState("0");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setRules(await api.get<HolidayRule[]>(`/platform/countries/${country.id}/holiday-rules`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudieron cargar las reglas");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country.id]);

  function resetForm() {
    setEditingId(null);
    setName("");
    setKind("fixed");
    setMonth("1");
    setDay("1");
    setWeekday("1");
    setOrdinal("1");
    setOffsetDays("0");
    setFormError(null);
  }

  function startEdit(rule: HolidayRule) {
    setEditingId(rule.id);
    setName(rule.name);
    setKind(rule.kind);
    setMonth(String(rule.month ?? 1));
    setDay(String(rule.day ?? 1));
    setWeekday(String(rule.weekday ?? 1));
    setOrdinal(String(rule.ordinal ?? 1));
    setOffsetDays(String(rule.offsetDays ?? 0));
    setFormError(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    const payload =
      kind === "fixed"
        ? { name, kind, month: Number(month), day: Number(day) }
        : kind === "nthWeekday"
          ? { name, kind, month: Number(month), weekday: Number(weekday), ordinal: Number(ordinal) }
          : { name, kind, offsetDays: Number(offsetDays) };
    try {
      if (editingId) {
        await api.put(`/platform/countries/${country.id}/holiday-rules/${editingId}`, payload);
        toast.success(`Feriado "${name}" actualizado.`);
      } else {
        await api.post(`/platform/countries/${country.id}/holiday-rules`, payload);
        toast.success(`Feriado "${name}" creado.`);
      }
      resetForm();
      await load();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "No se pudo guardar el feriado";
      setFormError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(rule: HolidayRule) {
    try {
      await api.delete(`/platform/countries/${country.id}/holiday-rules/${rule.id}`);
      toast.success(`Feriado "${rule.name}" borrado.`);
      if (editingId === rule.id) resetForm();
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo borrar el feriado");
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent style={{ maxWidth: 640 }}>
        <DialogHeader>
          <DialogTitle>Feriados de {country.name}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <PageSkeleton />
        ) : error ? (
          <ErrorState message={error} onRetry={load} />
        ) : rules.length === 0 ? (
          <p className="muted">Este país todavía no tiene reglas de feriados cargadas.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre</TableHead>
                <TableHead>Regla</TableHead>
                {canEdit && <TableHead></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((rule) => (
                <TableRow key={rule.id}>
                  <TableCell>{rule.name}</TableCell>
                  <TableCell className="muted">{describeRule(rule)}</TableCell>
                  {canEdit && (
                    <TableCell style={{ display: "flex", gap: 8 }}>
                      <Button variant="outline" size="sm" onClick={() => startEdit(rule)}>
                        Editar
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="outline" size="sm">
                            Borrar
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>¿Borrar el feriado "{rule.name}"?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Deja de sugerirse a las clínicas de {country.name}. No se puede deshacer.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancelar</AlertDialogCancel>
                            <AlertDialogAction onClick={() => handleDelete(rule)}>Borrar</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {canEdit && (
          <form className="card" onSubmit={handleSubmit} style={{ marginTop: 16 }}>
            <h4 style={{ margin: "0 0 8px" }}>{editingId ? "Editar feriado" : "Nuevo feriado"}</h4>
            <div className="field">
              <Label htmlFor="rule-name">Nombre</Label>
              <Input id="rule-name" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <Label>Tipo de regla</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as HolidayRuleKind)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fixed">Fecha fija</SelectItem>
                  <SelectItem value="nthWeekday">Enésimo día de la semana del mes</SelectItem>
                  <SelectItem value="easter">Relativa a la Pascua</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {kind === "fixed" && (
              <div style={{ display: "flex", gap: 12 }}>
                <div className="field" style={{ flex: 1 }}>
                  <Label htmlFor="rule-day">Día</Label>
                  <Input id="rule-day" type="number" min={1} max={31} value={day} onChange={(e) => setDay(e.target.value)} />
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <Label htmlFor="rule-month">Mes</Label>
                  <Select value={month} onValueChange={setMonth}>
                    <SelectTrigger id="rule-month">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MESES.map((mes, i) => (
                        <SelectItem key={mes} value={String(i + 1)}>
                          {mes}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {kind === "nthWeekday" && (
              <div style={{ display: "flex", gap: 12 }}>
                <div className="field" style={{ flex: 1 }}>
                  <Label htmlFor="rule-ordinal">Ordinal</Label>
                  <Select value={ordinal} onValueChange={(v) => v && setOrdinal(v)}>
                    <SelectTrigger id="rule-ordinal">
                      {/* El texto va como hijo explícito: sin eso Radix no
                          muestra un valor seteado por código —al editar una
                          regla— hasta que el usuario abre el desplegable. */}
                      <SelectValue>{describeOrdinal(Number(ordinal))}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {[1, 2, 3, 4, 5, ULTIMO].map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {describeOrdinal(n)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <Label htmlFor="rule-weekday">Día de la semana</Label>
                  <Select value={weekday} onValueChange={setWeekday}>
                    <SelectTrigger id="rule-weekday">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DIAS_SEMANA.map((dia, i) => (
                        <SelectItem key={dia} value={String(i)}>
                          {dia}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <Label htmlFor="rule-month-nth">Mes</Label>
                  <Select value={month} onValueChange={setMonth}>
                    <SelectTrigger id="rule-month-nth">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MESES.map((mes, i) => (
                        <SelectItem key={mes} value={String(i + 1)}>
                          {mes}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {kind === "easter" && (
              <div className="field">
                <Label htmlFor="rule-offset">Días respecto al Domingo de Pascua (negativo = antes)</Label>
                <Input
                  id="rule-offset"
                  type="number"
                  value={offsetDays}
                  onChange={(e) => setOffsetDays(e.target.value)}
                />
              </div>
            )}

            {formError && <p className="error-text">{formError}</p>}
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Guardando…" : editingId ? "Guardar cambios" : "Agregar feriado"}
              </Button>
              {editingId && (
                <Button type="button" variant="outline" onClick={resetForm}>
                  Cancelar edición
                </Button>
              )}
            </div>
          </form>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cerrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CurrencyCell({
  country,
  canEdit,
  onSave,
}: {
  country: CountryRow;
  canEdit: boolean;
  onSave: (currency: string) => void;
}) {
  const [value, setValue] = useState(country.currency);

  if (!canEdit) return <span className="muted">{country.currency}</span>;

  return (
    <div style={{ display: "flex", gap: 6 }}>
      <Input
        style={{ width: 70 }}
        maxLength={3}
        value={value}
        onChange={(e) => setValue(e.target.value.toUpperCase())}
      />
      <Button variant="outline" size="sm" disabled={value === country.currency} onClick={() => onSave(value)}>
        Guardar
      </Button>
    </div>
  );
}

function TimezonesCell({
  country,
  canEdit,
  onSave,
}: {
  country: CountryRow;
  canEdit: boolean;
  onSave: (timezonesText: string) => void;
}) {
  const initial = country.timezones.join(", ");
  const [value, setValue] = useState(initial);

  if (!canEdit) return <span className="muted">{initial || "—"}</span>;

  return (
    <div style={{ display: "flex", gap: 6 }}>
      <Input style={{ width: 420 }} value={value} onChange={(e) => setValue(e.target.value)} />
      <Button variant="outline" size="sm" disabled={value === initial} onClick={() => onSave(value)}>
        Guardar
      </Button>
    </div>
  );
}
