/**
 * Instantánea de la agenda de una clínica ANTES de conectarla a la plataforma, y la forma de
 * deshacer lo que la plataforma escribió en ella. Solo Google Calendar por ahora.
 *
 *   # 1. Antes de instalar: guarda cómo está la agenda (archivo local, sensible, fuera de git)
 *   npx tsx scripts/calendar-snapshot.ts --clinic <id>
 *
 *   # 2. Después de operar, comprueba que NO cambió ni se perdió ningún evento ajeno
 *   npx tsx scripts/calendar-snapshot.ts --clinic <id> --verify backups/calendar-<clinica>-<fecha>.json
 *
 *   # 3. Rollback: borra los eventos que creó la plataforma (los espejos de turnos).
 *   #    Sin --apply solo muestra cuántos borraría.
 *   npx tsx scripts/calendar-snapshot.ts --clinic <id> --rollback-mirrors [--apply]
 *
 * La plataforma NUNCA edita ni borra un evento ajeno: solo crea y borra sus espejos (marcados con
 * `appointmentId` en las propiedades privadas). Por eso el rollback borra únicamente esos y la
 * instantánea sirve, sobre todo, como PRUEBA de que lo demás quedó intacto.
 *
 * Opciones: --days-back 30 --days-ahead 365 (ventana de la instantánea).
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/db/client";
import { recordSystemAudit } from "../src/services/audit";
import {
  CLINIC_CALENDAR_INCLUDE,
  PROFESSIONAL_CALENDAR_INCLUDE,
  exportCalendarEvents,
  removeMirroredEvent,
  resolveCalendarTargetForProfessional,
} from "../src/services/calendar";
import type { CalendarSnapshotEvent, CalendarTarget } from "../src/services/calendar-providers/types";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const flag = (n: string) => process.argv.includes(`--${n}`);
const DAY = 86_400_000;

interface SnapshotFile {
  clinicId: string;
  takenAt: string;
  from: string;
  to: string;
  calendars: Array<{ provider: string; calendarId: string; events: CalendarSnapshotEvent[] }>;
}

/** Los calendarios distintos de la clínica (el compartido, o el de cada profesional). */
async function clinicTargets(clinicId: string): Promise<CalendarTarget[]> {
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, include: CLINIC_CALENDAR_INCLUDE });
  if (!clinic) throw new Error("Esa clínica no existe.");
  const professionals = await prisma.professional.findMany({ where: { clinicId }, include: PROFESSIONAL_CALENDAR_INCLUDE });
  const seen = new Map<string, CalendarTarget>();
  for (const p of professionals) {
    const t = resolveCalendarTargetForProfessional(clinic, p);
    if (t) seen.set(`${t.provider}|${t.calendarId}`, t);
  }
  return [...seen.values()];
}

async function takeSnapshot(clinicId: string, from: Date, to: Date): Promise<SnapshotFile> {
  const targets = await clinicTargets(clinicId);
  if (targets.length === 0) throw new Error("La clínica no tiene ningún calendario enlazado: no hay nada que respaldar.");
  const calendars: SnapshotFile["calendars"] = [];
  for (const t of targets) {
    const events = await exportCalendarEvents(t, from, to);
    if (events === null) throw new Error(`El proveedor ${t.provider} todavía no se puede respaldar con este script.`);
    calendars.push({ provider: t.provider, calendarId: t.calendarId, events });
  }
  return { clinicId, takenAt: new Date().toISOString(), from: from.toISOString(), to: to.toISOString(), calendars };
}

