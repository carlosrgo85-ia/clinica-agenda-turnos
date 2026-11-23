import { useCallback, useEffect, useState } from "react";
import { ScrollText } from "lucide-react";
import { api, ApiError } from "../api/client";
import { PageContainer } from "../components/shell/PageContainer";
import { Badge, type BadgeVariant } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { DateField } from "../components/ui/date-field";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { PageSkeleton } from "../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { formatDateTime } from "../lib/format";

interface Registro {
  id: string;
  occurredAt: string;
  userEmail: string | null;
  userName: string | null;
  clinicId: string | null;
  /** `panel`, `whatsapp` (el asistente) o `sistema` (un job). */
  origin: "panel" | "whatsapp" | "sistema" | null;
  origenEtiqueta: string | null;
  action: string;
  etiqueta: string;
  method: string | null;
  route: string | null;
  resourceType: string | null;
  resourceId: string | null;
  outcome: "ok" | "denegado" | "error";
  statusCode: number | null;
  ip: string | null;
  details: Record<string, unknown> | null;
}

interface Respuesta {
  registros: Registro[];
  siguiente: string | null;
}

const RESULTADO: Record<Registro["outcome"], { label: string; variant: BadgeVariant }> = {
  ok: { label: "Correcto", variant: "default" },
  denegado: { label: "Denegado", variant: "destructive" },
  error: { label: "Con error", variant: "secondary" },
};

/** Los datos extra de un registro en una línea legible: "campos: name, email · motivo: …". */
function resumenDeDetalles(d: Registro["details"]): string {
  if (!d) return "";
  return Object.entries(d)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");
}

/**
 * El registro de auditoría: quién hizo qué, cuándo, sobre qué y con qué resultado,
 * desde el login. Solo lectura: nada lo edita ni lo borra. **Nunca muestra lo que se
 * escribió**, solo qué campos cambiaron: el contenido no se guarda.
 *
 * Es solo del super-admin: muestra todas las clínicas y lo que no es de ninguna. Una clínica
 * no tiene pantalla propia (trae IPs y user agents, datos técnicos que no le corresponden).
 */
