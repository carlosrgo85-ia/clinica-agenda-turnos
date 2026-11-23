import { useState } from "react";
import { Moon, Sun, SunMoon } from "lucide-react";
import { applyTheme, getStoredTheme, nextTheme, type Theme } from "./theme";

const ICONS: Record<Theme, typeof Sun> = { light: Sun, dark: Moon, system: SunMoon };
const LABELS: Record<Theme, string> = { light: "Claro", dark: "Oscuro", system: "Sistema" };

/** Cicla claro → oscuro → sistema, persistido. Ver components/shell/theme.ts. */
export function ThemeToggle({ collapsed }: { collapsed?: boolean }) {
  const [theme, setTheme] = useState<Theme>(getStoredTheme);
  const Icon = ICONS[theme];

  function handleClick() {
    const next = nextTheme(theme);
    setTheme(next);
    applyTheme(next);
  }

  return (
    <button type="button" className="footer-item" onClick={handleClick} title={`Tema: ${LABELS[theme]}`}>
      <Icon size={16} />
      {!collapsed && <span>Tema: {LABELS[theme]}</span>}
    </button>
  );
}
