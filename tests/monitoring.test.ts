import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db/client";
import { MONITORED_JOBS } from "../src/config/monitored-jobs";
import {
  getMonitoringSnapshot,
  isJobStale,
  jobState,
  listSystemEvents,
} from "../src/services/monitoring";
import {
  pruneSystemEvents,
  recordSystemEvent,
  SYSTEM_EVENT_KINDS,
  SYSTEM_EVENT_RETENTION_DAYS,
} from "../src/services/system-events";
import { reportJobError } from "../src/jobs/tracked-cron";

const MIN = 60_000;
const HOUR = 60 * MIN;
const AHORA = new Date("2030-06-17T12:00:00.000Z");
const ids: string[] = [];
const jobsCreados: string[] = [];

afterEach(async () => {
  await prisma.systemEvent.deleteMany({ where: { id: { in: ids } } });
  await prisma.cronHeartbeat.deleteMany({ where: { jobName: { in: jobsCreados } } });
  ids.length = 0;
  jobsCreados.length = 0;
});

describe("isJobStale", () => {
  it("una tarea que nunca corrió está atrasada", () => {
    expect(isJobStale(AHORA, null, HOUR)).toBe(true);
  });

  it("dentro del hueco normal no está atrasada", () => {
    expect(isJobStale(AHORA, new Date(AHORA.getTime() - 50 * MIN), HOUR)).toBe(false);
  });

  it("tolera un retraso moderado sobre el hueco normal", () => {
    // 1 hora de hueco: se tolera hasta 1,5 h + 2 min de margen.
    expect(isJobStale(AHORA, new Date(AHORA.getTime() - 85 * MIN), HOUR)).toBe(false);
  });

  it("pasado ese margen, está atrasada", () => {
    expect(isJobStale(AHORA, new Date(AHORA.getTime() - 3 * HOUR), HOUR)).toBe(true);
  });

  it("una tarea de cada minuto no da falsa alarma por un par de minutos de retraso", () => {
    expect(isJobStale(AHORA, new Date(AHORA.getTime() - 2 * MIN), MIN)).toBe(false);
  });

  it("una tarea nocturna de las 8 a las 18 no está atrasada a media noche", () => {
    const job = MONITORED_JOBS.find((j) => j.name === "secret-expiry-alerts")!;
    // Última corrida a las 18:00; ahora son las 06:00 del día siguiente (12 h).
    const ultima = new Date("2030-06-17T18:00:00.000Z");
    const ahora = new Date("2030-06-18T06:00:00.000Z");
    expect(isJobStale(ahora, ultima, job.maxGapMs)).toBe(false);
  });
});

describe("jobState", () => {
  const base = { now: AHORA, maxGapMs: HOUR };
  it("distingue los cuatro estados", () => {
    const reciente = new Date(AHORA.getTime() - 10 * MIN);
    expect(jobState({ ...base, lastRunAt: null, hasError: false })).toBe("nunca_corrio");
    expect(jobState({ ...base, lastRunAt: reciente, hasError: false })).toBe("ok");
    expect(jobState({ ...base, lastRunAt: reciente, hasError: true })).toBe("con_error");
    expect(
      jobState({ ...base, lastRunAt: new Date(AHORA.getTime() - 5 * HOUR), hasError: true })
    ).toBe("atrasado");
  });
});

describe("recordSystemEvent", () => {
  it("guarda el evento con su tipo y clínica", async () => {
    await recordSystemEvent({
      kind: SYSTEM_EVENT_KINDS.MODELO_FALLO,
      clinicId: "clinica-x",
      message: "boom",
    });
    const fila = await prisma.systemEvent.findFirstOrThrow({
      where: { clinicId: "clinica-x" },
      orderBy: { createdAt: "desc" },
    });
    ids.push(fila.id);
    expect(fila).toMatchObject({ kind: "modelo_fallo", severity: "error", message: "boom" });
  });

  it("recorta los mensajes larguísimos", async () => {
    await recordSystemEvent({
      kind: SYSTEM_EVENT_KINDS.CRON_ERROR,
      clinicId: "clinica-larga",
      message: "x".repeat(5000),
    });
    const fila = await prisma.systemEvent.findFirstOrThrow({ where: { clinicId: "clinica-larga" } });
    ids.push(fila.id);
    expect(fila.message.length).toBeLessThan(600);
  });

  it("reportJobError registra el evento con la clínica", async () => {
    await reportJobError("daily-reminders", "Error de prueba", new Error("fallo X"), "clinica-job");
    const fila = await prisma.systemEvent.findFirstOrThrow({ where: { clinicId: "clinica-job" } });
    ids.push(fila.id);
    expect(fila.kind).toBe("cron_error");
    expect(fila.message).toContain("daily-reminders");
    expect(fila.message).toContain("fallo X");
  });
});

