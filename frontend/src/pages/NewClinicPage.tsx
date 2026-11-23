import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "../auth/AuthContext";
import { api, ApiError } from "../api/client";
import { PageContainer } from "../components/shell/PageContainer";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { ErrorState } from "../components/ui/error-state";
import { PageSkeleton } from "../components/ui/skeleton";
import { describirTramos } from "../lib/weekdays";
import { WeeklyHoursEditor, type TramoInput } from "../components/working-hours/WeeklyHoursEditor";

interface CountryOption {
  id: string;
  name: string;
  active: boolean;
  timezones: string[];
}

interface GoogleBusinessSuggestion {
  name: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  hours: Array<{ weekday: string; startMinute: number; endMinute: number }>;
  countryCode: string | null;
  timezone: string | null;
}

/** Un tramo tal como lo sugiere Google (`services/google-hours.ts`). */
interface TramoSugerido {
  weekday: string;
  startMinute: number;
  endMinute: number;
}

const emptyForm = {
  name: "",
  email: "",
  googleBusinessUrl: "",
  contactPhone: "",
  website: "",
  address: "",
  whatsappPhoneNumberId: "",
  whatsappWabaId: "",
  whatsappToken: "",
  timezone: "",
  country: "",
  services: "",
  // En minutos; 60 es el default de la plataforma. 0 = sin mínimo.
  minLeadMinutes: "60",
  adminEmail: "",
  adminName: "",
};

/**
 * El alta de una clínica nueva, en su propia pantalla (el listado de "Clínicas" quedaba larguísimo con el formulario
 * adentro). Al crearla lleva al detalle, que es donde se completa lo que falta (membresía, redes, facturación).
 */
