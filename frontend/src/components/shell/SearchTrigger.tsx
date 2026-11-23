import { Search } from "lucide-react";
import { cn } from "../../lib/cn";
import { openCommandPalette } from "./nav-state";

/**
 * Lo que hace visible el buscador. No es un segundo buscador: abre la MISMA paleta de comandos (⌘K) que ya existía
 * pero que nadie descubría. Con el menú reducido a íconos queda solo la lupa.
 */
export function SearchTrigger({ iconsOnly = false, onOpen }: { iconsOnly?: boolean; onOpen?: () => void }) {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <button
      type="button"
      className={cn("search-trigger", iconsOnly && "search-trigger--icon")}
      onClick={() => {
        onOpen?.();
        openCommandPalette();
      }}
      aria-label="Buscar una pantalla o una opción"
      title={`Buscar (${isMac ? "⌘K" : "Ctrl+K"})`}
    >
      <Search size={16} />
      {!iconsOnly && (
        <>
          <span className="search-trigger-text">Buscar…</span>
          <kbd className="search-trigger-kbd">{isMac ? "⌘K" : "Ctrl K"}</kbd>
        </>
      )}
    </button>
  );
}
