import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ExternalLink } from "lucide-react";
import { useAuth, useEffectiveClinicId } from "../auth/AuthContext";
import { ClinicScopeRequired } from "../components/shell/ClinicScopeRequired";
import { api, ApiError } from "../api/client";
import { RequirePermission } from "../auth/RequirePermission";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Switch } from "../components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { ErrorState } from "../components/ui/error-state";
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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import {
  CalendarPicker,
  credentialPayload,
  PROVIDER_LABELS,
  type CalendarAccountOption,
  type CalendarProvider,
  type CalendarSelection,
} from "../components/calendars/CalendarPicker";

interface GoogleAccount {
  id: string;
  email: string;
  scope: string;
  revokedAt: string | null;
  createdAt: string;
}

interface ProfessionalCalendar {
  id: string;
  name: string;
  /** El nombre es histórico: guarda el id del calendario en cualquier proveedor. */
  googleCalendarId: string | null;
  calendarProvider: CalendarProvider;
  blockSyncEnabled: boolean;
  googleAccount: { id: string; email: string } | null;
  microsoftAccount: { id: string; email: string } | null;
  calendarioEfectivo: string | null;
  proveedorEfectivo: CalendarProvider;
  /** "sin_cuenta": calendario de Microsoft sin cuenta — no hay espejo hasta conectar una. */
  credencial: "oauth" | "servicio" | "sin_cuenta";
}

interface CalendarsResponse {
  conectarCuentaUrl: string | null;
  oauthDisponible: boolean;
  conectarMicrosoftUrl: string | null;
  microsoftDisponible: boolean;
  cuentasConectadas: GoogleAccount[];
  cuentasMicrosoft: GoogleAccount[];
  sharedCalendarId: string | null;
  sharedCalendarProvider: CalendarProvider;
  sharedCalendarAccount: { id: string; email: string } | null;
  sharedCalendarMicrosoftAccount: { id: string; email: string } | null;
  modo: "compartido" | "por_profesional";
  profesionales: ProfessionalCalendar[];
}

