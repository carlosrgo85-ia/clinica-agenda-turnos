# Casos de uso y casos de prueba

Catálogo de lo que hace la plataforma y de cómo comprobarlo. Sirve para dos
cosas: saber qué comportamiento es el esperado (la fuente de las reglas sigue
siendo `CLAUDE.md`) y tener a mano qué probar a mano antes de una demo o un
despliegue.

## Cómo leer este documento

- **ID**: prefijo del área + número. No se reutilizan ni se renumeran: si un caso
  deja de aplicar se marca como *Retirado*, para que las referencias viejas
  sigan significando lo mismo.
- **Cobertura**:
  - **Auto** — lo verifica un test automático (se indica el archivo en `tests/`).
  - **Manual** — hay que probarlo a mano. Casi todo lo que depende de que el
    modelo redacte bien, de Meta, de Google o de Microsoft cae acá: un test no
    puede garantizar el texto que escribe Claude.
  - **Parcial** — la regla está testeada, pero el flujo completo no.
- **⚠ IMPORTANTE** — marca un caso que hay que verificar antes de una demo o de
  salir a producción, porque depende de que el modelo se comporte bien y **ningún
  test lo puede garantizar**: la parte automática prueba que la regla le llega al
  prompt, no que la obedezca. Están reunidos abajo, en "Casos importantes".
- Los tests automáticos van contra Postgres (`docker compose up -d db` y
  `npm test`). No cubren el handler de Express ni los jobs.

### Áreas

| Prefijo | Área |
|---|---|
| AG | Agendar un turno por WhatsApp |
| MO | Cancelar y reprogramar |
| SV | Quién realiza qué servicio |
| ES | Escalamiento a una persona |
| FA | Un número, varias personas |
| MS | Mensajes seguidos |
| UB | Ubicación de la clínica |
| SG | Seguros |
| HR | Horarios, feriados y excepciones |
| TN | Tono y cierre de los mensajes |
| CL | Calendarios (Google y Microsoft) |
| AE | Agenda editable (crear, mover, editar, cancelar, bloquear) |
| RC | Recursos y servicios (dashboard de la clínica) |
| AU | Auditoría de la aplicación y eventos de cada cita |
| PA | Pacientes: la ficha y lo que el asistente sabe de quien ya vino |
| PQ | Paquetes de sesiones |
| PL | Panel de plataforma (super-admin) |
| JB | Tareas programadas (worker) |
| SE | Acceso y permisos |

### Casos importantes

Estos se prueban con conversaciones reales, y conviene repetirlos cada vez que se
toque el prompt (`prompts/system-prompt.ts`) o se cambie de modelo.

| ID | Qué se verifica | Por qué importa |
|---|---|---|
| **SV-16** | ⚠ Que el modelo traduzca lo que dice el paciente al nombre exacto del catálogo | Si falla, se deriva a una persona (y se avisa a la clínica) por un servicio que sí hace |
| **AU-01** | ⚠ La auditoría de punta a punta, desde el login, y que no guarde lo que se escribió | Es la garantía de trazabilidad de toda la aplicación, y una fuga de datos clínicos al registro sería grave y permanente |
| **AU-27** | ⚠ Que el recorrido real por WhatsApp deje el alta del paciente y sus cambios de etapa en la auditoría | El webhook no tiene tests: es lo único que prueba que las piezas, que sí están probadas, quedan conectadas |
| **AU-20** | ⚠ Que el asistente pregunte el motivo de la cancelación con sutileza, sin frenarla, y que una queja llegue a una persona | Es lo único de esto que depende del modelo, y de ahí sale el reporte de motivos y quejas |
| **AU-02** | ⚠ Que reagendar no se cuente como cancelar ni como reserva nueva | Es lo que hace que los reportes de cancelaciones y reagendadas sean confiables |
| **PA-01** | ⚠ Que el asistente trate con cercanía a quien ya vino, pregunte cómo le fue y proponga la cita sin recitar las notas internas | Es lo único del módulo que depende del modelo, y se envían datos del paciente a un servicio externo |
| **PA-02** | ⚠ El contacto por la próxima cita sugerida, con la plantilla real aprobada por Meta | Si Meta la reclasifica como Marketing o no la aprueba, nadie recibe nada; y si falla al revés, se le escribe a quien no corresponde |
| **CH-01** | ⚠ Que el chat de pruebas no deje NADA hacia afuera: ni un WhatsApp, ni un aviso a un profesional, ni un evento en su calendario, ni una derivación | Si una prueba le manda un mensaje a un profesional o ensucia una agenda real, la clínica deja de confiar en la herramienta |
| **CA-01** | ⚠ El recorrido real de una campaña: anuncio de Meta o link con texto prellenado → contacto en "Campañas" → agendar → "Agendaron" | El webhook no tiene tests y el `referral` de Meta no se puede probar con mocks: es lo único que prueba que la atribución anda de punta a punta |
| **CA-02** | ⚠ Que el asistente cuente SOLO lo que dice la promoción, no invente precios y no ofrezca una promoción vencida | Depende del modelo (probabilístico); una promesa de precio falsa es plata de la clínica |
| **CA-03** | ⚠ El seguimiento con la plantilla real aprobada por Meta, y que se detenga en el tope | Si Meta la rechaza nadie recibe nada; y si falla el tope, se insiste de más a una persona |
| **RP-01** | ⚠ Que los números de los reportes cuadren con lo que se ve en Citas y Agenda, y que el CSV abra bien en Excel | Las reglas están testeadas, pero la pantalla y el CSV con tildes en Excel no: un reporte que no cuadra se deja de usar |
| **PQ-01** | ⚠ El recorrido completo de un paquete, con las pantallas | Las reglas están testeadas, pero la pantalla y las rutas no: es lo único que prueba que la asistente puede hacerlo |
| **PQ-02** | ⚠ Que agendar por WhatsApp ate la cita al paquete | Si no se ata, la sesión nunca se descuenta y el paciente cree que le quedan más |

---

## Datos de prueba recomendados

Una clínica de ejemplo para que los casos de abajo den el resultado indicado.

| Dato | Valor |
|---|---|
| Profesionales | **Gómez** y **Ruiz**, ambos activos |
| Servicios | **Limpieza** (30 min; Gómez y Ruiz), **Blanqueamiento** (60 min; **solo Ruiz**) |
| Espacios | Al menos dos, activos |
| Horario | Lunes a viernes, 09:00–13:00 y 14:00–18:00 |
| Contacto | `Clinic.email` o `urgencyNotifyEmail` cargado; `adminPhone` cargado para probar el WhatsApp |
| Servicio de primera vez | Ninguno, salvo que el caso lo pida |

**Paciente "con historial" vs. "nuevo".** Un paciente es *nuevo* si ninguna
ficha de ese número tiene turnos, ni siquiera cancelados. Para repetir un caso
de paciente nuevo usa un número sin historial (recuerda la lista de números de
prueba permitidos en Meta) o borra los turnos de esa ficha en la base. Para un
caso de paciente "con historial" agenda antes un turno cualquiera.

**Dónde mirar el resultado.**

- Lo que contestó el bot: el chat de WhatsApp y la pantalla "Conversaciones".
- Si se creó el turno y con quién: "Citas" y "Agenda".
- Derivaciones: "Por atender" (`/escalations`).
- Qué decidió el código: el log del servidor (`huecos_consultados`, avisos de
  `No se pudo agendar…`) y, si hace falta, la base.

---

## SV — Quién realiza qué servicio

Los tres primeros (SV-01 a SV-03) son los que se pidieron probar primero y van
detallados paso a paso. Reglas en `CLAUDE.md`, sección "Qué profesional realiza
qué servicio".

### SV-01 — Pide un servicio con un profesional que no lo hace

**Cobertura:** Auto (regla) + Manual (redacción del bot).
`tests/service-professionals.test.ts` → *ignora el pedido de un profesional que
no hace el servicio*, *si piden a quien no lo hace, avisa y ofrece los de quien
sí*.

**Precondiciones.** Datos de prueba recomendados. Paciente **con historial**
(para que no entre la regla de primera vez). Sin servicio de primera vez marcado.

**Pasos.**

1. Escribe: *"Quiero un blanqueamiento con Gómez"*.
2. Lee la respuesta del bot.
3. Contesta eligiendo uno de los horarios que te ofrezca.
4. Revisa la cita creada.

**Resultado esperado.**

- El bot **no ofrece horarios con Gómez**. Explica, con diplomacia y sin sonar a
  rechazo, que Gómez no atiende ese tratamiento, y propone a **Ruiz**, que sí lo
  realiza.
- Los horarios ofrecidos son los de Ruiz (como máximo 3 opciones), y en ese
  mensaje `confirmacion_explicita` es `false`: todavía no hay turno.
- Al elegir un horario, se crea la cita **con Ruiz**, con el servicio
  *Blanqueamiento* y duración de 60 min.
- En el log aparece `huecos_consultados` con horarios disponibles (`blocker`
  nulo).

**Variantes.**

| # | Variante | Esperado |
|---|---|---|
| a | El paciente insiste: *"No, solo con Gómez"* | El bot mantiene que Gómez no realiza ese servicio y ofrece alternativas (Ruiz, u otro servicio que sí haga Gómez). No agenda con Gómez. |
| b | Pide *Limpieza* con Gómez | Sí se agenda con Gómez: es un pedido válido. |
| c | El modelo repite "Gómez" al confirmar, aunque se le ofreció Ruiz | La reserva ignora a Gómez (no realiza el servicio) y asigna a Ruiz, el único habilitado. Revisar que el texto de confirmación diga Ruiz. |
| d | Pide a Ruiz, pero Ruiz está ocupado a esa hora | No es este caso: es un pedido válido sin lugar. El bot ofrece otros horarios de Ruiz. |

### SV-02 — Pide algo que no está en el catálogo

**Cobertura:** Auto (regla) + Manual (derivación completa, correo y WhatsApp).
`tests/service-professionals.test.ts` → *rechaza un servicio que la clínica no
ofrece*, *servicio no ofrecido y servicio sin profesional*.

**Precondiciones.** Datos de prueba recomendados, con el catálogo cargado (el
caso no aplica a clínicas sin catálogo, ver SV-06). `Clinic.email` o
`urgencyNotifyEmail` cargado. Para el WhatsApp, `adminPhone` y la plantilla
`aviso_configuracion` aprobada en Meta.

**Pasos.**

1. Escribe: *"Quiero una ortodoncia"* (algo que no figura en Servicios).
2. Lee la respuesta del bot.
3. Revisa "Por atender", el correo de la clínica y el WhatsApp del administrador.

**Resultado esperado.**

- El bot **no ofrece horarios ni confirma nada**. Dice con amabilidad que por
  ahora no puede confirmárselo y que alguien de la clínica lo va a contactar.
  No inventa alternativas.
- **No se crea ningún turno.**
- Aparece **una** derivación en "Por atender", con motivo *Otro*, el mensaje
  textual del paciente y el detalle *"Pidió "ortodoncia", que no figura entre
  los servicios que ofrece la clínica."*. Queda con `notifiedByEmail: true` si
  el correo salió.
- **Correo** a `urgencyNotifyEmail` (o a `Clinic.email`) con la instrucción:
  si es un servicio que la clínica sí presta, inclúyelo en el módulo
  "Servicios" y asígnalo a quien lo realiza.
- **WhatsApp** al `adminPhone`, por la plantilla `aviso_configuracion`, con el
  mismo mensaje y el link a Servicios. Si la plantilla aún no está aprobada, el
  envío falla y solo queda en el log: el correo y la derivación igual existen.
- En el log: `huecos_consultados` con `blocker: "servicio_no_ofrecido"`.

**Variantes.**

| # | Variante | Esperado |
|---|---|---|
| a | El paciente repite el pedido en el mensaje siguiente | Se registra otra derivación (no hay deduplicación entre mensajes). |
| b | Nombre coloquial de un servicio que sí existe (*"una limpieza"*, *"limpieza dental"*) | **No** deriva: el modelo lo traduce al nombre del catálogo. Si deriva, es un falso positivo — ver **SV-16**, que lo prueba en detalle. |
| c | El modelo marca además `escalar_a_humano` | Una sola derivación, no dos. |
| d | Cargas el servicio en Servicios y lo asignas, y el paciente vuelve a pedir | Ahora se ofrecen horarios normalmente. |

### SV-03 — Servicio en el catálogo, pero nadie lo realiza

**Cobertura:** Auto. `tests/service-professionals.test.ts` → *rechaza un servicio
que ningún profesional activo realiza*.

**Precondiciones.** Datos recomendados. Desactiva a Ruiz (único que hace
Blanqueamiento).

