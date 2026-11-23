import { trackedCron } from "./tracked-cron";
import { pruneAgentRequests } from "../services/agent-requests";
import { pruneSystemEvents } from "../services/system-events";
import { pruneUsageEvents } from "../services/costs";

/** Borra los eventos del sistema y las solicitudes al agente que pasaron la retención, una vez por día. */
export function scheduleSystemEventsCleanup(): void {
  trackedCron("system-events-cleanup", "0 4 * * *", async () => {
    await pruneSystemEvents();
    await pruneAgentRequests();
    await pruneUsageEvents();
  });
}
