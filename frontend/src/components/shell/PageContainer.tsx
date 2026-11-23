import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type ContainerSize = "default" | "form" | "auth";

interface PageContainerProps extends HTMLAttributes<HTMLDivElement> {
  size?: ContainerSize;
}

/**
 * Única fuente de verdad para el ancho de una pantalla — nunca hardcodear
 * un max-width en una página. "default" para el contenido general de una
 * pantalla, "form" para un formulario anidado adentro de una, "auth" para
 * las pantallas de login/recuperar/elegir contraseña.
 */
export function PageContainer({ className, size = "default", ...props }: PageContainerProps) {
  return <div className={cn("page-container", `page-container--${size}`, className)} {...props} />;
}