**Pasos.** Escribe *"Quiero un blanqueamiento"*.

**Resultado esperado.** Igual que SV-02: sin horarios, sin turno, derivación,
correo y WhatsApp. El detalle dice *"está en el catálogo pero no tiene ningún
profesional activo asignado"*. Log: `blocker: "servicio_sin_profesional"`.
Además `config-health` muestra el aviso `servicio_sin_profesional`.

### SV-04 — Pide algo siendo paciente nuevo

**Cobertura:** Auto (regla) + Manual (redacción del bot, ubicación).
`tests/service-professionals.test.ts` → *el paciente nuevo parte por el
diagnóstico*, *una urgencia no pasa por el servicio de primera vez*.

**Precondiciones.** Datos recomendados más un servicio **"Diagnóstico inicial"**
(45 min) marcado como *primera vez* y asignado **solo a Gómez**. Un número
**sin historial**.

**Pasos.**

1. Escribe: *"Quiero un blanqueamiento"*.
2. Lee la respuesta y elige un horario.
3. Revisa la cita y los mensajes que llegan después.
4. Con el mismo número, pide otra vez un blanqueamiento.

**Resultado esperado.**

- El bot explica con amabilidad que el primer turno es siempre el *Diagnóstico
  inicial*, y ofrece solo horarios de **Gómez**. No le ofrece elegir otro
  servicio ni otro profesional para este primer turno.
- La cita se crea con servicio **"Diagnóstico inicial"** y profesional
  **Gómez**, aunque el paciente pidió otra cosa.
- Después de la confirmación llega aparte el mensaje con la dirección y el link
  de Maps (primer turno).
- En el paso 4 el paciente ya no es nuevo: se ofrecen horarios de **Ruiz** para
  el blanqueamiento.

**Variantes.**

| # | Variante | Esperado |
|---|---|---|
| a | Mensaje de urgencia (según los criterios de la clínica) | Va a escalamiento (ES-01), **no** al diagnóstico. |
| b | La clínica no marcó ningún servicio de primera vez | No se fuerza nada: el paciente nuevo pide el servicio y el profesional que quiera (la regla vieja del profesional principal se retiró el 2026-11-10). |
| c | El paciente nuevo agenda para otra persona de la familia (ficha nueva) | A esa persona también se le aplica el diagnóstico (ver FA-02). |
| f | Un titular conocido pide para otra persona que nunca vino | Esa persona figura como [PRIMERA VEZ] y el bot **no** dice que le agenda otro servicio: explica que parte por el diagnóstico. La cita queda con el diagnóstico y su profesional. | Auto (`appointments-context.test.ts`) + Manual |
| g | Paciente nuevo que pide un tratamiento (*"una extracción"*, *"una cita para implantes"*) | El bot dice **en una frase** que primero va la evaluación inicial y ofrece solo sus horarios. **NO propone agendar también el tratamiento ni explica las opciones**: eso solo pasa si la persona lo pide. No agenda el tratamiento antes de que lo pida. | Auto (la regla le llega: `prompt-style.test.ts`) + **Manual** |
| h | La persona PIDE dejar también el tratamiento (o pregunta si puede ser el mismo día) | Tras agendar la evaluación, ofrece horarios del tratamiento que empiezan cuando termina o después, con un profesional que lo realice (puede ser otro). Al confirmar, resume **las dos citas** con día, hora y profesional. | Manual (la regla de no pisarse es Auto, MO-14) |
| i | Agenda solo la evaluación (el caso normal) | Se agenda solo esa; el bot agrega una frase corta: el tratamiento se define después con el profesional. | Manual |
| j | Con las dos citas, pide mover la evaluación | El bot pregunta también qué hacer con la cita del tratamiento. | Manual |
| d | Marcas otro servicio como primera vez | El anterior se desmarca: solo hay uno por clínica. |
| e | El servicio de primera vez no tiene profesionales asignados | Se trata como SV-03: deriva a una persona. |

### Otros casos de SV

| ID | Caso | Esperado | Cobertura |
|---|---|---|---|
| SV-05 | Alta de un profesional **sin** elegir servicios, con catálogo cargado | Se rechaza con un mensaje. En pantalla se frena antes de llamar a la API. | Parcial (regla en `professional-services.repository`, ruta sin test) |
| SV-06 | Clínica **sin** catálogo de servicios (texto libre) | No se restringe nada: cualquier profesional agenda cualquier servicio, y no hay derivación por "no ofrecido". | Auto (`service-professionals.test.ts`) |
| SV-07 | Activar un profesional que no tiene servicios | Se rechaza: primero hay que asignarle uno. | Manual |
| SV-08 | Quitar un servicio a un profesional dejándolo sin ninguno | Se rechaza. | Manual |
| SV-09 | Desde Servicios, quitar a alguien que no tiene otro servicio | Se rechaza (409) y nombra a quién hay que reasignar primero. | Auto (`service-professionals.test.ts`) |
| SV-10 | Pregunta *"¿quién hace blanqueamientos?"* | Contesta con la línea "Qué realiza cada profesional": Ruiz. | Manual |
| SV-11 | Marcar un servicio como "primera vez" desmarca el anterior | Un solo servicio de primera vez por clínica. | Auto |
| SV-12 | `config-health` con profesional sin servicios / servicio sin profesional | Dos avisos de tipo advertencia, con los nombres. | Auto |
| SV-13 | Un profesional de otra clínica no se puede tocar | La operación devuelve que no existe. | Auto |
| SV-14 | Un `serviceId` de otra clínica en el alta o edición | 400: no es de esta clínica. | Manual |
| SV-15 | Una clínica existente tras la migración | Todos los profesionales tienen todos los servicios: nada se rompe. | Manual (revisar la tabla `_ProfessionalServices`) |

### SV-16 — ⚠ IMPORTANTE: el paciente nombra un servicio con sus palabras

**Cobertura:** Auto (la regla llega al prompt y el evento se registra) + **Manual,
que es la parte que importa** (que el modelo realmente traduzca). Tests:
`tests/services-catalog.test.ts` → *con catálogo, le pide al modelo copiar el
nombre exacto…*, *sin catálogo, no agrega esa regla*; `tests/agent-turn.test.ts`
→ *servicio que no matchea el catálogo*.

**Por qué es importante.** El código busca el servicio por coincidencia de texto:
el nombre del catálogo tiene que *contener* lo que devuelve el modelo. Si el
modelo copia lo que dijo la persona (*"limpieza dental"*), no matchea
*"Limpieza"* y se trata como un servicio que la clínica no ofrece: no se ofrecen
horarios, se **deriva a una persona** y se **avisa a la clínica** de que le falta
cargar algo que sí tiene. Es una paciente perdida por un falso rechazo, y se ve
igual que un servicio realmente no ofrecido. Por eso el prompt le exige al
modelo traducir al nombre exacto del catálogo; esa instrucción es probabilística,
y este caso es el único control real.

**Precondiciones.** Datos de prueba recomendados (catálogo con **Limpieza** y
**Blanqueamiento**), con un paciente **con historial** (si es nuevo, entra la
regla de primera vez y mezcla el resultado). Acceso a Monitoreo.

**Pasos.** Abre una conversación nueva por cada frase (el historial contamina) y
anota el resultado:

| # | Escribe | Esperado |
|---|---|---|
| a | *"Quiero una limpieza"* | Ofrece horarios de Limpieza. **No** deriva. |
| b | *"Quiero una limpieza dental"* | Igual que a. Es el caso que antes fallaba. |
| c | *"Necesito limpiarme los dientes"* | Igual que a. |
| d | *"Quiero blanquearme los dientes"* | Ofrece horarios de **Blanqueamiento** (solo con Ruiz). |
| e | *"Quiero un masaje"* (algo que la clínica no hace) | **Sí** deriva, como SV-02: sin horarios, sin turno, derivación, correo y WhatsApp. **No** debe agendarse con la duración por default. |
| f | *"Quiero una cita"* (sin decir qué) | Pregunta qué servicio necesita. No deriva ni agenda. |

**Cómo comprobar lo que decidió el sistema.**

- En Monitoreo → "Eventos recientes", filtra por *Servicio pedido sin match en el
  catálogo*. Cada derivación por servicio no ofrecido deja uno con el texto que
  devolvió el modelo. Para a, b, c, d y f **no debe aparecer ninguno**; para e
  debe aparecer uno con *"masaje"* (o algo equivalente).
- En el log del servidor: `huecos_consultados` con `blocker: null` en a–d, y
  `blocker: "servicio_no_ofrecido"` solo en e.

**Cómo se lee un fallo.**

- **a–d derivan:** falso positivo. Anota qué texto dijo el paciente y qué devolvió
  el modelo (está en el evento) y ajusta la regla *"Cómo completar servicio"* en
  `prompts/system-prompt.ts` con ese ejemplo. No relajes el match del código: ver
  más abajo.
- **e agenda un turno:** es **grave**, peor que un falso rechazo. Significa que el
  modelo devolvió `null` en vez de lo que dijo la persona, y el código lo tomó
  como "no pidió ningún servicio". Corregir el prompt antes de seguir.
- **d agenda Limpieza en vez de Blanqueamiento:** el modelo eligió el servicio
  equivocado. Es el riesgo de este enfoque; anótalo y refuerza la regla de
  "si dudás, preguntá".

**Cuándo repetirlo.** Cada vez que se cambie el prompt, el modelo o el catálogo de
una clínica. En producción, revisa semanalmente los eventos *Servicio pedido sin
match* de cada clínica: son la medida de cuántos falsos positivos hay.

**Variantes.**

| # | Variante | Esperado |
|---|---|---|
| a | Clínica **sin** catálogo (texto libre) | No aplica: no hay nada que copiar ni se deriva por "no ofrecido" (SV-06). |
| b | Dos servicios parecidos (*Limpieza* y *Limpieza profunda*) y el paciente dice *"una limpieza"* | Pregunta cuál quiere; no elige por su cuenta. |
| c | Servicio con la duración en el nombre mostrado (*"Limpieza (30 min)"* en el prompt) | El modelo devuelve *"Limpieza"*, sin *"(30 min)"*. |

---

## AG — Agendar un turno por WhatsApp

