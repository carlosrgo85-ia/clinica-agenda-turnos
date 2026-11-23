/**
 * Trae dirección, teléfono, sitio web y horario de la ficha de Google
 * (Google Maps / un link corto "share.google") de una clínica, para que
 * el super-admin los revise y los guarde desde la pantalla "Clínicas" —
 * NUNCA se escriben solos. Usa Places API (New): requiere
 * `env.googlePlacesApiKey` (ver `config/env.ts`), que a su vez requiere un
 * proyecto de Google Cloud con esa API habilitada y facturación activa.
 *
 * Por qué no se resuelve el link con un solo llamado: un link corto de
 * "compartir" de Google codifica un identificador interno (CID o
 * `kgmid`), no el `place_id` que necesita Places API, y no hay una
 * conversión pública entre ellos. En cambio, se sigue el redirect hasta la
 * URL final — que según de dónde se compartió puede ser un lugar de Maps
 * (`.../maps/place/<Nombre>/@<lat>,<lng>`) o una ficha del buscador
 * (`google.com/search?...&q=<Nombre>`, sin coordenadas) — se le saca el
 * nombre del negocio (y sus coordenadas si las hay), y con eso se busca el
 * `place_id` real vía "Text Search": el mismo negocio, encontrado por
 * nombre (+ cercanía cuando hay coordenadas) en vez de por el
 * identificador interno.
 */
import { env } from "../config/env";
import { recordUsageEvent } from "./costs";
import { periodsATramos, type GooglePeriod, type TramoSugerido } from "./google-hours";

export interface GoogleBusinessSuggestion {
  name: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  /**
   * El horario que publica Google, ya convertido a tramos de `WorkingHours`
   * (ver `google-hours.ts`). Vacío si Google no lo trae. Es una sugerencia
   * para prellenar el formulario — nunca se guarda solo.
   */
  hours: TramoSugerido[];
  /** ISO 3166-1 alpha-2 (ej. "MX"), para prellenar `Clinic.country` — null si Google no lo trae. */
  countryCode: string | null;
  /** IANA (ej. "America/Mexico_City"), directo de Google — no hace falta inferirlo de la ciudad. */
  timezone: string | null;
}

function requireApiKey(): string {
  if (!env.googlePlacesApiKey) {
    throw new Error(
      "Falta configurar GOOGLE_PLACES_API_KEY para traer datos de Google (Places API, proyecto de Google Cloud con facturación activa)."
    );
  }
  return env.googlePlacesApiKey;
}

/** Sigue los redirects de un link corto (ej. share.google/...) y devuelve la URL final. */
async function resolveToFinalUrl(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow" });
  // No hace falta el cuerpo, solo a dónde terminó redirigiendo.
  await res.body?.cancel();
  return res.url;
}

/**
 * Un link corto de "compartir" de Google puede resolver a dos formas
 * distintas según de dónde se lo compartió, y las dos hay que cubrirlas:
 *
 * 1. Un lugar de Google Maps: `.../maps/place/<Nombre>/@<lat>,<lng>,<zoom>z/...`
 *    — de ahí se sacan nombre Y coordenadas (mejor precisión en el
 *    "Text Search" de abajo).
 * 2. Una ficha de negocio compartida desde el buscador de Google (el caso
 *    real que motivó esto): resuelve a
 *    `google.com/search?...&q=<Nombre del negocio>&kgmid=...`, sin
 *    coordenadas — se usa el parámetro `q` tal cual.
 *
 * Si ninguna de las dos matchea, se devuelve todo en null y quien llama
 * lo reporta como error explícito en vez de adivinar.
 */
function extractNameAndLocation(finalUrl: string): { name: string | null; lat: number | null; lng: number | null } {
  const mapsMatch = finalUrl.match(/\/maps\/place\/([^/]+)\/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (mapsMatch) {
    return {
      name: decodeURIComponent(mapsMatch[1].replace(/\+/g, " ")),
      lat: Number(mapsMatch[2]),
      lng: Number(mapsMatch[3]),
    };
  }

  try {
    const q = new URL(finalUrl).searchParams.get("q");
    if (q) return { name: q, lat: null, lng: null };
  } catch {
    // No era una URL válida — se informa como error más abajo, no acá.
  }

  return { name: null, lat: null, lng: null };
}

async function findPlaceId(apiKey: string, name: string, lat: number | null, lng: number | null): Promise<string | null> {
  const body: Record<string, unknown> = { textQuery: name };
  if (lat !== null && lng !== null) {
    body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: 500 } };
  }

  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.id",
    },
    body: JSON.stringify(body),
  });
  // Google cobra la llamada aunque no encuentre nada: se registra apenas contesta, sea cual sea el resultado.
  await recordUsageEvent({ provider: "google_places", kind: "text_search" });
  if (!res.ok) {
    throw new Error(`Google Places respondió ${res.status} al buscar el negocio.`);
  }
  const data = (await res.json()) as { places?: Array<{ id: string }> };
  return data.places?.[0]?.id ?? null;
}

async function fetchPlaceDetails(apiKey: string, placeId: string): Promise<GoogleBusinessSuggestion> {
  const fieldMask =
    "displayName,formattedAddress,addressComponents,timeZone,internationalPhoneNumber,websiteUri,regularOpeningHours.periods";
  const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: {
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": fieldMask,
    },
  });
  await recordUsageEvent({ provider: "google_places", kind: "place_details" });
  if (!res.ok) {
    throw new Error(`Google Places respondió ${res.status} al pedir el detalle del negocio.`);
  }
  const data = (await res.json()) as {
    displayName?: { text?: string };
    formattedAddress?: string;
    addressComponents?: Array<{ shortText?: string; types?: string[] }>;
    timeZone?: { id?: string };
    internationalPhoneNumber?: string;
    websiteUri?: string;
    regularOpeningHours?: { periods?: GooglePeriod[] };
  };

  const countryComponent = data.addressComponents?.find((c) => c.types?.includes("country"));

  return {
    name: data.displayName?.text ?? null,
    address: data.formattedAddress ?? null,
    phone: data.internationalPhoneNumber ?? null,
    website: data.websiteUri ?? null,
    hours: periodsATramos(data.regularOpeningHours?.periods),
    countryCode: countryComponent?.shortText ?? null,
    timezone: data.timeZone?.id ?? null,
  };
}

/** Punto de entrada único: link de Google → datos sugeridos del negocio. */
export async function fetchGoogleBusinessData(url: string): Promise<GoogleBusinessSuggestion> {
  const apiKey = requireApiKey();

  const finalUrl = await resolveToFinalUrl(url);
  const { name, lat, lng } = extractNameAndLocation(finalUrl);
  if (!name) {
    throw new Error(
      "No se pudo interpretar ese link como una ficha de Google Maps. Prueba pegando el link completo (no acortado) desde Google Maps."
    );
  }

  const placeId = await findPlaceId(apiKey, name, lat, lng);
  if (!placeId) {
    throw new Error("No se encontró el negocio en Google con ese link.");
  }

  return fetchPlaceDetails(apiKey, placeId);
}
