import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/cn";
import { activeHref, groupHasActiveRoute, type GroupedNav } from "./nav-items";
import { readGroupState, writeGroupState } from "./nav-state";

/**
 * El menú agrupado por secciones plegables, compartido por el sidebar y el menú móvil. Las secciones frecuentes
 * arrancan abiertas y las de configuración plegadas; entrar a una pantalla de una sección plegada la abre sola, y lo que
 * la persona abre o cierra se recuerda. Con el sidebar reducido a íconos no hay títulos ni plegado (todo quedaría
 * escondido): solo una línea fina entre secciones.
 */
export function NavGroups({
  groups,
  iconsOnly = false,
  onNavigate,
}: {
  groups: GroupedNav[];
  iconsOnly?: boolean;
  onNavigate?: () => void;
}) {
  const location = useLocation();
  // Un solo ítem activo: el más específico de todo el menú (no el primero cuyo prefijo coincida).
  const activa = activeHref(
    groups.flatMap((g) => g.items),
    location.pathname
  );
  const [stored, setStored] = useState<Record<string, boolean>>(readGroupState);

  // Llegar a una pantalla de una sección plegada (por un enlace, el buscador o la URL) la abre.
  useEffect(() => {
    setStored((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const { group, items } of groups) {
        if (groupHasActiveRoute(items, location.pathname) && (prev[group.id] ?? !group.defaultCollapsed) === false) {
          next[group.id] = true;
          changed = true;
        }
      }
      if (changed) writeGroupState(next);
      return changed ? next : prev;
    });
  }, [location.pathname, groups]);

  function toggle(id: string, open: boolean) {
    setStored((prev) => {
      const next = { ...prev, [id]: !open };
      writeGroupState(next);
      return next;
    });
  }

  return (
    <>
      {groups.map(({ group, items }, i) => {
        const open = stored[group.id] ?? !group.defaultCollapsed;
        const panelId = `nav-group-${group.id}`;
        return (
          <div key={group.id} className={cn("nav-group", i > 0 && "nav-group--separated")}>
            {!iconsOnly && (
              <button
                type="button"
                className="nav-group-title"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => toggle(group.id, open)}
              >
                <span>{group.title}</span>
                <ChevronDown size={14} className={cn("nav-group-chevron", !open && "nav-group-chevron--closed")} />
              </button>
            )}
            {(iconsOnly || open) && (
              <div id={panelId} className="nav-group-items">
                {items.map((item) => (
                  <Link
                    key={item.href}
                    to={item.href}
                    className={cn("nav-link", item.href === activa && "nav-link--active")}
                    title={item.title}
                    onClick={onNavigate}
                  >
                    <item.icon size={18} />
                    <span>{item.title}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

