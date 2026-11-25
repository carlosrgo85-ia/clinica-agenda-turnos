import { describe, expect, it } from "vitest";
import { redactTokens, whatsAppTokenError } from "../src/services/whatsapp-token";

const TOKEN_FALSO = "EAA" + "x1Y2z3".repeat(20);

describe("redactTokens", () => {
  it("oculta el token que Meta devuelve dentro del mensaje de error", () => {
    const meta = `{"error":{"message":"Malformed access token ${TOKEN_FALSO} identificador 123","code":190}}`;
    const limpio = redactTokens(meta);
    expect(limpio).not.toContain(TOKEN_FALSO);
    expect(limpio).toContain("[token oculto]");
    expect(limpio).toContain('"code":190');
  });

  it("no toca un texto sin token", () => {
    expect(redactTokens("Recipient phone number not in allowed list")).toBe("Recipient phone number not in allowed list");
  });
});

describe("whatsAppTokenError", () => {
  it("acepta un token limpio, aunque venga con espacios en los extremos", () => {
    expect(whatsAppTokenError(TOKEN_FALSO)).toBeNull();
    expect(whatsAppTokenError(`  ${TOKEN_FALSO}\n`)).toBeNull();
  });

  it("rechaza un token con algo pegado de más (el caso real)", () => {
    expect(whatsAppTokenError(`${TOKEN_FALSO} identificador de mensajes 2908647722815617`)).toMatch(/espacios/);
    expect(whatsAppTokenError(`${TOKEN_FALSO}\nsegunda línea`)).toMatch(/espacios/);
  });

  it("rechaza lo demasiado corto o largo", () => {
    expect(whatsAppTokenError("abc")).toMatch(/largo/);
    expect(whatsAppTokenError("a".repeat(1001))).toMatch(/largo/);
  });
});
