# CLAUDE.md

Este archivo le da contexto a Claude Code sobre este proyecto. Léelo antes de
hacer cambios.

## Qué es este proyecto

Una plataforma multi-clínica (SaaS) de agente de WhatsApp para gestión de
turnos, **agnóstica de rubro**. Nació para clínicas dentales, pero el
modelo de datos y el código no tienen nada específico de odontología — lo
mismo sirve para un spa estético, un consultorio de kinesiología, o
cualquier negocio que agende turnos con profesionales, espacios físicos y,
opcionalmente, equipos compartidos. Ver `docs/onboarding-vertical.md` para
el checklist completo de qué configurar al sumar un rubro nuevo.

Un solo backend atiende a todas las clínicas clientes. Cada una tiene su
propio número de WhatsApp, sus propios profesionales, espacios, y — si
aplica — equipos y catálogo de servicios.

## Stack

- Node.js + TypeScript, Express
- Postgres + Prisma — fuente de verdad de la disponibilidad de turnos, NO
  Google Calendar
- `@anthropic-ai/sdk` (motor de IA compartido)
- `googleapis` — espejo de la agenda personal de cada profesional
- `nodemailer`, `node-cron`

## Comandos

```bash
npm install
npm run db:generate
npm run db:migrate
npx tsx scripts/add-clinic.ts   # tiene un ejemplo dental y uno de spa comentado
npm run dev               # API + worker de crons + SPA, juntos
npm run db:studio

docker compose up -d db   # Postgres local; el .env apunta al puerto 5433
npm test                  # necesita esa base levantada
```

En producción son **dos procesos**: `npm start` (servidor web, N instancias
posibles) y `npm run start:worker` (tareas programadas, **una sola
instancia**) — ver "Dos procesos" más abajo.

## Reglas transversales: se aplican a TODO cambio

Lo que sigue no es de una pantalla ni de una funcionalidad: hay que tenerlo presente
en **cualquier** cambio, y revisarlo antes de dar algo por terminado.

1. **Auditoría: toda operación que modifica algo deja registro** (quién, qué,
   cuándo, sobre qué y con qué resultado), **desde el login**, y **nunca guarda los
   valores de lo que se escribió**. Una ruta nueva de la API ya queda cubierta
   sola (`middleware/audit.ts`), pero **lo que no pasa por una ruta de la API**
   —un job, el asistente de WhatsApp, un script— tiene que registrarse explícitamente
   (`AppointmentEvent`, `SystemEvent` o `recordSystemAudit()`, con su origen), y **si agregas algo que
   guarda datos sensibles hay que decidir qué se registra y qué no**. Ver la sección
   "Auditoría y eventos de cita" y su checklist.
2. **Registrar eventos de todo lo que se pueda** (decidido el 2026-11-13): ante la duda,
   se registra. Un hecho que no se guardó no se puede reconstruir después (las
   cancelaciones anteriores a esa fecha se perdieron justamente por eso). Incluye **cada
   solicitud que se le manda al agente**: toda llamada al modelo de IA deja su rastro
   (`AgentRequest`: cuánto tardó, cuánto costó, cómo terminó y qué decidió) y **no hay forma
   de llamarlo sin dejarlo**, porque `interpretWithClient()` exige un `trace`. Lo que se
   registra son metadatos y decisiones estructuradas, **nunca el texto** de los mensajes ni
   los datos del paciente.

3. **Cada funcionalidad se revisa contra la legislación mexicana** (decidido el 2026-11-20: México es el país donde se
   opera hoy). Antes de dar un cambio por terminado hay que preguntarse si modifica **qué datos se tratan, a quién se
   comparten o se envían (el modelo de IA, Meta, Google, un proveedor nuevo), cuánto se conservan, qué se le dice o se le promete
   al paciente o a la clínica, o cómo se cobra**, y comprobar que `docs/legal/` (política de privacidad y términos de servicio)
   **siga siendo cierto**. Si no lo es, **hay que AVISARLE al usuario de forma explícita en la respuesta** —qué cambió, qué
   texto hay que actualizar y por qué— y no dejarlo para después; y si aparece un riesgo normativo, decirlo aunque no
   haya cambiado ningún texto. Marcos de partida, **a verificar siempre contra la fuente vigente y no de memoria** (las
   normas cambian y esto no es asesoría legal): la **Ley Federal de Protección de Datos Personales en Posesión de los
   Particulares** (nueva ley publicada en el DOF el 20-mar-2025, con una reforma posterior; la autoridad pasó del INAI a la
   Secretaría Anticorrupción y Buen Gobierno) con sus **datos sensibles de salud**, el **aviso de privacidad** (lo da la clínica,
   que es la responsable), el consentimiento y los **derechos ARCO**; la **NOM-004-SSA3-2012** (expediente clínico) y la
   **NOM-024-SSA3-2012** (registro electrónico en salud) para cualquier historia clínica; la **firma electrónica**; la
   **publicidad de servicios de salud (COFEPRIS)** y la **Ley Federal de Protección al Consumidor / Profeco** para campañas,
   promociones, precios y contratos; y **facturación (CFDI/SAT)** y la normativa de **pagos y domiciliación** para los cobros.
   Si un feature viene del backlog (Instagram/Facebook, voz, historia clínica, pagos, sitio público), esta revisión es parte del
   **diseño**, no de la entrega. El resultado de la revisión se apunta en `docs/legal/pendientes-antes-de-publicar.md`. Si la
   plataforma empieza a operar en otro país, esta regla se repite para ese país.

## Plantillas de WhatsApp: son por WABA, no por plataforma

Cada clínica es dueña de su propio WhatsApp Business Account (WABA) —es el
modelo que corresponde para vender esto como SaaS: si todos los números
colgaran de un WABA nuestro, una suspensión se los lleva puestos a todos, y
los *messaging limits* se comparten entre las clínicas del mismo portfolio—.

La consecuencia que importa acá: **una plantilla aprobada en la clínica A no
existe para la clínica B.** Hay que crearla y hacerla aprobar en cada WABA.
Por eso `Clinic.whatsappWabaId` — sin él no se puede hacer nada que no sea
mandar un mensaje.

`services/whatsapp-templates.ts` tiene el catálogo de las plantillas que el
código realmente manda (`CLINIC_TEMPLATES`) y las crea en el WABA de la
clínica. Se corre solo en el alta (`POST /platform/clinics`), y se puede
reintentar con `POST /platform/clinics/:id/whatsapp/templates`. Es
idempotente: la que ya existe se informa como `ya_existia`.

Dos cosas que no son obvias:

- **Crear no es aprobar.** Una plantilla recién creada queda en `PENDING` y
  no se puede usar para enviar. `GET /platform/clinics/:id/whatsapp/templates`
  cruza el catálogo con lo que hay en Meta para poder ver cuál quedó en
  `REJECTED` — que es la causa típica de "los recordatorios no llegan", y
  desde afuera se ve igual que un bug nuestro.
- **El texto y la cantidad de parámetros tienen que coincidir con lo que
  manda el código.** Meta valida la cantidad de parámetros en el momento del
  envío: si la plantilla aprobada tiene 3 y el job manda 4, el mensaje se
  rechaza. Por eso cada entrada de `CLINIC_TEMPLATES` dice en un comentario
  qué job la manda y con qué parámetros.

- **Meta rechaza una plantilla con demasiadas variables para lo corto del
  texto** (subcódigo 2388293), y tampoco admite una variable al principio ni al
  final. `cita_asignada_profesional` (5 variables) y `aviso_configuracion` (3)
  quedaron sin crear por eso (2026-11-06), con un "Invalid parameter" genérico
  (después se alargó el texto y se crearon).
  El motivo real viene en `error_user_title` / `error_user_msg`: `createTemplate()`
  ahora los muestra (antes mostraba solo el genérico) y reconoce "ya existe" por
  el subcódigo 2388024 o el texto, no por `message`. Al sumar una plantilla,
  poner varias palabras alrededor de las variables; cambiar el TEXTO de una ya
  aprobada obliga a volver a aprobarla en cada WABA.
- **Meta puede reclasificar una plantilla de Utilidad a Marketing** aunque se
  cree como `UTILITY`. Le pasó a `aviso_configuracion` en la Clínica Demo
  (2026-11-06): se aprobó (la de las variables ya estaba resuelta), pero con el
  cierre "Gracias por mantener tu configuración al día" Meta la tomó por
  comercial. Marketing cuesta más, tiene límites propios y entrega peor. El
  texto del catálogo ya no lleva cortesías, pero **solo rige para clínicas
  nuevas**: en los WABA ya creados hay que editar la plantilla en el WhatsApp
  Manager (Editar plantilla conserva el nombre) y pedir la revisión de
  categoría (24 hs desde el aviso, 60 días desde la reclasificación). Al
  redactar, alargar con texto operativo y no con frases amables. En la
  Clínica Demo las demás plantillas quedaron activas y en Utilidad; solo
  `aviso_configuracion` se reclasificó. Se la editó con el texto nuevo el
  2026-11-13 y quedó "En revisión": falta confirmar que vuelva a Utilidad.

El alta no falla si Meta está caído — mismo criterio que el espejo en
Calendar: la clínica ya está creada y sirve para todo lo demás.

## El token de WhatsApp se guarda cifrado

`Clinic.whatsappTokenEncrypted` va cifrado con AES-256-GCM
(`services/crypto.ts`), igual que el refresh token de Google y con la misma
clave (`CALENDAR_TOKEN_ENCRYPTION_KEY`). Es la credencial con la que se le
escribe a los pacientes de esa clínica: en texto plano, un dump de la base
alcanzaba para mandar WhatsApps en su nombre.

- `services/whatsapp.ts` → `clinicWhatsAppCreds()` es el **único** lugar
  donde se descifra. Si cada llamador lo hiciera por su cuenta, tarde o
  temprano alguno lo loguea o lo mete en una respuesta de la API.
- `listAllClinics()` y `findClinicDetail()` (las del panel de plataforma)
  devuelven la clínica **sin** esa columna, y el filtro está en el
  repositorio y no en la ruta a propósito: si dependiera de que cada handler
  se acuerde, el próximo endpoint lo filtra. Lo que necesita el token pide
  `findClinicWithWhatsAppCreds()`, que es explícito.
- La clave pasó a ser necesaria para operar, no solo para los calendarios:
  sin ella no se puede descifrar el token y no sale ningún mensaje.

## Dos procesos: servidor web y worker de tareas programadas

`src/index.ts` es **solo** Express (webhook, dashboard, OAuth, la SPA).
`src/worker.ts` es el que programa los quince crons, y **tiene que haber una
sola instancia corriendo**.

Antes los crons se programaban adentro del callback de `app.listen()`, así
que los programaba cada instancia del servidor web. Eso ataba una cosa a la
otra: levantar una segunda instancia del webhook —lo que hace falta apenas
entran muchos mensajes juntos, porque cada mensaje retiene su conexión de
Prisma mientras espera las dos llamadas a Claude— hacía que a cada paciente
le llegara cada recordatorio dos veces y que el sync de calendario importara
los mismos bloqueos en paralelo.

Separados, el servidor web queda sin nada que dependa de ser único: N
instancias atrás de un balanceador y nadie recibe nada duplicado. El worker
es el que no se replica.

La contracara es que el worker hay que levantarlo aparte (`npm run
start:worker`; en desarrollo `npm run dev` levanta los dos). Si no está
corriendo, la plataforma atiende pacientes igual, pero nadie recibe
recordatorios, reportes ni avisos de configuración, y los bloqueos de Google
Calendar dejan de importarse. Es una falla silenciosa — vale la pena
monitorearla.

**Cada cron se protege a sí mismo.** Una excepción que escapa del callback
`async` de `node-cron` no la agarra nadie: es una promesa rechazada sin
manejar, y Node ≥15 mata el proceso con eso. Con los quince crons en un mismo
worker, uno solo tirando abajo el proceso deja sin correr a los otros once.
Por eso cada job tiene dos niveles de `try/catch`: uno por clínica (una
clínica con un problema no puede dejar sin recordatorio a las que faltaban
recorrer) y uno exterior que envuelve todo el callback, incluida la query
que trae las clínicas.

## Por qué Google Calendar dejó de ser la fuente de disponibilidad

`Appointment` en Postgres es la fuente de verdad. Antes de crear un turno
se valida: (1) el profesional no tiene otro turno que se solape, (2) hay
al menos un espacio físico libre, y (3) si el servicio lo requiere, hay
una unidad de equipo libre del tipo necesario (`services/availability.ts`).
Google Calendar es un espejo — un turno creado en la base se refleja como
evento en el calendario personal del profesional, nunca al revés.

Esto es necesario apenas hay más profesionales que espacios/equipos
disponibles (ej. 5 dentistas, 3 consultorios; o 2 esteticistas, 1 solo
láser) — ninguna API de calendario externa modela ese tipo de cuello de
botella compartido.

### La única lectura de Google Calendar: los bloqueos

Los profesionales suelen manejar UNA sola agenda con lo personal y lo
laboral junto. Si el bot ignora eso, agenda pacientes encima del rato que
el profesional se bloqueó.

Por eso `jobs/calendar-sync.ts` corre cada 15 minutos, lee los eventos de
cada calendario y copia a la tabla `CalendarBlock` los que **no** creamos
nosotros. Un evento es "nuestro" si tiene `appointmentId` en
`extendedProperties.private` (lo pone `mirrorAppointmentToCalendar`).

Esto NO contradice lo de arriba, y la distinción importa:

- El calendario se lee en un job aparte, y el resultado se copia a Postgres.
- `availability.ts` sigue consultando **únicamente Postgres** en el momento
  de decidir si un horario está libre. Nunca llama a Google.
- Si Google está caído, el peor caso es trabajar con bloqueos algo
  desactualizados; agendar sigue funcionando.

Lo que sigue prohibido es preguntarle a Google "¿este horario está libre?"
durante la decisión de un turno.

De los eventos de bloqueo se guarda **solo el rango horario** — ni título
ni descripción. Para frenar un turno y mostrarlo como "tiempo bloqueado"
alcanza con eso, y el título del evento personal de un profesional no es
algo que esta plataforma necesite tener.

Se ignoran los eventos marcados como "Libre" (`transparency: transparent`),
los cancelados, y las invitaciones que el profesional rechazó.

### Cómo se accede a los calendarios: OAuth o cuenta de servicio

Hay dos modos y conviven a propósito, para no romper las clínicas ya
cargadas. `services/calendar.ts` → `getCalendarClient()` es el único lugar
donde se elige.

**OAuth (recomendado).** La clínica autoriza su propia cuenta de Google
desde `/oauth/google/start?clinicId=...` y después elige el calendario de
una lista (`listAvailableCalendars`). Los tokens quedan en `GoogleAccount`.

**El cliente OAuth de Google es uno solo para toda la plataforma** (no por
clínica: agregar una clínica no toca nada) y se carga desde Catálogos →
Secretos, en la tarjeta "Google Calendar (OAuth)". Vive en `PlatformOAuthApp`
(id y URI en claro, secreto CIFRADO) y se usa al instante, sin reiniciar el
servidor web ni el worker. `services/google-oauth-config.ts` →
`getGoogleOAuthConfig()` es el ÚNICO lugar que lo descifra y lo resuelve: lo
guardado manda **entero** sobre `GOOGLE_OAUTH_*` del `.env` (que queda de
respaldo; no se mezclan campos de las dos fuentes), con caché de 60 s como los
secretos. Se verifica contra Google antes de guardar
(`verifyGoogleOAuthClient()`: un `code` inventado devuelve `invalid_grant` si
el par es bueno e `invalid_client` si no). Como la config sale de la base,
`isOAuthConfigured()`, `buildConsentUrl()` y `getClientForAccount()` son
**async**. El secreto es de solo escritura: ninguna respuesta de la API lo
devuelve (`GET/PUT/DELETE /platform/google-oauth`, permisos `secretos.*`).
"Configurado" solo dice que hay un valor guardado, no que Google lo acepte hoy: el botón
**"Verificar ahora"** (`POST /platform/google-oauth/verify`, permiso `secretos.ver`) repite contra
Google la prueba del guardado sobre la app EN USO (guardada o del `.env`) y muestra el resultado en
pantalla, sin guardar nada. Una falla de red devuelve 502 y no se marca como inválido.
Además `jobs/google-oauth-health.ts` (`google-oauth-health`, 08:10 todos los días) hace la misma
prueba sola: si Google la rechaza deja un evento `google_oauth_invalido` en Monitoreo y manda un mail
a los administradores de la plataforma (uno por día mientras siga mal; no hay marca porque corre una
vez al día). Una falla de red no se toma como "inválida". Si el SMTP está caído ese día, el evento
igual queda y se reintenta mañana. **Solo el super-admin ve esta tarjeta**: es la credencial de toda la
plataforma. Las clínicas autorizan su cuenta desde "Calendarios" (`calendarios.editar`).

**Cuenta de servicio (el modo viejo).** `GOOGLE_CLIENT_EMAIL` /
`GOOGLE_PRIVATE_KEY`, y la clínica tiene que compartirle cada calendario a
mano y pasar el calendar ID. Se usa cuando el calendario no tiene
`GoogleAccount` asociada. Estas variables ya **no** son obligatorias para
arrancar: si un calendario las necesita y faltan, el error salta ahí con un
mensaje explícito.

Sobre los tokens de OAuth:

- El `refreshToken` se guarda **cifrado** con AES-256-GCM
  (`services/crypto.ts`). La clave está en `CALENDAR_TOKEN_ENCRYPTION_KEY`,
  fuera de la base — si se pierde, todas las clínicas tienen que reconectar.
- El `state` del flujo va firmado con HMAC y vence a los 10 minutos. Sin
  eso, alguien podría hacer que una clínica conecte una cuenta ajena.
- Los scopes son los mínimos: `calendar.events` (crear/borrar los eventos
  espejo, leer los ajenos para los bloqueos) y `calendar.readonly` (listar
  los calendarios). **No** se pide el scope `calendar` completo.
- `access_type=offline` + `prompt=consent` en la URL de consentimiento:
  Google manda el refresh token una sola vez por autorización, y sin
  refresh token el acceso se cae en una hora y los cron jobs dejan de andar.
- Cuando Google devuelve `invalid_grant` (la clínica revocó el acceso), la
  cuenta se marca con `revokedAt` y la interfaz pide reconectar, en vez de
  reintentar cada 15 minutos para siempre.

**El access token guardado y el 401 "Invalid Credentials" (2026-11-21).** `getClientForAccount()` entrega al cliente el access token guardado con su
`expiry_date`. La librería de Google **solo reintenta un 401 con un token nuevo si no hay `expiry_date` o si `forceRefreshOnFailure` está prendido**:
como guardamos el vencimiento, un token que Google rechazaba aunque figurara vigente hacía fallar cada pasada de `calendar-sync` hasta que vencía solo
(pasó el 2026-11-19). `newOAuthClient()` ahora lo prende, así que un 401 refresca y reintenta una vez; si el refresh token también es inválido,
sigue siendo `invalid_grant` y la cuenta se marca como revocada. Test: `tests/google-auth-client.test.ts` (prueba la configuración, no la respuesta de Google).

### Cuándo se sincronizan los bloqueos, y cuándo se avisa que el acceso se cayó

`calendar-sync` corre cada 15 minutos, pero **también corre al instante**
cuando alguien conecta una cuenta (callback de OAuth) o enlaza un calendario
(`PUT .../calendars/shared`, `PUT .../professionals/:id/calendar`):
`syncClinicBlocksNow()` en `jobs/calendar-sync.ts`. No espera ni propaga
errores —el endpoint ya tiene su respuesta— y no arranca un segundo sync si ya
hay uno de esa clínica en ese proceso. Antes, quien reconectaba la cuenta
tenía hasta 15 minutos con el asistente ofreciendo horarios ocupados (pasó el
2026-11-04). Sigue siendo copiar a Postgres: la decisión de disponibilidad no
lee Google. Un sync inmediato (proceso web) y el del cron (worker) pueden
solaparse; para Google es inocuo, y con Microsoft el riesgo es el refresh
rotativo en paralelo (ver "Cosas que no hay que hacer"), que solo se da si
coinciden con el minuto del cron.

**Una cuenta revocada se avisa, no solo se marca.** `calendar-sync` ya
detectaba la revocación y ponía `revokedAt`, pero nadie lo comunicaba.
`jobs/calendar-access-alerts.ts` (de 8 a 20, minuto 5) manda un mail por
clínica con todas sus cuentas revocadas **en uso** (la de un calendario
compartido o de un profesional activo; una revocada que nadie usa no rompe
nada) y un WhatsApp por la plantilla `aviso_configuracion` si hay
`adminPhone`. Se repite una vez por día (`revokedAlertSentAt` en
`GoogleAccount` / `MicrosoftAccount`) hasta que se reconecte, que borra
`revokedAt` y `revokedAlertSentAt`. Solo se marca avisada si el mail salió.
El mismo dato aparece como issue bloqueante `calendario_revocado` en
`config-health` (banner y pantalla de Configuración).

Lo que **no** cubre: avisar ANTES de que se revoque. Un refresh token revocado
solo se descubre al usarlo, y en esta cuenta eso pasa cada 15 minutos por el
sync, así que la ventana es corta; pero un vencimiento por modo Prueba de
Google (7 días) o por inactividad no se puede predecir. La solución de fondo
es publicar la app de Google.

### Un calendario por profesional o uno compartido

- `Professional.googleCalendarId` (nullable) — el calendario personal.
  `null` = "todavía no enlazado": el turno vive en Postgres y simplemente
  no se espeja. `Professional.googleAccountId` dice con qué credencial se
  accede.
- `Clinic.sharedCalendarId` (nullable) — si está seteado, **todo** el
  equipo se espeja en ese calendario único y tiene prioridad sobre el
  personal de cada uno. Su credencial es `Clinic.sharedCalendarAccountId`.
- `resolveCalendarTargetForProfessional()` en `services/calendar.ts` es el
  único lugar donde se decide cuál de los dos se usa. Devuelve calendario
  **y** credencial juntos, porque son inseparables — quien consulta un
  calendario tiene que hacerlo con la cuenta que lo conectó.
- `Professional.blockSyncEnabled` — apaga la importación de bloqueos de ese
  profesional sin apagar el espejo.

Ojo al agregar una query: si traés un `Professional` o un `Clinic` para
espejar o borrar un evento, hay que incluir la relación (`googleAccount` /
`sharedCalendarAccount`). Sin eso, `resolveCalendarTargetForProfessional()`
se cae en silencio a la cuenta de servicio.

En un calendario compartido, un evento ajeno se aplica como bloqueo a
**todos** los profesionales que lo usan: no hay forma de saber de quién es.
Es el criterio conservador — puede rechazar algún horario que en realidad
estaba libre, pero nunca agenda encima de algo ocupado.

## Qué es genérico y qué se configura por rubro

**Genérico (mismo código para cualquier clínica):**
- Multi-tenant, identificación de clínica por `phone_number_id`
- CRM con etapas automatizadas (`Patient.stage`)
- Validación de profesional + espacio (+ equipo si aplica)
- Dashboard de auditoría y métricas
- Escalamiento con resumen del paciente/cliente
- Recordatorios (24hs, 2hs Plus), seguimiento post-visita (Plus), cobro de
  seña (Plus)
- Política de "primera vez" vía `Service.firstVisit` (opcional,
  cualquier rubro)

**Configurable por clínica, sin tocar código:**
- `Clinic.customerNoun` — "paciente" vs "cliente"
- `Clinic.serviceNoun` — cómo le dice el asistente al paciente a lo que se agenda: "tratamiento" en
  un dental, "servicio" en un spa (default "servicio"). Se edita en el detalle de la clínica (super-admin)
  y es **solo vocabulario del texto que lee el paciente** (`buildSystemPrompt()` y
  `recordatorioDeTratamiento()`): la etiqueta "Servicios que ofrece la clínica", las claves `servicio` del JSON y
  el catálogo `Service` no cambian, porque el modelo los usa para copiar el nombre exacto. Se valida con
  `isValidServiceNoun()` (una línea, hasta 30 caracteres: va dentro del prompt). Es una regla de prompt
  (probabilística): los tests prueban que llega, no que el modelo obedezca.
- `Clinic.escalationCriteria` — qué cuenta como urgencia en ESE rubro (el
  system prompt ya no tiene ninguna regla de urgencia hardcodeada)
- `Clinic.services` (texto libre) + `Service` (catálogo formal, con duración
  y equipo requerido si aplica). **El prompt usa el catálogo si la clínica lo
  cargó, y cae al texto libre si está vacío** — ver "Catálogo de servicios"
  más abajo. Se administra desde la pantalla "Servicios".
- `Resource` — solo se usa si el rubro tiene equipos compartidos que son
  el cuello de botella real (típico en estética, no en dental)
- `Package` — solo se usa si el rubro vende sesiones prepagas (típico en
  estética)

Si en algún momento aparece una regla de negocio que "solo aplica a
dental" o "solo aplica a spa", la señal correcta es: ¿esto puede resolverse
con un campo de texto configurable o un flag en `Clinic`, o es
genuinamente estructural? Casi siempre es lo primero — evitar volver a
meter lógica específica de un rubro en el código.

## La ubicación de la clínica

Hay **dos** momentos en que se manda un mensaje aparte con la dirección y el
link de Google Maps (`services/location.ts` → `buildLocationMessage()`):

1. **Cuando el paciente la pide.** El modelo marca `pidio_ubicacion: true`
   en su respuesta y contesta en prosa; el código adjunta el mensaje con los
   datos exactos. `Clinic.address` va en el system prompt justamente para
   que pueda contestar: antes no la recibía —solo figuraba "dirección" como
   ejemplo de `consultar_info`— así que ante "¿cuál es la dirección?" no
   tenía más opción que escalar, y escalaba siempre.
2. **Al sacar su primer turno**, después de la confirmación. Quien ya vino
   sabe dónde queda, así que no se repite. Si además la pidió en ese mismo
   mensaje, se manda una sola vez.

El mensaje se arma **en código y no en el prompt** a propósito: un link que
el modelo reescribe es un link que puede salir mal, y este es justo el
mensaje donde equivocarse significa que el paciente no llega. Por eso el
prompt le prohíbe explícitamente escribir links él.

`pidio_ubicacion` es el único flag que `parseAgentResponse()` **no** exige:
que falte solo significa que no se adjunta la dirección, y tirar la
respuesta entera por eso dejaría al paciente sin contestación. Los otros
tres cambian lo que se hace con el turno, así que ahí una respuesta a medias
no sirve.

- El link sale de `Clinic.googleBusinessUrl` cuando está cargado (la ficha
  exacta del negocio); si no, se busca por `Clinic.address`
  (`maps/search/?api=1&query=...`, con la dirección escapada — sin eso un
  `#` en la altura corta la URL). Sin ninguno de los dos no se manda nada.
- Va **después** de la respuesta: lo que el paciente espera leer es la
  confirmación. Si el envío falla, el turno ya está creado — se loguea y
  nada más.
- El texto es casi todo datos, sin verbos dirigidos al paciente: el prompt
  le exige al modelo el español del país de la clínica (tuteo o voseo), y
  esto no pasa por el modelo. Con frases hechas, el mensaje siguiente
  sonaría de otra región.

## Escalamiento a una persona

Cuando el asistente marca `escalar_a_humano`, `services/agent-turn.ts` →
`registrarEscalamiento()` hace dos cosas, **en este orden y no al revés**:

1. **Guarda una fila `Escalation`** (paciente, teléfono, motivo, mensaje
   textual, resumen).
2. **Manda el mail** a `Clinic.urgencyNotifyEmail` — o a `Clinic.email` si no
   está cargado — y recién ahí marca `notifiedByEmail`.

El orden es la garantía: el bot ya le **prometió** al paciente que alguien lo
va a contactar, así que un aviso que falla no puede ser el único rastro. Una
derivación pendiente con `notifiedByEmail: false` es un caso que no le llegó a
nadie, y la pantalla lo resalta en rojo. Nada de esto puede tumbar la respuesta
al paciente: si falla, se loguea y el mensaje sale igual.

La clínica las ve y las marca atendidas en "Por atender" (`/escalations`,
permisos `derivaciones.ver` / `derivaciones.gestionar`). Por default solo se
listan las pendientes: es una cola de trabajo, no un historial.

**El destinatario de urgencias es aparte de `adminPhone` y de `Clinic.email`**
a propósito: un diente roto tiene que llegarle a quien está de guardia, no a
quien administra el sistema y recibe los avisos de "te falta cargar el
horario". `config-health.ts` marca como **bloqueante** que no haya ningún
destinatario cargado.

`Clinic.urgencyNotifyPhone` existe pero **todavía no se usa**: WhatsApp exige
una plantilla aprobada por Meta para escribirle a alguien que no escribió
primero (la ventana de 24hs está cerrada para quien está de guardia), y esa
plantilla está pendiente. La pantalla lo aclara para que nadie cargue el número
creyendo que ya le van a avisar por ahí.

## Recursos: profesionales, espacios y equipos

La pantalla "Recursos" (`/resources`, permisos `recursos.ver` /
`recursos.editar`) es el ABM de lo que la clínica tiene para atender, en tres
pestañas: **Profesionales**, **Espacios** (los `Room` — consultorios, salas) y
**Equipos** (los `Resource`). Hasta el 2026-09-15 no existía ninguna forma de
cargarlos que no fuera `scripts/add-clinic.ts` o SQL directo: una clínica que
contrataba un profesional no podía darlo de alta, y una sin ningún espacio
veía `checkAvailability()` rechazar TODOS sus turnos.

**Nada se borra, se desactiva** — mismo criterio que `Service`: los turnos
históricos los referencian. Cada fila muestra cuántos turnos futuros tiene,
para no dar de baja a ciegas a alguien con doce por delante.

Los nombres son los del modelo y los del resto de la interfaz: "profesional"
y no "doctor" (el proyecto es agnóstico de rubro: en un spa son
esteticistas), "espacio" y no "consultorio" (un spa tiene cabinas) — es la
palabra que ya usan los filtros de Citas y la Agenda.

### El título del profesional

`Professional.titleId` (nullable) es cómo se lo nombra antes del nombre:
"Dr.", "Lic.", "Psicóloga", "Manicurista". Sale de un catálogo
(`ProfessionalTitle`) y **no es texto libre**: así dos fichas de la misma
clínica no quedan una con "Dra." y otra con "Dra". Nullable porque no todas
las clínicas usan título.

Va en su propia columna y no pegado a `name` —que es lo que se hacía antes,
con nombres cargados como "Dra. Gómez"— para que el dato quede separado de la
presentación: el mismo profesional se nombra distinto según quién lee.

**El catálogo es global de la plataforma, y la habilitación es por clínica.**
Son dos niveles y la distinción importa:

- `ProfessionalTitle` (tabla global) lo administra **solo el super-admin**,
  en la pantalla de plataforma "Títulos" (`/platform/titles`, permisos
  `titulos.ver` / `titulos.editar`, que son `PLATFORM_ONLY_PERMISSIONS`).
  `prisma/seed.ts` → `SEED_TITLES` siembra un punto de partida con títulos de
  varios rubros.
- `Clinic.professionalTitles` (relación N-N) es con cuáles trabaja cada
  clínica. También lo decide el super-admin, desde el detalle de la clínica —
  una clínica **no** elige sus títulos, solo usa los habilitados. Arranca
  vacía: nada se habilita solo.
- El selector de "Recursos" ofrece únicamente los habilitados **y activos**
  (`listTitlesForClinic()`), y el backend valida el `titleId` contra esa misma
  función. Si fueran dos listas distintas, el selector ofrecería algo que
  después se rechaza — mismo criterio que el tipo de equipo de un `Service`.

Un catálogo por clínica se descartó: cada una habría cargado "Dra." por su
cuenta y la plataforma no tendría forma de mantener una lista consistente.

**Dos bajas que NO se permiten**, y las dos por el mismo motivo: un título
inactivo o deshabilitado no se ofrece en ningún desplegable, así que la ficha
que ya lo tiene quedaría mostrando algo que no se puede volver a elegir ni
corregir desde la interfaz.

