import { Prisma } from "@prisma/client";
import { prisma } from "../db/client";

/**
 * Agrupa los mensajes que un paciente manda seguidos, para contestarlos una
 * sola vez.
 *
 * El problema real: la gente parte una idea en varios mensajes ("Agendar la
 * cita" / "Para mañana"). Contestando uno por uno el paciente recibe dos
 * respuestas a una sola pregunta y, peor, cada turno lee el historial al
 * empezar y lo escribe al terminar, así que el segundo ni siquiera ve al
 * primero: contesta como si el primer mensaje no hubiera existido.
 *
 * La solución es esperar a que deje de escribir. Cada mensaje entrante:
 *
 * 1. se guarda en `PendingInboundMessage` (no se procesa todavía),
 * 2. espera `DEBOUNCE_MS`,
 * 3. intenta quedarse con TODOS los pendientes de esa conversación.
 *
 * El paso 3 solo tiene éxito si en esos segundos no llegó nada nuevo. Si el
 * paciente siguió escribiendo, este intento se va con las manos vacías y el
 * que gana es el del último mensaje — que se los lleva todos juntos. Así la
 * ventana se estira mientras el paciente escribe, en vez de cortar cada N
 * segundos.
 *
 * Por qué en Postgres y no con un `setTimeout` y un Map en memoria: el
 * servidor web corre en N instancias atrás de un balanceador. Dos mensajes
 * seguidos pueden caer en instancias distintas, y el temporizador de una no
 * ve el buffer de la otra — cada una contestaría por su lado, que es
 * exactamente el problema que se quiere resolver. En la base el buffer es
 * uno solo para todas.
 */

/** Cuánto se espera, sin mensajes nuevos, antes de contestar. */
export const DEBOUNCE_MS = 5_000;

/**
 * Tope para que alguien que escribe sin parar reciba respuesta igual.
 *
 * Sin esto la ventana se estira indefinidamente: mientras sigan llegando
 * mensajes, ningún intento junta el lote y el paciente no recibe nada.
 */
export const MAX_WAIT_MS = 30_000;

export interface PendingMessage {
  text: string;
  receivedAt: Date;
}

/**
 * Devuelve el `receivedAt` que le puso la base, que es lo que después hay
 * que pasarle a `claimConversationBatch` como `notNewerThan`.
 */
export async function enqueueInboundMessage(params: {
  clinicId: string;
  patientPhone: string;
  text: string;
}): Promise<PendingMessage> {
  const fila = await prisma.pendingInboundMessage.create({ data: params });
  return { text: fila.text, receivedAt: fila.receivedAt };
}

/**
 * Vuelve a poner en la cola un mensaje que YA se tomó, como respaldo mientras se espera el
 * reintento de una llamada fallida al modelo (`agent-turn.ts`).
 *
 * Al tomar un lote se borra de la cola, así que durante esa espera el mensaje no existe en ningún
 * lado: si el proceso muere ahí, se pierde y el paciente queda en visto. Con esta fila, el barrido
 * (`inbound-sweeper`) lo rescata a los 2 minutos como a cualquier lote abandonado. Devuelve el id
 * para que el turno la reclame con `reclaimRequeuedMessage()` cuando siga vivo.
 */
export async function requeueMessageForRetry(params: {
  clinicId: string;
  patientPhone: string;
  text: string;
}): Promise<string> {
  const fila = await prisma.pendingInboundMessage.create({ data: params });
  return fila.id;
}

/**
 * Reclama de vuelta el respaldo de `requeueMessageForRetry()`. **`true` = sigue siendo del turno
 * que lo puso** y puede reintentar; **`false` = lo tomó otro** (el barrido, o el turno de un mensaje
 * nuevo que lo juntó en su lote) y ese otro turno lo va a contestar: el original tiene que
 * abandonar, o el paciente recibiría dos respuestas.
 *
 * Es un `DELETE` por id: igual que `claimConversationBatch`, la fila es el testigo y como se borra
 * no puede procesarse dos veces.
 */
export async function reclaimRequeuedMessage(id: string): Promise<boolean> {
  const { count } = await prisma.pendingInboundMessage.deleteMany({ where: { id } });
  return count === 1;
}

/**
 * Se queda con los pendientes de una conversación, o con ninguno.
 *
 * Es un `DELETE ... RETURNING`: en una sola sentencia decide y borra, así que
 * de dos instancias que lo intenten a la vez, una se lleva las filas y la
 * otra recibe cero. No hace falta un lock — la fila es el testigo, y como se
 * borra, no puede procesarse dos veces.
 *
 * La condición `NOT EXISTS` es la que espera a que deje de escribir: si
 * llegó algún mensaje DESPUÉS de `notNewerThan`, no se lleva nada y deja que
 * el intento de ese mensaje (que despierta después) junte el lote completo.
 * El `OR` del final es el tope de `MAX_WAIT_MS`, para que escribir sin parar
 * no postergue la respuesta para siempre.
 *
 * **`notNewerThan` es el `receivedAt` del mensaje que disparó este intento,
 * no un corte contra el reloj.** Comparar contra `ahora - DEBOUNCE_MS` no
 * servía: `receivedAt` lo pone Postgres y el corte lo calculaba Node justo
 * después de dormir esos mismos milisegundos, así que los dos valores caían
 * a menos de un milisegundo y el mensaje se veía a sí mismo como "más nuevo
 * que el corte". El intento se abstenía creyendo que el paciente seguía
 * escribiendo, y como nadie más iba a despertar, el mensaje quedaba encolado
 * sin respuesta. Salía o no según la imprecisión del `setTimeout` — una
 * moneda al aire. Comparar contra el mensaje propio no depende de ningún
 * reloj: si nada llegó después del mío, soy el último y me lo llevo.
 */
export async function claimConversationBatch(params: {
  clinicId: string;
  patientPhone: string;
  /** El `receivedAt` del mensaje que disparó este intento. */
  notNewerThan: Date;
  now?: Date;
}): Promise<PendingMessage[]> {
  const now = params.now ?? new Date();
  const maxWaitCutoff = new Date(now.getTime() - MAX_WAIT_MS);

  const filas = await prisma.$queryRaw<PendingMessage[]>(Prisma.sql`
    DELETE FROM "PendingInboundMessage" p
    WHERE p."clinicId" = ${params.clinicId}
      AND p."patientPhone" = ${params.patientPhone}
      AND (
        NOT EXISTS (
          SELECT 1 FROM "PendingInboundMessage" q
          WHERE q."clinicId" = p."clinicId"
            AND q."patientPhone" = p."patientPhone"
            AND q."receivedAt" > ${params.notNewerThan}
        )
        OR EXISTS (
          SELECT 1 FROM "PendingInboundMessage" r
          WHERE r."clinicId" = p."clinicId"
            AND r."patientPhone" = p."patientPhone"
            AND r."receivedAt" <= ${maxWaitCutoff}
        )
      )
    RETURNING p."text", p."receivedAt"
  `);

  return [...filas].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
}

/**
 * Los mensajes del lote como un solo texto para el modelo.
 *
 * Van en líneas separadas y no pegados con un espacio: son mensajes
 * distintos, y "Agendar la cita / Para mañana" se lee distinto que "Agendar
 * la cita Para mañana". El modelo los recibe como un único mensaje del
 * paciente, que es lo que son.
 */
export function joinBatch(messages: PendingMessage[]): string {
  return messages.map((m) => m.text).join("\n");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
