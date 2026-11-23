# Cómo dar de alta una clínica nueva

Pasos para sumar un cliente nuevo a la plataforma.

## 1. Número de WhatsApp de la clínica

**Cada clínica tiene su propio WABA (WhatsApp Business Account), del que es
dueña ella.** Nosotros tenemos una sola Meta App —la de la plataforma— con
un solo webhook, y quedamos autorizados a mandar y recibir en su nombre. El
ruteo lo hace `phone_number_id`.

Lo que NO hay que hacer es colgar los números de todas las clínicas de un
WABA nuestro: una suspensión se los lleva puestos a todos, los *messaging
limits* se comparten entre las clínicas del mismo portfolio, y el límite de
números por WABA/portfolio (≈20) corta el crecimiento enseguida.

Opciones para el alta:

- **Embedded Signup** (el camino para vender esto como SaaS, y desde 2026 el
  que Meta pide para altas nuevas): la clínica hace el onboarding desde una
  pantalla nuestra, usando nuestra Meta App como "Tech Provider". Al final
  obtenemos `waba_id`, `phone_number_id` y un token, sin que la clínica nos
  pase credenciales. Requiere, una sola vez y con tiempo de anticipación:
  App Review con *advanced access* de `whatsapp_business_management` y
  `whatsapp_business_messaging`, y Business Verification (sin verificar son
  10 clientes nuevos cada 7 días; verificado, 200).
- **Manual**: para las primeras clínicas. La clínica comparte su WABA con
  nuestro business portfolio y de ahí sale un token de system user.

En los dos casos hay que guardar tres valores:

| Campo | Qué es |
|---|---|
| `whatsappPhoneNumberId` | El número. Es la clave con la que el webhook identifica la clínica. |
| `whatsappWabaId` | El WABA. Hace falta para crear y consultar sus plantillas. |
| `whatsappToken` | La credencial. **Se guarda cifrada** (`whatsappTokenEncrypted`). |

El token entra en texto plano por el alta (`POST /platform/clinics` o el
formulario) y se cifra al guardarlo; no se devuelve nunca más por la API.
Para rotarlo, mandar el nuevo en `PUT /platform/clinics/:id`.

**El número no puede estar activo en la app de WhatsApp Business** como
cuenta aparte, pero desde 2025 existe *coexistence*: la clínica puede seguir
usando la app en el celular con el mismo número que la API, con los chats
sincronizados. Pide que el número venga usándose en la app hace al menos 7
días.

## 2. Plantillas de WhatsApp

**Las plantillas son por WABA.** Como cada clínica tiene el suyo, una
plantilla aprobada en la clínica A no existe para la clínica B: hay que
crearla en cada una. (Este documento decía lo contrario; era incorrecto.)

No hace falta hacerlo a mano: **el alta las crea sola** si la clínica tiene
`whatsappWabaId` cargado. Para reintentar —Meta caído, WABA cargado después,
una rechazada que se corrigió—:

```
POST /platform/clinics/:id/whatsapp/templates   # crea las que falten (idempotente)
GET  /platform/clinics/:id/whatsapp/templates   # estado de cada una en Meta
```

El catálogo vive en `src/services/whatsapp-templates.ts` → `CLINIC_TEMPLATES`,
todas en categoría "Utility":

- **`recordatorio_turno`** (`Clinic.reminderTemplateName`) — el recordatorio
  al paciente. 4 parámetros: nombre, fecha, hora, servicio.
- **`seguimiento_post_consulta`** — el seguimiento del día siguiente (plan
  Plus). 2 parámetros: nombre, nombre de la clínica.
- **`aviso_configuracion`** (`Clinic.configAlertTemplateName`) — los avisos
  de configuración incompleta al número interno de la clínica. 3
  parámetros: nombre de la clínica, qué falta, link. Hasta que esté
  aprobada, ese aviso llega solo por email.

**Crear no es aprobar**: quedan en `PENDING` hasta que Meta las revise (de
minutos a un día) y recién ahí se pueden usar. Antes de prometerle a la
clínica que los recordatorios andan, mirar el `GET` de arriba: una en
`REJECTED` se ve, desde afuera, igual que un bug nuestro.

Si cambiás el texto de una plantilla, la cantidad de `{{n}}` tiene que
seguir coincidiendo con los parámetros que manda el job: Meta valida eso en
el envío y rechaza el mensaje si no coinciden.

## 3. Calendario de Google

Hay dos modos de acceso. **OAuth** es el recomendado; la **cuenta de
servicio** queda para las clínicas que ya estaban cargadas así.

