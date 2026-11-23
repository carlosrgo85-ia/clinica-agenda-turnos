import { useCallback, useEffect, useState } from "react";
import { Download, Info } from "lucide-react";
import { api, ApiError } from "../api/client";
import { useEffectiveClinicId } from "../auth/AuthContext";
import { ClinicScopeRequired } from "../components/shell/ClinicScopeRequired";
import { PageContainer } from "../components/shell/PageContainer";
import { Badge } from "../components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { DateField } from "../components/ui/date-field";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { Label } from "../components/ui/label";
import { PageSkeleton } from "../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { isoADisplay } from "../lib/date-format";
import { claveDeDia, formatearValor, INFORMES, type Indicador, type Informe, type InformeClave } from "../lib/reports";

interface Opciones {
  profesionales: Array<{ id: string; name: string }>;
  servicios: Array<{ id: string; name: string }>;
}

/**
 * Reportes de citas: resumen, canceladas, reagendadas, atendidos por profesional y sin
 * confirmar. Todos comparten los filtros y tienen la misma forma, así que esta pantalla
 * solo dibuja lo que el servidor devuelve: indicadores, tablas de resumen y detalle.
 *
 * El servidor define qué cuenta cada número (las definiciones viven en
 * `services/reports.ts`); acá se muestran con su ayuda al lado, porque en un reporte "cuántas
 * canceladas" depende de qué se llama cancelada.
 */
