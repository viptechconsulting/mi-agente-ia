# Vertical de Calificación de Leads (Lynkro) — Diseño

## Contexto

El usuario proporcionó un prompt completo de identidad/tono/flujo de conversación para calificar leads que le escriben a Lynkro.io por un anuncio de Meta (Instagram/Facebook). El objetivo: sostener una conversación natural, entender el negocio del lead, clasificar internamente su volumen de mensajes (bajo/medio/alto) sin que lo note, y si califica (medio/alto), pedirle web + Instagram para armar un demo — todo sin sonar como un formulario.

Ya existe un patrón análogo en este código: el vertical **medspa** (`cfg.industry === 'medspa'`) tiene su propio módulo de prompt, su propio schema de respuesta estructurada forzada vía `tool_choice`, y su propio estado persistente por conversación (`services/medspa-*.js`). También existe ya `LYNKRO_COMPANY_ID` en `routes/chat.js`, usado hoy solo para el seguimiento automático (`LYNKRO_FU`, fases early/mid/late basadas en cuántas veces respondió el bot) — ese mecanismo **no se toca** en este proyecto, queda funcionando igual.

## Alcance

- Se activa **siempre que la empresa sea Lynkro** (`companyId === LYNKRO_COMPANY_ID`), en cualquier canal (WhatsApp o Instagram) — no depende de `cfg.industry` ni de un campo genérico, ya que esto es específico del embudo de ventas propio de Lynkro, no un producto para clientes.
- Al calificar (volumen `MEDIO`/`ALTO` + web/Instagram compartidos), **solo se notifica al equipo por email** — no se genera el demo automáticamente. El equipo lo arma manualmente con el sistema de Demos ya existente.
- El seguimiento automático (`LYNKRO_FU`) queda sin cambios — este vertical solo controla la conversación en vivo.

## Arquitectura

Tres archivos nuevos, calcando el patrón medspa:

- **`services/lynkro-lead-schema.js`** — estados, el tool `respond_to_lead`, y `validateAgentResponse`.
- **`services/lynkro-lead-state.js`** — persistencia en `conversations.flow_state` bajo el namespace `leadQuali` (mismo mecanismo que `medspa`), con `isValidTransition` para las reglas de happy-path.
- **`services/lynkro-lead-prompt.js`** — el prompt de IDENTIDAD/TONO/REGLAS/FLUJO del usuario, como bloque adicional al `buildSystemPrompt(cfg)` universal (no lo reemplaza — igual que medspa).

En `routes/chat.js`: la constante `LYNKRO_COMPANY_ID` (hoy definida cerca de la lógica de `LYNKRO_FU`, línea ~1025) se sube al inicio del archivo para poder reutilizarla también en el flujo principal de `processMessage`. `isLynkroLead = companyId === LYNKRO_COMPANY_ID` es mutuamente excluyente con `isMedspa` (mismo patrón `if/else if` ya existente), forzando `tool_choice: { type: 'tool', name: 'respond_to_lead' }`.

## Estados y campos capturados

```
OPENING → BUSINESS_TYPE → VOLUME_DISCOVERY → TICKET_DISCOVERY → DEMO_OFFERED (califica)
                                                                → LOW_VOLUME_CLOSE (no califica)
→ CONVERSATION_COMPLETE
```
Escape hatches alcanzables desde cualquier estado: `QUESTION_HANDLING`, `HUMAN_HANDOFF`, `DO_NOT_CONTACT`.

El tool `respond_to_lead` fuerza estos campos en cada turno:
- `message_to_user` — lo único que ve el lead
- `next_state` — uno de los estados de arriba
- `business_type` — tipo de negocio detectado
- `volume_level` — `'BAJO' | 'MEDIO' | 'ALTO' | null` — clasificación interna, nunca expuesta directamente al lead
- `avg_ticket` — ticket promedio si lo mencionó
- `captured_fields` — objeto libre (`website`, `instagram` cuando los comparta)
- `handoff_required`, `conversation_summary_update` — igual que medspa

## Notificación al equipo

Nuevo tipo en `sendNotification` (routes/chat.js): `'qualified_lead'`. Se dispara **una sola vez por conversación** (flag `qualified_notified` en el state, mismo mecanismo que `lead_notified` para conversaciones normales) cuando se cumplen a la vez: `volume_level` es `MEDIO` o `ALTO` **y** `captured_fields` ya tiene `website` e `instagram`. Va a `cfg.notifyEmail` de Lynkro (mismo destino que leads/escalamientos hoy), con asunto y contenido mostrando tipo de negocio, ticket promedio, y los datos para armar el demo.

## Manejo de errores

- **Modelo no llama al tool** (no debería pasar con `tool_choice` forzado): fallback defensivo idéntico al de medspa — mensaje genérico, `next_state` se queda en el estado actual, nunca rompe la conversación.
- **Transición inválida**: se registra un warning y se marca `flagged_invalid_transition`, pero nunca bloquea la respuesta — se confía en la elección del modelo, igual que medspa.
- **Preguntas fuera de flujo**: `QUESTION_HANDLING` alcanzable desde cualquier estado del happy path, sin perder el progreso ya capturado.
- **Escape hatches**: `HUMAN_HANDOFF` y `DO_NOT_CONTACT` siempre disponibles.

## Testing

`tests/lynkro-lead-state.test.js`, mismo patrón que el ya existente `tests/medspa-state.test.js` (inserta conversaciones reales vía `db` de `../db.js`, no mocks):
- `isValidTransition`: transiciones válidas del happy path, transición hacia atrás inválida, escape hatches alcanzables desde cualquier estado.
- Función pura que decide cuándo disparar la notificación de lead calificado (`volume_level` MEDIO/ALTO + `website` + `instagram` capturados → true; falta alguno → false).

Sin pruebas de la llamada real a Claude — se verifica manualmente conversando con el bot antes de producción, igual que con medspa. Nota: como este test importa `db.js` directamente (igual que `medspa-state.test.js`), en un worktree fresco fallará por el mismo bug preexistente de migración (columna `commerce_pro_enabled` faltante) — comportamiento esperado y ya conocido, no es un defecto nuevo.
