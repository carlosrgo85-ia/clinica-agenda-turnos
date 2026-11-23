import { trackedCron } from "./tracked-cron";
import { PLAN_FEATURES } from "../config/plan-features";
import { runReminderRound } from "./daily-reminders";

/**
 * Feature del plan de la clínica (`PLAN_FEATURES.REMINDER_2H`, ver
 * `Plan.features`). Corre cada hora y solo actúa sobre las clínicas cuyo
 * plan la incluye — el resto no recibe ningún recordatorio extra ni se les
 * cobra de más.
 *
 * Cada clínica va en su propio try/catch (en `runReminderRound`): si una falla, no puede
 * tirar abajo el resto ni, si la excepción escapa del callback async de node-cron, matar el
 * proceso entero (Node >=15 aborta en una promesa rechazada sin manejar).
 */
export function scheduleTwoHourReminders(): void {
  trackedCron("two-hour-reminders", "0 * * * *", async () => {
    await runTwoHourReminders();
  });
}

export async function runTwoHourReminders(now?: Date): Promise<void> {
  await runReminderRound({
    job: "two-hour-reminders",
    hoursAhead: 2,
    appliesTo: (clinic) => clinic.plan?.features.includes(PLAN_FEATURES.REMINDER_2H) ?? false,
    now,
  });
}