export function AuditPage() {

  const [usuario, setUsuario] = useState("");
  const [accion, setAccion] = useState("");
  const [resultado, setResultado] = useState("");
  const [origen, setOrigen] = useState("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [filas, setFilas] = useState<Registro[] | null>(null);
  const [siguiente, setSiguiente] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const base = "/platform/audit";

  const consulta = useCallback(
    (before?: string) => {
      const p = new URLSearchParams({ limit: "50" });
      if (usuario.trim()) p.set("usuario", usuario.trim());
      if (accion.trim()) p.set("accion", accion.trim());
      if (resultado) p.set("resultado", resultado);
      if (origen) p.set("origen", origen);
      if (desde) p.set("desde", desde);
      if (hasta) p.set("hasta", hasta);
      if (before) p.set("before", before);
      return `${base}?${p}`;
    },
    [base, usuario, accion, resultado, origen, desde, hasta]
  );

  useEffect(() => {
    let cancelado = false;
    // Con una pausa al escribir, para no pedir en cada tecla.
    const espera = setTimeout(() => {
      api
        .get<Respuesta>(consulta())
        .then((r) => {
          if (cancelado) return;
          setFilas(r.registros);
          setSiguiente(r.siguiente);
          setError(null);
        })
        .catch((err) => !cancelado && setError(err instanceof ApiError ? err.message : "No se pudo cargar la auditoría"));
    }, 250);
    return () => {
      cancelado = true;
      clearTimeout(espera);
    };
  }, [base, consulta]);

  async function verMas() {
    if (!siguiente) return;
    try {
      const r = await api.get<Respuesta>(consulta(siguiente));
      setFilas((prev) => [...(prev ?? []), ...r.registros]);
      setSiguiente(r.siguiente);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudieron cargar más registros");
    }
  }

  if (error && !filas) return <ErrorState message={error} />;
  if (!filas) return <PageSkeleton />;

  return (
    <PageContainer>
      <h1>Auditoría</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Quién hizo qué y cuándo, desde el inicio de sesión. Es de solo lectura y no se puede editar ni borrar. No guarda
        lo que se escribió, solo qué campos cambiaron.
      </p>

      <div className="card" style={{ marginBottom: 16, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div className="field" style={{ margin: 0, flex: "1 1 200px" }}>
          <Label htmlFor="aud-usuario">Usuario (email)</Label>
          <Input id="aud-usuario" value={usuario} onChange={(e) => setUsuario(e.target.value)} />
        </div>
        <div className="field" style={{ margin: 0, flex: "1 1 200px" }}>
          <Label htmlFor="aud-accion">Acción</Label>
          <Input id="aud-accion" placeholder="Ej. appointment, login" value={accion} onChange={(e) => setAccion(e.target.value)} />
        </div>
        <div className="field" style={{ margin: 0, flex: "0 1 150px" }}>
          <Label htmlFor="aud-resultado">Resultado</Label>
          <select id="aud-resultado" className="input" value={resultado} onChange={(e) => setResultado(e.target.value)}>
            <option value="">Todos</option>
            <option value="ok">Correcto</option>
            <option value="denegado">Denegado</option>
            <option value="error">Con error</option>
          </select>
        </div>
        <div className="field" style={{ margin: 0, flex: "0 1 190px" }}>
          <Label htmlFor="aud-origen">Origen</Label>
          <select id="aud-origen" className="input" value={origen} onChange={(e) => setOrigen(e.target.value)}>
            <option value="">Todos</option>
            <option value="panel">Panel (una persona)</option>
            <option value="whatsapp">Asistente (WhatsApp)</option>
            <option value="sistema">Sistema (un proceso)</option>
          </select>
        </div>
        <div className="field" style={{ margin: 0, flex: "0 1 170px" }}>
          <Label htmlFor="aud-desde">Desde</Label>
          <DateField id="aud-desde" value={desde} onChange={setDesde} />
        </div>
        <div className="field" style={{ margin: 0, flex: "0 1 170px" }}>
          <Label htmlFor="aud-hasta">Hasta</Label>
          <DateField id="aud-hasta" value={hasta} onChange={setHasta} />
        </div>
      </div>

      {filas.length === 0 ? (
        <EmptyState icon={ScrollText} title="Sin registros" description="No hay registros con esos filtros." />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cuándo</TableHead>
                <TableHead>Quién</TableHead>
                <TableHead>Qué hizo</TableHead>
                <TableHead>Resultado</TableHead>
                <TableHead>Desde (IP)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filas.map((r) => (
                <TableRow key={r.id}>
                  <TableCell style={{ whiteSpace: "nowrap" }}>{formatDateTime(r.occurredAt)}</TableCell>
                  <TableCell>
                    {/* Lo que hizo el asistente o un proceso no tiene usuario: se lee como lo que es,
                        y no como "sin sesión", que es otra cosa (un intento sin haber entrado). */}
                    {r.userName ?? r.userEmail ?? (r.origin && r.origin !== "panel" ? r.origenEtiqueta : "Sin sesión")}
                    {r.userName && r.userEmail && (
                      <div className="muted" style={{ fontSize: "0.85em" }}>
                        {r.userEmail}
                      </div>
                    )}
                    {r.origin && r.origin !== "panel" && (r.userName || r.userEmail) && (
                      <div className="muted" style={{ fontSize: "0.85em" }}>
                        vía {r.origenEtiqueta}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <strong>{r.etiqueta}</strong>
                    <div className="muted" style={{ fontSize: "0.85em" }}>
                      {r.action}
                      {r.resourceId ? ` · ${r.resourceType ?? ""} ${r.resourceId}` : ""}
                    </div>
                    {r.details && (
                      <div className="muted" style={{ fontSize: "0.85em" }}>
                        {resumenDeDetalles(r.details)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={RESULTADO[r.outcome].variant}>{RESULTADO[r.outcome].label}</Badge>
                    {r.statusCode && r.outcome !== "ok" && (
                      <div className="muted" style={{ fontSize: "0.85em" }}>
                        {r.statusCode}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="muted" style={{ fontSize: "0.85em" }}>
                    {r.ip ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {siguiente && (
            <Button variant="outline" onClick={verMas} style={{ marginTop: 12 }}>
              Ver más
            </Button>
          )}
        </>
      )}
    </PageContainer>
  );
}
