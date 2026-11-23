# Incorporar una clínica que ya está operando: importación, convivencia con su agenda y rollback

Procedimiento genérico (sirve para cualquier clínica). Durante el piloto **la clínica sigue agendando en su Google
Calendar** y además usa la plataforma: las dos agendas conviven sin chocar.

## Cómo conviven las dos agendas
- **Google → plataforma:** `calendar-sync` (cada 15 min, y al instante al conectar una cuenta) copia a la base el
  **rango horario** de cada evento ajeno del calendario del profesional. Esos rangos frenan al asistente: no ofrece ni
  agenda un horario que la clínica ya ocupó en Google. Solo el horario: **nunca el título ni la descripción** (privacidad).
  El retraso máximo es de 15 minutos: un evento creado en Google puede tardar ese tiempo en frenar al asistente.
- **Plataforma → Google:** cada turno que se agenda en la plataforma crea un evento "espejo" en el calendario
  (marcado con `appointmentId`), así el equipo lo ve en su agenda de siempre.
- La plataforma **nunca edita ni borra un evento ajeno**; solo crea y borra sus espejos.
- Lo que no hace: importar las citas que ya estaban en Google como citas de la plataforma (el título del evento no
  trae paciente ni servicio, y no se guarda a propósito). Esas citas se ven como bloqueos.

## Antes de instalar (todo esto es reversible)
1. **Respaldo de la base:** `DATABASE_URL=… bash scripts/db-backup.sh` y **probar restaurarlo** en una base vacía
   (`scripts/db-restore.sh`). En Render, además, activar los respaldos del plan.
2. **Instantánea de la agenda de Google** (después de conectar la cuenta y enlazar los calendarios, antes de la primera cita):
   `npx tsx scripts/calendar-snapshot.ts --clinic <id>` → `backups/calendar-….json` (permisos 600, sensible, fuera de git).
3. **Pacientes existentes**, ver abajo.

## Importar los pacientes de la clínica
Pedirle a la clínica un Excel (.xlsx) o CSV con tres columnas: **nombre, teléfono (con código de país) y fecha de la
última visita**. Acepta títulos distintos ("Paciente", "Celular", "Última visita"…), una fila de título arriba y
«Nombre» y «Apellido» en columnas separadas o juntas.

1. **Simulación** (no escribe nada):
   `npx tsx scripts/import-patients.ts --clinic <id> --file pacientes.xlsx`
   Muestra qué columnas entendió, cuántas filas cargaría y cuáles omite (solo **números de fila**: ni nombres ni teléfonos).
2. Revisar los avisos con la clínica: `sin_codigo_de_pais` (hay números de ≤ 10 dígitos: se puede pasar
   `--country-code 52` si TODOS son del mismo país; sin esa opción **no se adivina**), `fecha_descartada`/`fecha_futura`,
   `nombre_sin_apellido`. Fechas `03/14/2025` (mes/día): `--date-order mdy`.
3. **Cargar:** repetir con `--apply`. Entra todo el lote en una transacción (o nada) y devuelve el **id del lote**.

Qué hace y qué no:
- Crea las fichas con `priorHistory = true`: **no son "de primera vez"** aunque no tengan citas. Guarda la última visita
  informada como dato (`priorLastVisitOn`) sin crear citas, así no se ensucian reportes ni ocupación.
- **No pisa a nadie:** quien ya existe (mismo WhatsApp y mismo nombre) se omite. Varias personas en un mismo número son válidas.
- **No manda ningún mensaje** ni cambia la etapa del CRM. El contacto por próxima cita sugerida sigue apagado.
- Deja una entrada de auditoría (`patient.import`, origen `sistema`) con cantidades y nombres de columnas, nunca datos.
- No importa observaciones ni historia clínica (el asistente las lee y se envían al modelo): decisión de la clínica, aparte.

## Rollback: si algo falla en la instalación
Del más liviano al más drástico. Cada paso es independiente.

| Qué falló | Cómo deshacerlo |
|---|---|
| La importación de pacientes salió mal | `npx tsx scripts/import-patients.ts --clinic <id> --rollback <lote>`: borra ese lote. **Conserva** a quien ya tenga citas, paquetes, comentarios o derivaciones (no se lleva la historia generada después) y lo informa. |
| La plataforma dejó eventos en el Google Calendar | `npx tsx scripts/calendar-snapshot.ts --clinic <id> --rollback-mirrors` (simulación) y luego `--apply`: borra **solo** los espejos creados por la plataforma y desenlaza esas citas. |
| Dudas de si se tocó algo de la agenda | `npx tsx scripts/calendar-snapshot.ts --clinic <id> --verify backups/calendar-….json`: compara los eventos **ajenos** con la instantánea y dice si falta o cambió alguno. Los eventos nuevos que creó la clínica son esperables. |
| La base quedó mal (migración, datos) | Restaurar el respaldo: `CONFIRM_RESTORE=si DATABASE_URL=… bash scripts/db-restore.sh backups/db-….dump`, y reiniciar web y worker. Se pierde lo ocurrido después del respaldo. |
| Salida completa (se abandona el piloto) | 1) `--rollback-mirrors --apply`; 2) apagar el webhook en Meta (los mensajes dejan de llegar a la plataforma); 3) desconectar la cuenta de Google desde "Calendarios"; 4) conservar o borrar los datos según el acuerdo con la clínica. La agenda de Google de la clínica queda como estaba, sin los espejos. |

Notas:
- **Orden recomendado si hay que volver atrás:** primero apagar el webhook (para que no entren turnos nuevos), después
  los espejos, después los pacientes, y la restauración de la base solo si hace falta.
- Los archivos de `backups/` tienen datos de pacientes y títulos de eventos: permisos 600, **nunca a git**, guardarlos cifrados.
- Microsoft/Outlook: la instantánea y el rollback de espejos **todavía solo cubren Google** (el script avisa si el
  calendario es de otro proveedor).
- La auditoría (`AuditLog`) es de solo escritura: los rollbacks **no la borran**; quedan registrados como `patient.import_rollback`
  y `calendar.mirror_rollback`.
