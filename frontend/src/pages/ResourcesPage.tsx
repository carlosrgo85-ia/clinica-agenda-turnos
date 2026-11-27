import { useEffect, useState, type FormEvent } from "react";
import { Stethoscope } from "lucide-react";
import { toast } from "sonner";
import { useAuth, useEffectiveClinicId } from "../auth/AuthContext";
import { ClinicScopeRequired } from "../components/shell/ClinicScopeRequired";
import { api, ApiError } from "../api/client";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { Checkbox } from "../components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Badge } from "../components/ui/badge";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { PageSkeleton } from "../components/ui/skeleton";
import { CheckList } from "../components/CheckList";

/** Los 11 colores de evento de Google Calendar: id (`colorId`), nombre y el tono aproximado. */
const COLORES_GOOGLE = [
  { id: "1", label: "Lavanda", hex: "#7986cb" },
  { id: "2", label: "Salvia", hex: "#33b679" },
  { id: "3", label: "Uva", hex: "#8e24aa" },
  { id: "4", label: "Flamenco", hex: "#e67c73" },
  { id: "5", label: "Banana", hex: "#f6bf26" },
  { id: "6", label: "Mandarina", hex: "#f4511e" },
  { id: "7", label: "Pavo real", hex: "#039be5" },
  { id: "8", label: "Grafito", hex: "#616161" },
  { id: "9", label: "Arándano", hex: "#3f51b5" },
  { id: "10", label: "Albahaca", hex: "#0b8043" },
  { id: "11", label: "Tomate", hex: "#d50000" },
];
const SIN_COLOR = "__sin_color__";

interface Titulo {
  id: string;
  name: string;
}

interface Profesional {
  id: string;
  name: string;
  titleId: string | null;
  /** El nombre del título, ya resuelto por el backend. */
  title: string | null;
  active: boolean;
  preferredRoomId: string | null;
  preferredRoomName: string | null;
  contactEmail: string | null;
  whatsappPhone: string | null;
  notifyByEmail: boolean;
  notifyByWhatsapp: boolean;
  /** De qué avisa (además del canal): citas nuevas, cambios y cancelaciones. */
  notifyOnCreate: boolean;
  notifyOnChange: boolean;
  notifyOnCancel: boolean;
  /** Color con el que marca sus citas en un calendario compartido (colorId de Google). */
  calendarColorId: string | null;
  /** Los servicios que realiza. Vacío = no hace nada: no se le agenda. */
  servicios: Array<{ id: string; name: string; active: boolean }>;
  turnosFuturos: number;
}

interface Espacio {
  id: string;
  name: string;
  active: boolean;
  turnosFuturos: number;
}

interface Equipo extends Espacio {
  type: string;
  inactiveReason: string | null;
}

interface Recursos {
  /** Los servicios activos del catálogo. Vacío = la clínica no tiene catálogo. */
  serviciosDisponibles: Array<{ id: string; name: string }>;
  /** Los títulos que la plataforma le habilitó a esta clínica. */
  titulos: Titulo[];
  profesionales: Profesional[];
  espacios: Espacio[];
  equipos: Equipo[];
}

/** "Sin espacio fijo" no puede ser "": Radix lo usa para "sin selección". */
const SIN_ESPACIO = "__ninguno__";
/** Mismo motivo: "sin título" necesita un valor propio, no el string vacío. */
const SIN_TITULO = "__sin_titulo__";

/**
 * Lo que la clínica tiene para atender: profesionales, espacios y equipos.
 *
 * Hasta acá no había forma de cargarlos desde la interfaz —solo el script de
 * alta o SQL directo—, así que una clínica que contrataba un profesional no
 * podía darlo de alta, y una sin ningún espacio veía rechazar todos los
 * turnos.
 *
 * **Nada se borra, se desactiva**: los turnos históricos los referencian, y
 * borrarlos dejaría la agenda pasada sin poder explicarse.
 */
