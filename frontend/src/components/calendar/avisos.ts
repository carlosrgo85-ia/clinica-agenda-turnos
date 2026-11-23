import { toast } from "sonner";

/** La cita ya se guardó; si el aviso al paciente falló, se dice aparte. */
export function avisarSiFallo(aviso: { enviado: boolean; motivo?: string } | null | undefined): void {
  if (aviso && !aviso.enviado) {
    toast.warning(
      `El cambio se guardó, pero no se pudo avisar al paciente por WhatsApp${
        aviso.motivo ? `: ${aviso.motivo}` : ""
      }. Avísale por otro medio.`
    );
  }
}