async function main() {
  const clinicId = arg("clinic");
  if (!clinicId) throw new Error("Falta --clinic <id>.");
  const back = Number(arg("days-back") ?? 30);
  const ahead = Number(arg("days-ahead") ?? 365);

  // --- Rollback de los espejos ---
  if (flag("rollback-mirrors")) {
    const now = Date.now();
    const snap = await takeSnapshot(clinicId, new Date(now - back * DAY), new Date(now + ahead * DAY));
    const targets = await clinicTargets(clinicId);
    const mine = snap.calendars.map((c) => ({ c, events: c.events.filter((e) => e.isOurs) }));
    const total = mine.reduce((n, x) => n + x.events.length, 0);
    console.log(`Eventos creados por la plataforma en los calendarios de la clínica: ${total}`);
    if (!flag("apply")) { console.log("SIMULACIÓN: no se borró nada. Repite con --apply."); return; }
    let deleted = 0;
    const ids: string[] = [];
    for (const { c, events } of mine) {
      const target = targets.find((t) => t.provider === c.provider && t.calendarId === c.calendarId)!;
      for (const e of events) {
        try { await removeMirroredEvent(target, e.id); deleted++; ids.push(e.id); }
        catch (err) { console.error(`  No se pudo borrar un evento (${e.id}):`, err instanceof Error ? err.message : err); }
      }
    }
    const { count } = await prisma.appointment.updateMany({ where: { clinicId, googleEventId: { in: ids } }, data: { googleEventId: null } });
    await recordSystemAudit({
      origin: "sistema", clinicId, action: "calendar.mirror_rollback", resourceType: "clinic", resourceId: clinicId,
      details: { eventosBorrados: deleted, citasDesenlazadas: count },
    });
    console.log(`Borrados ${deleted} eventos espejo; ${count} cita(s) quedaron sin enlace al calendario.`);
    return;
  }

  // --- Verificar contra una instantánea ---
  const verifyFile = arg("verify");
  if (verifyFile) {
    const before = JSON.parse(await readFile(verifyFile, "utf8")) as SnapshotFile;
    if (before.clinicId !== clinicId) throw new Error("Esa instantánea es de otra clínica.");
    const now = await takeSnapshot(clinicId, new Date(before.from), new Date(before.to));
    let missing = 0, changed = 0, added = 0, checked = 0;
    for (const old of before.calendars) {
      const cur = now.calendars.find((c) => c.provider === old.provider && c.calendarId === old.calendarId);
      if (!cur) { console.error(`✖ Un calendario de la instantánea ya no está enlazado (${old.provider}).`); missing += old.events.filter((e) => !e.isOurs).length; continue; }
      const byId = new Map(cur.events.map((e) => [e.id, e]));
      for (const e of old.events.filter((x) => !x.isOurs)) {
        checked++;
        const now2 = byId.get(e.id);
        if (!now2) { missing++; console.log(`  Falta un evento ajeno: ${e.id}`); }
        else if (now2.start !== e.start || now2.end !== e.end || now2.summary !== e.summary) { changed++; console.log(`  Cambió un evento ajeno: ${e.id}`); }
      }
      const beforeIds = new Set(old.events.map((e) => e.id));
      added += cur.events.filter((e) => !e.isOurs && !beforeIds.has(e.id)).length;
    }
    console.log(`Eventos ajenos comprobados: ${checked}. Faltan: ${missing}. Cambiaron: ${changed}. (Nuevos desde la instantánea, esperables si la clínica sigue usando su agenda: ${added}.)`);
    console.log(missing + changed === 0 ? "✔ La plataforma no alteró ningún evento ajeno." : "✖ Hay diferencias: puede haberlas hecho la clínica; revisa los ids de arriba en Google Calendar.");
    if (missing + changed > 0) process.exitCode = 1;
    return;
  }

  // --- Tomar la instantánea ---
  const now = Date.now();
  const snap = await takeSnapshot(clinicId, new Date(now - back * DAY), new Date(now + ahead * DAY));
  const dir = path.resolve(process.cwd(), "backups");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `calendar-${clinicId}-${snap.takenAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(file, JSON.stringify(snap, null, 2), { mode: 0o600 });
  await chmod(file, 0o600);
  const n = snap.calendars.reduce((a, c) => a + c.events.length, 0);
  console.log(`Instantánea guardada: ${file}`);
  console.log(`${snap.calendars.length} calendario(s), ${n} evento(s). El archivo tiene títulos de eventos: es sensible, guárdalo cifrado y no lo subas a git.`);
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
