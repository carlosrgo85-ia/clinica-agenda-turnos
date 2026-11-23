import { useState, type ReactNode } from "react";
import { X } from "lucide-react";

/** Se recuerda que el usuario cerró este banner puntual, para no repetirlo en cada visita. */
function useDismissed(id: string): [boolean, () => void] {
  const key = `pontic-banner-dismissed:${id}`;
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(key) === "1");
  function dismiss() {
    localStorage.setItem(key, "1");
    setDismissed(true);
  }
  return [dismissed, dismiss];
}

export function Banner({ id, children }: { id: string; children: ReactNode }) {
  const [dismissed, dismiss] = useDismissed(id);
  if (dismissed) return null;

  return (
    <div className="banner" role="status">
      <div className="banner-message">{children}</div>
      <button type="button" className="btn btn--ghost btn--icon" onClick={dismiss} aria-label="Cerrar aviso">
        <X size={16} />
      </button>
    </div>
  );
}
