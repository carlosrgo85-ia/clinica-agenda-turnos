import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
vi.mock("../src/db/client", () => ({
  prisma: { platformOAuthApp: { findUnique: (...args: unknown[]) => findUnique(...args) } },
}));

// El `.env` de los tests no define GOOGLE_OAUTH_*: se simula el respaldo.
const googleOAuth = vi.hoisted(() => ({}) as { clientId?: string; clientSecret?: string; redirectUri?: string });
vi.mock("../src/config/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/env")>();
  return { env: { ...actual.env, googleOAuth } };
});

import { encryptToken } from "../src/services/crypto";
import {
  GOOGLE_OAUTH_CACHE_TTL_MS,
  getGoogleOAuthConfig,
  hasGoogleOAuthEnvFallback,
  invalidateGoogleOAuthConfigCache,
} from "../src/services/google-oauth-config";
import { isOAuthConfigured, verifyGoogleOAuthClient } from "../src/services/google-auth";

/**
 * La app de OAuth de Google se carga desde la pantalla (cifrada, en la base) y
 * el `.env` queda de respaldo. Lo que se verifica: de dónde se lee y con qué
 * prioridad, que no se mezclen campos de las dos fuentes, que se recuerde un
 * rato, y que un par mal pegado se rechace ANTES de guardarlo.
 */

const stored = (secret = "secreto-de-la-base") => ({
  clientId: "id-de-la-base.apps.googleusercontent.com",
  redirectUri: "https://app.test/oauth/google/callback",
  clientSecretEncrypted: encryptToken(secret),
});

beforeEach(() => {
  findUnique.mockReset();
  invalidateGoogleOAuthConfigCache();
  delete googleOAuth.clientId;
  delete googleOAuth.clientSecret;
  delete googleOAuth.redirectUri;
});

describe("getGoogleOAuthConfig", () => {
  it("lo guardado en la base manda, entero, sobre el .env", async () => {
    Object.assign(googleOAuth, { clientId: "id-env", clientSecret: "secreto-env", redirectUri: "http://env/cb" });
    findUnique.mockResolvedValue(stored());

    await expect(getGoogleOAuthConfig()).resolves.toEqual({
      clientId: "id-de-la-base.apps.googleusercontent.com",
      clientSecret: "secreto-de-la-base",
      redirectUri: "https://app.test/oauth/google/callback",
      source: "base",
    });
  });

  it("sin nada guardado cae al .env si está completo", async () => {
    Object.assign(googleOAuth, { clientId: "id-env", clientSecret: "secreto-env", redirectUri: "http://env/cb" });
    findUnique.mockResolvedValue(null);

    await expect(getGoogleOAuthConfig()).resolves.toMatchObject({ clientId: "id-env", source: "env" });
    expect(hasGoogleOAuthEnvFallback()).toBe(true);
  });

  it("un .env incompleto no cuenta: no se mezcla ni se arma a medias", async () => {
    Object.assign(googleOAuth, { clientId: "id-env", redirectUri: "http://env/cb" });
    findUnique.mockResolvedValue(null);

    await expect(getGoogleOAuthConfig()).resolves.toBeNull();
    expect(hasGoogleOAuthEnvFallback()).toBe(false);
  });

  it("si el secreto guardado no se puede descifrar (cambió la clave) cae al .env y lo loguea", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    Object.assign(googleOAuth, { clientId: "id-env", clientSecret: "secreto-env", redirectUri: "http://env/cb" });
    findUnique.mockResolvedValue({ ...stored(), clientSecretEncrypted: "basura-que-no-descifra" });

    await expect(getGoogleOAuthConfig()).resolves.toMatchObject({ source: "env" });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("lo recuerda un rato y al invalidar trae el nuevo", async () => {
    findUnique.mockResolvedValue(stored("viejo-secreto"));
    const t0 = 1_000_000;
    await getGoogleOAuthConfig(t0);
    await getGoogleOAuthConfig(t0 + GOOGLE_OAUTH_CACHE_TTL_MS - 1);
    expect(findUnique).toHaveBeenCalledTimes(1);

    findUnique.mockResolvedValue(stored("nuevo-secreto"));
    invalidateGoogleOAuthConfigCache();
    await expect(getGoogleOAuthConfig(t0)).resolves.toMatchObject({ clientSecret: "nuevo-secreto" });
  });

  it("isOAuthConfigured refleja si hay alguna de las dos fuentes", async () => {
    findUnique.mockResolvedValue(null);
    await expect(isOAuthConfigured()).resolves.toBe(false);

    invalidateGoogleOAuthConfigCache();
    findUnique.mockResolvedValue(stored());
    await expect(isOAuthConfigured()).resolves.toBe(true);
  });
});

describe("verifyGoogleOAuthClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const candidate = { clientId: "id.apps.googleusercontent.com", clientSecret: "GOCSPX-abcdef", redirectUri: "http://x/cb" };

  it("invalid_grant (el código inventado no existe) significa que las credenciales son buenas", async () => {
    fetchMock.mockResolvedValue(json({ error: "invalid_grant" }, 400));
    await expect(verifyGoogleOAuthClient(candidate)).resolves.toBe("valido");

    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string);
    expect(body.get("client_id")).toBe(candidate.clientId);
    expect(body.get("client_secret")).toBe(candidate.clientSecret);
    expect(body.get("grant_type")).toBe("authorization_code");
  });

  it("invalid_client es un par inválido", async () => {
    fetchMock.mockResolvedValue(json({ error: "invalid_client" }, 401));
    await expect(verifyGoogleOAuthClient(candidate)).resolves.toBe("invalido");
  });

  it("cualquier otra falla se propaga: no prueba nada sobre las credenciales", async () => {
    fetchMock.mockResolvedValue(json({ error: "backend_error" }, 503));
    await expect(verifyGoogleOAuthClient(candidate)).rejects.toThrow(/503/);

    fetchMock.mockRejectedValue(new Error("red caída"));
    await expect(verifyGoogleOAuthClient(candidate)).rejects.toThrow(/red caída/);
  });
});
