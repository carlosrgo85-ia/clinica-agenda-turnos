# Cómo configurar un rubro nuevo

La plataforma no tiene ninguna regla de negocio hardcodeada para dental ni
para ningún otro rubro. Todo lo que distingue a un tipo de negocio de otro
se configura por clínica, al momento del alta. Esto es lo que hay que
definir para cada rubro nuevo:

## 1. Vocabulario (`Clinic.customerNoun`)

"paciente" para dental o estética médica, "cliente" para un spa de belleza
sin perfil médico. Se inyecta en el system prompt tal cual.

## 2. Criterios de escalamiento (`Clinic.escalationCriteria`)

Texto libre que reemplaza cualquier regla hardcodeada de "cuándo es una
urgencia". Ejemplos:

- **Dental**: "Dolor intenso, sangrado abundante, hinchazón severa, o
  traumatismo."
- **Spa estético**: "Reacción alérgica, quemadura, dolor fuera de lo
  esperado, o cualquier duda sobre contraindicaciones (embarazo,
  medicación, piel sensibilizada)."

Este texto se inyecta directo en la regla 4 del system prompt — no hace
falta tocar código para ajustarlo por clínica.

## 3. Catálogo de servicios (`Service`)

Opcional, pero necesario si algún servicio requiere un equipo específico
(ver el punto 4) o si se quiere calcular huecos disponibles según duración
real. Si el rubro no tiene restricciones de equipo (como dental, salvo
casos puntuales), alcanza con dejar el catálogo vacío y seguir usando
`Clinic.services` como texto libre para que Claude converse.

## 4. Equipos compartidos (`Resource`)

Solo aplica a rubros donde el cuello de botella real puede ser una máquina
y no un profesional ni una sala — típico de estética (láser,
radiofrecuencia). Cada unidad física es una fila de `Resource`, agrupada
por `type`. Si un servicio del catálogo tiene `requiredResourceType`
seteado, `services/availability.ts` va a exigir que haya una unidad de ese
tipo libre además del profesional y la sala.

Si el rubro no usa equipos compartidos, simplemente no se crean filas de
`Resource` y ese chequeo nunca se activa.

## 5. Paquetes de sesiones (`Package`)

Solo aplica si el rubro vende tratamientos por sesiones prepagas (común en
estética: "6 sesiones de depilación láser"). No existe en dental — ahí
simplemente no se crean filas de `Package` y el turno no queda asociado a
ninguna.

## 6. Horario de atención (`WorkingHours`) — obligatorio

Es lo único de esta lista que hay que cargar **siempre**, en cualquier
rubro: sin horario estructurado la clínica **no puede agendar**: el asistente
no ofrece horarios y `booking.ts` rechaza todo turno (`clinica_sin_horario`).
El alta de la clínica ("Nueva clínica") lo exige, y también `POST /platform/clinics`.

Se carga a dos niveles y los dos tienen que permitir el turno:

- **De la clínica** (`professionalId` en null) — cuándo abre el local.
- **De cada profesional** — su horario propio. Si no se le carga ninguno,
  hereda el de la clínica completo.

**El horario de comida es el hueco entre dos tramos del mismo día.** Un
lunes de 9 a 18 con corte de 13 a 14 son dos tramos: 09:00–13:00 y
14:00–18:00. No hay un campo aparte de "descanso". Lo mismo sirve para una
clínica que corta dos veces al día, o para un profesional que come en otro
horario que el resto.

Ejemplos por rubro:

- **Dental**: la clínica de 9 a 13 y de 14 a 20, lunes a viernes; sábados
  de 9 a 13 corrido. Un dentista que solo hace guardias los sábados lleva
  su propio tramo, y así no le entran turnos entre semana.
- **Spa estético**: martes a sábado de 10 a 19 corrido. Una esteticista que
  trabaja media jornada lleva de 10 a 14 como tramo propio.

Se carga con `PUT /dashboard/clinics/:id/working-hours` (y
`.../professionals/:id/working-hours`), o directo en el `create` de la
clínica — ver `scripts/add-clinic.ts`, que trae un ejemplo con corte de
comida. Los minutos van desde la medianoche local de la clínica
(540 = 09:00, 1080 = 18:00).

