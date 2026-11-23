/**
 * Seed de la base: puebla el catálogo de `Permission` (fuente de verdad en
 * src/config/permissions.ts) y el rol global "Super Admin" con todos los
 * permisos. Corre solo en desarrollo, automático con `prisma migrate dev`.
 * En producción se invoca a mano como paso de deploy: `npx prisma db seed`.
 *
 * NO crea ningún usuario: eso lo hace `scripts/create-super-admin.ts`, a
 * propósito, para no dejar una cuenta con contraseña conocida corriendo
 * sola en ningún entorno.
 */
import { PrismaClient, type HolidayRuleKind } from "@prisma/client";
import { ALL_PERMISSION_IDS, PERMISSION_CATALOG, PLATFORM_ONLY_PERMISSIONS } from "../src/config/permissions";
import { PLAN_FEATURES } from "../src/config/plan-features";
import { ensureClinicAdminRole } from "../src/repositories/roles.repository";

const prisma = new PrismaClient();

interface SeedHolidayRule {
  name: string;
  kind: HolidayRuleKind;
  month?: number;
  day?: number;
  weekday?: number;
  ordinal?: number;
  offsetDays?: number;
}

/**
 * Catálogo inicial de países — lo que antes vivía hardcodeado en
 * `src/data/holidays.ts` como `HOLIDAYS_BY_COUNTRY`. Desde entonces, sumar un
 * país es una fila más (vía la pantalla de plataforma "Países"), no un cambio
 * de código — este seed es solo el punto de partida para un ambiente nuevo.
 *
 * Cubre América Latina y Estados Unidos. **Ninguna lista está completa a
 * propósito**, y el criterio es el mismo que ya estaba escrito para los
 * feriados por decreto: se carga solo lo que se puede expresar con una de las
 * tres reglas (`fixed`, `nthWeekday`, `easter`) y con fecha verificada. Queda
 * afuera:
 *
 * - Lo que se decide por decreto cada año (puentes turísticos, los "días no
 *   laborables" del Ejecutivo).
 * - Lo **trasladable**: "esta fecha fija se corre al lunes según el día en que
 *   caiga" (Ley Emiliani en Colombia, la reforma de 2016 en Ecuador, la Ley
 *   139-97 dominicana, las leyes 19.668/20.299 chilenas). La única excepción
 *   son los tres feriados colombianos atados a Pascua, donde el traslado da un
 *   offset constante — ver el comentario en CO.
 * - Lo que no es nacional (feriados de una provincia o de una ciudad) y lo que
 *   es medio día (el 24 de diciembre guatemalteco, asueto desde las 12).
 *
 * El motivo es que este catálogo le SUGIERE a la clínica qué días cerrar: una
 * fecha de más le hace perder turnos de un día que trabajaba, y una de menos
 * solo le deja un feriado sin cargar, que ya es el caso hoy. Por eso, ante la
 * duda, afuera — y el hueco se llena desde la pantalla de feriados, que existe
 * justamente para eso.
 *
 * Los feriados que quedaron afuera de cada país están anotados en su bloque,
 * para no volver a investigar lo mismo la próxima vez.
 */
