import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import { useAuth, useEffectiveClinicId } from "../auth/AuthContext";
import { ClinicScopeRequired } from "../components/shell/ClinicScopeRequired";
import { api, ApiError } from "../api/client";
import { Button } from "../components/ui/button";
import { ErrorState } from "../components/ui/error-state";
import { PageSkeleton } from "../components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { WeeklyHoursEditor, type TramoInput } from "../components/working-hours/WeeklyHoursEditor";
import { ScheduleExceptions } from "../components/working-hours/ScheduleExceptions";

interface ProfessionalHours {
  id: string;
  name: string;
  heredado: boolean;
  tramos: TramoInput[];
}

interface WorkingHoursResponse {
  faltaCargarHorario: boolean;
  clinica: { tramos: TramoInput[] };
  profesionales: ProfessionalHours[];
}

export function WorkingHoursPage() {
  const { hasPermission } = useAuth();
  const clinicId = useEffectiveClinicId();
  const canEdit = hasPermission("horarios.editar");

  const [data, setData] = useState<WorkingHoursResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingClinic, setSavingClinic] = useState(false);

  async function load() {
    if (!clinicId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.get<WorkingHoursResponse>(`/dashboard/clinics/${clinicId}/working-hours`);
      setData(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo cargar el horario");
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
  if (loading) return <PageSkeleton />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return null;

  async function saveClinicHours(tramos: TramoInput[]) {
    setSavingClinic(true);
    try {
      await api.put(`/dashboard/clinics/${clinicId}/working-hours`, { tramos });
      toast.success("Horario de la clínica guardado.");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo guardar el horario");
    } finally {
      setSavingClinic(false);
    }
  }

  async function saveProfessionalHours(professionalId: string, tramos: TramoInput[]) {
    try {
      await api.put(`/dashboard/clinics/${clinicId}/professionals/${professionalId}/working-hours`, { tramos });
      toast.success(tramos.length === 0 ? "Vuelve a heredar el horario de la clínica." : "Horario guardado.");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo guardar el horario");
    }
  }

  return (
    <div>
      <h1>Horarios de atención</h1>

      {data.faltaCargarHorario && (
        <div
          className="card"
          style={{ marginBottom: 24, borderColor: "var(--destructive)", display: "flex", gap: 10, alignItems: "center" }}
        >
          <AlertTriangle size={18} color="var(--destructive)" />
          <span>No hay horario cargado — el asistente no puede agendar ni ofrecer horarios hasta que lo cargues.</span>
        </div>
      )}

      <section className="card" style={{ marginBottom: 24 }}>
        <h2>Horario de la clínica</h2>
        <WeeklyHoursEditor
          initialTramos={data.clinica.tramos}
          readOnly={!canEdit}
          saving={savingClinic}
          onSave={saveClinicHours}
        />
      </section>

      {data.profesionales.length > 0 && (
        <section className="card" style={{ marginBottom: 24 }}>
          <h2>Por profesional</h2>
          <Tabs defaultValue={data.profesionales[0].id}>
            <TabsList>
              {data.profesionales.map((p) => (
                <TabsTrigger key={p.id} value={p.id}>
                  {p.name}
                </TabsTrigger>
              ))}
            </TabsList>
            {data.profesionales.map((p) => (
              <TabsContent key={p.id} value={p.id}>
                <ProfessionalHoursEditor
                  professional={p}
                  readOnly={!canEdit}
                  onSave={(tramos) => saveProfessionalHours(p.id, tramos)}
                />
              </TabsContent>
            ))}
          </Tabs>
        </section>
      )}

      <ScheduleExceptions
        clinicId={clinicId}
        professionals={data.profesionales.map((p) => ({ id: p.id, name: p.name }))}
        canEdit={canEdit}
      />
    </div>
  );
}

function ProfessionalHoursEditor({
  professional,
  readOnly,
  onSave,
}: {
  professional: ProfessionalHours;
  readOnly: boolean;
  onSave: (tramos: TramoInput[]) => void;
}) {
  const [defining, setDefining] = useState(!professional.heredado);

  if (professional.heredado && !defining) {
    return (
      <div>
        <p className="muted">Hereda el horario de la clínica.</p>
        {!readOnly && (
          <Button variant="outline" size="sm" onClick={() => setDefining(true)}>
            Definir horario propio
          </Button>
        )}
      </div>
    );
  }

  return (
    <div>
      <WeeklyHoursEditor initialTramos={professional.tramos} readOnly={readOnly} onSave={onSave} />
      {!readOnly && !professional.heredado && (
        <Button variant="ghost" size="sm" onClick={() => onSave([])} style={{ marginTop: 8 }}>
          Volver a heredar el horario de la clínica
        </Button>
      )}
    </div>
  );
}