Alcanza con una cuenta de Gmail común en los dos casos — **no** hace falta
Google Workspace.

### Modo OAuth (recomendado)

#### Una vez para toda la plataforma

1. Entrar a Google Cloud Console y crear un proyecto.
2. Habilitar la **Google Calendar API**.
3. En "Pantalla de consentimiento de OAuth", configurar la app. Mientras
   esté en modo "Prueba" solo pueden autorizar las cuentas que agregues
   como usuarias de prueba — para producción hay que publicarla, y como se
   piden scopes sensibles de Calendar, Google la revisa.
4. Crear credenciales → **ID de cliente de OAuth** → tipo "Aplicación web".
5. Registrar la **URI de redirección autorizada**, idéntica a la del
   `.env`:
   ```
   http://localhost:3000/oauth/google/callback
   ```
6. Cargar el ID, el secreto y la URI en la plataforma: **Catálogos →
   Secretos → "Google Calendar (OAuth)"** (como super-admin). Se verifican
   con Google, el secreto se guarda cifrado y se usan al instante, sin
   reiniciar. Alternativa (respaldo): completarlos en el `.env`, que solo se
   lee al arrancar:
   ```
   GOOGLE_OAUTH_CLIENT_ID=...
   GOOGLE_OAUTH_CLIENT_SECRET=...
   GOOGLE_OAUTH_REDIRECT_URI=http://localhost:3000/oauth/google/callback
   PUBLIC_BASE_URL=http://localhost:3000
   CALENDAR_TOKEN_ENCRYPTION_KEY=$(openssl rand -hex 32)
   ```

#### Microsoft 365 / Outlook (opcional)

Para las clínicas que llevan su agenda en Outlook. Es una sola app para toda
la plataforma, igual que la de Google:

1. Entrar a [Microsoft Entra](https://entra.microsoft.com) → **App
   registrations** → **New registration**.
2. **Supported account types**: "Accounts in any organizational directory
   and personal Microsoft accounts" (es lo que permite que cualquier clínica
   conecte la suya, y lo que corresponde a `MICROSOFT_OAUTH_TENANT=common`).
3. **Redirect URI** → tipo **Web**, idéntica a la del `.env`:
   ```
   http://localhost:3000/oauth/microsoft/callback
   ```
4. **API permissions** → Microsoft Graph → *Delegated*: `Calendars.ReadWrite`
   y `User.Read` (`offline_access` se pide en el flujo). No hacen falta
   permisos de aplicación ni consentimiento de administrador: cada clínica
   consiente para su propia cuenta. Una organización con consentimiento de
   usuarios deshabilitado necesita que su administrador lo apruebe una vez.
5. **Certificates & secrets** → New client secret. Se copia el **valor** al
   crearlo (después no se puede ver) y **vence**: cuando vence se cae el
   acceso de todas las clínicas hasta cambiarlo.
6. Completar en el `.env` (el secreto puede ir acá o guardarse desde la
   plataforma, ver más abajo):
   ```
   MICROSOFT_OAUTH_CLIENT_ID=...        # Application (client) ID
   MICROSOFT_OAUTH_REDIRECT_URI=http://localhost:3000/oauth/microsoft/callback
   MICROSOFT_OAUTH_CLIENT_SECRET=...    # opcional si se guarda desde la plataforma
   ```
7. Para producción, completar la **verificación del publicador** (Publisher
   verification); sin ella, Microsoft muestra a las clínicas una pantalla de
   "aplicación no verificada" al consentir.

A diferencia de Google, **no hay cuenta de servicio de respaldo**: sin una
cuenta conectada no hay espejo. La conexión se hace desde "Calendarios".

**Renovar el secreto (sin reiniciar nada).** En Catálogos → **Secretos** se
pega el valor del secreto nuevo junto con su fecha de vencimiento. Se
verifica contra Microsoft antes de guardarlo (un secreto mal pegado
desconectaría a todas las clínicas), se guarda cifrado y se usa al instante:
el servidor web y el worker lo toman, a lo sumo un minuto después. Lo
guardado manda sobre `MICROSOFT_OAUTH_CLIENT_SECRET`, que queda de respaldo.
Desde 7 días antes de la fecha se manda un mail diario a los administradores
de plataforma, hasta que se cargue la del secreto nuevo.

`CALENDAR_TOKEN_ENCRYPTION_KEY` cifra los refresh tokens en la base — y
también el token de WhatsApp de cada clínica, así que es obligatoria para
operar, no solo para los calendarios. Va fuera del repo, y si se cambia todas
las clínicas tienen que reconectar el calendario y recargar su token.

#### Por clínica

