import { useEffect, useState } from "react";
import { MessageSquare } from "lucide-react";
import { useEffectiveClinicId } from "../auth/AuthContext";
import { ClinicScopeRequired } from "../components/shell/ClinicScopeRequired";
import { api, ApiError } from "../api/client";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { StatusBadge, type Status } from "../components/ui/status-badge";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { PageSkeleton, Skeleton } from "../components/ui/skeleton";
import { Sheet, SheetContent, SheetTitle } from "../components/ui/sheet";
import { formatDateTime } from "../lib/format";

interface PatientRow {
  id: string;
  name: string | null;
  phone: string;
  stage: string;
  updatedAt: string;
}

interface MessageRow {
  id: string;
  role: "patient" | "assistant";
  content: string;
  createdAt: string;
}

export function ConversationsPage() {
  const clinicId = useEffectiveClinicId();

  const [patients, setPatients] = useState<PatientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PatientRow | null>(null);

  async function load() {
    if (!clinicId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<PatientRow[]>(`/dashboard/clinics/${clinicId}/conversations`);
      setPatients(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo cargar la lista de conversaciones");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinicId]);

  if (!clinicId) {
    return <ClinicScopeRequired />;
  }

  return (
    <div>
      <h1>Conversaciones</h1>
      <p className="muted" style={{ marginTop: -8, marginBottom: 24 }}>
        Auditoría de lo que habló el asistente con cada paciente. Solo lectura.
      </p>

      {loading ? (
        <PageSkeleton />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : patients.length === 0 ? (
        <EmptyState icon={MessageSquare} title="Sin conversaciones todavía" description="Van a aparecer aquí apenas un paciente le escriba al asistente." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Paciente</TableHead>
              <TableHead>Teléfono</TableHead>
              <TableHead>Etapa</TableHead>
              <TableHead>Última actividad</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {patients.map((p) => (
              <TableRow key={p.id} style={{ cursor: "pointer" }} onClick={() => setSelected(p)}>
                <TableCell>{p.name || "—"}</TableCell>
                <TableCell>{p.phone}</TableCell>
                <TableCell>
                  <StatusBadge status={p.stage as Status} />
                </TableCell>
                <TableCell>{formatDateTime(p.updatedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        {selected && (
          <SheetContent side="right">
            <SheetTitle>{selected.name || selected.phone}</SheetTitle>
            <ConversationThread clinicId={clinicId} patientPhone={selected.phone} />
          </SheetContent>
        )}
      </Sheet>
    </div>
  );
}

function ConversationThread({ clinicId, patientPhone }: { clinicId: string; patientPhone: string }) {
  const [messages, setMessages] = useState<MessageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMessages(null);
    setError(null);
    api
      .get<MessageRow[]>(`/dashboard/clinics/${clinicId}/conversations/${encodeURIComponent(patientPhone)}`)
      .then(setMessages)
      .catch((err) => setError(err instanceof ApiError ? err.message : "No se pudo cargar la conversación"));
  }, [clinicId, patientPhone]);

  if (error) return <ErrorState message={error} compact />;
  if (!messages) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
        <Skeleton style={{ height: 40 }} />
        <Skeleton style={{ height: 40, width: "70%" }} />
        <Skeleton style={{ height: 40 }} />
      </div>
    );
  }
  if (messages.length === 0) return <p className="muted">Sin mensajes.</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 16 }}>
      {messages.map((m) => (
        <div
          key={m.id}
          style={{
            alignSelf: m.role === "patient" ? "flex-start" : "flex-end",
            maxWidth: "85%",
            background: m.role === "patient" ? "var(--muted)" : "var(--primary)",
            color: m.role === "patient" ? "var(--foreground)" : "var(--primary-foreground)",
            borderRadius: "var(--radius)",
            padding: "8px 12px",
          }}
        >
          <div>{m.content}</div>
          <div className="muted" style={{ fontSize: "0.75em", marginTop: 4, color: "inherit", opacity: 0.7 }}>
            {formatDateTime(m.createdAt)}
          </div>
        </div>
      ))}
    </div>
  );
}
