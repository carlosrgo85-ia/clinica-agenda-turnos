import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { filterNavItems, CATALOG_ITEMS } from "../components/shell/nav-items";

/**
 * Un color por tarjeta, para que la grilla se lea de un vistazo en vez de
 * como cuatro cuadrados iguales.
 *
 * Tres son del logo (`icon-color.svg`); el ciruela es derivado, para que no
 * queden dos naranjas pegados. Van como canales RGB sueltos y no como `#hex`
 * porque el CSS los usa dos veces: el ícono a color pleno y su fondo al 12%
 * — ver `.hub-card-icon`.
 *
 * El mapa vive acá y no en `nav-items.ts` porque es presentación de ESTA
 * pantalla: el sidebar y la paleta usan la misma lista y no pintan nada. Un
 * catálogo nuevo sin color cae al coral de marca y se ve bien igual.
 */
const ACENTO_DEFAULT = "216 90 48";
const ACENTOS: Record<string, string> = {
  "/platform/catalogs/plans": "239 159 39", // ámbar
  "/platform/catalogs/titles": "212 83 126", // rosa
  "/platform/catalogs/insurers": "153 60 29", // coral oscuro
  "/platform/catalogs/countries": "140 58 90", // ciruela
  "/platform/catalogs/secrets": "99 56 6", // marrón
};

/**
 * La portada de "Catálogos": lo que se administra una vez y vale para todas
 * las clínicas, como una grilla de tarjetas cuadradas.
 *
 * Existe porque esas pantallas sueltas eran cinco de los diecinueve ítems del
 * menú. **Clínicas quedó afuera del grupo a propósito**: es la única
 * operativa —la puerta de entrada a "entrar a una clínica"— y tiene su propio
 * ítem en el menú. Lo que vive acá se carga una vez y se toca cada tanto, que
 * es lo que puede permitirse estar a dos clicks.
 *
 * **Cada tarjeta sigue siendo una opción con su propio permiso.** Se filtran
 * con el MISMO `filterNavItems` que el menú, así que un usuario de plataforma
 * que no tenga `paises.ver` no ve la tarjeta de Países, igual que antes no
 * veía el ítem. Si no se reusara ese filtro, tarde o temprano la grilla
 * mostraría una opción que el menú escondía.
 */
export function CatalogsHubPage() {
  const { user, hasPermission } = useAuth();

  if (user && user.clinicId !== null) {
    return (
      <p className="muted">Esta pantalla es de plataforma — un usuario de clínica no tiene acceso.</p>
    );
  }
  if (!user) return null;

  const items = filterNavItems(CATALOG_ITEMS, {
    clinicId: user.clinicId,
    hasPermission,
  });

  return (
    <div>
      <h1>Catálogos</h1>
      <p className="muted">
        Lo que se administra una vez y vale para todas las clínicas. Cada clínica después elige qué
        usa de aquí.
      </p>

      {items.length === 0 ? (
        <p className="muted">Tu usuario no tiene permisos sobre ninguno de los catálogos.</p>
      ) : (
        <div className="hub-grid">
          {items.map((item) => (
            <Link
              key={item.href}
              to={item.href}
              className="hub-card"
              style={{ "--hub-accent": ACENTOS[item.href] ?? ACENTO_DEFAULT } as CSSProperties}
            >
              <span className="hub-card-icon">
                <item.icon size={30} />
              </span>
              <span className="hub-card-title">{item.title}</span>
              {item.description && <span className="hub-card-description">{item.description}</span>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
