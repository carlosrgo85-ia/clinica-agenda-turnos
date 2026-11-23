import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { PageContainer } from "../components/shell/PageContainer";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { DateField } from "../components/ui/date-field";
import { ErrorState } from "../components/ui/error-state";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
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
import { isoADisplay } from "../lib/date-format";
import { GoogleOAuthCard } from "./GoogleOAuthCard";

interface SecretRow {
  key: string;
  label: string;
  description: string;
  impact: string;
  renewal: string[];
  /** La variable del .env que se usa mientras no haya un valor guardado. */
  envVar: string;
  /** Hay un valor guardado en la plataforma (nunca cuál es). */
  valorGuardado: boolean;
  /** De dónde sale el valor que se usa hoy. */
  origen: "base" | "env" | "ninguno";
  /** YYYY-MM-DD, o null si todavía no se registró. */
  expiresOn: string | null;
  note: string | null;
  daysLeft: number | null;
  state: "ok" | "por_vencer" | "vencido" | null;
  resumen: string | null;
  lastReminderOn: string | null;
}

interface SecretsResponse {
  hoy: string;
  diasDeAviso: number;
  secretos: SecretRow[];
}

/**
 * Cuándo vencen los secretos de las integraciones de la plataforma.
 *
 * Hoy es uno solo: el de la app de Microsoft. Cuando vence, ninguna clínica
 * puede conectar ni refrescar su Outlook. Se registra acá solo la FECHA —el
 * valor del secreto vive en el `.env`— y la plataforma manda un mail a los
 * administradores todos los días desde una semana antes, hasta que se
 * registre la fecha del secreto nuevo.
 */
