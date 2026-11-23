import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API_TARGET = "http://localhost:3000";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // La SPA se sirve en /app en producción (ver src/index.ts del backend),
  // así que todos los assets tienen que resolverse con ese prefijo.
  base: "/app/",
  server: {
    // Sin esto, el dev server de Vite (otro puerto) necesitaría CORS para
    // llamar a la API. Con el proxy, el browser ve todo same-origin.
    proxy: {
      "/auth": API_TARGET,
      "/dashboard": API_TARGET,
      "/platform": API_TARGET,
      "/oauth": API_TARGET,
    },
  },
});
