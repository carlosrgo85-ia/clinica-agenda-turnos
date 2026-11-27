import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { PageContainer } from "../components/shell/PageContainer";
import { Badge, type BadgeVariant } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { PageSkeleton } from "../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { formatDateTime } from "../lib/format";

type JobState = "ok" | "atrasado" | "con_error" | "nunca_corrio";

interface Snapshot {
  generadoEn: string;
  worker: { vivo: boolean; ultimaSeñal: string | null };
  tareas: Array<{
    name: string;
    label: string;
    schedule: string;
    estado: JobState;
    ultimaCorrida: string | null;
    ultimoError: string | null;
    ultimoErrorEn: string | null;
  }>;
  cola: { pendientes: number; abandonados: number; masViejoEn: string | null };
  derivacionesSinAvisar: { cantidad: number; masViejaEn: string | null };
  eventos24h: Array<{ kind: string; label: string; cantidad: number }>;
  agente24h: {
    llamadas: number;
    errores: number;
    sinInterpretar: number;
    latenciaMediaMs: number | null;
    latenciaMaximaMs: number | null;
    tokensEntrada: number;
    tokensSalida: number;
    mensajes: number;
  };
  clinicas: Array<{
    id: string;
    name: string;
    ultimoMensajeDePacienteEn: string | null;
    eventos24h: number;
  }>;
}

interface SystemEventRow {
  id: string;
  createdAt: string;
  kind: string;
  label: string;
  severity: string;
  clinicId: string | null;
  message: string;
}

interface EventsResponse {
  eventos: SystemEventRow[];
  siguiente: string | null;
}

const JOB_STATE: Record<JobState, { label: string; variant: BadgeVariant }> = {
  ok: { label: "Al día", variant: "default" },
  con_error: { label: "Corrió con error", variant: "destructive" },
  atrasado: { label: "Atrasada", variant: "destructive" },
  nunca_corrio: { label: "Nunca corrió", variant: "outline" },
};

/** Se refresca sola: una pantalla de monitoreo que hay que recargar a mano no se mira. */
const REFRESH_MS = 30_000;

/**
 * Salud del sistema, solo para el super-admin: si el worker está vivo, cuándo
 * corrió cada tarea, qué hay en la cola de mensajes y qué errores hubo.
 *
 * Existe porque las fallas de esta plataforma son silenciosas: un worker
 * apagado, un cron que revienta o un mensaje que muere antes de contestarse
 * no le muestran nada a nadie. Todo sale de Postgres (no llama a Meta ni a
 * Google): el estado de las plantillas de WhatsApp de cada clínica sigue en
 * el detalle de la clínica.
 */