const SEED_COUNTRIES: Array<{
  id: string;
  name: string;
  currency: string;
  timezones: string[];
  rules: SeedHolidayRule[];
}> = [
  {
    id: "AR",
    name: "Argentina",
    currency: "ARS",
    timezones: ["America/Argentina/Buenos_Aires"],
    rules: [
      { kind: "fixed", name: "Año Nuevo", month: 1, day: 1 },
      { kind: "easter", name: "Lunes de Carnaval", offsetDays: -48 },
      { kind: "easter", name: "Martes de Carnaval", offsetDays: -47 },
      {
        kind: "fixed",
        name: "Día Nacional de la Memoria por la Verdad y la Justicia",
        month: 3,
        day: 24,
      },
      { kind: "easter", name: "Viernes Santo", offsetDays: -2 },
      {
        kind: "fixed",
        name: "Día del Veterano y de los Caídos en la Guerra de Malvinas",
        month: 4,
        day: 2,
      },
      { kind: "fixed", name: "Día del Trabajador", month: 5, day: 1 },
      { kind: "fixed", name: "Día de la Revolución de Mayo", month: 5, day: 25 },
      {
        kind: "fixed",
        name: "Paso a la Inmortalidad del Gral. Manuel Belgrano",
        month: 6,
        day: 20,
      },
      { kind: "fixed", name: "Día de la Independencia", month: 7, day: 9 },
      { kind: "fixed", name: "Inmaculada Concepción de María", month: 12, day: 8 },
      { kind: "fixed", name: "Navidad", month: 12, day: 25 },
    ],
  },
  {
    id: "BO",
    name: "Bolivia",
    currency: "BOB",
    timezones: ["America/La_Paz"],
    rules: [
      { kind: "fixed", name: "Año Nuevo", month: 1, day: 1 },
      { kind: "easter", name: "Lunes de Carnaval", offsetDays: -48 },
      { kind: "easter", name: "Martes de Carnaval", offsetDays: -47 },
      { kind: "easter", name: "Viernes Santo", offsetDays: -2 },
      { kind: "fixed", name: "Día del Trabajo", month: 5, day: 1 },
      { kind: "easter", name: "Corpus Christi", offsetDays: 60 },
      { kind: "fixed", name: "Día de la Independencia", month: 8, day: 6 },
      { kind: "fixed", name: "Día de Todos los Difuntos", month: 11, day: 2 },
      { kind: "fixed", name: "Navidad", month: 12, day: 25 },
    ],
    // Fuera el 22 de enero (Estado Plurinacional) y el 21 de junio (Año Nuevo
    // Andino Amazónico). Son feriados permanentes (DS 2750), y quedan afuera
    // solo porque el Ejecutivo los corre por decreto: en 2026 el DS 5521 movió
    // el 22 de enero al viernes 23. Sugerir el 22 habría cerrado un día
    // laborable y dejado abierto el feriado. Es la exclusión más discutible
    // del catálogo: si en los próximos años se observan en su fecha, conviene
    // volver a incluirlos.
  },
  {
    id: "BR",
    name: "Brasil",
    currency: "BRL",
    timezones: [
      "America/Sao_Paulo",
      "America/Bahia",
      "America/Fortaleza",
      "America/Recife",
      "America/Belem",
      "America/Maceio",
      "America/Araguaina",
      "America/Santarem",
      "America/Manaus",
      "America/Cuiaba",
      "America/Campo_Grande",
      "America/Porto_Velho",
      "America/Boa_Vista",
      "America/Rio_Branco",
      "America/Eirunepe",
      "America/Noronha",
    ],
    rules: [
      { kind: "fixed", name: "Confraternização Universal", month: 1, day: 1 },
      { kind: "easter", name: "Sexta-feira Santa", offsetDays: -2 },
      { kind: "fixed", name: "Tiradentes", month: 4, day: 21 },
      { kind: "fixed", name: "Dia do Trabalho", month: 5, day: 1 },
      { kind: "fixed", name: "Independência do Brasil", month: 9, day: 7 },
      { kind: "fixed", name: "Nossa Senhora Aparecida", month: 10, day: 12 },
      { kind: "fixed", name: "Finados", month: 11, day: 2 },
      { kind: "fixed", name: "Proclamação da República", month: 11, day: 15 },
      {
        kind: "fixed",
        name: "Dia Nacional de Zumbi e da Consciência Negra",
        month: 11,
        day: 20,
      },
      { kind: "fixed", name: "Natal", month: 12, day: 25 },
    ],
    // El Carnaval y el Corpus Christi quedan FUERA aunque en la práctica casi
    // todo cierre: no son feriados nacionales por ley federal, son "ponto
    // facultativo" y feriado municipal solo donde hay ley local (el Corpus es
    // feriado en 12 capitales y ponto facultativo en 14, Rio incluido).
    // Sugerirlos haría cerrar a una clínica que trabajaba. La clínica que los
    // observa los carga como excepción a mano.
  },
  {
    id: "CL",
    name: "Chile",
    currency: "CLP",
    timezones: [
      "America/Santiago",
      "America/Punta_Arenas",
      // Aysén dejó de cambiar la hora en 2025 y tiene zona propia desde
      // tzdb 2025a: con un tzdata viejo no existe.
      "America/Coyhaique",
      "Pacific/Easter",
    ],
    rules: [
      { kind: "fixed", name: "Año Nuevo", month: 1, day: 1 },
      { kind: "easter", name: "Viernes Santo", offsetDays: -2 },
      // Chile es uno de los pocos países donde el sábado de Semana Santa es
      // feriado legal. Pasa desapercibido porque siempre cae sábado.
      { kind: "easter", name: "Sábado Santo", offsetDays: -1 },
      { kind: "fixed", name: "Día Nacional del Trabajo", month: 5, day: 1 },
      { kind: "fixed", name: "Día de las Glorias Navales", month: 5, day: 21 },
      { kind: "fixed", name: "Día de la Virgen del Carmen", month: 7, day: 16 },
      { kind: "fixed", name: "Asunción de la Virgen", month: 8, day: 15 },
      { kind: "fixed", name: "Independencia Nacional", month: 9, day: 18 },
      { kind: "fixed", name: "Día de las Glorias del Ejército", month: 9, day: 19 },
      { kind: "fixed", name: "Día de Todos los Santos", month: 11, day: 1 },
      { kind: "fixed", name: "Inmaculada Concepción", month: 12, day: 8 },
      { kind: "fixed", name: "Navidad", month: 12, day: 25 },
    ],
    // Fuera los trasladables: San Pedro y San Pablo (29/6) y Encuentro de Dos
    // Mundos (12/10) se corren al lunes según el día en que caen (Ley
    // 19.668), y el Día de las Iglesias Evangélicas (31/10) se corre al
    // viernes (Ley 20.299). También el Día de los Pueblos Indígenas, atado al
    // solsticio de invierno. El Corpus Christi NO está porque dejó de ser
    // feriado en 2007 (Ley 20.148 lo reemplazó por el 16 de julio).
  },
  {
    id: "CO",
    name: "Colombia",
    currency: "COP",
    timezones: ["America/Bogota"],
    rules: [
      { kind: "fixed", name: "Año Nuevo", month: 1, day: 1 },
      { kind: "easter", name: "Jueves Santo", offsetDays: -3 },
      { kind: "easter", name: "Viernes Santo", offsetDays: -2 },
      { kind: "fixed", name: "Día del Trabajo", month: 5, day: 1 },
      // Estos tres los mueve la Ley Emiliani al lunes siguiente, igual que a
      // media docena de fechas fijas. La diferencia es que su fecha base
      // también es móvil, así que el traslado da un offset CONSTANTE respecto
      // de Pascua y sí se puede expresar: Ascensión (jueves, +39) → +43,
      // Corpus Christi (jueves, +60) → +64, Sagrado Corazón (viernes, +68) →
      // +71. Verificado contra los calendarios oficiales de 2025 a 2027.
      { kind: "easter", name: "Ascensión del Señor", offsetDays: 43 },
      { kind: "easter", name: "Corpus Christi", offsetDays: 64 },
      { kind: "easter", name: "Sagrado Corazón de Jesús", offsetDays: 71 },
      { kind: "fixed", name: "Día de la Independencia", month: 7, day: 20 },
      { kind: "fixed", name: "Batalla de Boyacá", month: 8, day: 7 },
      { kind: "fixed", name: "Inmaculada Concepción", month: 12, day: 8 },
      { kind: "fixed", name: "Navidad", month: 12, day: 25 },
    ],
    // Fuera las siete fechas fijas que la Ley Emiliani corre al lunes
    // siguiente (Reyes, San José, San Pedro y San Pablo, Asunción, Día de la
    // Raza, Todos los Santos e Independencia de Cartagena) y el feriado nuevo
    // del 9 de julio (Ley 2578 de 2026), que también es trasladable.
  },
  {
    id: "CR",
    name: "Costa Rica",
    currency: "CRC",
    timezones: ["America/Costa_Rica"],
    rules: [
      { kind: "fixed", name: "Año Nuevo", month: 1, day: 1 },
      { kind: "easter", name: "Jueves Santo", offsetDays: -3 },
      { kind: "easter", name: "Viernes Santo", offsetDays: -2 },
      { kind: "fixed", name: "Día de Juan Santamaría", month: 4, day: 11 },
      { kind: "fixed", name: "Día Internacional del Trabajo", month: 5, day: 1 },
      { kind: "fixed", name: "Anexión del Partido de Nicoya", month: 7, day: 25 },
      { kind: "fixed", name: "Día de la Virgen de los Ángeles", month: 8, day: 2 },
      { kind: "fixed", name: "Día de la Madre", month: 8, day: 15 },
      {
        kind: "fixed",
        name: "Día de la Persona Negra y la Cultura Afrocostarricense",
        month: 8,
        day: 31,
      },
      { kind: "fixed", name: "Día de la Independencia", month: 9, day: 15 },
      { kind: "fixed", name: "Día de la Abolición del Ejército", month: 12, day: 1 },
      { kind: "fixed", name: "Navidad", month: 12, day: 25 },
    ],
  },
  {
    id: "CU",
    name: "Cuba",
    currency: "CUP",
    timezones: ["America/Havana"],
    rules: [
      { kind: "fixed", name: "Triunfo de la Revolución", month: 1, day: 1 },
      { kind: "fixed", name: "Día de la Victoria", month: 1, day: 2 },
      { kind: "easter", name: "Viernes Santo", offsetDays: -2 },
      { kind: "fixed", name: "Día Internacional de los Trabajadores", month: 5, day: 1 },
      { kind: "fixed", name: "Víspera del Día de la Rebeldía Nacional", month: 7, day: 25 },
      { kind: "fixed", name: "Día de la Rebeldía Nacional", month: 7, day: 26 },
      { kind: "fixed", name: "Conmemoración del asalto a Moncada", month: 7, day: 27 },
      { kind: "fixed", name: "Inicio de las Guerras de Independencia", month: 10, day: 10 },
      { kind: "fixed", name: "Navidad", month: 12, day: 25 },
      { kind: "fixed", name: "Fin de Año", month: 12, day: 31 },
    ],
  },
  {
    id: "EC",
    name: "Ecuador",
    currency: "USD",
    timezones: ["America/Guayaquil", "Pacific/Galapagos"],
    rules: [
      { kind: "fixed", name: "Año Nuevo", month: 1, day: 1 },
      { kind: "easter", name: "Lunes de Carnaval", offsetDays: -48 },
      { kind: "easter", name: "Martes de Carnaval", offsetDays: -47 },
      { kind: "easter", name: "Viernes Santo", offsetDays: -2 },
      { kind: "fixed", name: "Navidad", month: 12, day: 25 },
    ],
    // Ecuador queda con 5 de sus 11 feriados, y es correcto que sea así: la
    // reforma de 2016 al Código del Trabajo mueve casi todos según el día en
    // que caen (martes → lunes anterior; miércoles o jueves → viernes
    // siguiente; sábado → viernes anterior; domingo → lunes siguiente). Eso
    // no se puede expresar, y sugerir la fecha sin mover haría cerrar el día
    // equivocado Y abrir el día del feriado. Quedan los dos inamovibles y los
    // atados a Pascua, que no se trasladan. Fuera: 1 de mayo, 24 de mayo,
    // 10 de agosto, 9 de octubre, 2 y 3 de noviembre.
  },
  {
    id: "SV",
    name: "El Salvador",
    currency: "USD",
    timezones: ["America/El_Salvador"],
    rules: [
      { kind: "fixed", name: "Año Nuevo", month: 1, day: 1 },
      { kind: "easter", name: "Jueves Santo", offsetDays: -3 },
      { kind: "easter", name: "Viernes Santo", offsetDays: -2 },
      { kind: "easter", name: "Sábado Santo", offsetDays: -1 },
      { kind: "fixed", name: "Día del Trabajo", month: 5, day: 1 },
      { kind: "fixed", name: "Día del Divino Salvador del Mundo", month: 8, day: 6 },
      { kind: "fixed", name: "Día de la Independencia", month: 9, day: 15 },
      { kind: "fixed", name: "Día de los Difuntos", month: 11, day: 2 },
      { kind: "fixed", name: "Navidad", month: 12, day: 25 },
    ],
    // De las fiestas agostinas solo el 6 es asueto nacional: el 3 y el 5 lo
    // son únicamente en San Salvador, y en el resto del país el asueto es el
    // día de la festividad principal de cada lugar, que varía por municipio.
    //
    // El Día de la Madre (10/5) y el Día del Padre (17/6) quedan fuera: no
    // están en el artículo 190 del Código de Trabajo sino en decretos
    // posteriores, y las fuentes se contradicen sobre si son asueto nacional
    // para el sector privado (hay calendarios oficiales de 2026 que no los
    // listan, y los números de decreto no coinciden entre fuentes). Son el
    // caso exacto de "mejor sugerir de menos": si se confirman con el
    // Ministerio de Trabajo, van como fecha fija.
  },
  {
    id: "US",
    name: "Estados Unidos",
    currency: "USD",
    timezones: [
      "America/New_York",
      "America/Chicago",
      "America/Denver",
      "America/Los_Angeles",
      "America/Phoenix",
      "America/Anchorage",
      "Pacific/Honolulu",
    ],
    rules: [
      { kind: "fixed", name: "Año Nuevo", month: 1, day: 1 },
      { kind: "nthWeekday", name: "Día de Martin Luther King Jr.", month: 1, weekday: 1, ordinal: 3 },
      { kind: "nthWeekday", name: "Natalicio de Washington", month: 2, weekday: 1, ordinal: 3 },
      // Último lunes de mayo: según el año es el cuarto o el quinto, así que
      // necesita `ordinal: -1` y no se puede cargar como fecha fija.
      { kind: "nthWeekday", name: "Día de los Caídos", month: 5, weekday: 1, ordinal: -1 },
      { kind: "fixed", name: "Juneteenth", month: 6, day: 19 },
      { kind: "fixed", name: "Día de la Independencia", month: 7, day: 4 },
      { kind: "nthWeekday", name: "Día del Trabajo", month: 9, weekday: 1, ordinal: 1 },
      { kind: "nthWeekday", name: "Día de Colón", month: 10, weekday: 1, ordinal: 2 },
      { kind: "fixed", name: "Día de los Veteranos", month: 11, day: 11 },
      { kind: "nthWeekday", name: "Día de Acción de Gracias", month: 11, weekday: 4, ordinal: 4 },
      { kind: "fixed", name: "Navidad", month: 12, day: 25 },
    ],
    // Fuera el Inauguration Day (cada cuatro años y solo para empleados
    // federales del área de Washington D.C.) y la regla de "observed": cuando
    // un feriado de fecha fija cae sábado se observa el viernes anterior, y si
    // cae domingo el lunes siguiente. Eso depende del día de la semana y no se
    // puede expresar, así que en esos años se sugiere el sábado o domingo (la
    // clínica ya está cerrada) y no el día hábil en que cierran las oficinas
    // federales. Es el error del lado seguro.
  },
  {
    id: "GT",
    name: "Guatemala",
    currency: "GTQ",
    timezones: ["America/Guatemala"],
    rules: [
      { kind: "fixed", name: "Año Nuevo", month: 1, day: 1 },
      { kind: "easter", name: "Jueves Santo", offsetDays: -3 },
      { kind: "easter", name: "Viernes Santo", offsetDays: -2 },
      { kind: "easter", name: "Sábado Santo", offsetDays: -1 },
      { kind: "fixed", name: "Día del Trabajo", month: 5, day: 1 },
      { kind: "fixed", name: "Día de la Independencia", month: 9, day: 15 },
      { kind: "fixed", name: "Día de la Revolución", month: 10, day: 20 },
      { kind: "fixed", name: "Día de Todos los Santos", month: 11, day: 1 },
      { kind: "fixed", name: "Navidad", month: 12, day: 25 },
    ],
    // El 24 y el 31 de diciembre quedan fuera porque el artículo 127 del
    // Código de Trabajo los declara asueto solo desde las 12: marcarlos como
    // día cerrado haría rechazar turnos de una mañana en que sí se atiende, y
    // el modelo no tiene medio día. Si la clínica igual cierra, eso se carga
    // como excepción con tramo 09:00-12:00, que es lo que dice la ley.
    //
    // El 30 de junio (Día del Ejército) también sale: el Decreto 42-2010,
    // reformado por el 19-2018, lo corre al lunes según el día en que caiga
    // (en 2026 se observó el lunes 29). El 1 de mayo y el 20 de octubre, en
    // cambio, quedaron fijos cuando la Corte de Constitucionalidad dejó sin
    // efecto esa parte en 2020. El 10 de mayo tampoco entra: es asueto solo
    // para las trabajadoras, no un cierre del negocio.
  },
  {
    id: "HN",
    name: "Honduras",
    currency: "HNL",
    timezones: ["America/Tegucigalpa"],
    rules: [
      { kind: "fixed", name: "Año Nuevo", month: 1, day: 1 },
      { kind: "easter", name: "Jueves Santo", offsetDays: -3 },
      { kind: "easter", name: "Viernes Santo", offsetDays: -2 },
      { kind: "easter", name: "Sábado Santo", offsetDays: -1 },
      { kind: "fixed", name: "Día del Trabajo", month: 5, day: 1 },
      { kind: "fixed", name: "Día de la Independencia", month: 9, day: 15 },
      { kind: "fixed", name: "Navidad", month: 12, day: 25 },
    ],
    // La Semana Morazánica queda fuera: el Decreto 78-2015 unificó el 3, 12 y
    // 21 de octubre en los miércoles, jueves y viernes de "la primera semana
    // de octubre", que no es lo mismo que "el primer miércoles de octubre" y
    // se confirma por comunicado cada año. Tres días de cierre mal ubicados
    // son el peor caso posible, así que se cargan a mano. El 14 de abril
    // también sale: el Decreto 50-2003 lo corre al lunes siguiente.
  },
  {
    id: "MX",
    name: "México",
    currency: "MXN",
    timezones: [
      "America/Mexico_City",
      "America/Cancun",
      "America/Merida",
      "America/Monterrey",
      "America/Chihuahua",
      "America/Hermosillo",
      "America/Mazatlan",
      "America/Tijuana",
    ],
    rules: [
      { kind: "fixed", name: "Año Nuevo", month: 1, day: 1 },
      { kind: "nthWeekday", name: "Día de la Constitución", month: 2, weekday: 1, ordinal: 1 },
      { kind: "nthWeekday", name: "Natalicio de Benito Juárez", month: 3, weekday: 1, ordinal: 3 },
      { kind: "fixed", name: "Día del Trabajo", month: 5, day: 1 },
      { kind: "fixed", name: "Día de la Independencia", month: 9, day: 16 },
      { kind: "nthWeekday", name: "Revolución Mexicana", month: 11, weekday: 1, ordinal: 3 },
      { kind: "fixed", name: "Navidad", month: 12, day: 25 },
    ],
  },
  {
    id: "NI",
    name: "Nicaragua",
    currency: "NIO",
    timezones: ["America/Managua"],
    rules: [
      { kind: "fixed", name: "Año Nuevo", month: 1, day: 1 },
      { kind: "fixed", name: "Natalicio de Rubén Darío", month: 1, day: 18 },
      { kind: "fixed", name: "Día Nacional de la Reconciliación y la Paz", month: 2, day: 2 },
      { kind: "fixed", name: "Conmemoración de Augusto C. Sandino", month: 2, day: 21 },
      { kind: "easter", name: "Jueves Santo", offsetDays: -3 },
      { kind: "easter", name: "Viernes Santo", offsetDays: -2 },
      { kind: "fixed", name: "Día Internacional del Trabajo", month: 5, day: 1 },
      { kind: "fixed", name: "Día de las Madres Nicaragüenses", month: 5, day: 30 },
      { kind: "fixed", name: "Aniversario de la Revolución", month: 7, day: 19 },
      { kind: "fixed", name: "Batalla de San Jacinto", month: 9, day: 14 },
      { kind: "fixed", name: "Independencia de Centroamérica", month: 9, day: 15 },
      { kind: "fixed", name: "Conmemoración de Carlos Fonseca Amador", month: 11, day: 8 },
      { kind: "fixed", name: "La Purísima Concepción", month: 12, day: 8 },
      { kind: "fixed", name: "Navidad", month: 12, day: 25 },
    ],
    // La Ley 1272 llevó los feriados de 9 a 14 en enero de 2026 (agregó el 18
    // de enero, el 2 y el 21 de febrero y el 8 de noviembre; el 30 de mayo ya
    // lo había agregado la Ley 1118 en 2022). Las fechas están verificadas;
    // los nombres se reconstruyeron cruzando fuentes y no del texto
    // consolidado del artículo 66, así que pueden querer un ajuste de
    // redacción — el nombre no cambia qué día se cierra.
    //
    // A diferencia de sus vecinos, en Nicaragua el Sábado Santo NO es
    // feriado: es el error más fácil de arrastrar por analogía.
    // Fuera: el 1 y el 10 de agosto, que son asueto solo en Managua.
  },
  {
    id: "PA",
    name: "Panamá",
    currency: "PAB",
    timezones: ["America/Panama"],
    rules: [
      { kind: "fixed", name: "Año Nuevo", month: 1, day: 1 },
      // Del Carnaval solo el martes: el lunes no está en el artículo 46 del
      // Código de Trabajo, aunque de hecho casi todo cierre.
      { kind: "easter", name: "Martes de Carnaval", offsetDays: -47 },
      { kind: "easter", name: "Viernes Santo", offsetDays: -2 },
      { kind: "fixed", name: "Día del Trabajador", month: 5, day: 1 },
      { kind: "fixed", name: "Separación de Panamá de Colombia", month: 11, day: 3 },
      { kind: "fixed", name: "Día de Colón", month: 11, day: 5 },
      {
        kind: "fixed",
        name: "Primer Grito de Independencia de la Villa de los Santos",
        month: 11,
        day: 10,
      },
      { kind: "fixed", name: "Día de la Madre", month: 12, day: 8 },
      // Descanso obligatorio y no un duelo simbólico: la Ley 291 de 2022 lo
      // agregó a las fechas del artículo 46.
      { kind: "fixed", name: "Día de Duelo Nacional", month: 12, day: 20 },
      { kind: "fixed", name: "Navidad", month: 12, day: 25 },
    ],
    // El 9 de enero (Día de los Mártires) y el 28 de noviembre
    // (Independencia de España) quedan FUERA aunque casi todos los
    // calendarios los muestren como fijos: la Ley 70 de 2007 les impuso
    // traslado al lunes "automático y obligatorio" según el día en que caen.
    // Fuera también el 4 de noviembre (no está en el artículo 46; el sector
    // privado trabaja) y los "días puente" que el Ejecutivo puede decretar
    // sobre cualquier feriado — ese es el riesgo que queda y por eso el
    // catálogo sugiere en vez de cargar.
    //
    // Cuando un feriado cae domingo el descanso pasa al lunes (artículo 47):
    // la fecha base sigue siendo la de acá, y el lunes no se sugiere.
  },
  {
    id: "PY",
    name: "Paraguay",
    currency: "PYG",
    timezones: ["America/Asuncion"],
    rules: [
      { kind: "fixed", name: "Año Nuevo", month: 1, day: 1 },
      { kind: "easter", name: "Jueves Santo", offsetDays: -3 },
      { kind: "easter", name: "Viernes Santo", offsetDays: -2 },
      { kind: "fixed", name: "Día de los Trabajadores", month: 5, day: 1 },
      // La independencia se conmemora dos días, y los dos son feriado.
      { kind: "fixed", name: "Día de la Independencia Nacional", month: 5, day: 14 },
      { kind: "fixed", name: "Día de la Independencia Nacional", month: 5, day: 15 },
      { kind: "fixed", name: "Día de la Fundación de Asunción", month: 8, day: 15 },
      { kind: "fixed", name: "Día de la Virgen de Caacupé", month: 12, day: 8 },
      { kind: "fixed", name: "Navidad", month: 12, day: 25 },
    ],
    // La Ley 7544/2025 reemplazó a la 1723/2001 y dejó cuatro feriados
    // móviles, que quedan fuera por trasladables: 1 de marzo, 12 y 20 de
    // junio y 29 de septiembre. También los hasta tres que el Ejecutivo puede
    // fijar por decreto cada año para el turismo.
  },
  {
    id: "PE",
    name: "Perú",
    currency: "PEN",
    timezones: ["America/Lima"],
    rules: [
      { kind: "fixed", name: "Año Nuevo", month: 1, day: 1 },
      { kind: "easter", name: "Jueves Santo", offsetDays: -3 },
      { kind: "easter", name: "Viernes Santo", offsetDays: -2 },
      { kind: "fixed", name: "Día del Trabajo", month: 5, day: 1 },
      { kind: "fixed", name: "Batalla de Arica y Día de la Bandera", month: 6, day: 7 },
      { kind: "fixed", name: "San Pedro y San Pablo", month: 6, day: 29 },
      { kind: "fixed", name: "Día de la Fuerza Aérea del Perú", month: 7, day: 23 },
      { kind: "fixed", name: "Fiestas Patrias", month: 7, day: 28 },
      { kind: "fixed", name: "Día de las Fuerzas Armadas y la Policía Nacional", month: 7, day: 29 },
      { kind: "fixed", name: "Batalla de Junín", month: 8, day: 6 },
      { kind: "fixed", name: "Santa Rosa de Lima", month: 8, day: 30 },
      { kind: "fixed", name: "Combate de Angamos", month: 10, day: 8 },
      { kind: "fixed", name: "Día de Todos los Santos", month: 11, day: 1 },
      { kind: "fixed", name: "Inmaculada Concepción", month: 12, day: 8 },
      { kind: "fixed", name: "Batalla de Ayacucho", month: 12, day: 9 },
      { kind: "fixed", name: "Navidad", month: 12, day: 25 },
    ],
    // Fuera los "días no laborables para el sector público" que el Ejecutivo
    // declara por decreto cada año (los de los fines de semana largos): son
    // compensables y no aplican al sector privado salvo acuerdo.
    //
    // OJO para el futuro: hay un dictamen aprobado en comisión (no es ley al
    // 2026-09) para trasladar al lunes los feriados que caen de martes a
    // viernes. Si se promulga, la mayoría de estas 16 reglas deja de valer y
    // Perú pasa a ser un caso como Ecuador.
  },
  {
    id: "DO",
    name: "República Dominicana",
    currency: "DOP",
    timezones: ["America/Santo_Domingo"],
    rules: [
      { kind: "fixed", name: "Año Nuevo", month: 1, day: 1 },
      { kind: "fixed", name: "Día de Nuestra Señora de la Altagracia", month: 1, day: 21 },
      { kind: "fixed", name: "Día de la Independencia Nacional", month: 2, day: 27 },
      { kind: "easter", name: "Viernes Santo", offsetDays: -2 },
      // El artículo 3 exceptúa del traslado a los religiosos que se fijan por
      // el día de la semana, y nombra al Corpus Christi entre ellos.
      { kind: "easter", name: "Corpus Christi", offsetDays: 60 },
      { kind: "fixed", name: "Día de la Restauración de la República", month: 8, day: 16 },
      { kind: "fixed", name: "Día de Nuestra Señora de las Mercedes", month: 9, day: 24 },
      { kind: "fixed", name: "Navidad", month: 12, day: 25 },
    ],
    // La Ley 139-97 corre al lunes los feriados que caen de martes a viernes,
    // así que quedan fuera los cuatro del artículo 4: Reyes (6/1), el
    // Natalicio de Duarte (26/1), el Día del Trabajo (1/5) y el Día de la
    // Constitución (6/11) — sí, el 1 de mayo acá es trasladable.
    //
    // El 16 de agosto se queda: la letra del artículo 4 lo lista como
    // trasladable, pero el Ministerio de Trabajo lo declaró inamovible
    // también en años que no son de toma de posesión (2022 y 2023), por el
    // artículo 35 de la Constitución y una sentencia de la Suprema Corte.
    //
    // El Jueves Santo queda fuera: el artículo 3 lo nombra, pero no aparece
    // en las resoluciones anuales del Ministerio de Trabajo.
  },
  {
    id: "UY",
    name: "Uruguay",
    currency: "UYU",
    timezones: ["America/Montevideo"],
    rules: [
      { kind: "fixed", name: "Año Nuevo", month: 1, day: 1 },
      { kind: "fixed", name: "Día de los Trabajadores", month: 5, day: 1 },
      { kind: "fixed", name: "Jura de la Constitución", month: 7, day: 18 },
      { kind: "fixed", name: "Declaratoria de la Independencia", month: 8, day: 25 },
      { kind: "fixed", name: "Navidad", month: 12, day: 25 },
    ],
    // Uruguay distingue feriados NO laborables (estos cinco, en los que la
    // actividad cesa) de feriados LABORABLES, en los que se trabaja normal:
    // Reyes, Carnaval, Semana de Turismo, 19 de junio, 2 de noviembre y 8 de
    // diciembre. Sugerir los laborables sería sugerir cerrar un día hábil
    // común, así que van solo los cinco. Fuera también los trasladables de
    // las Leyes 16.805/17.414.
  },
  {
    id: "VE",
    name: "Venezuela",
    currency: "VES",
    timezones: ["America/Caracas"],
    rules: [
      { kind: "fixed", name: "Año Nuevo", month: 1, day: 1 },
      { kind: "easter", name: "Lunes de Carnaval", offsetDays: -48 },
      { kind: "easter", name: "Martes de Carnaval", offsetDays: -47 },
      { kind: "easter", name: "Jueves Santo", offsetDays: -3 },
      { kind: "easter", name: "Viernes Santo", offsetDays: -2 },
      { kind: "fixed", name: "Declaración de la Independencia", month: 4, day: 19 },
      { kind: "fixed", name: "Día del Trabajador", month: 5, day: 1 },
      { kind: "fixed", name: "Batalla de Carabobo", month: 6, day: 24 },
      { kind: "fixed", name: "Día de la Independencia", month: 7, day: 5 },
      { kind: "fixed", name: "Natalicio de Simón Bolívar", month: 7, day: 24 },
      { kind: "fixed", name: "Día de la Resistencia Indígena", month: 10, day: 12 },
      { kind: "fixed", name: "Nochebuena", month: 12, day: 24 },
      { kind: "fixed", name: "Navidad", month: 12, day: 25 },
      { kind: "fixed", name: "Fin de Año", month: 12, day: 31 },
    ],
    // El Carnaval y la Semana Santa acá SÍ son feriados legales nacionales
    // (artículo 184 de la LOTTT), a diferencia de otros países donde son
    // costumbre. Lo que queda fuera es el literal d) del mismo artículo: hasta
    // tres días más por año que pueden declarar el Gobierno, los Estados o los
    // Municipios. Venezuela los usa seguido, así que este catálogo va a quedar
    // corto y la clínica va a tener que cargar excepciones a mano.
  },
];

