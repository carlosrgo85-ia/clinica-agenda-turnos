# Solicitud de retención cero (ZDR) a Anthropic

Documento INTERNO. Lo que Anthropic decide (si aprueba y bajo qué condiciones) no depende de nosotros: ZDR **se pide a su equipo comercial** y se activa **por organización**. Anthropic: <https://claude.com/contact-sales>. Estado: **no enviada** (2026-11-20).

## 1. Antes de enviar: preparar la cuenta de Anthropic

1. **Una organización de producción separada** de la de desarrollo (ZDR se activa por organización y no se extiende a otras). La clave `ANTHROPIC_API_KEY` de producción debe salir de **esa** organización. Hoy el desarrollo y la producción usarían la misma cuenta si no se separan.
2. **No usar la Consola ni el Workbench con datos reales de pacientes**: según la documentación de Anthropic, ZDR no cubre el uso en la Consola. Para probar prompts con datos reales, usar el Chat de pruebas de la plataforma (usa el API) o datos inventados.
3. Tener a mano: ID de la organización, nombre legal de la empresa, país, contacto técnico y legal.

## 2. Qué usa hoy la plataforma (para confirmar que es elegible)

Según el código (`src/services/claude.ts`) y la documentación de Anthropic consultada el 2026-11-20:

| Qué usamos | ¿Elegible para ZDR? |
|---|---|
| API de Mensajes (`messages.create`) | Sí |
| Modelo `claude-sonnet-5` | Sí: los modelos que exigen retención de 30 días (y no admiten ZDR salvo autorización) son otros (Fable/Mythos 5.x) |
| Caché de prompt (`cache_control: ephemeral` sobre el system prompt) | Sí: no guarda prompts ni respuestas; la caché vive en memoria por su TTL |
| Herramientas, lotes, Files API, structured outputs, ejecución de código, agentes | **No se usan** (varias NO son elegibles; **no deben sumarse** sin revisar esto) |

**Si algún día se cambia de modelo o se agrega una función con almacenamiento, hay que revisar si sigue cubierta por ZDR** (y actualizar la política de privacidad).

## 3. Lo que ZDR NO cambia (decirlo con claridad a la clínica)

- Anthropic puede conservar datos **por obligación legal o contenido marcado por sus sistemas de seguridad** (hasta 2 años en ese caso).
- Las métricas de uso registradas no entran en ZDR.
- **Nuestra propia base de datos** sigue guardando las conversaciones (`ConversationMessage`), las fichas y las notas: ZDR es solo del lado de Anthropic.
- No sustituye el aviso de privacidad ni el consentimiento de la clínica con sus pacientes.
- El **BAA/HIPAA** de Anthropic es para la ley estadounidense y **no aplica a México**.

## 4. Texto de la solicitud (en inglés, para el formulario o correo al equipo comercial)

**Asunto:** Zero Data Retention request: health-related appointment assistant (Mexico)

Hello,

We are **[LEGAL COMPANY NAME]**, based in **[COUNTRY]**, and we operate **[PLATFORM NAME]**, a multi-clinic SaaS platform that provides a WhatsApp assistant for appointment scheduling (booking, rescheduling, cancelling) for medical and dental clinics. Our first customers are in **Mexico**.

We use the **Claude API (Messages API)** with the model **claude-sonnet-5** and **prompt caching** only. We do not use batch processing, the Files API, structured outputs, code execution, or tools. Our production organization ID is **[ORG ID]**.

**Why we are asking.** Patients write to the assistant in free text, and the conversation, together with limited context from the clinic's patient record (appointments, staff notes, visit history), is sent to the API. This can include **health-related information**, which is sensitive personal data under Mexican data protection law. We act as the **processor** of our clinic customers (the controllers), and we want to minimize retention at every subprocessor.

**What we would like to request:**
1. **Enable Zero Data Retention** for our production organization **[ORG ID]** (and confirm how it is applied to workspaces/API keys).
2. Confirm that our **model and features** (Messages API, `claude-sonnet-5`, prompt caching) are **eligible** under the arrangement, and tell us if that could change.
3. Explain the **exceptions** that still apply (legal requirements, trust and safety flagging, logged metrics) and **how long** flagged content is retained.
4. Information on **where data is processed**, **data residency options**, and the **mechanism for international transfers** from Mexico.
5. The **list of Anthropic subprocessors** and how changes are notified, and a **data processing agreement** that we can reference with our customers. Our customers are not covered by US HIPAA; they are subject to Mexican law.
6. **Incident notification** commitments and timelines.
7. Any contractual terms we should know about before we commit to production use with health-related data.
8. **AI disclosure.** Our assistant answers patients on WhatsApp on behalf of clinics. Your Usage Policy requires consumer-facing chatbots to disclose that users are interacting with AI "at a minimum at the beginning of each chat session or in the product interface". Could you confirm whether a clear, permanent disclosure in the **WhatsApp Business profile** of each clinic (for example, in the business description: "Automated appointment assistant (AI)") counts as disclosure "in the product interface", so that we do not need an additional message inside every new conversation? If not, what wording or placement do you consider sufficient?

Estimated volume: **[N] conversations/month** at launch, **[N]** within 12 months, in **Spanish**.

Contact: **[NAME, ROLE, EMAIL, PHONE]**. Thank you.

## 5. Cuando Anthropic responda

1. Guardar su respuesta y las condiciones (fecha y versión) en un lugar seguro.
2. **Actualizar `docs/legal/politica-de-privacidad.md`** (sección 4, y la 7 de transferencias) con lo que se confirme, y quitar los `[VERIFICAR]` que correspondan. Avisar a las clínicas si cambia algo importante.
3. Confirmar en la Consola que la organización de producción figura con ZDR (Configuración → Privacidad → retención de datos) y que la clave de producción es la de esa organización.
4. Marcar este punto como hecho en `pendientes-antes-de-publicar.md` y en `CLAUDE.md`.
5. Si no la aprueban o la condicionan, **no es bloqueante**: la retención por defecto del contenido ya es "no se conserva" para este modelo; decidir con la clínica si alcanza.
