import { describe, expect, it } from "vitest";
import { extractJsonObject, parseAgentResponse } from "../src/services/claude";

/**
 * El modelo tiene la instrucción de devolver únicamente un JSON, pero eso es
 * una instrucción y no una garantía. Con dos llamadas por mensaje, cualquier
 * respuesta rara que reviente el parseo deja al paciente sin contestación.
 */

const COMPLETO = {
  intent: "agendar",
  servicio: "limpieza",
  fecha_solicitada: "2030-06-17",
  hora_solicitada: "09:00",
  nombre_paciente: "Carlos",
  turno_a_modificar: null,
  requiere_horarios_disponibles: false,
  confirmacion_explicita: true,
  escalar_a_humano: false,
  motivo_escalar: null,
  respuesta_al_paciente: "Listo, te agendo el lunes a las 9.",
};

describe("parseAgentResponse", () => {
  it("interpreta una respuesta bien formada", () => {
    const parsed = parseAgentResponse(JSON.stringify(COMPLETO));
    expect(parsed?.intent).toBe("agendar");
    expect(parsed?.respuesta_al_paciente).toBe("Listo, te agendo el lunes a las 9.");
  });

  it("devuelve null si el JSON viene cortado", () => {
    // Lo que pasa cuando la respuesta se pasa de max_tokens.
    const truncado = JSON.stringify(COMPLETO).slice(0, 60);
    expect(parseAgentResponse(truncado)).toBeNull();
  });

  it("tolera prosa alrededor del JSON (antes devolvía null y el paciente terminaba derivado por una frase de más)", () => {
    expect(parseAgentResponse(`Claro, acá va:\n${JSON.stringify(COMPLETO)}`)?.intent).toBe("agendar");
  });

  it("devuelve null si la intención no es una de las conocidas", () => {
    expect(parseAgentResponse(JSON.stringify({ ...COMPLETO, intent: "pedir_pizza" }))).toBeNull();
  });

  it("devuelve null si no hay mensaje para el paciente", () => {
    expect(parseAgentResponse(JSON.stringify({ ...COMPLETO, respuesta_al_paciente: "" }))).toBeNull();
  });

  it("devuelve null si un flag vino como texto en vez de booleano", () => {
    expect(
      parseAgentResponse(JSON.stringify({ ...COMPLETO, confirmacion_explicita: "true" }))
    ).toBeNull();
  });

  /**
   * `pidio_ubicacion` es la excepción a la regla de arriba: que falte o
   * venga mal solo significa que no se adjunta la dirección. Tirar toda la
   * respuesta por eso dejaría al paciente sin contestación, que es mucho
   * peor que no mandarle un link.
   */
  it("asume que no pidió la ubicación si el flag no vino", () => {
    const { ...sinFlag } = COMPLETO;
    expect(parseAgentResponse(JSON.stringify(sinFlag))?.pidio_ubicacion).toBe(false);
  });

  it("respeta el flag de ubicación cuando sí vino", () => {
    expect(
      parseAgentResponse(JSON.stringify({ ...COMPLETO, pidio_ubicacion: true }))?.pidio_ubicacion
    ).toBe(true);
  });

  it("ignora el flag de ubicación si vino con otro tipo, sin tirar la respuesta", () => {
    const parsed = parseAgentResponse(JSON.stringify({ ...COMPLETO, pidio_ubicacion: "sí" }));
    expect(parsed).not.toBeNull();
    expect(parsed?.pidio_ubicacion).toBe(false);
  });

  it("devuelve null si no es un objeto", () => {
    expect(parseAgentResponse("[]")).toBeNull();
    expect(parseAgentResponse("null")).toBeNull();
    expect(parseAgentResponse("hola")).toBeNull();
  });

  it("los apellidos separados se leen, y si faltan o vienen mal quedan en null sin tirar la respuesta", () => {
    const conApellido = parseAgentResponse(JSON.stringify({ ...COMPLETO, nombre_paciente: "Petra María", apellido_paciente: " Romero ", apellido_paciente_del_turno: "" }));
    expect(conApellido?.apellido_paciente).toBe("Romero");
    expect(conApellido?.apellido_paciente_del_turno).toBeNull();
    const sin = parseAgentResponse(JSON.stringify({ ...COMPLETO, apellido_paciente: 42 }));
    expect(sin?.apellido_paciente).toBeNull();
  });

  it("`campana_mencionada` es opcional: se limpia si viene y queda en null si falta o viene raro", () => {
    expect(parseAgentResponse(JSON.stringify({ ...COMPLETO, campana_mencionada: "  Implantes  " }))?.campana_mencionada).toBe("Implantes");
    for (const v of [undefined, null, "", "   ", 42, true]) {
      expect(parseAgentResponse(JSON.stringify({ ...COMPLETO, campana_mencionada: v }))?.campana_mencionada, String(v)).toBeNull();
    }
  });
});

