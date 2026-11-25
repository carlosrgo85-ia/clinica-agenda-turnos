/**
 * Convertidor mínimo de Markdown a HTML, solo para publicar la política de privacidad y los términos
 * (`docs/legal/*.md`) como páginas estáticas del sitio público (`scripts/build-site.ts`). Soporta lo que esos
 * documentos usan: títulos (#), párrafos, **negrita**, *cursiva*, `código`, enlaces, listas con "-" y numeradas,
 * tablas con "|" y separadores "---". No es un Markdown completo ni pretende serlo: una librería para tres páginas
 * estáticas no valía una dependencia nueva. El texto se escapa ANTES de aplicar el formato, así un "<" del documento
 * no se convierte en HTML.
 */

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Enlaces internos del borrador (nombre de archivo) → ruta del sitio. */
const ENLACES_DEL_SITIO: Record<string, string> = {
  "politica-de-privacidad.md": "/privacidad",
  "terminos-de-servicio.md": "/terminos",
};

function inline(raw: string): string {
  let t = escapeHtml(raw);
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, texto: string, destino: string) => {
    const href = ENLACES_DEL_SITIO[destino] ?? destino;
    const seguro = /^(\/|https?:\/\/|mailto:)/.test(href) ? href : "#";
    return `<a href="${seguro}">${texto}</a>`;
  });
  return t;
}

/** Los campos pendientes del borrador: [TEXTO EN MAYÚSCULAS ...]. Se resaltan para que no pasen inadvertidos. */
// El `(?!\()` deja afuera el texto de un enlace de Markdown, `[Política de Privacidad](…)`, que no es un campo pendiente.
const PLACEHOLDER = /\[[A-ZÁÉÍÓÚÑ][^\]\n]*\](?!\()/g;

export function findPlaceholders(markdown: string): string[] {
  return [...new Set(markdown.match(PLACEHOLDER) ?? [])];
}

function resaltarPendientes(html: string): string {
  return html.replace(PLACEHOLDER, (m) => `<mark>${m}</mark>`);
}

function esFilaDeTabla(linea: string): boolean {
  return linea.trim().startsWith("|") && linea.trim().endsWith("|");
}

function celdas(linea: string): string[] {
  return linea.trim().slice(1, -1).split("|").map((c) => c.trim());
}

export function markdownToHtml(markdown: string): string {
  const lineas = markdown.replace(/\r\n/g, "\n").split("\n");
  const salida: string[] = [];
  let i = 0;

  while (i < lineas.length) {
    const linea = lineas[i];
    const t = linea.trim();

    if (t === "") { i++; continue; }

    if (/^---+$/.test(t)) { salida.push("<hr>"); i++; continue; }

    const titulo = t.match(/^(#{1,4})\s+(.*)$/);
    if (titulo) {
      const nivel = titulo[1].length;
      salida.push(`<h${nivel}>${inline(titulo[2])}</h${nivel}>`);
      i++;
      continue;
    }

    if (esFilaDeTabla(t)) {
      const filas: string[] = [];
      while (i < lineas.length && esFilaDeTabla(lineas[i])) { filas.push(lineas[i]); i++; }
      const [encabezado, separador, ...cuerpo] = filas;
      const hayEncabezado = separador !== undefined && /^[\s|:-]+$/.test(separador);
      const datos = hayEncabezado ? cuerpo : filas;
      let html = "<table>";
      if (hayEncabezado) html += `<thead><tr>${celdas(encabezado).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>`;
      html += `<tbody>${datos.map((f) => `<tr>${celdas(f).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      salida.push(html);
      continue;
    }

    if (/^[-*]\s+/.test(t)) {
      const items: string[] = [];
      while (i < lineas.length && /^[-*]\s+/.test(lineas[i].trim())) { items.push(lineas[i].trim().replace(/^[-*]\s+/, "")); i++; }
      salida.push(`<ul>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(t)) {
      const items: string[] = [];
      while (i < lineas.length && /^\d+\.\s+/.test(lineas[i].trim())) { items.push(lineas[i].trim().replace(/^\d+\.\s+/, "")); i++; }
      salida.push(`<ol>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</ol>`);
      continue;
    }

    // Párrafo: líneas seguidas hasta una en blanco o el comienzo de otro bloque.
    const parrafo: string[] = [];
    while (
      i < lineas.length &&
      lineas[i].trim() !== "" &&
      !/^(#{1,4}\s|---+$|[-*]\s|\d+\.\s)/.test(lineas[i].trim()) &&
      !esFilaDeTabla(lineas[i])
    ) {
      parrafo.push(lineas[i].trim());
      i++;
    }
    salida.push(`<p>${inline(parrafo.join(" "))}</p>`);
  }

  return resaltarPendientes(salida.join("\n"));
}