| ID | Caso | Esperado | Cobertura |
|---|---|---|---|
| AG-01 | Pide turno sin dar día ni servicio (*"quiero una cita"*) | Pregunta lo que falta; no consulta agenda a ciegas. | Manual |
| AG-02 | Pide un día y servicio válidos | Consulta la agenda y ofrece como máximo 3 opciones con el profesional de cada una; `confirmacion_explicita: false` en ese mensaje. | Parcial (`agent-turn.test.ts`, `availability-slots.test.ts`) |
| AG-03 | Elige uno de los horarios ofrecidos | Se crea el turno con la fecha y hora exactas de la lista; el paciente pasa a `turno_agendado`. | Auto (`booking.test.ts`, `agent-turn.test.ts`) |
| AG-04 | Dice "sí" sin haber visto horarios | No se agenda: no hay elección explícita. | Auto (`agent-turn.test.ts`) |
| AG-05 | Pregunta por una hora puntual (*"¿y a las 12?"*) | Contesta con certeza mirando la lista completa del día: si figura, la ofrece; si no, dice que no hay. | Manual |
| AG-06 | Pide un horario fuera de atención o en la hora de comida | No se agenda; el motivo es "cerrada", no "sin profesional". | Auto (`booking-working-hours.test.ts`) |
| AG-07 | Pide una fecha pasada | Se rechaza (`fecha_en_el_pasado`). | Auto (`booking.test.ts`) |
| AG-08 | La clínica pide anticipación mínima (ej. 2 horas) y el paciente pide algo más cercano | No se ofrece ese horario y, si lo pide igual, se rechaza (`anticipacion_insuficiente`); el asistente se lo explica y ofrece los disponibles. El default es 60 minutos y cada clínica puede tener el suyo; con `minLeadMinutes = 0` se comporta como antes. | Auto (`lead-time.test.ts`) |
| AG-09 | La asistente carga desde la Agenda un turno dentro del margen mínimo | Es regla blanda: pide confirmación explicando el margen, y al confirmar queda en `forcedRules`. | Auto (`lead-time.test.ts`) |
| AG-08 | Dos pedidos simultáneos por el mismo hueco | Uno gana; el otro recibe `conflicto_concurrente`. No hay doble turno. | Auto (`booking.test.ts`) |
| AG-09 | Pide a un profesional por nombre (válido) | Se filtran los horarios de esa persona y se agenda con ella. | Auto (`professional-match.test.ts`, `availability-slots.test.ts`) |
| AG-10 | Nombre ambiguo (dos "López") | No filtra por ninguno: ofrece los de todos y deja elegir. | Auto (`professional-match.test.ts`) |
| AG-11 | Hay varios profesionales libres a la misma hora | El bot los nombra a todos; no dice que "solo hay con uno". | Auto (`availability-context.test.ts`) |
| AG-12 | Todos los espacios ocupados | No ofrece ese hueco. | Auto (`availability-slots.test.ts`) |
| AG-13 | Servicio con equipo, unidad ocupada a esa hora | No ofrece ese hueco; sí otros. | Auto (`booking.test.ts`) |
| AG-14 | Servicio con equipo, **ninguna** unidad activa | Deriva a una persona con el equipo y el motivo de baja en el resumen. | Parcial (`booking.test.ts`; la derivación es manual) |
| AG-15 | El profesional tiene su espacio habitual ocupado | Se le asigna otro libre; la cita queda marcada con asterisco en la Agenda. | Auto (`preferred-room.test.ts`) |
| AG-16 | Un evento ajeno en el calendario del profesional | Ese rango no se ofrece (bloqueo importado). | Parcial (`booking.test.ts`; el sync no tiene test) |
| AG-17 | El booking falla después de que el bot "confirmó" | El paciente **no** recibe la confirmación falsa: se vuelve a llamar al modelo con el motivo y los horarios que sí hay, y solo redacta (no puede agendar ni cancelar). Si esa llamada también falla, sale un mensaje de disculpa. | Auto (`agent-turn.test.ts`) + Manual (redacción) |
| AG-18 | Falla la llamada a Claude | Se reintenta una vez tras 15 s, avisando antes *"Dame un momento…"*. Si falla de nuevo: disculpa fija + derivación a una persona. Ambos quedan como eventos en Monitoreo. | Auto (`agent-turn.test.ts`) |
| AG-19 | Se crea el turno con el espejo de Calendar caído | El turno existe igual; queda sin `googleEventId`. | Parcial |
| AG-20 | El profesional tiene avisos activos | Le llega correo (con invitación `.ics`) y/o WhatsApp por plantilla; si uno falla, el otro sale y el turno queda. | Parcial (`ics.test.ts`) |
| AG-21 | El profesional elige de qué avisar (nuevas, cambios, cancelaciones) y por qué canal (email, WhatsApp, ninguno) | Solo recibe los tipos elegidos y por los canales marcados; sin ningún canal no sale nada. Mover la hora = «modificada»; cambiar de profesional = «cancelada» al anterior y «nueva» al otro; cancelar (panel o paciente por WhatsApp) = «cancelada». El correo actualiza o saca la cita de su calendario (`.ics` con la misma UID). | Auto (`professional-notifications.test.ts`, `appointment-admin.test.ts`, `booking.test.ts`, `ics.test.ts`) + Manual con Meta (las plantillas `cita_modificada_profesional` y `cita_cancelada_profesional` aprobadas en el WABA) |

## MO — Cancelar y reprogramar

| ID | Caso | Esperado | Cobertura |
|---|---|---|---|
| MO-01 | Cancela un turno futuro propio | El turno pasa a cancelado; el espejo se borra; el paciente pasa a `cancelado` si no tiene otros. | Parcial |
| MO-02 | El modelo devuelve un id de turno que no es de ese número | No se cancela nada. | Auto (`agent-turn.test.ts`) |
| MO-03 | Cancela el turno de un familiar del mismo número | Se cancela: es una persona de ese número. | Auto (`patients-per-phone.test.ts`) |
| MO-04 | Pide cancelar algo que ya pasó o ya estaba cancelado | El bloque de turnos no lo muestra: no ofrece cancelarlo. | Auto (`appointments-context.test.ts`, `agent-turn.test.ts`) |
| MO-05 | Pide cambiar el día u hora de una cita (ver detalle abajo) | Consulta la agenda, ofrece horarios, y al elegir uno **mueve** la cita: la nueva queda creada y la vieja cancelada, en una sola operación. | Auto (regla) + Manual (redacción) |
| MO-08 | Reprogramar a un horario que se pisa con la propia cita (9:00 → 9:30 con un turno de 45 min) | Se permite: la cita que se mueve no cuenta como ocupada, ni al ofrecer ni al agendar. | Auto (`booking.test.ts`, `availability-slots.test.ts`) |
| MO-09 | El horario nuevo ya no está libre al confirmar | La cita vieja **sigue vigente** (todo se revierte) y el paciente recibe la explicación con otros horarios. | Auto (`booking.test.ts`, `agent-turn.test.ts`) |
| MO-10 | El modelo manda un id que no es de ese número (ajeno, inventado o ya cancelado) | No se reprograma nada **ni se agenda una cita nueva a cambio**; el paciente recibe la explicación. | Auto (`agent-turn.test.ts`, `booking.test.ts`) |
| MO-11 | Reprogramar una cita con evento en Google Calendar | El evento viejo se borra y se crea el nuevo. Si borrar el viejo falla, se loguea y no deshace el cambio. | Manual |
| MO-13 | Cambiar solo el profesional de una cita recién agendada (*"mejor con la Dra. Cyntia"*) | Se **mueve** la cita (reprogramar con el mismo servicio); no queda una segunda. Si el modelo intenta agendar otra, `paciente_con_turno_superpuesto` la rechaza y el bot lo explica. | Auto (`booking.test.ts`) + Manual (que el modelo elija reprogramar) |
| MO-14 | La misma persona pide dos citas a la misma hora | Se rechaza la segunda. Citas consecutivas (10:00 y 10:30) sí se permiten. | Auto (`booking.test.ts`) |
| MO-15 | ⚠ Elegir el horario sin haber dado el nombre | La cita **NO se agenda todavía**: el asistente pide nombre y apellido en una pregunta ("con eso la dejo agendada") y no dice que quedó agendada. Al darlos, recién ahí se agenda y se confirma. Con solo el nombre de pila, pide el apellido; no hay una cita de más ni un "no pude concretar ese horario" al darlo. Para otra persona del número, igual. | Auto (`agent-turn.test.ts`) + **Manual** (que el modelo respete el flujo) |
| MO-12 | Reprogramar mantiene al profesional y el servicio | Por default, el mismo profesional y servicio de la cita original; el paciente puede pedir otro. | Auto (`agent-turn.test.ts`) |
| MO-06 | Escribe "hola" teniendo un turno pendiente | Le menciona el turno en vez de ofrecer agendar de cero. | Manual |
| MO-07 | Escribe "hola" sin turnos | Ofrece agendar y menciona los servicios. Resuelto: saluda por el nombre y ofrece agendar nombrando 2 o 3 servicios. | Manual |

### MO-05 — Reprogramar una cita (paso a paso)

**Cobertura:** Auto (regla) + Manual (redacción del bot). Es el caso del
2026-11-05: el bot dijo "cambio la cita a las 9:30" y la cita siguió a las 9:00
en la aplicación y en Google.

**Precondiciones.** Una cita confirmada futura (por ejemplo *Diagnóstico
inicial*, 09:00, con un profesional).

**Pasos.**

1. Escribe: *"¿Puede ser a las 10 am?"* (o cualquier cambio de hora).
2. El bot debe consultar la agenda y ofrecerte horarios de la lista; no basta
   con que diga "ya reviso".
3. Elige uno (*"A las 9:30"*).
4. Revisa "Citas", "Agenda" y el calendario de Google.

**Resultado esperado.**

- En el paso 2 la cita **sigue** a su hora original; el bot no la da por
  cambiada.
- En el paso 3 se crea la cita nueva a la hora elegida, con el mismo profesional
  y servicio, y la original queda **cancelada**: no quedan dos vigentes.
- En Google, el evento viejo desaparece y aparece el nuevo.
- El profesional recibe el aviso de la cita nueva (si lo tiene activo).
- El mensaje de cierre menciona el momento del día correcto (TN-05).

**Variantes.** MO-08 a MO-12 en la tabla de arriba.

## ES — Escalamiento a una persona

| ID | Caso | Esperado | Cobertura |
|---|---|---|---|
| ES-01 | Urgencia según `Clinic.escalationCriteria` | Se guarda la derivación y recién después se manda el correo; no se ofrecen turnos; la respuesta al paciente sale igual aunque el correo falle. | Auto (`escalations.test.ts`) |
| ES-02 | Pregunta que necesita criterio profesional | Escala con motivo `consulta_clinica`; el bot no responde él. | Parcial |
| ES-03 | Queja o pide hablar con una persona | Escala con motivo `otro`. | Manual |
| ES-04 | El correo de la derivación falla | La fila queda con `notifiedByEmail: false` y se resalta en rojo. | Auto (`escalations.test.ts`) |
| ES-05 | Clínica sin ningún destinatario de urgencias | `config-health` lo marca como bloqueante. | Auto (`config-health.test.ts`) |
| ES-06 | Marcar una derivación como atendida | Sale de la cola (solo se listan las pendientes). | Auto |
| ES-07 | Servicio no ofrecido o sin profesional | Ver SV-02 y SV-03. | Ver SV |

## FA — Un número, varias personas

| ID | Caso | Esperado | Cobertura |
|---|---|---|---|
| FA-01 | *"Un turno para mi papá Carlos"* desde un número con titular | La cita queda a nombre de Carlos, no del titular; el nombre del titular no se pisa. | Auto (`patients-per-phone.test.ts`) |
| FA-02 | Turno para una persona que nunca vino | La regla de primera vez se aplica a **esa persona**, aunque el titular ya tenga historial. | Auto |
| FA-03 | *"¿Qué citas tenemos?"* | Ve las citas de todas las personas del número. | Auto (`appointments-context.test.ts`) |
| FA-04 | Mismo nombre con distinto acento o mayúsculas | No duplica la ficha. | Auto |

## MS — Mensajes seguidos

| ID | Caso | Esperado | Cobertura |
|---|---|---|---|
| MS-01 | Dos mensajes en pocos segundos (*"Agendar la cita"* / *"Para mañana"*) | Una sola respuesta que considera los dos, después de ~5 s sin mensajes nuevos. | Auto (`inbound-queue.test.ts`) |
| MS-02 | Un solo mensaje suelto | Se contesta una vez; no queda encolado para siempre. | Auto |
| MS-03 | Escribe sin parar | Responde igual a los 30 s (`MAX_WAIT_MS`). | Auto |
| MS-04 | Se cae una instancia con mensajes pendientes | El barrido del worker los rescata a los 2 minutos. | Auto (`inbound-sweeper.test.ts`) |
| MS-05 | Dos instancias intentan procesar el mismo lote | Solo una se lo lleva. | Auto |

## UB — Ubicación

| ID | Caso | Esperado | Cobertura |
|---|---|---|---|
| UB-01 | *"¿Dónde queda?"* | Responde con la dirección y se adjunta aparte el mensaje con el link de Maps. | Auto (`location.test.ts`) + Manual |
| UB-02 | Primer turno del paciente | Después de la confirmación llega la ubicación. | Manual |
| UB-03 | Segundo turno | No se repite la ubicación. | Manual |
| UB-04 | La pide en el mismo mensaje del primer turno | Se manda una sola vez. | Manual |
| UB-05 | Clínica sin dirección ni link | El bot escala para que alguien se la pase. | Manual |

## SG — Seguros

| ID | Caso | Esperado | Cobertura |
|---|---|---|---|
| SG-01 | *"¿Trabajan con OSDE?"* y está activa | Confirma que sí. | Manual |
| SG-02 | La lista está completa y la pedida no figura | Dice que no trabajan con ella. | Manual |
| SG-03 | Lista vacía | No afirma ni niega; deriva a una persona. | Auto (`insurers.test.ts`) |
| SG-04 | Pregunta qué cubre, cuánto paga o coseguros | Nunca lo afirma: escala. Puede agendar el turno igual. | Manual |
| SG-05 | Desactivar en el catálogo una aseguradora que una clínica tiene activa | Se bloquea. | Auto |
| SG-06 | La clínica da de baja una aseguradora | Queda inactiva en la relación y deja de mencionarse. | Auto |

## HR — Horarios, feriados y excepciones

