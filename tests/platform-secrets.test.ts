import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
vi.mock("../src/db/client", () => ({
  prisma: { platformSecret: { findUnique: (...args: unknown[]) => findUnique(...args) } },
}));

import { encryptToken } from "../src/services/crypto";
import {
  SECRET_CACHE_TTL_MS,
  describeSecretSource,
  getPlatformSecretValue,
  hasEnvFallback,
  invalidatePlatformSecretCache,
  parseSecretValue,
} from "../src/services/platform-secrets";
import { verifyMicrosoftClientSecret } from "../src/services/microsoft-auth";

/**
 * El secreto de la app de Microsoft puede estar guardado (cifrado) en la base
 * o en el `.env`. Lo que se verifica: de dónde se lee y con qué prioridad, que
 * se recuerde un rato en vez de pegarle a la base en cada llamada, y que un
 * secreto mal pegado se rechace ANTES de guardarlo.
 */

const KEY = "microsoft_oauth_client_secret";
// El `.env` de test (vitest.config.ts) define MICROSOFT_OAUTH_CLIENT_SECRET = "client-secret".
const ENV_VALUE = "client-secret";

beforeEach(() => {
  findUnique.mockReset();
  invalidatePlatformSecretCache();
});

describe("getPlatformSecretValue", () => {
  it("lo guardado en la base manda sobre el .env", async () => {
    findUnique.mockResolvedValue({ valueEncrypted: encryptToken("secreto-de-la-base") });
    await expect(getPlatformSecretValue(KEY)).resolves.toEqual({ value: "secreto-de-la-base", source: "base" });
  });

  it("sin valor guardado cae al .env", async () => {
    findUnique.mockResolvedValue(null);
    await expect(getPlatformSecretValue(KEY)).resolves.toEqual({ value: ENV_VALUE, source: "env" });
    findUnique.mockResolvedValue({ valueEncrypted: null });
    invalidatePlatformSecretCache();
    await expect(describeSecretSource(KEY)).resolves.toBe("env");
  });

  it("si el valor guardado no se puede descifrar (cambió la clave) cae al .env y lo loguea", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    findUnique.mockResolvedValue({ valueEncrypted: "basura-que-no-descifra" });

    await expect(getPlatformSecretValue(KEY)).resolves.toEqual({ value: ENV_VALUE, source: "env" });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("lo recuerda un rato: no consulta la base en cada llamada", async () => {
    findUnique.mockResolvedValue({ valueEncrypted: encryptToken("a") });
    const t0 = 1_000_000;
    await getPlatformSecretValue(KEY, t0);
    await getPlatformSecretValue(KEY, t0 + SECRET_CACHE_TTL_MS - 1);
    expect(findUnique).toHaveBeenCalledTimes(1);

    await getPlatformSecretValue(KEY, t0 + SECRET_CACHE_TTL_MS + 1);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it("al guardar uno nuevo se invalida y la próxima lectura ya trae el nuevo", async () => {
    findUnique.mockResolvedValue({ valueEncrypted: encryptToken("viejo") });
    await expect(getPlatformSecretValue(KEY)).resolves.toMatchObject({ value: "viejo" });

    findUnique.mockResolvedValue({ valueEncrypted: encryptToken("nuevo") });
    invalidatePlatformSecretCache(KEY);
    await expect(getPlatformSecretValue(KEY)).resolves.toMatchObject({ value: "nuevo" });
  });

  it("hay un respaldo en el .env", () => {
    expect(hasEnvFallback(KEY)).toBe(true);
  });
});

describe("parseSecretValue", () => {
  it("acepta un secreto y le saca los espacios de los extremos (un salto de línea de copy-paste)", () => {
    expect(parseSecretValue("  abcDEF12~_.-xyz\n")).toBe("abcDEF12~_.-xyz");
  });

  it("rechaza lo vacío, lo muy corto, lo muy largo y lo que tiene espacios adentro", () => {
    expect(parseSecretValue("")).toBeNull();
    expect(parseSecretValue("corto")).toBeNull();
    expect(parseSecretValue("x".repeat(513))).toBeNull();
    expect(parseSecretValue("con un espacio")).toBeNull();
    expect(parseSecretValue(12345678)).toBeNull();
  });
});

describe("verifyMicrosoftClientSecret", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("es válido si Microsoft entrega un token con ese secreto", async () => {
    fetchMock.mockResolvedValue(json({ access_token: "x" }, 200));
    await expect(verifyMicrosoftClientSecret("el-secreto-nuevo")).resolves.toBe("valido");

    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string);
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_secret")).toBe("el-secreto-nuevo");
  });

  it("invalid_client es un secreto inválido", async () => {
    fetchMock.mockResolvedValue(json({ error: "invalid_client" }, 401));
    await expect(verifyMicrosoftClientSecret("mal-pegado")).resolves.toBe("invalido");
  });

  it("cualquier otra falla se propaga: no prueba nada sobre el secreto, y no hay que descartarlo por eso", async () => {
    fetchMock.mockResolvedValue(json({ error: "temporarily_unavailable" }, 503));
    await expect(verifyMicrosoftClientSecret("secreto-valido")).rejects.toThrow(/503/);

    fetchMock.mockRejectedValue(new Error("red caída"));
    await expect(verifyMicrosoftClientSecret("secreto-valido")).rejects.toThrow(/red caída/);
  });
});