describe("el modelo envuelve el JSON en un bloque de código o lo precede de prosa", () => {
  const json = JSON.stringify(COMPLETO, null, 2);

  it("lee un JSON dentro de un bloque ```json (lo que mandó a un paciente a una persona por un par de backticks)", () => {
    expect(parseAgentResponse("```json\n" + json + "\n```")?.intent).toBe("agendar");
    expect(parseAgentResponse("```\n" + json + "\n```")?.intent).toBe("agendar");
    expect(parseAgentResponse("```JSON  \n" + json + "\n```\n")?.intent).toBe("agendar");
  });

  it("lee un JSON con prosa antes o después", () => {
    expect(parseAgentResponse("Claro, acá va:\n" + json)?.intent).toBe("agendar");
    expect(parseAgentResponse(json + "\n\nEspero que sirva.")?.intent).toBe("agendar");
    expect(parseAgentResponse("Va:\n```json\n" + json + "\n```\nListo.")?.intent).toBe("agendar");
  });

  it("no se deja engañar por las llaves que van dentro de un texto", () => {
    const raro = JSON.stringify({ ...COMPLETO, respuesta_al_paciente: 'Te dejo el {código} y un "cierre }" entre comillas \\ ok' });
    expect(parseAgentResponse("```json\n" + raro + "\n```")?.respuesta_al_paciente).toBe('Te dejo el {código} y un "cierre }" entre comillas \\ ok');
  });

  it("si hay dos objetos, toma el primero", () => {
    const otro = JSON.stringify({ ...COMPLETO, intent: "cancelar" });
    expect(parseAgentResponse(json + "\n" + otro)?.intent).toBe("agendar");
  });

  it("lo que sigue siendo ilegible sigue dando null: un JSON cortado, sin objeto o inválido", () => {
    expect(parseAgentResponse(json.slice(0, json.length - 20))).toBeNull(); // cortado por max_tokens
    expect(parseAgentResponse("```json\n" + json.slice(0, 80))).toBeNull();
    expect(parseAgentResponse("no hay nada de JSON acá")).toBeNull();
    expect(parseAgentResponse("```json\n{ esto no es json }\n```")).toBeNull();
    expect(parseAgentResponse("")).toBeNull();
    expect(parseAgentResponse("```json\n```")).toBeNull();
  });

  it("aunque venga envuelto, sigue exigiendo los campos de siempre", () => {
    const sinIntent = JSON.stringify({ ...COMPLETO, intent: "inventada" });
    expect(parseAgentResponse("```json\n" + sinIntent + "\n```")).toBeNull();
    const flagTexto = JSON.stringify({ ...COMPLETO, confirmacion_explicita: "sí" });
    expect(parseAgentResponse("```json\n" + flagTexto + "\n```")).toBeNull();
  });

  it("extractJsonObject devuelve el objeto completo o null", () => {
    expect(extractJsonObject('x {"a": {"b": 1}} y')).toBe('{"a": {"b": 1}}');
    expect(extractJsonObject("sin llaves")).toBeNull();
    expect(extractJsonObject('{"a": 1')).toBeNull();
  });
});

