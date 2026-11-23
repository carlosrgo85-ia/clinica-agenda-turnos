import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Los tests de booking van contra el Postgres local (docker-compose.yml)
    // y se pisan entre sí si corren en paralelo sobre la misma base.
    fileParallelism: false,
    env: {
      // Valores dummy para las variables que config/env.ts exige en el
      // import. Ningún test llama a Anthropic, WhatsApp, SMTP ni Google.
      ANTHROPIC_API_KEY: "test",
      WHATSAPP_VERIFY_TOKEN: "test",
      SMTP_HOST: "localhost",
      SMTP_USER: "test",
      SMTP_PASS: "test",
      CALENDAR_TOKEN_ENCRYPTION_KEY:
        "0000000000000000000000000000000000000000000000000000000000000001",
      JWT_SECRET: "test-jwt-secret",
      // Para el proveedor de Microsoft: ningún test llama a Microsoft de
      // verdad, `fetch` se simula.
      MICROSOFT_OAUTH_CLIENT_ID: "client-id",
      MICROSOFT_OAUTH_CLIENT_SECRET: "client-secret",
      MICROSOFT_OAUTH_REDIRECT_URI: "http://localhost:3000/oauth/microsoft/callback",
    },
  },
});