export function ResourcesPage() {
  const clinicId = useEffectiveClinicId();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("recursos.editar");

  const [data, setData] = useState<Recursos | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [nuevoProfesional, setNuevoProfesional] = useState("");
  const [tituloDelNuevo, setTituloDelNuevo] = useState(SIN_TITULO);
  const [espacioDelNuevo, setEspacioDelNuevo] = useState(SIN_ESPACIO);
  const [serviciosDelNuevo, setServiciosDelNuevo] = useState<string[]>([]);
  const [nuevoEspacio, setNuevoEspacio] = useState("");
  const [nuevoEquipo, setNuevoEquipo] = useState({ name: "", type: "" });
  const [editando, setEditando] = useState<Profesional | null>(null);
  // El equipo que se está por dar de baja: primero se pide el motivo.
  const [dandoDeBaja, setDandoDeBaja] = useState<Equipo | null>(null);
  const [motivoDeBaja, setMotivoDeBaja] = useState("");

  async function load() {
    if (!clinicId) return;
    setLoading(true);
    setError(null);
    try {
      setData(await api.get<Recursos>(`/dashboard/clinics/${clinicId}/resources`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudieron cargar los recursos");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinicId]);

  if (!clinicId) return <ClinicScopeRequired />;
  if (loading) return <PageSkeleton />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  const espaciosActivos = (data?.espacios ?? []).filter((e) => e.active);
  const titulos = data?.titulos ?? [];
  const catalogo = data?.serviciosDisponibles ?? [];
  const serviciosItems = catalogo.map((sv) => ({ id: sv.id, label: sv.name }));

  async function guardar(accion: () => Promise<unknown>, exito: string) {
    try {
      await accion();
      toast.success(exito);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo guardar");
    }
  }

  function crearProfesional(e: FormEvent) {
    e.preventDefault();
    const name = nuevoProfesional.trim();
    if (!name) return;
    // Sin servicios "no hace nada": con catálogo se exige al menos uno. El
    // backend lo valida igual; esto evita el viaje para avisarlo.
    if (catalogo.length > 0 && serviciosDelNuevo.length === 0) {
      toast.error("Elige al menos un servicio que realice este profesional.");
      return;
    }
    guardar(
      () =>
        api.post(`/dashboard/clinics/${clinicId}/professionals`, {
          name,
          titleId: tituloDelNuevo === SIN_TITULO ? null : tituloDelNuevo,
          preferredRoomId: espacioDelNuevo === SIN_ESPACIO ? null : espacioDelNuevo,
          serviceIds: serviciosDelNuevo,
        }),
      `"${name}" agregado.`
    ).then(() => {
      setNuevoProfesional("");
      setTituloDelNuevo(SIN_TITULO);
      setEspacioDelNuevo(SIN_ESPACIO);
      setServiciosDelNuevo([]);
    });
  }

  function crearEspacio(e: FormEvent) {
    e.preventDefault();
    const name = nuevoEspacio.trim();
    if (!name) return;
    guardar(
      () => api.post(`/dashboard/clinics/${clinicId}/rooms`, { name }),
      `"${name}" agregado.`
    ).then(() => setNuevoEspacio(""));
  }

  function crearEquipo(e: FormEvent) {
    e.preventDefault();
    const name = nuevoEquipo.name.trim();
    const type = nuevoEquipo.type.trim();
    if (!name || !type) return;
    guardar(
      () => api.post(`/dashboard/clinics/${clinicId}/resources`, { name, type }),
      `"${name}" agregado.`
    ).then(() => setNuevoEquipo({ name: "", type: "" }));
  }

  return (
    <div>
      <h1>Recursos</h1>
      <p className="muted">
        Con esto atiende la clínica. Un recurso desactivado deja de asignarse a citas nuevas, pero
        los que ya tiene agendados no se tocan.
      </p>

      <Tabs defaultValue="profesionales">
        <TabsList>
          <TabsTrigger value="profesionales">Profesionales</TabsTrigger>
          <TabsTrigger value="espacios">Espacios</TabsTrigger>
          <TabsTrigger value="equipos">Equipos críticos</TabsTrigger>
        </TabsList>

        <TabsContent value="profesionales">
          {canEdit && (
            <form
              className="card"
              onSubmit={crearProfesional}
              style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}
            >
              <div className="field" style={{ marginBottom: 0, flex: "1 1 160px" }}>
                <Label htmlFor="prof-titulo">Título</Label>
                <Select value={tituloDelNuevo} onValueChange={(v) => v && setTituloDelNuevo(v)}>
                  <SelectTrigger id="prof-titulo">
                    <SelectValue>
                      {tituloDelNuevo === SIN_TITULO
                        ? "Sin título"
                        : titulos.find((t) => t.id === tituloDelNuevo)?.name}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SIN_TITULO}>Sin título</SelectItem>
                    {titulos.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="field" style={{ marginBottom: 0, flex: "1 1 220px" }}>
                <Label htmlFor="prof-nombre">Nombre</Label>
                <Input
                  id="prof-nombre"
                  placeholder="Ej. Gómez"
                  value={nuevoProfesional}
                  onChange={(e) => setNuevoProfesional(e.target.value)}
                />
              </div>
              <div className="field" style={{ marginBottom: 0, flex: "1 1 200px" }}>
                <Label htmlFor="prof-espacio">Espacio habitual</Label>
                <Select value={espacioDelNuevo} onValueChange={(v) => v && setEspacioDelNuevo(v)}>
                  <SelectTrigger id="prof-espacio">
                    <SelectValue>
                      {espacioDelNuevo === SIN_ESPACIO
                        ? "Cualquiera disponible"
                        : espaciosActivos.find((e) => e.id === espacioDelNuevo)?.name}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SIN_ESPACIO}>Cualquiera disponible</SelectItem>
                    {espaciosActivos.map((e) => (
                      <SelectItem key={e.id} value={e.id}>
                        {e.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {catalogo.length > 0 && (
                <div className="field" style={{ marginBottom: 0, flex: "1 1 100%" }}>
                  <Label>Servicios que realiza (al menos uno)</Label>
                  <CheckList
                    idPrefix="nuevo-prof-serv"
                    items={serviciosItems}
                    value={serviciosDelNuevo}
                    onChange={setServiciosDelNuevo}
                  />
                </div>
              )}
              <Button type="submit">Agregar</Button>
            </form>
          )}

          <p className="muted" style={{ fontSize: "0.85em" }}>
            El espacio habitual es una preferencia, no una reserva: si está ocupado a esa hora se le
            asigna otro libre y la cita queda marcado para que se sepa por qué.
            {titulos.length === 0 && (
              <>
                {" "}
                Esta clínica todavía no tiene títulos habilitados —los habilita el equipo de la
                plataforma—, así que los profesionales se cargan sin título.
              </>
            )}
          </p>

          {(data?.profesionales ?? []).length === 0 ? (
            <EmptyState
              icon={Stethoscope}
              title="Todavía no hay profesionales"
              description="Sin al menos uno cargado no se puede agendar ninguna cita."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Servicios</TableHead>
                  <TableHead>Espacio habitual</TableHead>
                  <TableHead>Avisos</TableHead>
                  <TableHead>Citas por delante</TableHead>
                  <TableHead>Activo</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.profesionales ?? []).map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>{p.title ? `${p.title} ${p.name}` : p.name}</TableCell>
                    <TableCell>
                      {p.servicios.length > 0 ? (
                        p.servicios.map((sv) => (
                          <Badge key={sv.id} variant="outline" style={{ marginRight: 4 }}>
                            {sv.name}
                          </Badge>
                        ))
                      ) : catalogo.length > 0 ? (
                        <span className="error-text">
                          Ninguno: no se le agenda nada
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>
                      <Select
                        value={p.preferredRoomId ?? SIN_ESPACIO}
                        disabled={!canEdit}
                        onValueChange={(v) =>
                          v &&
                          guardar(
                            () =>
                              api.put(`/dashboard/clinics/${clinicId}/professionals/${p.id}`, {
                                preferredRoomId: v === SIN_ESPACIO ? null : v,
                              }),
                            "Espacio habitual actualizado."
                          )
                        }
                      >
                        <SelectTrigger>
                          <SelectValue>
                            {p.preferredRoomName ?? "Cualquiera disponible"}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={SIN_ESPACIO}>Cualquiera disponible</SelectItem>
                          {espaciosActivos.map((e) => (
                            <SelectItem key={e.id} value={e.id}>
                              {e.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      {p.notifyByEmail || p.notifyByWhatsapp ? (
                        <>
                          {p.notifyByEmail && <Badge variant="outline">Email</Badge>}{" "}
                          {p.notifyByWhatsapp && <Badge variant="outline">WhatsApp</Badge>}
                        </>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>
                      {p.turnosFuturos > 0 ? <Badge variant="outline">{p.turnosFuturos}</Badge> : "—"}
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={p.active}
                        disabled={!canEdit}
                        onCheckedChange={(active) =>
                          guardar(
                            () =>
                              api.put(`/dashboard/clinics/${clinicId}/professionals/${p.id}`, {
                                active,
                              }),
                            active ? `"${p.name}" activado.` : `"${p.name}" desactivado.`
                          )
                        }
                      />
                    </TableCell>
                    <TableCell>
                      {canEdit && (
                        <Button variant="outline" size="sm" onClick={() => setEditando(p)}>
                          Editar
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        <TabsContent value="espacios">
          {canEdit && (
            <form
              className="card"
              onSubmit={crearEspacio}
              style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}
            >
              <div className="field" style={{ marginBottom: 0, flex: "1 1 260px" }}>
                <Label htmlFor="espacio-nombre">Nombre</Label>
                <Input
                  id="espacio-nombre"
                  placeholder="Ej. Consultorio 3"
                  value={nuevoEspacio}
                  onChange={(e) => setNuevoEspacio(e.target.value)}
                />
              </div>
              <Button type="submit">Agregar</Button>
            </form>
          )}

          <p className="muted" style={{ fontSize: "0.85em" }}>
            Los consultorios o salas donde se atiende. Sin ninguno cargado, todos las citas se
            rechazan por falta de espacio.
          </p>

          <ListaSimple
            items={data?.espacios ?? []}
            vacio="Todavía no hay espacios"
            descripcionVacio="Sin al menos uno cargado no se puede agendar ninguna cita."
            canEdit={canEdit}
            onToggle={(id, active, name) =>
              guardar(
                () => api.put(`/dashboard/clinics/${clinicId}/rooms/${id}`, { active }),
                active ? `"${name}" activado.` : `"${name}" desactivado.`
              )
            }
          />
        </TabsContent>

        <TabsContent value="equipos">
          {canEdit && (
            <form
              className="card"
              onSubmit={crearEquipo}
              style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}
            >
              <div className="field" style={{ marginBottom: 0, flex: "1 1 220px" }}>
                <Label htmlFor="equipo-nombre">Nombre</Label>
                <Input
                  id="equipo-nombre"
                  placeholder="Ej. Láser diodo #1"
                  value={nuevoEquipo.name}
                  onChange={(e) => setNuevoEquipo((f) => ({ ...f, name: e.target.value }))}
                />
              </div>
              <div className="field" style={{ marginBottom: 0, flex: "1 1 200px" }}>
                <Label htmlFor="equipo-tipo">Tipo</Label>
                <Input
                  id="equipo-tipo"
                  placeholder="Ej. laser_diodo"
                  value={nuevoEquipo.type}
                  onChange={(e) => setNuevoEquipo((f) => ({ ...f, type: e.target.value }))}
                />
              </div>
              <Button type="submit">Agregar</Button>
            </form>
          )}

          <p className="muted" style={{ fontSize: "0.85em" }}>
            Los equipos de los que depende un servicio y que la clínica <strong>no tiene
            repetidos</strong>: un motor de implantes, un láser. Cargarlos aquí agrega una
            validación más al agendar — si el único motor ya está ocupado a esa hora, no se ofrece
            ni se acepta otra colocación de implante, aunque el profesional y el consultorio estén
            libres.
            <br />
            El <strong>tipo</strong> agrupa las unidades intercambiables (dos motores iguales
            comparten tipo) y es lo que cada servicio elige en "Equipo requerido". Un servicio que
            pida un tipo que no existe nunca va a tener horarios disponibles. Si ningún servicio
            depende de un equipo escaso, esto queda vacío.
          </p>

          {(data?.equipos ?? []).length === 0 ? (
            <EmptyState
              icon={Stethoscope}
              title="Todavía no hay equipos críticos"
              description="Solo hace falta si algún servicio depende de un equipo que la clínica no tiene repetido."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead>Citas por delante</TableHead>
                  <TableHead>En servicio</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.equipos ?? []).map((eq) => (
                  <TableRow key={eq.id}>
                    <TableCell>{eq.name}</TableCell>
                    <TableCell>
                      <code>{eq.type}</code>
                    </TableCell>
                    <TableCell>
                      {eq.active ? (
                        <Badge variant="outline">En servicio</Badge>
                      ) : (
                        <>
                          <Badge variant="destructive">Fuera de servicio</Badge>
                          <div className="muted" style={{ fontSize: "0.85em" }}>
                            {eq.inactiveReason ?? "sin motivo cargado"}
                          </div>
                        </>
                      )}
                    </TableCell>
                    <TableCell>
                      {eq.turnosFuturos > 0 ? (
                        <Badge variant="outline">{eq.turnosFuturos}</Badge>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={eq.active}
                        disabled={!canEdit}
                        onCheckedChange={(active) => {
                          // Darlo de baja pide el motivo; reactivarlo es directo.
                          if (!active) {
                            setDandoDeBaja(eq);
                            setMotivoDeBaja("");
                            return;
                          }
                          guardar(
                            () =>
                              api.put(`/dashboard/clinics/${clinicId}/resources/${eq.id}`, {
                                active: true,
                              }),
                            `"${eq.name}" volvió a estar en servicio.`
                          );
                        }}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>
      </Tabs>

      {dandoDeBaja && (
        <Dialog open onOpenChange={(abierto) => !abierto && setDandoDeBaja(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Dar de baja "{dandoDeBaja.name}"</DialogTitle>
            </DialogHeader>

            <p className="muted">
              Mientras esté fuera de servicio, <strong>ningún servicio que lo requiera se va a
              poder agendar</strong>. Si un paciente pide uno, el asistente no le va a ofrecer
              horarios: le avisa que alguien de la clínica lo va a contactar y la conversación
              aparece en "Por atender" con este motivo.
            </p>

            <div className="field">
              <Label htmlFor="motivo-baja">Motivo</Label>
              <Input
                id="motivo-baja"
                placeholder="Ej. Motor dañado, en reparación"
                value={motivoDeBaja}
                onChange={(e) => setMotivoDeBaja(e.target.value)}
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDandoDeBaja(null)}>
                Cancelar
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={async () => {
                  const eq = dandoDeBaja;
                  setDandoDeBaja(null);
                  await guardar(
                    () =>
                      api.put(`/dashboard/clinics/${clinicId}/resources/${eq.id}`, {
                        active: false,
                        inactiveReason: motivoDeBaja,
                      }),
                    `"${eq.name}" quedó fuera de servicio.`
                  );
                }}
              >
                Dar de baja
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {editando && (
        <EditarProfesional
          profesional={editando}
          espacios={espaciosActivos}
          titulos={titulos}
          servicios={serviciosItems}
          onCerrar={() => setEditando(null)}
          onGuardar={async (cambios) => {
            await guardar(
              () =>
                api.put(`/dashboard/clinics/${clinicId}/professionals/${editando.id}`, cambios),
              "Datos actualizados."
            );
            setEditando(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Los datos completos de un profesional.
 *
 * En un diálogo y no inline en la tabla: son siete campos, y dos de ellos
 * (los avisos) necesitan la explicación de al lado para que no se activen
 * sin entender qué implican.
 */
function EditarProfesional(props: {
  profesional: Profesional;
  espacios: Espacio[];
  titulos: Titulo[];
  /** El catálogo asignable. Vacío = sin catálogo, no se pide nada. */
  servicios: Array<{ id: string; label: string }>;
  onCerrar: () => void;
  onGuardar: (cambios: Record<string, unknown>) => void;
}) {
  const [serviceIds, setServiceIds] = useState<string[]>(
    props.profesional.servicios.map((sv) => sv.id)
  );
  const [errorServicios, setErrorServicios] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: props.profesional.name,
    titleId: props.profesional.titleId ?? SIN_TITULO,
    preferredRoomId: props.profesional.preferredRoomId ?? SIN_ESPACIO,
    contactEmail: props.profesional.contactEmail ?? "",
    whatsappPhone: props.profesional.whatsappPhone ?? "",
    notifyByEmail: props.profesional.notifyByEmail,
    notifyByWhatsapp: props.profesional.notifyByWhatsapp,
    notifyOnCreate: props.profesional.notifyOnCreate,
    notifyOnChange: props.profesional.notifyOnChange,
    notifyOnCancel: props.profesional.notifyOnCancel,
    calendarColorId: props.profesional.calendarColorId ?? SIN_COLOR,
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    if (props.servicios.length > 0 && serviceIds.length === 0) {
      setErrorServicios("Un profesional necesita al menos un servicio: sin ninguno no se le agenda nada.");
      return;
    }
    props.onGuardar({
      ...(props.servicios.length > 0 ? { serviceIds } : {}),
      name: form.name.trim(),
      titleId: form.titleId === SIN_TITULO ? null : form.titleId,
      preferredRoomId: form.preferredRoomId === SIN_ESPACIO ? null : form.preferredRoomId,
      contactEmail: form.contactEmail.trim(),
      whatsappPhone: form.whatsappPhone.trim(),
      notifyByEmail: form.notifyByEmail,
      notifyByWhatsapp: form.notifyByWhatsapp,
      notifyOnCreate: form.notifyOnCreate,
      notifyOnChange: form.notifyOnChange,
      notifyOnCancel: form.notifyOnCancel,
      calendarColorId: form.calendarColorId === SIN_COLOR ? null : form.calendarColorId,
    });
  }

  return (
    <Dialog open onOpenChange={(abierto) => !abierto && props.onCerrar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {props.profesional.title
              ? `${props.profesional.title} ${props.profesional.name}`
              : props.profesional.name}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={submit}>
          <div className="field">
            <Label htmlFor="edit-titulo">Título</Label>
            <Select
              value={form.titleId}
              onValueChange={(v) => v && setForm((f) => ({ ...f, titleId: v }))}
            >
              <SelectTrigger id="edit-titulo">
                <SelectValue>
                  {form.titleId === SIN_TITULO
                    ? "Sin título"
                    : props.titulos.find((t) => t.id === form.titleId)?.name ??
                      props.profesional.title}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SIN_TITULO}>Sin título</SelectItem>
                {props.titulos.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="field">
            <Label htmlFor="edit-nombre">Nombre</Label>
            <Input
              id="edit-nombre"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>

          <div className="field">
            <Label htmlFor="edit-espacio">Espacio habitual</Label>
            <Select
              value={form.preferredRoomId}
              onValueChange={(v) => v && setForm((f) => ({ ...f, preferredRoomId: v }))}
            >
              <SelectTrigger id="edit-espacio">
                <SelectValue>
                  {form.preferredRoomId === SIN_ESPACIO
                    ? "Cualquiera disponible"
                    : props.espacios.find((e) => e.id === form.preferredRoomId)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SIN_ESPACIO}>Cualquiera disponible</SelectItem>
                {props.espacios.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {props.servicios.length > 0 && (
            <div className="field">
              <Label>Servicios que realiza</Label>
              <CheckList
                idPrefix="edit-prof-serv"
                items={props.servicios}
                value={serviceIds}
                onChange={(v) => {
                  setServiceIds(v);
                  setErrorServicios(null);
                }}
              />
              {errorServicios && <p className="error-text">{errorServicios}</p>}
            </div>
          )}

          <h4>Calendario compartido</h4>
          <div className="field">
            <Label htmlFor="edit-color">Color de sus citas en el calendario</Label>
            <Select
              value={form.calendarColorId}
              onValueChange={(v) => v && setForm((f) => ({ ...f, calendarColorId: v }))}
            >
              <SelectTrigger id="edit-color">
                <SelectValue>
                  {form.calendarColorId === SIN_COLOR
                    ? "No usar el color"
                    : COLORES_GOOGLE.find((c) => c.id === form.calendarColorId)?.label}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SIN_COLOR}>No usar el color</SelectItem>
                {COLORES_GOOGLE.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    <span
                      aria-hidden
                      style={{
                        display: "inline-block",
                        width: 10,
                        height: 10,
                        borderRadius: "50%",
                        background: c.hex,
                        marginRight: 8,
                      }}
                    />
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="muted" style={{ fontSize: "0.85em", marginTop: 4 }}>
              Solo para clínicas que llevan a todos sus profesionales en un mismo calendario de Google. Un evento
              de ese calendario que Pontic no creó se atribuye a este profesional si (a) su nombre aparece en el
              título, (b) tiene este color o (c) su correo de arriba está entre los invitados. Si ninguna pista
              coincide, el evento bloquea a todo el equipo. De esos eventos solo se guarda el horario.
            </p>
          </div>

          <h4>Avisos de sus citas</h4>
          <p className="muted" style={{ marginTop: -8, fontSize: "0.85em" }}>
            Opcionales y apagados por default. Sirven para enterarse sin tener que mirar la agenda. Sin ningún medio marcado no
            se le avisa nada.
          </p>

          <div className="field">
            <Label htmlFor="edit-email">Email</Label>
            <Input
              id="edit-email"
              type="email"
              value={form.contactEmail}
              onChange={(e) => setForm((f) => ({ ...f, contactEmail: e.target.value }))}
            />
            <div className="checkbox-field" style={{ marginTop: 6 }}>
              <Checkbox
                id="edit-notif-email"
                checked={form.notifyByEmail}
                onCheckedChange={(v) => setForm((f) => ({ ...f, notifyByEmail: v === true }))}
              />
              <Label htmlFor="edit-notif-email">Avisarle por email</Label>
            </div>
          </div>

          <div className="field">
            <Label htmlFor="edit-wsp">WhatsApp</Label>
            <Input
              id="edit-wsp"
              placeholder="Ej. 5215512345678"
              value={form.whatsappPhone}
              onChange={(e) => setForm((f) => ({ ...f, whatsappPhone: e.target.value }))}
            />
            <div className="checkbox-field" style={{ marginTop: 6 }}>
              <Checkbox
                id="edit-notif-wsp"
                checked={form.notifyByWhatsapp}
                onCheckedChange={(v) => setForm((f) => ({ ...f, notifyByWhatsapp: v === true }))}
              />
              <Label htmlFor="edit-notif-wsp">Avisarle por WhatsApp</Label>
            </div>
            <p className="muted" style={{ fontSize: "0.85em", marginTop: 4 }}>
              Necesita que Meta apruebe en el WhatsApp de la clínica las plantillas{" "}
              <code>cita_asignada_profesional</code>, <code>cita_modificada_profesional</code> y{" "}
              <code>cita_cancelada_profesional</code>. Se crean con «Crear las que falten» en el detalle de la clínica y
              quedan pendientes hasta que Meta las apruebe; mientras tanto el aviso no llega (la cita se crea igual).
            </p>
          </div>

          <div className="field">
            <Label>Avisarle de</Label>
            {[
              { key: "notifyOnCreate", label: "Citas nuevas" },
              { key: "notifyOnChange", label: "Cambios (día, hora, espacio, servicio o profesional)" },
              { key: "notifyOnCancel", label: "Cancelaciones" },
            ].map((t) => (
              <div className="checkbox-field" style={{ marginTop: 6 }} key={t.key}>
                <Checkbox
                  id={`edit-${t.key}`}
                  checked={form[t.key as "notifyOnCreate" | "notifyOnChange" | "notifyOnCancel"]}
                  onCheckedChange={(v) => setForm((f) => ({ ...f, [t.key]: v === true }))}
                />
                <Label htmlFor={`edit-${t.key}`}>{t.label}</Label>
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onCerrar}>
              Cancelar
            </Button>
            <Button type="submit">Guardar</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Espacios y equipos se listan igual; lo único que cambia es la columna de tipo. */
function ListaSimple(props: {
  items: Array<Espacio & { type?: string }>;
  vacio: string;
  descripcionVacio: string;
  canEdit: boolean;
  conTipo?: boolean;
  onToggle: (id: string, active: boolean, name: string) => void;
}) {
  if (props.items.length === 0) {
    return (
      <EmptyState icon={Stethoscope} title={props.vacio} description={props.descripcionVacio} />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Nombre</TableHead>
          {props.conTipo && <TableHead>Tipo</TableHead>}
          <TableHead>Citas por delante</TableHead>
          <TableHead>Activo</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {props.items.map((item) => (
          <TableRow key={item.id}>
            <TableCell>{item.name}</TableCell>
            {props.conTipo && (
              <TableCell>
                <code>{item.type}</code>
              </TableCell>
            )}
            <TableCell>
              {item.turnosFuturos > 0 ? <Badge variant="outline">{item.turnosFuturos}</Badge> : "—"}
            </TableCell>
            <TableCell>
              <Switch
                checked={item.active}
                disabled={!props.canEdit}
                onCheckedChange={(active) => props.onToggle(item.id, active, item.name)}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
