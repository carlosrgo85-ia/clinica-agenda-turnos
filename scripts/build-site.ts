/**
 * Genera las páginas estáticas del sitio público (`public/site/`): la portada, la política de privacidad y los
 * términos de servicio, estos dos a partir de `docs/legal/*.md` (la fuente que se edita y se revisa con el abogado).
 *
 *   npx tsx scripts/build-site.ts            # genera; si quedan campos [ENTRE CORCHETES] las páginas salen como BORRADOR
 *   npx tsx scripts/build-site.ts --final    # lo mismo, pero FALLA si queda algún campo pendiente (para publicar de verdad)
 *
 * Las páginas generadas se commitean: `docs/` no entra en la imagen de Docker, así que no se pueden generar al construirla.
 * Un borrador lleva un cartel visible y `noindex`; recién sin campos pendientes (y con revisión legal) sale sin ellos.
 * El servidor las sirve en `/`, `/privacidad` y `/terminos` (`src/index.ts`).
 */
import fs from "node:fs";
import path from "node:path";
import { escapeHtml, findPlaceholders, markdownToHtml } from "../src/services/markdown-lite";

const RAIZ = path.resolve(__dirname, "..");
const SALIDA = path.join(RAIZ, "public", "site");
const final = process.argv.includes("--final");

const NAV = [
  { href: "/", texto: "Inicio" },
  { href: "/privacidad", texto: "Política de privacidad" },
  { href: "/terminos", texto: "Términos de servicio" },
];

function pagina(params: { titulo: string; descripcion: string; cuerpo: string; actual: string; borrador: boolean }): string {
  const nav = NAV.map((n) => `<a href="${n.href}"${n.href === params.actual ? ' aria-current="page"' : ""}>${n.texto}</a>`).join("");
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(params.titulo)}</title>
<meta name="description" content="${escapeHtml(params.descripcion)}">
${params.borrador ? '<meta name="robots" content="noindex">' : ""}
<link rel="icon" type="image/png" href="/site/favicon.png">
<link rel="stylesheet" href="/site/site.css">
</head>
<body>
<header class="cab"><div class="ancho">
<a class="marca" href="/"><img src="/site/logo.png" alt="Pontic" height="36"></a>
<nav>${nav}</nav>
</div></header>
<main class="ancho">
${params.borrador ? '<p class="borrador" role="note"><strong>Borrador en revisión.</strong> Este texto todavía no es la versión vigente: los campos resaltados están pendientes.</p>' : ""}
${params.cuerpo}
</main>
<footer class="pie"><div class="ancho">
<p>Pontic · <a href="mailto:avisos@pontic.com.mx">avisos@pontic.com.mx</a></p>
<p><a href="/privacidad">Política de privacidad</a> · <a href="/terminos">Términos de servicio</a></p>
</div></footer>
</body>
</html>
`;
}

const PORTADA = `
<section class="hero">
<h1>Pontic: el asistente de WhatsApp que agenda las citas de tu clínica</h1>
<p>Pontic atiende por WhatsApp a los pacientes de clínicas y consultorios: consulta los horarios disponibles, agenda, cambia y cancela citas, y envía recordatorios. Cuando algo necesita a una persona, avisa al equipo de la clínica.</p>
</section>
<section>
<h2>Qué incluye</h2>
<ul>
<li><strong>Asistente de WhatsApp con inteligencia artificial</strong> para agendar, reprogramar y cancelar citas, con los horarios, profesionales y servicios que la clínica configura.</li>
<li><strong>Panel de administración</strong>: agenda, pacientes, recursos, reportes y configuración.</li>
<li><strong>Recordatorios y avisos</strong> a los pacientes y al equipo de la clínica.</li>
<li><strong>Integración con calendarios</strong> (Google Calendar y Microsoft Outlook).</li>
</ul>
<p>Pontic es una herramienta de gestión de citas. No es un sistema de historia clínica ni de atención de emergencias, y el asistente no da consejos médicos ni diagnósticos.</p>
</section>
<section>
<h2>Cómo usamos los datos de Google Calendar</h2>
<p>Si la clínica conecta su Google Calendar, Pontic pide solo los permisos necesarios: crear y borrar los eventos que reflejan las citas, y leer el horario de los demás eventos para no ofrecer horarios ocupados. No guardamos el título, la descripción ni los asistentes de esos eventos, y la clínica puede desconectar su cuenta cuando quiera. El detalle está en la <a href="/privacidad">política de privacidad</a>.</p>
</section>
<section>
<h2>Contacto</h2>
<p>Para consultas sobre el servicio o sobre sus datos personales, escríbanos a <a href="mailto:avisos@pontic.com.mx">avisos@pontic.com.mx</a>. Consulte también nuestra <a href="/privacidad">política de privacidad</a> y los <a href="/terminos">términos de servicio</a>.</p>
</section>
`;

fs.mkdirSync(SALIDA, { recursive: true });
let pendientes = 0;
const escribir = (archivo: string, contenido: string) => fs.writeFileSync(path.join(SALIDA, archivo), contenido, "utf8");

escribir(
  "index.html",
  pagina({
    titulo: "Pontic — asistente de WhatsApp para agendar citas",
    descripcion: "Asistente de WhatsApp con inteligencia artificial para que clínicas y consultorios agenden, cambien y cancelen citas.",
    cuerpo: PORTADA,
    actual: "/",
    borrador: false,
  })
);

for (const doc of [
  { fuente: "politica-de-privacidad.md", archivo: "privacidad.html", titulo: "Política de privacidad — Pontic", ruta: "/privacidad" },
  { fuente: "terminos-de-servicio.md", archivo: "terminos.html", titulo: "Términos de servicio — Pontic", ruta: "/terminos" },
]) {
  const md = fs.readFileSync(path.join(RAIZ, "docs", "legal", doc.fuente), "utf8");
  const faltan = findPlaceholders(md);
  pendientes += faltan.length;
  if (faltan.length > 0) console.log(`${doc.fuente}: ${faltan.length} campo(s) pendiente(s):\n  - ${faltan.join("\n  - ")}`);
  escribir(
    doc.archivo,
    pagina({ titulo: doc.titulo, descripcion: doc.titulo, cuerpo: markdownToHtml(md), actual: doc.ruta, borrador: faltan.length > 0 })
  );
}

console.log(pendientes === 0 ? "Sitio generado sin campos pendientes." : `Sitio generado como BORRADOR: ${pendientes} campo(s) pendiente(s).`);
if (final && pendientes > 0) {
  console.error("--final: no se puede publicar con campos pendientes.");
  process.exit(1);
}
