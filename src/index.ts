import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";
import { env } from "./config/env";
import { webhookRouter } from "./routes/webhook";
import { dashboardRouter } from "./routes/dashboard";
import { oauthRouter } from "./routes/oauth";
import { authRouter } from "./routes/auth";
import { usersRouter } from "./routes/users";
import { rolesRouter } from "./routes/roles";
import { platformRouter } from "./routes/platform";
import { auditRequests } from "./middleware/audit";

const app = express();
if (env.trustProxyHops > 0) app.set("trust proxy", env.trustProxyHops);
app.use(express.json());
app.use(cookieParser());
// Auditoría de TODA la API: global y antes de los routers, para que una ruta nueva
// quede cubierta sin acordarse. Ver middleware/audit.ts y "Auditoría" en CLAUDE.md.
app.use(auditRequests);

app.use("/webhook", webhookRouter);
app.use("/auth", authRouter);
app.use("/dashboard", dashboardRouter);
app.use("/dashboard", usersRouter);
app.use("/dashboard", rolesRouter);
app.use("/platform", platformRouter);
app.use("/oauth", oauthRouter); // conexión de calendarios por OAuth

/**
 * Frontend. Hoy es solo el banner de configuración incompleta y una página
 * mínima que lo hospeda — ver public/index.html. Los archivos van estáticos
 * porque el proyecto no tiene bundler y un banner no justifica agregarlo.
 *
 * `path.resolve` desde el cwd y no desde __dirname: en dev se corre con tsx
 * sobre src/, y en producción desde dist/, así que __dirname apunta a
 * lugares distintos y public/ vive en la raíz en los dos casos.
 */
app.use("/ui", express.static(path.resolve(process.cwd(), "public")));

/**
 * SPA de administración (login, usuarios, roles y permisos). En dev corre
 * aparte con su propio servidor de Vite (`npm run dev:web`, con proxy a
 * esta API); acá solo se sirve el build de producción (`frontend/dist`,
 * generado por `npm run build`).
 *
 * El catch-all de abajo es necesario porque React Router usa el historial
 * del browser (no hashes): cualquier ruta bajo /app que no sea un archivo
 * estático tiene que devolver el mismo `index.html` para que la SPA la
 * resuelva del lado del cliente.
 */
const frontendDist = path.resolve(process.cwd(), "frontend", "dist");
app.use("/app", express.static(frontendDist));
app.get("/app/*", (_req, res) => res.sendFile(path.join(frontendDist, "index.html")));

app.get("/health", (_req, res) => res.send("ok"));

/**
 * Acá NO se programa ningún cron, a propósito: las tareas programadas viven
 * en `src/worker.ts`, que corre como un proceso aparte del que tiene que
 * haber una sola instancia. Si se programaran acá, cada instancia del
 * servidor web mandaría los recordatorios de nuevo — ver el comentario de
 * worker.ts.
 */
app.listen(env.port, () => {
  console.log(`Servidor escuchando en el puerto ${env.port}`);
});
