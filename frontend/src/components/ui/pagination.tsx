import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./button";

/**
 * Construido y listo, sin consumidor todavía: ninguna lista de este panel
 * pagina server-side hoy (son pocos usuarios/roles por clínica).
 */
export function Pagination({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  return (
    <div className="pagination">
      <Button variant="outline" size="icon" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
        <ChevronLeft size={16} />
      </Button>
      <span className="muted">
        Página {page} de {totalPages}
      </span>
      <Button variant="outline" size="icon" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
        <ChevronRight size={16} />
      </Button>
    </div>
  );
}
