import { AlertTriangle } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "./button";

interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
  /** Para meterlo dentro de una tarjeta o fila en vez de ocupar toda la página. */
  compact?: boolean;
}

export function ErrorState({ message, onRetry, compact }: ErrorStateProps) {
  return (
    <div className={cn("error-state", compact && "error-state--compact")}>
      <AlertTriangle size={compact ? 18 : 32} />
      {compact ? (
        <span>{message}</span>
      ) : (
        <>
          <h3>Algo salió mal</h3>
          <p>{message}</p>
        </>
      )}
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Reintentar
        </Button>
      )}
    </div>
  );
}
