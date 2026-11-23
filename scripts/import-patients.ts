/**
 * Importación inicial de pacientes de una clínica desde un Excel (.xlsx) o CSV con
 * nombre, teléfono y fecha de la última visita. Ver `src/services/patient-import.ts`.
 *
 * Por defecto es una SIMULACIÓN: no escribe nada. Para cargar de verdad, agregar --apply.
 *
 *   npx tsx scripts/import-patients.ts --clinic <clinicId> --file pacientes.xlsx
 *   npx tsx scripts/import-patients.ts --clinic <clinicId> --file pacientes.xlsx --country-code 52 --apply
 *   npx tsx scripts/import-patients.ts --clinic <clinicId> --rollback <lote>      # deshace un lote
 *
 * Opciones:
 *   --country-code 52   antepone ese código a los números de hasta 10 dígitos (sin esto se avisa y no se adivina)
 *   --date-order mdy    las fechas 03/14/2025 son mes/día (por defecto día/mes)
 *
 * Antes de --apply en producción: respaldo de la base (scripts/db-backup.sh). No manda ningún mensaje.
 */
import { prisma } from "../src/db/client";
import { analyzeRows, applyImport, readImportFile, rollbackImport, type DateOrder } from "../src/services/patient-import";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const clinicId = arg("clinic");
  if (!clinicId) throw new Error("Falta --clinic <id>.");
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { id: true, name: true } });
  if (!clinic) throw new Error("Esa clínica no existe.");

  const rollbackBatch = arg("rollback");
  if (rollbackBatch) {
    const r = await rollbackImport(clinicId, rollbackBatch);
    console.log(`Lote ${rollbackBatch}: ${r.deleted} paciente(s) borrados; ${r.kept} conservados por tener actividad.`);
    return;
  }

  const file = arg("file");
  if (!file) throw new Error("Falta --file <archivo.xlsx|.csv>.");
  const parsed = await readImportFile(file);
  if (parsed.errors.length) {
    parsed.errors.forEach((e) => console.error("✖", e));
    process.exitCode = 1;
    return;
  }
  const dateOrder = (arg("date-order") === "mdy" ? "mdy" : "dmy") as DateOrder;
  const analysis = await analyzeRows(clinicId, parsed.rows, { defaultCountryCode: arg("country-code"), dateOrder });

  console.log(`Clínica: ${clinic.name}`);
  console.log("Columnas entendidas:", JSON.stringify(parsed.detected));
  console.log("Totales:", JSON.stringify(analysis.totals));
  const porMotivo = (items: Array<{ rowNumber: number } & Record<string, unknown>>, k: string) => {
    const m = new Map<string, number[]>();
    for (const it of items) m.set(String(it[k]), [...(m.get(String(it[k])) ?? []), it.rowNumber]);
    return m;
  };
  // Solo números de fila: ni nombres ni teléfonos en la consola.
  for (const [motivo, filas] of porMotivo(analysis.skipped, "reason")) console.log(`  Omitidas por «${motivo}»: ${filas.length} (filas ${filas.slice(0, 15).join(", ")}${filas.length > 15 ? "…" : ""})`);
  for (const [aviso, filas] of porMotivo(analysis.warnings, "warning")) console.log(`  Aviso «${aviso}»: ${filas.length} (filas ${filas.slice(0, 15).join(", ")}${filas.length > 15 ? "…" : ""})`);

  if (!flag("apply")) {
    console.log("\nSIMULACIÓN: no se escribió nada. Revisa lo anterior y repite con --apply para cargar.");
    return;
  }
  const r = await applyImport(clinicId, analysis, { columnas: Object.values(parsed.detected).filter((v): v is string => !!v) });
  console.log(`\nCargados ${r.created} pacientes. Lote: ${r.batchId}`);
  console.log(`Para deshacer: npx tsx scripts/import-patients.ts --clinic ${clinicId} --rollback ${r.batchId}`);
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