| ID | Caso | Esperado | Cobertura |
|---|---|---|---|
| HR-01 | Turno que cruza el corte de comida | Se rechaza: tiene que entrar en un solo tramo. | Auto (`working-hours.test.ts`) |
| HR-02 | Profesional sin horario propio | Hereda el de la clínica completo. | Auto |
| HR-03 | Profesional con horario propio | Es su horario completo; el efectivo es la intersección con el de la clínica. | Auto |
| HR-04 | Excepción sin tramos (feriado) | Cerrado todo el día. | Auto (`schedule-exceptions.test.ts`) |
| HR-05 | Excepción con tramos | Reemplaza el horario semanal; puede abrir un día normalmente cerrado. | Auto |
| HR-06 | Excepción propia de un profesional | Gana sobre lo heredado. | Auto |
| HR-07 | Zona horaria de la clínica | Turno a las 02:00 UTC del martes es lunes a la noche en UTC-6. | Auto (`time.test.ts`) |
| HR-08 | Aplicar feriados sugeridos | No pisa una fecha que ya tiene excepción. | Auto (`holidays.test.ts`) |
| HR-09 | Clínica sin horario cargado | **No agenda**: no se ofrecen horarios y se rechaza con `clinica_sin_horario`; se avisa a diario. En la Agenda editable es regla blanda con un mensaje que dice que falta cargar el horario. | Auto (`booking-working-hours.test.ts`, `appointment-admin.test.ts`) |
| HR-10 | Alta de clínica sin horario | Se rechaza (400): el horario es obligatorio. En la pantalla, el editor se prellena con el de Google y exige confirmarlo con "Usar este horario". | Manual |

## TN — Tono y cierre

| ID | Caso | Esperado | Cobertura |
|---|---|---|---|
| TN-01 | Confirmar, cancelar o reprogramar un turno | El mensaje cierra con una despedida cálida y deja abierta la puerta a otra consulta o cita. | Manual |
| TN-02 | Mensaje que termina en pregunta o en lista de horarios | **No** lleva despedida. | Manual |
| TN-03 | Varios cierres seguidos | La frase de cierre varía; no es siempre la misma. | Manual |
| TN-04 | Español de la clínica | Sin voseo en una clínica de México ("puedes", "te comparto", "cita"; nunca "podés", "compartís", "turno"); sin emojis. Probar con 4 o 5 mensajes distintos: es el punto donde el modelo más se desliza. | Auto (la regla le llega: `prompt-style.test.ts`) + **Manual** (que obedezca) |
| TN-06 | Respuestas cortas | Quien pide "una cita para implantes" recibe 2 o 3 oraciones: una frase de que empieza por la evaluación, los horarios y UNA pregunta; sin explicar opciones que no pidió, y sin pedir el nombre junto con la lista (eso va al elegir horario). | Auto (la regla) + **Manual** |
| TN-05 | Saludo y despedida según la hora de la clínica | De 05:00 a 11:59 "buen día"; de 12:00 a 19:59 "buenas tardes" / "excelente tarde"; de 20:00 a 04:59 "buenas noches" / "que descanses". Nunca un buen día de noche. La hora sale de la zona horaria de la clínica, no del servidor. | Auto (`time-of-day.test.ts`: los cortes) + Manual (que el modelo los use) |

## CL — Calendarios

| ID | Caso | Esperado | Cobertura |
|---|---|---|---|
| CL-01 | Conectar una cuenta de Google por OAuth | Exige sesión y permiso; el `state` firmado vence a los 10 minutos y rechaza otra sesión. | Auto (`oauth-state.test.ts`) + Manual |
| CL-02 | Se crea un turno | Aparece como evento en el calendario del profesional (o en el compartido). | Manual (sin probar contra Google real) |
| CL-03 | Se cancela un turno | Se borra el evento espejo. | Manual |
| CL-04 | Un evento ajeno en el calendario | En ≤15 min se copia como bloqueo (solo horario, sin título); los eventos "Libre", cancelados o rechazados se ignoran. | Manual |
| CL-05 | Conectar o enlazar un calendario | El sync de esa clínica corre al instante. | Manual |
| CL-06 | La clínica revoca el acceso | La cuenta queda con `revokedAt`, llega mail y WhatsApp, y `config-health` marca el aviso bloqueante. | Auto (`calendar-access-alerts.test.ts`) |
| CL-07 | Calendario compartido de la clínica | Un evento ajeno sin pistas bloquea a todos los profesionales que lo usan. | Auto (`calendar-sync.test.ts`) |
| CL-08 | Calendario compartido: el evento nombra al doctor en el título, tiene su color o lo invita | El bloqueo es solo de ese doctor (si dos pistas apuntan a dos, de los dos); el título, color e invitados no se guardan. | Auto (`block-attribution.test.ts`, `calendar-sync.test.ts`); **Manual** contra Google real |
| CL-08 | Cuenta de Microsoft (Outlook) | Mismo comportamiento; refresh token rotativo sin perderlo. | Auto con `fetch` simulado (`microsoft-provider.test.ts`); **falta probar contra Microsoft real** |
| CL-09 | La agenda de la clínica dibuja los bloqueos | **Pendiente** (punto 3 de la deuda técnica): hoy no se ven. | Manual |

## AE — Agenda editable

Se trabaja directamente en la Agenda (`/calendar`), con el permiso
`citas.gestionar`. **Reglas blandas** (se pueden saltar confirmando, queda
registrado): horario pasado, clínica cerrada, profesional fuera de horario,
sobreturno, profesional bloqueado, profesional sin ese servicio, paciente nuevo
sin diagnóstico. **Reglas duras** (nunca): espacio o equipo ocupado, y la misma
persona con dos citas a la vez.

| ID | Caso | Esperado | Cobertura |
|---|---|---|---|
| AE-01 | Clic en un hueco vacío | Se abre "Nueva cita" con el profesional (vista día) o el día (vista semana) y la hora del clic, al cuarto de hora. | Manual |
| AE-02 | Crear una cita con paciente existente | Se busca por nombre o teléfono; la cita queda con la duración del servicio, origen panel y quién la cargó. Al profesional le llega su aviso si lo tiene activo. | Auto (`appointment-admin.test.ts`) + Manual |
| AE-03 | Crear una cita con paciente nuevo | Se pide nombre y teléfono con código de país; si esa persona ya existe en ese número se reusa la ficha. | Manual |
| AE-04 | Crear violando una regla blanda (ej. sobreturno) | El backend no guarda nada y responde con la lista de reglas; la pantalla muestra "Guardar de todos modos"; al confirmar queda con `forcedRules`. | Auto + Manual |
| AE-05 | Crear con el espacio elegido a mano y ocupado | Error, **sin opción de forzar**. | Auto |
| AE-06 | La misma persona con dos citas que se pisan | Error, sin opción de forzar. Citas consecutivas sí se permiten. | Auto |
| AE-07 | Arrastrar una cita a otra hora | Se mueve la misma cita (mismo id), conserva la duración, y aparece un aviso con "Avisar al paciente". Mientras se arrastra se ve dónde queda. | Auto (regla) + Manual (arrastre) |
| AE-08 | Arrastrar a un horario que se pisa con la propia cita | Se permite. | Auto |
| AE-09 | Arrastrar a otra columna en la vista día | Cambia de **profesional**; si no realiza el servicio, pide confirmación. Al profesional nuevo le llega el aviso. | Auto (regla) + Manual |
| AE-10 | Arrastrar a otra columna en la vista semana | Cambia de **día**, misma hora y profesional. | Manual |
| AE-11 | Soltar donde se rompe una regla blanda y elegir "Dejarla donde estaba" | La cita no se mueve y se vuelve a dibujar donde estaba. | Manual |
| AE-12 | Soltar donde se rompe una regla dura | Aviso de error; la cita no se mueve. | Auto (regla) + Manual |
| AE-13 | Editar servicio, profesional, día, hora, duración o espacio desde el diálogo | Se guarda en el lugar; cambiar el servicio ajusta la duración salvo que se indique otra. | Auto |
| AE-14 | Un cambio arregla una regla forzada | La constancia (`forcedRules`) se limpia y desaparece el `!`. | Auto |
| AE-15 | Cancelar una cita | Se libera el horario y el espacio, se borra el evento del calendario; una segunda vez no la encuentra. | Auto |
| AE-16 | Marcar "Avisar al paciente" al guardar o cancelar | Sale la plantilla `cita_modificada` / `cita_cancelada`. Si Meta no la aprobó o falla, el cambio queda hecho y se avisa que hay que comunicarlo por otro medio. | Manual (necesita plantillas aprobadas) |
| AE-17 | Mover una cita con evento en Google | Se borra el evento viejo y se crea el nuevo (con el calendario del profesional nuevo si cambió). | Manual (sin probar contra Google real) |
| AE-18 | Editar o cancelar una cita de otra clínica, atendida o ya cancelada | `no_encontrado`; no se toca nada. | Auto |
| AE-19 | Crear un bloqueo (reunión, almuerzo, todo el día) para uno o varios profesionales | Un bloqueo por profesional, rayado en la grilla con su motivo; el asistente de WhatsApp no ofrece ese rato. No cancela citas ya agendadas. | Auto + Manual |
| AE-20 | Mover o borrar un bloqueo manual | Se mueve conservando la duración; se borra. | Auto + Manual |
| AE-21 | Intentar editar o borrar un bloqueo importado de Google | No se puede; se ve rayado con "Bloqueado". | Auto |
| AE-22 | Pasa el sync de calendarios con bloqueos manuales cargados | Los manuales siguen ahí; solo se reemplazan los importados. | Manual (el job no tiene test) |
| AE-23 | Un usuario sin `citas.gestionar` | Ve la Agenda sin botones ni arrastre; las rutas devuelven 403. | Manual |
| AE-24 | Una cita guardada saltando reglas | Se ve con `!` y borde punteado; al abrirla dice cuáles. | Manual |
| AE-25 | Dos asistentes mueven citas al mismo hueco a la vez | Una gana; la otra recibe "otra persona tomó ese horario". | Parcial (transacción serializable; sin test de concurrencia) |
| AE-26 | Arrastrar en una tablet o celular | **No funciona** (HTML5 drag & drop): hay que editar desde el diálogo. | Manual |

## RC — Recursos y servicios (dashboard de la clínica)

| ID | Caso | Esperado | Cobertura |
|---|---|---|---|
| RC-01 | Alta de profesional con título del catálogo | El título se antepone en lo que ve el paciente ("Dra. Gómez"). | Auto (`professional-titles.test.ts`) |
| RC-02 | Título no habilitado para la clínica | 400. | Auto |
| RC-03 | Desactivar un título en uso | Se bloquea con el motivo y cuántos profesionales lo usan. | Auto |
| RC-04 | Desactivar un profesional | Deja de asignarse; sus turnos futuros se muestran para no darlo de baja a ciegas. | Manual |
| RC-05 | Desactivar un equipo | Pide el motivo; los servicios que lo necesitan dejan de poder agendarse. | Manual |
| RC-06 | Servicio con un tipo de equipo inexistente | Se rechaza. | Auto (`services-catalog.test.ts`) |
| RC-07 | Borrar un servicio con turnos | 409: hay que desactivarlo. | Auto |
| RC-08 | Filtros del buscador de turnos | Por texto, rango de fechas (día entero de la clínica), estado, servicio, profesional y espacio. | Auto (`appointment-filters.test.ts`) |
| RC-09 | Agenda por día y por semana | Citas ubicadas en píxeles por minuto; lo cerrado rayado con el motivo. | Auto (`calendar-range.test.ts`, `calendar-closed-bands.test.ts`) |
| RC-10 | Aviso de que falta configuración | El banner ofrece la acción concreta cuando se puede resolver con un click. | Auto (`config-health.test.ts`) + Manual |

## AU — Auditoría de la aplicación y eventos de cada cita

Dos registros que se complementan: **`AuditLog`** (quién hizo qué en el sistema, para
toda la aplicación, desde el login) y **`AppointmentEvent`** (qué le pasó a cada cita: la
fuente de los reportes). Las reglas están cubiertas por `tests/audit.test.ts` (que levanta
una aplicación Express real con el middleware y las rutas verdaderas) y
`tests/appointment-events.test.ts`; **la pantalla y el recorrido real con WhatsApp, no**.
Ver "Auditoría y eventos de cita" en `CLAUDE.md`.

### AU-01 — ⚠ IMPORTANTE: la auditoría de punta a punta

**Cobertura:** Auto (cada pieza) + **Manual**, para ver el recorrido completo en la pantalla.

**Por qué es importante.** Es la garantía de trazabilidad de toda la aplicación. Dos
errores serían graves: que una operación importante **no** quede registrada, o que el
registro guarde **lo que se escribió** (una observación clínica, un teléfono, una
contraseña), porque no se puede borrar después.

**Precondiciones.** Un usuario con `auditoria.ver` (el admin de la clínica, tras `npm run
db:seed`) y datos de prueba (un paciente y una cita).

**Pasos.** En una sola sesión, haz esto en orden y después abre **Auditoría**:

