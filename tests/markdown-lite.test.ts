import { describe, expect, it } from "vitest";
import { findPlaceholders, markdownToHtml } from "../src/services/markdown-lite";

describe("markdownToHtml", () => {
  it("convierte títulos, negritas y párrafos de varias líneas", () => {
    const html = markdownToHtml("# Título\n\nUna **frase** con\nsalto de línea.");
    expect(html).toContain("<h1>Título</h1>");
    expect(html).toContain("<p>Una <strong>frase</strong> con salto de línea.</p>");
  });

  it("convierte listas con guion y numeradas", () => {
    expect(markdownToHtml("- uno\n- dos")).toBe("<ul><li>uno</li><li>dos</li></ul>");
    expect(markdownToHtml("1. uno\n2. dos")).toBe("<ol><li>uno</li><li>dos</li></ol>");
  });

  it("convierte tablas con encabezado y formato dentro de las celdas", () => {
    const html = markdownToHtml("| A | B |\n|---|---|\n| **x** | `y` |");
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<td><strong>x</strong></td>");
    expect(html).toContain("<td><code>y</code></td>");
  });

  it("escapa el HTML del documento antes de darle formato", () => {
    const html = markdownToHtml("Un <script>alert(1)</script> y a & b");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("a &amp; b");
  });

  it("los enlaces entre documentos apuntan a las rutas del sitio y los javascript: se anulan", () => {
    expect(markdownToHtml("Ver la [Política](politica-de-privacidad.md).")).toContain('<a href="/privacidad">Política</a>');
    expect(markdownToHtml("[x](javascript:alert(1))")).toContain('href="#"');
  });

  it("resalta los campos pendientes", () => {
    expect(markdownToHtml("Vence el [FECHA].")).toContain("<mark>[FECHA]</mark>");
  });
});

describe("findPlaceholders", () => {
  it("lista los campos pendientes sin repetirlos", () => {
    expect(findPlaceholders("[FECHA] y [PLAZO] y otra vez [FECHA]")).toEqual(["[FECHA]", "[PLAZO]"]);
  });

  it("no toma el texto de un enlace como campo pendiente", () => {
    expect(findPlaceholders("Ver la [Política de Privacidad](politica-de-privacidad.md).")).toEqual([]);
  });

  it("no toma como pendiente un texto en minúsculas entre corchetes", () => {
    expect(findPlaceholders("una nota [aclaración] cualquiera")).toEqual([]);
  });
});