1. Quien conecta tiene que estar **logueado** y tener el permiso
   `calendarios.editar` sobre esa clínica (un usuario de la clínica, o el
   super-admin entrando a ella). Lo hace desde "Calendarios" → conectar
   cuenta; ya no se puede mandar el link suelto por mail, porque el flujo
   exige sesión (`conectarCuentaUrl` de
   `GET /dashboard/clinics/:clinicId/calendars`).
2. Autoriza con la cuenta de Google de la clínica, en el mismo navegador y
   con la misma sesión: el callback rechaza otra.
3. Pedir la lista de calendarios de esa cuenta:
   ```
   GET /dashboard/clinics/:clinicId/google-accounts/:accountId/calendars
   ```
4. Enlazar el elegido — uno por profesional:
   ```
   PUT /dashboard/clinics/:clinicId/professionals/:professionalId/calendar
   { "googleCalendarId": "...", "googleAccountId": "..." }
   ```
   o uno compartido para todo el equipo:
   ```
   PUT /dashboard/clinics/:clinicId/calendars/shared
   { "sharedCalendarId": "...", "googleAccountId": "..." }
   ```

Si la clínica revoca el acceso, la cuenta queda marcada con `revokedAt` y
hay que repetir el paso 1.

### Modo cuenta de servicio (el viejo)

1. Crear una **cuenta de servicio** en el proyecto de Google Cloud y
   generar una clave JSON.
2. Del JSON, al `.env`: `client_email` → `GOOGLE_CLIENT_EMAIL`,
   `private_key` → `GOOGLE_PRIVATE_KEY` (entre comillas; los `\n`
   literales están bien, `config/env.ts` los convierte).
3. La clínica comparte su calendario con ese email con permiso de
   **"Hacer cambios en los eventos"**.
4. Copiar el ID del calendario (Configuración del calendario →
   Integrar calendario → ID de calendario) y cargarlo sin `googleAccountId`.

Dos límites de este modo:

- La cuenta de servicio **no tiene calendario propio usable**. Siempre hay
  que escribir en un calendario compartido con ella; nunca en `primary`.
- Sin Workspace no puede mandar invitaciones a invitados. No molesta acá:
  el evento espejo no agrega `attendees`.

### Para probar

Crear un **calendario nuevo** en tu cuenta (no usar el personal). Con la
cuenta de servicio se puede saltear el flujo de OAuth pasándolo al script
de alta:

```bash
TEST_CALENDAR_ID=xxxx@group.calendar.google.com npx tsx scripts/add-clinic.ts
```

Conviene un calendario aparte por dos razones: los eventos de prueba no te
ensucian tu agenda real, y `jobs/calendar-sync.ts` va a leer ese calendario
e importar sus eventos como bloqueos.

### Ojo: los eventos personales frenan turnos

Todo evento en un calendario enlazado que no haya creado la plataforma
cuenta como tiempo ocupado, y el bot no va a ofrecer esos horarios (ver
"La única lectura de Google Calendar" en `CLAUDE.md`). Es lo que se quiere
cuando el profesional maneja una sola agenda para todo.

Si un evento **no** tiene que frenar turnos, marcarlo como **"Libre"** en
Google Calendar (Disponibilidad → Libre) y el sync lo ignora. Para apagar
esto por profesional, `Professional.blockSyncEnabled = false`.

## 3.5. Número interno para avisos

Cargar en `Clinic.adminPhone` el WhatsApp de quien administra el sistema
del lado de la clínica — **no** el de un paciente. Ahí van los avisos de
configuración incompleta (falta el horario, quedan feriados sin cargar),
que por email suelen pasar desapercibidos.

Es opcional: si queda en null, los avisos van solo a `Clinic.email`.

## 4. Alta en la base de datos

Completar `scripts/add-clinic.ts` con los datos de la clínica y correrlo:

```bash
npx tsx scripts/add-clinic.ts
```

O, si ya existe un panel de administración, cargarla desde ahí (ver
"Próximos pasos" en el `CLAUDE.md` — todavía no está construido).

## 5. Probar

Mandarle un WhatsApp de prueba al número de la clínica y confirmar que:
- El webhook identifica la clínica correctamente (revisar logs)
- Claude responde con el nombre y los horarios correctos de esa clínica
- Se puede agendar un turno y aparece en el calendario correcto
- El evento creado tiene el id del turno en la descripción, y ese id
  encuentra el detalle en
  `GET /dashboard/clinics/:clinicId/appointments/search?q=<id>`
- Si se crea un evento a mano en el calendario, después de correr el sync
  ese horario deja de ofrecerse
