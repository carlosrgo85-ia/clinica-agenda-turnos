import { useEffect, useState } from "react";
import { api, ApiError } from "../../api/client";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

export type CalendarProvider = "google" | "microsoft";

export const PROVIDER_LABELS: Record<CalendarProvider, string> = {
  google: "Google",
  microsoft: "Microsoft",
};

export interface CalendarAccountOption {
  id: string;
  email: string;
  revokedAt: string | null;
  provider: CalendarProvider;
}

/** Qué cuenta (de qué proveedor) y qué calendario de esa cuenta se eligió. */
export interface CalendarSelection {
  provider: CalendarProvider;
  accountId: string | null;
  calendarId: string | null;
}

interface CalendarOption {
  id: string;
  summary: string;
}

const NONE = "__none__";

/** El proveedor y la cuenta viajan juntos en un solo valor del selector. */
const encode = (provider: CalendarProvider, id: string) => `${provider}:${id}`;

/**
 * Cuando se guarda, el backend necesita saber el proveedor y la cuenta que le
 * corresponde. Con Google, `googleAccountId: null` es la cuenta de servicio
 * (el modo viejo); con Microsoft la cuenta es obligatoria.
 */
export function credentialPayload(selection: Pick<CalendarSelection, "provider" | "accountId">) {
  return selection.provider === "microsoft"
    ? { provider: "microsoft", microsoftAccountId: selection.accountId }
    : { provider: "google", googleAccountId: selection.accountId };
}

/**
 * Cuenta → calendario de esa cuenta. La lista de calendarios se pide recién
 * cuando se elige una cuenta (GET .../<proveedor>-accounts/:id/calendars) —
 * evita pedirle al proveedor la lista de todas las cuentas de una.
 */
export function CalendarPicker({
  clinicId,
  accounts,
  value,
  onChange,
}: {
  clinicId: string;
  accounts: CalendarAccountOption[];
  value: CalendarSelection;
  onChange: (value: CalendarSelection) => void;
}) {
  const [calendars, setCalendars] = useState<CalendarOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!value.accountId) {
      setCalendars([]);
      return;
    }
    setLoading(true);
    setError(null);
    api
      .get<{ calendarios: CalendarOption[] }>(
        `/dashboard/clinics/${clinicId}/${value.provider}-accounts/${value.accountId}/calendars`
      )
      .then((data) => setCalendars(data.calendarios))
      .catch((err) => setError(err instanceof ApiError ? err.message : "No se pudieron leer los calendarios"))
      .finally(() => setLoading(false));
  }, [clinicId, value.provider, value.accountId]);

  const usableAccounts = accounts.filter((a) => !a.revokedAt);

  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <Label>Cuenta</Label>
      <Select
        value={value.accountId ? encode(value.provider, value.accountId) : NONE}
        onValueChange={(selected) => {
          if (selected === NONE) {
            onChange({ provider: "google", accountId: null, calendarId: null });
            return;
          }
          const account = usableAccounts.find((a) => encode(a.provider, a.id) === selected);
          if (account) onChange({ provider: account.provider, accountId: account.id, calendarId: null });
        }}
      >
        <SelectTrigger style={{ minWidth: 260 }} aria-label="Cuenta">
          <SelectValue placeholder="Elegir cuenta…" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Sin cuenta</SelectItem>
          {usableAccounts.map((a) => (
            <SelectItem key={encode(a.provider, a.id)} value={encode(a.provider, a.id)}>
              {a.email} · {PROVIDER_LABELS[a.provider]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <Label>Calendario de esa cuenta</Label>
      <Select
        value={value.calendarId ?? NONE}
        disabled={!value.accountId || loading}
        onValueChange={(selected) => onChange({ ...value, calendarId: selected === NONE ? null : selected })}
      >
        <SelectTrigger style={{ minWidth: 220 }} aria-label="Calendario de esa cuenta">
          <SelectValue placeholder={loading ? "Cargando…" : "Elegir calendario…"} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Sin calendario</SelectItem>
          {calendars.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.summary}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