/**
 * Los dos planes de arranque. El super-admin puede crear más desde la
 * pantalla de plataforma "Planes" — esto es solo el punto de partida para
 * un ambiente nuevo, igual que `SEED_COUNTRIES`.
 */
const SEED_PLANS: Array<{ name: string; description: string; features: string[] }> = [
  {
    name: "Base",
    description: "Agendar, recordatorios de 24hs, multi-profesional, dashboard, CRM.",
    features: [],
  },
  {
    name: "Plus",
    description:
      "Todo lo de Base más recordatorio a 2hs, cobro de seña, seguimiento post-visita, contacto por próxima cita y seguimiento de campañas.",
    features: [
      PLAN_FEATURES.DEPOSIT,
      PLAN_FEATURES.REMINDER_2H,
      PLAN_FEATURES.POST_VISIT_FOLLOWUP,
      PLAN_FEATURES.NEXT_VISIT_OUTREACH,
      PLAN_FEATURES.CAMPAIGN_FOLLOWUP,
    ],
  },
];

/**
 * Títulos de arranque del catálogo de plataforma. El super-admin agrega los
 * que le falten desde la pantalla "Títulos" — esto es solo el punto de
 * partida, igual que `SEED_COUNTRIES`.
 *
 * Están todos acá, de rubros distintos a propósito: el catálogo es global y
 * lo que hace que un spa no vea "Dr." no es que no exista, es que nadie se lo
 * habilitó. Ninguna clínica arranca con títulos habilitados.
 */
