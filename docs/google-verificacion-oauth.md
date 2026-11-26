# Verificación de la app de Google (OAuth): textos y guion del video

Preparado el 2026-11-25. Sirve para pedir la verificación de los permisos de Calendar y pasar la app de "Prueba" a "En producción"
(así el permiso de cada clínica deja de vencer a los 7 días). Los textos para los formularios de Google están **en inglés**, que es el idioma
de los revisores; las instrucciones son para ti, en español.

## 0. Antes de enviar (checklist)

- [x] Dominio `pontic.com.mx` verificado en Search Console (con la cuenta de Google dueña del proyecto de Cloud).
- [x] Página de inicio pública: `https://app.pontic.com.mx/`
- [x] Política de privacidad pública: `https://app.pontic.com.mx/privacidad` (sección 6: declaración de uso limitado)
- [x] Términos de servicio públicos: `https://app.pontic.com.mx/terminos`
- [ ] **Branding** en Google Cloud (Google Auth Platform → Branding): nombre «Pontic», correo de soporte, logo (`frontend/src/assets/icons/png/icon-color-512.png`), dominio autorizado `pontic.com.mx`, y las tres URL de arriba.
- [ ] **Clínica de demostración** con profesional, servicio, espacio y horario cargados (el video la usa).
- [ ] **Cuenta de Google de prueba** con un calendario, solo para el video. No grabes con tu cuenta personal.
- [ ] **Video** subido a YouTube como «No listado» (ver sección 3).
- [ ] La URI de redirección de producción registrada en el cliente OAuth: `https://app.pontic.com.mx/oauth/google/callback`.
- [ ] El cliente OAuth cargado en la plataforma (Catálogos → Secretos → «Google Calendar (OAuth)») y probado: conectar una cuenta de punta a punta.

### Decisión tomada (2026-11-26): se pide un permiso más estrecho
Se pedían `calendar.events` y `calendar.readonly`. Los revisores suelen preguntar *«¿por qué no un permiso más estrecho?»*, y había un punto débil:
**`calendar.readonly` da lectura de todo el calendario, pero solo se usaba para listar los calendarios** (para que la clínica elija uno). Se reemplazó por
**`calendar.calendarlist.readonly`**, que solo lista los calendarios (`GOOGLE_CALENDAR_SCOPES` en `src/services/google-auth.ts`). Las cuentas ya conectadas con
el permiso anterior siguen funcionando. **Antes de enviar, probar conectar una cuenta nueva de punta a punta** (el permiso nuevo también tiene que alcanzar para leer
el calendario «primary» y saber de qué cuenta es). La clasificación de cada permiso —sensible o no— se ve en la pantalla «Acceso a los datos» de Google Cloud; no la pude
confirmar fuera de ahí.

## 1. Datos para el formulario

| Campo | Valor |
|---|---|
| Nombre de la app | Pontic |
| Página de inicio | https://app.pontic.com.mx/ |
| Política de privacidad | https://app.pontic.com.mx/privacidad |
| Términos de servicio | https://app.pontic.com.mx/terminos |
| Dominio autorizado | pontic.com.mx |
| Correo de soporte y de contacto | avisos@pontic.com.mx |
| Tipo de usuario | Externo |

### Descripción de la app (App description / purpose)
```
Pontic is a WhatsApp appointment-scheduling assistant and admin panel for clinics and small healthcare practices in Mexico. Patients book, change
and cancel appointments by WhatsApp; clinic staff manage the schedule in a web panel. When a clinic connects its Google account, Pontic shows each
appointment on the professional's Google Calendar and reads the professional's existing busy time so the assistant never offers a time slot that is
already taken. Pontic does not use Google user data for advertising, does not sell it, and does not use it to train AI models.
```

## 2. Justificación de cada permiso (Scopes justification)

### `https://www.googleapis.com/auth/calendar.events`
*(El formulario de Google limita cada justificación a **1.000 caracteres**: esta versión mide 914. No la alargues.)*
```
Pontic shows clinic appointments on the calendar the clinic chooses, and avoids double booking.

1) Create/delete: when a patient books (WhatsApp assistant or staff panel), we create one event (events.insert); if it is rescheduled or cancelled we delete it (events.delete). Our events carry a private property with our appointment id, so we never touch events we did not create.

2) Read: every 15 min we read the next 60 days (events.list) to learn which time ranges are busy, so patients are not offered them. We ignore "Free", cancelled and declined events. For events we did not create we store ONLY start and end time. In a shared team calendar, title, color and attendee emails are read in memory only to tell which professional the time belongs to, then discarded, never stored.

A narrower scope cannot work: freebusy cannot create or delete events, and the calendar already exists (created by the clinic).
```
*(Si cambian a `calendar.events.owned`, ajustar la última frase: funcionaría solo con calendarios de los que la cuenta es propietaria; en un calendario compartido de Workspace donde la cuenta es editora, no.)*

### `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
```
Pontic uses this permission only to list the calendars of the connected Google account, so that the clinic can choose in a drop-down which calendar the
appointments are shown on. It is done once, when the clinic connects or changes its calendar. We do not read the content of other calendars with it.
```

## 3. Guion del video

