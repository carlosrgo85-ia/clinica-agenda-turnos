/**
 * Armado de CSV para exportar reportes.
 *
 * Tres cuidados que no son obvios:
 * - **BOM de UTF-8** al principio: sin él Excel abre el archivo en otra codificación y
 *   los acentos y la eñe salen rotos.
 * - **Inyección de fórmulas**: una celda que empieza con `=`, `+`, `-`, `@`, tabulador o
 *   retorno de carro se interpreta como fórmula al abrirla en Excel, y el contenido sale
 *   de lo que escribió un paciente o el personal (un nombre, un motivo de cancelación).
 *   Se neutraliza anteponiendo una comilla simple, como recomienda OWASP.
 * - **Comillas, comas y saltos de línea** dentro de una celda (un motivo de cancelación
 *   con una coma) se escapan según RFC 4180.
 *
 * El separador es la coma. Algunos Excel en español esperan punto y coma: si al abrirlo
 * queda todo en una columna, se importa con "Datos → Desde texto" eligiendo la coma.
 */

export type CsvCell = string | number | boolean | null | undefined;

const BOM = "﻿";

/** Neutraliza una celda de texto que Excel interpretaría como fórmula. */
export function neutralizeFormula(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  // Los números se escriben tal cual: un `-5` es un número, no una fórmula.
  const text = typeof value === "number" ? String(value) : neutralizeFormula(String(value));
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(columns: string[], rows: CsvCell[][]): string {
  const lineas = [columns, ...rows].map((fila) => fila.map(csvCell).join(","));
  return BOM + lineas.join("\r\n") + "\r\n";
}
