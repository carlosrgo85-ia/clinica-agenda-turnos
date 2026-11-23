import type { Clinic } from "@prisma/client";

/**
 * El mensaje con la ubicación de la clínica, para el primer turno de un
 * paciente.
 *
 * Se arma **en código y no en el prompt** a propósito: un link que el modelo
 * reescribe es un link que puede salir mal, y este es justo el mensaje donde
 * equivocarse significa que el paciente no llega.
 *
 * El texto es casi todo datos, sin verbos dirigidos al paciente: el prompt le
 * exige al modelo escribir en el español del país de la clínica (tuteo o
 * voseo según corresponda), y esto no pasa por el modelo. Redactarlo con
 * frases hechas haría que el mensaje siguiente sonara de otra región.
 */
export function buildLocationMessage(
  clinic: Pick<Clinic, "name" | "address" | "googleBusinessUrl">
): string | null {
  const address = clinic.address?.trim() || null;
  const link = googleMapsLink(clinic);

  // Sin dirección ni link no hay nada útil que mandar. Un mensaje con el
  // nombre de la clínica y nada más es peor que no mandar ninguno.
  if (!address && !link) return null;

  // Sin dirección cargada el encabezado no puede anunciar una: quedaría
  // "Dirección de X:" y abajo nada.
  if (!address) return `Cómo llegar a ${clinic.name}: ${link}`;

  const lineas = [`Dirección de ${clinic.name}:`, address];
  if (link) lineas.push("", `Cómo llegar: ${link}`);

  return lineas.join("\n");
}

/**
 * El link de Google Maps.
 *
 * `googleBusinessUrl` gana cuando está cargado: apunta a la ficha exacta del
 * negocio, sin que Google tenga que interpretar nada. La búsqueda por
 * dirección es el respaldo para las clínicas que no lo tienen — funciona,
 * pero una dirección ambigua puede caer en otro lado.
 */
function googleMapsLink(
  clinic: Pick<Clinic, "address" | "googleBusinessUrl">
): string | null {
  const businessUrl = clinic.googleBusinessUrl?.trim();
  if (businessUrl) return businessUrl;

  const address = clinic.address?.trim();
  if (!address) return null;

  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}
