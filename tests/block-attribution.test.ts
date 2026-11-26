import { describe, expect, it } from "vitest";
import {
  attributeBlockToProfessionals,
  isValidEventColorId,
  type AttributableProfessional,
} from "../src/services/block-attribution";

const equipo: AttributableProfessional[] = [
  { id: "lili", name: "Liliana Munguía", contactEmail: "lili@x.com", calendarColorId: "7" },
  { id: "claus", name: "Claussent Luna González", contactEmail: null, calendarColorId: null },
  { id: "lopez1", name: "Ana López", contactEmail: null, calendarColorId: "3" },
  { id: "lopez2", name: "Rodrigo López", contactEmail: null, calendarColorId: "3" },
];

describe("attributeBlockToProfessionals", () => {
  it("sin pistas o sin coincidencia devuelve [] (de todos)", () => {
    expect(attributeBlockToProfessionals(undefined, equipo)).toEqual([]);
    expect(attributeBlockToProfessionals({}, equipo)).toEqual([]);
    expect(attributeBlockToProfessionals({ title: "Reunión de equipo" }, equipo)).toEqual([]);
  });

  it("reconoce el nombre en el título sin acentos, mayúsculas ni tratamiento", () => {
    expect(attributeBlockToProfessionals({ title: "DRA. MUNGUIA - Pérez" }, equipo)).toEqual(["lili"]);
    expect(attributeBlockToProfessionals({ title: "limpieza con luna" }, equipo)).toEqual(["claus"]);
  });

  it("un apellido que comparten dos personas no atribuye nada, pero el nombre de pila sí", () => {
    expect(attributeBlockToProfessionals({ title: "López, control" }, equipo)).toEqual([]);
    expect(attributeBlockToProfessionals({ title: "Ana López, control" }, equipo)).toEqual(["lopez1"]);
  });

  it("palabras de enlace y cortas no identifican a nadie", () => {
    const e = [{ id: "m", name: "María de la Cruz", contactEmail: null, calendarColorId: null }];
    expect(attributeBlockToProfessionals({ title: "cita de la tarde" }, e)).toEqual([]);
    expect(attributeBlockToProfessionals({ title: "Cruz, revisión" }, e)).toEqual(["m"]);
  });

  it("el color y el invitado atribuyen; un color compartido atribuye a los dos", () => {
    expect(attributeBlockToProfessionals({ colorId: "7" }, equipo)).toEqual(["lili"]);
    expect(attributeBlockToProfessionals({ colorId: "3" }, equipo).sort()).toEqual(["lopez1", "lopez2"]);
    expect(attributeBlockToProfessionals({ attendeeEmails: [" LILI@x.com "] }, equipo)).toEqual(["lili"]);
  });

  it("las pistas se suman", () => {
    expect(attributeBlockToProfessionals({ title: "Luna", colorId: "7" }, equipo).sort()).toEqual(["claus", "lili"]);
  });

  it("valida los colores de Google", () => {
    expect(isValidEventColorId("11")).toBe(true);
    expect(isValidEventColorId("12")).toBe(false);
    expect(isValidEventColorId(7)).toBe(false);
  });
});