const SEED_TITLES = [
  "Dr.",
  "Dra.",
  "Lic.",
  "Odontólogo",
  "Odontóloga",
  "Psicólogo",
  "Psicóloga",
  "Kinesiólogo",
  "Kinesióloga",
  "Esteticista",
  "Cosmetólogo",
  "Cosmetóloga",
  "Manicurista",
];

/**
 * Obras sociales y prepagas de arranque del catálogo de plataforma, de los
 * países donde hay clínicas hoy. El super-admin agrega las que falten desde
 * "Catálogo de seguros" — esto es solo el punto de partida.
 *
 * Están todas juntas y sin país a propósito: ninguna clínica arranca con
 * seguros tomados, así que una clínica mexicana no ve las argentinas hasta
 * que alguien las activa. Modelar el país de cada aseguradora sería un dato
 * más para mantener sin cambiar lo que el agente contesta.
 */
const SEED_INSURERS = [
  // Argentina
  "OSDE",
  "Swiss Medical",
  "Galeno",
  "Medifé",
  "Omint",
  "OSECAC",
  "PAMI",
  "IOMA",
  // México
  "GNP Seguros",
  "AXA",
  "MetLife",
  "Seguros Monterrey New York Life",
  "IMSS",
  "ISSSTE",
];

async function main() {
  for (const permission of PERMISSION_CATALOG) {
    await prisma.permission.upsert({
      where: { id: permission.id },
      update: { description: permission.description, group: permission.group },
      create: permission,
    });
  }

  // No se usa `upsert` con `clinicId: null` en la clave compuesta: un
  // UNIQUE de Postgres no deduplica NULLs entre sí, así que dos corridas
  // del seed podrían terminar creando dos roles "Super Admin" en vez de
  // reusar el mismo. Se busca a mano en su lugar.
  let superAdminRole = await prisma.role.findFirst({ where: { clinicId: null, name: "Super Admin" } });
  if (!superAdminRole) {
    superAdminRole = await prisma.role.create({
      data: { clinicId: null, name: "Super Admin", isSystem: true, description: "Acceso total a la plataforma." },
    });
  }

  await prisma.$transaction([
    prisma.rolePermission.deleteMany({ where: { roleId: superAdminRole.id } }),
    prisma.rolePermission.createMany({
      data: ALL_PERMISSION_IDS.map((permissionId) => ({ roleId: superAdminRole.id, permissionId })),
    }),
  ]);

  for (const plan of SEED_PLANS) {
    await prisma.plan.upsert({
      where: { name: plan.name },
      update: { description: plan.description, features: plan.features },
      create: { name: plan.name, description: plan.description, features: plan.features, isSystem: true },
    });
  }

  // Solo se crea el que falte: `active` y el nombre se administran desde la
  // pantalla, así que el seed no los pisa en una segunda corrida.
  for (const name of SEED_TITLES) {
    await prisma.professionalTitle.upsert({ where: { name }, update: {}, create: { name } });
  }

  for (const name of SEED_INSURERS) {
    await prisma.insurer.upsert({ where: { name }, update: {}, create: { name } });
  }

  for (const country of SEED_COUNTRIES) {
    await prisma.country.upsert({
      where: { id: country.id },
      update: { name: country.name, currency: country.currency, timezones: country.timezones },
      create: {
        id: country.id,
        name: country.name,
        currency: country.currency,
        timezones: country.timezones,
      },
    });

    // Se reemplazan las reglas del país (no se acumulan) para que correr
    // el seed de nuevo no duplique feriados si este archivo cambia.
    await prisma.$transaction([
      prisma.holidayRule.deleteMany({ where: { countryId: country.id } }),
      prisma.holidayRule.createMany({
        data: country.rules.map((rule) => ({ ...rule, countryId: country.id })),
      }),
    ]);
  }

  // Los roles "Admin de clínica" son una fila por clínica, así que un permiso
  // nuevo en el catálogo no les llega solo. Correr el seed los pone al día.
  const clinics = await prisma.clinic.findMany({ select: { id: true } });
  for (const clinic of clinics) {
    await ensureClinicAdminRole(clinic.id);
  }

  // Los permisos que pasaron a ser solo de plataforma no pueden quedar en ningún rol de una clínica
  // (tampoco en los que armó la propia clínica): no hay pantalla ni ruta de clínica que los use.
  const { count: sacados } = await prisma.rolePermission.deleteMany({
    where: { permissionId: { in: PLATFORM_ONLY_PERMISSIONS }, role: { clinicId: { not: null } } },
  });
  if (sacados > 0) console.log(`Se sacaron ${sacados} permisos de plataforma de roles de clínica.`);

  console.log(
    `Seed ok: ${PERMISSION_CATALOG.length} permisos, rol "Super Admin" con todos los permisos, ${SEED_PLANS.length} planes, ${SEED_COUNTRIES.length} países, ${SEED_TITLES.length} títulos, ${SEED_INSURERS.length} seguros, ${clinics.length} roles de clínica al día.`
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