- **Desactivar** un título que algún profesional tenga puesto — en cualquier
  clínica.
- **Deshabilitarlo de una clínica** cuyos profesionales lo usan.

Las dos las decide `repositories/professional-titles.repository.ts`, que
devuelve un motivo (`en_uso`, con cuántos y cuáles) en vez de tirar una
excepción, para que la interfaz explique por qué no se pudo y cuál es el
camino: cambiarles el título a esos profesionales primero. La pantalla además
lo frena antes de llamar a la API, con un cartel. **Un profesional
desactivado cuenta igual**: su ficha y sus turnos siguen mostrando el título.

**Renombrar sí está permitido con el título en uso**, incluso: las fichas
apuntan por id, así que el cambio se propaga solo y no hay nada que pueda
quedar inconsistente.

`prompts/professional-label.ts` → `describeProfessionalLabel()` es el único
lugar donde se decide cómo se arma la etiqueta, y lo usan las dos superficies
que ve el paciente: los horarios que se le ofrecen
(`prompts/availability-context.ts`) y sus turnos existentes
(`prompts/appointments-context.ts`). Si cada una lo concatenara por su cuenta,
el bot ofrecería "con Dra. Gómez" y al confirmar diría "con Gómez".

Los avisos al profesional, el espejo en Calendar y el reporte diario siguen
usando `name` solo: son internos, y quien los lee ya sabe de quién se trata.
En el dashboard el título solo se muestra en "Recursos", que es donde se
elige.

### Avisarle al profesional que le asignaron un turno

Cada profesional puede tener `contactEmail` y `whatsappPhone`, con dos
interruptores independientes (`notifyByEmail` / `notifyByWhatsapp`).
**Los dos arrancan apagados**: mandarle mensajes a alguien que no los pidió
es la forma más rápida de que la clínica apague el bot entero.

**El mail va como invitación de calendario**, no como texto suelto: lleva
adjunto un `.ics` con `METHOD:REQUEST` (`services/ics.ts`), así el gestor de
correo lo muestra como invitación y le ofrece agregarlo a su calendario
personal con un click. Sin `REQUEST` el archivo llega pero el cliente no
ofrece nada.

Es distinto del espejo en Google Calendar, y conviven: **el espejo pone el
turno en la agenda de la CLÍNICA y lo mantiene sincronizado** (si se cancela,
se borra); la invitación es una copia en la agenda personal de quien la
quiera, y nadie la actualiza después.

El `.ics` se arma a mano y no con una librería — treinta líneas de un formato
estable desde 1998. Dos cosas que se rompen en silencio si se tocan: el
escapeo (una coma sin escapar en "limpieza, control" corta el campo y el
evento llega a la mitad) y el plegado a 75 **octetos**, que hay que contar en
bytes y no en caracteres para no partir un acento al medio.

`services/professional-notifications.ts` se llama desde `booking.ts`
**después de cerrar la transacción**, por el mismo motivo que el espejo: son
llamadas de red. Cada canal falla por su cuenta y ninguno puede tumbar el
turno — si el mail rebota, el WhatsApp sale igual y el turno queda creado.

**El de WhatsApp necesita plantilla aprobada.** El profesional no le escribió
al bot, así que la ventana de 24hs está cerrada y Meta rechaza cualquier
mensaje que no sea plantilla. Por eso está `cita_asignada_profesional` en
`CLINIC_TEMPLATES`: se crea sola en el WABA al dar de alta la clínica, pero
queda en `PENDING` hasta que Meta la apruebe, y mientras tanto el envío falla
y se loguea. Mismo caso que `Clinic.urgencyNotifyPhone`. La pantalla lo
aclara para que nadie prenda el interruptor creyendo que ya funciona.

### El espacio habitual de un profesional

`Professional.preferredRoomId` (nullable) es el espacio en el que trabaja
habitualmente. **Es una preferencia, no una reserva**: si está ocupado a esa
hora se le asigna otro libre y el turno queda con
`Appointment.preferredRoomUnavailable: true`, para poder explicar en la
agenda por qué no le tocó el suyo — verlo en otro consultorio sin más parece
un error de carga.

Esa marca se muestra en los dos lados: en la **Agenda** como un asterisco en
el bloque de la cita, con la explicación en el tooltip y una leyenda al pie
que solo aparece si hay alguna marcada (en un bloque de 15 minutos no entra
una frase); en **Citas**, como una línea debajo del espacio.

Que sea preferencia y no restricción es lo que hace que el cambio sea
seguro: **no altera la disponibilidad**. Los mismos horarios se ofrecen y se
aceptan que antes, solo cambia cuál de los espacios libres se asigna. Por eso
el enumerador de huecos (`availability-slots.ts`) no la mira y no hubo que
mantener dos caminos de acuerdo — algo que sí habría hecho falta con una
restricción dura.

### Un equipo crítico fuera de servicio

