# Agente de WhatsApp — multi-clínica, multi-rubro

Plataforma que atiende pacientes/clientes por WhatsApp para múltiples
clínicas clientes, desde un único backend. No tiene nada específico de un
rubro puntual — sirve tanto para una clínica dental como para un spa
estético u otro negocio con turnos. Ver `CLAUDE.md` para el contexto
completo y `docs/onboarding-vertical.md` para configurar un rubro nuevo.

## Setup rápido

```bash
npm install
cd frontend && npm install && cd ..   # dependencias de la SPA de administración
cp .env.example .env      # completar con las credenciales globales de la plataforma
docker compose up -d db mailhog   # Postgres (5433) y SMTP de prueba (ver http://localhost:8025)
npm run db:generate
npm run db:migrate        # aplica las migraciones y corre el seed de permisos/roles en dev
npx tsx scripts/add-clinic.ts   # dar de alta al menos una clínica de prueba
SUPER_ADMIN_EMAIL=vos@ejemplo.com SUPER_ADMIN_NAME="Tu nombre" npx tsx scripts/create-super-admin.ts
npm run dev   # levanta la API (puerto 3000), el worker de tareas programadas y la SPA
```

Son dos proyectos npm independientes (raíz y `frontend/`), sin workspaces
— por eso el `npm install` se corre en los dos. `npm run dev` los levanta
juntos con `concurrently`; para correrlos por separado: `npm run dev:api`,
`npm run dev:worker` y `npm run dev:web`.

## Los dos procesos de backend

El backend se despliega como **dos procesos** que comparten el mismo código
y el mismo `.env`:

| Proceso | Comando | Instancias |
|---|---|---|
| Servidor web (webhook, dashboard, OAuth, SPA) | `npm start` | las que hagan falta |
| Tareas programadas (recordatorios, reporte diario, sync de calendario, avisos) | `npm run start:worker` | **exactamente una** |

Están separados para que el servidor web se pueda escalar horizontalmente:
si los crons vivieran ahí, una segunda instancia le mandaría cada
recordatorio dos veces a cada paciente. Ver "Dos procesos" en `CLAUDE.md`.

Si el worker no está corriendo, la plataforma sigue atendiendo pacientes,
pero nadie recibe recordatorios ni reportes y los bloqueos de Google
Calendar dejan de importarse — conviene monitorearlo.

El script de super-admin no asigna contraseña: manda una invitación por
email (en desarrollo, revisarla en Mailhog) con un link para elegirla.

Los tests van contra ese Postgres, así que hay que tenerlo levantado:

```bash
npm test
```

## Frontend

El panel de administración (login, gestión de usuarios/roles/permisos) es
una SPA en `frontend/` (React + Vite), servida en `/app`. En producción se
buildea con `npm run build` (que además corre `tsc` y el build de Vite) y
Express la sirve como estático desde `frontend/dist`.

El banner de configuración incompleta en
`http://localhost:3000/ui/?clinicId=<id>` sigue existiendo aparte — ahora
requiere haber iniciado sesión en el mismo navegador (sus endpoints de
`/dashboard` ya no son públicos). El resto de `/dashboard` (auditoría,
métricas, buscador de turnos, configuración de calendarios y horarios)
sigue siendo API cruda, ya protegida por permiso pero sin pantalla propia
todavía.

Variables globales necesarias (una sola vez, para toda la plataforma):
- API key de Anthropic
- Credenciales SMTP para el envío de reportes diarios y de los emails de
  invitación / recuperación de contraseña
- Verify token del webhook de WhatsApp
- `JWT_SECRET` (sesión del dashboard) y opcionalmente `FRONTEND_URL` (para
  los links de los emails de invitación/reset)
- Para Google Calendar, **uno** de los dos modos (ver
  `docs/onboarding-clinica.md`):
  - **OAuth** (recomendado): cliente de OAuth + `CALENDAR_TOKEN_ENCRYPTION_KEY`.
    Cada clínica conecta su propia cuenta y elige el calendario de una lista.
  - **Cuenta de servicio**: `GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY`, y
    cada clínica le comparte su calendario a mano.

Datos que se cargan **por clínica**, en la base de datos (no en `.env`):
número de WhatsApp y token, calendario de Google, nombre, horarios,
servicios, email de contacto.
