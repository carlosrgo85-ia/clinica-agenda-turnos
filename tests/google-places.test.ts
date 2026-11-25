import { describe, expect, it } from "vitest";
import { extractNameAndLocation, isGoogleBlockPage } from "../src/services/google-places";

describe("extractNameAndLocation", () => {
  it("saca el nombre de una ficha del buscador (el link compartido resuelve a esto)", () => {
    const url =
      "https://www.google.com/search?kgmid=/g/11g23mq437&hl=en-MX&q=RL+ORTHODONTICS&shem=epsd1&source=sh/x/loc/osrp/m5/1";
    expect(extractNameAndLocation(url)).toEqual({ name: "RL ORTHODONTICS", lat: null, lng: null });
  });

  it("saca nombre y coordenadas de un link completo de Maps", () => {
    const url = "https://www.google.com/maps/place/RL+ORTHODONTICS/@19.4153,-99.1673,17z/data=!3m1!4b1";
    expect(extractNameAndLocation(url)).toEqual({ name: "RL ORTHODONTICS", lat: 19.4153, lng: -99.1673 });
  });

  it("acepta un link de Maps sin coordenadas y decodifica acentos", () => {
    const url = "https://www.google.com/maps/place/Cl%C3%ADnica+Dental+Ju%C3%A1rez/data=!4m2";
    expect(extractNameAndLocation(url)).toEqual({ name: "Clínica Dental Juárez", lat: null, lng: null });
  });

  it("devuelve todo en null si no hay de dónde sacar el nombre", () => {
    expect(extractNameAndLocation("https://www.google.com/")).toEqual({ name: null, lat: null, lng: null });
    expect(extractNameAndLocation("no es una url")).toEqual({ name: null, lat: null, lng: null });
  });
});

describe("isGoogleBlockPage", () => {
  it("reconoce la página de verificación anti-robots, que trae un q ilegible", () => {
    expect(isGoogleBlockPage("https://www.google.com/sorry/index?continue=https://x&q=EgQAbc")).toBe(true);
    expect(isGoogleBlockPage("https://consent.google.com/m?continue=https://www.google.com/search")).toBe(true);
  });

  it("no confunde una ficha normal ni un negocio que se llame 'sorry'", () => {
    expect(isGoogleBlockPage("https://www.google.com/search?q=RL+ORTHODONTICS")).toBe(false);
    expect(isGoogleBlockPage("https://www.google.com/maps/place/Sorry+Cafe/@19.4,-99.1,17z")).toBe(false);
    expect(isGoogleBlockPage("no es una url")).toBe(false);
  });
});
