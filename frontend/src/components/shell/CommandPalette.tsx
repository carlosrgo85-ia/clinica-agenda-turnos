import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Clock3 } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../ui/command";
import { CATALOG_ITEMS, filterNavItems, groupNavItems, isActiveRoute, NAV_ITEMS, type NavItem } from "./nav-items";
import { OPEN_PALETTE_EVENT, pushRecent, readRecents } from "./nav-state";

/**
 * El buscador: se abre con ⌘K / Ctrl+K o con el campo "Buscar…" del menú (evento `OPEN_PALETTE_EVENT`), en cualquier
 * pantalla del panel. Busca por el título de la pantalla Y por cómo la llamaría la gente (`keywords` de cada ítem:
 * "horario de comida", "precio", "obra social"…), y muestra los resultados con las mismas secciones del menú.
 * Con el campo vacío ofrece las últimas pantallas visitadas.
 *
 * Solo ofrece pantallas: buscar personas o citas exige decidir qué datos de pacientes se muestran en un buscador
 * global, y eso ya tiene su propia pantalla.
 */
export function CommandPalette() {
  const { user, hasPermission } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [recents, setRecents] = useState<string[]>(readRecents);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    const abrir = () => setOpen(true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener(OPEN_PALETTE_EVENT, abrir);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(OPEN_PALETTE_EVENT, abrir);
    };
  }, []);

  const clinicId = user?.clinicId ?? null;
  const groups = useMemo(
    () => (user ? groupNavItems(NAV_ITEMS, { clinicId, hasPermission }) : []),
    [user, clinicId, hasPermission]
  );
  // Los catálogos se buscan aparte: "Seguros" existe en las dos listas y significa cosas distintas.
  const catalogItems = useMemo(
    () => (user ? filterNavItems(CATALOG_ITEMS, { clinicId, hasPermission }) : []),
    [user, clinicId, hasPermission]
  );
  const todas: NavItem[] = useMemo(() => [...groups.flatMap((g) => g.items), ...catalogItems], [groups, catalogItems]);

  // Cada pantalla que se visita queda como reciente (la más específica que coincida con la ruta, no el prefijo más corto).
  useEffect(() => {
    const visitada = todas
      .filter((i) => isActiveRoute(location.pathname, i.href))
      .sort((a, b) => b.href.length - a.href.length)[0];
    if (visitada) setRecents((prev) => pushRecent(visitada.href, prev));
  }, [location.pathname, todas]);

  if (!user) return null;

  const recientes = recents.map((href) => todas.find((i) => i.href === href)).filter((i): i is NavItem => Boolean(i));

  function ir(item: NavItem) {
    navigate(item.href);
    setOpen(false);
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setSearch("");
      }}
    >
      <CommandInput placeholder="¿Qué quiere hacer o dónde quiere ir? Ej.: horario, precio, obra social…" value={search} onValueChange={setSearch} />
      <CommandList>
        <CommandEmpty>
          No encontramos nada con eso. Pruebe con otra palabra, por ejemplo "horario", "paciente" o "precio".
        </CommandEmpty>
        {search === "" && recientes.length > 0 && (
          <CommandGroup heading="Recientes">
            {recientes.map((item) => (
              <CommandItem key={`reciente-${item.href}`} value={`reciente ${item.title}`} onSelect={() => ir(item)}>
                <Clock3 size={14} />
                {item.title}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {groups.map(({ group, items }) => (
          <CommandGroup key={group.id} heading={group.title}>
            {items.map((item) => (
              <CommandItem key={item.href} value={item.title} keywords={[...(item.keywords ?? []), item.description ?? ""]} onSelect={() => ir(item)}>
                <item.icon size={14} />
                <span>{item.title}</span>
                {item.description && <span className="command-item-description">{item.description}</span>}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
        {catalogItems.length > 0 && (
          <CommandGroup heading="Catálogos de la plataforma">
            {catalogItems.map((item) => (
              <CommandItem
                key={item.href}
                // El título solo no alcanza: "Seguros" está en las dos secciones, y cmdk busca por este valor.
                value={`Catálogo ${item.title}`}
                keywords={[item.description ?? ""]}
                onSelect={() => ir(item)}
              >
                <item.icon size={14} />
                <span>{item.title}</span>
                {item.description && <span className="command-item-description">{item.description}</span>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