export function SecretsPage() {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("secretos.editar");

  const [data, setData] = useState<SecretsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setData(await api.get<SecretsResponse>("/platform/secrets"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudieron cargar los secretos");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (loading && !data) return <PageSkeleton />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return null;

  return (
    <PageContainer>
      <h1>Secretos de las integraciones</h1>
      <GoogleOAuthCard canEdit={canEdit} />

      <h2>Vencimiento de secretos</h2>
      <p className="muted" style={{ marginBottom: 16 }}>
        Algunas integraciones usan un secreto que vence. Registra aquí la fecha: te avisamos por mail todos los
        días desde {data.diasDeAviso} días antes, hasta que cargues la del secreto nuevo.
      </p>

      {data.secretos.map((secret) => (
        <SecretCard key={secret.key} secret={secret} canEdit={canEdit} onChanged={load} />
      ))}
    </PageContainer>
  );
}

function StateBadge({ secret }: { secret: SecretRow }) {
  if (secret.state === null) return <Badge variant="secondary">Sin registrar</Badge>;
  if (secret.state === "ok") return <Badge variant="success">Vigente · {secret.resumen}</Badge>;
  return <Badge variant="destructive">{secret.state === "vencido" ? "Vencido" : "Por vencer"} · {secret.resumen}</Badge>;
}

function SecretCard({
  secret,
  canEdit,
  onChanged,
}: {
  secret: SecretRow;
  canEdit: boolean;
  onChanged: () => Promise<void>;
}) {
  const [expiresOn, setExpiresOn] = useState(secret.expiresOn ?? "");
  const [note, setNote] = useState(secret.note ?? "");
  // De solo escritura: el servidor nunca lo devuelve, así que empieza vacío y
  // se vacía al guardar.
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  // Se recarga desde afuera al guardar o borrar.
  useEffect(() => {
    setExpiresOn(secret.expiresOn ?? "");
    setNote(secret.note ?? "");
  }, [secret.expiresOn, secret.note]);

  const changed = expiresOn !== (secret.expiresOn ?? "") || note !== (secret.note ?? "") || value !== "";
  // `DateField` entrega "" mientras la fecha esté incompleta.
  const valid = Boolean(expiresOn);

  async function save() {
    setSaving(true);
    try {
      await api.put(`/platform/secrets/${secret.key}`, {
        expiresOn,
        note: note.trim() || null,
        ...(value ? { value } : {}),
      });
      toast.success(
        value
          ? "Secreto guardado y verificado. Ya se usa, sin reiniciar nada."
          : "Vencimiento guardado. El aviso empieza a salir 7 días antes."
      );
      setValue("");
      await onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo guardar");
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    try {
      await api.delete(`/platform/secrets/${secret.key}`);
      toast.success("Se dejó de seguir el vencimiento. Ya no se mandan avisos.");
      await onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo borrar");
    }
  }

  async function clearValue() {
    try {
      await api.delete(`/platform/secrets/${secret.key}/value`);
      toast.success(`Se quitó el secreto guardado. Se usa ${secret.envVar} del .env.`);
      await onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo quitar el secreto");
    }
  }

  const origen =
    secret.origen === "base"
      ? "Guardado en la plataforma (cifrado)"
      : secret.origen === "env"
        ? `Tomado de ${secret.envVar} en el .env`
        : "Sin configurar";

  return (
    <section className="card" style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>{secret.label}</h2>
        <StateBadge secret={secret} />
      </div>
      <p className="muted">{secret.description}</p>
      <p>
        <strong>Si vence:</strong> {secret.impact}
      </p>

      <p>
        <strong>Valor en uso:</strong> {origen}
        {secret.origen === "ninguno" && (
          <span className="error-text"> — sin secreto la integración no funciona.</span>
        )}
      </p>

      {secret.state === null && (
        <p className="error-text">
          Todavía no hay una fecha registrada: sin ella no podemos avisarte antes de que se rompa.
        </p>
      )}
      {secret.state === "vencido" && (
        <p className="error-text">
          Venció el {isoADisplay(secret.expiresOn!)}. Renuévalo y registra la fecha del nuevo para apagar el aviso.
        </p>
      )}

      {canEdit && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", margin: "16px 0" }}>
          <div>
            <Label htmlFor={`exp-${secret.key}`}>Vence el</Label>
            <DateField id={`exp-${secret.key}`} value={expiresOn} onChange={setExpiresOn} />
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <Label htmlFor={`note-${secret.key}`}>Nota (opcional)</Label>
            <Input
              id={`note-${secret.key}`}
              value={note}
              maxLength={500}
              placeholder="Ej. creado por Carlos, valor guardado en el gestor de contraseñas"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div style={{ flexBasis: "100%" }}>
            <Label htmlFor={`val-${secret.key}`}>
              {secret.valorGuardado ? "Reemplazar el secreto (opcional)" : "Guardar el secreto aquí (opcional)"}
            </Label>
            <Input
              id={`val-${secret.key}`}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={value}
              placeholder="Pega el VALOR del secreto nuevo"
              onChange={(e) => setValue(e.target.value)}
            />
            <p className="muted" style={{ margin: "4px 0 0" }}>
              Se verifica con Microsoft antes de guardarlo, se cifra y no se vuelve a mostrar. Se usa al instante,
              sin reiniciar. Si lo dejas vacío, el que ya hay no se toca.
            </p>
          </div>
          <Button disabled={!changed || !valid || saving} onClick={save}>
            {saving ? "Guardando…" : "Guardar"}
          </Button>
          {secret.valorGuardado && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline">Quitar el secreto guardado</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>¿Quitar el secreto guardado?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Se borra de la plataforma y desde ahí se usa {secret.envVar} del .env. Si esa variable no
                    está cargada, ninguna clínica podrá conectar ni refrescar su cuenta.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancelar</AlertDialogCancel>
                  <AlertDialogAction onClick={clearValue}>Quitar</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          {secret.expiresOn && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline">Dejar de seguir</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>¿Dejar de seguir este vencimiento?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Se borra la fecha y no se manda ningún aviso más. El secreto guardado, si hay uno, no se
                    toca. Si el secreto vence igual, nadie se va a enterar hasta que falle la integración.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancelar</AlertDialogCancel>
                  <AlertDialogAction onClick={clear}>Dejar de seguir</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      )}

      {secret.lastReminderOn && (
        <p className="muted">Último aviso enviado: {isoADisplay(secret.lastReminderOn)}</p>
      )}

      <details>
        <summary>Cómo se renueva</summary>
        <ol>
          {secret.renewal.map((paso) => (
            <li key={paso}>{paso}</li>
          ))}
        </ol>
      </details>
    </section>
  );
}