export function NewClinicPage() {
  const { user, hasPermission } = useAuth();
  const navigate = useNavigate();
  const canCreate = hasPermission("clinicas.crear");

  const [countries, setCountries] = useState<CountryOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [fetchingGoogle, setFetchingGoogle] = useState(false);
  /*
   * El horario de atención con el que nace la clínica. **Es obligatorio**: sin
   * ningún tramo la clínica no puede agendar. No está en `form` porque se arma
   * con el editor de tramos, y se prellena con lo que sugiere Google. Solo
   * cuenta lo que se confirmó con "Usar este horario": el editor tiene su
   * propio estado interno, y sin confirmarlo no viaja nada.
   */
  const [horario, setHorario] = useState<TramoSugerido[]>([]);
  /** Fuerza al editor a releer su punto de partida cuando Google trae un horario nuevo. */
  const [horarioKey, setHorarioKey] = useState(0);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const countriesData = await api.get<CountryOption[]>("/platform/countries");
      setCountries(countriesData.filter((c) => c.active));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudieron cargar los países");
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

  async function handleFetchGoogle() {
    if (!form.googleBusinessUrl.trim()) {
      toast.error("Pega primero el link de Google de la clínica.");
      return;
    }
    setFetchingGoogle(true);
    try {
      const suggestion = await api.post<GoogleBusinessSuggestion>("/platform/google-business/preview", {
        url: form.googleBusinessUrl.trim(),
      });
      // El país solo se completa si Google detectó uno que ya tenemos
      // cargado en "Países" — si no, el selector se queda como estaba
      // (un país que no existe en la lista rompería el selector y el alta).
      const matchedCountry = countries.find((c) => c.id === suggestion.countryCode);
      setForm((f) => ({
        ...f,
        name: suggestion.name ?? f.name,
        address: suggestion.address ?? f.address,
        contactPhone: suggestion.phone ?? f.contactPhone,
        website: suggestion.website ?? f.website,
        ...(matchedCountry
          ? { country: matchedCountry.id, timezone: suggestion.timezone ?? f.timezone }
          : {}),
      }));
      setHorario(suggestion.hours ?? []);
      setHorarioKey((k) => k + 1);
      toast.success("Datos de Google cargados en el formulario — revisa antes de crear la clínica.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudieron traer los datos de Google");
    } finally {
      setFetchingGoogle(false);
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    // Se frena acá con un mensaje que nombra el campo, en vez de dejar que el
    // servidor lo rechace después de haber llenado todo el formulario.
    if (horario.length === 0) {
      setFormError(
        "Falta el horario de atención: cárgalo y confirma con \"Usar este horario\". Sin horario la clínica no puede agendar."
      );
      return;
    }
    const lead = Number(form.minLeadMinutes);
    if (form.minLeadMinutes.trim() === "" || !Number.isInteger(lead) || lead < 0 || lead > 10080) {
      setFormError("La anticipación mínima tiene que ser un número entero de minutos, entre 0 y 10080.");
      return;
    }
    setSubmitting(true);
    try {
      const creada = await api.post<{ clinic: { id: string } }>("/platform/clinics", {
        name: form.name,
        email: form.email,
        googleBusinessUrl: form.googleBusinessUrl || undefined,
        contactPhone: form.contactPhone || undefined,
        website: form.website || undefined,
        address: form.address || undefined,
        whatsappPhoneNumberId: form.whatsappPhoneNumberId,
        whatsappWabaId: form.whatsappWabaId || undefined,
        whatsappToken: form.whatsappToken,
        timezone: form.timezone,
        country: form.country || undefined,
        // Obligatorio: la clínica nace con su horario cargado, porque sin él no
        // puede agendar.
        workingHours: horario,
        services: form.services,
        minLeadMinutes: lead,
        adminEmail: form.adminEmail || undefined,
        adminName: form.adminName || undefined,
      });
      toast.success(`Clínica "${form.name}" creada.`);
      navigate(`/platform/clinics/${creada.clinic.id}`);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "No se pudo crear la clínica";
      setFormError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  if (!canCreate) {
    return <p className="muted">No tienes permiso para crear clínicas.</p>;
  }
  if (loading) return <PageSkeleton />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <div>
      <Link to="/platform/clinics" className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <ArrowLeft size={14} /> Volver a Clínicas
      </Link>
      <h1>Crear clínica</h1>
      <p className="muted">Completa los datos de la clínica. Al crearla pasas a su detalle para terminar de configurarla.</p>

      <PageContainer size="form" style={{ margin: "16px 0 24px", padding: 0 }}>
        <form className="card" onSubmit={handleCreate}>
            <div className="field">
              <Label htmlFor="clinic-google-url">Link de la clínica en Google (opcional)</Label>
              <p className="muted" style={{ marginTop: 0, marginBottom: 6 }}>
                El link de la ficha en Google Maps (o uno corto tipo share.google/…). "Traer datos" completa nombre,
                dirección, teléfono, sitio web y horario aquí abajo — revisa antes de crear.
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <Input
                  id="clinic-google-url"
                  placeholder="https://share.google/…"
                  value={form.googleBusinessUrl}
                  onChange={(e) => setForm((f) => ({ ...f, googleBusinessUrl: e.target.value }))}
                  style={{ flex: 1 }}
                />
                <Button type="button" variant="outline" disabled={fetchingGoogle} onClick={handleFetchGoogle}>
                  {fetchingGoogle ? "Trayendo…" : "Traer datos de Google"}
                </Button>
              </div>
            </div>
            <div className="field">
              <Label>Horario de atención (obligatorio)</Label>
              <p className="muted" style={{ marginTop: 0, marginBottom: 8 }}>
                Es lo que se valida al agendar y lo que el asistente le cuenta al paciente: sin horario la
                clínica no puede agendar. Si traes los datos de Google se prellena con su horario. El corte
                del mediodía son dos tramos en el mismo día. Confirma con "Usar este horario"; después se
                ajusta en "Horarios".
              </p>
              <WeeklyHoursEditor
                key={horarioKey}
                initialTramos={horario as TramoInput[]}
                saveLabel="Usar este horario"
                onSave={(tramos) => {
                  setHorario(tramos);
                  toast.success(
                    tramos.length > 0 ? "Horario listo para crear la clínica." : "El horario quedó vacío."
                  );
                }}
              />
              {horario.length > 0 ? (
                <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                  {describirTramos(horario).map(({ dia, horario: franja }) => (
                    <li key={dia}>
                      <strong>{dia}:</strong> {franja}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted" style={{ margin: "8px 0 0" }}>
                  Todavía no confirmaste ningún horario.
                </p>
              )}
            </div>
            <div className="field">
              <Label htmlFor="clinic-name">Nombre</Label>
              <Input
                id="clinic-name"
                required
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="field">
              <Label htmlFor="clinic-email">Email</Label>
              <Input
                id="clinic-email"
                type="email"
                required
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              />
            </div>
            <div style={{ display: "flex", gap: 12 }}>
              <div className="field" style={{ flex: 1 }}>
                <Label htmlFor="clinic-phone">Teléfono de contacto</Label>
                <Input
                  id="clinic-phone"
                  value={form.contactPhone}
                  onChange={(e) => setForm((f) => ({ ...f, contactPhone: e.target.value }))}
                />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <Label htmlFor="clinic-website">Sitio web</Label>
                <Input
                  id="clinic-website"
                  placeholder="https://…"
                  value={form.website}
                  onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))}
                />
              </div>
            </div>
            <div className="field">
              <Label htmlFor="clinic-address">Dirección</Label>
              <Input
                id="clinic-address"
                value={form.address}
                onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
              />
            </div>
            <div style={{ display: "flex", gap: 12 }}>
              <div className="field" style={{ flex: 1 }}>
                <Label htmlFor="clinic-wa-id">WhatsApp phone number ID</Label>
                <Input
                  id="clinic-wa-id"
                  required
                  value={form.whatsappPhoneNumberId}
                  onChange={(e) => setForm((f) => ({ ...f, whatsappPhoneNumberId: e.target.value }))}
                />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <Label htmlFor="clinic-wa-waba">WhatsApp WABA ID</Label>
                <Input
                  id="clinic-wa-waba"
                  value={form.whatsappWabaId}
                  onChange={(e) => setForm((f) => ({ ...f, whatsappWabaId: e.target.value }))}
                />
                <p className="muted" style={{ fontSize: "0.85em", marginTop: 4 }}>
                  Con el WABA cargado, al crear la clínica se dan de alta sus plantillas de
                  WhatsApp automáticamente (quedan pendientes de aprobación de Meta).
                </p>
              </div>
            </div>
            <div style={{ display: "flex", gap: 12 }}>
              <div className="field" style={{ flex: 1 }}>
                <Label htmlFor="clinic-wa-token">WhatsApp token</Label>
                <Input
                  id="clinic-wa-token"
                  required
                  type="password"
                  value={form.whatsappToken}
                  onChange={(e) => setForm((f) => ({ ...f, whatsappToken: e.target.value }))}
                />
                <p className="muted" style={{ fontSize: "0.85em", marginTop: 4 }}>
                  Se guarda cifrado y no se vuelve a mostrar. Para rotarlo, carga el nuevo.
                </p>
              </div>
            </div>
            <div style={{ display: "flex", gap: 12 }}>
              <div className="field" style={{ flex: 1 }}>
                <Label htmlFor="clinic-country">País</Label>
                <Select
                  value={form.country}
                  onValueChange={(v) => {
                    // Radix a veces dispara `onValueChange("")` solo (sin que el
                    // usuario haya elegido nada) cuando el `value` seteado por
                    // código todavía no matchea ningún `SelectItem` montado —
                    // ningún país real tiene id vacío, así que se ignora.
                    if (!v) return;
                    setForm((f) => ({ ...f, country: v, timezone: "" }));
                  }}
                >
                  <SelectTrigger id="clinic-country">
                    {/* Hijo explícito: si no, Radix no muestra un valor precargado por
                        "Traer datos de Google" hasta que el usuario abre este dropdown. */}
                    <SelectValue placeholder="Elegir país…">
                      {countries.find((c) => c.id === form.country)?.name}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {countries.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="field" style={{ flex: 1 }}>
                <Label htmlFor="clinic-timezone">Zona horaria</Label>
                <Select
                  value={form.timezone}
                  onValueChange={(v) => v && setForm((f) => ({ ...f, timezone: v }))}
                >
                  {/* Ninguna zona real tiene valor vacío: si Radix dispara
                      `onValueChange("")` solo (porque el valor seteado por código
                      todavía no matchea ningún item montado), se ignora en vez de
                      pisar la zona que "Traer datos de Google" acaba de completar. */}
                  <SelectTrigger id="clinic-timezone">
                    <SelectValue placeholder={form.country ? "Elegir zona…" : "Elige un país primero"}>
                      {form.timezone || undefined}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {(countries.find((c) => c.id === form.country)?.timezones ?? []).map((tz) => (
                      <SelectItem key={tz} value={tz}>
                        {tz}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="field">
              <Label htmlFor="clinic-services">Servicios (texto para el prompt)</Label>
              <Textarea
                id="clinic-services"
                required
                rows={2}
                value={form.services}
                onChange={(e) => setForm((f) => ({ ...f, services: e.target.value }))}
              />
            </div>
            <div className="field">
              <Label htmlFor="clinic-min-lead">Anticipación mínima para reservar (minutos)</Label>
              <Input
                id="clinic-min-lead"
                type="number"
                min={0}
                max={10080}
                step={1}
                value={form.minLeadMinutes}
                onChange={(e) => setForm((f) => ({ ...f, minLeadMinutes: e.target.value }))}
              />
              <p className="muted" style={{ fontSize: "0.9em", margin: 0 }}>
                Por defecto 60 (una hora). 120 = 2 horas, 1440 = 1 día, 0 = sin mínimo. Se puede cambiar
                después desde el detalle de la clínica.
              </p>
            </div>
            <div style={{ display: "flex", gap: 12 }}>
              <div className="field" style={{ flex: 1 }}>
                <Label htmlFor="clinic-admin-email">Email del primer admin (opcional)</Label>
                <Input
                  id="clinic-admin-email"
                  type="email"
                  value={form.adminEmail}
                  onChange={(e) => setForm((f) => ({ ...f, adminEmail: e.target.value }))}
                />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <Label htmlFor="clinic-admin-name">Nombre del primer admin</Label>
                <Input
                  id="clinic-admin-name"
                  value={form.adminName}
                  onChange={(e) => setForm((f) => ({ ...f, adminName: e.target.value }))}
                />
              </div>
            </div>
            {formError && <p className="error-text">{formError}</p>}
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Creando…" : "Crear clínica"}
              </Button>
              <Link to="/platform/clinics">
                <Button type="button" variant="outline">
                  Cancelar
                </Button>
              </Link>
            </div>
        </form>
      </PageContainer>
    </div>
  );
}
