import { HelpCircle, Mail, BookOpen } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

/**
 * Contenido placeholder: no hay todavía un centro de ayuda ni una casilla
 * de soporte real configurada para este panel — ajustar cuando exista.
 */
export function HelpMenu({ collapsed }: { collapsed?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="footer-item">
          <HelpCircle size={16} />
          {!collapsed && <span>Ayuda</span>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end">
        <DropdownMenuItem asChild>
          <a href="/ui" target="_blank" rel="noreferrer">
            <BookOpen size={14} /> Documentación
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href="mailto:soporte@pontic.app">
            <Mail size={14} /> Escribir a soporte
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
