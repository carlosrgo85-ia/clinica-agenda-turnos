# Pontic — archivos de marca

## Qué archivo usar en cada caso

| Necesito... | Usar este archivo |
|---|---|
| Ícono de la app (iOS/Android) | `png/icon-app-social-1024.png` (1024px, o `-512`/`-192`/`-180` según requiera la plataforma) |
| Favicon del sitio web | `png/icon-color-32.png` o `icon-color-64.png` |
| Avatar de redes sociales (Instagram, LinkedIn, X, Facebook) | `png/icon-app-social-512.png` — tiene margen extra pensado para que no se corte en el recorte circular que usan la mayoría de las redes |
| Header del sitio web / membrete / firma de email | `png/logo-horizontal-color-1200.png` (o el `.svg` si el formato lo acepta, para que no pierda calidad al escalar) |
| Documento en blanco y negro (factura, fax, sello) | `png/logo-horizontal-black-1200.png` o `png/icon-mono-black-512.png` |
| Fondo oscuro (slide oscuro, dark mode, fondo de color) | `png/logo-horizontal-white-1200.png` o `png/icon-mono-white-512.png` |
| Post de redes sociales, splash screen de la app | `png/logo-stacked-color-1000.png` |
| Uso en Illustrator, Figma, Canva, o cualquier edición vectorial | los archivos en `svg/` — no pierden calidad a ningún tamaño |
| Insertar en Word, PowerPoint, Google Docs | los `.png` de la carpeta `png/`; Word y PowerPoint recientes también aceptan los `.svg` directamente |

## Reglas de uso

- **Margen de seguridad**: dejar como mínimo el ancho del trazo del ícono (el trazo vertical) como espacio libre alrededor del logo. No pegarlo directo contra bordes o texto.
- **No usar el ícono solo (sin "PONTIC") en un contexto donde la marca todavía no es conocida** — por ejemplo, un favicon está bien, pero un flyer para gente que no conoce la marca debería llevar el lockup con texto.
- **No recolorear el ícono a color en un solo tono para ahorrar tinta** — para eso ya existen las versiones `icon-mono-black` e `icon-mono-white`, pensadas para verse bien en un solo color.
- **No estirar ni deformar** ninguno de los archivos — todos mantienen proporción correcta si se escalan desde una esquina.
- **El tile crema (`icon-app-social`) ya tiene el fondo incluido** — no ponerlo dentro de otro marco ni agregarle otro fondo detrás.

## Paleta usada en el logo

| Color | Hex | Uso en el logo |
|---|---|---|
| Coral oscuro | `#993C1D` | Trazo vertical (la base) |
| Coral | `#D85A30` | Anillo exterior |
| Ámbar | `#EF9F27` | Anillo interior |
| Rosa | `#D4537E` | Punto central |
| Crema | `#FAF3EC` | Fondo del tile de ícono/app/redes |
| Gris oscuro | `#2C2C2A` | Texto "PONTIC" en la versión a color |
