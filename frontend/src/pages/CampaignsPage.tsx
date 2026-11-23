import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Megaphone, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "../api/client";
import { useAuth, useEffectiveClinicId } from "../auth/AuthContext";
import { ClinicScopeRequired } from "../components/shell/ClinicScopeRequired";
import { PageContainer } from "../components/shell/PageContainer";
import { Badge, type BadgeVariant } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { DateField } from "../components/ui/date-field";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { PageSkeleton } from "../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Textarea } from "../components/ui/textarea";
import { formatDate, formatDateTime } from "../lib/format";
import {
  estadoDelContacto,
  ETIQUETA_ESTADO,
  porcentaje,
  type Campana,
  type Contacto,
  type EstadoCampana,
  type FormatoDeCampana,
  type OpcionesDeCampana,
  type RespuestaDeCampanas,
} from "../lib/campaigns";

/** Desde cuántas palabras una frase de formato se avisa como demasiado larga para coincidir. */
const PALABRAS_MAXIMAS_AVISO = 6;

const VARIANTE: Record<EstadoCampana, BadgeVariant> = { vigente: "success", programada: "secondary", vencida: "outline", inactiva: "outline" };

/**
 * Campañas y promociones: de dónde llegan los mensajes de WhatsApp, qué se promociona y con quién se atiende.
 *
 * - Cada campaña se reconoce por uno o varios **formatos**: el anuncio de Meta (Click-to-WhatsApp) o una frase
 *   que viene en el mensaje (el texto prellenado de un link, un QR o un flyer).
 * - Se asocia a un **servicio** (que ya tiene sus profesionales) y, si hace falta, le suma profesionales solo
 *   para esa promoción.
 * - Quienes preguntan y no agendan quedan en **seguimiento**, con un tope de intentos para no insistir de más.
 */
