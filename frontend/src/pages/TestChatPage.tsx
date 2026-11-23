import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { FlaskConical, RotateCcw, Send } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "../api/client";
import { useEffectiveClinicId } from "../auth/AuthContext";
import { ClinicScopeRequired } from "../components/shell/ClinicScopeRequired";
import { PageContainer } from "../components/shell/PageContainer";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
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
import { PageSkeleton } from "../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";
import {
  resumirDecision,
  type CitaDePrueba,
  type ConversacionDePrueba,
  type Entrada,
  type TurnoDePrueba,
} from "../lib/test-chat";

/**
 * Chat de pruebas: hablar con el asistente desde el panel, sin pasar por WhatsApp.
 *
 * Es el MISMO asistente que contesta a los pacientes (mismo prompt, mismas reglas de agenda), así que sirve para probar
 * el tono, un cambio de configuración, una campaña o el recorrido completo de agendar. Lo que cambia es lo que NO sale
 * hacia afuera: nada va por WhatsApp, no se avisa a ningún profesional y una derivación a una persona no se guarda.
 * Las citas que se agenden acá SÍ se crean (para poder probar cambiarlas o cancelarlas) y se borran al reiniciar o,
 * si se olvida, solas a las 2 horas.
 */
export function TestChatPage() {
  const clinicId = useEffectiveClinicId();

  const [entradas, setEntradas] = useState<Entrada[] | null>(null);
  const [citas, setCitas] = useState<CitaDePrueba[]>([]);
  /** La campaña por la que el asistente reconoció que "llegó" esta conversación (solo se muestra, no se elige). */
  const [campana, setCampana] = useState<{ id: string; name: string } | null>(null);
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const fin = useRef<HTMLDivElement | null>(null);

  const cargar = useCallback(async () => {
    if (!clinicId) return;
    try {
      const c = await api.get<ConversacionDePrueba>(`/dashboard/clinics/${clinicId}/test-chat`);
      setEntradas(c.mensajes.map((m) => ({ tipo: m.role === "patient" ? "paciente" : "asistente", texto: m.content })));
      setCitas(c.citas);
      setCampana(c.campana);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo cargar la conversación de prueba");
      setEntradas([]);
    }
  }, [clinicId]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  useEffect(() => {
    fin.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entradas, enviando]);

  if (!clinicId) return <ClinicScopeRequired />;
  if (!entradas) return <PageSkeleton />;

  async function enviar() {
    const mensaje = texto.trim();
    if (!mensaje || enviando) return;
    setEnviando(true);
    setTexto("");
    setEntradas((e) => [...(e ?? []), { tipo: "paciente", texto: mensaje }]);
    try {
      const r = await api.post<TurnoDePrueba>(`/dashboard/clinics/${clinicId}/test-chat`, {
        message: mensaje,
      });
      setEntradas((e) => [
        ...(e ?? []),
        ...r.respuestas.map((t) => ({ tipo: "asistente" as const, texto: t })),
        ...r.notas.map((t) => ({ tipo: "nota" as const, texto: t })),
        ...(r.decisiones.length > 0 ? [{ tipo: "decisiones" as const, decisiones: r.decisiones }] : []),
      ]);
      setCitas(r.citas);
      // Si el mensaje trajo la frase de una campaña, el asistente la reconoció: se muestra cuál.
      void cargarCampana();
    } catch (err) {
      const motivo = err instanceof ApiError ? err.message : "No se pudo obtener la respuesta";
      setEntradas((e) => [...(e ?? []), { tipo: "nota", texto: `⚠ ${motivo}` }]);
    } finally {
      setEnviando(false);
    }
  }

  async function cargarCampana() {
    try {
      const c = await api.get<ConversacionDePrueba>(`/dashboard/clinics/${clinicId}/test-chat`);
      setCampana(c.campana);
    } catch {
      // Es solo informativo.
    }
  }

  async function reiniciar() {
    try {
      await api.delete(`/dashboard/clinics/${clinicId}/test-chat`);
      setEntradas([]);
      setCitas([]);
      setCampana(null);
      toast.success("Conversación de prueba reiniciada.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "No se pudo reiniciar");
    }
  }

  function alApretar(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter envía; Shift+Enter agrega un salto de línea.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      enviar();
    }
  }

  return (
    <PageContainer>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <FlaskConical size={24} /> Chat de pruebas
        </h1>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" disabled={enviando}>
              <RotateCcw size={16} /> Reiniciar
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>¿Reiniciar la conversación de prueba?</AlertDialogTitle>
              <AlertDialogDescription>
                Se borran lo hablado, la ficha de prueba y las citas que se hayan agendado en esta prueba. Nada de esto toca a pacientes ni
                citas reales.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancelar</AlertDialogCancel>
              <AlertDialogAction onClick={reiniciar}>Reiniciar</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      <div className="card" role="note" style={{ margin: "12px 0", borderLeft: "4px solid var(--primary)" }}>
        <strong>Es el asistente de verdad, pero nada sale a la calle.</strong>
        <ul className="muted" style={{ margin: "6px 0 0", paddingLeft: 20, fontSize: "0.9em" }}>
          <li>Nada va por WhatsApp: lo que ves es lo que le habría llegado al paciente.</li>
          <li>No se avisa a ningún profesional ni se escribe en su calendario, y una derivación a una persona no se guarda ni se manda por mail.</li>
          <li>
            Las citas que agendes <strong>sí se crean</strong>, a nombre de un paciente de prueba, y ocupan la agenda hasta que reinicies
            (o se borran solas a las 2 horas sin actividad).
          </li>
          <li>
            Se comporta como un mensaje de la calle: no sabe de antemano qué va a pedir quien escribe. Reconoce una campaña solo si tu
            mensaje trae una de sus frases, igual que por WhatsApp.
          </li>
          <li>Cada mensaje llama al modelo: cuesta como un mensaje real.</li>
        </ul>
      </div>

      {campana && (
        <p className="muted" role="status" style={{ margin: "0 0 8px" }}>
          El asistente reconoció que esta conversación llegó por la campaña <Badge variant="secondary">{campana.name}</Badge>
        </p>
      )}

      <div
        className="card"
        style={{ height: "55vh", minHeight: 320, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, padding: 16 }}
        aria-live="polite"
        aria-label="Conversación de prueba"
      >
        {entradas.length === 0 && !enviando && (
          <p className="muted" style={{ margin: "auto", textAlign: "center" }}>
            Escribe como lo haría un paciente: "Hola, quiero sacar un turno".
          </p>
        )}
        {entradas.map((e, i) => (
          <Linea key={i} entrada={e} />
        ))}
        {enviando && (
          <div className="muted" style={{ fontStyle: "italic" }}>El asistente está escribiendo…</div>
        )}
        <div ref={fin} />
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 12 }}>
        <Textarea
          aria-label="Mensaje"
          rows={2}
          value={texto}
          maxLength={1000}
          disabled={enviando}
          placeholder="Escribe un mensaje (Enter para enviar, Shift+Enter para un salto de línea)"
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={alApretar}
          style={{ flex: 1, resize: "vertical" }}
        />
        <Button onClick={enviar} disabled={enviando || !texto.trim()}>
          <Send size={16} /> Enviar
        </Button>
      </div>

      {citas.length > 0 && (
        <section style={{ marginTop: 24 }}>
          <h3 style={{ marginBottom: 8 }}>Citas de esta prueba</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cuándo</TableHead>
                <TableHead>Paciente</TableHead>
                <TableHead>Servicio</TableHead>
                <TableHead>Profesional</TableHead>
                <TableHead>Espacio</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {citas.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>{c.cuando}</TableCell>
                  <TableCell className={c.patient ? undefined : "muted"}>{c.patient ?? "Sin nombre"}</TableCell>
                  <TableCell>{c.service}</TableCell>
                  <TableCell>{c.professional}</TableCell>
                  <TableCell>{c.room}</TableCell>
                  <TableCell><Badge variant={c.status === "cancelado" ? "outline" : "success"}>{c.status}</Badge></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
    </PageContainer>
  );
}

function Linea({ entrada }: { entrada: Entrada }) {
  if (entrada.tipo === "nota") {
    return (
      <div className="muted" role="note" style={{ fontSize: "0.85em", borderLeft: "3px solid var(--muted-foreground)", paddingLeft: 10 }}>
        {entrada.texto}
      </div>
    );
  }
  if (entrada.tipo === "decisiones") {
    return (
      <details style={{ fontSize: "0.85em" }}>
        <summary className="muted" style={{ cursor: "pointer" }}>Qué entendió el asistente</summary>
        {entrada.decisiones.map((d, i) => (
          <ul key={i} className="muted" style={{ margin: "6px 0", paddingLeft: 20 }}>
            {entrada.decisiones.length > 1 && <li style={{ listStyle: "none", marginLeft: -20 }}><strong>Llamada {i + 1}</strong></li>}
            {resumirDecision(d).map((linea) => (
              <li key={linea}>{linea}</li>
            ))}
          </ul>
        ))}
      </details>
    );
  }
  const esPaciente = entrada.tipo === "paciente";
  return (
    <div
      style={{
        alignSelf: esPaciente ? "flex-end" : "flex-start",
        maxWidth: "78%",
        padding: "8px 12px",
        borderRadius: 12,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        background: esPaciente ? "var(--primary)" : "var(--muted)",
        color: esPaciente ? "var(--primary-foreground)" : "inherit",
      }}
    >
      {entrada.texto}
    </div>
  );
}
