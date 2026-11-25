# Despliegue a producción (piloto con una clínica)

Arquitectura: **dos procesos** de la misma imagen (`Dockerfile`) y una base Postgres.

| Proceso | Comando | Instancias |
|---|---|---|
| Servidor web (API, webhook, SPA en `/app`) | `npm start` | 1 o más |
| Worker (crons, recordatorios, sync de calendario) | `npm run start:worker` | **exactamente 1** |

`render.yaml` describe todo para Render. En Railway o un VPS es lo mismo: dos servicios con esa imagen y distinto comando.

## 1. Repositorio en GitHub
1. Crear un repositorio **privado** vacío en GitHub.
2. `git init` ya está hecho. Revisar `git status`: **no debe aparecer `.env`** (está en `.gitignore`).
3. Primer commit y `git remote add origin ...` + `git push -u origin main`.
4. Si alguna vez un secreto llegó a un commit, rotarlo: borrarlo después no lo saca del historial.

### Antes del primer push: los `package-lock.json` apuntan al registro privado de la empresa
Los dos lockfiles (`package-lock.json` y `frontend/package-lock.json`) tienen las URLs de descarga en `tr1.jfrog.io`
(el registro interno), que un servidor público no puede alcanzar: `npm ci` falla (verificado con `docker build`). Hay que
reemplazar `https://tr1.jfrog.io/artifactory/api/npm/npm/` por `https://registry.npmjs.org/` en ambos (los hashes de
integridad no cambian) y volver a probar `docker build -t clinica-test .`. Además evita publicar la URL interna en GitHub.

## 2. Crear los servicios (Render)
1. New → Blueprint → elegir el repositorio. Lee `render.yaml` y crea base, web y worker.
2. Cargar los secretos marcados `sync: false` en **los dos** servicios (web y worker usan las mismas variables).
3. Elegir región cercana a la clínica y revisar el plan de la base: tiene que incluir **respaldos** y no pausarse por inactividad (los gratuitos suelen hacerlo).

## 3. Variables de entorno (valores propios de producción)
Generar con `openssl rand -hex 32`: `JWT_SECRET` y `CALENDAR_TOKEN_ENCRYPTION_KEY`. **No reutilizar los de desarrollo.**
Guardar `CALENDAR_TOKEN_ENCRYPTION_KEY` en un lugar seguro aparte: si se pierde, hay que volver a cargar el token de WhatsApp de cada clínica y reconectar los calendarios.

| Variable | Valor |
|---|---|
| `DATABASE_URL` | la de la base de Render (el blueprint la conecta) |
| `WHATSAPP_VERIFY_TOKEN` | un texto largo al azar; el mismo que se pone en Meta |
| `ANTHROPIC_API_KEY` | clave de producción |
| `PUBLIC_BASE_URL`, `FRONTEND_URL` | `https://tu-dominio` (sin barra final) |
| `SMTP_*` | un SMTP real (Mailhog es solo de desarrollo) |
| `TRUST_PROXY_HOPS` | ver abajo |
| `GOOGLE_PLACES_API_KEY` | opcional |

Las credenciales de OAuth de Google y de Microsoft **no** van al `.env`: se cargan en la app, en Catálogos → Secretos.

### `TRUST_PROXY_HOPS`
Sin esto, la IP que ve el servidor es la del proxy: el límite de intentos de login cuenta a todos como una sola persona y la auditoría guarda una IP que no es la del usuario. Es la cantidad de proxies **entre el usuario y la app**: **En Render la cantidad real es 3** (verificado el 2026-11-25 con la URL `onrender.com`, sin dominio propio): con 1, Auditoría guardaba IPs `172.71.x.x` (de Cloudflare, que cambian en cada evento); con 2, una IP interna `10.x.x.x` de Render; con 3, la IP pública real. **Si se conecta un dominio propio con el proxy naranja de Cloudflare, puede cambiar** (un salto más): volver a comprobarlo. Mal puesto, `X-Forwarded-For` se puede falsificar. Después de desplegar, entrar al panel y comprobar en Auditoría que la IP guardada es la tuya.

## 4. Base de datos
Las migraciones corren solas antes de cada despliegue (`preDeployCommand: npx prisma migrate deploy`). La primera vez, además, **una sola vez** y desde una consola del servicio web:

```
npm run db:seed        # roles, permisos, planes, países, títulos, seguros
```

Después crear el primer super-admin (`prisma/seed.ts` / script correspondiente) y la clínica desde el panel ("Crear clínica").
Hay migraciones que tocan datos (ver "Todavía no hay ambientes…" en CLAUDE.md): en una base vacía no importan.

## 5. Dominio (Cloudflare como DNS)
1. En Render, agregar el dominio propio al servicio web; muestra un `CNAME`.
2. En Cloudflare → DNS, crear ese `CNAME`. Empezar con el proxy **desactivado** (nube gris) hasta que el certificado esté emitido; después se puede activar (y volver a comprobar `TRUST_PROXY_HOPS`: hoy vale 3 con la URL de Render).
3. Comprobar `https://tu-dominio/health` → `ok`.

## 6. Meta (WhatsApp)
1. Webhook: `https://tu-dominio/webhook`, con el `WHATSAPP_VERIFY_TOKEN` de producción. Suscribir el campo `messages`.
2. Token **permanente** de un usuario del sistema (Meta Business → Usuarios del sistema), no el temporal de 24 h. Cargarlo en la clínica desde el panel.
3. Crear las plantillas en el WABA de la clínica (`POST /platform/clinics/:id/whatsapp/templates`) y esperar la aprobación. Ver cuáles quedaron `REJECTED`.
4. El número real de la clínica tiene que estar fuera del modo de pruebas (sin la lista de números permitidos).

