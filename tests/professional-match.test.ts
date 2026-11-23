import { describe, expect, it } from "vitest";
import { matchRequestedProfessional } from "../src/services/professional-match";

/**
 * De "con la Dra. Liliana" al profesional real. Lo que importa: que sea
 * tolerante con acentos, mayúsculas y tratamiento, y que ante la duda NO
 * elija — agendar con la persona equivocada es peor que no filtrar.
 */

const EQUIPO = [
  { id: "p1", name: "Liliana Mungiga", title: "Dra." },
  { id: "p2", name: "Cyntia Trujullo", title: null },
  { id: "p3", name: "Rodrigo López", title: "Dr." },
  { id: "p4", name: "Ana López", title: "Lic." },
];

describe("matchRequestedProfessional", () => {
  it("encuentra al profesional copiando el nombre tal como figura", () => {
    expect(matchRequestedProfessional("Dra. Liliana Mungiga", EQUIPO)).toBe("p1");
    expect(matchRequestedProfessional("Cyntia Trujullo", EQUIPO)).toBe("p2");
  });

  it("ignora mayúsculas, acentos y el tratamiento", () => {
    expect(matchRequestedProfessional("rodrigo lopez", EQUIPO)).toBe("p3");
    expect(matchRequestedProfessional("Doctora Liliana", EQUIPO)).toBe("p1");
    expect(matchRequestedProfessional("liliana", EQUIPO)).toBe("p1");
  });

  it("con solo el apellido alcanza si es único", () => {
    expect(matchRequestedProfessional("Trujullo", EQUIPO)).toBe("p2");
  });

  it("si encaja con más de uno devuelve null en vez de elegir el primero", () => {
    expect(matchRequestedProfessional("López", EQUIPO)).toBeNull();
    // El tratamiento no desempata: "Dr." / "Dra." no identifican a nadie.
    expect(matchRequestedProfessional("Dr. López", EQUIPO)).toBeNull();
    expect(matchRequestedProfessional("Dr. Rodrigo López", EQUIPO)).toBe("p3");
  });

  it("devuelve null si no pidió a nadie o no existe", () => {
    expect(matchRequestedProfessional(null, EQUIPO)).toBeNull();
    expect(matchRequestedProfessional("", EQUIPO)).toBeNull();
    expect(matchRequestedProfessional("Dra.", EQUIPO)).toBeNull();
    expect(matchRequestedProfessional("Cynthia", EQUIPO)).toBeNull();
    expect(matchRequestedProfessional("Pedro Pérez", EQUIPO)).toBeNull();
  });
});
