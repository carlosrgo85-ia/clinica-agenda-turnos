import { purgeIdleSandbox, SANDBOX_IDLE_HOURS } from "../services/sandbox";
import { trackedCron } from "./tracked-cron";

/**
 * Borra las conversaciones del chat de pruebas que llevan `SANDBOX_IDLE_HOURS` horas sin actividad.
 *
 * Una prueba deja una ficha de paciente y, si se agendó, citas de mentira que ocupan la agenda y entran en los
 * reportes. "Reiniciar" en la pantalla las borra, pero alguien se va a olvidar: esto es la red de seguridad.
 * `trackedCron` ya trae el try/catch y el latido de Monitoreo.
 */
export function scheduleSandboxCleanup(): void {
  trackedCron("sandbox-cleanup", "20 * * * *", async () => {
    const borradas = await purgeIdleSandbox(new Date(), SANDBOX_IDLE_HOURS);
    if (borradas > 0) console.info(JSON.stringify({ evento: "pruebas_borradas", conversaciones: borradas }));
  });
}