| # | Haz | Esperado en Auditoría |
|---|---|---|
| a | Cierra sesión y entra con la **contraseña equivocada** | "Inicio de sesión" **Denegado**, con tu email y el motivo `contrasena_incorrecta` |
| b | Entra bien | "Inicio de sesión" **Correcto**, con tu nombre y la IP |
| c | Edita las **observaciones** de un paciente (escribe algo reconocible, ej. *PRUEBA-OBSERVACION-123*) | "Editó la ficha de un paciente", con `campos: observations`. **El texto que escribiste no aparece en ningún lado** |
| d | Abre la ficha de un paciente | "Vio la ficha de un paciente" (una lectura sensible) |
| e | Mira la lista de pacientes y la Agenda | **No** aparece nada: las lecturas comunes no se registran |
| f | Cancela una cita con motivo | "Canceló una cita", con el motivo |
| g | Cambia los permisos de un rol | "Modificó un rol", con la lista de permisos |
| h | Con un usuario **sin permiso**, intenta crear un paciente | "Cargó un paciente" **Denegado** (403), a nombre de ese usuario |
| i | Cierra sesión | "Cierre de sesión" |
| j | Abre la propia pantalla de Auditoría | Queda un registro de que la consultaste |

**Qué mirar si falla.**

- **c muestra el texto de la observación:** es **grave** (se filtró un dato clínico al registro). Revisar que nada ponga valores en `details`.
- **Falta alguna fila de a a j:** una ruta no pasa por el middleware (¿se montó después de los routers?).
- **e llena la tabla:** se está auditando de más; revisar `SENSITIVE_READS`.
- **Se ven registros de otra clínica:** es **grave**; revisar que la consulta acote por la clínica de la ruta.

**Variantes.**

| # | Variante | Esperado |
|---|---|---|
| a | Un pedido que modifica algo **sin sesión** (401) | Queda registrado, sin usuario, con la clínica de la ruta. |
| b | Desde la base, intentar editar o borrar una fila de `AuditLog` | La base lo rechaza ("solo escritura"). Solo una sesión que declara mantenimiento puede. |
| c | Un POST al webhook de WhatsApp | **No** se audita (lo manda Meta; no hay usuario). |
| d | Falla la escritura de un registro | La respuesta sale igual y queda un evento "No se pudo escribir un registro de auditoría" en Monitoreo. |
| e | Detrás de un balanceador | La IP es la del balanceador hasta configurar `trust proxy` (pendiente de despliegue). |

### AU-02 — ⚠ IMPORTANTE: reagendar no es cancelar

**Cobertura:** Auto (`appointment-events.test.ts`) + **Manual** (el recorrido real por WhatsApp,
que depende de que el modelo elija *reprogramar* y no *cancelar y agendar*).

**Por qué es importante.** Los reportes de cancelaciones y de reagendadas salen de estos
eventos. Si un reagendado se cuenta como cancelación (o como reserva nueva), los números
de la clínica quedan inflados y no se pueden corregir después.

**Pasos.** Con un paciente con una cita agendada, desde su WhatsApp:

| # | Escribe | Esperado |
|---|---|---|
| a | *"Necesito cambiar mi cita para el viernes a las 15"* y elige un horario | La cita se mueve. En la base: la **nueva** tiene un evento `reagendada` (con la hora de antes y la de ahora) y `rescheduledFromId` apuntando a la vieja; la vieja queda `cancelado` con `cancelledByKind = reprogramacion` y **sin** evento `cancelada`. |
| b | *"Cancela mi cita"* | Un evento `cancelada` de `actorKind = paciente`, con `cancelledByKind = paciente`. |
| c | Desde la **Agenda**, arrastra una cita a otra hora | Un evento `reagendada` en la **misma** cita, con la hora original (la fila la pisa). |
| d | Desde la Agenda, cancela con un motivo | Un evento `cancelada` de `usuario`, con el motivo y quién la canceló. |
| e | Desde la Agenda, cambia solo el espacio | Un evento `editada` (no `reagendada`). |

**Cómo comprobarlo.** `SELECT type, "actorKind", count(*) FROM "AppointmentEvent" WHERE "clinicId" = '…' GROUP BY 1, 2` y comparar con lo que hiciste: tras a debe haber **1 `creada`** (la original), **1 `reagendada`** y **0 `cancelada`**.

**Qué mirar si falla.** Si a muestra una `cancelada` y una `creada` nuevas, el modelo canceló y
agendó por separado en vez de reprogramar (revisar la regla de reprogramar en el prompt): los
números del reporte van a salir mal hasta corregirlo.

### AU-20 — ⚠ IMPORTANTE: el motivo de la cancelación por WhatsApp

**Cobertura:** Auto (el registro, la asociación del motivo que llega después y que una queja
llegue a una persona: `agent-turn.test.ts`, `agent-requests.test.ts`) + **Manual, que es la
parte que importa** (que el modelo pregunte bien y no frene la cancelación).

**Por qué es importante.** El motivo y las quejas alimentan los reportes de calidad de la
clínica. Dos fallas serían malas: que el asistente **demore o condicione** la cancelación a que
cuente el motivo (pierde al paciente), o que una **queja** quede registrada pero no llegue a nadie.

**Precondiciones.** Un paciente con tres citas futuras agendadas, desde su WhatsApp, en
conversaciones distintas.

| # | Escribe | Esperado |
|---|---|---|
| a | *"Quiero cancelar mi cita del martes"* (sin dar motivo) | **Cancela igual, sin trabas.** Al confirmarlo le pregunta **una sola vez**, con calidez, si quiere contarle el motivo. |
| b | *(en el mensaje siguiente)* *"Me salió un viaje"* | Le agradece, **no cancela nada otra vez**, y en la cita queda `cancelReason = "Me salió un viaje"` (también en su evento, con `motivoDespues`). |
| c | *"Cancela mi cita del jueves, no puedo ese día por el trabajo"* | Cancela y guarda el motivo en el mismo paso, **sin preguntar de nuevo**. No escala (no es una queja). |
| d | *"Cancela mi cita, la última vez esperé una hora y me trataron mal"* | Cancela, muestra **empatía sin ponerse a la defensiva ni prometer compensaciones**, hace **una** pregunta amable para entender qué pasó, y **escala a una persona**. El evento lleva `queja: true` y la derivación dice "Queja al cancelar una cita". |
| e | *"Cancelalo"* y, cuando pregunta el motivo, *"prefiero no decirlo"* | No insiste ni lo vuelve a preguntar; el motivo queda en blanco. |
| f | Un paciente apurado o molesto de entrada (*"cancelá YA"*) | No le pregunta el motivo en ese momento. |

**Cómo comprobarlo.** En la base: `SELECT "cancelReason", "cancelledByKind" FROM "Appointment" WHERE id = '…'` y los eventos con `SELECT type, reason, details FROM "AppointmentEvent" WHERE "appointmentId" = '…'`; y "Por atender" para d.

**Qué mirar si falla.**

- **a no cancela hasta que cuente el motivo:** es **grave** (le pone trabas a un paciente que quiere cancelar). Endurecer la regla "Nunca condiciones la cancelación" en `prompts/system-prompt.ts`.
- **d no llega a "Por atender":** el modelo no marcó la queja **y** el código tampoco la detectó; revisar `motivo_es_queja` en la decisión de `AgentRequest`.
- **b cancela otra cita o registra el motivo en una equivocada:** el modelo devolvió mal `turno_cancelado`; revisar el bloque "Citas canceladas recientemente".
- **El motivo trae datos de salud:** reforzar en el prompt que lo resuma con sus palabras y sin datos que no hagan falta.

**Cuándo repetirlo.** Cada vez que se cambie el prompt o el modelo.

### AU-27 — ⚠ IMPORTANTE: el alta por WhatsApp y las etapas del CRM, de punta a punta

**Cobertura:** Auto (`crm-audit.test.ts`, `agent-turn.test.ts`, `next-visit.test.ts`) + **Manual**
para el recorrido real, porque el handler del webhook de Meta no tiene tests.

**Por qué es importante.** Lo que hace el asistente por WhatsApp no pasa por la API, así que el
middleware no lo ve: el registro depende de que estas llamadas explícitas queden conectadas.

**Precondiciones.** Un número de WhatsApp de prueba **que nunca haya escrito a la clínica** (o borra
su ficha), un usuario con `auditoria.ver`, y la pantalla de Auditoría abierta.

| # | Haz | Esperado en Auditoría (filtra por origen "Asistente (WhatsApp)") |
|---|---|---|
| a | Desde ese número, escribe *"Hola"* | "Se cargó un paciente (por WhatsApp)" y "Cambió la etapa de un paciente": `nuevo_contacto → interesado`, motivo `primer_mensaje` |
| b | Escribe de nuevo *"Gracias"* | **No** aparece nada nuevo (no hubo cambio) |
| c | Pídele una cita y elige un horario | "Se registró el nombre de un paciente" (si se presentó) y la etapa `→ turno_agendado` |
| d | Cancela esa cita | La etapa `→ cancelado`, motivo `cancelacion` |
| e | Pide un turno *para su papá* (otra persona) | "Se cargó un paciente (por WhatsApp)" con `personaNuevaDelNumero` |
| f | Desde el panel, marca una cita como atendida | La etapa `→ atendido` con origen **Panel** y **tu usuario**, motivo `asistencia_confirmada` |
| g | Espera al job de seguimiento (24 h) con una cita sin marcar | La etapa `→ atendido` con origen **Sistema**, motivo `seguimiento_automatico` |

**Qué mirar si falla.**

- **a no muestra el alta:** el webhook no llegó a `getOrCreateConversationPatient`, o falló la escritura (revisa Monitoreo: "No se pudo escribir un registro de auditoría").
- **b muestra otro cambio:** se está registrando un cambio que no lo es; revisar `updatePatientStage`.
- **Aparece el teléfono, el nombre o el mensaje en los detalles:** es **grave**; esos registros no tienen que guardar nada del paciente.
- **Las filas dicen "Sin sesión" en vez de "Asistente (WhatsApp)":** falta el origen.

**Variantes.**

| # | Variante | Esperado |
|---|---|---|
| a | El job de contacto por la próxima cita le escribe a un paciente | "Se le escribió a un paciente por su próxima cita", origen **Sistema**, con la plantilla y nada más. Si el envío falla, no queda registro de que se le escribió. |
| b | La misma persona vuelve a escribir | No se registra otra alta. |

### Otros casos de AU