export function CampaignsPage() {
  const clinicId = useEffectiveClinicId();
  const { hasPermission } = useAuth();
  const puedeEditar = hasPermission("campanas.editar");

  const [datos, setDatos] = useState<RespuestaDeCampanas | null>(null);
  const [contactos, setContactos] = useState<Contacto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState<Campana | "nueva" | null>(null);
  const [prueba, setPrueba] = useState("");
  const [resultadoPrueba, setResultadoPrueba] = useState<{ reconocida: { id: string; name: string } | null; formato: { kind: string; value: string } | null } | null>(null);
  const [probando, setProbando] = useState(false);
  const [filtroCampana, setFiltroCampana] = useState("");
  const [filtroEstado, setFiltroEstado] = useState("");

  const cargar = useCallback(async () => {
    if (!clinicId) return;
    setError(null);
    try {
      setDatos(await api.get<RespuestaDeCampanas>(`/dashboard/clinics/${clinicId}/campaigns`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudieron cargar las campañas");
    }
  }, [clinicId]);

  const cargarContactos = useCallback(async () => {
    if (!clinicId) return;
    const p = new URLSearchParams();
    if (filtroCampana) p.set("campaignId", filtroCampana);
    if (filtroEstado) p.set("estado", filtroEstado);
    try {
      setContactos(await api.get<Contacto[]>(`/dashboard/clinics/${clinicId}/campaigns/leads?${p}`));
    } catch {
      setContactos([]);
    }
  }, [clinicId, filtroCampana, filtroEstado]);

  useEffect(() => {
    cargar();
  }, [cargar]);
  useEffect(() => {
    cargarContactos();
  }, [cargarContactos]);

  if (!clinicId) return <ClinicScopeRequired />;
  if (error && !datos) return <ErrorState message={error} onRetry={cargar} />;
  if (!datos) return <PageSkeleton />;

  async function alternarActiva(c: Campana) {
    try {
      await api.put(`/dashboard/clinics/${clinicId}/campaigns/${c.id}`, { active: !c.active });
      toast.success(c.active ? "Campaña desactivada." : "Campaña activada.");
      await cargar();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo cambiar la campaña");
    }
  }

  async function probarMensaje() {
    const texto = prueba.trim();
    if (!texto) return;
    setProbando(true);
    try {
      setResultadoPrueba(await api.get(`/dashboard/clinics/${clinicId}/campaigns/match?texto=${encodeURIComponent(texto)}`));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo probar el mensaje");
    } finally {
      setProbando(false);
    }
  }

  async function cerrarContacto(c: Contacto) {
    try {
      await api.post(`/dashboard/clinics/${clinicId}/campaigns/leads/${c.id}/close`, {});
      toast.success("Seguimiento cerrado.");
      await Promise.all([cargar(), cargarContactos()]);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo cerrar el seguimiento");
    }
  }

  return (
    <PageContainer>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>Campañas</h1>
        {puedeEditar && (
          <Button onClick={() => setEditando("nueva")}>
            <Plus size={16} /> Nueva campaña
          </Button>
        )}
      </div>
      <p className="muted">
        Identifica a quienes escriben por una promoción —desde un anuncio de Meta, un flyer, un QR o las redes— para saber qué
        campaña trae pacientes y hacerles seguimiento si preguntan y no agendan.
      </p>
      {!datos.seguimientoHabilitado && (
        <p className="muted" role="note">
          {datos.seguimientoEnPlan === false ? (
            <>
              El seguimiento automático <strong>no está incluido en el plan</strong> de esta clínica: los contactos se registran y se
              cuentan, pero no se les escribe. Está disponible en el plan Plus.
            </>
          ) : (
            <>
              El seguimiento automático está <strong>apagado</strong> en esta clínica: los contactos se registran y se cuentan, pero no se les
              escribe. Lo habilita el administrador de la plataforma cuando la plantilla de WhatsApp está aprobada.
            </>
          )}
        </p>
      )}

      <Tabs defaultValue="campanas">
        <TabsList>
          <TabsTrigger value="campanas">Campañas</TabsTrigger>
          <TabsTrigger value="contactos">Contactos y seguimiento</TabsTrigger>
        </TabsList>

        <TabsContent value="campanas">
          {datos.campanas.length > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              <Label htmlFor="c-probar">¿Se reconocería este mensaje como de una campaña?</Label>
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <Input
                  id="c-probar"
                  value={prueba}
                  placeholder="Pega acá lo que escribiría un paciente: «Hola, escribo por la promoción de implantes»"
                  onChange={(e) => { setPrueba(e.target.value); setResultadoPrueba(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); probarMensaje(); } }}
                />
                <Button variant="outline" onClick={probarMensaje} disabled={probando || !prueba.trim()}>Probar</Button>
              </div>
              {resultadoPrueba && (
                resultadoPrueba.reconocida ? (
                  <p style={{ margin: "8px 0 0" }} role="status">
                    <Badge variant="success">Se reconoce</Badge> como la campaña <strong>{resultadoPrueba.reconocida.name}</strong>, por el formato{" "}
                    <em>«{resultadoPrueba.formato?.value}»</em>.
                  </p>
                ) : (
                  <p style={{ margin: "8px 0 0" }} role="status">
                    <Badge variant="destructive">No se reconoce</Badge> Ninguna campaña activa tiene un formato que esté <strong>dentro</strong> de este
                    mensaje.
                  </p>
                )
              )}
              <p className="muted" style={{ margin: "6px 0 0", fontSize: "0.85em" }}>
                La regla: el mensaje tiene que <strong>contener</strong> la frase de un formato (sin importar mayúsculas ni tildes). Una frase larga casi
                nunca coincide: usa lo más corto y propio de la campaña.
              </p>
            </div>
          )}
          {datos.campanas.length === 0 ? (
            <EmptyState icon={Megaphone} title="Todavía no hay campañas" description="Crea la primera para empezar a saber de dónde llegan tus pacientes." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Campaña</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead>Servicio</TableHead>
                  <TableHead>Llegaron</TableHead>
                  <TableHead>Agendaron</TableHead>
                  <TableHead>En seguimiento</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {datos.campanas.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <strong>{c.name}</strong>
                      <div className="muted" style={{ fontSize: "0.85em" }}>
                        {c.channel ?? "Sin canal"} · {c.triggers.length} formato{c.triggers.length === 1 ? "" : "s"}
                        {(c.startsOn || c.endsOn) && ` · ${c.startsOn ? formatDate(c.startsOn) : "…"} al ${c.endsOn ? formatDate(c.endsOn) : "…"}`}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={VARIANTE[c.estado]}>{ETIQUETA_ESTADO[c.estado]}</Badge>
                      {c.active && c.triggers.length === 0 && (
                        <div style={{ marginTop: 4 }}>
                          <Badge variant="destructive">Sin formatos: nadie la va a reconocer</Badge>
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {c.service?.name ?? (c.active ? <Badge variant="destructive">Falta el servicio</Badge> : "—")}
                    </TableCell>
                    <TableCell>
                      {c.estadisticas.contacts}
                      <div className="muted" style={{ fontSize: "0.85em" }}>{c.estadisticas.newContacts} nuevos</div>
                    </TableCell>
                    <TableCell>
                      {c.estadisticas.converted}
                      <div className="muted" style={{ fontSize: "0.85em" }}>{porcentaje(c.estadisticas.converted, c.estadisticas.contacts)}</div>
                    </TableCell>
                    <TableCell>{c.estadisticas.open}</TableCell>
                    <TableCell style={{ whiteSpace: "nowrap" }}>
                      {puedeEditar && (
                        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                          <Button variant="outline" size="sm" onClick={() => setEditando(c)}>Editar</Button>
                          <Button variant="outline" size="sm" onClick={() => alternarActiva(c)}>{c.active ? "Desactivar" : "Activar"}</Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <p className="muted" style={{ marginTop: 12 }}>
            Las cifras son de toda la historia de cada campaña. Para un período, ver el reporte "Campañas" en Reportes.
          </p>
        </TabsContent>

        <TabsContent value="contactos">
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", margin: "0 0 12px" }}>
            <div className="field" style={{ margin: 0, flex: "1 1 200px" }}>
              <Label htmlFor="f-campana">Campaña</Label>
              <select id="f-campana" className="input" value={filtroCampana} onChange={(e) => setFiltroCampana(e.target.value)}>
                <option value="">Todas</option>
                {datos.campanas.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="field" style={{ margin: 0, flex: "1 1 200px" }}>
              <Label htmlFor="f-estado">Estado</Label>
              <select id="f-estado" className="input" value={filtroEstado} onChange={(e) => setFiltroEstado(e.target.value)}>
                <option value="">Todos</option>
                <option value="abierto">En seguimiento (no agendaron)</option>
                <option value="convertido">Agendaron</option>
                <option value="cerrado">Cerrados</option>
              </select>
            </div>
          </div>
          {contactos.length === 0 ? (
            <EmptyState icon={Megaphone} title="Sin contactos" description="Cuando alguien escriba por una campaña va a aparecer acá." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Persona</TableHead>
                  <TableHead>Campaña</TableHead>
                  <TableHead>Llegó</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contactos.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      {c.patientName ?? "Sin nombre todavía"}
                      <div className="muted" style={{ fontSize: "0.85em" }}>{c.patientPhone}{c.isNewContact ? " · contacto nuevo" : ""}</div>
                    </TableCell>
                    <TableCell>
                      {c.campaignName}
                      <div className="muted" style={{ fontSize: "0.85em" }}>{c.triggerKind === "anuncio" ? "Anuncio de Meta" : c.triggerKind === "asistente" ? "Lo reconoció el asistente" : "Frase en el mensaje"}</div>
                    </TableCell>
                    <TableCell>{formatDateTime(c.firstMessageAt)}</TableCell>
                    <TableCell>
                      <Badge variant={c.status === "convertido" ? "success" : c.status === "abierto" ? "secondary" : "outline"}>{estadoDelContacto(c)}</Badge>
                    </TableCell>
                    <TableCell style={{ textAlign: "right" }}>
                      {puedeEditar && c.status === "abierto" && (
                        <Button variant="outline" size="sm" onClick={() => cerrarContacto(c)}>Cerrar seguimiento</Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>
      </Tabs>

      {editando && (
        <FormularioDeCampana
          clinicId={clinicId}
          campana={editando === "nueva" ? null : editando}
          opciones={datos.opciones}
          onCerrar={() => setEditando(null)}
          onGuardada={async () => {
            setEditando(null);
            await cargar();
          }}
        />
      )}
    </PageContainer>
  );
}

function FormularioDeCampana(props: {
  clinicId: string;
  campana: Campana | null;
  opciones: OpcionesDeCampana;
  onCerrar: () => void;
  onGuardada: () => Promise<void>;
}) {
  const { campana, opciones } = props;
  const [name, setName] = useState(campana?.name ?? "");
  const [channel, setChannel] = useState(campana?.channel ?? "");
  const [description, setDescription] = useState(campana?.description ?? "");
  const [startsOn, setStartsOn] = useState(campana?.startsOn ?? "");
  const [endsOn, setEndsOn] = useState(campana?.endsOn ?? "");
  const [serviceId, setServiceId] = useState(campana?.serviceId ?? "");
  const [extras, setExtras] = useState<string[]>(campana?.extraProfessionals.map((p) => p.id) ?? []);
  const [formatos, setFormatos] = useState<FormatoDeCampana[]>(campana?.triggers ?? [{ kind: "texto", value: "" }]);
  const [intentos, setIntentos] = useState(String(campana?.followUpMaxAttempts ?? 2));
  const [despues, setDespues] = useState(String(campana?.followUpAfterHours ?? 24));
  const [cada, setCada] = useState(String(campana?.followUpIntervalHours ?? 48));
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const servicio = opciones.servicios.find((s) => s.id === serviceId) ?? null;
  const delCatalogo = servicio ? opciones.profesionales.filter((p) => servicio.profesionalIds.includes(p.id)) : [];
  // Los que se pueden SUMAR: los que el catálogo todavía no asigna al servicio.
  const sumables = opciones.profesionales.filter((p) => !servicio?.profesionalIds.includes(p.id));

  // El servicio de la promoción tiene que tener a alguien que lo atienda: del catálogo o sumado en la campaña.
  const sinQuienAtienda = !!servicio && delCatalogo.length === 0 && extras.filter((id) => sumables.some((p) => p.id === id)).length === 0;

  const formatosCargados = formatos.filter((f) => f.value.trim());

  async function guardar(e: FormEvent) {
    e.preventDefault();
    if (formatosCargados.length === 0) {
      setError("Agrega al menos un formato: la frase que trae el mensaje o el id del anuncio de Meta.");
      return;
    }
    if (!serviceId) {
      setError("Elige el servicio de la promoción: es obligatorio.");
      return;
    }
    if (sinQuienAtienda) {
      setError("El servicio no tiene ningún profesional: asígnalo en Servicios o suma uno en la campaña.");
      return;
    }
    setGuardando(true);
    setError(null);
    const body = {
      name, channel, description, startsOn: startsOn || null, endsOn: endsOn || null,
      serviceId: serviceId || null,
      extraProfessionalIds: serviceId ? extras.filter((id) => sumables.some((p) => p.id === id)) : [],
      triggers: formatosCargados,
      followUpMaxAttempts: Number(intentos), followUpAfterHours: Number(despues), followUpIntervalHours: Number(cada),
    };
    try {
      if (campana) await api.put(`/dashboard/clinics/${props.clinicId}/campaigns/${campana.id}`, body);
      else await api.post(`/dashboard/clinics/${props.clinicId}/campaigns`, body);
      toast.success(campana ? "Campaña guardada." : "Campaña creada.");
      await props.onGuardada();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo guardar la campaña");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Dialog open onOpenChange={(abierto) => !abierto && props.onCerrar()}>
      <DialogContent style={{ maxWidth: 680, maxHeight: "90vh", overflowY: "auto" }}>
        <DialogHeader>
          <DialogTitle>{campana ? `Editar ${campana.name}` : "Nueva campaña"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={guardar}>
          <div className="field">
            <Label htmlFor="c-name">Nombre</Label>
            <Input id="c-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Limpieza de verano" required />
          </div>
          <div className="field">
            <Label htmlFor="c-channel">Canal (opcional)</Label>
            <Input id="c-channel" value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="Instagram, Flyer, Radio…" />
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div className="field" style={{ flex: "1 1 180px" }}>
              <Label htmlFor="c-desde">Empieza (opcional)</Label>
              <DateField id="c-desde" value={startsOn} onChange={setStartsOn} />
            </div>
            <div className="field" style={{ flex: "1 1 180px" }}>
              <Label htmlFor="c-hasta">Termina (opcional)</Label>
              <DateField id="c-hasta" value={endsOn} onChange={setEndsOn} />
            </div>
          </div>
          <p className="muted" style={{ margin: "-4px 0 12px", fontSize: "0.9em" }}>
            Fuera de esas fechas el contacto igual se cuenta, pero el asistente ya no ofrece la promoción.
          </p>
          <div className="field">
            <Label htmlFor="c-desc">La promoción, tal como se la puede contar el asistente</Label>
            <Textarea id="c-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Ej. Limpieza + control con 20 % de descuento hasta fin de mes." />
            <p className="muted" style={{ margin: "4px 0 0", fontSize: "0.9em" }}>
              El asistente cuenta solo lo que escribas acá: no inventa precios ni condiciones. Si lo dejas vacío, no menciona detalles.
            </p>
          </div>

          <h3 style={{ marginBottom: 4 }}>Cómo reconocemos que escriben por esta campaña (obligatorio)</h3>
          <p className="muted" style={{ marginTop: 0, fontSize: "0.9em" }}>
            Hace falta al menos uno: sin un formato nadie puede ser reconocido como llegado por la campaña, aunque escriba "vengo por la
            promoción". Puede haber varios formatos. <strong>Frase en el mensaje</strong>: va en el texto prellenado del link o QR (ej. "Hola, quiero la promo de verano");
            alcanza con que el mensaje la contenga. <strong>Anuncio de Meta</strong>: el id del anuncio Click-to-WhatsApp, que Meta manda solo.
          </p>
          {formatos.map((f, i) => (
            <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
              <select
                className="input"
                aria-label="Tipo de formato"
                style={{ flex: "0 0 190px" }}
                value={f.kind}
                onChange={(e) => setFormatos((fs) => fs.map((x, j) => (j === i ? { ...x, kind: e.target.value as FormatoDeCampana["kind"] } : x)))}
              >
                <option value="texto">Frase en el mensaje</option>
                <option value="anuncio">Anuncio de Meta (id)</option>
              </select>
              <Input
                aria-label="Valor del formato"
                value={f.value}
                placeholder={f.kind === "texto" ? "promo de verano" : "120210000000000"}
                onChange={(e) => setFormatos((fs) => fs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
              />
              <Button type="button" variant="outline" size="sm" aria-label="Quitar formato" onClick={() => setFormatos((fs) => fs.filter((_, j) => j !== i))}>
                <Trash2 size={14} />
              </Button>
            </div>
          ))}
          {formatos.some((f) => f.kind === "texto" && f.value.trim().split(/\s+/).length > PALABRAS_MAXIMAS_AVISO) && (
            <p className="error-text" role="note" style={{ fontSize: "0.9em" }}>
              Una de las frases es larga. El mensaje del paciente tiene que contenerla <strong>entera</strong>, y casi nunca escribe lo mismo. Usa lo más
              corto y propio de la campaña (por ejemplo «promoción de implantes») y, si hace falta, agrega varios formatos cortos.
            </p>
          )}
          <Button type="button" variant="outline" size="sm" onClick={() => setFormatos((fs) => [...fs, { kind: "texto", value: "" }])}>
            <Plus size={14} /> Agregar formato
          </Button>

          <h3 style={{ marginBottom: 4 }}>Servicio y profesionales</h3>
          <p className="muted" style={{ marginTop: 0, fontSize: "0.9em" }}>
            Es obligatorio: le dice al asistente qué promocionar y con qué profesional agendar. Elige el servicio de la promoción; sus
            profesionales ya salen del catálogo, y puedes sumar otros solo para esta campaña.
          </p>
          {opciones.servicios.length === 0 ? (
            <p className="error-text">
              La clínica todavía no tiene servicios cargados. Crea primero el servicio en "Servicios" y después vuelve a armar la campaña.
            </p>
          ) : (
            <div className="field">
              <Label htmlFor="c-servicio">Servicio de la promoción (obligatorio)</Label>
              <select
                id="c-servicio"
                className="input"
                required
                value={serviceId}
                onChange={(e) => { setServiceId(e.target.value); setExtras([]); }}
              >
                <option value="" disabled>Elige un servicio…</option>
                {opciones.servicios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
          {servicio && (
            <>
              <p className="muted" style={{ fontSize: "0.9em" }}>
                Lo atienden hoy, según el catálogo: <strong>{delCatalogo.length ? delCatalogo.map((p) => p.name).join(", ") : "nadie todavía"}</strong>.
              </p>
              {sinQuienAtienda && (
                <p className="error-text" role="alert">
                  Este servicio no tiene ningún profesional asignado. Suma al menos uno acá abajo, o asígnalo en "Servicios": sin alguien que lo
                  atienda, el asistente no podría agendarlo.
                </p>
              )}
              {sumables.length > 0 && (
                <div className="field">
                  <Label>Sumar profesionales solo para esta promoción (opcional)</Label>
                  <p className="muted" style={{ margin: "0 0 6px", fontSize: "0.9em" }}>
                    Podrán dar este servicio únicamente a quienes lleguen por esta campaña, aunque el catálogo no se lo asigne. Se suman a los de arriba.
                  </p>
                  {sumables.map((p) => (
                    <div key={p.id} className="checkbox-field">
                      <Checkbox
                        id={`c-extra-${p.id}`}
                        checked={extras.includes(p.id)}
                        onCheckedChange={(v) => setExtras((xs) => (v === true ? [...xs, p.id] : xs.filter((x) => x !== p.id)))}
                      />
                      <Label htmlFor={`c-extra-${p.id}`}>{p.name}</Label>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          <h3 style={{ marginBottom: 4 }}>Seguimiento de quienes preguntan y no agendan</h3>
          <p className="muted" style={{ marginTop: 0, fontSize: "0.9em" }}>
            Se les escribe por una plantilla de WhatsApp, con un tope para no insistir por siempre. Con 0 intentos no se hace seguimiento.
            Solo sale si el administrador de la plataforma lo habilitó para la clínica.
          </p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div className="field" style={{ flex: "1 1 150px" }}>
              <Label htmlFor="c-intentos">Intentos (0 a 5)</Label>
              <Input id="c-intentos" type="number" min={0} max={5} step={1} value={intentos} onChange={(e) => setIntentos(e.target.value)} />
            </div>
            <div className="field" style={{ flex: "1 1 150px" }}>
              <Label htmlFor="c-despues">Primero, a las (horas)</Label>
              <Input id="c-despues" type="number" min={1} max={720} step={1} value={despues} onChange={(e) => setDespues(e.target.value)} />
            </div>
            <div className="field" style={{ flex: "1 1 150px" }}>
              <Label htmlFor="c-cada">Después, cada (horas)</Label>
              <Input id="c-cada" type="number" min={1} max={720} step={1} value={cada} onChange={(e) => setCada(e.target.value)} />
            </div>
          </div>

          {error && <p className="error-text">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onCerrar}>Cancelar</Button>
            <Button type="submit" disabled={guardando || !serviceId || sinQuienAtienda || formatosCargados.length === 0}>{guardando ? "Guardando…" : "Guardar"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
