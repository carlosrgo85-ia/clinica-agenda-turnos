/**
 * Feature del plan de la clínica (`PLAN_FEATURES.DEPOSIT`, ver
 * `Plan.features`). No está implementada la integración real con una
 * pasarela de pago todavía — esto define la forma que va a tener, para que
 * routes/webhook.ts y el system prompt ya sepan cómo van a usarla.
 *
 * TODO (Claude Code): implementar con Stripe Payment Links o Mercado
 * Pago Preferences (lo que decida usarse por país). El flujo esperado:
 *
 * 1. Cuando el paciente confirma un horario y el plan de la clínica
 *    incluye `PLAN_FEATURES.DEPOSIT`, en vez de crear el turno directo,
 *    generar un link de pago acá y devolverlo en la respuesta al paciente.
 * 2. El turno se crea con status "confirmado" pero depositPaid: false, y
 *    con un tiempo límite (ej. 30 min) para recibir el pago, antes de
 *    liberar el consultorio.
 * 3. Un webhook de la pasarela de pago marca depositPaid: true. Recién ahí
 *    se envía la confirmación final por WhatsApp y se refleja el turno en
 *    el calendario del profesional.
 * 4. Si no se paga a tiempo, cancelar el turno y liberar el consultorio.
 */

export interface DepositLink {
  url: string;
  amount: number;
  currency: string;
  expiresAt: Date;
}

export async function createDepositLink(params: {
  clinicId: string;
  appointmentId: string;
  amount: number;
  currency: string;
}): Promise<DepositLink> {
  throw new Error(
    "createDepositLink no está implementado todavía — ver TODO en services/payments.ts"
  );
}