`Resource.inactiveReason` es por qué está de baja ("Motor dañado, en
reparación"). Se pide al desactivarlo desde la pantalla: un equipo apagado
sin explicación es indistinguible de uno apagado por error, y mientras tanto
**todos los servicios que dependen de él dejan de poder agendarse**.
Reactivarlo borra el motivo.

`checkAvailability()` distingue dos situaciones que antes se veían iguales:

- `sin_equipo` — hay unidades activas pero todas ocupadas a esa hora. Se
  resuelve ofreciendo otro horario.
- `equipo_fuera_de_servicio` — **no hay ninguna unidad activa de ese tipo**.
  Ese servicio no se puede dar a ninguna hora, así que ofrecer otro horario
  no sirve de nada.

Por eso el segundo caso **genera una derivación automática**
(`agent-turn.ts`): el paciente que insiste con ese servicio no queda
rebotando contra horarios que nunca van a funcionar — se lo pasa a una
persona, que es quien puede decirle cuándo vuelve el equipo u ofrecerle otra
cosa. El resumen de la derivación incluye qué equipo falta y su motivo, para
que quien la atienda no tenga que ir a buscarlo.

## Anticipación mínima para reservar

`Clinic.minLeadMinutes` es con cuánta anticipación mínima se puede reservar, en
minutos. **El default es 60** (una hora): reservar para dentro de un minuto no le
sirve a nadie. Cada clínica puede tener el suyo, y **0 = sin mínimo** (solo se
rechaza el pasado, como funcionaba antes). La primera migración lo creó con
default 0 y la siguiente (`min_lead_default_60`) lo pasó a 60 y llevó a 60 a
todas las clínicas existentes, porque ninguna tenía un valor elegido a propósito.
Un CHECK de la migración impone 0 a 10080 (una semana). Se elige en el alta
("Nueva clínica", `POST /platform/clinics`, opcional: sin él rige el default) y
se edita desde el detalle de la clínica en plataforma
(`PUT /platform/clinics/:id`). Los dos validan con `isValidLeadMinutes()` antes
de escribir, y no se edita desde el panel de la clínica.

**La regla vive en `services/lead-time.ts` → `violatesLeadTime()` y la aplican
los TRES caminos que deciden un horario**, igual que `rangesOverlap` y
`getEffectiveIntervalsForRange` se comparten para no desincronizarse:

- **Ofrecer** (`availability-slots.ts`): el hueco dentro del margen no se
  ofrece. Si todo el día cae adentro, el día sale sin horarios con
  `reason: "anticipacion_minima"`.
- **Agendar** (`booking.ts`): `anticipacion_insuficiente`, después del chequeo
  del pasado y antes de todo lo demás. Si solo se aplicara al ofrecer, el
  paciente podría pedir una hora concreta y saltársela; si solo al agendar, el
  asistente ofrecería horarios que después rechaza.
- **Agenda editable** (`appointment-admin.ts`): es una regla **blanda**
  (`anticipacion_minima`), como el pasado: una asistente puede cargar un turno
  urgente confirmando, y queda en `forcedRules`.

El margen se cuenta sobre el **instante** de inicio (tiempo transcurrido), no
sobre la hora de pared. Un horario ya pasado sigue siendo `fecha_en_el_pasado`,
no "anticipación".

**El prompt lo sabe** cuando es mayor a 0 (`buildSystemPrompt()`): le dice al
modelo que nunca ofrezca ni prometa un turno más cercano y que, si el paciente lo
pide, se lo explique y ofrezca los horarios disponibles. Con 0 no agrega nada.

## Paquetes de sesiones

Un paquete es un servicio que el paciente paga por adelantado en varias sesiones
(*"6 sesiones de láser"*, típico de estética y kinesiología). `Package` guarda el
paciente, el servicio (`serviceId` del catálogo y `serviceName`, el nombre al momento
de la compra), `totalSessions` y `usedSessions`. Un CHECK impone `0 <= usedSessions <=
totalSessions` y `totalSessions > 0`. Toda la lógica vive en `services/packages.ts`.

**Los paquetes salen de un catálogo (`PackageTemplate`), no se arman uno por
paciente** (2026-11-13). La clínica define cada paquete UNA vez ("Láser piernas
completas · Láser · 6 sesiones") en la pestaña "Catálogo", y se lo **asigna** a quien
lo compra (`assignPackage()`, `POST .../packages` con `templateId`, o desde la ficha
del paciente). Es la única forma de dar de alta un paquete por la API.

- **Asignar COPIA los valores** (nombre, servicio, sesiones, notas) al `Package` del
  paciente, igual que la membresía copia el precio de lista: editar o desactivar la
  plantilla **no le cambia nada a quien ya lo tiene**, solo a lo que se asigne
  después. Por eso el paquete guarda su propio `name` y su `totalSessions`.
  `Package.templateId` es solo informativo. Editar las sesiones de UN paquete
  asignado (`updatePackage`) no toca el catálogo.
- **El servicio es obligatorio y se elige de la lista de servicios de la clínica**
  (`createPackageTemplate` / `createPackage` rechazan sin `serviceId` con
  `servicio_requerido`, y con un servicio ajeno o desactivado). No hay opción de
  escribirlo a mano: un paquete sin servicio no tiene a qué citas aplicarse y el
  asistente de WhatsApp no podría atarlo solo. Por eso una clínica **sin servicios
  cargados no puede armar su catálogo** hasta que cargue "Servicios" (la pantalla lo
  dice).
- Una plantilla desactivada o de otra clínica no se puede asignar
  (`plantilla_no_encontrada`). El nombre es único por clínica.
- `Package.serviceId` / `templateId` / `name` siguen siendo nullables en la base solo
  por los paquetes anteriores al catálogo, que se tratan como "sirven para cualquier
  servicio" y se muestran con `serviceName`.

**La sesión se descuenta cuando UNA PERSONA de la clínica marca la cita como
atendida, y solo entonces** (decidido el 2026-11-13). Ni al agendar (el paciente
puede cancelar o no venir, y habría que acordarse de devolverla) ni con el estado
`atendido` de la cita: **ese lo pone solo `jobs/post-visit-followup.ts` a las 24
horas de la cita, sin que nadie confirme que el paciente fue**, así que no prueba
nada. Por eso la confirmación humana vive aparte, en `Appointment.attendedAt` /
`attendedByUserId`, y es lo único que mueve el saldo. Marcarla también deja la
cita en `atendido` y la etapa del paciente en `atendido`, como el job, pero ahora
porque alguien lo confirmó.

- **Idempotente**: marcar dos veces no descuenta dos. El descuento es un UPDATE
  condicionado (`usedSessions < totalSessions`) en una transacción `Serializable`,
  así que dos personas confirmando a la vez no pasan del total.
- **Reversible** (`unmarkAppointmentAttended`, `DELETE .../attended`): devuelve la
  sesión y la cita vuelve a `confirmado`. Existe porque un click equivocado sobre
  el saldo prepago de alguien no puede quedar para siempre. Si el paquete se había
  agotado, se reactiva (no se distingue de uno apagado a mano estando agotado: sin
  otro campo no hay forma).
- **Se marca desde una hora antes** del inicio (`ATTEND_EARLY_MS`), no antes: el
  paciente llega un rato antes, pero marcar una cita de la semana que viene es un
  error.
- Al usarse la última sesión el paquete se apaga solo (`active: false`). Subir el
  total de uno agotado lo reactiva. No se puede bajar el total por debajo de las
  usadas más las agendadas sin confirmar.
- **Permiso aparte**: marcar atendida y administrar paquetes va con
  `paquetes.gestionar`, no con `citas.gestionar`: confirmar una asistencia es tocar
  el saldo prepago. Ver los paquetes y el aviso, `paquetes.ver`. Son permisos de
  clínica (el rol "Admin de clínica" los recibe con `npm run db:seed`).

**Qué sesiones "quedan"** (`packageCapacity()`): `total`, `used` (descontadas),
`reserved` (citas atadas al paquete, no canceladas y sin confirmar, **incluidas las
que ya pasaron y nadie marcó**) y `available = total − used − reserved`.

**Atar una cita a un paquete:**

- **Desde la Agenda** (`createManualAppointment` / `updateAppointment`,
  `packageId`): el diálogo ofrece los paquetes del paciente y sugiere el primero
  con sesiones libres. Duras (la cita no se crea): el paquete tiene que ser de
  ESE paciente y de esta clínica (el de otra persona "no existe"), estar activo, y
  ser del mismo servicio si está atado a uno. **Blanda**: si ya no le quedan sesiones
  libres, `paquete_sin_sesiones` pide confirmación (hay clínicas que agendan de más)
  y queda en `forcedRules`. Editar una cita ya atada no revalida el paquete salvo
  que cambie el paquete o el servicio: moverla de hora no puede fallar porque el
  paquete se haya agotado con las demás.
- **Por WhatsApp** (`booking.ts` → `findPackageForBooking()`, dentro de la
  transacción): se ata sola al paquete más antiguo, activo, **atado a ese mismo
  servicio** y con sesiones libres. Sin esto, quien compró un paquete y agenda por
  el asistente tendría una cita suelta que nunca descuenta. **No agenda de más**
  (sin lugar, la cita se crea sin paquete) y **un paquete heredado, sin servicio,
  no se ata solo**: no hay forma de saber de qué es, y descontar una sesión de láser
  a un paquete de limpiezas es peor que dejarla suelta; la asistente lo ata a mano.

**El recordatorio de la asistente** (`listPendingPackageAppointments()`,
`GET .../packages/pending`, panel `PendingPackagesPanel` arriba de "Citas", que es
el home): las citas de hoy que vienen por paquete ("quién llega") y las de días
anteriores sin marcar, aparte y sin desaparecer al día siguiente. **No depende de
`status`**: una cita que el job dejó en `atendido` sin `attendedAt` sigue
pendiente. "Hoy" es el de la clínica (`Clinic.timezone`), no el del servidor. Solo
lo ve quien tiene `paquetes.ver`, y no ocupa lugar si no hay nada pendiente.

**El mismo recordatorio llega por mail** (`jobs/package-reminders.ts`, el job
`package-reminders`): una vez por día por clínica, **en el horario de la clínica**
(corre cada hora y manda cuando allá son entre las 8 y las 18 y todavía no se
mandó hoy, `Clinic.packageReminderSentOn`; un SMTP caído a las 8 se reintenta a las
9). Va a los usuarios activos de la clínica con `paquetes.gestionar` (quienes
pueden marcar la cita), o a `Clinic.email` si no hay ninguno. **Solo se marca el día
si el mail salió**, y **no manda nada si no hay citas pendientes** (un aviso vacío
enseña a ignorarlos). Las atrasadas se repiten cada día hasta que se marquen. Va
por mail y no por WhatsApp porque es un aviso interno, no un mensaje a un paciente
(así no necesita plantilla de Meta).

**Lo que no cubre:** que el asistente de WhatsApp sepa cuántas sesiones le quedan y
lo diga; un recordatorio por WhatsApp a la asistente (el mail lo cubre sin plantilla
de Meta); el cobro del paquete (se registra a mano, `payments.ts` es un stub); y
las rutas nuevas de `dashboard.ts` no tienen tests (las reglas viven en
`services/packages.ts`, que sí: `tests/packages.test.ts`).

## Pacientes: la ficha, y lo que el asistente sabe de quien ya vino

La pantalla "Pacientes" (`/patients`, ficha en `/patients/:id`, permisos
`pacientes.ver` / `pacientes.editar`) es el módulo para ver y trabajar la ficha de
cada paciente (`services/patient-admin.ts`): **datos (nombre y apellido), próxima cita
sugerida, observaciones, comentarios, historial de citas y paquetes**. Es una
pantalla aparte de "Citas" y de la Agenda, y sus permisos también: la ficha tiene
notas internas del personal.

**Nombre y apellido** (decidido el 2026-11-13, contra la regla anterior de "un solo
campo"): `Patient.firstName` y `lastName` son las partes que se cargan desde el
módulo, pero **`Patient.name` sigue siendo el nombre completo y el dato canónico**
que usa todo lo demás (el asistente, los avisos, la búsqueda, la detección de
duplicados por nombre). Al editar las partes, `name` se recalcula
(`joinFullName()`); las fichas que crea el asistente por WhatsApp traen solo `name`
y se **parten al leer** (`patientNameParts()`) sin escribir nada. **Lo que garantiza que cada parte quede en su campo es que el MODELO las devuelva
separadas** (2026-11-13): `nombre_paciente` + `apellido_paciente` y `paciente_del_turno` +
`apellido_paciente_del_turno`, y el código las guarda en las tres columnas (`nameFields()`); el prompt
le pide separar siempre, preguntar el apellido una vez si falta y no adivinar. Sin el apellido
separado la ficha queda solo con `name` y se parte así: la
primera palabra / el resto: **es una heurística y se equivoca** con nombres
compuestos ("Ana María García") y apellidos con partículas; la ficha lo avisa
(`nameInferred`) para que el personal lo revise y guarde; la migración
`patients_module` la aplicó a las fichas existentes y el personal las corrige desde
la ficha. Dos personas con el mismo nombre en el mismo WhatsApp se rechazan
(`nombre_duplicado`): el asistente elige la ficha por nombre y no podría distinguirlas.

**Observaciones y comentarios** son dos cosas: `Patient.observations` es UNA nota
vigente que se edita (preferencias, indicaciones); `PatientComment` es el registro con
fecha y autor de lo que se fue hablando, que se agrega y se puede borrar pero **no se
edita**. Los comentarios no tienen FK a `Clinic` ni a `User` (ids planos): es
auditoría y borrar un usuario no los toca; `authorName` guarda el nombre al escribirlo.

**Próxima cita sugerida** (`suggestedNextVisitDate` + `suggestedNextVisitNote`): es
una SUGERENCIA del personal, no una cita: no reserva nada ni bloquea ningún horario.
La fecha se valida estricta (`parseDateKey()` rechaza `2030-02-31`, que
`dateKeyToUtcMidnight()` correría en silencio al mes siguiente). La lista de
pacientes filtra por rango de esa fecha y ordena lo más próximo primero: es la lista
de "a quién hay que darle cita para esa fecha".

### El asistente lee la ficha

Decidido el 2026-11-13: **el asistente lee el historial, las observaciones y los
comentarios** (`prompts/patient-history-context.ts` + `services/patient-history.ts`),
para tratar con cercanía a quien ya vino, preguntarle cómo le fue con lo que le
hicieron y proponerle una nueva cita. Llega en el mensaje de cada turno (no en el
system prompt, que se cachea) como "Historial de las personas de este WhatsApp":
lo que se le hizo (las últimas 5 atenciones cumplidas: `status: atendido` o con
`attendedAt`; no las canceladas ni las futuras), su próxima cita sugerida, las
observaciones y los últimos 5 comentarios. `historialPersonas` es **obligatorio** en
`interpretPatientMessage()` por lo mismo que `turnosPaciente`: opcional, nadie lo
pasaba y el asistente atendía a quien ya vino como a un desconocido.

**Todo esto se envía a la API del modelo** (un servicio externo), y por eso:
- Está **acotado**: 5 atenciones, 5 comentarios, observaciones a 600 caracteres y
  cada comentario a 300, y solo las personas de ESE número (acotado por `clinicId` y
  por los ids de las fichas del número: nunca otro paciente).
- **La pantalla lo avisa donde se escribe** (en la ficha, junto a las observaciones):
  el personal no tiene por qué saber que lo lee un modelo, y puede haber datos de
  salud o internos. Se eligió esta opción sobre leer solo el historial estructurado,
  que era la recomendada por la regla de minimización de datos.
- **El prompt lo limita** (regla "Personas que ya vinieron"): trato por nombre de
  pila y con calidez; preguntar cómo le fue **una sola vez**, sin interrogatorio; si
  cuenta algo preocupante, escalar según los criterios de la clínica; proponer la
  próxima cita solo si ya está cerca o vencida y no tiene turno; si en el historial
  reciente la clínica le escribió primero, contestar en ese hilo; y **nunca citar,
  recitar ni revelar las notas internas**, ni dar consejos médicos, ni inventar lo
  que el historial no dice. Es probabilístico: ningún test prueba que el modelo
  obedezca, solo que la regla le llega.

### Contactar a quien se le acerca la próxima cita

`jobs/next-visit-outreach.ts` (`next-visit-outreach`, cada hora) le escribe por
WhatsApp a los pacientes cuya fecha sugerida es de hoy, ya pasó o cae dentro de
`Clinic.nextVisitOutreachLeadDays` (default 14) días, y **no tienen ya un turno
confirmado a futuro**, no están marcados `outreachOptOut` ("no contactar") y no se
les escribió ya por esa sugerencia (`nextVisitOutreachSentAt`; cambiar la fecha lo
rearma). Va por la plantilla **`proximo_control`** (en `CLINIC_TEMPLATES`): una
clínica que escribe primero necesita plantilla aprobada por Meta en cada WABA.

- **Apagado por defecto** (`Clinic.nextVisitOutreachEnabled`): lo prende el
  super-admin en el detalle de la clínica, después de ver la plantilla aprobada.
  Escribirle primero a quien no lo pidió es la forma más rápida de que la clínica
  apague el bot.
- **Meta puede reclasificarla como Marketing** (como pasó con `aviso_configuracion`):
  el texto habla de lo que le corresponde al paciente según su última visita, sin
  ofertas ni cortesías de más. Si igual la marca, se pide la revisión de categoría.
- Un mensaje por sugerencia, **reclamado antes de enviar** (UPDATE condicionado), así
  dos corridas no le escriben dos veces; si el envío falla se libera y **se corta la
  tanda de esa clínica con UN solo evento** en Monitoreo (con la plantilla sin
  aprobar fallaría para todos). Como máximo 20 por clínica por corrida, y solo entre
  las 9 y las 18 de la clínica (ver la deuda sobre ventanas horarias).
- **Lo mandado queda en el historial** de la conversación como mensaje del asistente:
  cuando el paciente responde, el asistente sabe a qué contesta.
- Los parámetros pasan por `sanitizeTemplateParam()`: Meta rechaza saltos de línea,
  tabuladores y largos desmedidos, y la nota la escribe el personal.

**Lo que no cubre:** una pregunta de "cómo te fue" **proactiva** distinta del recordatorio
de la próxima cita (ya existe el seguimiento post-visita, plan Plus, que pregunta cómo
se siente a las 24 horas; el asistente retoma el tema cuando el paciente escribe); que
el paciente pueda darse de baja él mismo del contacto (hoy lo marca el personal); y
que las rutas nuevas de `dashboard.ts` tengan tests (las reglas viven en los servicios,
que sí: `patients-module`, `next-visit`, `patient-history`, `package-templates`).

## Auditoría y eventos de cita

Dos cosas distintas que se complementan: **`AuditLog`** responde "quién hizo qué en el
sistema" (seguridad y trazabilidad, para toda la aplicación), y **`AppointmentEvent`**
responde "qué le pasó a cada cita" (la fuente de los reportes de canceladas,
reagendadas y atendidas). Ambos arrancan el 2026-11-13: **no se pueden reconstruir las
cancelaciones ni los reagendados anteriores**, porque el sistema no los guardaba.

### Auditoría de toda la aplicación (`AuditLog`)

Una fila por cada operación que **modifica** algo (POST, PUT, PATCH y DELETE de la API,
incluido el login y el logout) y por la **lectura de datos sensibles** (la ficha de un
paciente, las conversaciones, la propia auditoría y el callback de OAuth). Lo escribe
**un middleware global** (`middleware/audit.ts`, montado en `src/index.ts` antes de los
routers) al terminar cada respuesta, así que **una ruta nueva queda auditada sin que
nadie se acuerde**. Registra también lo **denegado y lo que falla** (`outcome`: `ok`,
`denegado` para 401/403/429, `error` para el resto), con el usuario (id, email y nombre
al momento), la clínica, la clave de la operación, el patrón de la ruta, el recurso, la
IP y el user agent.

- **Nunca guarda valores de lo que se escribió**: solo los NOMBRES de los campos que
  vinieron en el cuerpo (`details.campos`; **son los que llegaron, no necesariamente los
  que cambiaron**: la ficha de un paciente manda todo en cada guardado, así que ahí la ruta
  calcula lo que cambió de verdad y lo pone en `details.camposModificados`), y ni siquiera el nombre de los que hablan de
  credenciales (`password`, `token`, `secret`…, `camposSensiblesOmitidos`). Una
  observación clínica, un teléfono, un token o una contraseña no pueden terminar en un
  registro que se conserva por años. Lo estructurado y NO sensible va en `details` a
  propósito (`enrichAudit()`): el motivo de una cancelación, los permisos de un rol
  (son ids de un catálogo fijo), los roles de un usuario, el motivo de un login fallido.
- **La URL no se guarda cruda**: se guarda el patrón (`/dashboard/clinics/:clinicId/…`) y
  los ids salen de los parámetros; el query string nunca queda.
- **El login**: el éxito, la contraseña incorrecta, la cuenta desactivada o inexistente
  (el motivo REAL queda en la auditoría aunque al cliente se le diga siempre lo mismo),
  el logout, pedir recuperar la contraseña y cambiarla. La contraseña no se registra.
- **Un intento sin sesión también queda**: `authenticate` es un middleware de router
  y rechaza antes de que ninguna ruta atienda el pedido (no hay `req.route`), así que el
  middleware arma el patrón desde la URL (`unmatchedDenied()`). Solo para pedidos que
  modifican y fueron denegados en la API: un 404 sin ruta es ruido de bots y no se
  registra.
- **Qué NO se audita**: las lecturas comunes (llenarían la tabla con cada refresco de
  pantalla y taparían lo que importa), el webhook de Meta, los archivos estáticos y los
  404. Las lecturas sensibles son una lista corta (`SENSITIVE_READS` en
  `services/audit.ts`): si se agrega una pantalla que muestra datos de salud o de
  contacto, hay que sumarla ahí.
- **Solo se agrega**: un trigger de la base (`audit_log_append_only`, migración
  `audit_log`) rechaza UPDATE y DELETE. El único camino es una sesión que declara
  mantenimiento (`SET LOCAL app.audit_maintenance = 'on'`, que es lo que usan los tests y
  la futura política de retención). Protege de un bug o de alguien con acceso a la base;
  no de un atacante con control total del servidor.
- **Fail-open**: si no se puede escribir un registro, la respuesta ya salió y no se tumba
  nada, pero se loguea y deja un evento `auditoria_fallo` en Monitoreo: un hueco en la
  historia no puede pasar inadvertido.
- **Dónde se ve**: solo en "Auditoría" de plataforma (`/platform/audit`, permiso
  `auditoria.ver`, **`PLATFORM_ONLY_PERMISSIONS`**: solo el super-admin), con todas las
  clínicas y `?clinicId=` para acotar a una. **Una clínica no tiene pantalla ni ruta de
  auditoría** (se retiró el 2026-11-13: el registro trae IPs y user agents, datos técnicos
  que no le corresponden; antes había `/audit` y `GET /dashboard/clinics/:id/audit`).
  Solo lectura, con filtros por usuario, acción, resultado, origen y fechas; consultarla
  también queda registrado.
- La clave de cada operación sale de `ROUTE_ACTIONS` (`appointment.cancel`,
  `patient.update`…) y, si no está, es `METHOD patrón`; las etiquetas en español de la
  pantalla están en `ACTION_LABELS`. **Al agregar una operación importante, sumarla a
  las dos** (no es obligatorio para que se audite, sí para que se lea).

### El origen: lo que NO hace un usuario del panel

`AuditLog.origin` dice desde dónde se originó la operación: **`panel`** (una persona desde
la aplicación web: todo lo que escribe el middleware), **`whatsapp`** (el asistente, por un
mensaje del paciente) o **`sistema`** (un job). Lo que hacen el asistente y los jobs **no
pasa por una ruta de la API**, así que el middleware no lo ve y **hay que registrarlo
explícitamente con `recordSystemAudit()`**. La pantalla de Auditoría filtra por origen y lo
que no hizo un usuario se lee como "Asistente (WhatsApp)" o "Sistema", no como "Sin sesión"
(que es otra cosa: un intento sin haber entrado).

Hoy se registran así (2026-11-13):

| Acción | Cuándo | Origen |
|---|---|---|
| `patient.create_whatsapp` | Se crea la ficha al primer mensaje (`getOrCreateConversationPatient`), o una persona nueva del mismo número (`resolvePatientForBooking`) | `whatsapp` |
| `patient.name_set` | El paciente se presenta y la ficha recibe su nombre (`setPatientName`, `resolvePatientForBooking`) | `whatsapp` |
| `patient.stage_change` | **Cada cambio de etapa del CRM**, con `desde`, `hasta` y `motivo` (`updatePatientStage`) | `whatsapp`, `sistema` o `panel` |
| `patient.outreach_sent` | El job de contacto le escribió a un paciente por su próxima cita | `sistema` |

- **Una etapa no se puede cambiar sin decir quién**: `updatePatientStage(id, etapa, contexto)`
  exige un `StageChangeContext` (`origin`, `userId` si fue una persona, y `motivo` de una lista
  cerrada: `primer_mensaje`, `turno_agendado`, `cancelacion`, `asistencia_confirmada`,
  `seguimiento_automatico`). Es un parámetro obligatorio **a propósito**: el compilador
  rechaza un llamador nuevo que lo olvide. Si la etapa ya era esa **no se escribe ni se
  registra nada** (no hubo cambio): sin esto, cada mensaje de un paciente "interesado" llenaría
  el registro de no-eventos.
- **Nunca guardan el teléfono, el nombre ni el mensaje**: el recurso es la ficha (`resourceId`)
  y de ahí sale todo lo demás. El nombre de una persona entra al sistema por una vía que no es
  la API; se registra que el campo cambió (`camposModificados: ["name"]`), nunca el valor.
- Las filas anteriores a esta columna (todas salieron del middleware) quedaron con
  `origin = 'panel'` por la migración `audit_origin`.

**Lo que sigue sin tener registro de auditoría:** los **jobs que modifican datos** y no son del
CRM (el sync de calendario, los avisos que marcan "ya se avisó") y la lectura de datos por el
asistente. Las citas que crea, reagenda o cancela el asistente quedan además en
`AppointmentEvent` (`actorKind: "paciente"`), lo que da por atendido el job de seguimiento
(`"sistema"`), y las fallas en `SystemEvent`. Un job nuevo que modifica datos tiene que dejar su
propio rastro.

**La IP** es `req.ip`: detrás de un proxy o balanceador **no es la del cliente** hasta
que se configure `trust proxy` en Express, y eso es una decisión de despliegue (si se
configura mal, `X-Forwarded-For` se puede falsificar). Pendiente para cuando haya
ambientes.

### Eventos de cada cita (`AppointmentEvent`)

Se escriben **con el cliente de la misma transacción que hace el cambio** (no puede haber
un cambio sin su evento ni un evento de algo que se revirtió) y, a diferencia de
`recordAudit()`, **sí pueden lanzar**: un reporte con huecos es peor que un cambio que
falla. Las **definiciones**, de las que dependen los reportes:

| Tipo | Cuándo |
|---|---|
| `creada` | Una reserva nueva (WhatsApp o panel). **Reagendar NO cuenta como crear.** |
| `reagendada` | Cambió la hora o el profesional. Guarda de dónde a dónde. |
| `editada` | Cambió otra cosa (espacio, servicio, duración, paquete): `details.campos`. |
| `cancelada` | Una cancelación **real**, con quién la hizo y, si se dio, el motivo. |
| `atendida` | Una persona confirmó la asistencia (`actorKind: usuario`) o el job la dio por atendida a las 24 h (`sistema`, `details.automatica`). |
| `desmarcada` | Una persona deshizo la asistencia. |

- **Reagendar por WhatsApp** da de baja la cita vieja y crea una nueva: el evento es UN
  `reagendada` en la **nueva**, con `relatedAppointmentId` = la vieja y
  `Appointment.rescheduledFromId` apuntando a ella; la vieja queda con
  `cancelledByKind: "reprogramacion"` y **sin** evento de cancelación. Por eso **mover
  una cita no es cancelarla** y los reportes de cancelaciones no la cuentan. Si la reserva
  nueva falla, todo se revierte: la vieja sigue vigente y no queda ningún evento.
- **Mover desde la Agenda** edita la misma fila y pisa la hora original: el evento
  `reagendada` es lo único que la conserva.
- **Cancelar** guarda además `Appointment.cancelledAt`, `cancelledByKind` (`paciente` por
  WhatsApp, `clinica` desde el panel, `reprogramacion`), `cancelledByUserId` y
  `cancelReason`. El motivo es opcional, se pide en el diálogo de cancelar y se recorta a
  200 caracteres. **El asistente también lo pregunta por WhatsApp** (ver "El motivo de la
  cancelación por WhatsApp" más abajo).
- **Para los reportes** (el siguiente paso): cancelaciones = eventos `cancelada`;
  reagendadas = eventos `reagendada`; reservas nuevas = `creada`; atendidos confirmados
  por una persona = `atendida` con `actorKind: "usuario"` (los de `sistema` no prueban que
  el paciente fue). Todo antes del 2026-11-13 **no tiene eventos**.
- Los eventos se borran con la cita o la clínica (`ON DELETE CASCADE`): en producción las
  citas no se borran, se cancelan.

### El motivo de la cancelación por WhatsApp (2026-11-13)

El asistente intenta saber **por qué cancela** el paciente, con sutileza, porque a la
clínica le sirve para mejorar y queda registrado para calidad y auditoría. La regla vive
en `prompts/system-prompt.ts` ("Motivo de la cancelación") y tiene tres cuidados:

- **Nunca frena ni condiciona la cancelación**: se cancela primero y se pregunta
  después, UNA sola vez y con calidez ("si querés contarme el motivo, nos ayuda a
  mejorar"). Si no quiere contarlo, no se insiste. Un asistente que pone trabas para
  cancelar es peor que uno que no pregunta.
- **Como el motivo suele llegar en el mensaje SIGUIENTE**, el modelo recibe el bloque
  "Citas canceladas recientemente por este WhatsApp (sin motivo registrado)" con el **id**
  de cada una (las del paciente por WhatsApp de las últimas 48 horas, de las personas de
  ESE número y sin motivo todavía; `findRecentCancellationsWithoutReason()`). Devuelve el
  motivo en `motivo_cancelacion` y el id en `turno_cancelado`, y
  `attachCancellationReason()` se lo pone a esa cita: **solo rellena** (un `UPDATE`
  condicionado a `cancelReason: null`, así que nunca pisa un motivo), **acotado** por clínica,
  personas del número, `cancelledByKind: "paciente"` y la ventana de 48 horas, y **no cancela
  nada otra vez**. El id lo escribe el modelo: nunca se confía en él solo (uno ajeno, viejo,
  de una reprogramación o de una cita vigente no sirve).
- **Una QUEJA es otra cosa que "no puedo ese día"** (la atención, la espera, el trato, el
  precio, el tratamiento, un profesional): el modelo marca `motivo_es_queja: true`, muestra
  empatía sin ponerse a la defensiva ni prometer compensaciones, hace UNA pregunta amable
  para entender mejor qué pasó, y escala. **El código es la red de seguridad**: si hay queja
  y el modelo no marcó `escalar_a_humano`, igual se escala (motivo `otro`) y la derivación
  dice "Queja al cancelar una cita: «…»". En el evento `cancelada` queda `details.queja`.

El motivo se guarda en `Appointment.cancelReason` y en el evento (`reason`); si llegó
después, el evento lleva `details.motivoDespues`. Es texto libre del paciente recortado a 200
caracteres: **el prompt le pide al modelo resumirlo con sus palabras y sin datos de salud que
no hagan falta**, pero es probabilístico. **Un motivo que no es queja no escala.**

### Solicitudes al agente (`AgentRequest`)

Cada llamada al modelo de IA queda registrada (`services/agent-requests.ts`): la clínica, el
titular de la conversación, el `turnId` que agrupa las llamadas de un mismo mensaje entrante,
el tipo (`interpretacion`, `reinterpretacion` con los horarios a la vista, `explicacion_fallo`),
el intento (2 si es el reintento tras una falla), el modelo, la latencia, los tokens (entrada,
salida y caché), el `stop_reason`, el tamaño del prompt, el resultado (`ok`, `sin_texto`,
`no_interpretable`, `error`), el error si lo hubo, la intención y la **decisión** estructurada
del modelo (servicio, fecha, hora, profesional pedido, flags de escalar/confirmar/ubicación/
queja y el id de la cita).

- **Registrar no es opcional**: `interpretPatientMessage()` / `interpretWithClient()` exigen un
  `trace` (`turnId`, `kind`, `attempt`, `patientId`), así que no se puede llamar al modelo sin
  dejar el rastro. Una llamada que **falla** también queda (`outcome: "error"`).
- **No guarda texto**: ni el prompt (lleva el historial y las notas del paciente), ni el mensaje
  del paciente, ni la respuesta, ni nombres, ni el motivo de cancelación en texto. Eso ya está
  en `ConversationMessage`; duplicarlo en otra tabla multiplicaría los datos sensibles. Un test
  lo comprueba con textos reconocibles.
- **`recordAgentRequest()` nunca lanza**: se llama después de hablar con el modelo y que falle el
  registro no puede tumbar la respuesta al paciente (queda en el log).
- Se ve en **Monitoreo** ("Solicitudes al asistente (24 horas)": mensajes, llamadas, errores,
  tiempos y tokens) y en `GET /platform/monitoring/agent-requests` (con `?turnId=` se ven todas
  las de un mensaje). **Se conservan 90 días** (`AGENT_REQUEST_RETENTION_DAYS`; la limpia
  `jobs/system-events-cleanup.ts`) y se borran con la clínica.
- Sirve para **calidad** (¿en qué intención falla?), para **costos** (los tokens) y para
  reconstruir por qué contestó lo que contestó: la decisión está, el texto está en la conversación.

### Checklist al agregar una funcionalidad

1. ¿Es una ruta de la API (`/dashboard`, `/platform`, `/auth`, `/oauth`)? Ya queda auditada.
   Revisa que `ROUTE_ACTIONS` / `ACTION_LABELS` la nombren si es importante.
2. ¿Guarda datos sensibles (salud, contacto, credenciales)? **No los pongas en `details`**:
   solo nombres de campos. Si hace falta un dato estructurado no sensible, `enrichAudit()`.
3. ¿Muestra datos sensibles en un GET? Sumarlo a `SENSITIVE_READS`.
4. ¿Lo hace un job, el asistente o un script, y modifica datos? Registrarlo explícitamente
   (`AppointmentEvent` si es una cita, `SystemEvent` si es una falla, `recordSystemAudit()` con
   `origin: "whatsapp"` o `"sistema"` si es otra operación) — no pasa por el middleware. Si es
   un cambio de etapa del CRM, ya está resuelto: `updatePatientStage()` lo exige.
5. ¿Cambia el ciclo de vida de una cita (crear, mover, cancelar, atender)? Escribir el
   `AppointmentEvent` en la misma transacción y respetar las definiciones de arriba.
6. ¿Llama al modelo de IA? Tiene que pasar por `interpretWithClient()` con su `trace`
   (`AgentRequest`); no registres el texto, solo metadatos y la decisión.
7. ¿Agrega un permiso o una pantalla? Documentar el caso de prueba y, si es una operación
   que alguien podría querer revisar, comprobar que aparece en la pantalla de Auditoría.
8. ¿Cambia qué datos se tratan, con quién se comparten, cuánto se conservan o qué se promete? **Revisar la legislación
   mexicana y `docs/legal/`, y avisar al usuario si hay que actualizar la política o los términos** (regla transversal 3).

## Reportes de citas

La pantalla "Reportes" (`/reports`, permiso `reportes.ver`) y `GET /dashboard/clinics/:id/reports/:report`
(`options` da los filtros; `?formato=csv` descarga). Todo vive en `services/reports.ts`; la ruta solo
valida y traduce. Doce informes con la misma forma (`ReportResult`: indicadores, tablas de
resumen, detalle, notas), así que la pantalla solo dibuja lo que llega:

- **resumen** — por fecha de la cita: atendidas, confirmadas, automáticas, canceladas, sin confirmar,
  futuras, reagendadas y tasas, más **pacientes por etapa del CRM (el estado de hoy, no depende del
  período)**. Absorbió la pantalla de **Métricas** (retirada el 2026-11-13, junto con
  `GET .../metrics`): eran dos pantallas casi iguales. El permiso `metricas.ver` quedó en el
  catálogo como en desuso (borrarlo rompería los roles que lo tienen); manda `reportes.ver`.
- **ocupacion** — uso de cada espacio y de cada equipo, por día de la semana y por franja horaria
  (2026-11-13). **Uso = minutos con una cita (confirmadas y atendidas) ÷ minutos que la clínica estuvo
  abierta**; el "abierto" sale de `getEffectiveIntervalsForRange()` (la misma que valida los turnos:
  feriados y excepciones ya resueltos). Todo espacio y equipo tiene la misma capacidad (la clínica
  abierta). **Solo cuenta lo transcurrido** (el período se corta en este instante) y un espacio
  desactivado solo aparece si tuvo citas. Con filtro de profesional o servicio la capacidad no cambia.
  Las tablas en barras llevan `unidad: "%"` y la escala va de 0 a 100.
  **Tiempos muertos**: lo libre no es todo aprovechable. Un hueco entre dos citas solo sirve si cabe el
  servicio activo más corto (si no hay catálogo, `defaultAppointmentMinutes`): el reporte separa las
  "horas libres aprovechables" de las sueltas y da el hueco más largo de cada espacio. El **mapa de calor**
  (`visual: "calor"`, día × hora) muestra dónde están. También mide a cada **profesional** contra SU
  horario (el efectivo, que hereda el de la clínica si no tiene propio).
- **pacientes** — nuevos vs recurrentes (por PERSONA: una ficha, no un WhatsApp; nuevo = su primera cita
  confirmada o atendida cae en el período) y **quiénes no volvieron**: última visita cumplida hace 60 días
  o más y sin cita futura. Esa lista se mide contra hoy y NO usa el período ni los filtros de profesional y
  servicio; es la lista de contacto (con teléfono, próxima cita sugerida y "no contactar"), así que ver y
  exportarla queda auditado como cualquier reporte.
- **campanas** — las campañas (todas, también las vigentes sin contactos) y cuántas personas llegaron por cada
  una en el período (por la fecha en que llegó): contactos, nuevos, agendaron, conversión, en seguimiento,
  seguimientos enviados, cerrados sin respuesta y citas atribuidas, más por canal y por formato (anuncio de Meta o
  frase). Ver "Campañas y promociones". El filtro por servicio deja las campañas de ese servicio.
- **servicios** — qué se pide (por `Appointment.service`, sin las movidas), cancelación y horas por
  servicio, los del catálogo sin ninguna cita, y **la demanda que no se pudo agendar**: los pedidos de
  servicios que la clínica no ofrece (eventos `servicio_sin_match`; solo los últimos 30 días, por la
  retención de monitoreo).
- **origen** — de dónde vienen las reservas (citas CREADAS en el período, sin las que son un
  reagendado): con `createdByUserId` es del panel, sin usuario es del asistente de WhatsApp (las anteriores
  a la Agenda editable, 2026-11-07, se leen como del asistente). Mide también cuántas el asistente tomó con
  la clínica cerrada (lo que sin él se perdería) y la cancelación por origen.
- **derivaciones** — desde `Escalation`: volumen, por motivo, cuánto se tardó en atenderlas y las
  pendientes que no llegaron a nadie. **No incluye el mensaje ni el resumen** (pueden tener datos de salud:
  están en "Por atender").
- **motivos** — las canceladas agrupadas por motivo, con la queja aparte (`details.queja`) y qué parte de las
  del paciente trae motivo (mide si el asistente lo pregunta). **La categoría sale de palabras clave
  (`CATEGORIAS_MOTIVO`, `categorizarMotivo()`): es aproximada**, por eso el detalle muestra el texto junto a
  la categoría y lo que no encaja queda en "Otro motivo". El detalle no lleva el nombre del paciente.
- **cancelaciones** — desde `Appointment`; **no cuenta** `cancelledByKind: "reprogramacion"`
  (mover no es cancelar). Quién canceló, motivo, quejas (`details.queja` de los eventos), tardías
  (menos de 24 h), por profesional, servicio y día de la semana.
- **reagendadas** — desde los eventos `reagendada`: de→a, cambio de profesional, adelantadas/atrasadas.
- **atendidos** — por profesional y servicio, **separando lo confirmado por una persona
  (`attendedAt`) de lo automático** del job de 24 h, que no prueba que el paciente fue.
- **sin-confirmar** — confirmadas ya pasadas que nadie marcó ni canceló.

Decisiones que no son obvias:

- **`base`** (solo cancelaciones y reagendadas): contar por *cuándo pasó* (`evento`, el default) o por
  el día de *la cita* (`cita`). Son preguntas distintas y las dos son legítimas.
- **Períodos y día de la semana en la zona de la clínica**, no del servidor. Máximo 366 días
  (default 30); desde ≤ hasta.
- **Lógica NULL de SQL**: excluir reprogramaciones se escribe con OR y `null` explícito, nunca con
  `NOT`: `cancelledByKind` null haría desaparecer cancelaciones reales (lo detectó un test).
- **Antes del 2026-11-13 no hay eventos**: la respuesta trae `desdeDatos` y la pantalla lo avisa.
- **CSV** (`services/csv.ts`): BOM para Excel, `\r\n`, escape RFC 4180 y **neutralización de
  fórmulas** (`= + - @` al inicio se prefijan con `'`): un motivo de cancelación lo escribe el
  paciente. La coma como separador puede requerir `;` en Excel en español.
- Límites: 500 filas en pantalla (avisa y el CSV trae todo), 10.000 en CSV.
- **Auditoría**: ver y descargar son `report.view` / `report.export` (lectura sensible); solo
  nombres de filtros, nunca valores.

**Lo que no cubre / siguiente paso:** otros reportes (paquetes: sesiones usadas y por vencer;
horas perdidas por la anticipación mínima) y, después, un chat que use estas mismas consultas como herramientas fijas.
La pantalla no tiene tests (las reglas sí: `tests/reports.test.ts`).

## Campañas y promociones

Para saber **por qué llega alguien por WhatsApp**: un anuncio de Meta, un flyer, un QR, las redes. La pantalla
"Campañas" (`/campaigns`, permisos `campanas.ver` / `campanas.editar`) las administra; el reporte "Campañas" (en
Reportes) dice cuántas personas llegó cada una y cuántas agendaron. Todo vive en `services/campaigns.ts`.

**Cómo se reconoce una campaña** (`CampaignTrigger`; una campaña puede tener varios formatos):

- **`anuncio`**: el id de un anuncio Click-to-WhatsApp de Meta. Llega en `referral.source_id` del mensaje del
  webhook (`extractAdSourceId()`), sin que el paciente escriba nada: es lo más confiable.
- **`texto`**: una frase que viene en el mensaje (el texto prellenado de un link, un QR o un flyer), normalizada
  (minúsculas, sin acentos). Matchea por **palabras enteras** y exige al menos 6 caracteres (`"hola"` o `"promo"`
  coincidirían con cualquier mensaje). Sirve para cualquier canal, pero depende de que el paciente no la borre.
- **La regla es que el mensaje CONTENGA la frase del formato**, no al revés: una frase larga o con un typo casi nunca
  coincide (pasó el 2026-11-18: el formato era la oración entera "hola, escribo por la promioen en implantes dentales, me gustaria
  hacer una cita" y ningún mensaje real la contenía). Hay que cargar lo más corto y propio de la campaña ("promoción en implantes"),
  y varios formatos cortos si hace falta. La pantalla avisa de las frases de más de 6 palabras y trae **"¿Se reconocería este
  mensaje como de una campaña?"** (`GET .../campaigns/match?texto=`, la misma `detectCampaign()` del webhook, dice qué formato
  coincidió; el texto va por query, que la auditoría no guarda): es la forma de comprobar una campaña sin escribirle por WhatsApp.
- El anuncio gana sobre la frase; entre frases gana la más larga. **Un formato no puede ser de dos campañas de la
  clínica** (no se sabría a cuál atribuir). Solo atribuyen las campañas **activas**.

- **`asistente`** (2026-11-18, para ser más robusto): si ningún formato coincide, el asistente igual puede reconocer a qué promoción
  se refiere la persona ("vi la promo de implantes", "la del 20 %"). Cada mensaje trae el bloque **"Promociones vigentes de la
  clínica"** (`describeActivePromotions()`: nombre entre comillas, servicio, quién lo atiende y detalle; **solo las vigentes**, máx. 10;
  parámetro `promociones`, **obligatorio**), y el modelo devuelve en `campana_mencionada` el **nombre EXACTO** de la que mencionó.
  `recordCampaignMention()` lo resuelve contra las vigentes de la clínica (sin acentos ni mayúsculas, **exacto**: un nombre inventado,
  aproximado, vencido, desactivado o de otra clínica no atribuye nada) y crea el contacto con `triggerKind: "asistente"`. **Pasa en la
  misma conversación**: el resto del turno (el contexto, los horarios con los profesionales sumados y la reserva) ya tiene la campaña.
  Solo si todavía no se había atribuido por un formato (lo que diga después no cambia de campaña), y nunca puede tumbar el turno.
  La regla del prompt: no marcar por un saludo ni por pedir un turno, no ofrecer promociones por su cuenta, contar solo el detalle,
  y escalar lo que no figure. Es **menos exacto que un formato** (depende de lo que entienda el modelo): el reporte lo cuenta aparte
  ("Lo reconoció el asistente"). **Cuesta tokens en cada conversación** (la lista va en cada mensaje).

**Atribución.** `webhook.ts` llama a `recordCampaignContact()` **antes de encolar** el mensaje (así el contacto ya existe
cuando arranca el turno) y nunca puede tumbarlo. Crea un `CampaignLead` la primera vez que un número llega por una
campaña (único por clínica, campaña y número; dos mensajes a la vez crean uno), con `isNewContact` (el número nunca
había escrito ni era paciente). Se audita (`campaign.lead_create`, origen `whatsapp`, **sin teléfono ni texto**). Cada
mensaje posterior de ese número actualiza `lastInboundAt` en sus contactos abiertos. Las citas que saque ese número
dentro de **30 días** (`ATTRIBUTION_DAYS`) quedan con `Appointment.campaignId`; al agendar por el asistente el contacto
pasa a `convertido`.

**Promoción, servicio y profesionales.** La campaña se asocia a un **servicio** (que ya tiene sus profesionales en el
catálogo) y opcionalmente **le suma profesionales** (`extraProfessionals`) que, SOLO para esa campaña, pueden dar ese
servicio aunque el catálogo no se lo asigne. Se **suman** a los del catálogo, nunca los reemplazan, y solo valen si la
campaña está **vigente** (activa y dentro de `startsOn`/`endsOn`) y el servicio pedido es el de la promoción.
`resolveServiceForRequest()` lo resuelve para los dos caminos (ofrecer horarios y agendar) vía `campaignId`. Con el servicio
de primera vez forzado no se suma nada.

**Los formatos son OBLIGATORIOS** (`SIN_FORMATOS`, `formato_requerido`): una campaña activa sin ninguno **nunca se reconoce**, aunque
alguien escriba "vengo por la promoción" (pasó el 2026-11-18: la campaña "Implantes" se guardó sin formatos y el asistente dijo que no
había ninguna promoción). Se aplica igual que el servicio: no se crea sin formatos, a una activa no se le sacan todos, y las de antes de la
regla se pueden desactivar pero no editar activas hasta cargarles uno; la pantalla marca "Sin formatos: nadie la va a reconocer".

**El servicio es OBLIGATORIO, y tiene que tener quién lo atienda** (`validateRelations()`): es lo que le dice al asistente
qué promocionar y con qué profesional agendar. Una campaña no se crea sin servicio (`servicio_requerido`) ni con un servicio
que nadie realiza —ni en el catálogo ni sumando profesionales a la campaña— (`servicio_sin_profesional`, cuenta solo a los
profesionales activos). **Una campaña activa, o que se va a activar, siempre cumple esto**: las anteriores a la regla (el
campo sigue nullable en la base solo por ellas) se pueden desactivar y renombrar, pero no editar activas ni reactivar sin
elegir el servicio; la pantalla las marca con "Falta el servicio". Si después el servicio se queda sin profesionales, editar
la campaña activa se rechaza hasta arreglarlo (desactivarla, no); mientras tanto el asistente recibe "no hay un profesional
que lo atienda" y no ofrece horarios de ese servicio.

**Lo que ve el asistente** (`prompts/campaign-context.ts`, parámetro `campana`, **obligatorio** en `interpretWithClient()`):
el nombre, el canal, **lo ÚNICO que se puede contar de la promoción** (`Campaign.description`; sin descripción se le dice
que no cuente precios ni condiciones), el servicio y quiénes lo atienden. Con la promoción vencida, programada o
desactivada se le dice que NO la ofrezca ni la prometa. La regla del prompt: reconocer la promoción una sola vez, no
inventar precios/descuentos/fechas, escalar lo que no figure, y que llegar por una campaña **no cambia las demás reglas**.
Es probabilístico: ningún test prueba que el modelo obedezca, solo que la regla y el contexto le llegan.

**Seguimiento de quienes preguntan y no agendan** (`jobs/campaign-followup.ts`, cada hora, plantilla
`seguimiento_campana`). **Con tope, para no insistir por siempre**: cada campaña define `followUpMaxAttempts` (0 a 5; 0 =
sin seguimiento), `followUpAfterHours` (cuánto después de su último mensaje el primero) y `followUpIntervalHours` (entre
uno y otro); **los límites los impone también un CHECK de la base**. Agotados los intentos y pasada la espera sin que
conteste, el contacto se cierra como `sin_respuesta`.

- **Apagado por defecto** (`Clinic.campaignFollowUpEnabled`, lo prende el super-admin en el detalle de la clínica): va
  por una plantilla que Meta tiene que aprobar en cada WABA y puede reclasificarla como Marketing. Con el interruptor
  apagado el seguimiento cuenta como 0 intentos y los contactos igual se cierran: no quedan "abiertos" para siempre.
- **No se le escribe a quien ya agendó** (se mira la agenda, no solo el contacto: una asistente pudo cargarle la cita a
  mano; pasa a `convertido`) **ni a quien pidió que no lo contacten** (`Patient.outreachOptOut`; se cierra como
  `solicitud_del_paciente`), ni si la campaña se desactivó (`campana_inactiva`).
- Cada envío se **reclama antes de mandarlo** (UPDATE condicionado al contador): dos corridas no le escriben dos veces. Si el
  envío falla se libera y **se corta la tanda de esa clínica** con UN evento. Solo de 9 a 18 de la clínica, máximo 20 por
  clínica por corrida. Lo mandado queda en el historial de la conversación y en la auditoría (`campaign.followup_sent`,
  origen `sistema`, sin teléfono).
- Si el paciente contesta, el asistente retoma la conversación con el contexto de la campaña; la espera del siguiente
  seguimiento arranca de su respuesta. Si vuelve con la frase de la campaña tras cerrarse por no contestar, el contacto se
  reabre (el contador de seguimientos se conserva).
- La clínica puede **cerrar a mano** el seguimiento de un contacto desde la pantalla (`campaign.lead_close`).

**Nada se borra, se desactiva** (los contactos y las citas referencian la campaña). Fuera de la vigencia el contacto igual
se atribuye (la gente usa un flyer viejo), pero el asistente ya no ofrece la promoción.

**Lo que no cubre:** atribuir por una campaña que el asistente reconozca DESPUÉS de haberse atribuido por otra;  campañas
con precio o cupo estructurados (la promoción es texto que el asistente cuenta, no un descuento que el sistema aplique);
cargar la campaña de una cita hecha a mano desde la Agenda (la cita manual no queda atribuida; el contacto sí pasa a
`convertido` por el seguimiento); y probar el recorrido real con un anuncio de Meta (el webhook no tiene tests: lo prueba
el caso CA-01).

## Chat de pruebas: hablar con el asistente sin pasar por WhatsApp

La pantalla "Chat de pruebas" (`/test-chat`, permiso `chat_pruebas.usar`) deja escribirle al asistente desde el panel y
ver lo que contesta. Sirve para probar el tono, un cambio de configuración, una campaña o el recorrido de agendar sin
tener un celular a mano. Todo vive en `services/sandbox.ts` y las rutas son `GET/POST/DELETE
/dashboard/clinics/:id/test-chat`.

**Es el MISMO asistente, no un simulador**: `runSandboxTurn()` corre `runAgentTurn()` con el mismo prompt, las mismas
reglas de agenda (horario, espacio, equipo, profesionales, anticipación mínima) y la misma conversación guardada. Lo que
cambia es lo que **NO sale hacia afuera**:

- **Nada va por WhatsApp**: `deps.send` captura lo que el asistente habría mandado y se lo devuelve al panel.
- **Ningún aviso real**: `booking.ts` recibe `skipExternalEffects` y no avisa al profesional (mail/WhatsApp) ni espeja en su
  Google Calendar; una derivación a una persona (`registrarEscalamiento`, con `deps.sandbox`) **no se guarda ni se manda por
  mail ni por WhatsApp**: queda como una nota en el chat. Tampoco se registran los eventos de monitoreo del catálogo.
- **La cita SÍ se crea** (con todas sus reglas), a nombre de un paciente de prueba, para poder probar cambiarla o
  cancelarla. Ocupa la agenda hasta que se reinicie.
- Cada mensaje devuelve también **qué entendió el asistente** (intención, servicio, fecha, derivación…), útil para depurar
  el prompt. Sin el texto de la respuesta, que ya está en el chat.
- **Se comporta como un mensaje de la calle, sin atajos** (decidido el 2026-11-18): no hay forma de decirle de antemano qué va a
  pedir quien escribe, ni de "simular" que llegó por una campaña (hubo un selector y se sacó). Una campaña se reconoce **solo si el
  texto trae una de sus frases**, igual que por WhatsApp; la pantalla muestra cuál reconoció. Es también lo que permite ver
  si una campaña está bien armada: si escribes "vengo por la promoción" y no la reconoce, es que falta ese formato.

**Aislamiento: todo cuelga de un teléfono reservado**, `prueba:<usuario>` (`services/sandbox-phone.ts`), uno por persona del
panel (cada una tiene su conversación). Por eso se borra de una vez:
- **"Reiniciar"** (`DELETE`) borra la ficha, lo hablado, las citas (con sus eventos) y el contacto de campaña.
  `purgeSandboxPhone()` **solo acepta teléfonos de prueba**: no puede usarse para borrar a un paciente real.
- **`jobs/sandbox-cleanup.ts`** (cada hora) borra las que llevan **2 horas** sin actividad, para que una prueba olvidada no
  le deje citas de mentira a la clínica.
- **Los jobs que le escribirían a un paciente ignoran esos teléfonos** (`SANDBOX_PATIENT_FILTER`): recordatorios de 24 h y
  2 h, seguimiento post-visita, contacto por próxima cita sugerida, seguimiento de campañas y el reporte diario. Las
  estadísticas y la lista de contactos de campañas también los dejan afuera. **Un job nuevo que le escriba a un paciente
  tiene que excluirlos.**

**Lo que sí es real**: cada mensaje llama al modelo (cuesta tokens y queda en las solicitudes de Monitoreo), la auditoría
registra los cambios de la ficha de prueba (`sandbox.message` / `sandbox.reset`, sin el texto), y mientras no se reinicie,
las citas de prueba **entran en los reportes y en la ocupación** (los reportes no las filtran: confían en el borrado). Dos
mensajes a la vez de la misma persona no se pisan: el segundo recibe 409.

**Lo que no cubre**: probar el webhook ni a Meta (el `referral` de un anuncio, las plantillas, que el mensaje llegue): para eso
hace falta WhatsApp de verdad (casos CA-01 y similares); ni los recordatorios y seguimientos, que no se disparan para pruebas.

## Seguros: con cuáles trabaja la clínica

Los pacientes preguntan seguido si la clínica trabaja con su obra social. El
agente contesta **un solo hecho**: si trabajan con esa aseguradora o no.

Dos niveles, igual que los títulos de profesional:

- `Insurer` — catálogo **global de la plataforma**, en Catálogos → Seguros
  (`/platform/catalogs/insurers`, solo super-admin). Si cada clínica cargara el suyo,
  "OSDE" existiría escrita de tres formas. `prisma/seed.ts` →
  `SEED_INSURERS` siembra un punto de partida.
- `ClinicInsurer` — con cuáles trabaja cada clínica, en "Seguros"
  (`/insurers`, permisos `seguros.ver` / `seguros.editar`). **Esto lo
  administra la clínica**, a diferencia de los títulos: empezar o dejar de
  trabajar con una aseguradora es una decisión operativa suya y cambia
  seguido.

**El activo/inactivo vive en la relación y no en la aseguradora**, y por eso
`ClinicInsurer` es un modelo explícito y no una N-N implícita: la clínica deja
de trabajar con una sin que eso diga nada de la aseguradora ni de las otras
clínicas. Se desactiva en vez de borrarse porque la interrupción suele ser
temporal —se renegocia el convenio y vuelve— y así no hay que buscarla de
nuevo en el catálogo. La pantalla distingue tres estados: activo, dado de baja
y nunca tomado (`active: null`).

Lo que el agente menciona sale de la **intersección**
(`listActiveInsurersForClinic()`): activa en el catálogo **y** activa para esa
clínica. Desactivar en el catálogo una que alguna clínica tiene activa está
bloqueado: el asistente dejaría de decir que trabajan con ella de un momento a
otro, sin que la clínica haya cambiado nada ni se entere.

**La cobertura NO se carga y el agente nunca la afirma.** No es una limitación
del modelo de datos, es del problema: la cobertura depende del **plan** del
paciente y no de la aseguradora (OSDE 210 y OSDE 450 no cubren lo mismo), así
que cualquier dato cargado a nivel clínica sería falso para alguien. Y
equivocarse acá significa que el paciente llega y tiene que pagar algo que le
dijimos que estaba cubierto — el mismo criterio que hace que el link de Maps se
arme en código. El prompt lo prohíbe explícitamente: ante una pregunta de
cobertura, importes, coseguros o autorizaciones, escala a una persona, y puede
agendar el turno igual en el mismo mensaje.

**Una lista vacía no significa "no trabajamos con seguros".** Puede ser eso o
"todavía no lo cargamos", y no hay forma de distinguirlas, así que
`SIN_SEGUROS` (`prompts/insurers-context.ts`) le dice al modelo que no afirme
ni niegue ninguno y derive. Mismo criterio que `SIN_HORARIO`: afirmar que no
trabajan con ninguno le haría perder un paciente que sí tenía cobertura.

Cuando la lista **sí** tiene seguros cargados, es autoritativa: el agente
puede decir que con uno que no está no trabajan. Por eso, si se carga, hay que
cargarla completa — mismo compromiso que el catálogo de servicios.

Nada de esto se guarda como texto libre ni como documento adjunto. El texto
libre es el error de `Clinic.businessHours` de nuevo (se desincroniza y el bot
anuncia lo que no se sostiene), y un PDF no le sirve al agente en la
conversación: le sirve a una persona.

## Catálogo de servicios

`Service` define, por clínica, qué se ofrece, cuánto dura y qué equipo ocupa.
Se carga desde la pantalla "Servicios" (`/services`, permisos `servicios.ver`
/ `servicios.editar`).

**El prompt lo lee.** `buildSystemPrompt()` recibe los servicios activos y arma
la línea de servicios con `describeServices()` (`services/catalog.ts`) —
nombre y duración. Si el catálogo está vacío usa `Clinic.services`, el texto
libre, para no romper a las clínicas que no lo cargaron. Es el mismo criterio
que ya se aplicó al horario: el texto
que ve el modelo sale del dato estructurado, así que el agente no puede
ofrecer un servicio que después no se pueda agendar, y puede contestar cuánto
dura cada uno.

`GET /dashboard/clinics/:id/services` devuelve `descripcion` (lo que lee el
agente) junto a `textoDelPrompt` (el campo libre) para poder compararlos a
ojo, igual que `GET .../working-hours`.

**El precio es opcional y de texto** (`Service.priceNote`, 2026-11-19; una línea, hasta 200 caracteres,
`isValidPriceNote()`). Es lo ÚNICO que el asistente dice cuando le preguntan cuánto cuesta algo: llega al system
prompt como "Precios que la clínica informa" (`describeServicePrices()`, solo los servicios con precio) y **no toca**
la línea "Servicios que ofrece la clínica", que el modelo copia para el nombre exacto. Es texto y no un número para
cubrir "desde $500" o una condición ("sin costo si llega por redes") sin modelar monedas ni descuentos. **Sin precio
cargado el asistente no lo inventa ni da un rango**: dice que el costo se confirma en la consulta y vuelve a agendar;
**una consulta de precio no es motivo para escalar** (antes el paciente que preguntaba el precio del diagnóstico se
quedaba sin respuesta y se iba sin agendar). La cortesía "si llega por redes" no es un campo aparte: es una campaña
(`Campaign.description`), y **lo que diga la promoción vigente sobre el precio de ese servicio manda sobre
`priceNote`**. Es una regla de prompt (probabilística): los tests prueban que llega, no que el modelo obedezca.

**El tipo de equipo no es texto libre.** El selector solo ofrece los `type` de
los `Resource` activos de esa clínica, y el backend lo valida igual
(`GET .../resource-types`). Un servicio que pidiera un tipo inexistente no
tendría nunca un hueco disponible ni se podría agendar, y no daría ningún
error visible — `findAvailableResource()` devolvería `null` siempre.

**Un servicio con turnos no se borra**, se desactiva: los turnos históricos lo
referencian. `findServiceInCatalog()` ya filtra por `active`.

## Cómo se identifica el servicio que pidió el paciente

`findServiceInCatalog()` busca por coincidencia de texto: el nombre del catálogo
tiene que CONTENER lo que devolvió el modelo en `servicio`. Si el modelo copiaba
lo que dijo la persona ("limpieza dental") no matcheaba "Limpieza" y se trataba
como servicio que la clínica no ofrece (derivación + aviso de configuración por
algo que sí hace). Por eso, **con catálogo cargado** el prompt le exige traducir
al nombre exacto del catálogo, sin la duración entre paréntesis
(`buildSystemPrompt()`, regla "Cómo completar servicio"; sin catálogo no se
agrega, no hay nada que copiar).

**Cuando nada encaja NO se le pide `null`**, sino lo que pidió la persona con sus
palabras. `null` significa "no pidió ningún servicio": se agenda con
`defaultAppointmentMinutes` y un masaje en una clínica dental saldría agendado.
Lo que no matchea es lo que el código ya trata como `servicio_no_ofrecido`
(`resolveServiceForRequest()`), y así sigue.

Cada derivación por `servicio_no_ofrecido` registra un evento
`servicio_sin_match` (`registrarEscalamiento()` en `agent-turn.ts`) con el
nombre que devolvió el modelo —no el mensaje del paciente—, para medir con uso
real cuántas son falsas. El prompt es probabilístico: no hay test que pruebe que
el modelo obedece, solo que la regla se le entrega.

## Qué profesional realiza qué servicio

No todos los profesionales hacen todo. `Professional` ↔ `Service` es una N-N
(`_ProfessionalServices`), que se administra desde "Servicios" (quiénes lo
realizan) y desde "Recursos" (qué servicios hace cada uno). Lo resuelve
`resolveServiceForRequest()` (`services/catalog.ts`), que devuelve
`allowedProfessionalIds` — la MISMA función para los dos caminos: el que ofrece
huecos (`findSlotsForPatient`) y el que agenda (`createAppointmentFromRequest`),
más el chequeo final dentro de la transacción serializable
(`profesional_no_hace_servicio`).

- **Un profesional sin servicios "no hace nada".** Con catálogo cargado no se
  lo deja dar de alta, activar ni quedar sin ninguno
  (`repositories/professional-services.repository.ts`); y quitarle a alguien su
  último servicio desde el lado del servicio también se rechaza, con los nombres.
  `config-health` avisa de los que ya están así (`profesional_sin_servicios`) y
  de los servicios que nadie realiza (`servicio_sin_profesional`).
- **Sin catálogo no se restringe nada** (`allowedProfessionalIds: null`): las
  clínicas con servicios en texto libre siguen como antes. Ojo: **lista vacía ≠
  null**; vacía es "nadie lo hace".
- La migración **rellenó todos × todos** para las clínicas existentes: el
  comportamiento anterior (cualquiera hace cualquier cosa) pasó a ser explícito
  y cada clínica lo ajusta.
- **Pide a alguien que no lo hace**: el pedido se ignora (no se agenda con esa
  persona) y `formatAvailableSlots()` antepone `AVISO: X no realiza este
  servicio…` al bloque de horarios; el prompt le dice al modelo que lo explique
  con diplomacia y ofrezca a quienes sí. `resolveProfessionalForBooking()`
  devuelve `requestedIgnored`.
- **Servicio de primera vez** (`Service.firstVisit`, uno solo por clínica):
  el paciente nuevo (y no urgente) parte siempre por ese servicio, que reemplaza
  a lo pedido (`firstVisitForced`) y solo lo hacen los profesionales asignados.
  Sale del mismo dato que todo lo demás. Si la clínica no marcó ninguno, no se fuerza nada
  (la regla vieja del profesional principal se retiró el 2026-11-10).
- **Servicio no ofrecido / sin profesional** (`blocker` `servicio_no_ofrecido` /
  `servicio_sin_profesional`, o el mismo motivo al agendar): no se ofrecen
  horarios, `agent-turn.ts` registra una derivación (fila + mail) y avisa por
  WhatsApp por la plantilla `aviso_configuracion` al `adminPhone`. El mail y el
  WhatsApp dicen que, si la clínica sí presta el servicio, lo cargue en
  "Servicios" y lo asigne a quienes lo realizan. `servicioSinCubrir` evita que
  la misma derivación se registre dos veces si el modelo además marca
  `escalar_a_humano`.
- El prompt recibe `serviciosPorProfesional` ("Qué realiza cada profesional") y
  `servicioPrimeraVez`.

## Reprogramar una cita, y cuando la reserva falla

**Reprogramar se ejecuta, no se dice.** Durante un tiempo el modelo detectaba la
intención `reprogramar` y respondía "cambié tu cita", pero `agent-turn.ts` solo
ejecutaba agendar y cancelar: la cita seguía en su hora (pasó el 2026-11-05).
Ahora `createAppointmentFromRequest()` recibe `replaceAppointmentId`.

- **La baja de la cita vieja va DENTRO de la misma transacción serializable que
  crea la nueva.** Dos motivos: si el hueco nuevo se pisa con la propia cita
  (9:00 → 9:30 con un turno de 45 min), tiene que dejar de contar como ocupado;
  y si la nueva no se puede crear, todo se revierte y el paciente **conserva la
  vieja**: nunca se queda sin ninguna.
- El enumerador de huecos recibe `excludeAppointmentId` para lo mismo: no ofrecer
  como ocupado el horario que el paciente ya tiene.
- Se considera reprogramación `intent: "reprogramar"`, o `"confirmar"` con
  `turno_a_modificar` (el paciente elige el horario y el modelo lo marca como
  confirmación). El id del modelo **nunca se busca solo**: va acotado a la
  clínica y a las personas del número, y solo si sigue `confirmado`
  (`buscarTurnoVigente()`). Un id que no cumple no reprograma nada **y tampoco
  agenda una cita nueva a cambio** (duplicaría el turno).
- Por default se mantienen la persona, el servicio y el profesional de la cita
  que se mueve; si el paciente pide otro, rige lo que pida.
- El evento espejo viejo se borra después de cerrar la transacción; si falla se
  loguea y no deshace el cambio.
- El prompt tiene la regla del flujo: consultar la agenda, esperar la elección y
  recién ahí confirmar con el id. "Ya reviso" sin consultar es justo lo que
  dejaba la conversación sin hacer nada.

**Cuando la reserva falla, el paciente no recibe la confirmación que el modelo ya
redactó.** Antes se mandaba igual ("quedó agendado" de un turno que no existía).
Ahora `agent-turn.ts` vuelve a llamar al modelo con el motivo
(`describeBookingFailure()`) y, si otro horario sirve, con los huecos reales; lo
que devuelve es **solo redacción** (se fuerzan `confirmacion_explicita`,
`requiere_horarios_disponibles`, `escalar_a_humano`, `turno_a_modificar` y
`pidio_ubicacion` en falso, para que no pueda agendar, cancelar ni derivar nada).
Si esa llamada también falla, sale una disculpa fija en español neutro. Los
motivos que ya derivan a una persona (servicio no ofrecido o sin profesional,
equipo fuera de servicio) lo dicen en vez de ofrecer horarios.

**Una persona no puede tener dos citas que se pisan.** `booking.ts` lo impone
dentro de la transacción (`paciente_con_turno_superpuesto`), después de dar de
baja la que se reprograma. Sin esto, "mejor con la Dra. X" sobre una cita recién
agendada creaba una SEGUNDA cita en vez de mover la primera (2026-11-06: Eva
María quedó con dos). El prompt además dice que cambiar cualquier dato de una
cita —también solo el profesional, también una recién agendada— es reprogramar.
**Al reprogramar el servicio no cambia:** manda el de la cita que se mueve, no el
que diga el modelo (si no, mover una evaluación inicial la convertía en otro
servicio y se salteaba la regla de primera vez).

**La primera vez se le muestra al modelo POR PERSONA**, igual que la decide el
código: "Personas de este WhatsApp" marca `[PRIMERA VEZ: nunca tuvo una cita]`
(`PersonForPrompt.primeraVez`, calculado con cualquier cita, aunque esté
cancelada). Antes el prompt usaba "primera vez" del NÚMERO, así que con un titular
conocido no se enteraba de que la persona por la que pedía era nueva, y decía
"agendo la extracción" mientras el sistema agendaba el diagnóstico inicial (con
otra duración y otro profesional). La regla del servicio de primera vez se le da
al modelo siempre que la clínica tenga uno marcado.

**Evaluación inicial y tratamiento: dos citas seguidas se agendan SOLO si la persona las pide.** El sistema las permite: la
persona deja de ser "de primera vez" apenas tiene una cita agendada (no hace falta que esté atendida), así que puede agendar el
tratamiento a continuación, y el tratamiento puede ser con otro profesional (el que lo tenga asignado). **Pero no es lo que el
asistente propone**: el 2026-11-06 el prompt se escribió a partir de un caso puntual (un paciente que sí hizo dos citas
consecutivas) y quedó como si fuera la norma, ofreciéndole a todo paciente nuevo "una cita o dos"; el 2026-11-18 se corrigió. Hoy,
ante un paciente nuevo que pide un tratamiento, el bot le dice **en una sola frase** que primero va la evaluación y le ofrece los
horarios de la evaluación, nada más. **Solo si la persona pide dejar el tratamiento reservado a continuación, o pregunta si puede ser
el mismo día**, ofrece los horarios del tratamiento (que empiecen cuando termina la evaluación). Al confirmar cuenta la situación de
cada cita; si quedó solo la evaluación, agrega una frase: el tratamiento se define después con el profesional. No hay ningún código que
ate las dos citas: si se mueve la evaluación, el bot solo *pregunta* qué hacer con la otra.

## No se agenda sin el nombre y el apellido

**El asistente primero confirma quién es la persona y recién después agenda** (decidido el 2026-11-18). Pasaba al revés: el modelo
marcaba la confirmación apenas la persona elegía el horario, la cita se creaba a nombre de nadie, y el mensaje que pedía el nombre
llegaba DESPUÉS de haberla agendado; al darlo, el segundo intento chocaba con la cita recién creada ("no pude concretar ese horario").

- **Se impone por código** (`agent-turn.ts`, antes de `deps.book`, motivo `falta_nombre_y_apellido`), no solo por el prompt: se lee la
  ficha de la persona del turno de la base (el nombre pudo llegar en este mismo mensaje) y, si no tiene nombre **y** apellido (las
  partes guardadas, o el nombre completo con dos palabras o más), **no se agenda**. Al modelo se le avisa con el mismo mecanismo
  que un fallo de reserva (`explicacion_fallo`), pero sin horarios alternativos: "la cita NO se agendó todavía, pedí el nombre y
  apellido en una sola pregunta y decile que con eso la dejás agendada (horario elegido: …)". Si esa llamada también falla, sale una
  frase fija ("Para dejar tu cita agendada necesito tu nombre y apellido. ¿Me los compartes?").
- **Completar una ficha a medias**: si la ficha de quien escribe está sin nombre o solo con el nombre de pila, se completa con lo que el
  modelo entendió en este mensaje (antes el nombre solo se cargaba si la ficha estaba vacía, y un apellido dado después nunca llegaba:
  se lo pedía una y otra vez). Una ficha que ya está completa no se pisa,
  **salvo que la persona la corrija** (2026-11-19: "te di mi nombre mal, es María" — el asistente decía "ya lo corrijo" y la ficha
  quedaba igual): el modelo marca `corrige_nombre: true` y completa `nombre_paciente` / `apellido_paciente` con el nombre ya corregido;
  `correctPatientName()` lo aplica **solo sobre la ficha de quien escribe**, acotada por clínica, conserva el apellido si no vino, y
  se audita como `patient.name_set` con `details.correccion` (nunca el valor). Sin la marca no se pisa nada. No cubre corregir el
  nombre de OTRA persona del número (queda para el personal, desde la ficha).
- **El prompt** le pide lo mismo (no marcar `confirmacion_explicita` sin nombre y apellido; cuando los dé, confirmar repitiendo la
  fecha y la hora elegidas; nunca decir "quedó agendada" mientras falten), para que el flujo sea natural y el guard sea la red.
- **No aplica** al reprogramar (esa persona ya tiene una cita) ni a la Agenda editable (ahí la asistente carga el nombre al crear la cita).
- Para otra persona del número vale lo mismo: "Nieves" sola no alcanza, hace falta "Nieves García".

## Privacidad de terceros: el asistente solo habla de quienes están en ESE número

Decidido el 2026-11-18. **Estructuralmente** el modelo solo recibe fichas, citas, historial y notas de las personas registradas en el
número que escribe (`findPatientsByPhone()`, todo acotado por `clinicId` y esos ids), así que no puede revelar datos de otro número.
El hueco era de **conducta**: ante "¿María Nieves tiene cita esta semana?" (alguien sin ficha en ese número) contestaba "no tiene
ninguna", que confirma o niega algo sobre un tercero (y puede ser falso: tal vez sí tiene, desde otro número). Regla "PRIVACIDAD" en
`prompts/system-prompt.ts`: no confirma ni niega citas ni que sea paciente, lo explica en una frase y ofrece agendarle una cita o que
escriba desde su número. **No frena agendar para un familiar** (papá, hijo): eso sigue igual. Es una regla de prompt (probabilística);
el test prueba que llega y se verificó con el modelo real.

### Cita para otra persona: con qué número se registra y quién queda autorizado

Al agendar para OTRA persona nueva (que no figura en "Personas de este WhatsApp"), el asistente pregunta —en el mismo mensaje que el
nombre y el apellido, sin frenar el agendar— con qué número se la registra (**este u otro**) y si se deja autorizado **otro número**
para pedir informes de la cita. El modelo devuelve `telefono_registro` y `telefono_autorizado` (opcionales; sin respuesta rige este
número y ninguno adicional). Lo guarda `applyBookingPhones()` (`repositories/patients.repository.ts`) justo antes de crear la cita:

- **`Patient.phone`** es el número de la persona, al que van sus avisos y recordatorios; si se la registra con otro, ese otro número
  la ve como su ficha (cuando escriba será su titular). **`Patient.authorizedPhones`** (hasta 3) son los WhatsApp que pueden
  consultarla y gestionarla SIN ser su titular: `findPatientsByPhone()` devuelve las fichas del número y las que lo tienen autorizado,
  y de ahí sale todo lo que el asistente lee de un número, así que lo autorizado es lo único que se suma a lo visible.
- Si se la registra con otro número, **quien agendó queda autorizado automáticamente** (si no, no podría cancelar ni cambiar la cita).
- **Solo se aplica a una ficha sin citas y que vive en el número de quien escribe**: no se pueden reescribir los datos de contacto de
  alguien ya registrado ni de otro número. Nunca a la ficha propia de quien escribe, ni al reprogramar.
- **En el chat de pruebas no se mueve `phone`** (los avisos saldrían a un teléfono real); solo se agrega el autorizado.
- Se normaliza (`services/phone.ts`: solo dígitos, 8 a 15) y lo inválido se descarta. Se audita `patient.phones_set` con solo el nombre
  de los campos, nunca los números. El personal los ve y edita en la ficha del paciente ("Números autorizados").
- **Riesgos que se aceptan, y por qué:** el número lo dicta quien agenda y no se verifica que sea de esa persona (los avisos pueden
  llegar a un tercero equivocado; el autorizado ve las citas). Por eso son pocos, quedan en la ficha para revisar y la pantalla pide
  agregar solo gente de confianza. **No hay un guard por código** que obligue a preguntarlo (a diferencia del nombre): es del prompt, y
  si el modelo no lo pregunta rige el comportamiento de siempre. Tampoco se reconcilian formatos: un número dictado sin el código de
  país (o México con 52 vs 521) no va a coincidir con el que usa WhatsApp, y el prompt le pide al paciente incluir el código.

## Presentación del asistente y aviso de privacidad (2026-11-20)

Dos mensajes que el asistente manda **por código** (no por el prompt: un link que el modelo reescribe puede salir mal, y esto no puede
depender de que el modelo lo mencione), cada uno **una sola vez por ficha titular** de la conversación, como mensaje APARTE
(`services/privacy-notice.ts`; `agent-turn.ts` → `enviarAvisosUnaVez()`):

1. **Presentación, antes de la primera respuesta:** *"Le atiende el asistente virtual de {clínica}."* (`Patient.assistantIntroSentAt`).
   **No se puede apagar ni quitar**: la política de uso de Anthropic exige que los chatbots que hablan con clientes avisen que son una IA
   (*"al menos al comienzo de cada sesión de chat o en la interfaz del producto"*) y prohíbe hacerse pasar por una persona; incumplirlo pone en
   riesgo la cuenta del modelo, que es la de TODAS las clínicas (se pidió no decirlo, el 2026-11-20, y se mantuvo por esto: se acortó y se quitó el
   tono legal). El prompt lo refuerza ("HONESTIDAD SOBRE QUIÉN ERES": nunca niega ser un asistente virtual ni usa nombre de persona).
   Cualquier cambio que haga al asistente parecer una persona (nombre propio, frases como "mi consultorio") choca con esto: revisarlo
   contra la política de uso y la regla transversal 3.
2. **Aviso de privacidad, en el SEGUNDO mensaje de la persona (no en el primero, para no abrumar):** *"Mientras tanto, le dejamos el aviso
   de privacidad de {clínica}: {link}"* (`Patient.privacyNoticeSentAt`). El link es `Clinic.privacyNoticeUrl` (https, hasta 500
   caracteres, `isValidPrivacyNoticeUrl()`), lo carga el super-admin en el detalle de la clínica. **Sin link no se manda nada y la marca no se
   pone**: cuando se cargue, lo recibe quien todavía no lo tenía. `config-health` avisa (advertencia) si falta (`sin_aviso_de_privacidad`).
   La clínica es la responsable de los datos de sus pacientes. **A confirmar con un abogado** que llegue en el segundo mensaje y no al recoger el
   primer dato (el primer mensaje ya puede traer datos de salud).

Común a los dos: la marca se **reclama antes de mandar** (UPDATE condicionado a null: dos mensajes a la vez no duplican) y **se libera si el
envío falla** para reintentar en el próximo mensaje; **nunca tumban el turno**; son mensajes de respuesta (ventana de 24 h, sin plantilla de Meta);
van de usted; quedan en el historial de la conversación y en la auditoría (`patient.assistant_intro_sent`, `patient.privacy_notice_sent`, origen
`whatsapp`, sin el link ni el teléfono). **El Chat de pruebas no los manda por WhatsApp pero los MUESTRA como notas** («Al paciente real se le mandaría, antes de la primera
respuesta: …» / «…después de esta respuesta: …»), y en el segundo mensaje avisa **por qué no salió el aviso si la clínica no cargó el link** (es la
causa más común de «no me mandó el link»); la marca se reclama igual y se borra al reiniciar. Las fichas que ya existían (incluidas las importadas) los reciben la próxima vez que escriban.

**Lo que NO resuelve:** el consentimiento para datos de salud. Los mensajes informan y enlazan; no afirman que la persona "acepte" nada. Si la ley
mexicana lo pide expreso y por escrito, la clínica y su abogado tienen que definir cómo recogerlo (ver `docs/legal/`; modelo de aviso para que cada
clínica lo adapte en `docs/legal/modelo-aviso-de-privacidad-clinica.md`). En `tests/agent-turn.test.ts` las fichas se crean con las dos marcas ya
puestas para que el resto de las pruebas no cuenten estos mensajes; las de "presentación del asistente y aviso de privacidad" las ponen en null.

## Cómo habla el asistente: tratamiento y brevedad

Dos reglas de estilo (`prompts/system-prompt.ts`), decididas el 2026-11-18 al probar en el chat de pruebas:

- **Al paciente se le habla SIEMPRE de usted, en todos los países** (decidido el 2026-11-18, por respeto; antes era tuteo/voseo según el
  país). Se dice con ejemplos ("puede", "cuénteme", "le comparto", "¿me indica su nombre?"; nunca "puedes", "podés"…; en México "cita" y
  no "turno") en el system prompt **y** en una línea del mensaje de CADA turno (`recordatorioDeTratamiento()`), que pesa más porque
  está junto a lo que el modelo redacta. `formaDeTratamiento()` quedó fija en "usted" a propósito: si un país pidiera otro trato, es un
  campo de `Clinic`, no una lista en el código. Las frases fijas que salen sin pasar por el modelo (`AVISO_DE_ESPERA`,
  `DISCULPA_POR_FALLA`, los fallbacks de `agent-turn.ts`) y los ejemplos para el paciente que se escriban en el prompt van de usted.
  **No escribir instrucciones en voseo**: el modelo copia el registro.
- **Habla como PARTE del equipo de la clínica, no como un tercero** (2026-11-23): primera persona del plural y con cercanía ("trabajamos con AXA",
  "nuestros doctores", "nuestro equipo se lo confirma", "atendemos de lunes a viernes"), nunca "la clínica", "alguien de la clínica" ni "el personal"
  en tercera persona. Regla "ERES PARTE DEL EQUIPO" del system prompt, una frase en el mensaje de CADA turno (`recordatorioDeTratamiento()`) y los
  ejemplos de derivación ("se lo confirma nuestro equipo") y las frases fijas (`DISCULPA_POR_FALLA`: "una persona de nuestro equipo…") ya van así.
  **Convive con la honestidad sobre ser un asistente virtual** (regla "HONESTIDAD SOBRE QUIÉN ERES": es el asistente del equipo, lo dice al empezar y
  nunca se hace pasar por una persona, sin nombre propio ni "mi consultorio"). Es una regla de prompt (probabilística): los tests prueban que llega.
- **La despedida no dice dónde se espera** ("ahí", "allí", "aquí"): la clínica es
  donde está quien escribe. Se dice "lo esperamos" a secas.
- **Sé breve.** Solo lo que preguntó o necesita para el próximo paso, **2 o 3 oraciones** (la lista de horarios no cuenta), sin
  explicar políticas, procesos ni opciones que no pidió, y **una sola pregunta por mensaje**: el nombre y el apellido se piden cuando
  ya eligió un horario, no junto con la lista.

Son instrucciones a un modelo (probabilístico): los tests prueban que la regla le llega, no que obedezca; se ve en el chat de pruebas.

## Saludo y despedida según la hora

Cada turno lleva `Momento del día: mañana | tarde | noche` junto a "Fecha y hora
actual" (`prompts/time-of-day.ts` → `momentoDelDia()`). Se calcula **en código y
con `Clinic.timezone`**, no con la hora del servidor, y no se deja que el modelo
decida el umbral: mañana 05:00–11:59, tarde 12:00–19:59, noche 20:00–04:59. Va en
el mensaje del turno y **no en el system prompt**, que se cachea y no puede
cambiar de un mensaje a otro. Antes la regla de despedida le decía al modelo que
no dependiera de la hora, y deseó un "excelente día" de noche (2026-11-05).

## La Agenda es editable: crear, mover, editar y cancelar desde la aplicación

La Agenda (`/calendar`) a futuro reemplaza a la de otras plataformas, así que las
asistentes pueden trabajar directamente en ella (permiso `citas.gestionar`; sin él
la pantalla es de solo lectura). Todo vive en `services/appointment-admin.ts`; las
rutas (`/dashboard/clinics/:id/appointments`, `.../appointments/:id`,
`.../appointments/:id/cancel`, `.../blocks`) solo validan el body y traducen el
resultado a HTTP.

**Mismas reglas que el asistente de WhatsApp, con excepción confirmada** (decidido
el 2026-11-07). Hay dos categorías y la distinción es todo el diseño:

- **Blandas — se pueden saltar confirmando:** horario en el pasado, horario
  dentro de la anticipación mínima de la clínica (`anticipacion_minima`), clínica
  cerrada, profesional fuera de su horario, profesional ocupado (sobreturno) o
  con la agenda bloqueada, y paciente de
  primera vez que no empieza por el diagnóstico. El flujo es de dos pasos: se
  manda sin `force`, y si hay reglas rotas el backend responde **409 con
  `requiereConfirmacion` y `violaciones` sin haber escrito nada**; la pantalla las
  muestra y reenvía con `force: true`. Queda constancia en `Appointment.forcedRules`
  (y `createdByUserId` / `modifiedByUserId`); la grilla marca esas citas con `!`.
  Un cambio posterior que arregla la regla limpia la constancia.
- **Duras — no se saltan nunca:** el espacio ocupado (o inexistente), el equipo
  ocupado o fuera de servicio, la misma persona con dos citas que se pisan, y
  **que el profesional realice el servicio** (`profesional_no_hace_servicio`,
  endurecida el 2026-11-21: antes era blanda; es la misma regla que impone el
  asistente de WhatsApp). Son físicas o rompen la identidad del turno; confirmar
  no las cambia. Al **editar**, la regla del profesional solo se exige si cambió el
  profesional o el servicio (mover de hora una cita anterior no falla porque
  después se le quitó el servicio al profesional), y el diálogo no deja elegir a
  quien no realiza el servicio (aparece deshabilitado). `forcedRules` de citas
  viejas puede traer esa regla guardada: la etiqueta se conserva.

Detalles que no son obvios:

- **Se edita en el lugar, no se crea una cita nueva.** Mover una cita actualiza la
  misma fila (el id no cambia, así la historia es una). Por eso
  `hasOverlappingAppointment`, `findAvailableRoom`, `findAvailableResource` y
  `checkAvailability` aceptan `excludeAppointmentId`: la cita que se mueve no
  cuenta como ocupación de nada, y se puede mover 9:00 → 9:30 aunque se pise
  consigo misma. (El camino de reprogramar del asistente de WhatsApp es otro: crea
  una nueva y cancela la vieja, en una transacción.)
- **Mover no cambia la duración**; cambiar el servicio sí (la del servicio nuevo)
  salvo que se indique otra. Al editar sin pedir un espacio, se intenta conservar
  el mismo.
- **Transacción `Serializable` y llamadas de red después**, igual que `booking.ts`.
  Al mover o cambiar de profesional se borra el evento espejo viejo y se crea el
  nuevo; si el profesional cambió se le avisa. Si falla el espejo, se loguea y no
  deshace el cambio.
- **Una cita atendida o cancelada no se edita** (`no_encontrado`): es historia.
- **La primera vez NO reemplaza el servicio** como hace el asistente: la asistente
  eligió a propósito, así que se avisa y se deja confirmar.
- **El paciente se busca o se carga ahí mismo** (**nombre Y apellido en dos campos, los dos obligatorios** —
  `validateNewPatientName()`; con una palabra sola se rechaza con 400, y las partes se guardan en `firstName`/`lastName`—, y
  teléfono con código de país, que es el WhatsApp de los recordatorios). El campo de búsqueda lleva una lupa que avisa que al
  escribir aparecen las opciones. La auditoría de la ruta dice si la cita trajo una ficha nueva (`pacienteNuevo`, sin datos). Si esa persona ya está cargada
  en ese número se reusa la ficha.

**Aviso al paciente: opcional en cada cambio.** Una casilla al guardar o cancelar, y
tras arrastrar una cita un botón "Avisar al paciente" en el aviso. Va por
plantilla (`cita_modificada`, `cita_cancelada` en `CLINIC_TEMPLATES`;
`services/patient-notifications.ts`), porque lo inicia la clínica; **hay que
esperar que Meta las apruebe en cada WABA**. Si falla, el cambio ya está hecho: se
le avisa a la asistente que lo comunique por otro medio.

**Bloqueos manuales** (`CalendarBlock.source = manual`, con `title`): reunión,
almuerzo, vacaciones; uno por profesional, frenan al asistente igual que uno
importado. **`calendar-sync` solo reemplaza los `source: calendario`**: sin ese
filtro borraba los manuales en cada pasada. No validan contra citas ya existentes
(como un evento de Google): frenan las nuevas, no cancelan las agendadas. Los
importados no se editan ni se borran desde la aplicación (volverían en el próximo
sync).

**Interfaz:** `CalendarGrid` sigue sin saber qué son sus columnas; avisa "esto, a
esta columna, a este minuto" y quien la usa decide: en vista día soltar en otra
columna es **cambiar de profesional**, en vista semana es **cambiar de día**. El
arrastre usa HTML5 drag & drop (no funciona en pantallas táctiles), ajusta a
cuartos de hora y dibuja dónde va a quedar. Soltar en un lugar que rompe reglas
blandas abre la confirmación; cancelarla deja la cita donde estaba.

## Planes

Qué funcionalidades tiene una clínica ya NO son booleanos sueltos en
`Clinic` — es un `Plan` (tabla, no hardcodeado), asignado vía
`Clinic.planId`. El super-admin arma planes desde la pantalla de
plataforma "Planes" (`/platform/plans`), combinando funcionalidades del
catálogo fijo en `src/config/plan-features.ts` (`PLAN_FEATURES` /
`PLAN_FEATURE_CATALOG` — mismo criterio que `PERMISSIONS`: los planes se
arman combinando este catálogo, pero una feature nueva ahí requiere código
real detrás). `prisma/seed.ts` siembra dos planes de arranque:

| Feature | Clave en `Plan.features` | En "Base" | En "Plus" |
|---|---|---|---|
| Agendar / cancelar / reprogramar | — (siempre activo) | sí | sí |
| Recordatorio 24hs antes | — (siempre activo) | sí | sí |
| Multi-profesional + validación de espacio/equipo | — (siempre activo) | sí | sí |
| Dashboard de métricas / auditoría / CRM | — (siempre activo) | sí | sí |
| Recordatorio adicional a 2hs | `recordatorio_2h` | no | sí |
| Cobro de seña/adelanto al agendar | `deposito_sena` (+ `Clinic.depositPercentage`) | no | sí |
| Seguimiento post-consulta | `seguimiento_post_visita` | no | sí |
| Contacto por próxima cita sugerida (plantilla `proximo_control`) | `contacto_proxima_cita` (+ `Clinic.nextVisitOutreachEnabled`) | no | sí |
| Seguimiento de quienes llegaron por una campaña (plantilla `seguimiento_campana`) | `seguimiento_campanas` (+ `Clinic.campaignFollowUpEnabled`) | no | sí |

**Dos llaves para el contacto por próxima cita y el seguimiento de campañas (2026-11-20):** el plan lo incluye
(`planIncludes(clinic, PLAN_FEATURES.NEXT_VISIT_OUTREACH | CAMPAIGN_FOLLOWUP)`, solo "Plus") **y** el super-admin prendió el interruptor de la
clínica (`nextVisitOutreachEnabled` / `campaignFollowUpEnabled`, apagados por defecto, después de ver la plantilla aprobada en Meta). Son
dos cosas distintas a propósito: el plan es lo contratado; el interruptor es "ya está lista la plantilla en el WABA de ESTA clínica". Sin
alguna de las dos el job no escribe (en el seguimiento de campañas, los contactos igual se cierran por el tiempo). `PUT /platform/clinics/:id`
**rechaza con 409 (`funcionalidad_fuera_del_plan`)** prender un interruptor cuyo plan no lo incluye (apagarlo siempre se puede), la pantalla de la
clínica lo deshabilita con el aviso y el panel de Campañas dice "no está incluido en el plan" (`seguimientoEnPlan`). **Pasar una clínica de Base
a Plus** (desde su membresía) lo habilita sin tocar nada más, pero NO prende el interruptor: sigue apagado hasta que se confirme la plantilla.
Una clínica que ya tenía el interruptor prendido en Base **deja de recibir esos mensajes** al desplegar esto; hay que subirla a Plus.
Para probar el flujo de planes: crear la clínica de pruebas en Base, comprobar que no puede prenderlos, y subirla a Plus.

`jobs/two-hour-reminders.ts` y `jobs/post-visit-followup.ts` chequean
`clinic.plan?.features.includes(PLAN_FEATURES.<X>)`, no un booleano.
Los planes "Base"/"Plus" son `isSystem: true` — no se pueden borrar, y
tampoco un plan con clínicas asignadas (`repositories/plans.repository.ts`
→ `deletePlan`).

## Secretos de la plataforma: su valor y su vencimiento

Algunas integraciones usan un secreto que **vence**. El de la app de
Microsoft (Entra ID) es el caso: cuando pasa su fecha, ninguna clínica puede
conectar su Outlook ni se pueden refrescar las cuentas ya conectadas, y los
turnos dejan de reflejarse allá. Es una falla silenciosa, igual que el worker
apagado, así que se avisa antes.

- **`PlatformSecret` guarda dos cosas independientes:** la fecha de
  vencimiento y, opcionalmente, el VALOR del secreto (cifrado). Se cargan en
  Catálogos → "Secretos"
  (`/platform/catalogs/secrets`, permisos `secretos.ver` / `secretos.editar`,
  `PLATFORM_ONLY_PERMISSIONS`). Los super-admin ya existentes necesitan los
  permisos nuevos: `npm run db:seed` los otorga al rol "Super Admin".
- **El valor guardado manda sobre el `.env`**
  (`services/platform-secrets.ts` → `getPlatformSecretValue()`), y por eso
  renovar el secreto NO requiere reiniciar nada: antes vivía en el `.env`, que
  se lee una sola vez al arrancar, y había que reiniciar el servidor web Y el
  worker. Se recuerda 60 segundos (`SECRET_CACHE_TTL_MS`): guardar uno nuevo
  invalida la caché del proceso que lo guardó, y el otro lo toma a lo sumo un
  minuto después. La variable del `.env` queda de respaldo.
- **El valor es de solo escritura.** Se cifra con AES-256-GCM, con la misma
  clave que los tokens de OAuth (`CALENDAR_TOKEN_ENCRYPTION_KEY`), y ninguna
  respuesta de la API lo devuelve, ni cifrado: se informa si hay uno guardado
  y de dónde sale (`origen`). El filtro está en el repositorio
  (`PlatformSecretRecord` no tiene el campo) y solo
  `getPlatformSecretValue()` descifra. Si se cambia la clave de cifrado, el
  valor guardado ya no se puede leer y se cae al `.env` (con un error en el
  log).
- **Se verifica contra el proveedor ANTES de guardarlo**
  (`verifyMicrosoftClientSecret()`, con `client_credentials`, que no necesita
  cuenta ni permisos): un secreto mal pegado desconectaría a todas las clínicas
  de golpe. Solo `invalid_client` lo rechaza; una falla de red no prueba nada
  sobre el secreto y devuelve 502 sin guardar, y una app sin configurar, 409.
- **"Dejar de seguir" y "quitar el secreto" son acciones separadas.** Dejar de
  seguir el vencimiento no toca el valor (no puede dejar a la integración sin
  secreto); quitar el valor no toca el vencimiento, y se rechaza si no hay
  variable del `.env` que lo respalde (`?forzar=true` lo permite). La fila se
  borra cuando no queda ninguna de las dos cosas.
- **El catálogo de secretos vive en el código** (`config/tracked-secrets.ts`),
  no en la base: cada entrada trae qué se rompe y los pasos para renovarlo,
  que viajan en el mail. Sumar un secreto es una entrada más ahí.
- **`jobs/secret-expiry-alerts.ts`** manda un mail a los administradores de la
  plataforma (usuarios activos con `clinicId: null`) **todos los días desde 7
  días antes, y también después de vencido**: el aviso no se apaga solo
  cuando el secreto deja de servir sino cuando alguien registra la fecha del
  nuevo (eso borra `lastReminderOn`). Corre cada hora entre las 8 y las 18 y
  `lastReminderOn` evita repetirlo en el día: así un SMTP caído a las 8 se
  reintenta a las 9 en vez de perderse hasta mañana.
- **Solo se marca como avisado si el mail salió.** Y si no hay ningún
  administrador activo a quien avisar, no se manda ni se marca y se loguea
  como error: es un aviso que nadie va a leer.
- **El "hoy" sale de `PLATFORM_TIMEZONE`** (default UTC), no de la hora del
  servidor. Las reglas (`services/secret-expiry.ts`) trabajan con fechas de
  calendario y rechazan los días imposibles (`2027-02-31`) y los vencimientos
  a más de 3 años, que casi seguro son un typo y apagarían los avisos.
- **Banner para el super-admin, no para la clínica**
  (`SecretExpiryBanner` en `BannerStack.tsx`). El secreto es de la plataforma:
  una clínica no puede renovarlo y el aviso solo la alarmaría; a ella le llega
  la consecuencia que sí entiende (su cuenta de Outlook figura revocada). Sale
  con 7 días o menos y vencido, **no se puede cerrar** (un aviso que se
  descarta una vez y no vuelve es justo lo que no sirve acá), y se va al
  registrar la fecha nueva. No avisa los "Sin registrar": serían un banner
  eterno aun en una plataforma que no usa Outlook.
- **Sin fecha registrada no hay aviso posible.** La pantalla lo marca como
  "Sin registrar": hay que cargar la fecha al crear el secreto en Entra ID.

## Cuánto paga cada clínica

Dos cosas distintas y separadas a propósito: el **precio de lista** de un
plan (lo que se le va a ofrecer a una clínica nueva) y la **membresía** de
una clínica concreta (lo que efectivamente paga).

### Precios de lista: `PlanPrice`

**El plan es global y el precio es por país.** No se crean planes "Base
Argentina" y "Base México" — eso duplicaría el catálogo y las features
derivarían entre sí. Un plan, N precios: `PlanPrice` es
`(planId, countryId, billingPeriod) → amount`, con un único por esa terna.
No lleva moneda: es el precio vigente, y la moneda sale de
`Country.currency`.

Se cargan desde "Planes" (`/platform/catalogs/plans` → botón "Precios"), en
una grilla de un país por fila y una columna por periodicidad
(`services/plan-prices.ts` → `buildPriceGrid()`, presentación pura).

- **Una celda vacía es `null` y no un cero.** Cero no es un precio: para no
  cobrarle a una clínica está la modalidad "exonerada". Un CHECK impone
  `amount > 0`, y vaciar la celda **borra** el precio.
- Se listan **los países activos, más los inactivos que ya tengan precio**
  — si no, desactivar un país haría desaparecer un precio sin explicación.
  Estrenar un precio en un país desactivado sí se rechaza.
- Borrar un precio **no se bloquea** aunque haya clínicas en ese plan y
  país: ya tienen el monto copiado, así que no les cambia nada. Lo único
  que se pierde es la referencia, y se informa cuántas quedaron sin ella.

### La membresía de una clínica

**El precio de lista se COPIA, no se referencia.** Al fijarle la membresía
a una clínica se guarda el monto en `Clinic.membershipCost` y desde ese
momento son independientes: un aumento de la lista no mueve a nadie que ya
esté. Eso es lo que evita pisarle el precio a alguien con quien se negoció,
y hace que no haga falta ningún job que se acuerde de no tocarlos.
`Clinic.membershipCurrency` se congela por el mismo motivo — la moneda de
un país se puede editar y un acuerdo viejo no puede cambiar de significado
solo. Si dejan de coincidir, la pantalla lo avisa (`currencyMismatch`).

`Clinic.membershipPricing` (enum `MembershipPricing`) es con qué criterio
se le cobra, y **`null` es un estado propio**: "todavía no le pusimos
precio", distinto de exonerada. Antes las dos cosas eran un costo en null y
no se podían distinguir — el mismo problema que `SIN_HORARIO` y
`SIN_SEGUROS`.

- `lista` — paga el precio de lista que regía cuando se le fijó. El monto
  lo copia el backend: el cliente **no** manda monto, si no habría dos
  fuentes para el mismo número.
- `especial` — precio negociado. Exige **motivo**.
- `exonerada` — no se le cobra. **Conserva el plan y sus
  funcionalidades**: los jobs filtran por `clinic.plan?.features`, así que
  sacarle el plan le apagaría los recordatorios de 2hs y el seguimiento
  post-visita. Exige motivo y no tiene monto ni periodicidad.

**Las combinaciones válidas las impone también un CHECK** (en la migración,
no en Prisma, que no los modela): nada de exonerada con monto, precio sin
moneda o sin periodicidad, ni exoneración sin motivo.

`MembershipPriceChange` es el historial, append-only y escrito **en la
misma transacción** que el cambio, con quién lo hizo y el motivo. Es la
tabla más barata del diseño y la única imposible de rellenar después: el día
1 alguien pregunta por qué una clínica paga 2.500 y la de al lado 3.000.

Tres cosas que no son obvias:

- **La membresía tiene endpoint propio** (`GET/PUT
  /platform/clinics/:id/membership`) y **no viaja en el `PUT` general de la
  clínica**, que la rechaza explícitamente si viene. Sus reglas son cruzadas
  (modalidad ↔ monto ↔ moneda ↔ motivo ↔ periodicidad ↔ país ↔ existencia de
  precio de lista), y un rechazo por el motivo faltante no puede bloquear el
  guardado de la dirección. En el detalle de la clínica es su propia tarjeta
  con su propio botón, mismo criterio que los títulos habilitados.
- **El plan es parte de la membresía**, no un campo suelto: se escribe solo
  por ese endpoint. `pricing: null` **con** `planId` es "tiene plan y
  todavía no le pusimos precio" —el estado en que nace toda clínica, porque
  el alta la crea en "Base"—, y sin `planId` es "ni plan ni precio". Si el
  único `null` posible borrara el plan, sacarle el precio a una clínica le
  apagaría de paso lo que tiene contratado.
- **`listPriceStatus` nunca devuelve un null mudo.** Dice POR QUÉ no hay
  precio de lista con el que comparar (`sin_plan`, `sin_pais`,
  `sin_periodicidad`, `no_cargado`), que es la diferencia entre una pantalla
  que explica y un admin adivinando. Y `listaCambiadaDespues` avisa que la
  lista se movió después de fijarle el suyo, sin cambiarle nada.

## Agenda: la vista de citas

Dos pantallas distintas, y el nombre importa porque se confunden:

- **"Agenda"** (`/calendar`) — la vista de citas. Vista **día** con una
  columna por profesional, y vista **semana** con un profesional y siete
  columnas.
- **"Calendarios"** (`/calendars`) — la integración con Google:
  qué cuenta está conectada y a qué calendario se espeja cada profesional.
  No muestra ninguna cita.

**Está pensado para cuando una clínica tenga sucursales**, que todavía no
existen en el modelo:

- `CalendarGrid` **no sabe qué representan sus columnas**. Recibe columnas
  con citas y las ubica por hora. Hoy son profesionales (día) o días
  (semana); mañana pueden ser sucursales, sin tocar el componente.
- El endpoint filtra por `professionalIds` (**plural**), no por un
  profesional suelto: elegir una sucursal se va a traducir a "los
  profesionales de esa sucursal" sin cambiar la firma. Por lo mismo devuelve
  el espacio de cada cita, que es el otro eje por el que se va a agrupar.

`GET /dashboard/clinics/:id/calendar?desde=&hasta=&professionalIds=` es
aparte del buscador a propósito: el buscador devuelve las 50 más recientes
en orden descendente —sirve para encontrar UNA cita— y una agenda necesita
**todas** las del rango en orden cronológico, porque una que falte es un
hueco que no existe.

Tres detalles que no son obvios:

- **El rango se convierte con la zona de la clínica.** "El día 15" son las
  24 horas del 15 en hora local: con `new Date("2026-09-15")` arrancaría a
  las 18:00 del 14 en México y la agenda mostraría la tarde anterior.
- **Las citas se posicionan en píxeles calculados desde los minutos**, no
  con filas de tabla: una cita de 15' tiene que ocupar un cuarto de la
  altura de una hora.
- **Los límites de la grilla salen de `WorkingHours`.** Una agenda que
  arranca a las 00:00 son doce pantallas de nada antes de la primera cita. **Pero se estiran para abarcar las citas y
  los bloqueos con hora del rango** (`services/agenda-grid.ts` → `gridLimits()`, redondeando a la hora): la Agenda deja guardar una cita
  fuera del horario confirmando (regla blanda), y si la grilla se quedaba en el horario de la clínica esa cita se guardaba y NO se veía
  (pasó el 2026-11-23). Los bloqueos de día completo no estiran nada; lo que cruza la medianoche se corta en las 24:00.
- **Lo cerrado se pinta rayado**, y sale de `getEffectiveIntervalsForRange()`
  — la MISMA función que valida los turnos, con el horario semanal, las
  excepciones por fecha y la herencia ya resueltos. Cubre el hueco del
  mediodía, lo de antes de abrir y de después de cerrar, y el día entero
  cuando es feriado, con el motivo de la excepción como rótulo ("DÍA DE LA
  INDEPENDENCIA"). Si se calculara aparte, tarde o temprano mostraría
  abierto un rato en el que `booking.ts` rechaza. El complemento lo arma
  `frontend/src/lib/closed-bands.ts`, aparte del componente para poder
  testearlo con el runner del backend. En la vista Semana con "Todos" los
  profesionales se **unen** los horarios de todos (`unirDisponibilidades()`):
  el día se pinta cerrado solo si NADIE atiende (un feriado de la clínica), no
  por la vacación de uno solo. Antes, con "Todos", la grilla no pintaba nada.

## Filtros del buscador de turnos

La pantalla "Turnos" filtra por texto (`q`), rango de fechas, **estado,
servicio, profesional y espacio**. Las opciones de los tres últimos salen de
`GET /dashboard/clinics/:id/appointments/filters`.

Dos decisiones que no son obvias:

- **El servicio se filtra por nombre (`Appointment.service`), no por
  `serviceId`.** Ese campo es null en los turnos que no matchearon el
  catálogo o que se crearon antes de que la clínica lo cargara, y esos
  turnos existen igual. `service` siempre tiene el nombre, y cuando hubo
  match es exactamente el del catálogo, así que una sola condición cubre los
  dos casos. Por lo mismo, el desplegable se arma con los servicios que la
  clínica **realmente tiene en sus turnos** (`distinct`), no con el catálogo:
  así toda opción de la lista devuelve al menos un resultado.
- **No hay filtro aparte por apellido.** `q` busca por coincidencia parcial en
  `Patient.name` (el nombre completo), así que escribir el apellido ahí funciona.
  Desde el 2026-11-13 existen `firstName` / `lastName`, pero `name` sigue siendo
  el dato canónico y el que busca este filtro: ver "Pacientes".
- **`desde` y `hasta` son días de pared de la clínica**, igual que en la
  Agenda, y `hasta` incluye el día entero (se convierte a la medianoche del
  siguiente y se compara con `lt`). Con `new Date("2026-09-15")` el corte
  quedaba en la medianoche UTC —las 18:00 del 14 en México— y buscar "hasta
  el 15" no devolvía ninguna cita del 15.

## Monitoreo: ver la salud del sistema (solo super-admin)

Casi todas las fallas de la plataforma eran silenciosas: un worker apagado, un
cron que revienta, un mensaje que muere antes de contestarse (el paciente queda
en visto y el lote ya no está en la cola, así que nada lo rescata), un WhatsApp
que Meta rechaza. Lo único que dejaban era una línea de log. La pantalla
**"Monitoreo"** (`/platform/monitoring`, permiso `monitoreo.ver`, que es
`PLATFORM_ONLY_PERMISSIONS`; `npm run db:seed` se lo da al "Super Admin") junta
eso en un lugar. Es un ítem suelto del menú y no está en Catálogos: se mira
seguido, no se carga una vez.

Tres piezas, todas en Postgres:

- **`SystemEvent`** (`services/system-events.ts` → `recordSystemEvent()`): qué
  salió mal, de qué clínica y con qué mensaje. Los tipos son claves de
  `SYSTEM_EVENT_KINDS` (texto y no enum: sumar uno no migra). Hoy se registra:
  falla del modelo (el primer intento como `warning`, los dos como `error`),
  mensaje que murió en el webhook (`mensaje_sin_procesar`, que cubre los fallos
  de la base antes de llamar a Claude), error de un cron (también los de cada
  clínica, con `reportJobError()`) y envíos de WhatsApp fallidos de avisos al
  paciente, al profesional y de configuración.
  **`recordSystemEvent()` nunca lanza** (se llama desde el camino de error de
  algo que ya falló) y **no recibe el texto del paciente ni su teléfono**:
  solo clínica, tipo y error. No tiene FK a `Clinic` a propósito. Se limpia
  solo a los 30 días (`jobs/system-events-cleanup.ts`).
- **`CronHeartbeat`**: `trackedCron()` anota cuándo arrancó y terminó cada
  corrida y su error. `config/monitored-jobs.ts` es el catálogo de tareas con
  `maxGapMs`: **el hueco más largo que es normal**, no la frecuencia (una tarea
  "cada hora de 8 a 18" descansa 14 horas de noche y eso no es una falla). Se
  considera atrasada pasado `maxGapMs × 1,5 + 2 min` (`isJobStale()`). El
  worker figura vivo si `inbound-sweeper` (corre cada minuto) está al día. Al
  sumar un cron: programarlo con `trackedCron("nombre", …)` y agregarlo a
  `MONITORED_JOBS`; si el nombre no coincide, la pantalla dice "nunca corrió".
  El latido dice "corrió", no "todo salió perfecto": lo que un job atrapa por
  clínica llega como evento, no como estado de la tarea.
- **`services/monitoring.ts`** arma lo que lee la API
  (`GET /platform/monitoring` y `.../monitoring/events`, con filtros por
  clínica y tipo y paginación por cursor `before`): worker, tareas, cola de
  `PendingInboundMessage` (con los abandonados, los que pasaron
  `ABANDONED_AFTER_MS`), derivaciones sin avisar (`notifiedByEmail: false` sin
  resolver), errores de 24 h por tipo y por clínica, y el último mensaje de
  paciente de cada clínica (para notar una que dejó de recibir).

**No llama a Meta, Google ni Anthropic**: una pantalla de monitoreo que se
cuelga cuando una de esas APIs anda mal no sirve justo cuando hace falta. Por
eso el estado de las plantillas de WhatsApp por clínica **no está** acá: sigue
en `GET /platform/clinics/:id/whatsapp/templates`. La pantalla se refresca sola
cada 30 s.

**Lo que NO cubre:** que el proceso web esté caído (si no responde, tampoco
responde esta pantalla: hace falta un monitor externo que le pegue al servidor),
ni avisar de forma activa (es una pantalla que hay que mirar; mandar un mail o
WhatsApp al super-admin cuando algo se atrasa es el siguiente paso natural), ni
un worker que murió dentro de una corrida (se ve como atrasada recién pasado el
margen).

## Costos: cuánto consume y cuesta cada clínica (solo super-admin)

La pantalla **"Costos"** (`/platform/costs`, permisos `costos.ver` / `costos.editar`, `PLATFORM_ONLY_PERMISSIONS`; `npm run db:seed`
se los da al "Super Admin") mide lo que gasta cada clínica y la plataforma en el modelo de IA, WhatsApp y las integraciones
(2026-11-19). Todo en `services/costs.ts`; las rutas son `GET /platform/costs/{summary,conversations,inventory,rates}` y
`PUT/DELETE .../costs/{rates,fx-rates}`. Cuatro pestañas: resumen (global o de una clínica con `clinicId`), por conversación, inventario y tarifas.

- **El costo se congela al ocurrir** el evento con la tarifa vigente de ese momento (`CostRate`, con `effectiveFrom`): un cambio de
  tarifa no reescribe el pasado (mismo criterio que la membresía copia el precio de lista). **Sin tarifa el costo es `null` y la pantalla
  dice "sin tarifa"**, y no se suma como cero: un cero haría creer que algo es gratis. **Lo gratis por definición** (Calendar, Graph, el
  texto libre de WhatsApp dentro de la ventana de 24 h) cuesta 0. Las tarifas **las carga el super-admin** desde la tarifa vigente de cada
  proveedor: el código no trae precios (arrancan vacías).
- **Qué se registra y dónde** (`config/cost-catalog.ts` es el inventario; sumar una integración = una entrada ahí + su punto de registro):
  - **Modelo de IA**: `AgentRequest.costUsd` se calcula en `recordAgentRequest()` desde los tokens (entrada, salida, caché) y las tarifas
    `<modelo>:input|output|cache_read|cache_creation`. Sin tarifa de entrada o de salida, null; si faltan las de caché se usa la de entrada.
  - **WhatsApp**: `sendTemplateMessage()` / `sendTextMessage()` registran un `UsageEvent` **solo si el envío salió** (Meta no cobra el
    rechazado). El `clinicId` y el país viajan en `ClinicWhatsAppCreds`, que sale de `clinicWhatsAppCreds(clinic)`: **por eso ningún envío
    se hace sin dejar rastro y no hubo que tocar a cada llamador**. La clínica que se le pasa tiene que traer `id` y `country`.
    Tarifas `whatsapp:<categoría>:<PAÍS>` o `whatsapp:<categoría>:*`. Todas las plantillas del catálogo se crean como Utilidad, así que se
    registran como `utility`: **si Meta reclasifica una a Marketing, lo facturado difiere de lo registrado**. Meta cobra por mensaje de
    plantilla según categoría y país; verificar la tarifa vigente de Meta antes de cargarla.
  - **Google Places** (`google-places.ts`) y **crear/borrar el evento espejo** de Calendar o Outlook (`calendar.ts`): un `UsageEvent` por llamada.
    Calendar y Graph son gratis (se cuenta el volumen); los de Calendar van con `clinicId` null (el despachador no conoce la clínica).
  - **No se registra** el sync de bloqueos (cada 15 minutos por calendario, gratis): una fila por lectura no diría nada útil.
- **Cómo se muestra lo que no tiene tarifa** (`frontend/src/lib/cost-display.ts` → `mostrarCosto()`, 2026-11-23): el backend no suma lo que no
  tiene tarifa, así que un consumo SIN ninguna llegaba como `0` y la pantalla mostraba "US$ 0,00" (127 llamadas y 245.202 tokens figuraban gratis
  porque no había tarifas cargadas). Ahora: todo sin tarifa → **"Sin tarifa"** (en rojo); una parte → "US$ 0,12 + 40 sin tarifa"; nada sin tarifa → el costo.
  Vale en las tarjetas, por clínica, por día y por conversación. **Las tarifas rigen desde su `effectiveFrom` y NO recalculan lo ya registrado**: el consumo
  anterior a cargar las tarifas queda "sin tarifa" para siempre (no hay recálculo retroactivo; sería un script que rellene `costUsd` null con la tarifa
  vigente en cada fecha). **Cargar las tarifas ANTES del piloto con tráfico real.**
- **Tarifas del modelo cargadas (2026-11-23, solo en la base de desarrollo):** `claude-sonnet-5` desde 2026-09-01, USD por millón de tokens: entrada 2, salida 10,
  lectura de caché 0,20 y escritura de caché de 5 min 2,50 (la que usa el asistente), tomadas de https://platform.claude.com/docs/en/about-claude/pricing. **Hay que
  cargarlas también en cada ambiente nuevo** (Costos → Tarifas) y **volver a cargarlas si Anthropic cambia el precio o si se cambia el modelo** (`services/claude.ts`):
  la clave lleva el nombre del modelo, y un modelo nuevo vuelve a quedar "sin tarifa". Nadie vigila los precios solos: hay que revisarlos de vez en cuando.
  Las de WhatsApp (por categoría y país, ej. `whatsapp:utility:MX`) siguen sin cargar.
- **Solo metadatos**: ni teléfono, ni nombre, ni texto. La "conversación" es el titular (`patientId`) por día, mostrado con los últimos 6
  caracteres de la ficha. Las llamadas del **Chat de pruebas** cuestan de verdad y se muestran **aparte** (no suman al total).
  `recordUsageEvent()` y `recordWhatsAppSend()` **nunca lanzan**: se llaman después de hacer lo que miden.
- **Moneda**: se muestra en USD y, si hay un tipo de cambio cargado (`FxRate`, manual) para la moneda del país de la clínica, también en local.
  Las cifras locales dependen de ese valor y de su fecha; los USD no.
- **Retención**: `UsageEvent` 400 días (`USAGE_RETENTION_DAYS`, la limpia `jobs/system-events-cleanup.ts`); se borra con la clínica.
- **Escribir tarifas queda auditado** (`platform.cost_rate_set`, etc.). Leer no es dato sensible (no hay teléfonos ni nombres).

**Lo que no cubre (pendiente):** costos fijos manuales (servidor, base de datos, dominio, correo) para el costo operativo total; topes de
mensajes por plan con cobro de excedente (el conteo de mensajes por clínica y por día ya está, falta el límite en `Plan`); conciliar con la
facturación real de Meta (hoy es una estimación con la tarifa que se cargó); atribuir a una clínica el espejo de Calendar; y que la pantalla
no tiene tests (las reglas sí: `tests/costs.test.ts`).

## El menú y el buscador (2026-11-20)

El menú lateral ya no es una lista plana: está **agrupado por frecuencia de uso**, con lo que se hace todos los días arriba y a la vista y lo
que se configura una vez plegado más abajo. Todo sale de `frontend/src/components/shell/nav-items.ts`, que sigue siendo la fuente única del
Sidebar, el menú móvil y el buscador (los tres filtran con el MISMO `filterNavItems()`, así que ven siempre lo mismo):

- **Secciones, en orden** (`NAV_GROUPS`): **Plataforma** (super-admin: Clínicas, Crear clínica, Monitoreo, Costos), **Día a día** (Agenda, Citas, Pacientes, Por
  atender, Conversaciones), **Seguimiento y resultados** (Paquetes, Campañas, Reportes), **Configuración de la clínica** (Servicios, Recursos,
  Horarios, Feriados, Seguros, Calendarios, Configuración, Chat de pruebas; plegada), **Accesos** (Usuarios, Roles; plegada) y **Sistema**
  (Catálogos, Auditoría; plegada, al fondo). Una sección sin ningún ítem visible para el usuario no se dibuja (`groupNavItems()`).
- **Una pantalla nueva** es una entrada en `NAV_ITEMS` con su `group` (dónde vive) y sus `keywords` (cómo la llamaría alguien que no sabe cómo
  se llama: "horario de comida", "precio", "obra social"). Rutas y permisos no cambiaron.
- **Un solo ítem activo**: `activeHref()` elige el más específico (en `/platform/clinics/new` se enciende "Crear clínica" y no también "Clínicas").
- **Plegado**: las secciones de configuración arrancan plegadas; entrar a una pantalla de una sección plegada la abre sola; lo que la persona
  abre o cierra se recuerda en `localStorage` (`nav-state.ts`, siempre dentro de try/catch). Con el sidebar reducido a íconos no hay títulos ni plegado.
- **Buscador**: un campo "Buscar…  ⌘K" arriba del menú (`SearchTrigger`; solo la lupa con el menú reducido y en la barra móvil) que abre la MISMA
  paleta de comandos que ya existía y nadie descubría (`CommandPalette`, también con ⌘K / Ctrl+K). Busca por título y por `keywords`, muestra los
  resultados con las mismas secciones del menú, y con el campo vacío ofrece las últimas 5 pantallas visitadas. **Solo ofrece pantallas**: buscar
  personas o citas exige decidir qué datos de pacientes se muestran en un buscador global (y auditarlo).
- Los tests de esto están en `frontend/src/components/shell/nav-items.test.ts` y **se corren con el vitest del frontend** (`cd frontend && npx vitest
  run`), no con `npm test` de la raíz (que solo incluye `tests/`). La pantalla en sí no tiene tests.
- **Siguiente paso posible:** una insignia con la cantidad de pendientes en "Por atender", y acciones directas en el buscador ("Nueva cita"),
  que necesitan enlaces profundos que hoy no existen.

## Panel de plataforma (solo super-admin)

Las pantallas de plataforma no son de una clínica: son visibles solo para un
usuario con `clinicId: null` (`NavItem.superadminOnly` en
`frontend/src/components/shell/nav-items.ts`) y su API está montada bajo
`/platform` en el backend (`src/routes/platform.ts`,
`platformRouter.use(authenticate, requireSuperAdmin)`).

En el menú son **dos** ítems, y la división no es arbitraria:

- **"Clínicas"** va suelta. Es la única operativa del lote: es la puerta de
  entrada a "entrar a una clínica", que es como el super-admin hace todo lo
  demás, y tanto el banner ("Volver a Clínicas") como el cartel de "elegí una
  clínica" mandan de vuelta ahí. Un click de más se pagaría seguido.
- **"Catálogos"** agrupa a los otros cuatro en una portada con tarjetas
  (`CatalogsHubPage`, `/platform/catalogs`). Son cosas que se cargan una vez
  y se tocan cada tanto, que es lo que puede permitirse estar a dos clicks.
  Sueltas eran cinco de los diecinueve ítems del menú.

Tres cosas que no son obvias:

- **Los catálogos cuelgan de `/platform/catalogs/...`, un nivel más abajo que
  Clínicas.** No es cosmético: `isActiveRoute()` mira el prefijo, así que si
  colgaran de `/platform` a secas, "Catálogos" se marcaría activo también
  estando en Clínicas. (En el browser son `/app/platform/...`, porque el
  router tiene `basename="/app"` — no chocan con la API, que vive en
  `/platform`.)
- **Cada tarjeta sigue siendo una opción con su permiso.** La portada filtra
  `CATALOG_ITEMS` con el MISMO `filterNavItems()` que el menú: un usuario de
  plataforma sin `paises.ver` no ve la tarjeta de Países. Si se filtrara
  aparte, tarde o temprano la grilla mostraría algo que el menú escondía.
- **La paleta de comandos (⌘K) los sigue listando todos**, en su propia
  sección: agrupar acorta el menú, pero no tiene por qué dejar Países a dos
  clicks.

Las pantallas:

- **Países** (`/platform/catalogs/countries`) — catálogo de países y sus feriados (ver
  arriba).
- **Planes** (`/platform/catalogs/plans`) — catálogo de planes y qué funcionalidades
  incluye cada uno (ver "Planes" arriba), y por plan una grilla con su
  **precio de lista** en cada país (ver "Cuánto paga cada clínica").
- **Títulos** (`/platform/catalogs/titles`) — catálogo global de títulos de
  profesional, y desde el detalle de cada clínica se elige con cuáles trabaja
  (ver "El título del profesional" arriba).
- **Seguros** (`/platform/catalogs/insurers`) — las obras sociales y prepagas que
  existen en la plataforma. Ojo: la pantalla "Seguros" del menú de una
  clínica (`/insurers`) es otra cosa —con cuáles trabaja ESA clínica— y la
  administra la clínica. Las separa el contexto, igual que "Agenda" y
  "Calendarios".
- **Clínicas** (`/platform/clinics` solo el listado con el botón "Crear clínica", `/platform/clinics/new` el alta en su propia
  pantalla —antes el formulario vivía arriba del listado y la hacía larguísima; al crear lleva al detalle—, `/platform/clinics/:id` detalle) — alta de
  clínicas nuevas (antes solo posible por script o llamando la API a
  mano) y edición de sus datos: general (nombre, zona horaria, país,
  activa), contacto (teléfono, email, sitio web — este último pensado
  como contexto para que el agente lo cite en la conversación), redes
  sociales (Facebook/Instagram/TikTok, solo el link de referencia — sin
  credenciales; son la base para cuando esos canales existan, hoy solo
  WhatsApp), facturación (razón social, CUIT/RFC, dirección, email — texto
  libre, el formato del identificador fiscal varía por país). También
  `address` y `googleBusinessUrl`. La **membresía** (plan + qué paga) está
  en el mismo detalle pero en su propia tarjeta, con su propio endpoint —
  ver "Cuánto paga cada clínica" más arriba; el `PUT` general rechaza esos
  campos si los recibe. El
  horario NO se edita acá — es `WorkingHours`, y se carga en la pantalla
  "Horarios". La zona
  horaria (`Clinic.timezone`) es un selector, no texto libre — depende del
  país elegido y lista `Country.timezones` (ver más abajo), para que un
  typo no rompa la validación de turnos.

**Traer datos desde el link de Google de la clínica** (`services/
google-places.ts`): un botón — tanto en el alta ("Nueva clínica") como en
el detalle de una clínica ya creada — sugiere nombre, dirección,
teléfono, sitio web, **horario**, país y zona horaria a partir de un link
de Google (Maps o un link corto "share.google") —

El horario viene de `regularOpeningHours.periods` y no de
`weekdayDescriptions`: los periods son dato estructurado (día + hora +
minuto), así que no hay que parsear "Monday: 10:00 AM – 7:00 PM" en un
idioma que además cambia con el locale de la consulta.
`services/google-hours.ts` los convierte a tramos de `WorkingHours` — y el
corte del mediodía sale gratis, porque Google ya lo manda como dos periods
del mismo día, que es exactamente cómo lo modela `WorkingHours`. Se
descartan los que no se pueden representar: sin cierre (abierto 24hs) y los
que cruzan la medianoche. En el alta se muestran para revisar y se crean
junto con la clínica (`workingHours` en el body de `POST /platform/clinics`);
después se editan en "Horarios", que es la pantalla con el editor real.

`POST /platform/google-business/preview` (no cuelga de un `:id`: no hace
falta que la clínica exista todavía, lo usan los dos formularios). Como
los feriados, **es una sugerencia que prellena el formulario, nunca
escribe la clínica sola**: el admin revisa y recién ahí crea
(`POST /clinics`) o guarda (`PUT /clinics/:id`). Requiere
`GOOGLE_PLACES_API_KEY` (Places API "New", proyecto de Google Cloud con
facturación activa — variable opcional, sin ella el botón devuelve un
error explícito en vez de romper el resto de la pantalla). Un link corto
de Google no trae el `place_id` que pide la API (codifica un CID o
`kgmid` interno, sin conversión pública): se sigue el redirect hasta la
URL final, que puede ser un lugar de Maps
(`.../maps/place/<Nombre>/@<lat>,<lng>`) o una ficha del buscador
(`google.com/search?...&q=<Nombre>`, sin coordenadas), se le saca el
nombre del negocio, y con eso se busca el `place_id` real vía "Text
Search". El país (`addressComponents`, el de `types: ["country"]`) y la
zona horaria (`timeZone.id`, directo de Google — no hace falta inferirla
de la ciudad) salen del mismo `Place Details`. El país solo se completa
si coincide con uno ya cargado en "Países"; si no, se deja como estaba.

Los selectores de "País" y "Zona horaria" en estas pantallas necesitaron
dos ajustes puntuales a Radix Select para poder prellenarse así — ver
"gotcha" en la sección del selector de zona horaria, un poco más abajo:
pasarle el texto como hijo explícito de `SelectValue` (si no, no muestra
un valor seteado por código hasta que el usuario abre ese dropdown), e
ignorar en el `onValueChange` los llamados con `v === ""` (Radix los
dispara solo, sin que nadie haya elegido nada, cuando el valor todavía no
matchea ningún `SelectItem` montado — y ningún país o zona real tiene id
vacío).

**"Entrar a esta clínica"**: el horario, los usuarios y las métricas de
una clínica elegida NO se ven en una pantalla nueva — se reusan Horarios/
Usuarios/Reportes/Turnos/etc. tal cual las usa un admin de clínica. El
botón en el detalle de una clínica llama `setViewingClinic({id, name})`
(`frontend/src/auth/AuthContext.tsx`), muestra un aviso breve que se cierra solo ("Estás dentro de X") y navega a la
**Agenda** (`/calendar`, antes `/appointments`: es lo primero de "Día a día"); la franja de arriba sigue diciendo en qué clínica se está. Todas
las pantallas por clínica resuelven su `clinicId` con
`useEffectiveClinicId()` (`user.clinicId ?? viewingClinic?.id ?? null`) en
vez de `user.clinicId` directo, así les sirve tanto a un admin de clínica
como a un super-admin de visita. El backend no necesitó ningún cambio para
esto: `middleware/authorize.ts` → `requirePermission()` ya deja pasar
cualquier `:clinicId` cuando `user.clinicId === null`. `BannerStack.tsx`
muestra el nombre de la clínica que se está viendo y un botón "Volver a
Clínicas" que limpia `viewingClinic` (persistido en `sessionStorage`, se
limpia también al hacer logout).

## Primera vez: el servicio de primera vez

Caso real de la clínica dental piloto, generalizado a cualquier rubro: un
solo profesional (o unos pocos) recibe y evalúa a los clientes/pacientes nuevos.

**Se modela como dato del catálogo, no como regla aparte.** La clínica marca un
servicio como `Service.firstVisit` (uno solo por clínica) y se lo asigna a quienes
lo hacen; ver "Qué profesional realiza qué servicio". La regla vieja
(`Clinic.firstVisitToLeadProfessionalEnabled` + `leadProfessionalId`) se retiró el
2026-11-10: eran dos fuentes para la misma decisión. La migración
`retire_lead_professional_rule` **frena** si alguna clínica todavía depende de
ella (activada y sin servicio de primera vez): hay que marcar el servicio y
asignarlo antes de migrar. No migra datos sola porque crear un servicio es una
decisión de la clínica.

- `services/catalog.ts` → `resolveServiceForRequest()` impone el servicio y
  devuelve `allowedProfessionalIds`; `resolveProfessionalForBooking()` solo
  elige entre esos habilitados. "Primera vez" = la persona no tiene ningún
  `Appointment` registrado, ni siquiera cancelado (`isFirstTimePatient`).
- Las urgencias NO pasan por esta regla.
- El system prompt recibe `esPrimeraVez` (del número) y `servicioPrimeraVez`.
- Sin servicio marcado, el paciente nuevo pide lo que quiera: no hay profesional
  forzado.

## Los mensajes seguidos se contestan juntos

La gente parte una idea en varios mensajes ("Agendar la cita" / "Para
mañana"). Contestando uno por uno el paciente recibe dos respuestas a una
sola pregunta y, peor, ninguna ve a la otra: cada turno lee el historial al
empezar y lo escribe al terminar, así que el segundo contesta como si el
primero no hubiera existido. Pasó en la prueba del 2026-09-14 y se ve como
un bot con amnesia.

Por eso el webhook **no contesta el mensaje que recibe**. Lo encola en
`PendingInboundMessage`, espera `DEBOUNCE_MS` (5s) y recién ahí intenta
llevarse todos los pendientes de esa conversación
(`services/inbound-queue.ts`).

- El intento solo tiene éxito **si en esos segundos no llegó nada nuevo**.
  Si el paciente siguió escribiendo, se va con las manos vacías y el que
  junta el lote completo es el intento del último mensaje. La ventana se
  estira mientras escribe, en vez de cortar cada N segundos.
- La comparación es **contra el `receivedAt` del mensaje propio**
  (`notNewerThan`), no contra `ahora - DEBOUNCE_MS`. Con el corte calculado
  en Node, y `receivedAt` puesto por Postgres, los dos valores caían a menos
  de un milisegundo —el intento despierta exactamente `DEBOUNCE_MS` después
  de encolar— y **el mensaje se veía a sí mismo como más nuevo que el
  corte**: se abstenía creyendo que el paciente seguía escribiendo, y como
  nadie más iba a despertar, quedaba encolado sin respuesta para siempre.
  Salía o no según la imprecisión del `setTimeout`, así que fallaba una de
  cada tantas veces (pasó el 2026-09-14 con un "hola" suelto). Comparado
  contra el mensaje propio no depende de ningún reloj: si nada llegó después
  del mío, soy el último y me lo llevo. La espera la hace el llamador con su
  `sleep`; la función solo decide **a quién le toca**.
- `MAX_WAIT_MS` (30s) es el tope: quien escribe sin parar recibe respuesta
  igual, si no la ventana no cerraría nunca.
- Los mensajes del lote se le pasan al modelo como **un solo mensaje del
  paciente**, separados por saltos de línea, y así quedan en el historial.

**El buffer está en Postgres y no en memoria porque el servidor web corre
en N instancias.** Dos mensajes seguidos pueden caer en instancias
distintas, y el temporizador de una no ve el buffer de la otra: cada una
contestaría por su lado, que es el problema que esto viene a resolver.

`claimConversationBatch()` es un **`DELETE ... RETURNING`**: en una sola
sentencia decide y borra, así que de dos instancias que lo intenten a la
vez, una se lleva las filas y la otra recibe cero. No hace falta un lock —
la fila es el testigo, y como se borra no puede procesarse dos veces. **No
usar un advisory lock de sesión acá**: Prisma toma una conexión distinta
del pool en cada query, así que el `unlock` correría en otra conexión que
el `lock` y quedaría colgado.

La espera vive en el proceso web, así que si la instancia se cae o la matan
en medio —un deploy con rolling restart lo hace de rutina— las filas quedan
sin dueño. De eso se ocupa `jobs/inbound-sweeper.ts`, que cada minuto
rescata los pendientes de más de 2 minutos. Es **recuperación, no el camino
principal**: con el worker apagado los pacientes se siguen atendiendo. Ese
umbral tiene que ser bastante mayor que `DEBOUNCE_MS + MAX_WAIT_MS`, o el
barrido le robaría el lote a un webhook que todavía está esperando y la
respuesta saldría partida.

## Cómo se ofrecen horarios: dos llamadas a Claude por mensaje

`services/agent-turn.ts` → `runAgentTurn()` es un turno de conversación
completo. El webhook solo rutea: identifica la clínica y delega.

Cuando la primera interpretación marca `requiere_horarios_disponibles`, se
consulta la agenda y se vuelve a llamar a Claude con los huecos reales para
que redacte la respuesta final. Sin esa segunda llamada, el bot promete
"dejame consultar la disponibilidad" y la conversación muere ahí.

**El enumerador nunca es el portero.** `availability-slots.ts` →
`findAvailableSlots()` ofrece; `checkAvailability()` dentro de la transacción
serializable de `booking.ts` es quien decide. Por eso el enumerador puede
resolver en memoria (una carga masiva y ~7 queries, en vez de miles) sin
riesgo: si alguna vez difirieran, lo peor es ofrecer un hueco que después
falla, o no ofrecer uno que estaba libre. Nunca un sobreturno. Para que no
se desincronicen, el predicado de solape (`rangesOverlap`), las reglas de
horario (`getEffectiveIntervalsForRange`) y la resolución del servicio
(`catalog.ts`) se comparten entre los dos caminos, y hay un test que le
exige a `checkAvailability()` estar de acuerdo con cada hueco ofrecido.

Tres invariantes se imponen **por código** y no solo por el prompt
(`applyAvailabilityGuards`), porque un prompt es probabilístico:

- En el mensaje en que se ofrecen horarios, `confirmacion_explicita` es
  siempre `false` — el paciente recién los está viendo.
- El pedido de horarios de la segunda respuesta se ignora: una sola consulta
  de agenda por mensaje entrante, y no hay forma de entrar en loop.
- El escalamiento a humano de la primera respuesta nunca se pierde. Y si la
  primera ya marcó escalamiento, no se consulta la agenda: a una urgencia no
  se le ofrecen turnos.

`SLOT_STEP_MINUTES` (15) es el paso de la grilla, no una duración —
`Clinic.defaultAppointmentMinutes` es otra cosa. La ventana por default es
de 14 días y al paciente se le ofrecen 3 opciones como máximo (el tope lo
aplica el prompt).

**El modelo ve TODOS los horarios de cada día, no un recorte**
(`prompts/availability-context.ts`, agrupados por profesional: "11:00, 11:15,
12:00 con Dra. Gómez; 14:00 con Dr. Ruiz"). Antes se recortaba a 4 por día y
se repartían; el 2026-11-05, con 6 huecos libres, el agente vio 4 y ante "¿y a
las 12?" contestó que no había lugar, estando libre: una lista parcial hace
que "no figura" se lea como "no hay". Solo se recortan los **días** (4), y se
avisa con "(hay más días disponibles después de estos)". El prompt le dice
que, si pregunta por una hora puntual, estar o no estar en la lista es la
respuesta, y que si todavía no se consultó la agenda no conteste de memoria
sino que marque `requiere_horarios_disponibles`.

Si Claude devuelve algo que no se puede interpretar (JSON cortado por
`max_tokens`, un flag que vino como texto), `parseAgentResponse()` lo detecta en
vez de explotar. **Tolera el cerco y la prosa**: si el modelo envuelve el JSON en
un bloque ```` ```json ```` o le antepone una frase, `extractJsonObject()` toma el primer
objeto completo (contando las llaves sin dejarse engañar por las que van dentro de un
texto). Antes eso se leía como ilegible y, dos veces seguidas, mandaba al paciente a una
persona **por un par de backticks** (2026-11-18, en el chat de pruebas); el prompt además pide
"sin bloque de código ni markdown", pero un prompt es probabilístico.

### Cuando el paciente pide a un profesional en particular

El modelo devuelve `profesional_solicitado` (el nombre, copiado de la línea
"Profesionales de la clínica" del prompt) y el código lo resuelve a un id con
`services/professional-match.ts` → `matchRequestedProfessional()`. Ese id se usa
en los DOS lados: filtra los horarios que se ofrecen (`findSlotsForPatient`) y
fija con quién se agenda (`requestedProfessionalId` de `booking.ts`, que lo
valida igual dentro de la transacción como a cualquier otro).

- **Una sola función decide el match**, sin acentos, sin mayúsculas, sin el
  tratamiento ("Dra.") y por palabras sueltas, no por texto exacto. **Ante la
  duda devuelve null y no el primero**: "López" puede ser dos personas, y
  agendar con la equivocada es peor que no filtrar (sin filtro se ofrecen los
  de todos y el paciente elige). El tratamiento no desempata.
- **Cada hueco lleva a TODOS los profesionales libres**
  (`Slot.candidateProfessionals`), y `describeDay()` los nombra ("11:00 con
  Dra. Liliana o Cyntia"). Antes el prompt solo veía al primero de cada hueco y
  el agente decía "solo veo disponibilidad con la Dra. Liliana" cuando los tres
  estaban libres a esa hora —con un calendario compartido pasa siempre—, y
  derivaba a una persona lo que no necesitaba derivación.
- Si la segunda respuesta no repite el profesional, no se pierde el del primer
  mensaje (`applyAvailabilityGuards`). Si el paciente confirma sin repetirlo y
  el modelo lo deja en null, rige el primero libre: por eso el prompt le pide
  repetirlo mientras siga en pie la elección.
- El servicio de primera vez **sigue ganando** sobre el pedido: acota a los
  profesionales habilitados antes de que el pedido se evalúe.

### Los turnos que el paciente ya tiene

Las dos llamadas reciben, además de los huecos, el bloque "Turnos existentes
del paciente" que arma `prompts/appointments-context.ts` →
`describeAppointments()`: los turnos **futuros y en `confirmado`** de ese
paciente, cada uno con su **id**, fecha, hora, servicio y profesional.

Es la fuente autoritativa de lo que el paciente tiene agendado, y reemplaza a
lo que quedara escrito en el historial. El parámetro `turnosPaciente` de
`interpretPatientMessage()` es **obligatorio** por eso: existía como opcional,
nadie lo pasaba, el prompt decía "ninguno informado" en todos los mensajes, y
las consecuencias eran tres — el bot le ofrecía agendar a quien ya tenía
turno, se olvidaba del turno en cuanto salía de los últimos 10 mensajes del
historial (`getRecentConversation`), y **no podía cancelar nada**, porque la
cancelación necesita el id y el modelo no tenía de dónde sacarlo.

Se informan solo los futuros y vigentes a propósito: sobre un turno que ya
pasó, se canceló o se atendió no hay nada que hacer, y ofrecer cancelarlo
lleva al modelo a prometer algo que después se rechaza.

**El id que devuelve el modelo nunca se busca solo.** La cancelación en
`agent-turn.ts` lo busca acotado a `clinicId` **y** `patientId` de esa
conversación, y solo en estado `confirmado`. Un id alucinado —o dictado por el
paciente— no puede cancelarle el turno a otra persona: si no es suyo, no se
encuentra y no se cancela nada.

## Estructura de carpetas

```
public/                       # frontend estático, servido en /ui
├── config-banner.js          # renderConfigBanner(), pensado para embeberse
├── config-banner.css
└── index.html                # página provisoria que hospeda el banner
prisma/schema.prisma          # Clinic, Professional, ProfessionalTitle, Insurer, ClinicInsurer,
                              # Room, Resource, Service,
                              # Patient, Package, Appointment, CalendarBlock, GoogleAccount,
                              # WorkingHours, ScheduleException,
                              # Plan, PlanPrice, MembershipPriceChange
src/
├── index.ts                   # servidor web: SOLO Express, ningún cron
├── worker.ts                  # tareas programadas, proceso aparte y único
├── config/env.ts              # SOLO variables globales de la plataforma
├── data/holidays.ts           # catálogo de feriados por país (datos, no lógica)
├── db/client.ts
├── middleware/
│   ├── authenticate.ts         # sesión → req.user
│   ├── authorize.ts            # requirePermission / requireSuperAdmin
│   └── audit.ts                # AUDITORÍA global de la API: una fila por operación
├── repositories/
│   ├── clinics.repository.ts      # clínicas + historial de conversación
│   ├── services.repository.ts     # catálogo de servicios de cada clínica
│   ├── professional-titles.repository.ts  # catálogo global de títulos +
│   │                              # habilitación por clínica y sus bajas bloqueadas
│   ├── insurers.repository.ts     # catálogo global de seguros + con cuáles
│   │                              # trabaja cada clínica (activo por relación)
│   ├── plan-prices.repository.ts  # precios de lista por país; NUNCA escribe en Clinic
│   ├── platform-secrets.repository.ts  # fecha de vencimiento de los secretos de la plataforma
│   ├── clinic-membership.repository.ts  # qué paga cada clínica; copia el precio
│   │                              # de lista, e historial en la misma transacción
│   ├── escalations.repository.ts  # derivaciones a una persona (cola de trabajo)
│   └── patients.repository.ts     # CRM
├── routes/
│   ├── webhook.ts              # entrada de WhatsApp (encola, espera, → agent-turn.ts)
│   ├── oauth.ts                # conexión de calendarios por OAuth (sin auth)
│   └── dashboard.ts            # API cruda: auditoría, métricas, buscador de
│                               # turnos, config de calendarios (sin auth)
├── services/
│   ├── claude.ts
│   ├── agent-turn.ts           # un turno de conversación completo: interpretar,
│   │                           # consultar huecos, reinterpretar, agendar, responder
│   ├── whatsapp.ts
│   ├── inbound-queue.ts        # agrupa los mensajes seguidos en un solo turno
│   ├── availability.ts         # profesional + espacio + equipo + bloqueos, contra Postgres
│   ├── availability-slots.ts   # enumera huecos libres para OFRECER (nunca decide)
│   ├── catalog.ts              # duración y equipo del servicio pedido, para los dos caminos
│   ├── booking.ts              # creación de turnos: transacción serializable + espejo
│   ├── appointment-admin.ts    # Agenda editable: crear/mover/editar/cancelar + bloqueos manuales
│   ├── patient-notifications.ts # aviso al paciente (plantilla) cuando la clínica cambia su cita
│   ├── booking-rules.ts        # primera vez → principal; default → primero libre
│   ├── working-hours.ts        # horario clínica ∩ profesional; comida = hueco;
│   │                           # excepciones por fecha (feriados)
│   ├── holidays.ts             # resuelve el catálogo de feriados a fechas
│   ├── config-health.ts        # qué le falta configurar a una clínica
│   ├── time.ts                 # hora de pared de la clínica → instante UTC
│   ├── calendar.ts             # despacha al proveedor de agenda: espejo + bloqueos
│   ├── calendar-providers/     # types.ts (contrato) + google.ts + microsoft.ts
│   ├── calendar-link.ts        # qué cuenta acompaña a un calendario al enlazarlo
│   ├── microsoft-auth.ts       # OAuth de Microsoft + acceso a Graph (refresh rotativo)
│   ├── oauth-state.ts          # state firmado: clínica + usuario + proveedor
│   ├── google-auth.ts          # OAuth: consentimiento, tokens, refresh
│   ├── google-hours.ts         # horario de Google → tramos de WorkingHours
│   ├── crypto.ts               # cifrado de tokens + firma del state de OAuth
│   ├── whatsapp-templates.ts   # crea las plantillas en el WABA de cada clínica
│   ├── location.ts             # dirección + link de Maps (si la pide, y en el primer turno)
│   ├── escalation.ts           # resumen del paciente/cliente al escalar
│   ├── membership.ts           # reglas puras de qué paga una clínica + comparación
│   ├── plan-prices.ts          # la grilla de precios de lista (presentación pura)
│   ├── secret-expiry.ts        # reglas puras del aviso de vencimiento de un secreto
│   ├── packages.ts             # paquetes de sesiones: la sesión se descuenta al marcar atendida
│   ├── audit.ts                # AuditLog: registrar, derivar la operación de la ruta, consultar
│   ├── sandbox.ts              # chat de pruebas: el turno del asistente sin WhatsApp ni avisos reales
│   ├── sandbox-phone.ts        # el teléfono reservado de las pruebas (sin dependencias, para los jobs)
│   ├── campaigns.ts            # campañas y promociones: detectar, atribuir, contexto, contactos y estadísticas
│   ├── reports.ts              # reportes de citas: doce informes con la misma forma + CSV
│   ├── csv.ts                  # CSV con BOM y anti-inyección de fórmulas
│   ├── agent-requests.ts       # AgentRequest: cada llamada al modelo (metadatos y decisión, sin texto)
│   ├── appointment-events.ts   # AppointmentEvent: la vida de cada cita (fuente de los reportes)
│   ├── patient-admin.ts        # módulo de pacientes: ficha, comentarios, nombre y apellido
│   ├── patient-history.ts      # qué se le hizo a cada persona, para el prompt del asistente
│   ├── next-visit.ts           # a quién hay que contactar por su próxima cita sugerida
│   ├── payments.ts             # stub del cobro de seña
│   └── email.ts
├── prompts/
│   ├── system-prompt.ts        # genérico, parametrizado por Clinic
│   ├── availability-context.ts # arma el texto de horarios que lee el prompt
│   ├── appointments-context.ts # los turnos que el paciente ya tiene, con su id
│   ├── professional-label.ts   # "Dra. Gómez": título + nombre, para el paciente
│   ├── insurers-context.ts     # con qué seguros trabaja; nunca qué cubren
│   └── campaign-context.ts     # la campaña por la que llegó el paciente, para el asistente
├── jobs/
│   ├── inbound-sweeper.ts          # rescata mensajes que dejó colgando una instancia caída
│   ├── calendar-access-alerts.ts   # avisa a la clínica que hay que reconectar un calendario
│   ├── secret-expiry-alerts.ts     # avisa a los admins que vence un secreto de la plataforma
│   ├── tracked-cron.ts             # cron.schedule + latido + errores a Monitoreo
│   ├── system-events-cleanup.ts    # borra los eventos de monitoreo viejos (30 días)
│   ├── google-oauth-health.ts      # verifica contra Google que la app de OAuth siga valiendo
│   ├── package-reminders.ts        # mail diario: citas por paquete sin marcar como atendidas
│   ├── next-visit-outreach.ts      # WhatsApp a pacientes cuya próxima cita sugerida se acerca
│   ├── sandbox-cleanup.ts          # borra las conversaciones del chat de pruebas que quedaron sin actividad
│   ├── campaign-followup.ts        # seguimiento (con tope) de quienes llegaron por una campaña y no agendaron
│   ├── daily-report.ts             # lee Appointment de Postgres, NO Calendar
│   ├── calendar-sync.ts            # Calendar → CalendarBlock, cada 15'
│   ├── config-alerts.ts            # avisa a las clínicas sin horario cargado
│   ├── daily-reminders.ts          # exporta sendRemindersForWindow
│   ├── two-hour-reminders.ts       # Plus
│   └── post-visit-followup.ts      # Plus + marca "atendido" para CRM en todos los casos
└── types/index.ts
scripts/add-clinic.ts           # ejemplo dental y ejemplo de spa
docs/
├── onboarding-clinica.md       # alta de WhatsApp/Calendar
├── onboarding-vertical.md      # checklist para configurar un rubro nuevo
└── casos-de-uso-y-pruebas.md   # casos de uso y de prueba (auto y manuales) de toda la app
```

## Un WhatsApp, varias personas

`Patient` **no** está identificado por teléfono. Un número suele ser de una
familia: el titular agenda para él, para su papá y para su hija.

- El **teléfono identifica la conversación** — `ConversationMessage` se
  guarda por número, no por paciente — y el **titular** es la ficha más
  vieja de ese número (`getOrCreateConversationPatient()`).
- De quién es cada turno lo resuelve `resolvePatientForBooking()`: si el
  modelo devolvió `paciente_del_turno`, busca esa persona entre las fichas
  del número (comparando sin acentos ni mayúsculas, para no duplicarla por
  un tipeo) y la crea si no está. Sin nombre, el turno es del titular.
- El prompt recibe el bloque "Personas de este WhatsApp" con todas las
  fichas y sus turnos: si solo viera la del titular, quien escribe pregunta
  "¿qué citas tenemos?" y no ve la de su papá.

**El nombre de quien escribe y el del paciente del turno son campos
distintos** (`nombre_paciente` vs `paciente_del_turno`). Mientras fueron uno
solo, pedir un turno "para Nieves de García" lo agendaba a nombre de Carlos
—pasó el 2026-09-14— y, si Carlos no hubiera tenido nombre cargado, le
habría renombrado la ficha.

Lo que más importa de esto no es el nombre: **`isFirstTimePatient()` cuenta
los turnos de la PERSONA**, así que la política de "primera vez" se le aplica a quien realmente viene por primera vez.
Con una ficha por teléfono, la hija de un paciente conocido nunca era
"nueva" y se salteaba la regla.

`resolvePatientForBooking()` corre **antes** de buscar huecos, no al
agendar: si el turno es para alguien nuevo, la regla lo manda por el servicio de
primera vez y los horarios que se ofrecen tienen que ser los de
él. Resolviéndolo después se ofrecerían huecos de cualquiera y el turno
rebotaría al confirmar.

## CRM — etapas del paciente/cliente

```
nuevo_contacto → interesado → turno_agendado → turno_confirmado → atendido
                                     ↘ cancelado (desde cualquier punto)
```

Igual que antes de la generalización — ver el detalle de cada transición
en el historial de este archivo si hace falta, no cambió con este refactor.

## Horario de atención

**Es la única fuente.** De `WorkingHours` sale tanto la validación al
agendar como el texto que el bot le cuenta al paciente
(`describeWorkingHours()` → `buildSystemPrompt()`). Hubo un campo de texto
libre aparte (`Clinic.businessHours`) y se eliminó el 2026-09-14: se
desincronizaban. En la clínica piloto el texto anunciaba comida de 15:00 a
16:00 mientras el horario real la tenía de 13:00 a 14:00, así que el bot
agendó a las 15:00 —correctamente, según el dato— y después le dio la razón
al paciente cuando protestó.

Una clínica sin tramos cargados hace que el prompt diga explícitamente que
el horario no está cargado, en vez de dejar la línea vacía y que el modelo
invente uno plausible (`SIN_HORARIO` en `prompts/system-prompt.ts`).

Dato estructurado en `WorkingHours`, con dos niveles. **Los dos tienen que
permitir el turno**: el efectivo es la intersección.

- `professionalId` en null → horario de la **clínica**.
- `professionalId` con valor → horario de **ese profesional**.

Tres reglas que no son obvias:

1. **Un profesional sin NINGÚN tramo propio hereda el de la clínica
   completo.** La herencia es todo o nada, no por día. Si fuera por día, un
   profesional que define lunes a miércoles heredaría jueves y viernes de la
   clínica y lo agendarían en sus días libres. Tener al menos un tramo
   propio significa "este es mi horario completo".
2. **El horario de comida es el hueco entre dos tramos del mismo día.** No
   hay un concepto separado de "descanso": lunes 09:00–13:00 + 14:00–18:00
   son dos filas, y de 13 a 14 no se agenda. Modelarlo así evita definir qué
   pasa si un descanso cae fuera del horario o se solapa con dos tramos, y
   permite gratis la clínica que corta dos veces.
3. **Un turno tiene que entrar completo dentro de UN tramo.** No puede
   empezar en uno y terminar en el siguiente — eso sería atender durante la
   comida. Un turno de 12:45 a 13:15 se rechaza.

El horario propio de un profesional **no habilita nada** fuera del horario
de la clínica: cargarle un tramo con la clínica cerrada no le va a dar
turnos ahí.

`startMinute` / `endMinute` son minutos desde la medianoche **local de la
clínica** (540 = 09:00). El día de la semana y los minutos se calculan con
`Clinic.timezone`, nunca con la hora del servidor: un turno a las 02:00 UTC
del martes es lunes por la noche para una clínica en UTC-6.

Se configura por API (`GET/PUT /dashboard/clinics/:id/working-hours` y
`.../professionals/:id/working-hours`). Se manda el set completo, no de a un
tramo: el horario de un día son sus tramos juntos, y los solapamientos solo
se detectan viéndolos todos. Mandar `tramos: []` a un profesional lo
devuelve a heredar.

### Excepciones por fecha: feriados y jornadas especiales

`WorkingHours` es semanal y se repite siempre. `ScheduleException` es lo que
permite decir "el 25 de diciembre no se atiende".

**Una excepción REEMPLAZA el horario semanal de esa fecha**, no lo recorta
ni lo suma:

- Sin tramos → **cerrado todo el día**. Es el feriado y el "ese día tenemos
  una actividad y no trabajamos".
- Con tramos → ese es el horario de ese día. Sirve para media jornada, y
  también para **abrir un día que normalmente está cerrado**.

Feriado y horario especial son el mismo concepto a propósito: evita dos
tablas que se pueden contradecir, y el chequeo es el mismo
`fitsInSomeInterval()` que para el horario semanal.

`professionalId` en null afecta a toda la clínica; con valor, solo a ese
profesional (se tomó el día, se fue a un congreso).

Dos cosas que no son obvias:

- **Un profesional que hereda el horario hereda el EFECTIVO de la clínica,
  excepciones incluidas.** Si no, una clínica que abre un sábado por
  excepción no tendría a nadie para atender: el sábado no existe en el
  horario semanal que el profesional hereda.
- **La excepción propia de un profesional gana sobre lo que herede.** Puede
  tener excepción propia sin tener horario semanal propio: las dos cosas son
  independientes.
- Cargar la misma fecha de nuevo **sobrescribe**. Dos excepciones para el
  mismo día no tendrían un significado claro ("cerrado" vs "de 9 a 12").

API: `GET/PUT /dashboard/clinics/:id/schedule-exceptions` y
`DELETE .../schedule-exceptions/:dateKey?professionalId=`.

### Feriados nacionales precargados

El catálogo de países y sus reglas de feriados vive en las tablas
`Country` / `HolidayRule` (Postgres), no en código — `src/data/holidays.ts`
hoy solo tiene `suggestCountryFromTimezone()` (la sugerencia de país al dar
de alta una clínica, ver más abajo). `services/holidays.ts` →
`holidaysForCountry()` resuelve las reglas de un país a fechas concretas
para un año dado. `Clinic.country` (ISO alpha-2) es lo que habilita las
sugerencias — explícito y no inferido de `timezone`, porque la inferencia
falla en países con varias zonas y en zonas que abarcan varios países.

`Country.currency` (ISO 4217, ej. "ARS", "MXN") es la moneda en la que se
expresan los precios de ese país: los de lista (`PlanPrice`) y el que paga
cada clínica (`Clinic.membershipCost` — ver "Cuánto paga cada clínica") —
un campo del país, no de la clínica, porque todas las clínicas de un mismo
país facturan en la misma moneda. Al fijarle el precio a una clínica se
**copia** a `Clinic.membershipCurrency`: editar la moneda del país no puede
cambiarle el significado a un acuerdo ya cerrado.

`Country.timezones` (arreglo de IANA, ej. `["America/Mexico_City",
"America/Tijuana", ...]`) es de dónde sale el selector de zona horaria de
una clínica en "Clínicas" — reemplaza lo que antes era un campo de texto
libre donde había que escribir a mano algo como "America/Mexico_City" sin
ninguna validación (un typo silencioso rompía `services/time.ts` para esa
clínica). Un país puede tener varias — México tiene ocho cargadas. Se
edita desde "Países" como una lista separada por comas, mismo patrón que
`currency`.

**Los feriados se SUGIEREN, no se cargan solos.** Hay clínicas que atienden
algunos feriados, y cerrar un día sin que lo confirmen les haría perder
turnos reales. El flujo es: `GET .../holidays` devuelve el calendario del año
con `yaCargado` en cada fecha → la clínica confirma →
`POST .../holidays/apply` crea las `ScheduleException`. Aplicar **no pisa**
una fecha que ya tenga excepción, así que un feriado con horario especial
cargado a mano sobrevive.

El catálogo soporta tres tipos de regla (`HolidayRule.kind`): fecha fija,
enésimo día de la semana del mes, y relativa a la Pascua (Viernes Santo,
Carnaval), con el algoritmo gregoriano en `easterSunday()`. **Agregar (o
desactivar) un país es un dato, no un cambio de código**: se hace desde la
pantalla de plataforma "Países" (`/platform/countries`, solo super-admin,
`repositories/countries.repository.ts`) o, para el punto de partida de un
ambiente nuevo, en `prisma/seed.ts` → `SEED_COUNTRIES`.

En `nthWeekday`, **`ordinal: -1` es "el último del mes"** y no un ordinal
fijo. Hace falta porque hay feriados definidos así: el Memorial Day de
Estados Unidos es el último lunes de mayo, que según el año es el cuarto o el
quinto. Cargado como "cuarto lunes" estaría mal uno de cada tantos años, y
como fecha fija estaría mal casi siempre. No confundirlo con el Thanksgiving,
que es el **cuarto** jueves y no el último (noviembre puede tener cinco).

Los feriados que dependen de una decisión anual o del día de la semana en que
caen NO están en el catálogo a propósito. Son tres familias:

- **Por decreto cada año** — puentes turísticos, los "días no laborables" que
  declara un Ejecutivo, los hasta tres días que puede agregar el gobierno
  venezolano.
- **Trasladables** — "esta fecha fija se corre al lunes según el día en que
  caiga": la Ley Emiliani en Colombia, la reforma de 2016 en Ecuador, la Ley
  139-97 dominicana, las leyes 19.668/20.299 chilenas, la Ley 70 de 2007
  panameña. La única excepción son los tres feriados colombianos atados a
  Pascua (Ascensión, Corpus Christi y Sagrado Corazón): como su fecha base
  también es móvil, el traslado da un offset **constante** (+43, +64, +71) y
  sí se puede expresar.
- **Medio día** — el 24 y el 31 de diciembre guatemaltecos son asueto desde
  las 12:00. Marcarlos como día cerrado haría rechazar turnos de una mañana
  en que sí se atiende; van como excepción con tramo, no como feriado.

**Es mejor sugerir de menos que sugerir una fecha equivocada**, y la asimetría
es la razón: una fecha de más le hace perder a la clínica los turnos de un día
que trabajaba, y una de menos solo le deja un feriado sin cargar, que es el
estado en el que ya está. Por eso hay países que quedan con listas cortas y
está bien: Ecuador tiene 5 de sus 11 feriados y Uruguay 5, porque casi todo su
calendario es trasladable o "laborable"; Honduras 7, porque la Semana
Morazánica se ancla a un bloque de la primera semana de octubre que se
confirma por comunicado cada año. Esas clínicas cargan el resto a mano desde
"Horarios", que es exactamente para lo que existe.

Cada bloque de `SEED_COUNTRIES` tiene anotado qué quedó afuera y por qué, para
no volver a investigar lo mismo.

### Avisos de configuración incompleta

`services/config-health.ts` es la fuente única de "qué le falta a esta
clínica", y de ahí salen los tres canales, para que no se contradigan:

- **Banner** — `public/config-banner.js` → `renderConfigBanner(contenedor,
  clinicId)`. Consume `GET /dashboard/clinics/:id/config-health` y ofrece la
  acción concreta cuando se puede resolver de un click: cargar los feriados
  de un año, elegir el país. Cargar el horario de atención no tiene botón
  porque necesita un editor de tramos por día, que es una pantalla aparte.
  Está pensado para embeberse: cuando exista el dashboard real se importa
  esa función, no se reimplementa. Se sirve estático en `/ui` — sin bundler,
  porque el proyecto no tiene y un banner no justifica agregarlo.
  `public/index.html` es una página provisoria que lo hospeda
  (`/ui/?clinicId=...`) y se borra cuando haya dashboard.
- **Email** a `Clinic.email`.
- **WhatsApp** a `Clinic.adminPhone` si está cargado — el número interno de
  quien administra el sistema, NO de un paciente. Va **siempre por plantilla
  aprobada** (`Clinic.configAlertTemplateName`), nunca por `sendTextMessage`.

Dos avisos con cadencias distintas, en `jobs/config-alerts.ts`:

- **Horario faltante**: diario. Es bloqueante — sin horario, `booking.ts`
  rechaza todo turno (`clinica_sin_horario`) y no se ofrece ningún horario.
- **Feriados sin cargar**: semanal. Es advertencia; funciona, pero esos días
  va a ofrecer turnos. **Desde diciembre se cuenta también el año
  siguiente** (`relevantHolidayYears()`), para que el calendario esté
  confirmado antes del 1 de enero — si se deja para enero, el asistente
  ofrece turnos el Año Nuevo. Se amplía la sugerencia y el aviso, **no** se
  carga solo: la clínica sigue confirmando. La pantalla de Feriados ofrece **siempre el año en curso y el siguiente** (no solo desde diciembre), para poder cargar el calendario con tiempo.

`Clinic.workingHoursAlertSentAt` y `holidayAlertSentAt` evitan repetirlos si
el proceso se reinicia o hay más de una instancia corriendo el cron. El
chequeo va contra la base, no contra el cron, justamente por eso. Si falla
el email no se marca como enviado y se reintenta; si falla el WhatsApp, no
se propaga, porque el email ya salió.

## Creación de turnos

`services/booking.ts` → `createAppointmentFromRequest()` es el único camino
para crear un turno. El webhook solo le pasa lo que interpretó Claude.

El orden importa y no es intercambiable:

1. `fecha_solicitada` + `hora_solicitada` se convierten con
   `services/time.ts`. Son hora de pared **de la clínica**
   (`Clinic.timezone`), no del servidor: sin esto un servidor en UTC y una
   clínica en México guardarían el turno con 6 horas de corrimiento. Si la
   hora no existe en esa zona (la madrugada que se saltea al arrancar el
   horario de verano) se rechaza en vez de inventar un instante.
2. La duración sale de `Service.durationMinutes` si el servicio que dijo el
   paciente matchea el catálogo, y si no de
   `Clinic.defaultAppointmentMinutes`. No tener catálogo es un caso válido.
3. `checkClinicHours()` — ¿está abierta la clínica? Va **antes** de resolver
   el profesional, y el orden importa: el criterio por default descarta a
   los profesionales que no trabajan a esa hora, así que si se resolviera
   primero, una clínica cerrada devolvería "ningún profesional disponible"
   en vez de "cerrada". El motivo es lo que después se le explica al
   paciente, así que tiene que ser el útil.
4. `resolveProfessionalForBooking()` decide el profesional, en este orden:
   regla de primera vez → el que pidió el paciente → el primero libre que
   además trabaje a esa hora.
5. `checkWorkingHours()` — el horario del profesional concreto. Hace falta
   igual, porque un profesional pedido explícitamente o el principal de la
   regla de primera vez no pasan por el filtro del paso anterior.
6. `checkAvailability()` valida espacio y equipo.
7. Se crea el `Appointment`.

**Los pasos 3 a 7 corren en una sola transacción `Serializable`.** Si no,
dos mensajes que llegan juntos pasan los dos el chequeo y queda un turno
duplicado en el mismo espacio — el chequeo de uno no ve lo que el otro está
por insertar. Cuando Postgres aborta una de las dos, se devuelve
`conflicto_concurrente`; Prisma reporta eso como `P2034`, no como el 40001
nativo.

**El espejo en Calendar va DESPUÉS de cerrar la transacción**, a propósito:
es una llamada de red y no puede tener una transacción de Postgres abierta
esperándola. Si falla, el turno ya está creado y es válido — se devuelve
`mirrorError` y el turno queda sin `googleEventId`.

## Reglas de negocio importantes (no las rompas al refactorizar)

1. **Minimización de datos** y **escalamiento obligatorio a humano** —
   viven en `prompts/system-prompt.ts`, ahora parametrizadas por
   `Clinic.escalationCriteria` en vez de hardcodeadas.
2. **Nunca inventar horarios ni confirmar sin elección explícita.**
3. **Disponibilidad se valida SIEMPRE contra Postgres**
   (`services/availability.ts`) — profesional, espacio, equipo si
   corresponde, y bloqueos de la agenda personal (`CalendarBlock`). Esa
   función no llama a ninguna API externa.
4. **Mensajes iniciados por la clínica van siempre por plantilla
   aprobada**, nunca por `sendTextMessage`.
5. **El resumen de escalamiento no hace una llamada nueva a Claude.**
6. **No meter lógica específica de un rubro en el código** — ver la
   sección "Qué es genérico y qué se configura por rubro" más arriba. Si
   una feature nueva "solo tiene sentido para dental" o "solo para spa",
   buscar la forma de modelarla como dato configurable antes de asumir que
   necesita código nuevo.
7. **Toda operación que modifica algo deja registro de auditoría** (quién, qué,
   cuándo, sobre qué y con qué resultado), desde el login, y **nunca guarda valores de lo
   que se escribió, solo los nombres de los campos**. Las rutas de la API lo tienen
   automático (`middleware/audit.ts`); lo que no pasa por una ruta (jobs, el asistente de
   WhatsApp, scripts) hay que registrarlo explícitamente. Ver "Reglas transversales" y
   "Auditoría y eventos de cita".

## Deuda técnica conocida / próximos pasos

### Hallazgos de escribir los tests de los jobs (2026-11-13), ya corregidos

- **`calendar-sync` no actualizaba ni borraba un evento EN CURSO.** El borrado filtraba por el inicio
  del evento dentro de la ventana, y uno que empezó antes de ahora quedaba afuera: si se alargaba o
  se borraba en el calendario, el bloqueo viejo seguía vivo (y `skipDuplicates` descartaba la versión
  nueva). Ahora borra por `endTime > ahora`, y el historial ya terminado sigue sin tocarse.
- **El recordatorio de 24 h solo avisaba a las citas de las 17:00 a las 18:00 del día siguiente.**
  Corría una vez al día a las 18:00 del servidor con una ventana de una hora. Ahora corre cada hora,
  como el de 2 h, y cada cita cae en exactamente una pasada.
- **Los recordatorios mandaban la hora y la fecha del servidor, no las de la clínica.** Un servidor
  en UTC le decía a un paciente de México una hora corrida 6 horas. Ahora son las de `Clinic.timezone`.
- **Resuelto (2026-11-20): la marca de "recordatorio ya enviado".** `Appointment.reminder24SentAt` / `reminder2hSentAt`
  (independientes entre sí). `sendRemindersForWindow()` **reclama la marca antes de mandar** (UPDATE condicionado a null: dos pasadas
  seguidas o dos instancias del worker no duplican el aviso, solo una gana) y **la libera si el envío falla** para que un reintento lo
  mande; lo que Meta aceptó no se repite. **Mover la cita de hora desde la Agenda borra las dos marcas** (otro horario = otro aviso;
  `updateAppointment()`); reagendar por WhatsApp crea una cita nueva, que nace sin marcas. Lo que no cubre: las citas que ya existían
  al desplegar tienen las marcas en null, así que una cita de las próximas horas puede recibir un aviso que ya había salido (una sola vez).

### Funcionalidades futuras, después de salir al piloto (anotado el 2026-11-20, sin diseñar)

Decidido: primero se pasa el agente de WhatsApp a producción con una clínica interesada; lo siguiente se agrega después
y **no bloquea la salida**. Ninguno está diseñado todavía; lo anotado son los puntos a resolver al empezar.

- **Instagram como canal.** Un plan de suscripción (o una feature de plan en `PLAN_FEATURES`, no un booleano en `Clinic`) que
  permita conectar la cuenta de Instagram de la clínica. Hoy todo asume WhatsApp: el teléfono identifica la conversación,
  `ConversationMessage` se guarda por número y las plantillas son por WABA. Hay que decidir cómo se identifica a la persona en un
  canal sin teléfono (id de Instagram), cómo se vincula con una ficha `Patient` y cómo se ve en Conversaciones.
- **Mensajes de Facebook (Messenger).** Plan aparte, mismo problema de identidad que Instagram; conviene resolver los dos canales
  con una sola abstracción de "canal" en vez de dos caminos paralelos. `Clinic` ya guarda los links de redes solo como referencia
  (sin credenciales): esto necesitaría credenciales cifradas como el token de WhatsApp.
- **Atender llamadas de voz.** Plan aparte. Requiere voz a texto y texto a voz, latencia baja y un proveedor de telefonía; el
  asistente actual está pensado para texto (respuestas con listas, varios mensajes, links). Evaluar costo por minuto y
  reflejarlo en "Costos" (`config/cost-catalog.ts`).
- **Historia clínica de primera vez, en línea y firmada.** Módulo para que el paciente nuevo la complete antes de llegar y la
  firme; la clínica puede imprimirla y adjuntarla, o hacerla firmar en el lugar. Puntos a resolver: es **dato de salud**
  (decidir qué se guarda, cifrado, quién lo ve con un permiso propio, y que **no se mande al modelo** salvo decisión explícita,
  a diferencia de las observaciones de la ficha); el formulario debe ser configurable por clínica y por rubro (agnóstico,
  como `escalationCriteria`), con versiones para saber qué firmó cada paciente; la firma (en pantalla o impresa) y su valor
  legal varían por país; impresión/PDF; cómo llega el link al paciente (plantilla de Meta, porque lo inicia la clínica) y
  la auditoría de ver, firmar e imprimir (`SENSITIVE_READS`).

- **Pagos y cobros en línea, con domiciliación de pagos y tarjetas (anotado el 2026-11-20, sin diseñar).** Hoy no existe ningún
  cobro: `services/payments.ts` es un stub y lo que paga cada clínica se registra a mano (`Clinic.membershipCost`, ver "Cuánto paga
  cada clínica"). Hay **dos problemas distintos** y conviene no mezclarlos:
  (1) **Cobrarle a las clínicas la membresía de la plataforma** (suscripción recurrente): cobro automático con tarjeta o
  domiciliación, facturas o recibos, qué pasa si falla el pago (reintentos, aviso, suspensión del servicio y de qué: no se puede
  cortar el asistente de una clínica de un día para otro sin aviso), cambio de plan (Base ↔ Plus) con prorrateo, y los países y
  monedas (`Country.currency`; el precio ya se congela por clínica). Encaja con `MembershipPriceChange` y con `exonerada`.
  (2) **Que la clínica le cobre a SUS pacientes** (seña, paquetes, consultas): ver el pendiente de la seña (`deposito_sena`); el dinero
  tiene que ir a la cuenta de la clínica, con credenciales de pasarela cifradas por clínica. Puntos comunes a resolver: elegir
  pasarela por país (Mercado Pago, Stripe u otras; la domiciliación bancaria existe en algunos países y en otros no), **no guardar
  datos de tarjeta nunca** (que los tokenice la pasarela, para quedar fuera del alcance de PCI), webhooks firmados e idempotentes
  (auditoría explícita con `recordSystemAudit()`), facturación y obligaciones fiscales de cada país, y los costos de la pasarela en "Costos".
- **Sitio web público para mostrar y vender la plataforma (anotado el 2026-11-20, sin diseñar).** Hoy lo único público es la API
  (webhook, OAuth) y la SPA de administración en `/app`, que es para clientes ya dados de alta. El sitio comercial es otra cosa:
  páginas de producto, planes y precios (podrían salir de `Plan` / `PlanPrice`, que ya son por país, para no mantener dos listas),
  demostración, contacto o solicitud de alta, y las páginas legales (política de privacidad y términos de servicio: **Google las exige
  para verificar la app de OAuth**, ver "El OAuth de Google está probado solo en local", y Meta las pide para el negocio). Decidir si
  vive en el mismo servidor o aparte (conviene aparte y estático: no mezclarlo con el servidor que atiende pacientes ni exponer la API
  de plataforma), el dominio (el que ya tienes en Cloudflare), y si el alta de una clínica sigue siendo manual (super-admin) o pasa a
  autoservicio, que recién ahí exige el cobro automático de la membresía de arriba.

### Campañas: lo que falta para usarlas de verdad (2026-11-18)

- **Meta tiene que aprobar `seguimiento_campana` en cada WABA** (y puede reclasificarla como Marketing: pedir la revisión de
  categoría). El alta de clínicas nuevas la crea sola; en los WABA ya creados hay que correr
  `POST /platform/clinics/:id/whatsapp/templates`. Hasta entonces, no prender `campaignFollowUpEnabled`.
- **Probar el recorrido real**: un anuncio Click-to-WhatsApp de Meta (que `referral.source_id` llegue como se espera) y un
  link con texto prellenado. El webhook no tiene tests (caso CA-01).
- **Que el modelo cuente bien la promoción** (caso CA-02): solo lo que figura en la descripción, sin inventar precios.

### Pendientes antes de salir a producción (resumen, 2026-11-13)

- **Ambientes:** cuando existan integración y producción, en cada uno hay que aplicar las migraciones
  (`npx prisma migrate deploy`) y correr `npm run db:seed`, y después reiniciar el servidor web y el worker.
  El detalle (qué migraciones, cuáles tocan datos y el `.env` de cada ambiente) está en "Todavía no hay
  ambientes de integración ni de producción", más abajo.
- **Migración de datos al incorporar una clínica nueva (hecha el 2026-11-20, falta probarla con una clínica real).** Ver
  `docs/migracion-clinica.md`. `scripts/import-patients.ts` carga desde un Excel/CSV (nombre, teléfono, fecha de la última visita)
  con simulación por defecto (`--apply` para cargar) y `--rollback <lote>`; la lógica está en `services/patient-import.ts` y los tests en
  `tests/patient-import.test.ts`. **Solo importa pacientes, no citas pasadas**: quien ya venía se marca con `Patient.priorHistory` y
  **no es de "primera vez"** (`isFirstTimePatient()`, el `primeraVez` del prompt en `agent-turn.ts` y el reporte de pacientes nuevos
  lo respetan: si se agrega una cuarta regla de "primera vez", tiene que mirarlo). `Patient.priorLastVisitOn` es informativa e
  `importBatchId` identifica el lote para deshacerlo (conserva a quien ya tiene actividad). No pisa fichas existentes, no adivina el
  código de país (solo con `--country-code`), no manda mensajes ni toca la etapa del CRM, y audita por lote (`patient.import`,
  `patient.import_rollback`, origen `sistema`, solo cantidades). **Convivencia con la agenda de la clínica durante el piloto:** la
  clínica sigue en Google Calendar; `calendar-sync` copia el horario de sus eventos como bloqueos (sin título) y los turnos de la
  plataforma se espejan allá. **Rollback:** `scripts/calendar-snapshot.ts` (instantánea, `--verify`, `--rollback-mirrors`; solo Google:
  `CalendarProvider.exportEvents` es opcional y Microsoft no lo implementa) y `scripts/db-backup.sh` / `db-restore.sh` (`backups/` está
  en `.gitignore`: tiene datos de pacientes). **Lo que no cubre:** importar observaciones, historia clínica ni citas futuras de otro
  sistema; una pantalla en el panel para subir el archivo (hoy es un script que corre quien administra); respaldo/rollback de calendarios de
  Microsoft; ni el nombre partido con certeza (si el Excel trae una sola columna se guarda el nombre completo y la ficha marca
  `nameInferred`).
- **Política de privacidad y términos de servicio (borradores del 2026-11-20).** En `docs/legal/` (`politica-de-privacidad.md`,
  `terminos-de-servicio.md` con su anexo de tratamiento de datos, y `pendientes-antes-de-publicar.md`, interno). Hay que completar los campos
  `[ENTRE CORCHETES]`, **revisarlos con un abogado**, publicarlos en URLs públicas y enlazarlos desde Google (verificación de la app de OAuth),
  Meta y la aplicación. Dicen cosas que el producto todavía no hace (exportar o borrar los datos de un paciente, retención definida, cobro):
  la lista está en `pendientes-antes-de-publicar.md`. Si cambia lo que se envía al modelo de IA, los proveedores o los permisos de Google,
  **hay que actualizar la política**.
- **Retención cero (ZDR) con Anthropic para datos de salud (decidido pedirla el 2026-11-20, falta enviarla).** Es un trámite con su equipo comercial y se
  activa **por organización**: separar una organización de Anthropic para producción (la `ANTHROPIC_API_KEY` de producción tiene que salir de ella) y no
  usar la Consola/Workbench con datos reales. Texto y pasos en `docs/legal/solicitud-retencion-cero-anthropic.md`. Hoy la plataforma usa solo Mensajes +
  caché de prompt con `claude-sonnet-5` (elegibles); **cambiar de modelo o usar lotes, Files API, herramientas, etc. puede dejarla fuera de ZDR** y obliga
  a revisar la política de privacidad. Al recibir la respuesta, actualizar `docs/legal/` (regla transversal 3).
- **Decisión (2026-11-20): se sigue como persona física por ahora** para no atrasar el piloto; revisar la sociedad antes de vender a varias clínicas.
- **Figura legal del proveedor (anotado el 2026-11-20).** Detrás de la plataforma hay **una persona que ofrece servicios de desarrollo, no una empresa**:
  responde con su patrimonio personal (sin límite), y las cuentas de Meta, Google, Anthropic, hosting y dominio quedan a su nombre. Decidir con un contador y un
  abogado si seguir como persona física o constituir una sociedad (por ejemplo una SAS: verificar vigencia y límites) **antes de vender a clínicas con datos
  reales**, y contratar un seguro de responsabilidad civil / ciberriesgos. Los textos de `docs/legal/` dicen "el Proveedor" para servir con las dos
  figuras. Detalle y qué cuentas habría que transferir en `docs/legal/pendientes-antes-de-publicar.md` (sección 7).
- **Google:** publicar la app en Google Cloud Console (pasarla de "Prueba" a "En producción") para que el
  permiso de cada clínica no venza cada 7 días: en modo Prueba cada clínica tiene que reconectar su calendario
  una vez por semana. Incluye la verificación de Google por los scopes de Calendar, el dominio autorizado y la
  URI de redirección de producción; el detalle está en "El OAuth de Google está probado solo en local y en modo
  Prueba", más abajo.

### Puntos a mejorar de la prueba del 2026-10-28 con el agente

1. ~~El agente decía que solo había lugar con la Dra. Liliana~~ **Resuelto**:
   ver "Cuando el paciente pide a un profesional en particular".
2. ~~El saludo a quien no tiene citas era seco y no invitaba a agendar~~
   **Resuelto**: la regla está en `prompts/system-prompt.ts` ("escribe sin un
   pedido concreto y no tiene ninguna cita pendiente"): saluda por el nombre y
   ofrece agendar nombrando 2 o 3 servicios de la clínica, en vez de informar
   que no hay citas. Es texto del modelo, no una frase fija en el código.
3. ~~Un evento creado a mano en Google no aparecía en la Agenda~~ **Resuelto
   (2026-11-07)**: `GET /dashboard/clinics/:id/calendar` ahora devuelve `bloqueos`
   (importados y manuales) y la grilla los dibuja con un rayado propio, distinto
   del de "cerrado". Siguen sin título los importados. Con calendario compartido
   el bloqueo aparece en todas las columnas. El retraso de hasta 15 minutos entre
   crearlo en Google y verlo acá todavía no se aclara en la pantalla.

- ~~Una clínica sin `WorkingHours` cargado acepta turnos a cualquier hora~~
  **Resuelto (2026-11-13): el horario es obligatorio.** `booking.ts` rechaza con
  `clinica_sin_horario` (con `hasStructuredHours()` antes de abrir la
  transacción), el enumerador ya devolvía `sin_horario_de_atencion` y no ofrece
  nada, y el alta exige el horario: `POST /platform/clinics` responde 400 sin
  `workingHours` o con la lista vacía, y "Nueva clínica" trae un editor de
  tramos prellenado con el de Google que hay que confirmar con "Usar este
  horario". En la Agenda editable es una regla **blanda** (la asistente puede
  confirmar) pero el mensaje dice que falta cargar el horario, no que "no
  atiende a esa hora". `config-health` sigue marcándolo como bloqueante y
  `config-alerts` avisa a diario, ahora con el texto real: "no puede agendar".
  **Lo que no cubre:** una clínica ya creada sin horario (ej. una de antes de
  este cambio) queda sin poder agendar hasta que lo cargue; no se migra nada
  solo, porque inventarle un horario sería peor.
- **Falta que Meta apruebe `aviso_configuracion` en cada WABA.** El código
  la manda, pero hasta que esté aprobada el WhatsApp de configuración falla
  (se loguea y sigue; el email igual sale). Ojo: **no** es una plantilla por
  plataforma —lo decía este archivo y era incorrecto—, es por WABA, y cada
  clínica tiene el suyo. Ver "Plantillas de WhatsApp" más arriba: el alta ya
  las crea sola, lo que falta es la aprobación, que la hace Meta.
- **El banner es lo único que hay de frontend.** No hay dashboard: ni
  auditoría de conversaciones, ni métricas, ni editor de horarios. El
  editor de tramos por día es el que más falta — es la acción del único
  issue bloqueante y hoy no se puede hacer desde la interfaz.
- **`public/` no tiene tests.** El banner se verificó a mano en un
  navegador (temas claro y oscuro, 360px, el flujo de guardar país y
  aplicar feriados), pero no hay nada automatizado. Falta un runner de
  browser; `vitest` solo corre los tests de `tests/`, que son de backend.
- **El catálogo de feriados cubre 20 países**: América Latina de habla
  hispana, Brasil y Estados Unidos (`prisma/seed.ts` → `SEED_COUNTRIES`;
  sumar uno más se hace desde la pantalla "Países", sin tocar código). Las
  listas son deliberadamente incompletas donde la ley no se puede expresar
  con las tres reglas — ver "Feriados nacionales precargados". Dos cosas
  quedaron para revisar con una fuente primaria: el Día de la Madre y el
  Día del Padre de El Salvador (excluidos: las fuentes se contradicen sobre
  si son asueto nacional privado) y el 22 de enero de Bolivia (excluido
  porque el Ejecutivo lo corrió por decreto en 2026, pero es feriado
  permanente: si se observa en fecha los próximos años, conviene
  incluirlo). Y un aviso: Perú tiene un dictamen aprobado en comisión para
  trasladar feriados al lunes; si se promulga, sus 16 reglas dejan de
  valer.
- ~~Falta un lead time mínimo configurable~~ **Hecho (2026-11-13)**: ver
  "Anticipación mínima para reservar".
- ~~`dateKeyToUtcMidnight()` corre en silencio los días imposibles~~ **Resuelto (2026-11-13)**:
  ahora devuelve `null` para un día que no existe en su mes (`2030-02-31`, `2030-04-31`), comprobando que
  la fecha vuelva a dar el mismo texto. Los llamadores ya manejaban el `null`, así que una excepción por
  fecha mal tipeada se rechaza en vez de cerrar otro día.
- ~~Si falla la llamada a Claude, el paciente no recibe nada~~ **Resuelto
  (2026-11-13)**: `runAgentTurn()` reintenta UNA vez la primera interpretación
  tras `MODEL_RETRY_DELAY_MS` (15 s; avisa antes con `AVISO_DE_ESPERA` para que el
  paciente no vea silencio) y, si vuelve a fallar,
  `atenderFallaDelModelo()` registra la derivación (fila + mail, con el mensaje
  textual y el error) y manda una disculpa fija (`DISCULPA_POR_FALLA`, español
  neutro, no pasa por el modelo). Se reintenta solo esa llamada y no el turno
  entero: hasta ahí no se escribió nada, así que repetirla no duplica turnos ni
  historial. Antes el error subía al `catch` del webhook, que solo lo logueaba,
  y como el lote ya estaba borrado de la cola ni `inbound-sweeper` lo rescataba
  (pasó el 2026-09-12). Ojo: **no cubre** fallos de la base antes de esa
  llamada (historial, catálogo), que siguen subiendo al webhook.
  **Si el proceso muere durante los 15 s de espera ya no se pierde el mensaje
  (2026-11-13):** antes de esperar, el turno vuelve a poner el mensaje en la cola
  (`requeueMessageForRetry()`) y lo reclama al volver (`reclaimRequeuedMessage()`, un
  `DELETE` por id). Si el proceso murió, `inbound-sweeper` lo rescata a los 2 minutos como a
  cualquier lote abandonado; si lo tomó el barrido o el turno de un mensaje nuevo que lo juntó
  en su lote, el turno original **cede** (no reintenta ni contesta) para no duplicar la
  respuesta. Es seguro repetirlo porque hasta ahí no se escribió nada. Si no se puede guardar el
  respaldo se reintenta igual, como antes. Lo que no cubre: un proceso que muere DURANTE el
  segundo intento (la misma exposición que tiene cualquier turno una vez tomado el lote).
- ~~`Package` (paquetes de sesiones) no tiene lógica~~ **Hecho (2026-11-13)**:
  ver "Paquetes de sesiones". Queda afuera: que el asistente de WhatsApp sepa
  cuántas sesiones le quedan al paciente y lo diga, y el cobro del paquete
  (`payments.ts` sigue siendo un stub).
- **PENDIENTE (plan Plus, anotado el 2026-11-20): cobro de seña/adelanto al agendar (`deposito_sena`).** Hoy la feature
  figura en el catálogo de planes y en la descripción del plan Plus, pero **no hace nada**: `services/payments.ts` es un stub
  (`createDepositLink()` lanza un error y nadie la llama). **No vender ni prometer la seña mientras no esté**: en el piloto la
  clínica va en Base. Antes de implementarla hay que resolver: (1) **pasarela por país** (Mercado Pago, Stripe u otra: depende
  de dónde cobre cada clínica y de que el dinero vaya a la cuenta de la CLÍNICA, no a la nuestra); (2) el flujo: link de pago
  al confirmar el horario, turno retenido con tiempo límite (ej. 30 min) y liberado si no se paga, `Appointment.depositPaid`,
  y la confirmación final y el espejo en el calendario recién al pagar; (3) el webhook de confirmación de pago (ruta pública:
  firma verificada, idempotente, y fuera de la API auditada, así que registrar el hecho con `recordSystemAudit()` y un
  `AppointmentEvent`); (4) el monto (`Clinic.depositPercentage`, default 30, o un valor por servicio) y qué pasa al cancelar o
  reprogramar (reembolso o crédito); (5) credenciales de la pasarela cifradas por clínica, como el token de WhatsApp;
  (6) lo cobrado en los reportes y los costos de la pasarela en "Costos"; (7) el prompt: que el asistente explique la seña sin
  inventar importes ni condiciones, y que el cobro del paquete se resuelva con el mismo mecanismo. Mientras tanto,
  conviene quitar "cobro de seña" de la descripción del plan Plus en `prisma/seed.ts`, o aclarar que está próximamente.
- **Falta el frontend de configuración de calendarios.** La API ya está
  completa, OAuth incluido: `GET /dashboard/clinics/:id/calendars` (estado
  + link para conectar), `GET .../google-accounts/:id/calendars` (lista
  para el selector), los dos `PUT` para enlazar, y el `DELETE` para
  desconectar una cuenta. Falta la pantalla.
- **Autenticación del OAuth de Google.** `/oauth/google/start` y `/callback`
  exigen sesión y `calendarios.editar` sobre la clínica
  (`userCanAccessClinic()`), y el `state` firmado lleva el `userId` de quien
  inició el flujo: el callback rechaza a otra sesión. Antes cualquiera con el
  id de una clínica podía conectarle su propia cuenta de Google. No se puede
  mandar el link suelto a la clínica: tiene que abrirlo un usuario logueado.
- **Solo hay integración con Google Calendar, y no puede ser la única.** La
  plataforma se piensa comercializar, y muchas clínicas llevan su agenda en
  Outlook o en un software de gestión propio. Pendiente, en este orden:
  1. ~~Interfaz de proveedor~~ **hecha**: `services/calendar-providers/types.ts`
     define `CalendarProvider` (crear/borrar evento, leer bloqueos, manejar
     una cuenta revocada); `services/calendar.ts` despacha por
     `target.provider`. Registrados: Google y Microsoft. Al sumar otro
     (Dentalink): implementar la interfaz, registrarlo en `PROVIDERS`,
     ampliar `CalendarProviderId` / `CalendarProviderKind` (enum de Prisma)
     y su rama en `chooseCalendarCredential()` y en el dashboard. **Deuda
     de nombres, sin migrar a propósito:** `Professional.googleCalendarId`,
     `Professional.googleAccountId`, `Appointment.googleEventId` y
     `CalendarBlock.googleEventId` guardan datos de cualquier proveedor; se
     renombran cuando haya un tercero, no antes.
  2. **Dentalink** (software de gestión dental): es la prioridad comercial,
     porque ya existe un agente de la competencia integrado con él. A
     diferencia de un calendario, hay que leer disponibilidad y crear turnos
     en su sistema. No hay documentación pública de su API: pedir acceso a la
     empresa antes de diseñar.
  3. ~~Microsoft 365 / Outlook~~ **hecho en código, falta probarlo contra
     Microsoft real**: hay que crear la app en Entra ID (ver
     `docs/onboarding-clinica.md`) y correr el flujo completo una vez. Está
     probado solo con `fetch` simulado (`tests/microsoft-provider.test.ts`).
     Dos cosas sin verificar contra Graph: cómo devuelve las fechas de los
     eventos de día completo con `Prefer: outlook.timezone="UTC"` (hoy se
     interpretan como medianoche UTC), y que `calendarView` con
     `$expand=singleValueExtendedProperties($filter=...)` filtre como se espera.
  4. **Validar otras plataformas** con clínicas reales antes de construirlas
     (AgendaPro, Medilink, Doctoralia, Doctocliq) y un feed `.ics` como
     opción universal sin OAuth.
- **Falta la verificación del publicador de la app de Microsoft.** Sin
  ella, Microsoft le muestra a cada clínica una pantalla de "aplicación no
  verificada" al consentir, y las organizaciones con consentimiento de
  usuarios restringido pueden bloquearla. Se hace en Entra ID (Publisher
  verification) y exige una cuenta del programa de Microsoft para
  partners. Hay que completarla antes de vender la integración con Outlook
  a clientes reales. Es el equivalente a publicar la app de Google, que
  también se revisa por los scopes de Calendar.
- **Nombres históricos sin renombrar.** Estos campos nacieron cuando solo
  existía Google y hoy guardan datos de cualquier proveedor:
  `Professional.googleCalendarId`, `Professional.googleAccountId`,
  `Appointment.googleEventId` y `CalendarBlock.googleEventId`. Funciona,
  pero confunde: un profesional con Outlook tiene su calendario en un campo
  que dice "google". Se renombran con una migración cuando entre el
  tercer proveedor (Dentalink), para tocarlos una sola vez; hay que
  actualizar también el frontend (`CalendarsPage`) y los tests.
- **El OAuth de Google está probado solo en local y en modo Prueba.** Se
  corrió el flujo completo (2026-10-28): conectar la cuenta, canjear el code y
  guardar el refresh token cifrado. **Sigue sin probarse** que el espejo de un
  turno cree el evento y que `calendar-sync` importe un bloqueo contra un
  calendario real. Para producción falta, en orden:
  1. **Google Cloud Console** (proyecto de "ponticApp", Google Auth Platform):
     - **Publicar la app**: pasarla de "Prueba" a "En producción" en
       Público. En modo Prueba solo entran los usuarios de prueba y el refresh
       token **vence a los 7 días**, así que cada clínica tendría que
       reconectar una vez por semana.
     - **Verificación de Google**: los scopes `calendar.events` y
       `calendar.readonly` son sensibles, así que Google revisa la app. Se pide
       desde el Centro de verificación. Hay que completar Branding (nombre,
       logo, dominio de la app), una política de privacidad y unos términos de
       servicio públicos, y un video de la demo que muestre el uso de los
       scopes. Sin la verificación cada clínica ve "Google no verificó esta
       app", con un tope de 100 usuarios.
     - **Dominio autorizado y URI de redirección de producción**: agregar el
       dominio real en Branding y registrar
       `https://<dominio>/oauth/google/callback` en el cliente OAuth. Google
       exige HTTPS fuera de `localhost`. La de `localhost` puede quedar para
       desarrollo.
     - Confirmar que la **Google Calendar API** esté habilitada en ese
       proyecto.
  2. **En la aplicación** (en cada ambiente: staging y producción):
     - Cargar el ID de cliente, el secreto y la URI de producción en Catálogos →
       Secretos → "Google Calendar (OAuth)". No hace falta reiniciar. Si el
       ambiente usa el `.env` de respaldo, que no lleve las credenciales de
       desarrollo.
     - `PUBLIC_BASE_URL` apuntando al dominio real: de ahí salen los links de
       conexión que se le mandan a la clínica.
     - `CALENDAR_TOKEN_ENCRYPTION_KEY` propia de ese ambiente, generada con
       `openssl rand -hex 32`. Si es la misma que en local, los tokens de un
       ambiente se descifran en el otro.
  3. **Reconectar las cuentas** que se hayan conectado en modo Prueba, porque
     quedan con el refresh token de 7 días.
- **`GOOGLE_PLACES_API_KEY` es por ahora solo local.** Probada de punta a
  punta contra un link real (Places API "New", proyecto de Google Cloud
  con facturación activa) — funciona. Falta configurarla en cualquier
  otro entorno (staging/producción) además de local.
- **Todavía no hay ambientes de integración ni de producción (2026-11-13).**
  Hoy solo existe el desarrollo local. Cuando se creen, hay que hacer en cada uno,
  antes de levantar el código: `npx prisma migrate deploy` y `npm run db:seed` (da
  `monitoreo.ver` al "Super Admin"), y después reiniciar el servidor web y el
  worker. Doce migraciones de esta tanda (más `patient_import`, del 2026-11-20: columnas nuevas en `Patient`, no cambia datos) no están en ningún otro lado (la del chat de pruebas no necesita ninguna; la última es
  `campaigns`: las tablas `Campaign`, `CampaignTrigger` y `CampaignLead`, las columnas
  `Appointment.campaignId` y `Clinic.campaignFollowUpEnabled`, y unos CHECK del tope de seguimientos; no cambia
  datos; el `db:seed` además da `campanas.*` a los roles de clínica y **saca `auditoria.ver` de los de
  clínica**):
  `monitoring` (`SystemEvent`, `CronHeartbeat`), `clinic_min_lead_minutes`,
  `min_lead_default_60`, `package_sessions` (columnas nuevas en `Package` y
  `Appointment`, y un CHECK), `package_reminder` (`Clinic.packageReminderSentOn`),
  `patients_module` (campos nuevos de `Patient`, `PatientComment`, `PackageTemplate`
  y el contacto por clínica), `package_name` y `audit_log` (las tablas `AuditLog` y
  `AppointmentEvent`, los campos de cancelación de `Appointment` y el trigger que hace
  la auditoría de solo escritura; no cambia datos) y `agent_requests` (la tabla
  `AgentRequest`; no cambia datos) y `audit_origin` (la columna `AuditLog.origin`, que rellena
  las filas existentes con `panel` declarando mantenimiento para el trigger); `min_lead_default_60` y
  `patients_module` tocan datos (esta última parte el nombre de los pacientes
  existentes en nombre y apellido: es una heurística, ver "Pacientes"), y la primera
  **cambia datos** (lleva a 60 las clínicas
  que estén en 0), así que en una base con clínicas reales conviene un respaldo
  antes y decidir si alguna debe quedar sin mínimo. Cada ambiente necesita además
  su propio `.env` (ver los pendientes de producción de Google, el webhook y
  `CALENDAR_TOKEN_ENCRYPTION_KEY` propia).
- ~~El alta de un paciente por WhatsApp y el cambio de etapa del CRM no tenían auditoría~~
  **Hecho (2026-11-13)**: ver "El origen: lo que NO hace un usuario del panel". Queda por probar
  con una conversación real (caso AU-27) que el webhook, que no tiene tests, deja el rastro.
- **PENDIENTE — capturar la IP del dispositivo que hace el cambio (2026-11-13).** Hoy
  `AuditLog.ip` es `req.ip`, que detrás de un proxy o balanceador **es la del balanceador, no la
  del dispositivo**. Hay que configurar `trust proxy` en Express al desplegar (con el número de
  saltos real: mal configurado, `X-Forwarded-For` se puede falsificar) y verificar que lo que
  se guarda es la IP del cliente. Dos matices: (1) esto cubre lo que se hace **desde el panel**;
  (2) lo que se hace **por WhatsApp** llega por el webhook de Meta, así que la IP que se ve es
  la de Meta y **la del dispositivo del paciente no existe para nosotros**: en esos casos el
  origen que se puede registrar es el número de WhatsApp (conviene guardarlo hasheado o
  enmascarado, por ser un dato personal). Considerar también registrar el user agent (ya se
  guarda) y un identificador de sesión para los cambios desde el panel.
- **Auditoría: otros pendientes (2026-11-13).** (1) **Política de retención**: `AuditLog` no se
  borra nunca; hay que decidir cuánto se conserva (lo habitual es 1 a 2 años mínimo) y hacer el
  job que la aplique con `app.audit_maintenance`. (2) **Los jobs que modifican datos y no son del CRM** (el sync de
  calendario, los avisos que marcan "ya se avisó") no tienen registro de auditoría: revisar
  cuáles lo necesitan.
  (3) **Nada de lo anterior al 2026-11-13**: las cancelaciones y reagendados previos no se pueden
  recuperar. (4) **El motivo de cancelación por WhatsApp está hecho** (ver "El motivo de la
  cancelación por WhatsApp"), pero depende de que el modelo obedezca la regla: verlo con
  conversaciones reales (caso AU-20) y revisar en Monitoreo cuántas cancelaciones quedan sin
  motivo. (5) El siguiente paso es el **módulo de reportes** (canceladas, reagendadas, atendidos
  por profesional, no-shows, ocupación, motivos de cancelación, quejas…) y, después, un chat que
  use esas mismas consultas como herramientas fijas: ya están los datos.
- **Revisar la ventana horaria de los avisos por mail cuando haya clínicas en
  otras zonas horarias (2026-11-13).** `jobs/package-reminders.ts` manda el
  recordatorio de citas por paquete entre las 8 y las 18 **de cada clínica**
  (`REMINDER_FROM_HOUR` / `REMINDER_TO_HOUR`, iguales para todas), por analogía con
  los otros avisos y sin haberlo hablado con ninguna clínica. Con una sola zona
  alcanza; al sumar clínicas de otros países conviene ver si ese rango sirve para
  todas, y si hace falta que sea configurable por clínica (un campo en `Clinic`,
  no código condicional). Lo mismo vale para el resto de los jobs que dependen de
  una hora (`daily-report`, `config-alerts`, `calendar-access-alerts`,
  `secret-expiry-alerts`): hoy corren a una hora fija **del servidor**, no de la
  clínica, y el recordatorio de paquetes y el contacto por próxima cita sugerida
  (`jobs/next-visit-outreach.ts`, 9 a 18 de la clínica) son los únicos que ya
  respetan la zona. (`daily-reminders` y `two-hour-reminders` corren cada hora y calculan la
  ventana desde la hora en punto: no dependen de la hora ni de la zona del servidor, y la fecha y la
  hora que ve el paciente son las de la clínica.)
- **El sync de bloqueos relee la ventana completa cada 15 minutos.** Para
  pocas clínicas está bien; a escala conviene usar `syncToken` de la API de
  Google para traer solo los cambios.
- **Cómo cambiar la URL del webhook en producción sin dejar clínicas sin
  servicio.** Hoy en desarrollo la URL es la de un quick tunnel de Cloudflare y
  cambia cada vez que se reinicia `cloudflared` (2026-11-05), así que hay que
  reconfigurarla a mano en Meta. En producción, con varias clínicas, un cambio
  de URL deja de recibir mensajes a las que todavía apunten a la vieja mientras
  se termina de reconfigurar el resto — y es una falla silenciosa: el paciente
  escribe y nadie contesta. Cosas a resolver:
  1. Usar un dominio propio y estable (`PUBLIC_BASE_URL`) para que la URL casi
     nunca cambie; el túnel quick queda solo para desarrollo.
  2. Verificar cómo se configura el callback en Meta: por app (un solo cambio
     para todas) o con override por WABA (`subscribed_apps`, un cambio por
     clínica). Cada clínica tiene su propio WABA, así que puede ser lo segundo.
     Sin verificar todavía.
  3. Si es por WABA, un script que migre todas las clínicas de una vez
     (similar a `POST /platform/clinics/:id/whatsapp/templates`), y mantener la
     URL vieja respondiendo hasta que todas estén migradas (migración
     gradual, sin corte).
  4. Monitorear que sigan entrando mensajes por clínica, igual que con el
     worker apagado.
- **Quién hace qué servicio: falta lo que quedó afuera (2026-11-05).** Lo
  principal está hecho — ver "Qué profesional realiza qué servicio". Queda:
  (1) ~~migrar la regla del profesional principal~~ **hecho (2026-11-10)**: campos
  retirados; la migración frena si una clínica aún dependía de ella; (2) aprobar `aviso_configuracion` en Meta para que el WhatsApp de
  "servicio sin cubrir" salga; (3) las clínicas sin catálogo (texto libre en
  `Clinic.services`) no tienen nada que asignar y quedan sin restricción;
  (4) ~~un servicio con nombre coloquial que no matchea el catálogo se
  trata como "no ofrecido" y deriva~~ **Mitigado (2026-11-13)**: con catálogo
  cargado, el prompt le pide al modelo traducir lo que dijo la persona al
  nombre EXACTO del catálogo ("limpieza dental" → "Limpieza"), y cada derivación
  por `servicio_no_ofrecido` deja un evento `servicio_sin_match` en Monitoreo con
  el texto que devolvió el modelo. Falta mirar esos eventos con uso real para
  ver cuántos son falsos y ajustar el prompt.
- **Falta la plantilla de WhatsApp para avisar urgencias.** Hoy la derivación
  se registra y se avisa por mail; el aviso por WhatsApp a
  `Clinic.urgencyNotifyPhone` necesita una plantilla aprobada en Meta que
  todavía no existe.
- Los tests cubren la creación de turnos, el horario de atención, la
  conversión de zonas, el cálculo de huecos, el catálogo de servicios, las
  derivaciones y los precios de membresía (`tests/membership.test.ts` contra
  la base, `membership-pricing.test.ts` la lógica pura). **Jobs con tests propios
  (2026-11-13):** `calendar-sync` (`calendar-sync.test.ts`: qué importa, qué no toca, qué pasa
  cuando Google falla, el sync inmediato) y los recordatorios de 24 h y 2 h
  (`reminders.test.ts`: la ventana, la zona horaria, el plan, el aislamiento entre clínicas),
  además de `calendar-access-alerts`, `config-alerts`, `google-oauth-health`,
  `inbound-sweeper`, `next-visit-outreach`, `package-reminders`, `post-visit-followup`,
  `secret-expiry-alerts` y `tracked-cron`. **Las rutas de `oauth.ts`** (`oauth-routes.test.ts`:
  sesión, permiso, aislamiento por clínica, `state` ajeno o adulterado, escapado del HTML) y **las
  puertas de TODA la API** (`route-guards.test.ts`) también tienen tests: este último recorre
  todas las rutas de `/dashboard` y `/platform` y comprueba que cada una exige sesión, permiso y
  clínica (estático y por HTTP), así que **una ruta nueva sin `requirePermission` hace fallar la
  suite**. `requirePermission()` le pone a su función el nombre `requirePermission:<permiso>`
  justamente para eso: no lo renombres. Las rutas de plataforma que no piden un permiso propio
  (hoy solo `POST /google-business/preview`) están listadas con su motivo en ese test.
  **Sin tests todavía:** `daily-report`, `system-events-cleanup` y `public/` (provisorio, no vale
  la pena). Lo que hacen las rutas de `platform.ts` por dentro (validar el body y delegar) no se
  prueba ruta por ruta: las reglas viven en los repos y servicios, que sí están cubiertos. Del
  webhook se testea `agent-turn.ts` con dependencias inyectadas, no el handler de Express.

## Cosas que no hay que hacer

- No traer una clínica o un profesional para espejar o borrar un evento sin
  `CLINIC_CALENDAR_INCLUDE` / `PROFESSIONAL_CALENDAR_INCLUDE`
  (`services/calendar.ts`). Sin la relación de la cuenta, el espejo no se
  crea y no hay error. Un proveedor nuevo se suma en esas constantes.
- No devolver el valor de un `PlatformSecret` por ninguna API, ni cifrado, ni
  descifrarlo fuera de `getPlatformSecretValue()`.
- No guardar el refresh token de Microsoft sin esperar la escritura: Microsoft
  lo ROTA en cada uso, y perder el nuevo desconecta la cuenta
  (`microsoft-auth.ts`). Tampoco refrescar en paralelo la misma cuenta.
- No asumir que un calendario de Microsoft puede usar la cuenta de servicio:
  no existe. Sin cuenta conectada no hay espejo (`resolveCalendarTargetForProfessional()`
  devuelve null y la pantalla muestra "sin cuenta").
- No consultar Google Calendar para decidir si hay un turno libre. La
  única lectura permitida del calendario es `jobs/calendar-sync.ts`, que
  copia bloqueos a Postgres en un job aparte — ver "La única lectura de
  Google Calendar" más arriba. Si aparece una llamada a `googleapis` dentro
  del camino de decisión de un turno, está mal.
- No guardar el título ni la descripción de los eventos de bloqueo. Solo el
  rango horario.
- No devolver ni loguear los tokens de OAuth. Los endpoints del dashboard
  exponen `email`, `scope` y `revokedAt` de una `GoogleAccount`, nunca las
  columnas `*Encrypted`.
- No devolver `Clinic.whatsappTokenEncrypted` por ninguna API, ni siquiera
  cifrado, ni en la respuesta del alta. Para el panel están
  `listAllClinics()` / `findClinicDetail()`, que ya lo sacan; si hace falta
  el token es para mandar un mensaje, y eso va por
  `findClinicWithWhatsAppCreds()` + `clinicWhatsAppCreds()`.
- No descifrar el token de WhatsApp fuera de `clinicWhatsAppCreds()`.
- No guardar un refresh token sin cifrar, ni meter
  `CALENDAR_TOKEN_ENCRYPTION_KEY` en la base o en el repo.
- No pedir el scope `calendar` completo en el flujo de OAuth — con
  `calendar.events` + `calendar.readonly` alcanza.
- No agregar una feature Plus ni una regla de rubro como código
  condicional sobre el nombre de una clínica — siempre un campo en
  `Clinic` (booleano, texto, o referencia).
- No agregar un booleano nuevo en `Clinic` para una funcionalidad que se
  activa o no según lo que pagó la clínica — eso va como una entrada más en
  `src/config/plan-features.ts` (`PLAN_FEATURES`) y se chequea contra
  `clinic.plan?.features`, no contra una columna nueva.
- No escribir `planId`, `membershipCost`, `membershipCurrency`,
  `membershipBillingPeriod`, `membershipPricing` ni `membershipReason` por
  fuera de `setClinicMembership()`. Se validan juntos y la base lo impone con
  un CHECK: escribirlos de a uno deja una clínica con costo y sin moneda (un
  500) o con un monto copiado del plan de otro. El `PUT` general de la clínica
  los rechaza a propósito.
- No leer `PlanPrice` para saber qué paga una clínica. Lo que paga está en
  `Clinic.membershipCost`, copiado: la lista es solo el precio de hoy para una
  clínica nueva, y usarla como fuente le aplicaría cada aumento a todo el
  mundo — exactamente lo que este diseño evita.
- No dejar de cobrarle a una clínica sacándole el plan. Eso le apaga las
  funcionalidades que tiene contratadas (los jobs filtran por
  `clinic.plan?.features`): va `pricing: "exonerada"` con su motivo, que
  conserva el plan.
- No usar un costo en cero como "no le cobramos" ni como "todavía no le
  pusimos precio". Son dos estados distintos y explícitos (`exonerada` con
  motivo, y `membershipPricing: null`), y un cero no distingue ninguno de los
  dos.
- No programar un `cron.schedule()` en `src/index.ts` ni en ningún lado del
  camino del servidor web. Los crons van en `src/worker.ts`, que corre como
  un proceso aparte del que hay una sola instancia — si no, cada instancia
  del webhook manda los recordatorios de nuevo y el webhook deja de poder
  escalar.
- No dejar un `await` de correo (`sendMail`, invitaciones, recuperar contraseña) sin `try/catch` dentro de un handler `async` de Express 4: un SMTP mal configurado es una promesa rechazada sin manejar y **mata el proceso web** (pasó en el primer despliegue, 2026-11-24). Usar `trySendUserInvitation()` o capturar y registrar `correo_envio`.
- No registrar en `SystemEvent` el texto de un mensaje, un teléfono ni un
  nombre de paciente: solo clínica, tipo y error. Y `recordSystemEvent()` no
  puede lanzar nunca.
- No mandarle al asistente observaciones, comentarios o historial de una persona
  que no sea de ESE número, ni sin acotar el largo y la cantidad
  (`prompts/patient-history-context.ts`): todo eso se envía a la API del modelo. Y no
  hacer que el asistente cite las notas internas.
- No contactar por iniciativa de la clínica a quien tiene `outreachOptOut`, ni
  mandar `proximo_control` sin el interruptor `Clinic.nextVisitOutreachEnabled`
  prendido, ni reintentar toda la tanda cuando falla el envío.
- No escribir `Patient.name` por fuera de la ficha sin mantener `firstName` /
  `lastName` coherentes: `name` es el canónico y se recalcula desde las partes.
- No armar un paquete nuevo por cada paciente: se asigna uno del catálogo.
- No llamar a la API del modelo por fuera de `interpretWithClient()` (o sin `trace`): cada
  solicitud al agente tiene que dejar su `AgentRequest`. Y no guardar ahí el prompt, el mensaje
  del paciente, la respuesta, nombres ni el motivo de cancelación en texto.
- No condicionar ni demorar una cancelación por WhatsApp a que el paciente cuente el motivo, ni
  insistir si no quiere contarlo, ni dejar que una queja al cancelar quede sin llegar a una persona.
- No escribir `Patient.stage` por fuera de `updatePatientStage()` ni llamarla sin su contexto
  (`origin` y `motivo`), ni crear o renombrar una ficha por WhatsApp sin registrarlo: el alta y
  cada cambio de etapa se auditan con su origen. Y no guardar en esos registros el teléfono, el
  nombre ni el mensaje del paciente.
- No dejar una operación que modifica datos sin registro de auditoría, ni
  desmontar o saltear `auditRequests` en `src/index.ts`, ni mover el middleware después
  de los routers (no vería lo que los routers resuelven). Y no dejar sin registrar lo que
  hacen los jobs, el asistente o un script: no pasan por el middleware.
- No guardar en `AuditLog` ni en `AppointmentEvent.details` valores de lo que se escribió
  (observaciones, teléfonos, nombres, tokens, contraseñas) ni la URL cruda con su query
  string: solo nombres de campos, ids y datos estructurados no sensibles.
- No editar ni borrar filas de `AuditLog` (el trigger lo impide, y el código no debe
  intentarlo); ni usar `app.audit_maintenance` fuera de la limpieza de tests y de la
  política de retención.
- No contar como cancelación una cita con `cancelledByKind: "reprogramacion"`, ni como
  reserva nueva una cita con `rescheduledFromId`: se dio de baja o se creó porque el
  paciente la MOVIÓ.
- No escribir un `AppointmentEvent` fuera de la transacción que hace el cambio.
- No descontar una sesión de un paquete al agendar ni cuando `status` pasa a
  `atendido`: ese estado lo pone solo el job de seguimiento a las 24 horas y no
  prueba que el paciente haya ido. El saldo solo lo mueve
  `markAppointmentAttended()` (una persona confirmando). Y no escribir
  `Package.usedSessions` por fuera de `services/packages.ts`: el descuento es
  condicionado y serializable a propósito.
- No permitir crear un paquete sin elegir un servicio del catálogo de la clínica
  (ni con un nombre escrito a mano), ni atar solo a uno heredado sin servicio
  (`findPackageForBooking()` exige el mismo `serviceId`), ni usar el paquete de un
  paciente en la cita de otro.
- No usar un teléfono `prueba:` fuera del chat de pruebas, ni escribirle a un paciente de prueba desde un job nuevo
  (excluirlo con `SANDBOX_PATIENT_FILTER`), ni dejar que el turno del chat de pruebas avise a un profesional, espeje en un
  calendario, guarde una derivación o mande un WhatsApp: esos efectos van detrás de `skipExternalEffects` / `deps.sandbox`.
- No agregar una ruta a `/dashboard` sin `requirePermission(...)` ni a `/platform` fuera del
  guard `authenticate, requireSuperAdmin` del principio del router, ni renombrar la función que
  devuelve `requirePermission()`: `tests/route-guards.test.ts` las recorre todas por esa puerta.
- No dejar el cuerpo de un cron sin `try/catch` propio (incluida la query
  que trae las clínicas). Una promesa rechazada sin manejar mata el proceso
  entero en Node ≥15, y con eso se caen los quince jobs. Los crons se programan
  con `trackedCron()` (`jobs/tracked-cron.ts`), que ya trae ese try/catch y el
  latido de Monitoreo.
- No mandar recordatorios ni seguimientos con `sendTextMessage`. Tampoco
  los avisos de configuración: van por `Clinic.configAlertTemplateName`.
- No cargar feriados solos al dar de alta una clínica. Se sugieren y la
  clínica confirma — hay clínicas que atienden algunos feriados.
- No inferir `Clinic.country` de la zona horaria en runtime. La inferencia
  solo propone un valor al dar de alta; después el campo es explícito.
- No contestar un mensaje entrante apenas llega. Va por
  `services/inbound-queue.ts`: se encola y se contesta el lote cuando el
  paciente deja de escribir — si no, una idea partida en dos mensajes
  recibe dos respuestas, y ninguna ve a la otra.
- No reemplazar ese buffer por un `setTimeout` y un Map en memoria. El
  servidor web corre en N instancias y dos mensajes seguidos pueden caer en
  instancias distintas.
- No volver a identificar a un `Patient` por su teléfono. Un número tiene
  varias fichas; para la conversación va `getOrCreateConversationPatient()`
  (el titular) y para el turno `resolvePatientForBooking()` (la persona).
- No usar `nombre_paciente` para nombrar al paciente de un turno: ese campo
  es cómo se llama QUIEN ESCRIBE. El del turno es `paciente_del_turno`.
- No volver a hacer del título del profesional un campo de texto libre, ni
  cargarle a una clínica un catálogo propio de títulos. El catálogo es
  global y lo administra el super-admin; la clínica solo usa los que le
  habilitaron. Ver "El título del profesional".
- No permitir desactivar un título que algún profesional tenga puesto, ni
  quitárselo a una clínica que lo esté usando. La ficha quedaría con un
  título que ningún desplegable ofrece, así que no habría forma de
  corregirla.
- No dejar que el agente diga qué cubre un seguro, ni si un tratamiento
  está cubierto, ni cuánto va a pagar el paciente. La cobertura depende del
  plan de cada persona, así que no hay dato correcto a nivel clínica: esas
  preguntas escalan. Ver "Seguros".
- No agregar un campo de texto libre ni un documento adjunto con las
  condiciones de los seguros para que las lea el prompt. Es el error de
  `Clinic.businessHours`, y un PDF no le sirve al agente en la conversación.
- No sacar el filtro por `clinicId` de ninguna query.
- No buscar un `Appointment` por el id que devolvió el modelo sin acotar
  además por `clinicId` y `patientId`. Ese id lo escribe Claude a partir de
  lo que dijo el paciente: por id solo, nombrar un id ajeno alcanzaría para
  cancelarle el turno a otra persona.
- No crear un `Appointment` con `prisma.appointment.create()` suelto. Va
  siempre por `services/booking.ts`, dentro de la transacción serializable
  — si no, se duplican turnos con dos mensajes simultáneos.
- No armar un `startTime` con `new Date("...")` a partir de lo que dijo el
  paciente. Va por `services/time.ts`, que aplica `Clinic.timezone`.
- No volver a agregar un campo de texto libre con el horario. Existió
  (`Clinic.businessHours`, lo leía el prompt) y se eliminó: se
  desincronizaba de `WorkingHours` y el bot anunciaba un horario que el
  sistema después rechazaba. El texto que ve el modelo se genera con
  `describeWorkingHours()` desde el mismo dato que se valida.
- No calcular el día de la semana ni la hora con métodos locales de `Date`
  (`getDay()`, `getHours()`). Usan la zona del servidor. Va por
  `clinicWeekday()` / `clinicMinutesFromMidnight()` de `services/time.ts`.
- No agregar un concepto de "descanso" o "horario de comida" separado. Es el
  hueco entre dos tramos de `WorkingHours`.
- No meter una llamada a Google Calendar adentro de la transacción de
  creación del turno.
- No debilitar las reglas de escalamiento a humano del system prompt.