**Requisitos de Google** (según su documentación de verificación de permisos sensibles): mostrar cómo el usuario inicia el flujo y concede el acceso, y
**cómo la app usa cada permiso**. Pantalla de consentimiento **en inglés**, con la **barra de direcciones visible** (que se vea el `client_id` y el nombre
de la app). Si el video no está en inglés, debe llevar **subtítulos en inglés**. Se sube a YouTube como «No listado» y se pega el enlace en el formulario.
Duración razonable: 3 a 5 minutos, sin cortes en la parte del consentimiento.

### Preparación (antes de grabar)
1. Pon el idioma de tu navegador y de la cuenta de Google de prueba en **inglés**, o agrega `&hl=en` a la URL del consentimiento.
2. **Antes de grabar**, crea en el Google Calendar de prueba un evento personal llamado «Personal» mañana de 10:00 a 11:00. Se usa en la escena 6.
3. Con la clínica de demostración ya creada y el usuario de la asistente listo. Abre el panel en una pestaña y Google Calendar en otra.
4. Cierra otras pestañas y notificaciones. Graba con la barra de direcciones visible (OBS, Xbox Game Bar o Teams).

### Escenas (Spanish: lo que haces · English: lo que dices o subtitulas)

**Escena 1: la app y la política (20 s)**
*Haces:* abre `https://app.pontic.com.mx/`, muestra la portada y el enlace a la política de privacidad; ábrela un momento y baja a la sección 6 («Google user data»).
*English:* "This is Pontic, a WhatsApp appointment assistant for clinics. This is our public home page and our privacy policy, including how we use Google user data."

**Escena 2: iniciar sesión y conectar (30 s)**
*Haces:* entra a `https://app.pontic.com.mx/app` con el usuario de la asistente; ve a **Calendarios** y pulsa conectar Google.
*English:* "A clinic staff member signs in to the Pontic panel, opens Calendars and starts connecting a Google account."

**Escena 3: el consentimiento (45 s) — la más importante**
*Haces:* en la pantalla de Google, **deja quieta la barra de direcciones unos segundos** (se ve el `client_id`), elige la cuenta, **muestra la lista de permisos** y pulsa Allow / Continue.
*English:* "Google shows the consent screen for the app Pontic. These are the two permissions requested: see, create and delete events, and see the list of calendars. The user grants access."

**Escena 4: elegir el calendario (20 s)** — uso de `calendar.calendarlist.readonly`
*Haces:* en Pontic, abre el selector y elige el calendario de prueba.
*English:* "Pontic lists the account's calendars so the clinic can choose where appointments are shown. This is the only use of the calendar-list permission."

**Escena 5: crear y borrar un evento (60 s)** — uso de `calendar.events` (insert y delete)
*Haces:* agenda una cita desde la **Agenda** del panel (o por WhatsApp con el número de pruebas); cambia a Google Calendar y muestra el evento nuevo, con el título «paciente — servicio (profesional)». Vuelve al panel, **cancela la cita** y recarga Google Calendar: el evento desaparece.
*English:* "When an appointment is booked, Pontic creates one event on the selected calendar. When it is cancelled, Pontic deletes that event. Pontic only touches events it created."

**Escena 6: evitar horarios ocupados (60 s)** — uso de `calendar.events` (list)
*Haces:* muestra el evento «Personal» que creaste de antemano en Google Calendar. Para que se importe al instante, en Calendarios vuelve a enlazar el calendario (eso dispara la sincronización inmediata). En la **Agenda**, muestra que esa franja aparece como **bloqueada y sin título**. Luego, en el **Chat de pruebas**, pídele al asistente una cita para mañana y muestra que **no ofrece** las 10:00.
*English:* "Pontic reads the busy time ranges of the calendar so the assistant does not offer taken slots. Only the start and end time are stored, never the title, description or attendees (in a shared calendar the title, color and attendees are read in memory only to tell which professional the time belongs to). Here, the personal event appears as a blocked time without a title, and the assistant does not offer that time to patients."

**Escena 7: desconectar (30 s)**
*Haces:* en Calendarios, desconecta la cuenta. Abre `https://myaccount.google.com/permissions` y muestra que el usuario también puede revocar el acceso desde su cuenta de Google.
*English:* "The clinic can disconnect its Google account at any time from Pontic, and can also revoke access from the Google Account permissions page."

### Si Google pide una cuenta de prueba para los revisores
Crea un usuario de demostración en la clínica de demostración y manda las credenciales **solo por el formulario**, nunca en el repositorio ni en un correo. Desactívala al terminar la revisión.

## 4. Después de enviar
- Google suele contestar por correo en **3 a 5 días hábiles**; si pide ajustes, responde desde el mismo hilo o desde el Centro de verificación.
- **Mientras esté en revisión**, la app puede seguir en modo Prueba (reconectar cada 7 días).
- **No cambies** los textos de la política ni de las URL durante la revisión, y no borres el registro de verificación del dominio.
- Si la verificación se aprueba, pasa la app a «En producción» y **reconecta las cuentas** conectadas en modo Prueba: su permiso es el de 7 días.
- Si cambian los permisos que pide la app, hay que **volver a verificar**.