## 7. Google Calendar
Publicar la app de Google (de "Prueba" a "En producción") y registrar `https://tu-dominio/oauth/google/callback` como URI de redirección. Detalle en CLAUDE.md, "El OAuth de Google está probado solo en local".

## 8. Verificación posterior
- `/health` responde; el login funciona; la IP de Auditoría es la real.
- **El worker está corriendo**: Monitoreo → worker "vivo". Si no corre, no salen recordatorios y nadie avisa.
- Mandar un WhatsApp de prueba y ver la respuesta; revisar Monitoreo → Solicitudes al asistente.
- Probar un respaldo: saber cómo se restaura la base *antes* de necesitarlo.
- Cargar las tarifas en Costos → Tarifas.

---

# Lista de verificación previa al piloto con datos reales

Marcar cada punto antes de conectar el número de la clínica. Los puntos 1 y 2 son bloqueantes.

## 1. Privacidad y legalidad (bloqueante)
- [ ] Confirmar con alguien con criterio legal qué exige la ley de protección de datos del país de la clínica (datos de salud).
- [ ] Política de privacidad y términos de servicio revisados por un abogado y publicados (borradores en `docs/legal/`).
- [ ] Acuerdo escrito con la clínica: qué datos se tratan, quién es responsable, qué pasa al terminar el piloto.
- [ ] Aviso de privacidad / consentimiento para los pacientes: sus mensajes pasan por Meta (WhatsApp) y por la API de Anthropic, y el asistente lee observaciones e historial de la ficha.
- [ ] Revisar las condiciones de retención de datos de la cuenta de Anthropic y de Meta.
- [ ] El personal de la clínica sabe que lo escrito en observaciones y comentarios lo lee un modelo (la pantalla ya lo avisa).

## 2. Respaldos y recuperación (bloqueante)
- [ ] Postgres de pago con respaldos automáticos (no el gratuito, que tiene límite de vida).
- [ ] **Restauración de prueba hecha** en una base aparte, antes del primer paciente.
- [ ] `CALENDAR_TOKEN_ENCRYPTION_KEY` guardada fuera de la base y fuera de GitHub (si se pierde, hay que recargar los tokens y reconectar los calendarios).
- [ ] Ningún secreto en el repositorio (`git status` limpio de `.env`; ver sección 1 de esta guía).

## 3. Monitoreo
- [ ] Monitor externo (UptimeRobot o similar) sobre `https://tu-dominio/health`, con aviso por mail.
- [ ] Monitoreo de la app: el worker figura "vivo".
- [ ] Revisar Monitoreo todos los días las primeras semanas: errores, cola de mensajes, derivaciones sin avisar.
- [ ] Los recordatorios llevan marca de "ya enviado" (no se duplican si el cron corre dos veces). Las citas que ya existían al desplegar no la tienen: la primera pasada puede repetir un aviso una sola vez.

## 4. Entorno de pruebas
- [ ] Segundo conjunto de servicios (otro nombre, otra base con datos de prueba) para probar cambios antes de producción.
- [ ] Nunca probar con el número ni los pacientes reales; el Chat de pruebas no manda nada a WhatsApp.

## 5. Qué dejar apagado al inicio
- [ ] La clínica del piloto en el plan **Base**: el contacto por próxima cita y el seguimiento de campañas son del plan Plus (y además tienen su interruptor, apagado hasta que Meta apruebe `proximo_control` y `seguimiento_campana`). Subir a Plus recién cuando estén aprobadas.
- [ ] `nextVisitOutreachEnabled` apagado hasta tener `proximo_control` aprobada en Meta.
- [ ] `campaignFollowUpEnabled` apagado hasta tener `seguimiento_campana` aprobada.
- [ ] Empezar solo con agendar, cancelar, reprogramar y recordatorios.
- [ ] Revisar conversaciones reales los primeros días (casos AU-20 y similares de `docs/casos-de-uso-y-pruebas.md`).

## 6. Configuración de la clínica
- [ ] Horario de atención cargado (sin horario no se agenda), feriados confirmados.
- [ ] Servicios, profesionales (con servicios asignados), espacios y equipos cargados; servicio de primera vez marcado.
- [ ] Destinatario de urgencias cargado (mail de guardia) y `adminPhone` para avisos de configuración.
- [ ] Calendarios conectados y un bloqueo de prueba importado.
- [ ] Plantillas de WhatsApp creadas en el WABA de la clínica y **aprobadas** (ninguna en `REJECTED` o reclasificada a Marketing).
- [ ] Token permanente de WhatsApp (usuario del sistema), número fuera del modo de pruebas.
- [ ] Usuarios de la clínica creados con el rol mínimo que necesitan.

## 7. Pacientes existentes
- [ ] Excel de la clínica (nombre, teléfono con código de país, fecha de la última visita) recibido y revisado.
- [ ] Simulación hecha (`scripts/import-patients.ts` sin `--apply`) y avisos revisados con la clínica.
- [ ] Respaldo de la base y restauración de prueba hechos **antes** de cargar (ver `docs/migracion-clinica.md`).
- [ ] Instantánea de la agenda de Google tomada (`scripts/calendar-snapshot.ts`) antes de la primera cita.
- [ ] Conocido el procedimiento de rollback (tabla en `docs/migracion-clinica.md`).

## 8. Seguridad
- [ ] `TRUST_PROXY_HOPS` correcto: la IP en Auditoría es la real.
- [ ] Contraseña del super-admin larga y única; sin usuarios de prueba en producción.
- [ ] `JWT_SECRET` y claves propias de producción (no las de desarrollo).
- [ ] Decidido el plazo de retención de la auditoría (hoy no se borra nunca).