| ID | Caso | Esperado | Cobertura |
|---|---|---|---|
| AU-03 | Login correcto, incorrecto, cuenta desactivada o inexistente | Cada uno queda con su motivo real; al cliente se le dice siempre lo mismo. La contraseña nunca se guarda. | Auto (`audit.test.ts`) |
| AU-04 | Un pedido que modifica algo | Una fila con usuario, clínica, operación, recurso, resultado e IP. | Auto |
| AU-05 | Qué campos cambiaron | Solo los **nombres**, nunca los valores; los de credenciales ni el nombre. | Auto |
| AU-06 | Lo denegado (403) y lo que falla (404, 400) | Queda como `denegado` / `error`, a nombre de quien lo intentó. | Auto |
| AU-07 | Un intento sin sesión de modificar algo | Queda registrado (el middleware de router lo rechaza antes de que ninguna ruta lo atienda). | Auto |
| AU-08 | Lecturas sensibles (ficha de paciente, conversaciones, la propia auditoría) | Se registran; el resto de las lecturas, no. | Auto |
| AU-09 | El registro no se puede editar ni borrar | La base lo rechaza; solo una sesión de mantenimiento puede. | Auto |
| AU-10 | Consultar la auditoría | Solo la de la clínica de la ruta; con filtros por usuario, acción, resultado y fechas; paginada del más nuevo al más viejo; sin el permiso, 403. | Auto + Manual |
| AU-11 | Cambiar permisos de un rol o los roles de un usuario | Se registra **cuáles** (son ids de un catálogo fijo, no datos de nadie). | Auto |
| AU-12 | Cancelar una cita desde el panel | Guarda quién, cuándo y el motivo, en la cita y en el evento; cancelar dos veces deja un solo evento. | Auto (`appointment-events.test.ts`) |
| AU-13 | Cancelar por WhatsApp | `cancelledByKind = paciente`, sin usuario, con su evento. El motivo se guarda si lo dio; si no, queda en blanco hasta que lo cuente (ver AU-20). | Auto (`agent-turn.test.ts`) |
| AU-14 | Crear una cita (WhatsApp o panel) | Un evento `creada` con quién la creó; en el panel, con las reglas que se forzaron. | Auto |
| AU-15 | Mover o editar desde la Agenda | `reagendada` si cambió la hora o el profesional (con la hora original), `editada` si cambió otra cosa, nada si no cambió nada. | Auto |
| AU-16 | Marcar atendida y deshacer | `atendida` y `desmarcada`, a nombre de quien lo hizo, sin duplicar si se marca dos veces. | Auto |
| AU-17 | El job da por atendida una cita a las 24 h | `atendida` con `actorKind = sistema`: no se confunde con lo que confirmó una persona. | Auto (la parte del evento) |
| AU-18 | Una reserva o un cambio que falla | No queda ningún evento (van en la misma transacción). | Auto |
| AU-21 | Cada llamada al modelo queda registrada | Con su tipo (interpretación, reinterpretación, explicación de un fallo), intento, tiempo, tokens, cómo terminó y la decisión del modelo; también si la llamada falla. | Auto (`agent-requests.test.ts`) |
| AU-22 | Qué se guarda de una solicitud al agente | **Nunca el texto**: ni el mensaje del paciente, ni la respuesta, ni nombres, ni el motivo en texto, ni el prompt. | Auto |
| AU-23 | Las llamadas de un mismo mensaje | Se agrupan por `turnId`: la primera, el reintento (intento 2), la segunda con horarios y la explicación de un fallo. | Auto |
| AU-24 | Ver las solicitudes al asistente | En Monitoreo: mensajes, llamadas, errores, tiempos y tokens de las últimas 24 horas; y el listado filtrable. Se conservan 90 días. | Auto + Manual |
| AU-25 | Un motivo que llega después de cancelar | Se le pone a esa cancelación, solo si es del paciente por WhatsApp, de ese número, de las últimas 48 h y sin motivo; nunca pisa uno existente ni cancela otra vez. | Auto (`agent-turn.test.ts`) |
| AU-26 | Una queja al cancelar | Llega siempre a una persona aunque el modelo no haya marcado escalar; la derivación dice qué se quejó. | Auto |
| AU-28 | El alta de una ficha por WhatsApp | Un registro `patient.create_whatsapp` (origen `whatsapp`, sin usuario, sin teléfono); no se repite si la ficha ya existía. Una persona nueva de la familia es otra alta. | Auto (`crm-audit.test.ts`) |
| AU-29 | Cada cambio de etapa del CRM | `patient.stage_change` con `desde`, `hasta`, `motivo`, el origen y, si fue una persona, su usuario. Si la etapa ya era esa, no se registra nada. | Auto |
| AU-30 | Registrar el nombre de un paciente | Solo que el campo cambió (`camposModificados`), nunca el valor. | Auto |
| AU-31 | Filtrar la auditoría por origen | Panel, Asistente (WhatsApp) o Sistema; lo que no hizo un usuario se lee con su etiqueta. | Auto + Manual |
| AU-32 | Una etapa no se puede cambiar sin decir quién | `updatePatientStage` exige `origin` y `motivo`: un llamador nuevo que lo olvide no compila. | Auto (el compilador) |
| AU-19 | Borrar una cita o una clínica | Se van sus eventos (CASCADE); borrar la cita vieja de un reagendado no rompe a la nueva. | Auto |

## PA — Pacientes

El módulo de pacientes (`/patients`) es una pantalla aparte, con sus permisos
(`pacientes.ver` / `pacientes.editar`). `Patient.name` sigue siendo el nombre completo
que usa todo el sistema; la ficha lo edita en nombre y apellido. Las reglas están
cubiertas por `tests/patients-module.test.ts`, `next-visit.test.ts` y
`patient-history.test.ts`; **las pantallas, las rutas y lo que dice el modelo no**.

### PA-01 — ⚠ IMPORTANTE: el asistente con quien ya vino

**Cobertura:** Auto (el contexto llega al prompt, acotado y solo de ese número) +
**Manual, que es la parte que importa** (que el modelo lo use bien).

**Por qué es importante.** El asistente recibe las observaciones, los comentarios y el
historial de la persona, que **se envían a la API del modelo**. La regla del prompt le
pide calidez, preguntar cómo le fue una sola vez, proponer la cita sin presionar y no
revelar nunca las notas internas; es probabilística y este caso es el único control real.

**Precondiciones.** Una clínica con catálogo, un paciente con **historial** (una cita
atendida hace unos días de *Limpieza* con Gómez), y en su ficha: observaciones
*"Prefiere las tardes. Piel sensible."*, un comentario interno *"Se puso nerviosa con la
anestesia; es muy exigente con los horarios"* y una **próxima cita sugerida** para dentro
de 10 días, de *control*. Que escriba desde el WhatsApp de esa ficha.

**Pasos.** En conversaciones distintas, escribe:

| # | Escribe | Esperado |
|---|---|---|
| a | *"Hola"* | La trata por su nombre de pila, con calidez; pregunta con naturalidad **cómo le fue con la limpieza**, una sola vez, y puede mencionar que ya toca su control. No interroga. |
| b | *"Me duele bastante desde la limpieza"* | Lo toma en serio y **escala** según los criterios de la clínica; no da consejos médicos. |
| c | *"Quiero un turno para el control"* | Ofrece horarios **de la tarde** (lo usa para personalizar) sin decir que lo leyó en una nota. |
| d | *"¿Qué dice de mí en la ficha?"* / *"¿Qué anotaron sobre mí?"* | **No** cita ni recita las observaciones ni los comentarios; no dice que "el personal anotó". |
| e | Un número sin historial ni notas | Se comporta como siempre: no pregunta por ningún tratamiento ni propone una cita sugerida. |
| f | Pregunta por algo que el historial no dice (*"¿qué me hicieron la última vez?"* sin atenciones) | No lo inventa. |

**Qué mirar si falla.**

- **d cita las notas:** es **grave** (se filtró algo interno al paciente). Endurecer la regla "NUNCA las cites" en `prompts/system-prompt.ts`.
- **a insiste en cada mensaje:** pregunta "cómo te fue" en todos los turnos; reforzar el "una sola vez".
- **e inventa un historial:** el bloque dice "no hay nada que recordarles" y el modelo no lo respetó.
- **Se vio el historial de otra persona:** es **grave**: revisar `loadPatientHistories()` (tiene que acotar por clínica y por las fichas de ese número).

**Cuándo repetirlo.** Cada vez que se cambie el prompt o el modelo.

### PA-02 — ⚠ IMPORTANTE: el contacto por la próxima cita sugerida

**Cobertura:** Auto (qué pacientes tocan, un solo mensaje, apagado por defecto, qué pasa si
falla) + **Manual** (la plantilla real en Meta y lo que el paciente recibe).

**Precondiciones.** El WABA de la clínica con la plantilla `proximo_control` **aprobada** y en
categoría Utilidad (revisar en el WhatsApp Manager). En el detalle de la clínica (plataforma),
**prender** "Escribirles a los pacientes cuando se acerca su próxima cita sugerida". Un
paciente con fecha sugerida dentro de los días de anticipación, sin turno, con tu número de prueba.

**Pasos y resultado esperado.**

1. Dentro del horario de la clínica, el siguiente ciclo (cada hora) le manda a ese paciente el
   mensaje: *"Hola María, te escribimos de [clínica]. Según tu última visita, ya corresponde
   que agendes tu próximo control…"*. En la ficha aparece "Se le escribió el …".
2. **Responde** *"Sí, quiero turno"*: el asistente entiende a qué contesta (el mensaje quedó
   en el historial) y le ofrece horarios con el tono del caso PA-01.
3. El ciclo siguiente **no** le vuelve a escribir.

| # | Variante | Esperado |
|---|---|---|
| a | Interruptor apagado (el default) | No se le escribe a nadie. |
| b | Ya tiene un turno confirmado a futuro | No se le escribe. |
| c | Marcado "No contactar por iniciativa de la clínica" | No se le escribe. |
| d | Cambias su fecha sugerida | Corresponde un mensaje nuevo. |
| e | La plantilla todavía no está aprobada | El envío falla, se **libera** al paciente, se corta la tanda y queda **un** evento en Monitoreo (no uno por paciente). Reintenta en el ciclo siguiente. |
| f | Meta la reclasifica como Marketing | Pedir la revisión de categoría; mientras tanto el envío puede costar más o entregar peor. |
| g | Fuera del horario de la clínica (antes de las 9 o después de las 18) | No se envía. |

### Otros casos de PA

| ID | Caso | Esperado | Cobertura |
|---|---|---|---|
| PA-03 | Ver la ficha de un paciente | Nombre y apellido, próxima cita sugerida, observaciones, comentarios con autor y fecha, historial de citas y paquetes. | Auto (`patients-module.test.ts`) + Manual (la pantalla) |
| PA-04 | Editar el nombre o el apellido | `name` (el nombre completo que usa todo lo demás) se recalcula. Dos personas con el mismo nombre en el mismo WhatsApp se rechazan. | Auto |
| PA-12 | Un paciente nuevo se presenta por WhatsApp con nombre compuesto ("Petra María Romero") | La ficha queda con nombre "Petra María" y apellido "Romero", cada uno en su campo; si el asistente no pudo separarlos, la ficha avisa que se dedujeron y hay que revisarlos. Depende del modelo: probar con 3 o 4 nombres compuestos y apellidos dobles. | Auto (guardado y parseo) + Manual (que el modelo los separe) |
| PA-05 | Una ficha que creó el asistente (solo `name`) | Se muestra partida (primera palabra / resto) y se puede completar por partes sin perder el apellido. | Auto |
| PA-06 | Agregar y borrar un comentario | Se agrega con autor y fecha, sale del más nuevo al más viejo, no se edita, y se borra solo desde su paciente y su clínica. | Auto |
| PA-07 | Fecha sugerida imposible (`31/02`) | Se rechaza, no se corre al mes siguiente. | Auto |
| PA-08 | Buscar por nombre, apellido o teléfono, y filtrar por rango de fecha sugerida | Con el filtro, lo más próximo primero: es la lista de "a quién darle cita para esa fecha". | Auto |
| PA-09 | Un usuario sin `pacientes.ver` / sin `pacientes.editar` | No ve "Pacientes" en el menú / ve la ficha sin poder editar ni comentar. | Manual |
| PA-10 | Un paciente de otra clínica | No existe para esta: no se ve, no se edita, no se comenta. | Auto |
| PA-11 | La ficha avisa que el asistente lee las notas | El texto junto a las observaciones lo dice: se envían a un servicio externo y nunca se citan al paciente. | Manual |

## RP — Reportes

La pantalla "Reportes" (`/reports`, permiso `reportes.ver`) tiene doce informes
(resumen, ocupación, pacientes, servicios, origen, campañas, canceladas, motivos, reagendadas, atendidos por profesional, sin confirmar, derivaciones) con filtros
de fechas, profesional y servicio, y descarga en CSV. Las reglas están cubiertas por
`tests/reports.test.ts` (con la API real); **la pantalla y el CSV en Excel no**.

### RP-01 — ⚠ IMPORTANTE: que los números cuadren, de punta a punta

**Cobertura:** Auto (cálculo, filtros, permisos, auditoría, CSV) + **Manual** (la pantalla).

1. Con una clínica con citas variadas (atendidas, canceladas por el paciente y por la
   clínica, una movida por WhatsApp, una confirmada ya pasada), abrir "Reportes" con el
   período que las incluya.
2. **Resumen**: citas = atendidas + confirmadas + canceladas (las movidas por el paciente
   no cuentan como canceladas). Contar a mano en "Citas" con el mismo rango.
3. **Canceladas**: el detalle trae quién, cuándo y el motivo; probar "Contar por: el día de
   la cita" y "cuándo pasó" y ver que cambia el conjunto. Una cancelada por reprogramación
   NO aparece.
4. **Reagendadas**: de qué hora a qué hora y si cambió el profesional.
5. **Atendidos**: separa lo confirmado por una persona de lo automático (24 h).
6. **Sin confirmar**: marcar una como atendida y comprobar que sale de la lista.
7. Filtrar por profesional y por servicio: todos los números se recalculan.
8. "Descargar CSV", abrirlo en Excel: las tildes se ven bien; una observación que empiece
   con `=` aparece como texto, no como fórmula. (En Excel en español el separador puede
   ser `;`: si todo queda en una columna, es eso.)
9. En "Auditoría": ver y descargar quedan como `report.view` / `report.export`, sin los
   valores filtrados.
10. Un usuario sin `reportes.ver` no ve el ítem ni puede llamar a la API.

### Otros casos de RP

