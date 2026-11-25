import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { useAuth } from "../auth/AuthContext";
import { api, ApiError } from "../api/client";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { Checkbox } from "../components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { ErrorState } from "../components/ui/error-state";
import { PageSkeleton } from "../components/ui/skeleton";
import { formatDateTime } from "../lib/format";

interface ClinicDetail {
  id: string;
  name: string;
  email: string;
  active: boolean;
  country: string | null;
  timezone: string;
  contactPhone: string | null;
  website: string | null;
  address: string | null;
  googleBusinessUrl: string | null;
  privacyNoticeUrl?: string | null;
  services: string;
  whatsappPhoneNumberId: string;
  whatsappWabaId: string | null;
  facebookUrl: string | null;
  instagramUrl: string | null;
  tiktokUrl: string | null;
  billingLegalName: string | null;
  billingTaxId: string | null;
  billingAddress: string | null;
  billingPostalCode: string | null;
  billingEmail: string | null;
  urgencyNotifyEmail: string | null;
  urgencyNotifyPhone: string | null;
  minLeadMinutes: number;
  serviceNoun?: string;
  nextVisitOutreachEnabled: boolean;
  campaignFollowUpEnabled: boolean;
  assistantDisclosedInProfile: boolean;
  nextVisitOutreachLeadDays: number;
  plan?: { name: string; features: string[] } | null;
  _count: { users: number; professionals: number; workingHours: number };
}

/**
 * Lo que devuelve `GET /platform/clinics/:id/membership`.
 *
 * El plan viaja acá y no se lee del detalle de la clínica: es parte de la
 * membresía (un plan sin precio no se puede facturar, y un precio sin plan no
 * significa nada), y así la tarjeta se refresca sola después de guardar sin
 * quedar mostrando el plan viejo.
 */
interface MembershipView {
  planId: string | null;
  pricing: "lista" | "especial" | "exonerada" | null;
  amount: string | null;
  currency: string | null;
  billingPeriod: "mensual" | "anual" | null;
  reason: string | null;
  pricedAt: string | null;
  listPrice: { amount: string; currency: string; updatedAt: string } | null;
  listPriceStatus: "ok" | "sin_plan" | "sin_pais" | "sin_periodicidad" | "no_cargado";
  /* Tres miembros y no dos: con `{ estado: "sin_referencia" | "igual" }` junto,
     TypeScript narra la propiedad pero no descarta el miembro, así que
     `diffAmount` no existe ni después de excluir los dos estados sin diff. */
  comparacion:
    | { estado: "sin_referencia" }
    | { estado: "igual" }
    | { estado: "por_debajo" | "por_encima"; diffAmount: string; diffPercent: number };
  /** El precio de lista se tocó después de fijarle el suyo a esta clínica. */
  listaCambiadaDespues: boolean;
  currencyMismatch: { membresia: string; pais: string } | null;
  historial: Array<{
    id: string;
    changedAt: string;
    fromPricing: string | null;
    toPricing: string | null;
    fromAmount: string | null;
    toAmount: string | null;
    currency: string | null;
    reason: string | null;
    changedBy: string | null;
  }>;
}

/** Una fila de la grilla de precios de lista de un plan. */
interface PlanPriceRow {
  countryId: string;
  currency: string;
  mensual: { amount: string } | null;
  anual: { amount: string } | null;
}

interface PlanOption {
  id: string;
  name: string;
}

/** Lo que devuelve `GET /platform/clinics/:id/whatsapp/templates`. */
interface TemplateStatus {
  name: string;
  descripcion: string;
  /** `APPROVED`, `PENDING`, `REJECTED`, o `NO_CREADA` si no está en el WABA. */
  status: string;
}