describe("pruneSystemEvents", () => {
  it("borra solo lo que pasó la retención", async () => {
    const viejo = await prisma.systemEvent.create({
      data: {
        kind: "cron_error",
        message: "viejo",
        clinicId: "clinica-prune",
        createdAt: new Date(AHORA.getTime() - (SYSTEM_EVENT_RETENTION_DAYS + 1) * 24 * HOUR),
      },
    });
    const reciente = await prisma.systemEvent.create({
      data: {
        kind: "cron_error",
        message: "reciente",
        clinicId: "clinica-prune",
        createdAt: new Date(AHORA.getTime() - 24 * HOUR),
      },
    });
    ids.push(viejo.id, reciente.id);

    await pruneSystemEvents(AHORA);

    expect(await prisma.systemEvent.findUnique({ where: { id: viejo.id } })).toBeNull();
    expect(await prisma.systemEvent.findUnique({ where: { id: reciente.id } })).not.toBeNull();
  });
});

describe("listSystemEvents", () => {
  it("filtra por clínica y pagina con el cursor", async () => {
    const creados = [];
    for (let i = 0; i < 3; i++) {
      creados.push(
        await prisma.systemEvent.create({
          data: {
            kind: "whatsapp_envio",
            message: `e${i}`,
            clinicId: "clinica-lista",
            createdAt: new Date(AHORA.getTime() - i * MIN),
          },
        })
      );
    }
    ids.push(...creados.map((c) => c.id));
    await recordSystemEvent({ kind: "cron_error", clinicId: "otra", message: "ajeno" });
    const ajeno = await prisma.systemEvent.findFirstOrThrow({ where: { clinicId: "otra" } });
    ids.push(ajeno.id);

    const primera = await listSystemEvents({ clinicId: "clinica-lista", limit: 2 });
    expect(primera.eventos.map((e) => e.message)).toEqual(["e0", "e1"]);
    expect(primera.siguiente).not.toBeNull();

    const segunda = await listSystemEvents({
      clinicId: "clinica-lista",
      limit: 2,
      before: new Date(primera.siguiente!),
    });
    expect(segunda.eventos.map((e) => e.message)).toEqual(["e2"]);
    expect(segunda.siguiente).toBeNull();
  });
});

describe("getMonitoringSnapshot", () => {
  it("el worker figura vivo si la tarea de cada minuto corrió hace poco", async () => {
    const previo = await prisma.cronHeartbeat.findUnique({ where: { jobName: "inbound-sweeper" } });
    jobsCreados.push("inbound-sweeper");
    const ahora = new Date();
    await prisma.cronHeartbeat.upsert({
      where: { jobName: "inbound-sweeper" },
      create: { jobName: "inbound-sweeper", lastStartedAt: ahora, lastFinishedAt: ahora },
      update: { lastStartedAt: ahora, lastFinishedAt: ahora, lastError: null, lastErrorAt: null },
    });

    const snapshot = await getMonitoringSnapshot();
    expect(snapshot.worker.vivo).toBe(true);
    expect(snapshot.tareas.find((t) => t.name === "inbound-sweeper")?.estado).toBe("ok");

    // Si el latido es viejo, el worker figura caído.
    await prisma.cronHeartbeat.update({
      where: { jobName: "inbound-sweeper" },
      data: { lastFinishedAt: new Date(Date.now() - 3 * HOUR) },
    });
    expect((await getMonitoringSnapshot()).worker.vivo).toBe(false);

    // Se restaura lo que hubiera antes: la base de pruebas es compartida.
    if (previo) {
      await prisma.cronHeartbeat.update({ where: { jobName: "inbound-sweeper" }, data: previo });
      jobsCreados.pop();
    }
  });

  it("lista todas las tareas del catálogo, aunque no hayan corrido", async () => {
    const snapshot = await getMonitoringSnapshot();
    expect(snapshot.tareas.map((t) => t.name)).toEqual(MONITORED_JOBS.map((j) => j.name));
  });

  it("cuenta los errores de las últimas 24 horas por tipo", async () => {
    await recordSystemEvent({ kind: "modelo_fallo", clinicId: "clinica-snap", message: "a" });
    await recordSystemEvent({ kind: "modelo_fallo", clinicId: "clinica-snap", message: "b" });
    const filas = await prisma.systemEvent.findMany({ where: { clinicId: "clinica-snap" } });
    ids.push(...filas.map((f) => f.id));

    const snapshot = await getMonitoringSnapshot();
    const modelo = snapshot.eventos24h.find((e) => e.kind === "modelo_fallo");
    expect(modelo?.cantidad).toBeGreaterThanOrEqual(2);
  });
});
