import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Check } from "lucide-react";
import { api, ApiError } from "../api/client";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
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

interface GoogleOAuthState {
  guardado: { clientId: string; redirectUri: string } | null;
  origen: "base" | "env" | "ninguno";
  respaldoEnEnv: boolean;
  redirectUriSugerida: string;
}

/**
 * La app de OAuth de Google de la plataforma: la que usan TODAS las clínicas
 * para conectar su calendario. Se carga una vez, acá, y se usa al instante —
 * sin reiniciar el servidor ni el worker. Las variables GOOGLE_OAUTH_* del
 * .env quedan de respaldo.
 *
 * El secreto es de solo escritura: el servidor nunca lo devuelve, así que el
 * campo empieza vacío y se vacía al guardar.
 */
export function GoogleOAuthCard({ canEdit }: { canEdit: boolean }) {
  const [state, setState] = useState<GoogleOAuthState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [redirectUri, setRedirectUri] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  /** El último resultado de "Verificar ahora": solo vive en pantalla, no se guarda. */
  const [check, setCheck] = useState<{ ok: boolean; at: Date } | null>(null);

  async function verify() {
    setChecking(true);
    try {
      const r = await api.post<{ estado: "valido" | "invalido"; verificadoEn: string }>("/platform/google-oauth/verify", {});
      setCheck({ ok: r.estado === "valido", at: new Date(r.verificadoEn) });
    } catch (err) {
      // Una falla de red no prueba nada sobre el secreto: se avisa, sin marcarlo como inválido.
      setCheck(null);
      toast.error(err instanceof ApiError ? err.message : "No se pudo verificar");
    } finally {
      setChecking(false);
    }
  }

  async function load() {
    try {
      const data = await api.get<GoogleOAuthState>("/platform/google-oauth");
      setState(data);
      setClientId(data.guardado?.clientId ?? "");
      setRedirectUri(data.guardado?.redirectUri ?? data.redirectUriSugerida);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo cargar la configuración de Google");
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (error) return <p className="error-text">{error}</p>;
  if (!state) return null;

  const stored = state.guardado;
  const changed =
    clientId.trim() !== (stored?.clientId ?? "") ||
    redirectUri.trim() !== (stored?.redirectUri ?? "") ||
    clientSecret !== "";
  // La primera vez hace falta el secreto; después se puede corregir lo demás sin repegarlo.
  const valid = clientId.trim() !== "" && redirectUri.trim() !== "" && (stored !== null || clientSecret !== "");

  async function save() {
    setSaving(true);
    try {
      await api.put("/platform/google-oauth", {
        clientId: clientId.trim(),
        redirectUri: redirectUri.trim(),
        ...(clientSecret ? { clientSecret } : {}),
      });
      toast.success("Credenciales de Google guardadas y verificadas. Ya se usan, sin reiniciar nada.");
      setClientSecret("");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo guardar");
    } finally {
      setSaving(false);
    }
  }

  async function removeStored() {
    try {
      await api.delete("/platform/google-oauth");
      toast.success("Se quitó la configuración guardada. Se usan las variables GOOGLE_OAUTH_* del .env.");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo quitar");
    }
  }

  const origen =
    state.origen === "base"
      ? "Guardado en la plataforma (secreto cifrado)"
      : state.origen === "env"
        ? "Tomado de las variables GOOGLE_OAUTH_* del .env"
        : "Sin configurar";

  return (
    <section className="card" style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Google Calendar (OAuth)</h2>
        <Badge variant={state.origen === "ninguno" ? "destructive" : "success"}>
          {state.origen === "ninguno" ? (
            "Sin configurar"
          ) : (
            <>
              <Check size={12} /> Configurado
            </>
          )}
        </Badge>
      </div>
      <p className="muted">
        Es el cliente de OAuth de Google Cloud Console (tipo "Aplicación web") que usan todas las clínicas para
        conectar su calendario. Es uno solo para la plataforma: agregar una clínica no requiere tocar nada aquí.
      </p>
      <p>
        <strong>Valor en uso:</strong> {origen}
        {state.origen === "ninguno" && (
          <span className="error-text"> — ninguna clínica puede conectar su calendario de Google.</span>
        )}
      </p>

      {state.origen !== "ninguno" && (
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", margin: "12px 0" }}>
          <Button variant="outline" disabled={checking} onClick={verify}>
            {checking ? "Verificando…" : "Verificar ahora"}
          </Button>
          {check &&
            (check.ok ? (
              <Badge variant="success">
                <Check size={12} /> Google lo acepta · verificado a las{" "}
                {check.at.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}
              </Badge>
            ) : (
              <Badge variant="destructive">Google lo rechaza: reemplaza el secreto</Badge>
            ))}
        </div>
      )}

      {canEdit && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", margin: "16px 0" }}>
          <div style={{ flexBasis: "100%" }}>
            <Label htmlFor="g-client-id">ID de cliente</Label>
            <Input
              id="g-client-id"
              value={clientId}
              spellCheck={false}
              placeholder="123456-abc.apps.googleusercontent.com"
              onChange={(e) => setClientId(e.target.value)}
            />
          </div>
          <div style={{ flexBasis: "100%" }}>
            <Label htmlFor="g-secret">
              {stored ? "Reemplazar el secreto (opcional)" : "Secreto del cliente"}
            </Label>
            <Input
              id="g-secret"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={clientSecret}
              placeholder="GOCSPX-…"
              onChange={(e) => setClientSecret(e.target.value)}
            />
          </div>
          <div style={{ flexBasis: "100%" }}>
            <Label htmlFor="g-redirect">URI de redirección autorizada</Label>
            <Input
              id="g-redirect"
              value={redirectUri}
              spellCheck={false}
              onChange={(e) => setRedirectUri(e.target.value)}
            />
            <p className="muted" style={{ margin: "4px 0 0" }}>
              Tiene que estar registrada en Google Cloud Console igual, carácter por carácter. Se verifica con
              Google antes de guardar, el secreto se cifra y no se vuelve a mostrar.
            </p>
          </div>
          <Button disabled={!changed || !valid || saving} onClick={save}>
            {saving ? "Verificando…" : "Guardar"}
          </Button>
          {stored && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline">Quitar lo guardado</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>¿Quitar la configuración guardada?</AlertDialogTitle>
                  <AlertDialogDescription>
                    {state.respaldoEnEnv
                      ? "Se borra de la plataforma y desde ahí se usan las variables GOOGLE_OAUTH_* del .env."
                      : "No hay variables GOOGLE_OAUTH_* completas en el .env que la reemplacen: ninguna clínica podrá conectar ni refrescar su cuenta de Google."}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancelar</AlertDialogCancel>
                  <AlertDialogAction onClick={removeStored}>Quitar</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      )}
    </section>
  );
}
