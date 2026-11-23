import { describe, expect, it } from "vitest";
import { buildAssistantIntroMessage, buildPrivacyNoticeMessage, isValidPrivacyNoticeUrl } from "../src/services/privacy-notice";

describe("la presentación del asistente", () => {
  it("dice, sin tono legal, que lo atiende un asistente virtual de la clínica", () => {
    const m = buildAssistantIntroMessage({ name: "Clínica Sonrisa" });
    expect(m).toBe("Le atiende el asistente virtual de Clínica Sonrisa.");
    expect(m).not.toMatch(/privacidad|datos|https?:/i);
  });
});

describe("el mensaje del aviso de privacidad", () => {
  it("manda el link de la clínica con un tono amable, sin decir que es un asistente", () => {
    const m = buildPrivacyNoticeMessage({ name: "Clínica Sonrisa", privacyNoticeUrl: "https://sonrisa.mx/privacidad" });
    expect(m).toBe("Mientras tanto, le dejamos el aviso de privacidad de Clínica Sonrisa: https://sonrisa.mx/privacidad");
    expect(m).not.toMatch(/asistente|virtual|inteligencia/i);
  });

  it("sin link cargado no manda nada: no promete un aviso que no puede mostrar", () => {
    for (const url of [null, "", "   "]) {
      expect(buildPrivacyNoticeMessage({ name: "Clínica Sonrisa", privacyNoticeUrl: url })).toBeNull();
    }
  });

  it("habla de usted y no usa tuteo ni voseo", () => {
    for (const m of [buildAssistantIntroMessage({ name: "X" }), buildPrivacyNoticeMessage({ name: "X", privacyNoticeUrl: "https://x.mx/p" })!]) {
      expect(m).not.toMatch(/\b(te|tu|tus|vos|podés|puedes)\b/i);
    }
  });
});

describe("validar el link", () => {
  it("acepta un https con dominio", () => {
    expect(isValidPrivacyNoticeUrl("https://clinica.mx/aviso-de-privacidad")).toBe(true);
    expect(isValidPrivacyNoticeUrl("  https://clinica.mx/a  ")).toBe(true);
  });
  it("rechaza http, otros esquemas, texto con espacios, sin dominio y vacíos", () => {
    for (const v of ["http://clinica.mx/a", "javascript:alert(1)", "https://a b.mx", "https://localhost/a", "clinica.mx/a", "", "   ", null, 5, undefined]) {
      expect(isValidPrivacyNoticeUrl(v)).toBe(false);
    }
  });
  it("rechaza uno de más de 500 caracteres", () => {
    expect(isValidPrivacyNoticeUrl(`https://clinica.mx/${"a".repeat(500)}`)).toBe(false);
  });
});
