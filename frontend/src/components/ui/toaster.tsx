import type { CSSProperties } from "react";
import { Toaster as SonnerToaster } from "sonner";

/**
 * Wrapper de `sonner` mapeado a nuestros tokens (ver index.css) en vez de
 * su paleta default, para que un toast no desentone del resto de la app.
 */
export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      style={
        {
          "--normal-bg": "var(--card)",
          "--normal-text": "var(--card-foreground)",
          "--normal-border": "var(--border)",
          "--success-bg": "var(--card)",
          "--success-text": "var(--card-foreground)",
          "--success-border": "var(--primary)",
          "--error-bg": "var(--card)",
          "--error-text": "var(--card-foreground)",
          "--error-border": "var(--destructive)",
        } as CSSProperties
      }
    />
  );
}

export { toast } from "sonner";
