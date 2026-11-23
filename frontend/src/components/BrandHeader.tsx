import iconColor from "../assets/icons/svg/icon-color.svg";
import logoColor from "../assets/icons/svg/logo-horizontal-color.svg";
import logoWhite from "../assets/icons/svg/logo-horizontal-white.svg";

/**
 * Logo de marca (ver frontend/docs/README.md). El lockup con texto — no el
 * ícono solo — porque esto aparece en pantallas donde la marca todavía no
 * se conoce (login, sidebar expandido), que es justo el caso que la guía
 * pide evitar para el ícono suelto. `iconOnly` es la excepción: se usa
 * SOLO en el sidebar colapsado, un espacio de 64px donde ya se vio la
 * marca completa un segundo antes de colapsar — no es el primer contacto.
 *
 * `logo-horizontal-color.svg` pinta el texto "PONTIC" en gris oscuro casi
 * negro, así que se vuelve ilegible sobre un fondo oscuro — se muestra la
 * variante blanca en dark mode con CSS puro (sin JS) para que siga
 * funcionando con el toggle de tema. El ícono solo no tiene ese problema
 * (no lleva texto), así que no necesita variante oscura.
 */
export function BrandHeader({ iconOnly }: { iconOnly?: boolean } = {}) {
  if (iconOnly) {
    return (
      <div className="brand-header">
        <img src={iconColor} alt="Pontic" />
      </div>
    );
  }

  return (
    <div className="brand-header">
      <img className="logo-light" src={logoColor} alt="Pontic" />
      <img className="logo-dark" src={logoWhite} alt="Pontic" />
    </div>
  );
}
