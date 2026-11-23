/** Lo que devuelve `GET .../reports/:report`: todos los reportes tienen esta misma forma. */
export type InformeClave = "resumen" | "ocupacion" | "pacientes" | "servicios" | "origen" | "campanas" | "derivaciones" | "motivos" | "cancelaciones" | "reagendadas" | "atendidos" | "sin-confirmar";

export interface Indicador {
  clave: string;
  etiqueta: string;
  valor: number | null;
  formato: "numero" | "porcentaje";
  /** Qué cuenta exactamente: las definiciones importan en un reporte. */
  ayuda?: string;
}

export interface TablaDeResumen {
  clave: string;
  titulo: string;
  columnas: string[];
  filas: Array<Array<string | number | null>>;
  visual?: "barras" | "calor";
  unidad?: "%";
}

export interface Informe {
  informe: InformeClave;
  titulo: string;
  periodo: { desde: string; hasta: string; base: "evento" | "cita" };
  /** Desde cuándo hay eventos de cita (YYYY-MM-DD). */
  desdeDatos: string | null;
  kpis: Indicador[];
  tablas: TablaDeResumen[];
  detalle: {
    titulo: string;
    columnas: string[];
    filas: Array<Array<string | number | null>>;
    total: number;
    truncado: boolean;
  };
  notas: string[];
}

export const INFORMES: Array<{ clave: InformeClave; etiqueta: string; descripcion: string; conBase: boolean }> = [
  { clave: "resumen", etiqueta: "Resumen", descripcion: "Cómo salieron las citas del período: atendidas, canceladas, sin confirmar.", conBase: false },
  { clave: "ocupacion", etiqueta: "Ocupación", descripcion: "Qué espacios, equipos y profesionales se usan, cuáles quedan vacíos y dónde están los tiempos muertos.", conBase: false },
  { clave: "pacientes", etiqueta: "Pacientes", descripcion: "Pacientes nuevos y recurrentes, y a quiénes hay que contactar porque hace tiempo que no vienen.", conBase: false },
  { clave: "servicios", etiqueta: "Servicios", descripcion: "Qué servicios se piden más, cuáles no se agendan nunca y qué piden los pacientes que la clínica no ofrece.", conBase: false },
  { clave: "origen", etiqueta: "Origen", descripcion: "De dónde vienen las reservas: el asistente de WhatsApp o la clínica desde el panel.", conBase: false },
  { clave: "campanas", etiqueta: "Campañas", descripcion: "Cuántas personas llegaron por cada campaña o promoción, cuántas agendaron y cuántas siguen en seguimiento.", conBase: false },
  { clave: "cancelaciones", etiqueta: "Canceladas", descripcion: "Quién canceló, por qué y con cuánto aviso. No incluye las que el paciente movió a otra hora.", conBase: true },
  { clave: "motivos", etiqueta: "Motivos", descripcion: "Por qué se cancelan las citas, agrupado: trabajo, salud, viaje, quejas y más.", conBase: true },
  { clave: "reagendadas", etiqueta: "Reagendadas", descripcion: "Citas que cambiaron de hora o de profesional, de dónde a dónde.", conBase: true },
  { clave: "atendidos", etiqueta: "Atendidos por profesional", descripcion: "Citas y pacientes atendidos, separando lo confirmado por una persona de lo automático.", conBase: false },
  { clave: "sin-confirmar", etiqueta: "Sin confirmar", descripcion: "Citas ya pasadas que nadie marcó como atendidas ni canceló.", conBase: false },
  { clave: "derivaciones", etiqueta: "Derivaciones", descripcion: "Cuántas veces el asistente pasó la conversación a una persona, por qué y cuánto se tardó en atenderlas.", conBase: false },
];

export function formatearValor(i: Pick<Indicador, "valor" | "formato">): string {
  if (i.valor === null) return "—";
  return i.formato === "porcentaje" ? `${i.valor.toLocaleString("es", { maximumFractionDigits: 1 })} %` : i.valor.toLocaleString("es", { maximumFractionDigits: 1 });
}

/** YYYY-MM-DD del día de hoy en el navegador, con `dias` de corrimiento. */
export function claveDeDia(dias = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  const dos = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
}
