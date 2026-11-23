import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api, ApiError } from "../api/client";
import { PageContainer } from "../components/shell/PageContainer";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { DateField } from "../components/ui/date-field";
import { ErrorState } from "../components/ui/error-state";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { PageSkeleton } from "../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { claveDeDia } from "../lib/reports";
import { mostrarCosto } from "../lib/cost-display";

interface Totals {
  costoModeloUsd: number;
  costoWhatsappUsd: number;
  costoOtrosUsd: number;
  costoTotalUsd: number;
  llamadasModelo: number;
  llamadasSinTarifa: number;
  tokensEntrada: number;
  tokensSalida: number;
  tokensCache: number;
  mensajesWhatsapp: number;
  mensajesSinTarifa: number;
  eventosOtros: number;
}
interface Fx {
  currency: string;
  unitsPerUsd: number;
  effectiveFrom: string;
}
interface Summary {
  rango: { desde: string; hasta: string; zona: string };
  total: Totals;
  pruebas: Totals;
  porDia: Array<Totals & { dia: string }>;
  porClinica: Array<Totals & { clinicId: string; clinica: string; pais: string | null; moneda: string | null; cambio: Fx | null }>;
  porProveedor: Array<{ provider: string; etiqueta: string; eventos: number; costoUsd: number; sinTarifa: number }>;
  sinTarifa: { modelos: string[]; mensajes: number; llamadas: number };
}
interface ConversationRow extends Totals {
  dia: string;
  conversacion: string | null;
  prueba: boolean;
}
interface InventoryRow {
  key: string;
  proveedor: string;
  operacion: string;
  cobro: string;
  unidad: string | null;
  gratis: boolean;
  registradoEn: string;
  eventos: number;
  costoUsd: number;
  sinTarifa: number;
  conTarifa: boolean;
}
interface Rates {
  tarifas: Array<{ id: string; provider: string; item: string; unit: string; priceUsd: number; effectiveFrom: string; note: string | null }>;
  cambios: Array<{ id: string; currency: string; unitsPerUsd: number; effectiveFrom: string }>;
}
interface ClinicOption {
  id: string;
  name: string;
}

const UNIDADES: Record<string, string> = {
  usd_por_millon_tokens: "USD por millón de tokens",
  usd_por_mensaje: "USD por mensaje",
  usd_por_llamada: "USD por llamada",
};