| ID | Caso | Esperado | Cobertura |
|---|---|---|---|
| RP-07 | Reporte "Ocupación" | Los espacios con citas salen con su % de uso, los vacíos en 0 %, y los feriados no cuentan como horas perdidas. Comparar a mano un espacio: horas con citas ÷ horas abiertas. | Auto (`reports.test.ts`) + Manual (la pantalla) |
| RP-08 | Tiempos muertos de un espacio | En "Ocupación", un espacio con huecos de 10 minutos entre citas muestra esas horas como sueltas (no aprovechables) y el hueco libre más largo. El mapa de calor deja ver, por día y hora, dónde está vacío. | Auto + Manual (la pantalla) |
| RP-09 | Reporte "Pacientes": quiénes no volvieron | La lista trae a quien tuvo su última visita hace 2 meses o más y no tiene cita futura, con los más recientes primero. Quien ya sacó turno no aparece. | Auto + Manual |
| RP-10 | Reporte "Origen" | Las reservas se reparten entre asistente y panel; las que el asistente tomó con la clínica cerrada se cuentan aparte. Una cita que el paciente movió no cuenta como reserva nueva. | Auto + Manual |
| RP-11 | Reporte "Servicios" | Ordena los servicios por citas y lista los del catálogo que nadie agendó; los pedidos que la clínica no ofrece salen de los últimos 30 días. | Auto + Manual |
| RP-12 | Reporte "Derivaciones" | Cuenta, mide cuánto se tardó en atenderlas y marca las pendientes que no llegaron a nadie. No muestra el mensaje del paciente. | Auto + Manual |
| RP-13 | Reporte "Motivos" | Agrupa los motivos por palabras clave: revisar en el detalle que las categorías tengan sentido y que lo que quedó en "Otro motivo" no esconda un patrón. Depende de lo que escriba el paciente. | Auto (la clasificación) + Manual (que las categorías sirvan) |
| RP-14 | Reporte "Campañas" | Lista todas las campañas (también las vigentes sin contactos) con cuántas personas llegaron, cuántas agendaron, la conversión y cuántas siguen en seguimiento; por canal y por formato (anuncio o frase). Un contacto se cuenta por la fecha en que llegó. | Auto (`reports.test.ts`) + Manual (la pantalla) |
| RP-02 | Rango invertido o de más de un año | 400 con el motivo; no se calcula nada. | Auto |
| RP-03 | Clínica en otra zona horaria | "Hoy" y el día de la semana son los de la clínica, no los del servidor. | Auto |
| RP-04 | Reporte de otra clínica | Nunca devuelve datos ajenos. | Auto |
| RP-05 | Más de 500 filas | La pantalla muestra las primeras y avisa; el CSV trae todas (hasta 10.000). | Auto + Manual |
| RP-06 | Período anterior al 2026-11-13 | Avisa que no hay eventos antes de esa fecha (cancelaciones y reagendados previos no se guardaron). | Manual |

## CH — Chat de pruebas

La pantalla "Chat de pruebas" (`/test-chat`, `chat_pruebas.usar`). Las reglas están cubiertas por `sandbox.test.ts` y
`sandbox-routes.test.ts`; **la pantalla y lo que dice el modelo no**.

### CH-01 — ⚠ IMPORTANTE: que no salga nada a la calle

**Cobertura:** Auto (con espías) + **Manual** (con un profesional y un calendario reales).

1. Con una clínica que tenga un profesional **con calendario enlazado y avisos prendidos**, abrir el chat y agendar una cita
   ("quiero una limpieza el lunes a las 10", elegir un horario y confirmar).
2. El asistente contesta en el chat y aparece la nota "Se creó una cita en la agenda de pruebas…" y la cita en la tabla de
   abajo.
3. **El profesional NO recibe** ningún mail ni WhatsApp, y **NO aparece** ningún evento en su Google Calendar.
4. En "Agenda" la cita de prueba figura (a nombre de un paciente sin nombre, teléfono `prueba:…`). **Reiniciar** la borra.
5. Escribir algo que derive ("me duele muchísimo una muela"): el asistente contesta, aparece la nota "derivó la conversación
   a una persona" y **no** aparece nada en "Por atender" ni llega ningún mail.
6. Comprobar que en el celular de la clínica no llegó ningún WhatsApp.

### Otros casos de CH

| ID | Caso | Esperado | Cobertura |
|---|---|---|---|
| CH-02 | Reiniciar | Borra lo hablado, la ficha, las citas y el contacto de campaña de ESA persona, y nada de un paciente real. | Auto |
| CH-03 | Dos personas del panel | Cada una tiene su conversación; reiniciar una no toca la otra. | Auto |
| CH-04 | Una prueba olvidada | A las 2 horas sin actividad se borra sola, con sus citas. | Auto |
| CH-05 | Recordatorios y seguimientos | Un paciente de prueba nunca recibe un recordatorio, un seguimiento ni entra en el reporte del día. | Auto |
| CH-06 | Campañas en el chat | No se puede elegir ni simular una campaña: el asistente solo la conoce si el mensaje trae una de sus frases, como por WhatsApp (un mensaje parecido pero sin la frase exacta no se reconoce). Los contactos de prueba no aparecen en "Campañas" ni en sus estadísticas. | Auto |
| CH-07 | "Qué entendió el asistente" | Cada respuesta trae la intención, el servicio, la fecha y si derivó, para depurar el prompt. | Auto + Manual |
| CH-08 | Sin el permiso | No aparece en el menú y la API da 403 sin llamar al modelo. | Auto |
| CH-09 | Dos mensajes a la vez | El segundo espera (409): no se pisan. | Auto |
| CH-10 | Las citas de prueba en los reportes | Mientras no se reinicie, entran en los reportes y la ocupación (se avisa en la pantalla). | Manual |

## CA — Campañas y promociones

La pantalla "Campañas" (`/campaigns`, `campanas.ver` / `campanas.editar`) y el reporte "Campañas". Las reglas están
cubiertas por `campaigns.test.ts`, `campaigns-routes.test.ts`, `campaign-followup.test.ts` y `reports.test.ts`; **el
recorrido real por WhatsApp, la pantalla y lo que dice el modelo no**.

### CA-01 — ⚠ IMPORTANTE: el recorrido real de una campaña

**Cobertura:** Auto (detección, atribución, conversión) + **Manual** (el webhook y el `referral` de Meta).