interface CountryOption {
  id: string;
  name: string;
  currency: string;
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

const NONE = "__none__";

export function ClinicDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, hasPermission, setViewingClinic } = useAuth();
  const canEdit = hasPermission("clinicas.editar");

  const [clinic, setClinic] = useState<ClinicDetail | null>(null);
  const [plans, setPlans] = useState<PlanOption[]>([]);
  const [countries, setCountries] = useState<CountryOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fetchingGoogle, setFetchingGoogle] = useState(false);

  /**
   * WhatsApp vive en un estado aparte del resto del formulario aunque se
   * guarde con el mismo botón: el token es una credencial que no se puede
   * mostrar (se guarda cifrada y no vuelve por la API), así que su campo
   * arranca siempre vacío y "vacío" significa "no lo cambies" — no es un
   * valor precargado que se edita, como todos los demás.
   */
  const [waForm, setWaForm] = useState({ whatsappWabaId: "", whatsappToken: "" });
  const [templates, setTemplates] = useState<TemplateStatus[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [templatesBusy, setTemplatesBusy] = useState(false);

  const [form, setForm] = useState({
    name: "",
    email: "",
    timezone: "",
    country: NONE,
    active: true,
    contactPhone: "",
    website: "",
    address: "",
    googleBusinessUrl: "",
    privacyNoticeUrl: "",
    services: "",
    facebookUrl: "",
    instagramUrl: "",
    tiktokUrl: "",
    billingLegalName: "",
    billingTaxId: "",
    billingAddress: "",
    billingPostalCode: "",
    billingEmail: "",
    urgencyNotifyEmail: "",
    urgencyNotifyPhone: "",
    minLeadMinutes: "60",
    serviceNoun: "servicio",
    nextVisitOutreachEnabled: false,
    campaignFollowUpEnabled: false,
    assistantDisclosedInProfile: false,
    nextVisitOutreachLeadDays: "14",
  });

  /** ¿El plan de la clínica incluye esta funcionalidad? (Decide si se puede prender el interruptor.) */
  const enPlan = (feature: string) => clinic?.plan?.features.includes(feature) ?? false;

  /** Tras cambiar la membresía: solo se refresca el plan, sin pisar lo que haya escrito en el formulario. */
  async function refreshPlan() {
    if (!id) return;
    try {
      const fresh = await api.get<ClinicDetail>(`/platform/clinics/${id}`);
      setClinic((c) => (c ? { ...c, plan: fresh.plan ?? null } : fresh));
    } catch {
      /* si falla, se verá el plan anterior hasta recargar */
    }
  }

  async function load() {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [clinicData, plansData, countriesData] = await Promise.all([
        api.get<ClinicDetail>(`/platform/clinics/${id}`),
        api.get<PlanOption[]>("/platform/plans"),
        api.get<CountryOption[]>("/platform/countries"),
      ]);
      setClinic(clinicData);
      setPlans(plansData);
      setCountries(countriesData.filter((c) => c.active));
      setForm({
        name: clinicData.name,
        email: clinicData.email,
        timezone: clinicData.timezone,
        country: clinicData.country ?? NONE,
        active: clinicData.active,
        contactPhone: clinicData.contactPhone ?? "",
        website: clinicData.website ?? "",
        address: clinicData.address ?? "",
        googleBusinessUrl: clinicData.googleBusinessUrl ?? "",
        privacyNoticeUrl: clinicData.privacyNoticeUrl ?? "",
        services: clinicData.services,
        facebookUrl: clinicData.facebookUrl ?? "",
        instagramUrl: clinicData.instagramUrl ?? "",
        tiktokUrl: clinicData.tiktokUrl ?? "",
        billingLegalName: clinicData.billingLegalName ?? "",
        billingTaxId: clinicData.billingTaxId ?? "",
        billingAddress: clinicData.billingAddress ?? "",
        billingPostalCode: clinicData.billingPostalCode ?? "",
        billingEmail: clinicData.billingEmail ?? "",
        urgencyNotifyEmail: clinicData.urgencyNotifyEmail ?? "",
        urgencyNotifyPhone: clinicData.urgencyNotifyPhone ?? "",
        minLeadMinutes: String(clinicData.minLeadMinutes ?? 0),
        serviceNoun: clinicData.serviceNoun ?? "servicio",
        nextVisitOutreachEnabled: clinicData.nextVisitOutreachEnabled ?? false,
        campaignFollowUpEnabled: clinicData.campaignFollowUpEnabled ?? false,
        assistantDisclosedInProfile: clinicData.assistantDisclosedInProfile ?? false,
        nextVisitOutreachLeadDays: String(clinicData.nextVisitOutreachLeadDays ?? 14),
      });
      // El token nunca se prefilla: la API no lo devuelve, y en blanco
      // significa "dejá el que ya está".
      setWaForm({ whatsappWabaId: clinicData.whatsappWabaId ?? "", whatsappToken: "" });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo cargar la clínica");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (user && user.clinicId !== null) {
    return <p className="muted">Esta pantalla es de plataforma — un usuario de clínica no tiene acceso.</p>;
  }
  if (loading) return <PageSkeleton />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!clinic || !id) return null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    // Un campo vacío o con decimales llegaría como NaN/1,5: se frena acá con un
    // mensaje, en vez de dejar que el servidor lo rechace sin decir cuál campo.
    const lead = Number(form.minLeadMinutes);
    if (form.minLeadMinutes.trim() === "" || !Number.isInteger(lead) || lead < 0 || lead > 10080) {
      setFormError("La anticipación mínima tiene que ser un número entero de minutos, entre 0 y 10080.");
      return;
    }
    const dias = Number(form.nextVisitOutreachLeadDays);
    if (form.nextVisitOutreachLeadDays.trim() === "" || !Number.isInteger(dias) || dias < 0 || dias > 90) {
      setFormError("Los días de anticipación del contacto tienen que ser un entero entre 0 y 90.");
      return;
    }
    const palabra = form.serviceNoun.trim();
    if (palabra === "" || palabra.length > 30) {
      setFormError("La palabra para lo que se agenda no puede estar vacía ni pasar de 30 caracteres.");
      return;
    }
    setSubmitting(true);
    try {
      await api.put(`/platform/clinics/${id}`, {
        name: form.name,
        email: form.email,
        timezone: form.timezone,
        country: form.country === NONE ? null : form.country,
        active: form.active,
        contactPhone: form.contactPhone || null,
        website: form.website || null,
        address: form.address || null,
        googleBusinessUrl: form.googleBusinessUrl || null,
        privacyNoticeUrl: form.privacyNoticeUrl.trim() || null,
        services: form.services,
        whatsappWabaId: waForm.whatsappWabaId || null,
        // El token va solo si se escribió uno nuevo: en blanco significa
        // "dejá el que ya está". El backend además ignora el string vacío,
        // así que no hay forma de borrar la credencial sin querer.
        ...(waForm.whatsappToken.trim() ? { whatsappToken: waForm.whatsappToken.trim() } : {}),
        facebookUrl: form.facebookUrl || null,
        instagramUrl: form.instagramUrl || null,
        tiktokUrl: form.tiktokUrl || null,
        billingLegalName: form.billingLegalName || null,
        billingTaxId: form.billingTaxId || null,
        billingAddress: form.billingAddress || null,
        billingPostalCode: form.billingPostalCode || null,
        billingEmail: form.billingEmail || null,
        urgencyNotifyEmail: form.urgencyNotifyEmail || null,
        urgencyNotifyPhone: form.urgencyNotifyPhone || null,
        minLeadMinutes: Number(form.minLeadMinutes),
        serviceNoun: palabra,
        nextVisitOutreachEnabled: form.nextVisitOutreachEnabled,
        campaignFollowUpEnabled: form.campaignFollowUpEnabled,
        assistantDisclosedInProfile: form.assistantDisclosedInProfile,
        nextVisitOutreachLeadDays: dias,
      });
      toast.success(
        waForm.whatsappToken.trim()
          ? "Clínica actualizada. El token nuevo quedó guardado cifrado."
          : "Clínica actualizada."
      );
      await load();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "No se pudo guardar la clínica";
      setFormError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleFetchGoogle() {
    if (!form.googleBusinessUrl.trim()) {
      toast.error("Pega primero el link de Google de la clínica.");
      return;
    }
    setFetchingGoogle(true);
    try {
      const suggestion = await api.post<GoogleBusinessSuggestion>(`/platform/google-business/preview`, {
        url: form.googleBusinessUrl.trim(),
      });
      // El país solo se completa si Google detectó uno que ya tenemos
      // cargado en "Países" — si no, se deja lo que ya tenía la clínica.
      const matchedCountry = countries.find((c) => c.id === suggestion.countryCode);
      setForm((f) => ({
        ...f,
        address: suggestion.address ?? f.address,
        contactPhone: suggestion.phone ?? f.contactPhone,
        website: suggestion.website ?? f.website,
        ...(matchedCountry
          ? { country: matchedCountry.id, timezone: suggestion.timezone ?? f.timezone }
          : {}),
      }));
      toast.success("Datos de Google cargados en el formulario — revisa y guarda los cambios.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudieron traer los datos de Google");
    } finally {
      setFetchingGoogle(false);
    }
  }

  function handleEnter() {
    if (!clinic) return;
    setViewingClinic({ id: clinic.id, name: clinic.name });
    // Se aterriza en la Agenda (lo primero de "Día a día", lo que se mira al abrir una clínica) y no en el buscador de
    // Citas. El aviso se cierra solo: la franja de arriba ya dice en qué clínica se está mientras se navega.
    toast.success(`Estás dentro de ${clinic.name}.`, {
      description: "Ahora puedes ir a cualquier opción del menú.",
    });
    navigate("/calendar");
  }

  async function handleLoadTemplates() {
    setTemplatesBusy(true);
    setTemplatesError(null);
    try {
      setTemplates(await api.get<TemplateStatus[]>(`/platform/clinics/${id}/whatsapp/templates`));
    } catch (err) {
      setTemplatesError(err instanceof ApiError ? err.message : "No se pudieron leer las plantillas");
    } finally {
      setTemplatesBusy(false);
    }
  }

  async function handleCreateTemplates() {
    setTemplatesBusy(true);
    setTemplatesError(null);
    try {
      await api.post(`/platform/clinics/${id}/whatsapp/templates`, {});
      toast.success("Plantillas enviadas a Meta. Quedan pendientes de aprobación.");
      setTemplates(await api.get<TemplateStatus[]>(`/platform/clinics/${id}/whatsapp/templates`));
    } catch (err) {
      setTemplatesError(err instanceof ApiError ? err.message : "No se pudieron crear las plantillas");
    } finally {
      setTemplatesBusy(false);
    }
  }

  /*
   * El orden de los campos sigue al del alta ("Nueva clínica" en
   * ClinicsPage): primero exactamente lo que se pide al crear una clínica y
   * en la misma secuencia, y recién después lo que solo existe acá (estado,
   * redes, facturación, urgencias). Cuando los dos formularios divergen, el
   * que da de alta una clínica no encuentra después dónde editar lo que acaba
   * de cargar.
   *
   * La membresía NO está en este formulario: tiene su propia tarjeta y su
   * propio endpoint, por lo mismo que los títulos — sus reglas son cruzadas
   * (modalidad ↔ monto ↔ motivo ↔ periodicidad ↔ país), y un rechazo por el
   * motivo faltante no puede bloquear el guardado de la dirección.
   */
  return (
    <div>
      <h1>{clinic.name}</h1>

      <div className="card" style={{ marginBottom: 16 }}>
        <h4 style={{ marginTop: 0 }}>Resumen operativo</h4>
        <p className="muted">
          {clinic._count.users} usuario(s) · {clinic._count.professionals} profesional(es) ·{" "}
          {clinic._count.workingHours > 0 ? "horario cargado" : "sin horario cargado"}
        </p>
        <Button onClick={handleEnter}>Entrar a esta clínica</Button>
      </div>

      <form className="card" style={{ marginBottom: 16 }} onSubmit={handleSubmit}>
        <h4 style={{ marginTop: 0 }}>Datos de la clínica</h4>

        <div className="field">
          <Label htmlFor="detail-privacy-url">Link del aviso de privacidad de la clínica</Label>
          <p className="muted" style={{ marginTop: 0, marginBottom: 6 }}>
            La clínica es la responsable de los datos de sus pacientes y tiene que tener su propio aviso de privacidad publicado
            (que mencione al asistente virtual). El asistente manda este link una sola vez, en el segundo mensaje de cada persona
            ("Mientras tanto, le dejamos el aviso de privacidad de la clínica…"). Tiene que ser https. Si lo dejas vacío, no se manda
            ningún aviso.
          </p>
          <Input
            id="detail-privacy-url"
            placeholder="https://clinica.com/aviso-de-privacidad"
            disabled={!canEdit}
            value={form.privacyNoticeUrl}
            onChange={(e) => setForm((f) => ({ ...f, privacyNoticeUrl: e.target.value }))}
          />
        </div>

        <div className="field">
          <div className="checkbox-field">
            <Checkbox
              id="detail-disclosed-in-profile"
              disabled={!canEdit}
              checked={form.assistantDisclosedInProfile}
              onCheckedChange={(v) => setForm((f) => ({ ...f, assistantDisclosedInProfile: v === true }))}
            />
            <Label htmlFor="detail-disclosed-in-profile">
              El perfil de WhatsApp Business ya dice que se atiende con un asistente virtual
            </Label>
          </div>
          <p className="muted" style={{ fontSize: "0.9em", margin: "4px 0 8px" }}>
            Apagado por defecto: el asistente se presenta ("Le atiende el asistente virtual de…") en la primera respuesta de cada
            persona. Prende esto <strong>solo después de cargar y comprobar</strong> en WhatsApp Manager → Perfil que la descripción
            lo dice (por ejemplo: "Atención por WhatsApp con un asistente virtual. Si prefiere hablar con una persona, indíquelo.").
            Con esto prendido ya no se presenta en el chat. La política de uso del modelo de IA exige avisar que es una IA, al
            comienzo del chat o en la interfaz del producto; que el perfil cuente como "interfaz" no está confirmado con el
            proveedor del modelo: es una decisión tomada bajo ese riesgo, por clínica.
          </p>
        </div>

        <div className="field">
          <Label htmlFor="detail-google-url">Link de la clínica en Google</Label>
          <p className="muted" style={{ marginTop: 0, marginBottom: 6 }}>
            El link de la ficha en Google Maps (o uno corto tipo share.google/…). "Traer datos" sugiere dirección,
            teléfono, sitio web y horario en el formulario — no guarda nada solo, revisa y guarda los cambios.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <Input
              id="detail-google-url"
              placeholder="https://share.google/…"
              disabled={!canEdit}
              value={form.googleBusinessUrl}
              onChange={(e) => setForm((f) => ({ ...f, googleBusinessUrl: e.target.value }))}
              style={{ flex: 1 }}
            />
            {canEdit && (
              <Button type="button" variant="outline" disabled={fetchingGoogle} onClick={handleFetchGoogle}>
                {fetchingGoogle ? "Trayendo…" : "Traer datos de Google"}
              </Button>
            )}
          </div>
        </div>

        <div className="field">
          <Label htmlFor="detail-name">Nombre</Label>
          <Input
            id="detail-name"
            required
            disabled={!canEdit}
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </div>

        <div className="field">
          <Label htmlFor="detail-email">Email</Label>
          <Input
            id="detail-email"
            type="email"
            required
            disabled={!canEdit}
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
          />
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <Label htmlFor="detail-phone">Teléfono de contacto</Label>
            <Input
              id="detail-phone"
              disabled={!canEdit}
              value={form.contactPhone}
              onChange={(e) => setForm((f) => ({ ...f, contactPhone: e.target.value }))}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <Label htmlFor="detail-website">Sitio web</Label>
            <Input
              id="detail-website"
              placeholder="https://…"
              disabled={!canEdit}
              value={form.website}
              onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))}
            />
          </div>
        </div>

        <div className="field">
          <Label htmlFor="detail-address">Dirección</Label>
          <Input
            id="detail-address"
            disabled={!canEdit}
            value={form.address}
            onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
          />
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <Label>WhatsApp phone number ID</Label>
            {/* Único campo del alta que acá no se edita: es con lo que el
                webhook identifica a la clínica, y cambiarlo significa dar de
                alta el número de nuevo. */}
            <p className="muted" style={{ margin: "4px 0 0" }}>
              <code>{clinic.whatsappPhoneNumberId}</code> — es con lo que el webhook identifica a
              esta clínica. Para cambiarlo hay que dar de alta el número de nuevo.
            </p>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <Label htmlFor="detail-waba">WhatsApp WABA ID</Label>
            <Input
              id="detail-waba"
              value={waForm.whatsappWabaId}
              disabled={!canEdit}
              onChange={(e) => setWaForm((f) => ({ ...f, whatsappWabaId: e.target.value }))}
            />
            <p className="muted" style={{ fontSize: "0.85em", marginTop: 4 }}>
              El WhatsApp Business Account de la clínica. Hace falta para crear y consultar sus
              plantillas — son por WABA, así que cada clínica tiene las suyas.
            </p>
          </div>
        </div>

        <div className="field">
          <Label htmlFor="detail-wa-token">WhatsApp token</Label>
          <Input
            id="detail-wa-token"
            type="password"
            /* Sin esto el gestor de contraseñas del navegador autocompleta el
               campo, y "Guardar cambios" mandaría esa basura como token. */
            autoComplete="new-password"
            placeholder="Dejar en blanco para no cambiarlo"
            value={waForm.whatsappToken}
            disabled={!canEdit}
            onChange={(e) => setWaForm((f) => ({ ...f, whatsappToken: e.target.value }))}
          />
          <p className="muted" style={{ fontSize: "0.85em", marginTop: 4 }}>
            Se guarda cifrado y no se vuelve a mostrar. Pega uno nuevo aquí para rotarlo — el de
            prueba de Meta vence cada ~24hs. No lo edites por SQL: quedaría sin cifrar y el
            servidor no podría usarlo.
          </p>
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <Label htmlFor="detail-country">País</Label>
            <Select
              value={form.country}
              onValueChange={(v) => {
                // Radix a veces dispara `onValueChange("")` solo (sin que el
                // usuario haya elegido nada) cuando el `value` seteado por
                // código todavía no matchea ningún `SelectItem` montado — acá
                // ningún país real tiene id vacío, así que un `v` vacío nunca
                // es una elección real y se ignora.
                if (!v) return;
                const timezones = countries.find((c) => c.id === v)?.timezones ?? [];
                // Si la zona actual sigue siendo válida para el país nuevo, se
                // mantiene (evita pedirle de nuevo algo que ya estaba bien). Si
                // no, se limpia — mejor forzar una elección explícita que
                // adivinar una zona nueva en silencio.
                setForm((f) => ({ ...f, country: v, timezone: timezones.includes(f.timezone) ? f.timezone : "" }));
              }}
              disabled={!canEdit}
            >
              <SelectTrigger id="detail-country">
                {/* Hijo explícito: si no, Radix no muestra un valor precargado por
                    "Traer datos de Google" hasta que el usuario abre este dropdown. */}
                <SelectValue placeholder="Sin configurar">
                  {form.country === NONE ? undefined : countries.find((c) => c.id === form.country)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Sin configurar</SelectItem>
                {countries.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <Label htmlFor="detail-timezone">Zona horaria</Label>
            <Select
              value={form.timezone}
              onValueChange={(v) => v && setForm((f) => ({ ...f, timezone: v }))}
              disabled={!canEdit}
            >
              {/* Sin sumar `form.country === NONE` acá: alternar `disabled` justo cuando se
                  completa el valor (ej. por "Traer datos de Google") hace que Radix
                  resetee el valor a "" solo. Sin país, la lista de opciones ya queda vacía. */}
              <SelectTrigger id="detail-timezone">
                <SelectValue placeholder={form.country === NONE ? "Elige un país primero" : "Elegir zona…"}>
                  {form.timezone || undefined}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {form.timezone && !(countries.find((c) => c.id === form.country)?.timezones ?? []).includes(form.timezone) && (
                  <SelectItem value={form.timezone}>{form.timezone} (actual)</SelectItem>
                )}
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
          <Label htmlFor="detail-services">Servicios (texto para el prompt)</Label>
          <Textarea
            id="detail-services"
            required
            rows={3}
            disabled={!canEdit}
            value={form.services}
            onChange={(e) => setForm((f) => ({ ...f, services: e.target.value }))}
          />
          <p className="muted" style={{ fontSize: "0.85em", marginTop: 4 }}>
            Solo se usa si la clínica no cargó el catálogo de la pantalla "Servicios": con catálogo,
            el asistente lee ese (nombre y duración) y este texto queda de respaldo.
          </p>
        </div>

        <h4>Estado</h4>
        <div className="checkbox-field">
          <Switch
            checked={form.active}
            disabled={!canEdit}
            onCheckedChange={(checked) => setForm((f) => ({ ...f, active: checked }))}
          />
          <Label>Activa</Label>
        </div>
        <p className="muted" style={{ fontSize: "0.85em", marginTop: 4 }}>
          Una clínica inactiva sigue existiendo, pero el webhook descarta los mensajes que llegan a
          su número: el asistente deja de contestarle a sus pacientes.
        </p>

        <h4>Redes sociales</h4>
        <p className="muted" style={{ marginTop: -8 }}>
          Link o handle de referencia — sin credenciales. Contexto para el asistente y base para los canales de
          Facebook/Instagram/TikTok cuando existan.
        </p>
        <div style={{ display: "flex", gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <Label htmlFor="detail-facebook">Facebook</Label>
            <Input
              id="detail-facebook"
              disabled={!canEdit}
              value={form.facebookUrl}
              onChange={(e) => setForm((f) => ({ ...f, facebookUrl: e.target.value }))}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <Label htmlFor="detail-instagram">Instagram</Label>
            <Input
              id="detail-instagram"
              disabled={!canEdit}
              value={form.instagramUrl}
              onChange={(e) => setForm((f) => ({ ...f, instagramUrl: e.target.value }))}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <Label htmlFor="detail-tiktok">TikTok</Label>
            <Input
              id="detail-tiktok"
              disabled={!canEdit}
              value={form.tiktokUrl}
              onChange={(e) => setForm((f) => ({ ...f, tiktokUrl: e.target.value }))}
            />
          </div>
        </div>

        <h4>Facturación</h4>
        <div style={{ display: "flex", gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <Label htmlFor="detail-legal-name">Razón social</Label>
            <Input
              id="detail-legal-name"
              disabled={!canEdit}
              value={form.billingLegalName}
              onChange={(e) => setForm((f) => ({ ...f, billingLegalName: e.target.value }))}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <Label htmlFor="detail-tax-id">CUIT / RFC</Label>
            <Input
              id="detail-tax-id"
              disabled={!canEdit}
              value={form.billingTaxId}
              onChange={(e) => setForm((f) => ({ ...f, billingTaxId: e.target.value }))}
            />
          </div>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <Label htmlFor="detail-billing-address">Dirección de facturación</Label>
            <Input
              id="detail-billing-address"
              disabled={!canEdit}
              value={form.billingAddress}
              onChange={(e) => setForm((f) => ({ ...f, billingAddress: e.target.value }))}
            />
          </div>
          <div className="field" style={{ flex: "0 0 160px" }}>
            <Label htmlFor="detail-billing-postal-code">Código postal</Label>
            <Input
              id="detail-billing-postal-code"
              disabled={!canEdit}
              inputMode="numeric"
              maxLength={12}
              value={form.billingPostalCode}
              onChange={(e) => setForm((f) => ({ ...f, billingPostalCode: e.target.value }))}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <Label htmlFor="detail-billing-email">Email de facturación</Label>
            <Input
              id="detail-billing-email"
              type="email"
              disabled={!canEdit}
              value={form.billingEmail}
              onChange={(e) => setForm((f) => ({ ...f, billingEmail: e.target.value }))}
            />
          </div>
        </div>

        <h4>Avisos de urgencias</h4>
        <p className="muted" style={{ marginTop: 0 }}>
          A dónde avisar cuando el asistente deriva una urgencia a una persona. Va aparte del mail
          general: tiene que llegarle a quien está de guardia, no a quien administra el sistema.
        </p>
        <div style={{ display: "flex", gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <Label htmlFor="detail-urgency-email">Email para urgencias</Label>
            <Input
              id="detail-urgency-email"
              type="email"
              placeholder="Si queda vacío se usa el email de la clínica"
              disabled={!canEdit}
              value={form.urgencyNotifyEmail}
              onChange={(e) => setForm((f) => ({ ...f, urgencyNotifyEmail: e.target.value }))}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <Label htmlFor="detail-urgency-phone">WhatsApp para urgencias</Label>
            <Input
              id="detail-urgency-phone"
              disabled={!canEdit}
              value={form.urgencyNotifyPhone}
              onChange={(e) => setForm((f) => ({ ...f, urgencyNotifyPhone: e.target.value }))}
            />
            <p className="muted" style={{ fontSize: "0.9em", margin: 0 }}>
              Todavía no se usa: WhatsApp exige una plantilla aprobada por Meta para escribirle a
              alguien que no escribió primero, y está pendiente. Por ahora el aviso va por mail.
            </p>
          </div>
        </div>

        <div className="field" style={{ marginTop: 12 }}>
          <Label htmlFor="detail-service-noun">Cómo se llama lo que se agenda</Label>
          <Input
            id="detail-service-noun"
            maxLength={30}
            disabled={!canEdit}
            value={form.serviceNoun}
            onChange={(e) => setForm((f) => ({ ...f, serviceNoun: e.target.value }))}
          />
          <p className="muted" style={{ fontSize: "0.9em", margin: 0 }}>
            La palabra con que el asistente nombra, ante el paciente, lo que se agenda: "tratamiento" en una
            clínica dental, "servicio" en un spa, "atención", etc. Solo cambia cómo habla el asistente: el
            catálogo de Servicios y sus nombres no se tocan.
          </p>
        </div>

        <div className="field" style={{ marginTop: 12 }}>
          <Label htmlFor="detail-min-lead">Anticipación mínima para reservar (minutos)</Label>
          <Input
            id="detail-min-lead"
            type="number"
            min={0}
            max={10080}
            step={1}
            disabled={!canEdit}
            value={form.minLeadMinutes}
            onChange={(e) => setForm((f) => ({ ...f, minLeadMinutes: e.target.value }))}
          />
          <p className="muted" style={{ fontSize: "0.9em", margin: 0 }}>
            Por defecto 60 (una hora). Cada clínica puede tener el suyo: 120 = 2 horas, 1440 = 1 día, 0 =
            sin mínimo (se puede reservar para dentro de un minuto). El asistente no ofrece ni agenda
            horarios más cercanos; desde la Agenda una asistente sí puede saltárselo confirmando.
          </p>
        </div>

        <div className="field" style={{ marginTop: 12 }}>
          <div className="checkbox-field">
            <Checkbox
              id="detail-outreach"
              disabled={!canEdit || !enPlan("contacto_proxima_cita")}
              checked={form.nextVisitOutreachEnabled}
              onCheckedChange={(v) => setForm((f) => ({ ...f, nextVisitOutreachEnabled: v === true }))}
            />
            <Label htmlFor="detail-outreach">
              Escribirles a los pacientes cuando se acerca su próxima cita sugerida
            </Label>
          </div>
          <p className="muted" style={{ fontSize: "0.9em", margin: "4px 0 8px" }}>
            Apagado por defecto. Va por la plantilla <code>proximo_control</code>, que Meta tiene que aprobar en el WABA
            de esta clínica (y puede reclasificarla como Marketing): revisa su estado en "Plantillas de WhatsApp" antes de
            prenderlo. Solo les escribe a quienes no tienen ya un turno ni pidieron que no los contactemos, de a un mensaje
            por sugerencia.
          </p>
          {!enPlan("contacto_proxima_cita") && (
            <p className="muted" role="note" style={{ fontSize: "0.9em", margin: "0 0 8px" }}>
              <strong>No está incluido en el plan{clinic.plan ? ` «${clinic.plan.name}»` : ""}</strong> de esta clínica (es del plan Plus).
              Cambia el plan en la tarjeta de membresía para poder prenderlo.
            </p>
          )}
          <Label htmlFor="detail-outreach-dias">Días de anticipación a la fecha sugerida</Label>
          <Input
            id="detail-outreach-dias"
            type="number"
            min={0}
            max={90}
            step={1}
            disabled={!canEdit}
            value={form.nextVisitOutreachLeadDays}
            onChange={(e) => setForm((f) => ({ ...f, nextVisitOutreachLeadDays: e.target.value }))}
            style={{ maxWidth: 140 }}
          />
        </div>

        <div className="field" style={{ marginTop: 12 }}>
          <div className="checkbox-field">
            <Checkbox
              id="detail-campaign-followup"
              disabled={!canEdit || !enPlan("seguimiento_campanas")}
              checked={form.campaignFollowUpEnabled}
              onCheckedChange={(v) => setForm((f) => ({ ...f, campaignFollowUpEnabled: v === true }))}
            />
            <Label htmlFor="detail-campaign-followup">
              Hacerles seguimiento a quienes llegaron por una campaña y no agendaron
            </Label>
          </div>
          <p className="muted" style={{ fontSize: "0.9em", margin: "4px 0 8px" }}>
            Apagado por defecto. Va por la plantilla <code>seguimiento_campana</code>, que Meta tiene que aprobar en el WABA
            de esta clínica (y puede reclasificarla como Marketing): revisa su estado en "Plantillas de WhatsApp" antes de
            prenderlo. Cuántas veces y cada cuánto lo define cada campaña (con un tope de 5 intentos), y no se le escribe a
            quien ya agendó ni a quien pidió que no lo contactemos.
          </p>
          {!enPlan("seguimiento_campanas") && (
            <p className="muted" role="note" style={{ fontSize: "0.9em", margin: "0 0 8px" }}>
              <strong>No está incluido en el plan{clinic.plan ? ` «${clinic.plan.name}»` : ""}</strong> de esta clínica (es del plan Plus).
              Cambia el plan en la tarjeta de membresía para poder prenderlo.
            </p>
          )}
        </div>

        {formError && <p className="error-text">{formError}</p>}
        {canEdit && (
          <Button type="submit" disabled={submitting} style={{ marginTop: 12 }}>
            {submitting ? "Guardando…" : "Guardar cambios"}
          </Button>
        )}
      </form>

      <Membresia clinicId={id} country={clinic.country} plans={plans} canEdit={canEdit} onSaved={refreshPlan} />

      <TitulosHabilitados clinicId={id} canEdit={canEdit} />

      {/*
        * Las plantillas van en su propia tarjeta y no adentro del formulario:
        * sus botones no guardan la clínica, le hablan a Meta.
        */}
      <div className="card">
        <h4 style={{ marginTop: 0 }}>Plantillas de WhatsApp</h4>
        {!clinic.whatsappWabaId ? (
          <p className="muted">
            Carga el WABA ID aquí arriba y guarda para poder crear y consultar las plantillas de esta
            clínica.
          </p>
        ) : (
          <>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Button type="button" variant="outline" disabled={templatesBusy} onClick={handleLoadTemplates}>
                {templatesBusy ? "Consultando…" : "Ver estado en Meta"}
              </Button>
              {canEdit && (
                <Button type="button" variant="outline" disabled={templatesBusy} onClick={handleCreateTemplates}>
                  Crear las que falten
                </Button>
              )}
            </div>
            {templatesError && <p className="error-text">{templatesError}</p>}
            {templates && (
              <ul style={{ marginTop: 12, paddingLeft: 18 }}>
                {templates.map((t) => (
                  <li key={t.name} style={{ marginBottom: 6 }}>
                    <code>{t.name}</code> — <strong>{t.status}</strong>
                    <div className="muted" style={{ fontSize: "0.85em" }}>{t.descripcion}</div>
                  </li>
                ))}
              </ul>
            )}
            <p className="muted" style={{ fontSize: "0.85em", marginTop: 8 }}>
              Crear no es aprobar: quedan en <code>PENDING</code> hasta que Meta las revise, y
              recién ahí se pueden usar para mandar recordatorios.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/** Cómo se lee cada modalidad en pantalla. */
const MODALIDADES: Record<string, { label: string; ayuda: string }> = {
  lista: {
    label: "Precio de lista",
    ayuda:
      "Se copia el precio de lista del plan para el país de la clínica. Desde ese momento es su precio: " +
      "un aumento de la lista no la va a mover.",
  },
  especial: {
    label: "Precio especial",
    ayuda:
      "Precio negociado, distinto al de lista. Exige un motivo: sin él es indistinguible de un error de tipeo.",
  },
  exonerada: {
    label: "Exonerada",
    ayuda:
      "No se le cobra. Conserva el plan y todas sus funcionalidades — exonerar no es sacarle el plan. Exige un motivo.",
  },
};

/**
 * Qué le cobra la plataforma a esta clínica.
 *
 * En su propia tarjeta y con su propio botón, aparte del formulario grande,
 * por el mismo motivo que los títulos: sus reglas son cruzadas (modalidad ↔
 * monto ↔ motivo ↔ periodicidad ↔ país ↔ existencia de precio de lista), y un
 * rechazo por el motivo faltante no puede bloquear el guardado de la
 * dirección.
 *
 * Las tres cosas que la pantalla tiene que explicar, porque son las que no se
 * deducen mirando un monto:
 *
 * 1. **El precio es una copia**, no una referencia: cambiar la lista no mueve
 *    a esta clínica, y por eso se muestra la comparación con la lista de hoy.
 * 2. **"Exonerada" no es costo cero** — es un estado propio, distinto de
 *    "todavía no le pusimos precio", y conserva el plan.
 * 3. **Por qué no hay lista con la que comparar**, cuando no hay
 *    (`listPriceStatus`), en vez de mostrar un guion y dejar al admin
 *    adivinando.
 */
function Membresia(props: {
  clinicId: string;
  country: string | null;
  plans: PlanOption[];
  canEdit: boolean;
  onSaved?: () => void;
}) {
  const [view, setView] = useState<MembershipView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const [pricing, setPricing] = useState<string>(NONE);
  const [planId, setPlanId] = useState<string>(NONE);
  const [billingPeriod, setBillingPeriod] = useState<"mensual" | "anual">("mensual");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  /** La grilla del plan elegido, para poder mostrar el precio de lista ANTES de guardar. */
  const [gridPlanId, setGridPlanId] = useState<string | null>(null);
  const [grid, setGrid] = useState<PlanPriceRow[] | null>(null);
  const [gridFallo, setGridFallo] = useState(false);

  async function load() {
    setError(null);
    try {
      const data = await api.get<MembershipView>(`/platform/clinics/${props.clinicId}/membership`);
      setView(data);
      setPricing(data.pricing ?? NONE);
      setPlanId(data.planId ?? NONE);
      setBillingPeriod(data.billingPeriod ?? "mensual");
      setAmount(data.pricing === "especial" ? (data.amount ?? "") : "");
      setReason(data.reason ?? "");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo cargar la membresía");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.clinicId]);

  /*
   * El precio de lista del plan ELEGIDO (que puede no ser el que la clínica
   * tiene hoy). Se trae para poder decir "vas a copiar ARS 18.000" antes de
   * guardar, y para avisar que falta cargarlo en vez de dejar que el backend
   * lo rechace con un 409 después de completar todo el formulario.
   */
  useEffect(() => {
    if (pricing !== "lista" || planId === NONE || gridPlanId === planId) return;
    let vigente = true;
    api
      .get<{ filas: PlanPriceRow[] }>(`/platform/plans/${planId}/prices`)
      .then((data) => {
        if (!vigente) return;
        setGrid(data.filas);
        setGridPlanId(planId);
        setGridFallo(false);
      })
      .catch(() => {
        // Se distingue de "no hay precio cargado": son dos cosas distintas y
        // decir la equivocada manda al admin a cargar un precio que ya existe.
        if (!vigente) return;
        setGrid(null);
        setGridFallo(true);
      });
    return () => {
      vigente = false;
    };
  }, [pricing, planId, gridPlanId]);

  async function guardar() {
    setFormError(null);
    setGuardando(true);
    try {
      const body =
        pricing === NONE
          ? // "Sin precio definido" conserva el plan si hay uno elegido: sacarle
            // el precio a una clínica no puede apagarle de paso las
            // funcionalidades que tiene contratadas.
            { pricing: null, planId: planId === NONE ? null : planId }
          : pricing === "exonerada"
            ? { pricing, planId, reason }
            : pricing === "lista"
              ? { pricing, planId, billingPeriod }
              : { pricing, planId, billingPeriod, amount, reason };

      await api.put(`/platform/clinics/${props.clinicId}/membership`, body);
      toast.success("Membresía actualizada.");
      // Se recarga en vez de usar lo que devolvió el PUT: ese cuerpo no trae el
      // historial, y la fila del cambio que se acaba de hacer es justo lo que
      // hay que ver abajo.
      await load();
      props.onSaved?.();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "No se pudo guardar la membresía";
      setFormError(message);
      toast.error(message);
    } finally {
      setGuardando(false);
    }
  }

  if (error) {
    return (
      <div className="card">
        <h4 style={{ marginTop: 0 }}>Membresía</h4>
        <ErrorState message={error} onRetry={load} />
      </div>
    );
  }
  if (!view) {
    return (
      <div className="card">
        <h4 style={{ marginTop: 0 }}>Membresía</h4>
        <p className="muted">Cargando…</p>
      </div>
    );
  }

  const filaDelPais = grid?.find((f) => f.countryId === props.country) ?? null;
  const listaElegida = filaDelPais?.[billingPeriod]?.amount ?? null;
  const planDe = (id: string | null) => props.plans.find((p) => p.id === id)?.name ?? null;

  const razonesSinLista: Record<MembershipView["listPriceStatus"], string> = {
    ok: "",
    sin_plan: "esta clínica no tiene plan asignado",
    sin_pais: "esta clínica no tiene país cargado",
    sin_periodicidad: "su membresía no tiene periodicidad (una exoneración no la necesita)",
    no_cargado: "nadie cargó el precio de ese plan para su país y periodicidad",
  };

  return (
    <div className="card">
      <h4 style={{ marginTop: 0 }}>Membresía</h4>

      {/* Estado actual, antes del formulario: es lo que se viene a mirar. */}
      <p style={{ marginTop: 0 }}>
        {view.pricing === null ? (
          <>
            <strong>Sin precio definido.</strong>{" "}
            <span className="muted">
              {view.planId
                ? `Tiene el plan ${planDe(view.planId) ?? view.planId} y sus funcionalidades, pero todavía no se le fijó qué paga.`
                : "No tiene plan ni precio."}
            </span>
          </>
        ) : view.pricing === "exonerada" ? (
          <>
            <strong>Exonerada</strong> — no se le cobra, y conserva el plan{" "}
            {planDe(view.planId) ?? "asignado"} con todas sus funcionalidades.
          </>
        ) : (
          <>
            <strong>
              {view.currency} {view.amount}
            </strong>{" "}
            {view.billingPeriod === "anual" ? "por año" : "por mes"} — plan{" "}
            {planDe(view.planId) ?? "—"}, {MODALIDADES[view.pricing].label.toLowerCase()}
          </>
        )}
      </p>

      {view.reason && (
        <p className="muted" style={{ marginTop: 0 }}>
          Motivo: {view.reason}
        </p>
      )}
      {view.pricedAt && (
        <p className="muted" style={{ fontSize: "0.85em", marginTop: 0 }}>
          Fijado el {formatDateTime(view.pricedAt)}.
        </p>
      )}

      {/* La comparación con la lista de HOY: es referencia, no lo que paga. */}
      {view.pricing !== null && view.pricing !== "exonerada" && (
        <p className="muted" style={{ fontSize: "0.9em" }}>
          {view.listPriceStatus !== "ok" || !view.listPrice ? (
            <>Sin precio de lista con el que comparar: {razonesSinLista[view.listPriceStatus]}.</>
          ) : view.comparacion.estado === "igual" ? (
            <>
              Igual al precio de lista de hoy ({view.listPrice.currency} {view.listPrice.amount}).
            </>
          ) : view.comparacion.estado === "sin_referencia" ? (
            <>Sin precio de lista con el que comparar.</>
          ) : (
            <>
              Precio de lista de hoy: {view.listPrice.currency} {view.listPrice.amount} — esta clínica está{" "}
              {view.comparacion.estado === "por_debajo" ? "por debajo" : "por encima"} en{" "}
              {view.comparacion.diffAmount} ({view.comparacion.diffPercent}%).
            </>
          )}
        </p>
      )}

      {view.listaCambiadaDespues && (
        <p className="muted" style={{ fontSize: "0.9em" }}>
          El precio de lista cambió después de que se le fijó el suyo. <strong>No se le tocó nada</strong>:
          si corresponde actualizarlo, hay que volver a elegir "precio de lista" aquí abajo.
        </p>
      )}
      {view.currencyMismatch && (
        <p className="error-text">
          Su precio está en {view.currencyMismatch.membresia} y el país de la clínica factura en{" "}
          {view.currencyMismatch.pais}. La moneda queda congelada con el acuerdo: hay que volver a fijar el
          precio para pasarlo a la moneda nueva.
        </p>
      )}

      {props.canEdit && (
        <>
          <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
            <div className="field" style={{ flex: 1 }}>
              <Label htmlFor="membresia-modalidad">Modalidad</Label>
              <Select value={pricing} onValueChange={(v) => v && setPricing(v)}>
                <SelectTrigger id="membresia-modalidad">
                  <SelectValue>
                    {pricing === NONE ? "Sin precio definido" : MODALIDADES[pricing].label}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Sin precio definido</SelectItem>
                  <SelectItem value="lista">Precio de lista</SelectItem>
                  <SelectItem value="especial">Precio especial</SelectItem>
                  <SelectItem value="exonerada">Exonerada</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <Label htmlFor="membresia-plan">Plan</Label>
              <Select value={planId} onValueChange={(v) => v && setPlanId(v)}>
                <SelectTrigger id="membresia-plan">
                  <SelectValue>{planId === NONE ? "Sin plan" : (planDe(planId) ?? planId)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Sin plan</SelectItem>
                  {props.plans.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {pricing !== NONE && pricing !== "exonerada" && (
              <div className="field" style={{ flex: 1 }}>
                <Label htmlFor="membresia-periodo">Periodicidad</Label>
                <Select
                  value={billingPeriod}
                  onValueChange={(v) => v && setBillingPeriod(v as "mensual" | "anual")}
                >
                  <SelectTrigger id="membresia-periodo">
                    <SelectValue>{billingPeriod === "anual" ? "Anual" : "Mensual"}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mensual">Mensual</SelectItem>
                    <SelectItem value="anual">Anual</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <p className="muted" style={{ fontSize: "0.9em", marginTop: 0 }}>
            {pricing === NONE
              ? planId === NONE
                ? "Queda sin plan y sin precio: pierde las funcionalidades del plan."
                : "Conserva el plan y sus funcionalidades; queda pendiente definir qué paga."
              : MODALIDADES[pricing].ayuda}
          </p>

          {pricing === "lista" && (
            <p className="muted" style={{ fontSize: "0.9em" }}>
              {planId === NONE ? (
                "Elige un plan para ver su precio de lista."
              ) : !props.country ? (
                "La clínica no tiene país cargado, así que no hay moneda en la que expresar el precio. Carga el país arriba y guarda primero."
              ) : listaElegida ? (
                <>
                  Se va a copiar: {filaDelPais?.currency} {listaElegida} ({billingPeriod}).
                </>
              ) : gridFallo ? (
                "No se pudieron leer los precios de ese plan, así que aquí no se puede mostrar cuál se va a copiar."
              ) : (
                <>
                  Ese plan no tiene precio {billingPeriod} cargado para el país de la clínica. Cárgalo en
                  Catálogos → Planes → Precios, o usa un precio especial.
                </>
              )}
            </p>
          )}

          {pricing === "especial" && (
            <div className="field">
              <Label htmlFor="membresia-monto">Monto</Label>
              <Input
                id="membresia-monto"
                inputMode="decimal"
                placeholder="15000.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          )}

          {(pricing === "especial" || pricing === "exonerada") && (
            <div className="field">
              <Label htmlFor="membresia-motivo">Motivo</Label>
              <Textarea
                id="membresia-motivo"
                rows={2}
                placeholder={
                  pricing === "exonerada"
                    ? "Convenio de colaboración, clínica piloto…"
                    : "Precio acordado en la negociación de…"
                }
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <p className="muted" style={{ fontSize: "0.85em", marginTop: 4 }}>
                Queda en el historial con quién lo cambió. Es lo que se va a leer el día que alguien
                pregunte por qué esta clínica paga distinto que la de al lado.
              </p>
            </div>
          )}

          {formError && <p className="error-text">{formError}</p>}
          <Button type="button" disabled={guardando} onClick={guardar} style={{ marginTop: 12 }}>
            {guardando ? "Guardando…" : "Guardar membresía"}
          </Button>
        </>
      )}

      {view.historial.length > 0 && (
        <>
          <h4>Historial</h4>
          <ul style={{ paddingLeft: 18, margin: 0 }}>
            {view.historial.map((h) => (
              <li key={h.id} style={{ marginBottom: 6 }}>
                {formatDateTime(h.changedAt)} —{" "}
                {describirCambio(h.fromPricing, h.fromAmount, h.toPricing, h.toAmount, h.currency)}
                {h.changedBy && <span className="muted"> · {h.changedBy}</span>}
                {h.reason && <div className="muted" style={{ fontSize: "0.85em" }}>{h.reason}</div>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * Una línea del historial en castellano.
 *
 * Se arma con la modalidad Y el monto porque ninguno de los dos alcanza solo:
 * "15000 → 15000" esconde el paso de lista a especial (que es justo la
 * decisión que se quiere poder auditar), y "lista → especial" esconde cuánto
 * cambió.
 */
function describirCambio(
  fromPricing: string | null,
  fromAmount: string | null,
  toPricing: string | null,
  toAmount: string | null,
  currency: string | null
): string {
  const lado = (pricing: string | null, monto: string | null) => {
    if (pricing === null) return "sin precio definido";
    if (pricing === "exonerada") return "exonerada";
    const etiqueta = MODALIDADES[pricing]?.label.toLowerCase() ?? pricing;
    return monto ? `${etiqueta} de ${currency ?? ""} ${monto}`.trim() : etiqueta;
  };
  return `${lado(fromPricing, fromAmount)} → ${lado(toPricing, toAmount)}`;
}

/**
 * Con qué títulos de profesional trabaja esta clínica.
 *
 * En su propia tarjeta y con su propio botón, aparte del formulario grande,
 * por dos motivos: quitar un título que la clínica está usando se rechaza, y
 * si viviera adentro del formulario ese rechazo bloquearía el guardado de
 * todo lo demás. Además el catálogo es de la plataforma — acá solo se elige
 * de él.
 */
function TitulosHabilitados(props: { clinicId: string; canEdit: boolean }) {
  const [catalogo, setCatalogo] = useState<Array<{ id: string; name: string; active: boolean }>>([]);
  const [habilitados, setHabilitados] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  async function load() {
    try {
      const [titulos, asignados] = await Promise.all([
        api.get<Array<{ id: string; name: string; active: boolean }>>("/platform/titles"),
        api.get<{ habilitados: string[] }>(`/platform/clinics/${props.clinicId}/titles`),
      ]);
      setCatalogo(titulos);
      setHabilitados(asignados.habilitados);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudieron cargar los títulos");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.clinicId]);

  async function guardar() {
    setError(null);
    setGuardando(true);
    try {
      await api.put(`/platform/clinics/${props.clinicId}/titles`, { titleIds: habilitados });
      toast.success("Títulos habilitados actualizados.");
      await load();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "No se pudieron guardar los títulos";
      setError(message);
      toast.error(message);
      // Se recarga para volver a mostrar lo que realmente quedó guardado: si
      // el backend rechazó quitar uno en uso, el tilde tiene que volver.
      await load();
    } finally {
      setGuardando(false);
    }
  }

  // Un título inactivo en el catálogo no se puede habilitar, pero si esta
  // clínica ya lo tenía se muestra igual — si no, desaparecería de la
  // pantalla sin explicación.
  const visibles = catalogo.filter((t) => t.active || habilitados.includes(t.id));

  return (
    <div className="card">
      <h4 style={{ marginTop: 0 }}>Títulos de profesional</h4>
      <p className="muted" style={{ fontSize: "0.9em", marginTop: 0 }}>
        Con cuáles trabaja esta clínica. Es lo único que va a ofrecer el desplegable al cargar un
        profesional en "Recursos". El catálogo se administra en "Títulos".
      </p>

      {visibles.length === 0 ? (
        <p className="muted">
          El catálogo está vacío. Carga títulos en la pantalla "Títulos" para poder habilitarlos aquí.
        </p>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 20px" }}>
          {visibles.map((t) => (
            <div className="checkbox-field" key={t.id} style={{ flex: "0 0 auto" }}>
              <Checkbox
                id={`titulo-${t.id}`}
                disabled={!props.canEdit || !t.active}
                checked={habilitados.includes(t.id)}
                onCheckedChange={(checked) =>
                  setHabilitados((prev) =>
                    checked ? [...prev, t.id] : prev.filter((id) => id !== t.id)
                  )
                }
              />
              <Label htmlFor={`titulo-${t.id}`}>
                {t.name}
                {!t.active && <span className="muted"> (inactivo)</span>}
              </Label>
            </div>
          ))}
        </div>
      )}

      {error && <p className="error-text">{error}</p>}
      {props.canEdit && visibles.length > 0 && (
        <Button type="button" disabled={guardando} onClick={guardar} style={{ marginTop: 12 }}>
          {guardando ? "Guardando…" : "Guardar títulos"}
        </Button>
      )}
    </div>
  );
}
