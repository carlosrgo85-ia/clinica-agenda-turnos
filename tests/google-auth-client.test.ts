import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db/client", () => ({ prisma: { googleAccount: { update: vi.fn().mockResolvedValue({}) } } }));
vi.mock("../src/services/google-oauth-config", () => ({
  getGoogleOAuthConfig: async () => ({ clientId: "id", clientSecret: "secreto", redirectUri: "https://app.test/cb" }),
  hasGoogleOAuthEnvFallback: () => false,
  invalidateGoogleOAuthConfigCache: () => undefined,
}));

import { encryptToken } from "../src/services/crypto";
import { getClientForAccount } from "../src/services/google-auth";

/**
 * El 2026-11-19 `calendar-sync` falló con 401 "Invalid Credentials": el access token guardado figuraba vigente (`expiry_date`
 * en el futuro) pero Google lo rechazó. La librería de Google SOLO reintenta un 401 con un token nuevo si no hay `expiry_date` o
 * si `forceRefreshOnFailure` está prendido, y nosotros guardamos `expiry_date`: no reintentaba nunca.
 */
describe("el cliente OAuth de una cuenta", () => {
  it("reintenta con un token nuevo cuando Google rechaza con 401 uno que figura vigente", async () => {
    const client = await getClientForAccount({
      id: "acc-1",
      email: "clinica@example.com",
      refreshTokenEncrypted: encryptToken("refresh"),
      accessTokenEncrypted: encryptToken("access-viejo"),
      accessTokenExpiresAt: new Date(Date.now() + 30 * 60_000),
    } as never);
    expect(client.forceRefreshOnFailure).toBe(true);
    // Lleva las credenciales guardadas: sin refresh token no habría con qué reintentar.
    expect(client.credentials.refresh_token).toBe("refresh");
    expect(client.credentials.access_token).toBe("access-viejo");
  });
});