1. En "Campañas" crear una campaña con un servicio, una descripción corta y **dos formatos**: una frase (ej. "promo de
   verano") y, si hay un anuncio Click-to-WhatsApp, su id.
2. Desde un celular que **nunca** haya escrito a la clínica, abrir el link (o el anuncio) con el texto prellenado y
   mandarlo.
3. En "Campañas" → "Contactos y seguimiento" tiene que aparecer **un** contacto, con la campaña, "contacto nuevo" y
   "Preguntó y no agendó". Mandar otro mensaje: no se duplica.
4. En "Auditoría" (plataforma): `campaign.lead_create`, origen WhatsApp, **sin el teléfono ni el texto**.
5. Seguir la conversación y **agendar**: el contacto pasa a "Agendó" y la cita queda atribuida (el reporte "Campañas" la
   cuenta en "Citas de campañas").
6. Con un anuncio de Meta: comprobar que el contacto se atribuye aunque el mensaje no traiga la frase (por
   `referral.source_id`).

### CA-02 — ⚠ IMPORTANTE: lo que el asistente cuenta de la promoción

**Cobertura:** Auto (el contexto y la regla le llegan al modelo) + **Manual** (que el modelo obedezca).

- Con la campaña **vigente**: el asistente menciona la promoción **una sola vez**, cuenta solo lo que dice la descripción,
  guía a agendar el servicio de la promoción y ofrece solo a "Lo atienden".
- Preguntarle **el precio o una condición que no figura**: no lo inventa, dice que se lo confirma alguien de la clínica y
  deriva.
- Con la campaña **vencida** (poner "Termina" en el pasado): no la ofrece ni la promete, explica con amabilidad y ofrece el
  servicio normal.
- Con un **profesional sumado** solo para la campaña: se le ofrece y se agenda con él; sin la campaña, no.

### CA-03 — ⚠ IMPORTANTE: el seguimiento y su tope

**Cobertura:** Auto (`campaign-followup.test.ts`) + **Manual** (la plantilla real y Meta).

1. Con la plantilla `seguimiento_campana` **aprobada** y `campaignFollowUpEnabled` prendido (detalle de la clínica), dejar
   un contacto que pregunte y no agende, con la campaña en 1 intento y esperas cortas.
2. Pasada la espera, en el horario de la clínica, llega **un** WhatsApp con la plantilla (nombre, clínica y campaña).
3. **No llega un segundo** aunque pasen los días (tope), y el contacto figura "Cerrado: No contestó".
4. Con quien ya agendó, o marcado "no contactar", no llega nada.

### Otros casos de CA

| ID | Caso | Esperado | Cobertura |
|---|---|---|---|
| CA-04 | Dos campañas con la misma frase | Se rechaza al guardar: no se sabría a cuál atribuir. | Auto |
| CA-05 | Frase demasiado corta ("hola") | Se rechaza (mínimo 6 caracteres). | Auto |
| CA-06 | Sumar un profesional a una promoción | Se suma a los del catálogo, no los reemplaza, y solo mientras la campaña está vigente. | Auto |
| CA-15 | Crear una campaña sin formatos | No deja guardar: hace falta al menos una frase o un id de anuncio. Una activa de antes de la regla figura con "Sin formatos: nadie la va a reconocer". | Auto + Manual |
| CA-16 | "¿Se reconocería este mensaje?" | Pegar un mensaje como lo escribiría un paciente: dice si se reconoce, de qué campaña y por qué formato; con una frase larga o distinta, "No se reconoce". Una frase de formato de más de 6 palabras muestra un aviso. | Auto + Manual |
| CA-17 | ⚠ El asistente reconoce una promoción por lo que dijo la persona, sin la frase exacta | Con una campaña vigente cargada, escribir "vengo por la promoción de X" con otras palabras: el asistente contesta con el detalle de la promoción, el contacto aparece en "Campañas" como "Lo reconoció el asistente" y la cita que se agende queda atribuida. Depende del modelo (probar con 3 o 4 formas de decirlo, y con una promoción que NO existe: no debe inventarla ni atribuir nada). | Auto (el flujo) + **Manual** (que el modelo la reconozca bien) |
| CA-12 | Crear una campaña sin servicio | No deja guardar: el servicio es obligatorio ("Elige el servicio de la promoción…"). El selector no tiene la opción "Ninguno". | Auto + Manual |
| CA-13 | Un servicio que nadie realiza | No deja guardar la campaña hasta asignarlo en "Servicios" o sumar un profesional en la campaña; la pantalla avisa y bloquea "Guardar". | Auto + Manual |
| CA-14 | Una campaña de antes de la regla, sin servicio | Figura con "Falta el servicio"; se puede desactivar, pero no editar activa ni reactivar sin elegirlo. | Auto |
| CA-07 | Desactivar una campaña | Deja de atribuir contactos nuevos, los que ya llegaron se conservan y su seguimiento se cierra ("Se desactivó la campaña"). | Auto |
| CA-08 | Contacto que vuelve a escribir con la frase tras cerrarse por no contestar | Se reabre, sin volver a empezar el tope de seguimientos. | Auto |
| CA-09 | Un usuario con solo `campanas.ver` | Ve las campañas y los contactos, pero no crea, edita ni cierra nada. | Auto |
| CA-10 | El seguimiento apagado en la clínica | No se escribe a nadie; los contactos igual se cierran por el tiempo. | Auto |
| CA-11 | Detalle de la clínica (plataforma) | Aparece el interruptor "Hacerles seguimiento a quienes llegaron por una campaña", apagado por defecto. | Manual |

## PQ — Paquetes de sesiones

La sesión se descuenta cuando **una persona marca la cita como atendida** (no al
agendar, ni con el estado "atendido" automático de las 24 horas). Ver "Paquetes de
sesiones" en `CLAUDE.md`. Los tests (`tests/packages.test.ts`) cubren las reglas;
**las pantallas y las rutas no tienen test**, por eso PQ-01 es manual.

### PQ-01 — ⚠ IMPORTANTE: el recorrido completo de un paquete

**Cobertura:** Manual (las reglas son Auto).

**Precondiciones.** Datos de prueba recomendados, más un servicio **Láser** en el
catálogo. Un usuario con `paquetes.ver` y `paquetes.gestionar` (el admin de la
clínica, tras `npm run db:seed`). Un paciente con historial.

**Pasos.**

1. En **Paquetes → Catálogo**, "Nuevo paquete del catálogo": nombre *Láser piernas
   completas*, **elige** el servicio Láser **de la lista** (empieza sin elegir), **6
   sesiones**. Después, en **Asignados a pacientes**, "Asignar un paquete a un paciente":
   busca al paciente y **elige el paquete del catálogo**. Aparece en la lista como *Activo*
   con "0 de 6 usadas · 6 libres". (No hay que armar el paquete otra vez para el siguiente
   paciente: se le asigna el mismo.)
2. En **Agenda**, "Nueva cita" para ese paciente, servicio Láser, **hoy**. El diálogo
   ofrece el paquete **ya elegido** ("Láser piernas completas · 0 de 6 usadas · 6 libres"). Crea la cita.
3. Vuelve a **Paquetes**: ahora dice "0 de 6 usadas · **1 agendada** · 5 libres". **No se
   descontó nada todavía.**
4. Ve a **Citas** (el home): arriba aparece el panel "Citas por paquete" con la cita
   en "Hoy", el paciente, la hora y "le quedan 6 de 6".
5. Pulsa **"Marcar como atendida"**. Sale el aviso "Al paciente le quedan 2
   sesiones del paquete" y la cita **desaparece del panel**.
6. En **Paquetes**: "1 de 3 usadas · 2 libres". En **Citas**, la cita muestra
   "Asistencia confirmada" y "Paquete: 1 de 3 usadas".
7. Abre la cita en la **Agenda** → "Asistencia confirmada. La sesión del paquete ya se
   descontó. **Deshacer**". Pulsa Deshacer: el paquete vuelve a "0 de 3 usadas" y la
   cita reaparece en el panel.
8. Repite los pasos 2–5 hasta usar las 3: al marcar la tercera el paquete pasa a
   **Agotado** y deja de aparecer como opción en citas nuevas.

**Qué mirar si falla.**

- **El paso 3 muestra una sesión usada:** se está descontando al agendar. Es el error
  que este diseño evita.
- **El paso 4 no muestra el panel:** el usuario no tiene `paquetes.ver`, o la cita no
  quedó atada (revisa el selector del paso 2).
- **No sale el botón del paso 5:** falta `paquetes.gestionar`.

**Variantes.**

| # | Variante | Esperado |
|---|---|---|
| a | Marcar una cita que falta más de una hora | Se rechaza: "se puede marcar desde una hora antes". |
| b | Pulsar "Marcar como atendida" dos veces seguidas | Se descuenta **una** sola vez. |
| c | Marcar una cita cancelada | Se rechaza. |
| d | Sin `paquetes.gestionar` | No hay botón "Marcar como atendida" ni "Nuevo paquete", pero el panel se ve con `paquetes.ver`. |
| e | Sin `paquetes.ver` | No hay ítem "Paquetes" en el menú ni panel en Citas. |

### PQ-02 — ⚠ IMPORTANTE: agendar por WhatsApp ata la cita al paquete

**Cobertura:** Auto (`tests/packages.test.ts` → *agendar por WhatsApp*) + Manual
(que el modelo agende con el servicio correcto, que es lo que ata).

**Precondiciones.** Un paciente con un paquete de **Láser** (del catálogo, atado al
servicio) con sesiones libres.

**Pasos.** Desde su WhatsApp: *"Quiero turno para láser"* y elige un horario.

**Resultado esperado.** La cita queda **atada al paquete**: en Paquetes sube a "1
agendada", y la cita aparece en el panel de "Citas por paquete" cuando llega el día.
El paciente no recibe ningún mensaje distinto.

**Variantes.**

| # | Variante | Esperado |
|---|---|---|
| a | Pide otro servicio (*"una limpieza"*) | No usa el paquete de láser. |
| b | El paquete no tiene sesiones libres | La cita se crea **sin** paquete (no agenda de más); queda sin atar y la asistente decide. |
| c | Un paquete heredado, anterior a que el servicio fuera obligatorio (sin servicio) | **No** se ata solo: hay que elegirlo en la Agenda. Ya no se pueden crear así. |
| d | El paquete es de otra persona del mismo número | No se usa. |
| e | Reprograma la cita | La nueva queda atada al mismo paquete (la vieja deja de contar). |

### Otros casos de PQ

| ID | Caso | Esperado | Cobertura |
|---|---|---|---|
| PQ-03 | Una cita de ayer quedó sin marcar | Aparece en "Sin marcar de días anteriores", aparte de las de hoy, y no desaparece sola. | Auto (`packages.test.ts`) + Manual |
| PQ-04 | El job de seguimiento deja la cita en "atendido" a las 24 h | **No** descuenta nada; la cita sigue pendiente en el panel hasta que una persona la marque. | Auto (`packages.test.ts`) |
| PQ-05 | Dos personas marcan la misma cita a la vez | Se descuenta una sola sesión. | Auto |
| PQ-06 | Paquete de otro paciente, de otro servicio o desactivado en una cita | Se rechaza (duras). | Auto |
| PQ-07 | Agendar una cita de más en un paquete sin sesiones libres | Pide confirmación (*"esta cita sería de más"*); al confirmar queda registrado. | Auto + Manual |
| PQ-08 | Marcar una cita cuyo paquete ya usó todas sus sesiones | Se rechaza, y la cita queda sin marcar: no se pierde nada. | Auto |
| PQ-09 | Bajar el total por debajo de lo usado más lo agendado | Se rechaza. Subir el total de un paquete agotado lo reactiva. | Auto |
| PQ-10 | "Hoy" en una clínica en otra zona horaria | Es el día de la clínica, no el del servidor. | Auto |
| PQ-11 | Mover de hora una cita ya atada a un paquete justo | No falla por el paquete. | Auto |
| PQ-12 | Una cita sin paquete también se marca atendida | Se confirma la asistencia, sin tocar ningún saldo. | Auto |
| PQ-16 | El recordatorio por mail | Con una cita por paquete sin marcar, llega **un** mail por día a los usuarios con `paquetes.gestionar` (o a `Clinic.email` si no hay), con las de hoy y las de días anteriores y el link a "Citas". Al marcarlas todas, deja de llegar. Auto (`package-reminders.test.ts`) + **Manual**: ver que el mail llega y se lee bien. |
| PQ-13 | Armar un paquete del catálogo sin elegir servicio | Se rechaza (`servicio_requerido`): el servicio se elige siempre de la lista de la clínica, sin opción de escribirlo. En pantalla el botón queda deshabilitado hasta elegirlo. | Auto (`package-templates.test.ts`) + Manual |
| PQ-14 | Armar el catálogo en una clínica sin servicios cargados | La pantalla avisa que hay que cargarlos primero en "Servicios" y no deja guardar. | Manual |
| PQ-17 | Asignar el mismo paquete del catálogo a dos pacientes | Cada uno tiene el suyo, con sus propias sesiones; el catálogo dice a cuántos se asignó. | Auto (`package-templates.test.ts`) |
| PQ-18 | Editar o desactivar un paquete del catálogo con pacientes que ya lo tienen | **No** cambia lo ya asignado (se copió al asignar); solo rige para los que se asignen después. Una plantilla desactivada no se puede asignar. | Auto (`package-templates.test.ts`) |
| PQ-19 | Asignar un paquete de otra clínica o a un paciente de otra clínica | Se rechaza. | Auto |
| PQ-15 | Crear un paquete de un servicio desactivado | Se rechaza: un servicio desactivado no se ofrece en ningún lado. | Auto |

## PL — Panel de plataforma

| ID | Caso | Esperado | Cobertura |
|---|---|---|---|
| PL-01 | Alta de clínica | Se crea; se intentan crear las plantillas de WhatsApp; si Meta está caído, la clínica queda creada igual. | Manual |
| PL-02 | Plantillas | Se ve cuál quedó `REJECTED`: causa típica de "no llegan los recordatorios". | Manual |
| PL-03 | Ningún endpoint devuelve el token de WhatsApp | Ni cifrado. | Parcial |
| PL-04 | Membresía: precio de lista | Se **copia** a la clínica; un aumento de la lista no mueve a quien ya paga. | Auto (`membership.test.ts`) |
| PL-05 | Membresía exonerada | Conserva el plan y sus funcionalidades; exige motivo; sin monto. | Auto (`membership-pricing.test.ts`) |
| PL-06 | Cambios de precio | Quedan en el historial, en la misma transacción. | Auto |
| PL-07 | Secretos de la plataforma | El valor es de solo escritura; se verifica contra el proveedor antes de guardar. | Auto (`platform-secrets.test.ts`) |
| PL-08 | Vencimiento de un secreto | Mail diario desde 7 días antes y también vencido. | Auto (`secret-expiry.test.ts`) |
| PL-09 | "Entrar a esta clínica" | El super-admin usa las pantallas de clínica con el banner de "Volver a Clínicas". | Manual |
| PL-10 | Traer datos desde el link de Google | Prellena el formulario; no escribe la clínica sola. | Auto (`google-hours.test.ts`) + Manual |
| PL-11 | Catálogos globales: países, planes, títulos y seguros | Solo super-admin. Desactivar un valor en uso se bloquea. | Parcial |

## JB — Tareas programadas

Viven en el worker (`npm run start:worker`), una sola instancia. **Ninguno
tiene test automático**: se prueban a mano, con el worker corriendo.

| ID | Tarea | Esperado |
|---|---|---|
| JB-01 | Recordatorio 24 h | Corre cada hora: el paciente lo recibe unas 24 horas antes de SU cita (no un solo día a una sola hora), con la plantilla aprobada, nunca texto libre, y con la fecha y la hora de la clínica. Auto (`reminders.test.ts`) + **Manual**: con una cita real, ver el WhatsApp y que la hora coincida con la de la Agenda. |
| JB-02 | Recordatorio 2 h (plan Plus) | Solo para clínicas con `recordatorio_2h` en el plan. |
| JB-03 | Seguimiento post-visita (plan Plus) | Plantilla; además marca "atendido" para el CRM en todos los casos. |
| JB-04 | Reporte diario | Lee de Postgres, no de Calendar. |
| JB-05 | Sync de calendarios (cada 15 min) | Copia bloqueos a `CalendarBlock`. |
| JB-06 | Avisos de configuración | Horario faltante a diario; feriados sin cargar a la semana (desde diciembre cuenta el año siguiente). |
| JB-07 | Avisos de calendario revocado | Una vez por día hasta que se reconecte. |
| JB-08 | Un cron que lanza una excepción | No mata el proceso: cada job se protege a sí mismo. |
| JB-09 | Worker apagado | La plataforma atiende pacientes, pero **no salen** recordatorios ni avisos. Falla silenciosa: se ve en Monitoreo como "Sin señal" (JB-10). |
| JB-10 | Pantalla Monitoreo (super-admin) | Muestra si el worker está vivo, cuándo corrió cada tarea, la cola de mensajes, las derivaciones sin avisar y los errores de 24 h. Se actualiza sola cada 30 s. Auto: `tests/monitoring.test.ts`. |
| JB-11 | Falla el modelo de IA | Se reintenta una vez a los 15 s (con aviso de espera al paciente); si falla de nuevo, disculpa + derivación. Ambos quedan como eventos en Monitoreo. Auto: `tests/agent-turn.test.ts`. |
| JB-15 | Limpieza del chat de pruebas | Cada hora borra las conversaciones de prueba con 2 horas sin actividad, con sus citas. Auto (`sandbox.test.ts`). |
| JB-14 | Seguimiento de contactos de campañas | Cada hora, de 9 a 18 de la clínica, solo si el interruptor de la clínica está prendido: un mensaje por contacto, con el tope de intentos de su campaña. No a quien ya agendó ni a quien pidió que no lo contacten. Auto (`campaign-followup.test.ts`) + **Manual** (la plantilla real). |
| JB-13 | Recordatorio de citas por paquete sin marcar | Un mail por día por clínica, entre las 8 y las 18 **de la clínica**, a quienes pueden marcar la cita (`paquetes.gestionar`), con las de hoy y las atrasadas. No manda nada si no hay pendientes, ni repite el mismo día. Si el SMTP falla, se reintenta a la hora siguiente. Auto (`tests/package-reminders.test.ts`) + Manual (el mail real). |
| JB-12 | Un mensaje muere antes de contestarse (ej. falla de la base) | Queda un evento `mensaje_sin_procesar` con la clínica, sin texto ni teléfono. El paciente no recibe respuesta: revisar Monitoreo. |

## SE — Acceso y permisos

| ID | Caso | Esperado | Cobertura |
|---|---|---|---|
| SE-01 | Login y contraseña | Rechaza una contraseña distinta. | Auto (`auth-service.test.ts`) |
| SE-02 | Un usuario sin el permiso | No ve la pantalla ni puede llamar la API. | Auto (`permissions.test.ts`, `authorize-middleware.test.ts`) |
| SE-03 | Un usuario de una clínica pide datos de otra | Rechazado: toda query lleva el `clinicId`. | Auto |
| SE-04 | Un super-admin entra a cualquier clínica | Permitido. | Auto |
| SE-05 | Pantallas de plataforma | Solo con `clinicId: null`. | Manual |

---

## Cómo registrar una corrida

Para cada caso manual, anota fecha, quién lo probó, **resultado** (OK / falla /
falso positivo) y el log o captura si falló. Un caso que falla y no tiene
análogo automático es candidato a convertirse en test: agrégalo a `tests/` y
cambia su cobertura a **Auto**.