/** Los costos son chicos (centavos o menos por mensaje): hasta 4 decimales para que no se vea todo "$0.00". */
const usd = (n: number) => `US$ ${n.toLocaleString("es", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
const entero = (n: number) => n.toLocaleString("es");
/** El costo de modelo / WhatsApp / total de una fila, o "Sin tarifa" si falta la tarifa (nunca un cero engañoso). */
const costoModelo = (x: Totals) => mostrarCosto({ costoUsd: x.costoModeloUsd, total: x.llamadasModelo, sinTarifa: x.llamadasSinTarifa, formatear: usd });
const costoWhatsapp = (x: Totals) => mostrarCosto({ costoUsd: x.costoWhatsappUsd, total: x.mensajesWhatsapp, sinTarifa: x.mensajesSinTarifa, formatear: usd });
const costoTotal = (x: Totals) =>
  mostrarCosto({
    costoUsd: x.costoTotalUsd,
    total: x.llamadasModelo + x.mensajesWhatsapp,
    sinTarifa: x.llamadasSinTarifa + x.mensajesSinTarifa,
    formatear: usd,
  });
const local = (n: number, fx: Fx | null, moneda: string | null) =>
  fx && moneda ? `${moneda} ${(n * fx.unitsPerUsd).toLocaleString("es", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null;

/**
 * Consumo y costo de la plataforma, solo para el super-admin: cuánto gasta cada clínica en el modelo de IA, en
 * WhatsApp y en las integraciones, con las tarifas que se cargan acá. Ver `services/costs.ts`.
 *
 * El costo de cada evento se congela al ocurrir (cambiar una tarifa no mueve el pasado) y **sin tarifa se muestra
 * "sin tarifa", nunca cero**: un cero haría creer que algo es gratis.
 */
export function CostsPage() {
  const [desde, setDesde] = useState(claveDeDia(-29));
  const [hasta, setHasta] = useState(claveDeDia(0));
  const [clinicId, setClinicId] = useState("");
  const [clinicas, setClinicas] = useState<ClinicOption[]>([]);
  const [resumen, setResumen] = useState<Summary | null>(null);
  const [conversaciones, setConversaciones] = useState<ConversationRow[]>([]);
  const [inventario, setInventario] = useState<{ filas: InventoryRow[]; noRegistrado: string[] } | null>(null);
  const [tarifas, setTarifas] = useState<Rates | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  const query = useMemo(() => `desde=${desde}&hasta=${hasta}`, [desde, hasta]);

  const cargar = useCallback(async () => {
    if (!desde || !hasta) return;
    setCargando(true);
    try {
      const filtro = clinicId ? `&clinicId=${encodeURIComponent(clinicId)}` : "";
      const [r, inv, rates, conv] = await Promise.all([
        api.get<Summary>(`/platform/costs/summary?${query}${filtro}`),
        api.get<{ filas: InventoryRow[]; noRegistrado: string[] }>(`/platform/costs/inventory?${query}`),
        api.get<Rates>("/platform/costs/rates"),
        clinicId
          ? api.get<{ filas: ConversationRow[] }>(`/platform/costs/conversations?${query}&clinicId=${encodeURIComponent(clinicId)}`)
          : Promise.resolve({ filas: [] as ConversationRow[] }),
      ]);
      setResumen(r);
      setInventario(inv);
      setTarifas(rates);
      setConversaciones(conv.filas);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudieron cargar los costos");
    } finally {
      setCargando(false);
    }
  }, [query, clinicId, desde, hasta]);

  useEffect(() => {
    api.get<ClinicOption[]>("/platform/clinics").then(setClinicas).catch(() => setClinicas([]));
  }, []);
  useEffect(() => {
    cargar();
  }, [cargar]);

  if (error && !resumen) return <ErrorState message={error} onRetry={cargar} />;
  if (!resumen || !tarifas || !inventario) return <PageSkeleton />;

  const t = resumen.total;
  const unaClinica = resumen.porClinica.find((c) => c.clinicId === clinicId) ?? null;
  const hayFaltantes = resumen.sinTarifa.llamadas > 0 || resumen.sinTarifa.mensajes > 0;

  return (
    <PageContainer>
      <h1>Costos</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Consumo y costo del modelo de IA, de WhatsApp y de las integraciones. Los días son los de la zona {resumen.rango.zona}.
        Cada costo se calcula con la tarifa vigente cuando ocurrió, así que cambiar una tarifa no modifica el pasado.
      </p>

      <div className="card" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div className="field" style={{ margin: 0, flex: "0 1 170px" }}>
          <Label htmlFor="cost-desde">Desde</Label>
          <DateField id="cost-desde" value={desde} onChange={setDesde} />
        </div>
        <div className="field" style={{ margin: 0, flex: "0 1 170px" }}>
          <Label htmlFor="cost-hasta">Hasta</Label>
          <DateField id="cost-hasta" value={hasta} onChange={setHasta} />
        </div>
        <div className="field" style={{ margin: 0, flex: "1 1 220px" }}>
          <Label htmlFor="cost-clinica">Clínica</Label>
          <select id="cost-clinica" className="input" value={clinicId} onChange={(e) => setClinicId(e.target.value)}>
            <option value="">Todas (global)</option>
            {clinicas.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        {cargando && <span className="muted">Actualizando…</span>}
      </div>

      {hayFaltantes && (
        <div className="card" role="alert" style={{ borderLeft: "4px solid var(--primary-hover)", marginTop: 12 }}>
          <strong>Hay consumo sin tarifa cargada</strong>, y no se suma al costo (no se cuenta como gratis):{" "}
          {resumen.sinTarifa.llamadas > 0 && (
            <>
              {entero(resumen.sinTarifa.llamadas)} llamada(s) al modelo ({resumen.sinTarifa.modelos.join(", ")})
            </>
          )}
          {resumen.sinTarifa.llamadas > 0 && resumen.sinTarifa.mensajes > 0 && " y "}
          {resumen.sinTarifa.mensajes > 0 && <>{entero(resumen.sinTarifa.mensajes)} mensaje(s) de WhatsApp</>}. Cárguelas en la pestaña
          "Tarifas".
        </div>
      )}

      <Tabs defaultValue="resumen" style={{ marginTop: 16 }}>
        <TabsList>
          <TabsTrigger value="resumen">{clinicId ? "Resumen de la clínica" : "Resumen global"}</TabsTrigger>
          {clinicId && <TabsTrigger value="conversaciones">Por conversación</TabsTrigger>}
          <TabsTrigger value="inventario">Inventario</TabsTrigger>
          <TabsTrigger value="tarifas">Tarifas</TabsTrigger>
        </TabsList>

        <TabsContent value="resumen">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12, margin: "12px 0" }}>
            <Kpi titulo="Costo total" valor={costoTotal(t).texto} alerta={costoTotal(t).incompleto} detalle={unaClinica && !costoTotal(t).incompleto ? local(t.costoTotalUsd, unaClinica.cambio, unaClinica.moneda) : null} />
            <Kpi titulo="Modelo de IA" valor={costoModelo(t).texto} alerta={costoModelo(t).incompleto} detalle={`${entero(t.llamadasModelo)} llamadas · ${entero(t.tokensEntrada + t.tokensSalida)} tokens`} />
            <Kpi titulo="WhatsApp" valor={costoWhatsapp(t).texto} alerta={costoWhatsapp(t).incompleto} detalle={`${entero(t.mensajesWhatsapp)} mensajes`} />
            <Kpi titulo="Otras integraciones" valor={usd(t.costoOtrosUsd)} detalle={`${entero(t.eventosOtros)} llamadas`} />
          </div>
          {resumen.pruebas.llamadasModelo > 0 && (
            <p className="muted" style={{ fontSize: "0.9em" }}>
              Aparte, el Chat de pruebas gastó {usd(resumen.pruebas.costoModeloUsd)} ({entero(resumen.pruebas.llamadasModelo)} llamadas): cuesta de
              verdad pero no es de ningún paciente, así que no suma arriba.
            </p>
          )}

          {!clinicId && (
            <>
              <h3 style={{ margin: "20px 0 8px" }}>Por clínica</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Clínica</TableHead>
                    <TableHead>Modelo de IA</TableHead>
                    <TableHead>WhatsApp</TableHead>
                    <TableHead>Otros</TableHead>
                    <TableHead>Total (USD)</TableHead>
                    <TableHead>Total (moneda local)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {resumen.porClinica.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="muted">
                        Sin consumo en el período.
                      </TableCell>
                    </TableRow>
                  )}
                  {resumen.porClinica.map((c) => (
                    <TableRow key={c.clinicId}>
                      <TableCell>
                        <button type="button" className="link-button" onClick={() => setClinicId(c.clinicId)}>
                          {c.clinica}
                        </button>
                      </TableCell>
                      <TableCell>{costoModelo(c).texto}<br /><span className="muted" style={{ fontSize: "0.85em" }}>{entero(c.tokensEntrada + c.tokensSalida)} tokens</span></TableCell>
                      <TableCell>{costoWhatsapp(c).texto}<br /><span className="muted" style={{ fontSize: "0.85em" }}>{entero(c.mensajesWhatsapp)} mensajes</span></TableCell>
                      <TableCell>{usd(c.costoOtrosUsd)}</TableCell>
                      <TableCell><strong>{costoTotal(c).texto}</strong></TableCell>
                      <TableCell>{costoTotal(c).incompleto ? <span className="muted">—</span> : (local(c.costoTotalUsd, c.cambio, c.moneda) ?? <span className="muted">{c.moneda ? `sin cambio para ${c.moneda}` : "sin país"}</span>)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}

          <h3 style={{ margin: "20px 0 8px" }}>Por día</h3>
          <BarrasPorDia filas={resumen.porDia} />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Día</TableHead>
                <TableHead>Tokens (entrada / salida)</TableHead>
                <TableHead>Mensajes de WhatsApp</TableHead>
                <TableHead>Costo del día (USD)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {resumen.porDia.map((d) => (
                <TableRow key={d.dia}>
                  <TableCell>{d.dia}</TableCell>
                  <TableCell>{entero(d.tokensEntrada)} / {entero(d.tokensSalida)}</TableCell>
                  <TableCell>{entero(d.mensajesWhatsapp)}</TableCell>
                  <TableCell>{costoTotal(d).texto}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <h3 style={{ margin: "20px 0 8px" }}>Por proveedor</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Proveedor</TableHead>
                <TableHead>Eventos</TableHead>
                <TableHead>Costo (USD)</TableHead>
                <TableHead>Sin tarifa</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {resumen.porProveedor.map((p) => (
                <TableRow key={p.provider}>
                  <TableCell>{p.etiqueta}</TableCell>
                  <TableCell>{entero(p.eventos)}</TableCell>
                  <TableCell>{usd(p.costoUsd)}</TableCell>
                  <TableCell>{p.sinTarifa > 0 ? <Badge variant="destructive">{entero(p.sinTarifa)} sin tarifa</Badge> : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TabsContent>

        {clinicId && (
          <TabsContent value="conversaciones">
            <p className="muted" style={{ margin: "12px 0" }}>
              Una fila por conversación y por día, la más cara primero. La conversación se identifica con un código corto de la ficha: no se
              muestra el nombre ni el teléfono. Sin código son avisos internos (al profesional o a quien administra).
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Día</TableHead>
                  <TableHead>Conversación</TableHead>
                  <TableHead>Llamadas</TableHead>
                  <TableHead>Tokens (entrada / salida)</TableHead>
                  <TableHead>Mensajes WA</TableHead>
                  <TableHead>Costo (USD)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {conversaciones.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="muted">
                      Sin consumo en el período.
                    </TableCell>
                  </TableRow>
                )}
                {conversaciones.map((c) => (
                  <TableRow key={`${c.dia}-${c.conversacion ?? "interno"}`}>
                    <TableCell>{c.dia}</TableCell>
                    <TableCell>
                      {c.conversacion ? `…${c.conversacion}` : <span className="muted">Avisos internos</span>}{" "}
                      {c.prueba && <Badge variant="outline">prueba</Badge>}
                    </TableCell>
                    <TableCell>{entero(c.llamadasModelo)}</TableCell>
                    <TableCell>{entero(c.tokensEntrada)} / {entero(c.tokensSalida)}</TableCell>
                    <TableCell>{entero(c.mensajesWhatsapp)}</TableCell>
                    <TableCell>{costoTotal(c).texto}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TabsContent>
        )}

        <TabsContent value="inventario">
          <p className="muted" style={{ margin: "12px 0" }}>
            Cada integración y operación que se mide, con su volumen y costo en el período. Para sumar una integración nueva hay que agregarla
            al catálogo (<code>config/cost-catalog.ts</code>) y registrar su uso en el código.
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Integración</TableHead>
                <TableHead>Operación y cómo se cobra</TableHead>
                <TableHead>Eventos</TableHead>
                <TableHead>Costo (USD)</TableHead>
                <TableHead>Tarifa</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {inventario.filas.map((f) => (
                <TableRow key={f.key}>
                  <TableCell>{f.proveedor}</TableCell>
                  <TableCell>
                    {f.operacion}
                    <br />
                    <span className="muted" style={{ fontSize: "0.85em" }}>{f.cobro}</span>
                  </TableCell>
                  <TableCell>{entero(f.eventos)}</TableCell>
                  <TableCell>{!f.gratis && !f.conTarifa && f.eventos > 0 ? <span className="muted">—</span> : usd(f.costoUsd)}</TableCell>
                  <TableCell>
                    {f.gratis ? <Badge variant="outline">Gratis</Badge> : f.conTarifa ? <Badge>Con tarifa</Badge> : <Badge variant="destructive">Sin tarifa</Badge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <h3 style={{ margin: "20px 0 8px" }}>Lo que no se registra</h3>
          <ul className="muted">
            {inventario.noRegistrado.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </TabsContent>

        <TabsContent value="tarifas">
          <Tarifas tarifas={tarifas} onChange={cargar} />
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}

function Kpi({ titulo, valor, detalle, alerta }: { titulo: string; valor: string; detalle?: string | null; alerta?: boolean }) {
  return (
    <div className="card" style={{ margin: 0 }}>
      <div className="muted" style={{ fontSize: "0.85em" }}>{titulo}</div>
      <div style={{ fontSize: "1.5em", fontWeight: 600, fontVariantNumeric: "tabular-nums", ...(alerta ? { color: "var(--destructive)" } : {}) }}>{valor}</div>
      {detalle && <div className="muted" style={{ fontSize: "0.85em" }}>{detalle}</div>}
    </div>
  );
}

/** Una barra por día con el costo total: se lee más rápido que la columna de números. */
function BarrasPorDia({ filas }: { filas: Array<{ dia: string; costoTotalUsd: number }> }) {
  const max = Math.max(0, ...filas.map((f) => f.costoTotalUsd));
  if (filas.length === 0 || max === 0) return <p className="muted">Sin costo en el período (o todavía sin tarifas cargadas).</p>;
  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 6, margin: "0 0 12px" }}>
      {filas.map((f) => (
        <div key={f.dia} style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="muted" style={{ width: 90, flexShrink: 0, fontSize: "0.85em" }}>{f.dia}</span>
          <div style={{ flex: 1, background: "var(--muted)", borderRadius: 4, height: 14 }}>
            <div style={{ width: `${(f.costoTotalUsd / max) * 100}%`, height: "100%", background: "var(--primary)", borderRadius: 4, minWidth: f.costoTotalUsd > 0 ? 3 : 0 }} />
          </div>
          <span style={{ width: 90, textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: "0.9em" }}>{usd(f.costoTotalUsd)}</span>
        </div>
      ))}
    </div>
  );
}

function Tarifas({ tarifas, onChange }: { tarifas: Rates; onChange: () => void }) {
  const hoy = claveDeDia(0);
  const [form, setForm] = useState({ provider: "whatsapp", item: "", unit: "usd_por_mensaje", priceUsd: "", effectiveFrom: hoy, note: "" });
  const [cambio, setCambio] = useState({ currency: "", unitsPerUsd: "", effectiveFrom: hoy });
  const [enviando, setEnviando] = useState(false);

  async function guardarTarifa(e: FormEvent) {
    e.preventDefault();
    setEnviando(true);
    try {
      await api.put("/platform/costs/rates", { ...form, priceUsd: Number(form.priceUsd) });
      toast.success("Tarifa guardada.");
      setForm((f) => ({ ...f, item: "", priceUsd: "", note: "" }));
      onChange();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo guardar la tarifa");
    } finally {
      setEnviando(false);
    }
  }

  async function guardarCambio(e: FormEvent) {
    e.preventDefault();
    setEnviando(true);
    try {
      await api.put("/platform/costs/fx-rates", { ...cambio, unitsPerUsd: Number(cambio.unitsPerUsd) });
      toast.success("Tipo de cambio guardado.");
      setCambio((c) => ({ ...c, currency: "", unitsPerUsd: "" }));
      onChange();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo guardar el tipo de cambio");
    } finally {
      setEnviando(false);
    }
  }

  async function borrar(ruta: string) {
    try {
      await api.delete(ruta);
      onChange();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo borrar");
    }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <p className="muted">
        La plataforma no trae precios: cárguelos desde la tarifa vigente de cada proveedor. Una tarifa rige desde su fecha; cargar otra para el mismo
        ítem con una fecha posterior no cambia lo ya registrado. Ejemplos de ítem: <code>claude-sonnet-5-5:input</code>,{" "}
        <code>claude-sonnet-5-5:output</code> (también <code>:cache_read</code> y <code>:cache_creation</code>), <code>whatsapp:utility:MX</code> (o{" "}
        <code>whatsapp:utility:*</code> para todos los países; también <code>marketing</code>, <code>authentication</code> y <code>service</code>),{" "}
        <code>google_places:text_search</code>, <code>google_places:place_details</code>.
      </p>

      <form onSubmit={guardarTarifa} className="card" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div className="field" style={{ margin: 0, flex: "0 1 140px" }}>
          <Label htmlFor="rate-provider">Proveedor</Label>
          <Input id="rate-provider" required value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} />
        </div>
        <div className="field" style={{ margin: 0, flex: "1 1 240px" }}>
          <Label htmlFor="rate-item">Ítem</Label>
          <Input id="rate-item" required placeholder="whatsapp:utility:MX" value={form.item} onChange={(e) => setForm({ ...form, item: e.target.value })} />
        </div>
        <div className="field" style={{ margin: 0, flex: "1 1 200px" }}>
          <Label htmlFor="rate-unit">Unidad</Label>
          <select id="rate-unit" className="input" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })}>
            {Object.entries(UNIDADES).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>
        <div className="field" style={{ margin: 0, flex: "0 1 130px" }}>
          <Label htmlFor="rate-price">Precio (USD)</Label>
          <Input id="rate-price" required type="number" step="any" min={0} value={form.priceUsd} onChange={(e) => setForm({ ...form, priceUsd: e.target.value })} />
        </div>
        <div className="field" style={{ margin: 0, flex: "0 1 170px" }}>
          <Label htmlFor="rate-from">Vigente desde</Label>
          <DateField id="rate-from" value={form.effectiveFrom} onChange={(v) => setForm({ ...form, effectiveFrom: v })} />
        </div>
        <Button type="submit" disabled={enviando}>Guardar tarifa</Button>
      </form>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Ítem</TableHead>
            <TableHead>Unidad</TableHead>
            <TableHead>Precio (USD)</TableHead>
            <TableHead>Desde</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {tarifas.tarifas.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="muted">Todavía no hay tarifas: ningún costo se calcula.</TableCell>
            </TableRow>
          )}
          {tarifas.tarifas.map((t) => (
            <TableRow key={t.id}>
              <TableCell><code>{t.item}</code></TableCell>
              <TableCell>{UNIDADES[t.unit] ?? t.unit}</TableCell>
              <TableCell>{t.priceUsd.toLocaleString("es", { maximumFractionDigits: 8 })}</TableCell>
              <TableCell>{t.effectiveFrom}</TableCell>
              <TableCell><Button variant="outline" onClick={() => borrar(`/platform/costs/rates/${t.id}`)}>Borrar</Button></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <h3 style={{ margin: "24px 0 8px" }}>Tipos de cambio (moneda local)</h3>
      <p className="muted">
        Para mostrar el costo de cada clínica en la moneda de su país. Es un valor manual: las cifras locales cambian si cambia el tipo de cambio, y
        los costos en USD no.
      </p>
      <form onSubmit={guardarCambio} className="card" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div className="field" style={{ margin: 0, flex: "0 1 120px" }}>
          <Label htmlFor="fx-currency">Moneda</Label>
          <Input id="fx-currency" required maxLength={3} placeholder="MXN" value={cambio.currency} onChange={(e) => setCambio({ ...cambio, currency: e.target.value.toUpperCase() })} />
        </div>
        <div className="field" style={{ margin: 0, flex: "0 1 200px" }}>
          <Label htmlFor="fx-units">Unidades por 1 USD</Label>
          <Input id="fx-units" required type="number" step="any" min={0} value={cambio.unitsPerUsd} onChange={(e) => setCambio({ ...cambio, unitsPerUsd: e.target.value })} />
        </div>
        <div className="field" style={{ margin: 0, flex: "0 1 170px" }}>
          <Label htmlFor="fx-from">Vigente desde</Label>
          <DateField id="fx-from" value={cambio.effectiveFrom} onChange={(v) => setCambio({ ...cambio, effectiveFrom: v })} />
        </div>
        <Button type="submit" disabled={enviando}>Guardar tipo de cambio</Button>
      </form>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Moneda</TableHead>
            <TableHead>Unidades por USD</TableHead>
            <TableHead>Desde</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {tarifas.cambios.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="muted">Sin tipos de cambio: los costos se muestran solo en USD.</TableCell>
            </TableRow>
          )}
          {tarifas.cambios.map((c) => (
            <TableRow key={c.id}>
              <TableCell>{c.currency}</TableCell>
              <TableCell>{c.unitsPerUsd.toLocaleString("es", { maximumFractionDigits: 6 })}</TableCell>
              <TableCell>{c.effectiveFrom}</TableCell>
              <TableCell><Button variant="outline" onClick={() => borrar(`/platform/costs/fx-rates/${c.id}`)}>Borrar</Button></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