**Si no se carga, la plataforma manda un email diario** a `Clinic.email`
avisando que falta, porque en ese estado el asistente no puede agendar. El
aviso se corta solo cuando el horario está cargado.

Ojo: `Clinic.businessHours` es un campo aparte, de texto libre, y es solo
lo que Claude le cuenta al paciente en la conversación. No se valida contra
él. Hay que mantener los dos coherentes a mano por ahora.

### Feriados y días especiales (`ScheduleException`)

El horario de arriba es semanal y se repite siempre. Para las fechas
puntuales se cargan excepciones, que **reemplazan** el horario semanal de
ese día:

- **Feriado o día que no se atiende** — sin tramos:
  ```
  PUT /dashboard/clinics/:id/schedule-exceptions
  { "dateKey": "2030-12-25", "reason": "Navidad" }
  ```
- **Media jornada, o un horario distinto ese día** — con tramos:
  ```
  { "dateKey": "2030-12-24", "reason": "Nochebuena: media jornada",
    "tramos": [{ "startMinute": 540, "endMinute": 720 }] }
  ```
- **Abrir un día que normalmente está cerrado** — igual que el anterior,
  con los tramos de ese día.
- **Un solo profesional** (se toma el día, va a un congreso) — agregando
  `professionalId`. No afecta al resto del equipo.

Cargar la misma fecha de nuevo sobrescribe. Para volver al horario semanal,
`DELETE .../schedule-exceptions/2030-12-25`.

### Feriados nacionales

La plataforma trae el calendario de feriados de cada país, así que no hay
que buscarlos a mano. Se habilita con el país de la clínica:

```
PUT /dashboard/clinics/:id/country     { "country": "AR" }
GET /dashboard/clinics/:id/holidays?year=2026
POST /dashboard/clinics/:id/holidays/apply   { "year": 2026 }
```

**Los feriados no se cargan solos**: `GET .../holidays` devuelve el
calendario del año con `yaCargado` en cada fecha, y la clínica confirma
cuáles no atiende. Es a propósito — hay clínicas que trabajan algunos
feriados, y cerrarles el día sin preguntar les haría perder turnos. Para
cargar solo algunos, se pasan las fechas en `dateKeys`.

Si en un feriado se atiende con horario reducido, se carga como excepción
con tramos (arriba) en vez de aplicarlo desde el calendario. Aplicar el
calendario **no pisa** las fechas que ya tienen una excepción cargada.

Países con calendario hoy: **AR** y **MX**. Sumar otro es agregar una
entrada en `src/data/holidays.ts` — es un cambio de datos, no de código.

Mientras queden feriados del año sin revisar, la plataforma manda un aviso
semanal (email, y WhatsApp si la clínica cargó `adminPhone`), y el banner de
configuración muestra un botón para cargarlos de una.

**Desde diciembre se pide también el calendario del año siguiente**, para
que esté confirmado antes del 1 de enero. Si se deja para enero, el
asistente ofrece turnos el Año Nuevo.

### Ver qué falta configurar

`/ui/?clinicId=<id>` muestra el banner con todo lo que falta, y permite
resolver de un click lo que se puede (elegir el país, cargar los feriados).
La misma información sale por API en
`GET /dashboard/clinics/:id/config-health`.

## 7. Política de primera vez (opcional, cualquier rubro)

Si un solo profesional recibe y evalúa a los clientes/pacientes nuevos
(caso real de la clínica dental piloto, pero aplica igual a un spa con una
esteticista que hace la evaluación de piel inicial), marcar un servicio como "primera vez" (`Service.firstVisit`) en la pantalla
"Servicios" y asignarlo solo a esa persona. Ver `services/catalog.ts`.

## Resumen: qué es igual para todos los rubros

Todo el resto — multi-tenant, CRM con etapas, dashboard de auditoría y
métricas, recordatorios, cobro de seña, validación de profesional +
espacio (+ equipo si aplica) + horario de atención — es exactamente el
mismo código para cualquier clínica, sin importar el rubro.