export function ReportsPage() {
  const clinicId = useEffectiveClinicId();

  const [tab, setTab] = useState<InformeClave>("resumen");
  const [desde, setDesde] = useState(claveDeDia(-29));
  const [hasta, setHasta] = useState(claveDeDia(0));
  const [base, setBase] = useState<"evento" | "cita">("evento");
  const [professionalId, setProfessionalId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [opciones, setOpciones] = useState<Opciones | null>(null);
  const [informe, setInforme] = useState<Informe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  const consulta = useCallback(
    (extra?: Record<string, string>) => {
      const p = new URLSearchParams();
      if (desde) p.set("desde", desde);
      if (hasta) p.set("hasta", hasta);
      p.set("base", base);
      if (professionalId) p.set("professionalId", professionalId);
      if (serviceId) p.set("serviceId", serviceId);
      for (const [k, v] of Object.entries(extra ?? {})) p.set(k, v);
      return p.toString();
    },
    [desde, hasta, base, professionalId, serviceId]
  );

  useEffect(() => {
    if (!clinicId) return;
    api
      .get<Opciones>(`/dashboard/clinics/${clinicId}/reports/options`)
      .then(setOpciones)
      // Sin las opciones los filtros de profesional y servicio quedan vacíos; el reporte sigue sirviendo.
      .catch(() => setOpciones(null));
  }, [clinicId]);

  useEffect(() => {
    if (!clinicId || !desde || !hasta) return;
    let cancelado = false;
    setCargando(true);
    // Con una pausa al cambiar un filtro, para no pedir en cada cambio.
    const espera = setTimeout(() => {
      api
        .get<Informe>(`/dashboard/clinics/${clinicId}/reports/${tab}?${consulta()}`)
        .then((r) => {
          if (cancelado) return;
          setInforme(r);
          setError(null);
        })
        .catch((err) => !cancelado && setError(err instanceof ApiError ? err.message : "No se pudo cargar el reporte"))
        .finally(() => !cancelado && setCargando(false));
    }, 250);
    return () => {
      cancelado = true;
      clearTimeout(espera);
    };
  }, [clinicId, tab, consulta, desde, hasta]);

  if (!clinicId) return <ClinicScopeRequired />;

  const definicion = INFORMES.find((i) => i.clave === tab)!;
  // Mientras llega uno nuevo no se muestra el de otra pestaña como si fuera este.
  const actual = informe?.informe === tab ? informe : null;
  const urlCsv = `/dashboard/clinics/${clinicId}/reports/${tab}?${consulta({ formato: "csv" })}`;

  return (
    <PageContainer>
      <h1>Reportes</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Los períodos son los de la zona horaria de la clínica. Ver o descargar un reporte queda registrado en la auditoría.
      </p>

      <div className="card" style={{ marginBottom: 16, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div className="field" style={{ margin: 0, flex: "0 1 170px" }}>
          <Label htmlFor="rep-desde">Desde</Label>
          <DateField id="rep-desde" value={desde} onChange={setDesde} />
        </div>
        <div className="field" style={{ margin: 0, flex: "0 1 170px" }}>
          <Label htmlFor="rep-hasta">Hasta</Label>
          <DateField id="rep-hasta" value={hasta} onChange={setHasta} />
        </div>
        <div className="field" style={{ margin: 0, flex: "1 1 170px" }}>
          <Label htmlFor="rep-prof">Profesional</Label>
          <select id="rep-prof" className="input" value={professionalId} onChange={(e) => setProfessionalId(e.target.value)}>
            <option value="">Todos</option>
            {(opciones?.profesionales ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ margin: 0, flex: "1 1 170px" }}>
          <Label htmlFor="rep-serv">Servicio</Label>
          <select id="rep-serv" className="input" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
            <option value="">Todos</option>
            {(opciones?.servicios ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        {definicion.conBase && (
          <div className="field" style={{ margin: 0, flex: "1 1 210px" }}>
            <Label htmlFor="rep-base">Contar por</Label>
            <select id="rep-base" className="input" value={base} onChange={(e) => setBase(e.target.value as "evento" | "cita")}>
              <option value="evento">Cuándo pasó (se canceló o se cambió)</option>
              <option value="cita">El día de la cita</option>
            </select>
          </div>
        )}
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as InformeClave)}>
        {/* Con tantos reportes no entran en una línea: que pasen a la siguiente en vez de salirse de la pantalla. */}
        <TabsList style={{ flexWrap: "wrap", maxWidth: "100%" }}>
          {INFORMES.map((i) => (
            <TabsTrigger key={i.clave} value={i.clave}>
              {i.etiqueta}
            </TabsTrigger>
          ))}
        </TabsList>

        {INFORMES.map((i) => (
          <TabsContent key={i.clave} value={i.clave}>
            <p className="muted" style={{ marginTop: 0 }}>
              {i.descripcion}
            </p>
            {i.clave !== tab ? null : error && !actual ? (
              <ErrorState message={error} />
            ) : !actual ? (
              <PageSkeleton />
            ) : (
              <Contenido informe={actual} cargando={cargando} urlCsv={urlCsv} />
            )}
          </TabsContent>
        ))}
      </Tabs>
    </PageContainer>
  );
}

function Contenido({ informe, cargando, urlCsv }: { informe: Informe; cargando: boolean; urlCsv: string }) {
  return (
    <div style={{ opacity: cargando ? 0.6 : 1 }}>
      <p className="muted" style={{ marginTop: 0 }}>
        Del {isoADisplay(informe.periodo.desde)} al {isoADisplay(informe.periodo.hasta)}
        {informe.desdeDatos && <> · hay datos de eventos desde el {isoADisplay(informe.desdeDatos)}</>}
      </p>

      {informe.informe === "resumen" && <Composicion kpis={informe.kpis} />}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12, marginBottom: 12 }}>
        {informe.kpis.slice(0, 4).map((k) => (
          <Tile key={k.clave} k={k} grande />
        ))}
      </div>
      {informe.kpis.length > 4 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 24 }}>
          {informe.kpis.slice(4).map((k) => (
            <Tile key={k.clave} k={k} />
          ))}
        </div>
      )}

      {informe.tablas.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 24, marginBottom: 24 }}>
          {informe.tablas.map((t) => (
            <div key={t.clave}>
              <h3 style={{ marginTop: 0 }}>{t.titulo}</h3>
              {t.visual === "barras" ? (
                <BarList filas={t.filas} unidad={t.unidad} />
              ) : t.visual === "calor" ? (
                <MapaDeCalor columnas={t.columnas} filas={t.filas} />
              ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    {t.columnas.map((c) => (
                      <TableHead key={c}>{c}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {t.filas.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={t.columnas.length} className="muted">
                        Sin datos en el período.
                      </TableCell>
                    </TableRow>
                  ) : (
                    t.filas.map((f, i) => (
                      <TableRow key={i}>
                        {f.map((c, j) => (
                          <TableCell key={j}>{c ?? "—"}</TableCell>
                        ))}
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
              )}
            </div>
          ))}
        </div>
      )}

      {informe.detalle.columnas.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 16, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
            <h3 style={{ margin: 0 }}>
              {informe.detalle.titulo} <Badge variant="secondary">{informe.detalle.total}</Badge>
            </h3>
            {informe.detalle.total > 0 && (
              <a className="btn btn--outline" href={urlCsv} download>
                <Download size={14} /> Descargar CSV
              </a>
            )}
          </div>
          {informe.detalle.total === 0 ? (
            <EmptyState title="Sin resultados" description="No hay citas que coincidan con los filtros." />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    {informe.detalle.columnas.map((c) => (
                      <TableHead key={c}>{c}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {informe.detalle.filas.map((f, i) => (
                    <TableRow key={i}>
                      {f.map((c, j) => (
                        <TableCell key={j}>{c ?? "—"}</TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {informe.detalle.truncado && (
                <p className="muted">Se muestran las primeras {informe.detalle.filas.length}; el CSV trae todas.</p>
              )}
            </>
          )}
        </>
      )}

      {informe.notas.length > 0 && (
        <ul className="muted" style={{ marginTop: 24, fontSize: "0.9em" }}>
          {informe.notas.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Barras horizontales de una sola serie (etiqueta y conteo), en el color de marca: sin leyenda
 * (una serie no la necesita), el valor en la punta de la barra en vez de un eje, y la propia
 * lista es la vista accesible: nada se lee solo por color.
 */
function BarList({ filas, unidad }: { filas: Array<Array<string | number | null>>; unidad?: "%" }) {
  const datos = filas.map((f) => ({ etiqueta: String(f[0] ?? "—"), valor: Number(f[1] ?? 0) }));
  // En porcentajes la escala es 0-100 (una barra al 40 % se ve al 40 %, no al 100 % por ser la mayor).
  const max = unidad === "%" ? 100 : Math.max(1, ...datos.map((d) => d.valor));

  // En porcentajes un 0 % es un dato (el espacio está vacío): se muestra. En conteos, todo cero es "sin datos".
  if (datos.length === 0 || (!unidad && datos.every((d) => d.valor === 0))) return <p className="muted">Sin datos en el período.</p>;

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10, margin: 0 }}>
      {datos.map((d) => (
        <div key={d.etiqueta} style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="muted" style={{ width: 150, flexShrink: 0, fontSize: "0.9em" }}>
            {d.etiqueta}
          </span>
          <div style={{ flex: 1, background: "var(--muted)", borderRadius: 4, height: 20 }}>
            <div
              style={{
                width: `${Math.min(100, (d.valor / max) * 100)}%`,
                height: "100%",
                background: "var(--primary)",
                borderRadius: 4,
                minWidth: d.valor > 0 ? 4 : 0,
              }}
            />
          </div>
          <span style={{ width: 48, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
            {d.valor.toLocaleString("es", { maximumFractionDigits: 1 })}
            {unidad ?? ""}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Color de acento según lo que mide: lo malo en rojo, lo pendiente en el coral oscuro. */
function acento(clave: string, valor: number | null): string | undefined {
  if (clave === "canceladas" || clave === "tasa_cancelacion") return "var(--destructive)";
  if (clave === "sin_confirmar" && (valor ?? 0) > 0) return "var(--primary-hover)";
  return undefined;
}

/**
 * Un indicador. La explicación de qué cuenta va en el tooltip del ícono y no en el cuerpo:
 * con el texto debajo, las tarjetas quedaban de alturas distintas y el número se perdía.
 * Los porcentajes llevan una barra, que se lee más rápido que el número solo.
 */
function Tile({ k, grande }: { k: Indicador; grande?: boolean }) {
  const color = acento(k.clave, k.valor);
  return (
    <div className="card" style={{ margin: 0, padding: grande ? 16 : 12, borderLeft: `4px solid ${color ?? "var(--border, var(--muted))"}` }}>
      <div className="muted" style={{ fontSize: "0.85em", display: "flex", alignItems: "center", gap: 6 }}>
        {k.etiqueta}
        {k.ayuda && (
          // Un popover que se abre con un click o un toque (y con el teclado): el tooltip nativo (`title`)
          // tarda en aparecer, no sale en pantallas táctiles y mucha gente no sabe que existe.
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={`Qué significa: ${k.etiqueta}`}
                style={{ display: "inline-flex", background: "none", border: 0, padding: 2, cursor: "pointer", color: "inherit" }}
              >
                <Info size={14} />
              </button>
            </PopoverTrigger>
            <PopoverContent style={{ maxWidth: 300, fontSize: "0.9em", lineHeight: 1.45 }}>
              <strong>{k.etiqueta}</strong>
              <p style={{ margin: "6px 0 0", whiteSpace: "pre-line" }}>{k.ayuda}</p>
            </PopoverContent>
          </Popover>
        )}
      </div>
      <div style={{ fontSize: grande ? "2.2em" : "1.5em", fontWeight: 700, lineHeight: 1.2, color }}>{formatearValor(k)}</div>
      {k.formato === "porcentaje" && k.valor !== null && (
        <div style={{ background: "var(--muted)", borderRadius: 4, height: 6, marginTop: 6 }}>
          <div style={{ width: `${Math.min(100, Math.max(0, k.valor))}%`, height: "100%", borderRadius: 4, background: color ?? "var(--primary)" }} />
        </div>
      )}
    </div>
  );
}

/**
 * Cómo se reparten las citas del período, en una sola barra. Sale de los mismos indicadores
 * (no hay un dato aparte): confirmadas + automáticas + canceladas + sin confirmar + por venir
 * = citas del período. La leyenda con los números es la vista accesible: el color solo no alcanza.
 */
function Composicion({ kpis }: { kpis: Indicador[] }) {
  const v = (c: string) => kpis.find((k) => k.clave === c)?.valor ?? 0;
  const total = v("citas");
  const tramos = [
    { etiqueta: "Atendidas confirmadas", valor: v("atendidas_confirmadas"), color: "var(--primary)" },
    { etiqueta: "Atendidas automáticas", valor: v("atendidas_automaticas"), color: "color-mix(in srgb, var(--primary) 45%, transparent)" },
    { etiqueta: "Canceladas", valor: v("canceladas"), color: "var(--destructive)" },
    { etiqueta: "Sin confirmar", valor: v("sin_confirmar"), color: "var(--muted-foreground)" },
    { etiqueta: "Por venir", valor: v("futuras"), color: "var(--muted)" },
  ];
  if (!total) return null;

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="muted" style={{ fontSize: "0.85em", marginBottom: 8 }}>
        Cómo se repartieron las {total} citas del período
      </div>
      <div style={{ display: "flex", height: 18, borderRadius: 4, overflow: "hidden", background: "var(--muted)" }}>
        {tramos.filter((t) => t.valor > 0).map((t) => (
          <div key={t.etiqueta} title={`${t.etiqueta}: ${t.valor}`} style={{ width: `${(t.valor / total) * 100}%`, background: t.color }} />
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px", marginTop: 10, fontSize: "0.85em" }}>
        {tramos.map((t) => (
          <span key={t.etiqueta} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: t.color, border: "1px solid var(--muted-foreground)" }} />
            {t.etiqueta} <strong>{t.valor}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Mapa de calor: una fila por día y una columna por hora. Cuanto más oscuro, más usado; lo vacío
 * (guion) es que la clínica estaba cerrada. Cada celda lleva su número, así que se puede leer sin
 * distinguir el color; los tramos casi vacíos (el tiempo muerto) son los que se ven más claros.
 */
function MapaDeCalor({ columnas, filas }: { columnas: string[]; filas: Array<Array<string | number | null>> }) {
  if (filas.length === 0) return <p className="muted">Sin datos en el período.</p>;
  return (
    <div className="card" style={{ margin: 0, overflowX: "auto" }}>
      <table style={{ borderCollapse: "separate", borderSpacing: 3, width: "100%", fontSize: "0.8em", fontVariantNumeric: "tabular-nums" }}>
        <thead>
          <tr>
            {columnas.map((c, i) => (
              <th key={c} className="muted" style={{ fontWeight: 500, textAlign: i === 0 ? "left" : "center", padding: "0 2px" }}>
                {i === 0 ? "" : c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filas.map((f) => (
            <tr key={String(f[0])}>
              <td className="muted" style={{ whiteSpace: "nowrap", paddingRight: 8 }}>{f[0]}</td>
              {f.slice(1).map((v, i) => {
                const n = typeof v === "number" ? v : null;
                return (
                  <td
                    key={i}
                    title={n === null ? "Cerrado" : `${columnas[i + 1]}: ${n}%`}
                    style={{
                      textAlign: "center",
                      padding: "6px 2px",
                      borderRadius: 4,
                      minWidth: 38,
                      // Tramos de color en pasos: 0 % casi sin color; 100 % el coral pleno.
                      background: n === null ? "transparent" : `color-mix(in srgb, var(--primary) ${Math.round(8 + Math.min(100, n) * 0.85)}%, var(--muted))`,
                      color: n !== null && n >= 55 ? "var(--primary-foreground)" : "inherit",
                    }}
                  >
                    {n === null ? "–" : Math.round(n)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ margin: "8px 0 0", fontSize: "0.85em" }}>
        Porcentaje de uso. Los tramos más claros son tiempo libre; "–" es que la clínica estaba cerrada.
      </p>
    </div>
  );
}