export function MonitoringPage() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<Snapshot>("/platform/monitoring"));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo cargar el monitoreo");
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (error && !data) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <PageSkeleton />;

  const problemas = [
    !data.worker.vivo && "El worker no responde: nadie recibe recordatorios ni avisos.",
    data.cola.abandonados > 0 &&
      `${data.cola.abandonados} mensaje(s) de pacientes llevan demasiado esperando respuesta.`,
    data.derivacionesSinAvisar.cantidad > 0 &&
      `${data.derivacionesSinAvisar.cantidad} derivación(es) sin avisar a la clínica.`,
    // Antes «Todo en orden» ignoraba al asistente: una llamada al modelo que fallaba no ponía la pantalla en alerta.
    data.agente24h.errores > 0 &&
      `${data.agente24h.errores} llamada(s) al modelo de IA fallaron en las últimas 24 horas (ver «Solicitudes al asistente» y los eventos).`,
    data.agente24h.sinInterpretar > 0 &&
      `${data.agente24h.sinInterpretar} respuesta(s) del modelo no se pudieron interpretar en las últimas 24 horas.`,
  ].filter(Boolean) as string[];

  return (
    <PageContainer>
      <h1>Monitoreo</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Se actualiza sola cada 30 segundos. Última lectura: {formatDateTime(data.generadoEn)}.
        {error && " (La última actualización falló: se muestra lo anterior.)"}
      </p>

      {problemas.length === 0 ? (
        <p style={{ marginBottom: 24 }}>
          <Badge>Todo en orden</Badge>
        </p>
      ) : (
        <div role="alert" style={{ marginBottom: 24 }}>
          {problemas.map((p) => (
            <p key={p}>
              <Badge variant="destructive">Atención</Badge> {p}
            </p>
          ))}
        </div>
      )}

      <h2>Tareas programadas</h2>
      <p className="muted" style={{ marginBottom: 8 }}>
        Worker:{" "}
        <Badge variant={data.worker.vivo ? "default" : "destructive"}>
          {data.worker.vivo ? "Activo" : "Sin señal"}
        </Badge>
        {data.worker.ultimaSeñal && <> · última señal {formatDateTime(data.worker.ultimaSeñal)}</>}
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tarea</TableHead>
            <TableHead>Cuándo corre</TableHead>
            <TableHead>Estado</TableHead>
            <TableHead>Última corrida</TableHead>
            <TableHead>Último error</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.tareas.map((t) => (
            <TableRow key={t.name}>
              <TableCell>{t.label}</TableCell>
              <TableCell>{t.schedule}</TableCell>
              <TableCell>
                <Badge variant={JOB_STATE[t.estado].variant}>{JOB_STATE[t.estado].label}</Badge>
              </TableCell>
              <TableCell>{t.ultimaCorrida ? formatDateTime(t.ultimaCorrida) : "—"}</TableCell>
              <TableCell>
                {t.ultimoError ? `${t.ultimoError} (${formatDateTime(t.ultimoErrorEn!)})` : "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <h2 style={{ marginTop: 32 }}>Mensajes y derivaciones</h2>
      <ul>
        <li>
          Mensajes de pacientes en la cola: <strong>{data.cola.pendientes}</strong>
          {data.cola.abandonados > 0 && (
            <>
              {" "}
              · <Badge variant="destructive">{data.cola.abandonados} abandonados</Badge>
            </>
          )}
          {data.cola.masViejoEn && <> · el más viejo, de {formatDateTime(data.cola.masViejoEn)}</>}
        </li>
        <li>
          Derivaciones sin avisar a la clínica: <strong>{data.derivacionesSinAvisar.cantidad}</strong>
          {data.derivacionesSinAvisar.masViejaEn && (
            <> · la más vieja, de {formatDateTime(data.derivacionesSinAvisar.masViejaEn)}</>
          )}
        </li>
      </ul>

      <h2 style={{ marginTop: 32 }}>Errores de las últimas 24 horas</h2>
      {data.eventos24h.length === 0 ? (
        <p className="muted">Ninguno.</p>
      ) : (
        <ul>
          {data.eventos24h.map((e) => (
            <li key={e.kind}>
              {e.label}: <strong>{e.cantidad}</strong>
            </li>
          ))}
        </ul>
      )}

      <h2 style={{ marginTop: 32 }}>Solicitudes al asistente (24 horas)</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Cada llamada al modelo de IA queda registrada: cuánto tardó, cuánto costó y qué decidió. No se guarda el texto de
        los mensajes.
      </p>
      <ul>
        <li>
          Mensajes atendidos: <strong>{data.agente24h.mensajes}</strong> · llamadas al modelo:{" "}
          <strong>{data.agente24h.llamadas}</strong>
        </li>
        <li>
          Con error: <strong>{data.agente24h.errores}</strong>
          {data.agente24h.errores > 0 && <Badge variant="destructive"> revisar</Badge>} · sin poder interpretar:{" "}
          <strong>{data.agente24h.sinInterpretar}</strong>
        </li>
        <li>
          Tiempo de respuesta: {data.agente24h.latenciaMediaMs === null ? "—" : `${data.agente24h.latenciaMediaMs} ms de promedio`}
          {data.agente24h.latenciaMaximaMs !== null && ` · máximo ${data.agente24h.latenciaMaximaMs} ms`}
        </li>
        <li>
          Tokens: {data.agente24h.tokensEntrada.toLocaleString("es")} de entrada ·{" "}
          {data.agente24h.tokensSalida.toLocaleString("es")} de salida
        </li>
      </ul>

      <h2 style={{ marginTop: 32 }}>Clínicas</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Clínica</TableHead>
            <TableHead>Último mensaje de un paciente</TableHead>
            <TableHead>Errores (24 h)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.clinicas.map((c) => (
            <TableRow key={c.id}>
              <TableCell>
                <Link to={`/platform/clinics/${c.id}`}>{c.name}</Link>
              </TableCell>
              <TableCell>
                {c.ultimoMensajeDePacienteEn ? formatDateTime(c.ultimoMensajeDePacienteEn) : "Nunca"}
              </TableCell>
              <TableCell>
                {c.eventos24h > 0 ? <Badge variant="destructive">{c.eventos24h}</Badge> : 0}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <EventsLog clinicas={data.clinicas} />
    </PageContainer>
  );
}

function EventsLog({ clinicas }: { clinicas: Snapshot["clinicas"] }) {
  const [clinicId, setClinicId] = useState("");
  const [kind, setKind] = useState("");
  const [rows, setRows] = useState<SystemEventRow[]>([]);
  const [siguiente, setSiguiente] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (before?: string) => {
      const params = new URLSearchParams({ limit: "25" });
      if (clinicId) params.set("clinicId", clinicId);
      if (kind) params.set("kind", kind);
      if (before) params.set("before", before);
      return api.get<EventsResponse>(`/platform/monitoring/events?${params}`);
    },
    [clinicId, kind]
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchPage()
      .then((r) => {
        if (cancelled) return;
        setRows(r.eventos);
        setSiguiente(r.siguiente);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "No se pudieron cargar los eventos");
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [fetchPage]);

  async function loadMore() {
    if (!siguiente) return;
    try {
      const r = await fetchPage(siguiente);
      setRows((prev) => [...prev, ...r.eventos]);
      setSiguiente(r.siguiente);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudieron cargar más eventos");
    }
  }

  const nombreClinica = (id: string | null) =>
    id ? (clinicas.find((c) => c.id === id)?.name ?? id) : "Plataforma";

  return (
    <>
      <h2 style={{ marginTop: 32 }}>Eventos recientes</h2>
      <p className="muted" style={{ marginBottom: 8 }}>
        Se conservan 30 días. No incluyen el texto de los mensajes ni teléfonos de pacientes.
      </p>
      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <select
          className="input"
          aria-label="Filtrar por clínica"
          value={clinicId}
          onChange={(e) => setClinicId(e.target.value)}
        >
          <option value="">Todas las clínicas</option>
          {clinicas.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          className="input"
          aria-label="Filtrar por tipo"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="">Todos los tipos</option>
          {EVENT_KINDS.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </select>
      </div>

      {error && <ErrorState message={error} />}
      {loading ? (
        <PageSkeleton />
      ) : rows.length === 0 ? (
        <EmptyState title="Sin eventos" description="No hay eventos con esos filtros." />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cuándo</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Clínica</TableHead>
                <TableHead>Detalle</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>{formatDateTime(e.createdAt)}</TableCell>
                  <TableCell>
                    <Badge variant={e.severity === "error" ? "destructive" : "secondary"}>{e.label}</Badge>
                  </TableCell>
                  <TableCell>{nombreClinica(e.clinicId)}</TableCell>
                  <TableCell>{e.message}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {siguiente && (
            <Button variant="outline" onClick={loadMore} style={{ marginTop: 12 }}>
              Ver más
            </Button>
          )}
        </>
      )}
    </>
  );
}

/** Los mismos tipos que `SYSTEM_EVENT_KINDS` del backend. */
const EVENT_KINDS = [
  { kind: "modelo_fallo", label: "Falló el modelo de IA" },
  { kind: "mensaje_sin_procesar", label: "Mensaje sin contestar" },
  { kind: "cron_error", label: "Error en una tarea programada" },
  { kind: "whatsapp_envio", label: "Falló un envío de WhatsApp" },
  { kind: "servicio_sin_match", label: "Servicio pedido sin match en el catálogo" },
  { kind: "auditoria_fallo", label: "No se pudo escribir un registro de auditoría" },
  { kind: "google_oauth_invalido", label: "Google rechaza la app de OAuth de la plataforma" },
];
