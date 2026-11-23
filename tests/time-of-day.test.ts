import { describe, expect, it } from "vitest";
import { momentoDelDia } from "../src/prompts/time-of-day";

const hm = (h: number, m = 0) => h * 60 + m;

describe("momentoDelDia", () => {
  it("de 05:00 a 11:59 es mañana", () => {
    expect(momentoDelDia(hm(5))).toBe("mañana");
    expect(momentoDelDia(hm(9, 30))).toBe("mañana");
    expect(momentoDelDia(hm(11, 59))).toBe("mañana");
  });

  it("de 12:00 a 19:59 es tarde", () => {
    expect(momentoDelDia(hm(12))).toBe("tarde");
    expect(momentoDelDia(hm(15, 45))).toBe("tarde");
    expect(momentoDelDia(hm(19, 59))).toBe("tarde");
  });

  it("de 20:00 a 04:59 es noche (el caso del 2026-11-05: era de noche y se deseó un buen día)", () => {
    expect(momentoDelDia(hm(20))).toBe("noche");
    expect(momentoDelDia(hm(22, 31))).toBe("noche");
    expect(momentoDelDia(hm(0))).toBe("noche");
    expect(momentoDelDia(hm(4, 59))).toBe("noche");
  });

  it("tolera valores fuera de rango sin romper", () => {
    expect(momentoDelDia(hm(24) + hm(9))).toBe("mañana");
    expect(momentoDelDia(-hm(1))).toBe("noche");
  });
});