export function CalendarsPage() {
  const { hasPermission } = useAuth();
  const clinicId = useEffectiveClinicId();
  const canEdit = hasPermission("calendarios.editar");

  const [data, setData] = useState<CalendarsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Prender el switch todavía no elige ningún calendario — solo revela el
  // selector. Sin esto, "activar" mandaba `sharedCalendarId: null` (lo que
  // ya había, nada) y el switch volvía a "Desactivado" al recargar, aunque
  // el toast dijera que se había guardado.
  const [revealSharedPicker, setRevealSharedPicker] = useState(false);
  // Borrador local: elegir cuenta y calendario no guarda solo — recién al
  // tocar "Guardar" se manda el PUT. Si guardara en cada paso, elegir la
  // cuenta ya mandaría `sharedCalendarId: null` (el calendario todavía no
  // se eligió) y el backend lo interpretaría como "desactivar".
  const [sharedDraft, setSharedDraft] = useState<CalendarSelection>({
    provider: "google",
    accountId: null,
    calendarId: null,
  });

  useEffect(() => {
    if (data) {
      setSharedDraft({
        provider: data.sharedCalendarProvider,
        accountId:
          (data.sharedCalendarProvider === "microsoft"
            ? data.sharedCalendarMicrosoftAccount?.id
            : data.sharedCalendarAccount?.id) ?? null,
        calendarId: data.sharedCalendarId,
      });
    }
  }, [data]);

  // `silent` recarga sin tirar la pantalla a un esqueleto y sin pisar los datos
  // que ya se ven si la recarga falla: es la que se usa al volver a la pestaña.
  async function load({ silent = false }: { silent?: boolean } = {}) {
    if (!clinicId) return;
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const result = await api.get<CalendarsResponse>(`/dashboard/clinics/${clinicId}/calendars`);
      // Si nada cambió se conserva el objeto: reemplazarlo reinicia el borrador
      // del calendario compartido (efecto sobre `data`) y pisaría lo que la
      // persona estaba eligiendo al volver a la pestaña.
      setData((prev) => (silent && prev && JSON.stringify(prev) === JSON.stringify(result) ? prev : result));
    } catch (err) {
      if (!silent) {
        setError(err instanceof ApiError ? err.message : "No se pudo cargar la configuración de calendarios");
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinicId]);

  // "Conectar cuenta" abre el flujo de OAuth en otra pestaña. Al terminar, la
  // persona vuelve a esta y los datos seguían siendo los de antes de conectar:
  // se recargan solos cuando la pestaña recupera el foco.
  useEffect(() => {
    if (!clinicId) return;
    let last = 0;
    function refresh() {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - last < 2000) return; // focus y visibilitychange suelen llegar juntos
      last = now;
      load({ silent: true });
    }
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinicId]);

  if (!clinicId) {
    return <ClinicScopeRequired />;
  }
  if (loading) return <PageSkeleton />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return null;

  async function disconnectAccount(provider: CalendarProvider, accountId: string) {
    try {
      await api.delete(`/dashboard/clinics/${clinicId}/${provider}-accounts/${accountId}`);
      toast.success("Cuenta desconectada.");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo desconectar la cuenta");
    }
  }

  async function disableShared() {
    try {
      await api.put(`/dashboard/clinics/${clinicId}/calendars/shared`, { sharedCalendarId: null });
      toast.success("Calendario compartido desactivado.");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo cambiar el modo");
    }
  }

  /**
   * El switch prendido, sin elegir todavía cuenta/calendario, no manda
   * nada al backend — no hay ningún `sharedCalendarId` real para guardar
   * todavía. Apagarlo si ya estaba activo sí es una acción real.
   */
  function handleSharedSwitch(checked: boolean) {
    setRevealSharedPicker(checked);
    if (!checked && data!.modo === "compartido") {
      disableShared();
    }
  }

  async function saveShared(selection: CalendarSelection) {
    try {
      await api.put(`/dashboard/clinics/${clinicId}/calendars/shared`, {
        sharedCalendarId: selection.calendarId,
        ...credentialPayload(selection),
      });
      toast.success("Calendario compartido guardado.");
      setRevealSharedPicker(false);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo guardar");
    }
  }

  async function saveProfessionalCalendar(professionalId: string, selection: CalendarSelection) {
    try {
      await api.put(`/dashboard/clinics/${clinicId}/professionals/${professionalId}/calendar`, {
        googleCalendarId: selection.calendarId,
        ...credentialPayload(selection),
      });
      toast.success("Calendario guardado.");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo guardar");
    }
  }

  async function toggleBlockSync(professionalId: string, enabled: boolean) {
    try {
      await api.put(`/dashboard/clinics/${clinicId}/professionals/${professionalId}/calendar`, {
        blockSyncEnabled: enabled,
      });
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo cambiar");
    }
  }

  const accounts: Array<CalendarAccountOption & { scope: string }> = [
    ...data.cuentasConectadas.map((a) => ({ ...a, provider: "google" as const })),
    ...data.cuentasMicrosoft.map((a) => ({ ...a, provider: "microsoft" as const })),
  ];

  return (
    <div>
      <h1>Calendarios</h1>

      <section className="card" style={{ marginBottom: 24 }}>
        <h2>Cuentas conectadas</h2>
        <p className="muted">
          Conecta la cuenta donde la clínica lleva su agenda. Las citas se reflejan ahí y los
          bloqueos personales se respetan al ofrecer horarios.
        </p>
        {!data.oauthDisponible && !data.microsoftDisponible && (
          <p className="error-text">
            La conexión con calendarios no está disponible por el momento: la plataforma todavía no la tiene
            configurada. No es algo que puedas resolver desde acá; avisa a soporte.
          </p>
        )}
        {accounts.some((a) => a.revokedAt) && (
          <div className="card" role="alert" style={{ borderLeft: "4px solid var(--destructive)", margin: "12px 0" }}>
            <strong>Hay una cuenta con el acceso caído.</strong>
            <p style={{ margin: "4px 0 0" }}>
              Mientras no se vuelva a autorizar, las citas nuevas no se reflejan en esa agenda y sus bloqueos
              personales no se tienen en cuenta al ofrecer horarios. Pulsa <strong>Reconectar</strong> y vuelve a
              autorizar con esa cuenta. Pasa cuando la cuenta revoca el permiso desde su configuración de Google, o
              cuando Google lo vence (por ejemplo, si la aplicación de la plataforma todavía está en modo de
              prueba, el permiso dura 7 días).
            </p>
          </div>
        )}
        <RequirePermission permission="calendarios.editar">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {data.oauthDisponible && (
              <a href={data.conectarCuentaUrl!} target="_blank" rel="noreferrer">
                <Button type="button" variant="outline">
                  <ExternalLink size={16} /> Conectar Google Calendar
                </Button>
              </a>
            )}
            {data.microsoftDisponible && (
              <a href={data.conectarMicrosoftUrl!} target="_blank" rel="noreferrer">
                <Button type="button" variant="outline">
                  <ExternalLink size={16} /> Conectar Microsoft 365 / Outlook
                </Button>
              </a>
            )}
          </div>
        </RequirePermission>

        {accounts.length > 0 && (
          <Table style={{ marginTop: 16 }}>
            <TableHeader>
              <TableRow>
                <TableHead>Cuenta</TableHead>
                <TableHead>Proveedor</TableHead>
                <TableHead>Permisos</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((account) => (
                <TableRow key={`${account.provider}:${account.id}`}>
                  <TableCell>{account.email}</TableCell>
                  <TableCell>{PROVIDER_LABELS[account.provider]}</TableCell>
                  <TableCell className="muted">{account.scope}</TableCell>
                  <TableCell>
                    {account.revokedAt ? <Badge variant="destructive">Revocada</Badge> : <Badge>Activa</Badge>}
                  </TableCell>
                  <TableCell>
                    <RequirePermission permission="calendarios.editar">
                      <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end", whiteSpace: "nowrap" }}>
                      {account.revokedAt && (account.provider === "microsoft" ? data.conectarMicrosoftUrl : data.conectarCuentaUrl) && (
                        <a
                          href={(account.provider === "microsoft" ? data.conectarMicrosoftUrl : data.conectarCuentaUrl)!}
                          target="_blank"
                          rel="noreferrer"
                          style={{ display: "inline-flex" }}
                        >
                          <Button type="button" size="sm">
                            Reconectar
                          </Button>
                        </a>
                      )}
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="outline" size="sm">
                            Desconectar
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>¿Desconectar {account.email}?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Los calendarios que usaban esta cuenta se quedan sin espejo hasta que se
                              vuelva a conectar.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancelar</AlertDialogCancel>
                            <AlertDialogAction onClick={() => disconnectAccount(account.provider, account.id)}>
                              Desconectar
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                      </div>
                    </RequirePermission>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="card" style={{ marginBottom: 24 }}>
        <h2>Calendario compartido</h2>
        <p className="muted">Si se activa, todo el equipo se espeja en un único calendario.</p>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <Switch
            checked={data.modo === "compartido" || revealSharedPicker}
            onCheckedChange={handleSharedSwitch}
            disabled={!canEdit}
          />
          <span>{data.modo === "compartido" ? "Activado" : revealSharedPicker ? "Pendiente de guardar" : "Desactivado"}</span>
        </div>
        {(data.modo === "compartido" || revealSharedPicker) && (
          <>
            {data.modo === "compartido" &&
              (data.sharedCalendarProvider === "microsoft"
                ? data.sharedCalendarMicrosoftAccount
                : data.sharedCalendarAccount) && (
                <p className="muted" style={{ marginBottom: 8 }}>
                  Cuenta actual:{" "}
                  {(data.sharedCalendarProvider === "microsoft"
                    ? data.sharedCalendarMicrosoftAccount
                    : data.sharedCalendarAccount
                  )!.email}{" "}
                  · {PROVIDER_LABELS[data.sharedCalendarProvider]}
                </p>
              )}
            {data.modo !== "compartido" && (
              <p className="muted" style={{ marginBottom: 8 }}>
                Elige una cuenta y un calendario, y guarda para activarlo.
              </p>
            )}
            {canEdit && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
                <CalendarPicker
                  clinicId={clinicId}
                  accounts={accounts}
                  value={sharedDraft}
                  onChange={setSharedDraft}
                />
                <Button
                  size="sm"
                  disabled={!sharedDraft.accountId || !sharedDraft.calendarId}
                  onClick={() => saveShared(sharedDraft)}
                >
                  Guardar
                </Button>
              </div>
            )}
          </>
        )}
      </section>

      <section className="card">
        <h2>Por profesional</h2>
        {data.modo === "compartido" && (
          <p className="muted">El calendario compartido manda mientras esté activado.</p>
        )}
        <Table style={{ marginTop: 12 }}>
          <TableHeader>
            <TableRow>
              <TableHead>Profesional</TableHead>
              <TableHead>Calendario efectivo</TableHead>
              <TableHead>Credencial</TableHead>
              <TableHead>Importar bloqueos</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.profesionales.map((p) => (
              <ProfessionalCalendarRow
                key={p.id}
                clinicId={clinicId}
                professional={p}
                accounts={accounts}
                disabled={data.modo === "compartido" || !canEdit}
                onSaveCalendar={(selection) => saveProfessionalCalendar(p.id, selection)}
                onToggleBlockSync={(enabled) => toggleBlockSync(p.id, enabled)}
              />
            ))}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}

function ProfessionalCalendarRow({
  clinicId,
  professional,
  accounts,
  disabled,
  onSaveCalendar,
  onToggleBlockSync,
}: {
  clinicId: string;
  professional: ProfessionalCalendar;
  accounts: CalendarAccountOption[];
  disabled: boolean;
  onSaveCalendar: (selection: CalendarSelection) => void;
  onToggleBlockSync: (enabled: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<CalendarSelection>({
    provider: professional.calendarProvider,
    accountId:
      (professional.calendarProvider === "microsoft"
        ? professional.microsoftAccount?.id
        : professional.googleAccount?.id) ?? null,
    calendarId: professional.googleCalendarId,
  });

  return (
    <TableRow>
      <TableCell>{professional.name}</TableCell>
      <TableCell className="muted">{professional.calendarioEfectivo ?? "sin enlazar"}</TableCell>
      <TableCell>
        {professional.credencial === "sin_cuenta" ? (
          <Badge variant="destructive">Sin cuenta conectada</Badge>
        ) : (
          <Badge variant={professional.credencial === "oauth" ? "default" : "secondary"}>
            {PROVIDER_LABELS[professional.proveedorEfectivo]} ·{" "}
            {professional.credencial === "oauth" ? "OAuth" : "Cuenta de servicio"}
          </Badge>
        )}
      </TableCell>
      <TableCell>
        <Switch
          checked={professional.blockSyncEnabled}
          onCheckedChange={onToggleBlockSync}
          disabled={disabled}
        />
      </TableCell>
      <TableCell>
        {!disabled && (
          <Dialog open={open} onOpenChange={setOpen}>
            <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
              Elegir calendario
            </Button>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Calendario de {professional.name}</DialogTitle>
              </DialogHeader>
              <CalendarPicker clinicId={clinicId} accounts={accounts} value={selection} onChange={setSelection} />
              <DialogFooter>
                <Button
                  onClick={() => {
                    onSaveCalendar(selection);
                    setOpen(false);
                  }}
                >
                  Guardar
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </TableCell>
    </TableRow>
  );
}
