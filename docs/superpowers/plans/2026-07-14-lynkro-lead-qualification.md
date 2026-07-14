# Lynkro Lead-Qualification Vertical Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Lynkro's own WhatsApp/Instagram conversations a dedicated, structured lead-qualification flow (business type → message-volume classification → ticket size → demo offer or graceful decline), mirroring the existing medspa vertical's architecture.

**Architecture:** Three new `services/lynkro-lead-*.js` files (schema, state machine, prompt module) that are exact structural mirrors of the existing `services/medspa-*.js` files. `routes/chat.js` gains a new `isLynkroLead` branch, mutually exclusive with `isMedspa`, gated by the already-existing `LYNKRO_COMPANY_ID` constant (hoisted to the top of the file so both this vertical and the existing `LYNKRO_FU` follow-up job can use it). A new `sendNotification` type (`qualified_lead`) fires once per conversation when the lead is classified `MEDIO`/`ALTO` volume and has shared both website and Instagram.

**Tech Stack:** Node.js (ESM), `@anthropic-ai/sdk` tool-use (forced `tool_choice`), better-sqlite3 (state lives in the existing `conversations.flow_state` JSON column).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-14-lynkro-lead-qualification-design.md` — activates only for `companyId === LYNKRO_COMPANY_ID`, any channel. Does NOT touch `LYNKRO_FU` (the existing follow-up/retargeting job) — that stays exactly as-is.
- On qualifying (volume `MEDIO`/`ALTO` + website + Instagram captured): only send a team notification email. Do NOT auto-generate a demo.
- Mirror the medspa pattern exactly: forced `tool_choice`, state persisted under its own namespace in `conversations.flow_state` (namespace `leadQuali`, alongside the existing `medspa` namespace and the Lynkro-internal `fu1`/`fu2`/`fu3` flags — all coexist in the same JSON blob without collision, exactly as `medspa-state.test.js` already verifies for the `medspa` namespace).
- Test convention already established in this repo (`tests/medspa-state.test.js`): state-machine and schema-validation pure functions ARE tested (this file imports the real `db.js` and inserts real rows — no mocks). The Claude tool-use call itself is NOT tested — verified manually by chatting with the bot before deploy.
- Any deploy to the production container MUST use `docker commit` + `docker service update --image`, never `docker restart` — and the OLD container must be `docker stop`'d manually immediately after `docker service update` (memory `feedback_deploy_mi_agente_ia.md`; Swarm does not stop it automatically).
- Never import `routes/chat.js` directly in an ad-hoc test script inside the production container — it auto-reconnects WhatsApp for every company at import time (same memory; this caused a real incident on 2026-07-13). Any manual verification against production must import the underlying `services/*.js` file directly instead.
- Commit after every task.

---

### Task 1: `services/lynkro-lead-schema.js`

**Files:**
- Create: `services/lynkro-lead-schema.js`

**Interfaces:**
- Produces: `STATES` (array), `VOLUME_LEVELS` (array), `RESPOND_TO_LEAD_TOOL` (Claude tool definition), `validateAgentResponse(input) → { valid, errors }`. Consumed by Task 2 (state machine imports `STATES`), Task 4 (routes/chat.js imports `RESPOND_TO_LEAD_TOOL` and `validateAgentResponse`), and Task 2's test file.

- [ ] **Step 1: Write the file**

Create `services/lynkro-lead-schema.js`:

```js
// ============================================================
// LYNKRO LEAD QUALIFICATION — structured agent response (forced tool call)
// ============================================================
// Every turn of this vertical ends by calling this tool instead of
// returning raw text. `message_to_user` is the only field ever sent
// to the lead; everything else is persisted into flow_state.

export const STATES = [
  'OPENING', 'BUSINESS_TYPE', 'VOLUME_DISCOVERY', 'TICKET_DISCOVERY',
  'DEMO_OFFERED', 'LOW_VOLUME_CLOSE', 'QUESTION_HANDLING',
  'HUMAN_HANDOFF', 'DO_NOT_CONTACT', 'CONVERSATION_COMPLETE'
]

export const VOLUME_LEVELS = ['BAJO', 'MEDIO', 'ALTO']

export const RESPOND_TO_LEAD_TOOL = {
  name: 'respond_to_lead',
  description: 'Termina SIEMPRE tu turno llamando esta herramienta. message_to_user es lo único que el lead ve — el resto es estado interno para el sistema.',
  input_schema: {
    type: 'object',
    properties: {
      message_to_user: { type: 'string', description: 'Respuesta para el lead. Frases cortas, sin JSON, sin markdown, máximo un emoji si el tono lo amerita.' },
      next_state: { type: 'string', enum: STATES },
      business_type: { type: ['string', 'null'], description: 'Tipo de negocio detectado, o null si aún no se sabe.' },
      volume_level: { type: ['string', 'null'], enum: [...VOLUME_LEVELS, null], description: 'Clasificación interna del volumen de mensajes — nunca se le dice directamente al lead, se infiere de su respuesta.' },
      avg_ticket: { type: ['string', 'null'], description: 'Ticket promedio mencionado por el lead, o null si aún no se sabe.' },
      captured_fields: {
        type: 'object',
        description: 'Campos nuevos capturados en este turno (website, instagram). Solo incluye lo nuevo/confirmado.',
        additionalProperties: true
      },
      handoff_required: { type: 'boolean' },
      conversation_summary_update: { type: 'string', description: 'Resumen actualizado de la conversación en 1-2 oraciones (reemplaza el anterior).' }
    },
    required: ['message_to_user', 'next_state', 'handoff_required', 'conversation_summary_update']
  }
}

// Thin structural check — not a full JSON-schema validator, matches this
// repo's existing posture (see services/medspa-response-schema.js).
export function validateAgentResponse(input) {
  const errors = []
  if (typeof input?.message_to_user !== 'string' || !input.message_to_user.trim()) {
    errors.push('message_to_user missing or empty')
  }
  if (!STATES.includes(input?.next_state)) errors.push(`next_state invalid: ${input?.next_state}`)
  if (input?.volume_level != null && !VOLUME_LEVELS.includes(input.volume_level)) {
    errors.push(`volume_level invalid: ${input?.volume_level}`)
  }
  if (typeof input?.handoff_required !== 'boolean') errors.push('handoff_required must be boolean')
  return { valid: errors.length === 0, errors }
}
```

- [ ] **Step 2: Verify the file parses correctly**

Run: `node --check services/lynkro-lead-schema.js`
Expected: no output (success)

- [ ] **Step 3: Commit**

```bash
git add services/lynkro-lead-schema.js
git commit -m "feat: add respond_to_lead tool schema for Lynkro lead-qualification vertical"
```

---

### Task 2: `services/lynkro-lead-state.js` + tests

**Files:**
- Create: `services/lynkro-lead-state.js`
- Test: `tests/lynkro-lead-state.test.js`

**Interfaces:**
- Consumes: `STATES` from `services/lynkro-lead-schema.js` (Task 1), `validateAgentResponse` from the same (tested here alongside the state machine, matching the existing `tests/medspa-state.test.js` convention of testing both in one file).
- Produces: `loadState(conversationId)`, `saveState(conversationId, patch)`, `isValidTransition(from, to)`, `shouldNotifyQualified(state) → boolean`. All consumed by Task 4 (`routes/chat.js`) and Task 5 (`shouldNotifyQualified` used to decide when to fire the notification).

- [ ] **Step 1: Write the failing tests**

Create `tests/lynkro-lead-state.test.js`:

```js
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import { db } from '../db.js'
import { loadState, saveState, isValidTransition, shouldNotifyQualified } from '../services/lynkro-lead-state.js'
import { validateAgentResponse } from '../services/lynkro-lead-schema.js'

function makeConversation() {
  const id = crypto.randomUUID()
  const now = Date.now()
  db.prepare('INSERT INTO conversations (id, visitor_id, channel, created_at, updated_at, company_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, 'test-visitor', 'web', now, now, 'test-company')
  return id
}

describe('lynkro-lead-state: transitions', () => {
  test('happy-path forward transition is valid', () => {
    assert.ok(isValidTransition('OPENING', 'BUSINESS_TYPE'))
    assert.ok(isValidTransition('BUSINESS_TYPE', 'DEMO_OFFERED'))
  })

  test('staying in the same state is always valid', () => {
    assert.ok(isValidTransition('VOLUME_DISCOVERY', 'VOLUME_DISCOVERY'))
  })

  test('backward happy-path transition is invalid', () => {
    assert.equal(isValidTransition('TICKET_DISCOVERY', 'OPENING'), false)
  })

  test('QUESTION_HANDLING reachable from any happy-path state', () => {
    assert.ok(isValidTransition('VOLUME_DISCOVERY', 'QUESTION_HANDLING'))
    assert.ok(isValidTransition('TICKET_DISCOVERY', 'QUESTION_HANDLING'))
  })

  test('escape-hatch states reachable from anywhere', () => {
    assert.ok(isValidTransition('OPENING', 'HUMAN_HANDOFF'))
    assert.ok(isValidTransition('DEMO_OFFERED', 'DO_NOT_CONTACT'))
  })
})

describe('lynkro-lead-state: loadState/saveState', () => {
  test('loadState returns defaults for a fresh conversation', () => {
    const convId = makeConversation()
    const state = loadState(convId)
    assert.equal(state.current_state, 'OPENING')
    assert.equal(state.volume_level, null)
    assert.equal(state.qualified_notified, false)
  })

  test('saveState persists and merges captured_fields incrementally', () => {
    const convId = makeConversation()
    saveState(convId, {
      next_state: 'BUSINESS_TYPE', business_type: 'clínica dental', handoff_required: false,
      conversation_summary_update: 'a', captured_fields: { website: 'clinica.com' }
    })
    const state = saveState(convId, {
      next_state: 'VOLUME_DISCOVERY', volume_level: 'ALTO', handoff_required: false,
      conversation_summary_update: 'b', captured_fields: { instagram: '@clinica' }
    })
    assert.equal(state.current_state, 'VOLUME_DISCOVERY')
    assert.equal(state.business_type, 'clínica dental')
    assert.equal(state.volume_level, 'ALTO')
    assert.deepEqual(state.captured_fields, { website: 'clinica.com', instagram: '@clinica' })
  })

  test('lynkro-lead state coexists with unrelated flow_state data without collision', () => {
    const convId = makeConversation()
    db.prepare('UPDATE conversations SET flow_state = ? WHERE id = ?').run(JSON.stringify({ fu1: true, phase: 'mid' }), convId)
    saveState(convId, { next_state: 'BUSINESS_TYPE', handoff_required: false, conversation_summary_update: 'x' })
    const row = db.prepare('SELECT flow_state FROM conversations WHERE id = ?').get(convId)
    const blob = JSON.parse(row.flow_state)
    assert.equal(blob.fu1, true)
    assert.equal(blob.phase, 'mid')
    assert.equal(blob.leadQuali.current_state, 'BUSINESS_TYPE')
  })
})

describe('lynkro-lead-state: shouldNotifyQualified', () => {
  test('true when volume is ALTO and both website and instagram are captured', () => {
    assert.equal(shouldNotifyQualified({
      volume_level: 'ALTO',
      captured_fields: { website: 'a.com', instagram: '@a' },
      qualified_notified: false
    }), true)
  })

  test('true when volume is MEDIO and both fields are captured', () => {
    assert.equal(shouldNotifyQualified({
      volume_level: 'MEDIO',
      captured_fields: { website: 'a.com', instagram: '@a' },
      qualified_notified: false
    }), true)
  })

  test('false when volume is BAJO even with both fields captured', () => {
    assert.equal(shouldNotifyQualified({
      volume_level: 'BAJO',
      captured_fields: { website: 'a.com', instagram: '@a' },
      qualified_notified: false
    }), false)
  })

  test('false when instagram is missing', () => {
    assert.equal(shouldNotifyQualified({
      volume_level: 'ALTO',
      captured_fields: { website: 'a.com' },
      qualified_notified: false
    }), false)
  })

  test('false when already notified', () => {
    assert.equal(shouldNotifyQualified({
      volume_level: 'ALTO',
      captured_fields: { website: 'a.com', instagram: '@a' },
      qualified_notified: true
    }), false)
  })
})

describe('lynkro-lead-schema: validateAgentResponse', () => {
  test('valid response passes', () => {
    const { valid, errors } = validateAgentResponse({
      message_to_user: 'Con ese volumen seguro se te escapan mensajes.',
      next_state: 'VOLUME_DISCOVERY', handoff_required: false, conversation_summary_update: 'x'
    })
    assert.equal(valid, true)
    assert.deepEqual(errors, [])
  })

  test('missing message_to_user fails', () => {
    const { valid, errors } = validateAgentResponse({
      message_to_user: '   ', next_state: 'VOLUME_DISCOVERY', handoff_required: false, conversation_summary_update: 'x'
    })
    assert.equal(valid, false)
    assert.ok(errors.some(e => e.includes('message_to_user')))
  })

  test('invalid enum values fail', () => {
    const { valid, errors } = validateAgentResponse({
      message_to_user: 'hi', next_state: 'NOT_A_STATE', volume_level: 'HIRVIENDO', handoff_required: false, conversation_summary_update: 'x'
    })
    assert.equal(valid, false)
    assert.equal(errors.length, 2)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/lynkro-lead-state.test.js`
Expected: FAIL — `Cannot find module '../services/lynkro-lead-state.js'`

Note: in a fresh git worktree (no populated `data/agent.db`), this test file will additionally fail with `no such column: commerce_pro_enabled` because it imports the real `db.js`, which runs a migration at import time against a pre-existing unrelated bug in this repo (the same reason `tests/medspa-state.test.js` already fails in a fresh worktree). This is expected and not something to fix as part of this task — verify the code is correct by reading it and by running this test in an environment with a populated `data/agent.db` (e.g. the main checkout) before merging.

- [ ] **Step 3: Write the implementation**

Create `services/lynkro-lead-state.js`:

```js
import { db } from '../db.js'
import { STATES } from './lynkro-lead-schema.js'

// ============================================================
// LYNKRO LEAD QUALIFICATION — conversation state machine
// ============================================================
// Persists into the existing conversations.flow_state JSON column
// (already used by the medspa vertical and the Lynkro-internal fu1/fu2/fu3
// follow-up flags). Lives under a `leadQuali` namespace so it never
// collides with either of those.

const DEFAULT_STATE = {
  current_state: 'OPENING',
  previous_state: null,
  business_type: null,
  volume_level: null,
  avg_ticket: null,
  handoff_required: false,
  handoff_reason: null,
  captured_fields: {},
  conversation_summary: '',
  qualified_notified: false
}

const ESCAPE_HATCH_STATES = new Set(['HUMAN_HANDOFF', 'DO_NOT_CONTACT', 'CONVERSATION_COMPLETE'])

const HAPPY_PATH = [
  'OPENING', 'BUSINESS_TYPE', 'VOLUME_DISCOVERY', 'TICKET_DISCOVERY',
  'DEMO_OFFERED', 'LOW_VOLUME_CLOSE'
]

export function isValidTransition(from, to) {
  if (!STATES.includes(to)) return false
  if (to === from) return true
  if (ESCAPE_HATCH_STATES.has(to)) return true
  if (to === 'QUESTION_HANDLING' && HAPPY_PATH.includes(from)) return true
  const fromIdx = HAPPY_PATH.indexOf(from)
  const toIdx = HAPPY_PATH.indexOf(to)
  if (fromIdx === -1 || toIdx === -1) return false
  return toIdx >= fromIdx
}

function parseFlowState(raw) {
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { return {} }
}

export function loadState(conversationId) {
  const row = db.prepare('SELECT flow_state FROM conversations WHERE id = ?').get(conversationId)
  const blob = parseFlowState(row?.flow_state)
  return { ...DEFAULT_STATE, ...(blob.leadQuali || {}) }
}

// patch: partial state update (the fields extracted from respond_to_lead,
// plus optionally qualified_notified). Merges captured_fields rather than
// replacing it wholesale.
export function saveState(conversationId, patch) {
  const row = db.prepare('SELECT flow_state FROM conversations WHERE id = ?').get(conversationId)
  const blob = parseFlowState(row?.flow_state)
  const current = { ...DEFAULT_STATE, ...(blob.leadQuali || {}) }

  const nextState = patch.next_state || current.current_state
  const validTransition = isValidTransition(current.current_state, nextState)

  const merged = {
    ...current,
    previous_state: current.current_state,
    current_state: nextState,
    business_type: patch.business_type ?? current.business_type,
    volume_level: patch.volume_level ?? current.volume_level,
    avg_ticket: patch.avg_ticket ?? current.avg_ticket,
    handoff_required: patch.handoff_required ?? current.handoff_required,
    handoff_reason: patch.handoff_reason ?? current.handoff_reason,
    captured_fields: { ...current.captured_fields, ...(patch.captured_fields || {}) },
    conversation_summary: patch.conversation_summary_update ?? current.conversation_summary,
    qualified_notified: patch.qualified_notified ?? current.qualified_notified
  }
  if (!validTransition) {
    console.warn(`[lynkro-lead] invalid transition ${current.current_state} -> ${nextState} (conv ${conversationId})`)
    merged.flagged_invalid_transition = true
  } else {
    delete merged.flagged_invalid_transition
  }

  const nextBlob = { ...blob, leadQuali: merged }
  db.prepare('UPDATE conversations SET flow_state = ? WHERE id = ?').run(JSON.stringify(nextBlob), conversationId)
  return merged
}

// Pure decision function: has this lead crossed the "qualified" line, and
// have we not already told the sales team about it?
export function shouldNotifyQualified(state) {
  return (state.volume_level === 'MEDIO' || state.volume_level === 'ALTO')
    && !!state.captured_fields?.website
    && !!state.captured_fields?.instagram
    && !state.qualified_notified
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/lynkro-lead-state.test.js`
Expected: PASS (14 tests) — unless run in a fresh worktree with the pre-existing unrelated `commerce_pro_enabled` migration bug (see note in Step 2); in that case verify by reading the code and re-running once merged into a checkout with a populated `data/agent.db`.

- [ ] **Step 5: Commit**

```bash
git add services/lynkro-lead-state.js tests/lynkro-lead-state.test.js
git commit -m "feat: add Lynkro lead-qualification state machine and tests"
```

---

### Task 3: `services/lynkro-lead-prompt.js`

**Files:**
- Create: `services/lynkro-lead-prompt.js`

**Interfaces:**
- Produces: `buildLynkroLeadPromptModule(state) → string`. Consumed by Task 4 (`routes/chat.js`).

- [ ] **Step 1: Write the file**

Create `services/lynkro-lead-prompt.js`:

```js
// ============================================================
// LYNKRO LEAD QUALIFICATION — prompt module (appended to buildSystemPrompt(cfg) output)
// ============================================================
// Additive, like the existing medspa prompt module — never replaces
// buildSystemPrompt's universal formatting rules. Only injected when
// companyId === LYNKRO_COMPANY_ID (see routes/chat.js).

function stateBlock(state) {
  const captured = Object.entries(state.captured_fields || {}).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(', ') || 'ninguno aún'
  return `━━━ ESTADO ACTUAL DE ESTA CONVERSACIÓN ━━━
Estado: ${state.current_state}
Tipo de negocio: ${state.business_type || '(aún no se sabe)'}
Volumen clasificado internamente: ${state.volume_level || '(aún no se sabe)'}
Ticket promedio: ${state.avg_ticket || '(aún no se sabe)'}
Datos ya capturados: ${captured}
Resumen: ${state.conversation_summary || '(inicio de conversación)'}
No repitas preguntas sobre datos ya capturados arriba.`
}

const LYNKRO_LEAD_PRINCIPLES = `IDENTIDAD Y ROL

Eres el agente conversacional de Lynkro, una empresa que construye agentes de inteligencia artificial para negocios de servicios. Estás conversando con alguien que escribió a través de un anuncio en Meta (Instagram o Facebook). Tu objetivo es sostener una conversación natural, entender su negocio, y si califica, ofrecerle un demo interactivo personalizado con la información real de su negocio.

Nunca te presentes como un bot ni menciones que sigues un guion o proceso de calificación. Tu forma de hablar debe sentirse como la de una persona real y atenta, no como un formulario disfrazado de chat.

TONO

- Español neutro latinoamericano, sin voseo ni regionalismos marcados.
- Cercano pero profesional. Como alguien que genuinamente quiere entender el negocio del otro, no como un vendedor que sigue un checklist.
- Frases cortas. Evita párrafos largos — esto es una conversación de mensajería, no un correo.
- Usa afirmaciones antes de preguntas cuando sea posible ("Con ese tipo de negocio, imagino que...") en vez de preguntas secas y directas.

REGLAS GENERALES

- Nunca hagas más de una pregunta por mensaje.
- Nunca uses frases como "para calificarte necesito preguntarte..." o "antes de continuar, dime...". Rompen la conversación.
- Si la persona ya mencionó información relevante sin que se la pidieras (por ejemplo, su volumen de mensajes), no la vuelvas a preguntar — reconócela y avanza.
- Reacciona siempre a lo que la persona acaba de decir antes de introducir la siguiente pregunta. Cada pregunta debe sentirse conectada a la respuesta anterior, no como el siguiente ítem de una lista.
- Si la persona hace una pregunta o comentario fuera del flujo (dudas, objeciones, curiosidad), respóndela primero con naturalidad antes de retomar el flujo. No ignores lo que dice para volver al guion.

FLUJO DE CONVERSACIÓN

1) Apertura
Si la persona ya escribió algo (por ejemplo, respondiendo al anuncio), responde con calidez y haz una pregunta abierta sobre su negocio.
Ejemplo: "¡Hola! Qué bueno que escribieras. Cuéntame un poco, ¿a qué se dedica tu negocio?"

2) Tipo de negocio
Si aún no lo sabes, pregúntalo con curiosidad genuina.
Una vez que la persona responde, haz un comentario breve mostrando que entendiste su negocio antes de seguir.

3) Volumen de mensajes (el punto más delicado — requiere más cuidado)
Nunca preguntes directamente "¿cuántos mensajes recibes al día entre todas tus plataformas?". Es una pregunta que obliga a calcular y genera fricción, y muchas personas simplemente no responden por eso.

En su lugar, conecta el volumen con el tipo de negocio que ya mencionó, como una suposición que la persona puede confirmar o corregir:
Ejemplo: "Con ese tipo de negocio, imagino que deben recibir mensajes todo el día entre WhatsApp e Instagram. ¿Es bastante volumen o todavía se maneja bien?"

Si responde "bastante" o "nos satura": profundiza con calidez, sin pedir un número exacto de forma forzada.
Ejemplo: "¿Más o menos cuántos sientes que son al día, unos 20 o 30, o más?"

Si responde "poco" o "se maneja": confirma con una frase breve, sin insistir en el número.
Ejemplo: "Entendido, algo manejable por ahora."

Clasifica internamente el volumen en bajo / medio / alto según la respuesta, sin que la persona note que está siendo evaluada.

4) Ticket promedio
Pregúntalo con curiosidad genuina, como parte de conocer el negocio, no como dato financiero formal.
Ejemplo: "Y en promedio, ¿cuánto te deja un cliente cuando cierra? Es solo para tener una idea de tu negocio."

5) Transición al demo — SOLO si el volumen califica como medio o alto
No anuncies el demo como un premio por completar el flujo. Conéctalo directamente con lo que la persona ya contó sobre su negocio.
Ejemplo: "Con ese volumen, seguramente se te escapan mensajes sin que te des cuenta. Te muestro algo mejor que explicártelo: te envío un demo con la información real de tu negocio y lo pruebas tú mismo, como si fueras tu propio cliente. ¿Me compartes tu página web y tu Instagram para armarlo?"

6) Si el volumen califica como bajo
No ofrezcas el demo de inmediato. Reconoce el negocio con calidez, deja la puerta abierta sin presionar, y no cierres la conversación de forma abrupta.
Ejemplo: "Entendido. Por ahora seguramente lo puedes manejar bien tú mismo, pero si en algún momento el volumen crece, aquí estoy para ayudarte."

7) Cierre de cualquier interacción
Siempre termina invitando a una acción concreta y clara — nunca dejes la conversación en un punto ambiguo. Si la persona calificó, la acción es compartir web e Instagram. Si no calificó, la acción es dejar la puerta abierta sin presión.

RESTRICCIONES

- No prometas resultados específicos (números de leads, tiempos de respuesta) que no estén confirmados por Lynkro.
- No uses emojis en exceso — máximo uno por mensaje, y solo si el tono de la conversación lo amerita.
- No menciones precios ni condiciones comerciales en esta etapa — esa conversación ocurre después del demo, en la llamada de Discovery.

Debes SIEMPRE terminar tu turno llamando la herramienta respond_to_lead — nunca respondas con texto plano.`

export function buildLynkroLeadPromptModule(state) {
  return '\n\n' + [LYNKRO_LEAD_PRINCIPLES, stateBlock(state)].join('\n\n')
}
```

- [ ] **Step 2: Verify the file parses correctly**

Run: `node --check services/lynkro-lead-prompt.js`
Expected: no output (success)

- [ ] **Step 3: Commit**

```bash
git add services/lynkro-lead-prompt.js
git commit -m "feat: add Lynkro lead-qualification prompt module"
```

---

### Task 4: Wire the vertical into `routes/chat.js`

**Files:**
- Modify: `routes/chat.js` (imports ~line 19, constants ~line 23, `processMessage` around the `isMedspa` block ~line 486-544, tool-use loop guard ~line 548, reply extraction ~line 798, state-save/notification block ~line 816-830, and the existing `const LYNKRO_COMPANY_ID = ...` at ~line 1025)

**Interfaces:**
- Consumes: `RESPOND_TO_LEAD_TOOL`, `validateAgentResponse` (Task 1), `loadState`/`saveState`/`shouldNotifyQualified` (Task 2, imported as `loadLeadState`/`saveLeadState`/`shouldNotifyQualified` to avoid name collision with the medspa imports of the same names), `buildLynkroLeadPromptModule` (Task 3).
- Produces: the vertical is fully wired; Task 5 will extend `sendNotification` with the `qualified_lead` type this task starts calling.

- [ ] **Step 1: Add the new imports**

In `routes/chat.js`, immediately after the existing line:
```js
import { canModifyAppointment } from '../services/appointments.js'
```
add:
```js
import { RESPOND_TO_LEAD_TOOL, validateAgentResponse as validateLeadResponse } from '../services/lynkro-lead-schema.js'
import { buildLynkroLeadPromptModule } from '../services/lynkro-lead-prompt.js'
import { loadState as loadLeadState, saveState as saveLeadState, shouldNotifyQualified } from '../services/lynkro-lead-state.js'
```

- [ ] **Step 2: Hoist `LYNKRO_COMPANY_ID` to the top of the file**

Find (near the top of the file, right after `const rootDir = path.join(__dirname, '..')`):
```js
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.join(__dirname, '..')

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
```
Replace with:
```js
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.join(__dirname, '..')

// Lynkro's own company — used both by the lead-qualification vertical
// (processMessage, below) and by the LYNKRO_FU follow-up job further down.
const LYNKRO_COMPANY_ID = '4a945bfd-5090-472e-a3e4-a137c1da56c9'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
```

Then find the now-duplicate declaration further down in the file:
```js
// ============================================================
// LYNKRO FOLLOW-UP JOB — qualification flow follow-ups
// ============================================================
const LYNKRO_COMPANY_ID = '4a945bfd-5090-472e-a3e4-a137c1da56c9'

// Phases: early = calificación (bot_count 1-2), mid = shock factor mostrado (3), late = demo ofrecida (4+)
```
Replace with (just remove the now-duplicate constant declaration, keep everything else):
```js
// ============================================================
// LYNKRO FOLLOW-UP JOB — qualification flow follow-ups
// ============================================================

// Phases: early = calificación (bot_count 1-2), mid = shock factor mostrado (3), late = demo ofrecida (4+)
```

- [ ] **Step 3: Add the `isLynkroLead` branch alongside `isMedspa`**

Find:
```js
  const isMedspa = cfg.industry === 'medspa'

  const hasCalendarProvider = ['square', 'ghl', 'google'].includes(cfg.calendarProvider)
  // Medspa forces tool_choice: respond_to_patient below, so it structurally cannot call
  // find_my_appointments/reschedule_appointment/cancel_appointment (only registered in the
  // non-medspa branch of activeTools) — never advertise them in the medspa prompt either.
  const appointmentsSystemBlock = (hasCalendarProvider && !isMedspa)
    ? `\n\nPUEDES REAGENDAR Y CANCELAR CITAS. Flujo OBLIGATORIO:\n1) Llama a find_my_appointments para ver las citas futuras del cliente.\n2) Si hay una sola, confírmala por fecha/hora antes de continuar. Si hay varias, pregunta cuál. Si no hay ninguna, dilo — no inventes una cita.\n3) Para reagendar: pide la nueva fecha/hora, llama a check_availability, y si no está libre ofrece la alternativa más cercana. Solo llama a reschedule_appointment después de que el cliente confirme el horario exacto ya verificado.\n4) Para cancelar: pide confirmación explícita ("¿confirmas que quieres cancelar tu cita del [fecha]?") antes de llamar a cancel_appointment.\nNUNCA reagendes ni canceles sin esa confirmación explícita del cliente. Si find_my_appointments o reschedule_appointment/cancel_appointment devuelven un error, dile al cliente que hubo un problema técnico y que el equipo lo confirma manualmente — nunca digas que ya quedó hecho si la herramienta falló.`
    : ''

  let medspaState = isMedspa ? loadMedspaState(convId) : null
  const medspaSystemBlock = isMedspa ? buildMedspaPromptModule(cfg, medspaState) : ''

  const activeTools = []
  if (isMedspa) {
    activeTools.push(RESPOND_TO_PATIENT_TOOL)
  } else {
    if (hasCommercePro) activeTools.push(SEARCH_PRODUCTS_TOOL)
    if (hasSquare) activeTools.push(SQUARE_GET_SERVICES_TOOL, SQUARE_BOOK_APPOINTMENT_TOOL)
    if (hasCalendarProvider) activeTools.push(FIND_MY_APPOINTMENTS_TOOL, CHECK_AVAILABILITY_TOOL, RESCHEDULE_APPOINTMENT_TOOL, CANCEL_APPOINTMENT_TOOL)
  }

  const callParams = {
    model: cfg.model || 'claude-haiku-4-5-20251001',
    max_tokens: (hasCommercePro || hasSquare || isMedspa) ? 800 : 350,
    system: buildSystemPrompt(cfg) + knowledgeText + pageCtx + commerceSystemBlock + squareSystemBlock + appointmentsSystemBlock + medspaSystemBlock,
    messages: (isMedspa ? windowHistory(history, 20, 16) : history).map(m => ({ role: m.role, content: m.content }))
  }
  if (activeTools.length > 0) callParams.tools = activeTools
  if (isMedspa) callParams.tool_choice = { type: 'tool', name: 'respond_to_patient' }
```

Replace with:
```js
  const isMedspa = cfg.industry === 'medspa'
  const isLynkroLead = companyId === LYNKRO_COMPANY_ID

  const hasCalendarProvider = ['square', 'ghl', 'google'].includes(cfg.calendarProvider)
  // Medspa forces tool_choice: respond_to_patient below, so it structurally cannot call
  // find_my_appointments/reschedule_appointment/cancel_appointment (only registered in the
  // non-medspa branch of activeTools) — never advertise them in the medspa prompt either.
  const appointmentsSystemBlock = (hasCalendarProvider && !isMedspa && !isLynkroLead)
    ? `\n\nPUEDES REAGENDAR Y CANCELAR CITAS. Flujo OBLIGATORIO:\n1) Llama a find_my_appointments para ver las citas futuras del cliente.\n2) Si hay una sola, confírmala por fecha/hora antes de continuar. Si hay varias, pregunta cuál. Si no hay ninguna, dilo — no inventes una cita.\n3) Para reagendar: pide la nueva fecha/hora, llama a check_availability, y si no está libre ofrece la alternativa más cercana. Solo llama a reschedule_appointment después de que el cliente confirme el horario exacto ya verificado.\n4) Para cancelar: pide confirmación explícita ("¿confirmas que quieres cancelar tu cita del [fecha]?") antes de llamar a cancel_appointment.\nNUNCA reagendes ni canceles sin esa confirmación explícita del cliente. Si find_my_appointments o reschedule_appointment/cancel_appointment devuelven un error, dile al cliente que hubo un problema técnico y que el equipo lo confirma manualmente — nunca digas que ya quedó hecho si la herramienta falló.`
    : ''

  let medspaState = isMedspa ? loadMedspaState(convId) : null
  const medspaSystemBlock = isMedspa ? buildMedspaPromptModule(cfg, medspaState) : ''

  let leadState = isLynkroLead ? loadLeadState(convId) : null
  const leadSystemBlock = isLynkroLead ? buildLynkroLeadPromptModule(leadState) : ''

  const activeTools = []
  if (isMedspa) {
    activeTools.push(RESPOND_TO_PATIENT_TOOL)
  } else if (isLynkroLead) {
    activeTools.push(RESPOND_TO_LEAD_TOOL)
  } else {
    if (hasCommercePro) activeTools.push(SEARCH_PRODUCTS_TOOL)
    if (hasSquare) activeTools.push(SQUARE_GET_SERVICES_TOOL, SQUARE_BOOK_APPOINTMENT_TOOL)
    if (hasCalendarProvider) activeTools.push(FIND_MY_APPOINTMENTS_TOOL, CHECK_AVAILABILITY_TOOL, RESCHEDULE_APPOINTMENT_TOOL, CANCEL_APPOINTMENT_TOOL)
  }

  const callParams = {
    model: cfg.model || 'claude-haiku-4-5-20251001',
    max_tokens: (hasCommercePro || hasSquare || isMedspa || isLynkroLead) ? 800 : 350,
    system: buildSystemPrompt(cfg) + knowledgeText + pageCtx + commerceSystemBlock + squareSystemBlock + appointmentsSystemBlock + medspaSystemBlock + leadSystemBlock,
    messages: (isMedspa ? windowHistory(history, 20, 16) : history).map(m => ({ role: m.role, content: m.content }))
  }
  if (activeTools.length > 0) callParams.tools = activeTools
  if (isMedspa) callParams.tool_choice = { type: 'tool', name: 'respond_to_patient' }
  if (isLynkroLead) callParams.tool_choice = { type: 'tool', name: 'respond_to_lead' }
```

- [ ] **Step 4: Extract the `respond_to_lead` block, mirroring the medspa block**

Find:
```js
  // Med Spa: forced tool_choice guarantees the structured block on the first
  // response — no action-tool loop needed yet (Phase 2 adds GHL booking here).
  let medspaResult = null
  if (isMedspa) {
    const block = response.content.find(b => b.type === 'tool_use' && b.name === 'respond_to_patient')
    if (block) {
      const { valid, errors } = validateAgentResponse(block.input)
      if (!valid) console.warn('[medspa] respond_to_patient validation errors:', errors)
      medspaResult = block.input
    } else {
      // Defensive fallback — should not happen with tool_choice forced, but never crash the reply path.
      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()
      console.warn('[medspa] model did not call respond_to_patient, falling back to raw text')
      medspaResult = {
        message_to_user: text || 'Dame un momento, ya te ayudo.',
        next_state: medspaState.current_state,
        primary_intent: 'UNCLEAR',
        lead_temperature: medspaState.lead_temperature,
        confidence: 0,
        handoff_required: false,
        follow_up_eligible: false,
        conversation_summary_update: medspaState.conversation_summary
      }
    }
  }

  // Tool-use loop (max 3 iterations to prevent runaway) — skipped for medspa (see above)
  let iterations = 0
  while (!isMedspa && response.stop_reason === 'tool_use' && iterations < 3) {
```

Replace with:
```js
  // Med Spa: forced tool_choice guarantees the structured block on the first
  // response — no action-tool loop needed yet (Phase 2 adds GHL booking here).
  let medspaResult = null
  if (isMedspa) {
    const block = response.content.find(b => b.type === 'tool_use' && b.name === 'respond_to_patient')
    if (block) {
      const { valid, errors } = validateAgentResponse(block.input)
      if (!valid) console.warn('[medspa] respond_to_patient validation errors:', errors)
      medspaResult = block.input
    } else {
      // Defensive fallback — should not happen with tool_choice forced, but never crash the reply path.
      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()
      console.warn('[medspa] model did not call respond_to_patient, falling back to raw text')
      medspaResult = {
        message_to_user: text || 'Dame un momento, ya te ayudo.',
        next_state: medspaState.current_state,
        primary_intent: 'UNCLEAR',
        lead_temperature: medspaState.lead_temperature,
        confidence: 0,
        handoff_required: false,
        follow_up_eligible: false,
        conversation_summary_update: medspaState.conversation_summary
      }
    }
  }

  // Lynkro lead qualification: same forced tool_choice pattern as medspa.
  let leadResult = null
  if (isLynkroLead) {
    const block = response.content.find(b => b.type === 'tool_use' && b.name === 'respond_to_lead')
    if (block) {
      const { valid, errors } = validateLeadResponse(block.input)
      if (!valid) console.warn('[lynkro-lead] respond_to_lead validation errors:', errors)
      leadResult = block.input
    } else {
      // Defensive fallback — should not happen with tool_choice forced, but never crash the reply path.
      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()
      console.warn('[lynkro-lead] model did not call respond_to_lead, falling back to raw text')
      leadResult = {
        message_to_user: text || 'Dame un momento, ya te ayudo.',
        next_state: leadState.current_state,
        handoff_required: false,
        conversation_summary_update: leadState.conversation_summary
      }
    }
  }

  // Tool-use loop (max 3 iterations to prevent runaway) — skipped for medspa/lynkro-lead (see above)
  let iterations = 0
  while (!isMedspa && !isLynkroLead && response.stop_reason === 'tool_use' && iterations < 3) {
```

- [ ] **Step 5: Extract the reply text**

Find:
```js
  const reply = isMedspa ? medspaResult.message_to_user : response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()
```

Replace with:
```js
  const reply = isMedspa ? medspaResult.message_to_user : isLynkroLead ? leadResult.message_to_user : response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()
```

- [ ] **Step 6: Save state and fire the qualified-lead notification**

Find:
```js
  if (isMedspa) {
    medspaResult.last_meaningful_user_message = message
    medspaState = saveMedspaState(convId, medspaResult)

    if (medspaResult.primary_intent === 'OPT_OUT' || medspaResult.next_state === 'DO_NOT_CONTACT') {
      setDoNotContact(convId)
    }
    if (medspaResult.handoff_required) {
      const c = db.prepare('SELECT escalated_notified FROM conversations WHERE id = ?').get(convId)
      db.prepare('UPDATE conversations SET unresolved = 1 WHERE id = ?').run(convId)
      if (!c.escalated_notified) {
        db.prepare('UPDATE conversations SET escalated_notified = 1 WHERE id = ?').run(convId)
        setImmediate(() => sendNotification({ type: 'escalation', conversationId: convId, companyId }))
      }
    }
  } else if (/no (tengo|sé|conozco)|no puedo (ayudart|responder)|contacta(r)? (al|con) (el )?(equipo|negocio)|pasar tu consulta/i.test(reply)) {
```

Replace with:
```js
  if (isMedspa) {
    medspaResult.last_meaningful_user_message = message
    medspaState = saveMedspaState(convId, medspaResult)

    if (medspaResult.primary_intent === 'OPT_OUT' || medspaResult.next_state === 'DO_NOT_CONTACT') {
      setDoNotContact(convId)
    }
    if (medspaResult.handoff_required) {
      const c = db.prepare('SELECT escalated_notified FROM conversations WHERE id = ?').get(convId)
      db.prepare('UPDATE conversations SET unresolved = 1 WHERE id = ?').run(convId)
      if (!c.escalated_notified) {
        db.prepare('UPDATE conversations SET escalated_notified = 1 WHERE id = ?').run(convId)
        setImmediate(() => sendNotification({ type: 'escalation', conversationId: convId, companyId }))
      }
    }
  } else if (isLynkroLead) {
    leadState = saveLeadState(convId, leadResult)
    if (shouldNotifyQualified(leadState)) {
      leadState = saveLeadState(convId, { qualified_notified: true })
      setImmediate(() => sendNotification({ type: 'qualified_lead', conversationId: convId, companyId }))
    }
  } else if (/no (tengo|sé|conozco)|no puedo (ayudart|responder)|contacta(r)? (al|con) (el )?(equipo|negocio)|pasar tu consulta/i.test(reply)) {
```

- [ ] **Step 7: Verify the file parses correctly**

Run: `node --check routes/chat.js`
Expected: no output (success)

- [ ] **Step 8: Commit**

```bash
git add routes/chat.js
git commit -m "feat: wire Lynkro lead-qualification vertical into processMessage"
```

---

### Task 5: `qualified_lead` notification type

**Files:**
- Modify: `db.js` (defaultConfig, near `notifyOnReschedule`/`notifyOnCancel`)
- Modify: `routes/chat.js` (`sendNotification`, search for `if (type === 'reschedule' && !cfg.notifyOnReschedule) return`)

**Interfaces:**
- Consumes: `shouldNotifyQualified` already wired in Task 4.
- Produces: a `qualified_lead` email notification, gated by a new `cfg.notifyOnQualifiedLead` config field (default `true`, matching the existing `notifyOnLead`/`notifyOnEscalation`/`notifyOnReschedule`/`notifyOnCancel` pattern).

- [ ] **Step 1: Add the config default**

In `db.js`, find:
```js
  notifyOnReschedule: true,
  notifyOnCancel: true,
```
Replace with:
```js
  notifyOnReschedule: true,
  notifyOnCancel: true,
  notifyOnQualifiedLead: true,
```

- [ ] **Step 2: Extend `sendNotification`**

In `routes/chat.js`, find:
```js
  if (type === 'lead' && !cfg.notifyOnLead) return
  if (type === 'escalation' && !cfg.notifyOnEscalation) return
  if (type === 'reschedule' && !cfg.notifyOnReschedule) return
  if (type === 'cancel' && !cfg.notifyOnCancel) return
```
Replace with:
```js
  if (type === 'lead' && !cfg.notifyOnLead) return
  if (type === 'escalation' && !cfg.notifyOnEscalation) return
  if (type === 'reschedule' && !cfg.notifyOnReschedule) return
  if (type === 'cancel' && !cfg.notifyOnCancel) return
  if (type === 'qualified_lead' && !cfg.notifyOnQualifiedLead) return
```

Then find:
```js
  const SUBJECTS = {
    lead: `🎯 Nuevo lead capturado — ${cfg.businessName || 'Agente'}`,
    escalation: `🚨 Conversación escalada — ${cfg.businessName || 'Agente'}`,
    reschedule: `📅 Cita reagendada por el bot — ${cfg.businessName || 'Agente'}`,
    cancel: `❌ Cita cancelada por el bot — ${cfg.businessName || 'Agente'}`,
  }
```
Replace with:
```js
  const SUBJECTS = {
    lead: `🎯 Nuevo lead capturado — ${cfg.businessName || 'Agente'}`,
    escalation: `🚨 Conversación escalada — ${cfg.businessName || 'Agente'}`,
    reschedule: `📅 Cita reagendada por el bot — ${cfg.businessName || 'Agente'}`,
    cancel: `❌ Cita cancelada por el bot — ${cfg.businessName || 'Agente'}`,
    qualified_lead: `🔥 Lead calificado por Meta Ads — ${cfg.businessName || 'Agente'}`,
  }
```

Then find:
```js
      <div style="color:${accent};font-size:11px;letter-spacing:2px">${ { lead: 'NUEVO LEAD', escalation: 'ESCALAMIENTO', reschedule: 'CITA REAGENDADA', cancel: 'CITA CANCELADA' }[type] || 'AVISO' }</div>
```
Replace with:
```js
      <div style="color:${accent};font-size:11px;letter-spacing:2px">${ { lead: 'NUEVO LEAD', escalation: 'ESCALAMIENTO', reschedule: 'CITA REAGENDADA', cancel: 'CITA CANCELADA', qualified_lead: 'LEAD CALIFICADO' }[type] || 'AVISO' }</div>
```

Then add a business-details block for the qualified lead, sourced from its state, alongside the existing `leadInfo` block. Find:
```js
  const leadInfo = (conv.lead_email || conv.lead_phone)
    ? `<tr><td style="padding:14px;background:#0a0a0a;border-radius:8px;color:#fff">
        <div style="color:${accent};font-size:11px;letter-spacing:2px;margin-bottom:8px">DATOS DEL CLIENTE</div>
        ${conv.lead_email ? `<div>📧 <b>${conv.lead_email}</b></div>` : ''}
        ${conv.lead_phone ? `<div>📞 <b>${conv.lead_phone}</b></div>` : ''}
        <div style="color:#888;font-size:12px;margin-top:6px">${conv.visitor_id || ''}</div>
      </td></tr><tr><td style="height:14px"></td></tr>` : ''
```
Replace with:
```js
  const leadInfo = (conv.lead_email || conv.lead_phone)
    ? `<tr><td style="padding:14px;background:#0a0a0a;border-radius:8px;color:#fff">
        <div style="color:${accent};font-size:11px;letter-spacing:2px;margin-bottom:8px">DATOS DEL CLIENTE</div>
        ${conv.lead_email ? `<div>📧 <b>${conv.lead_email}</b></div>` : ''}
        ${conv.lead_phone ? `<div>📞 <b>${conv.lead_phone}</b></div>` : ''}
        <div style="color:#888;font-size:12px;margin-top:6px">${conv.visitor_id || ''}</div>
      </td></tr><tr><td style="height:14px"></td></tr>` : ''

  let qualifiedLeadInfo = ''
  if (type === 'qualified_lead') {
    const { loadState: loadLeadStateForEmail } = await import('../services/lynkro-lead-state.js')
    const leadState = loadLeadStateForEmail(conversationId)
    qualifiedLeadInfo = `<tr><td style="padding:14px;background:#0a0a0a;border-radius:8px;color:#fff">
        <div style="color:${accent};font-size:11px;letter-spacing:2px;margin-bottom:8px">DATOS PARA EL DEMO</div>
        <div>🏢 <b>${leadState.business_type || 'Tipo de negocio no capturado'}</b></div>
        <div>💰 Ticket promedio: <b>${leadState.avg_ticket || 'no capturado'}</b></div>
        <div>📊 Volumen: <b>${leadState.volume_level || 'no capturado'}</b></div>
        ${leadState.captured_fields?.website ? `<div>🌐 <b>${leadState.captured_fields.website}</b></div>` : ''}
        ${leadState.captured_fields?.instagram ? `<div>📷 <b>${leadState.captured_fields.instagram}</b></div>` : ''}
      </td></tr><tr><td style="height:14px"></td></tr>`
  }
```

Then find:
```js
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px">
      ${leadInfo}
      <tr><td style="color:#666;font-size:12px;letter-spacing:1px;padding:0 0 8px">TRANSCRIPCIÓN</td></tr>
      ${transcript}
    </table>
```
Replace with:
```js
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px">
      ${leadInfo}
      ${qualifiedLeadInfo}
      <tr><td style="color:#666;font-size:12px;letter-spacing:1px;padding:0 0 8px">TRANSCRIPCIÓN</td></tr>
      ${transcript}
    </table>
```

- [ ] **Step 3: Verify both files parse correctly**

Run:
```bash
node --check db.js
node --check routes/chat.js
```
Expected: no output from either command

- [ ] **Step 4: Commit**

```bash
git add db.js routes/chat.js
git commit -m "feat: add qualified_lead notification type for Lynkro lead-qualification vertical"
```

---

### Task 6: Deploy to production

**Files:** none (operational task)

- [ ] **Step 1: Identify the active container and copy changed files**

```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}" | grep agente
```

Copy every changed/new file into that container:
```bash
ACTIVE=<container-name-from-above>
for f in db.js routes/chat.js services/lynkro-lead-schema.js services/lynkro-lead-state.js services/lynkro-lead-prompt.js; do
  docker cp "$f" "$ACTIVE:/app/$f"
done
```

- [ ] **Step 2: Verify the files match before committing the image**

```bash
for f in db.js routes/chat.js services/lynkro-lead-schema.js services/lynkro-lead-state.js services/lynkro-lead-prompt.js; do
  docker exec $ACTIVE sh -c "cat /app/$f" | diff - "$f" && echo "MATCH: $f"
done
```
Expected: `MATCH:` for every file.

- [ ] **Step 3: Commit the image and update the service**

```bash
docker commit $ACTIVE lynkro-agente:lynkro-lead-quali
docker service update --image lynkro-agente:lynkro-lead-quali mi-agente-ai_mi-agente-ai
```

- [ ] **Step 4: Stop the old container manually**

Swarm does not stop the old container automatically after `service update` — check for and stop it:
```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}" | grep agente
docker stop <old-container-name>
```
Expected after this: exactly one container `Up`, running the new image.

- [ ] **Step 5: Confirm stability**

```bash
docker logs --since 20s <new-container-name> 2>&1 | grep -i "conectado\|desconectado"
```
Expected: no repeated Conectado/Desconectado churn (that would indicate a duplicate-container WhatsApp-session conflict).

- [ ] **Step 6: Manual verification before telling the team it's ready**

Message Lynkro's own WhatsApp/Instagram number as a test "lead" and walk through the flow: mention a business type, respond to the volume question with something that should classify as ALTO, give a ticket amount, and share a website + Instagram handle. Confirm:
- The bot never sounds like a form (no "para calificarte necesito...", no back-to-back unrelated questions).
- The internal `volume_level` classification never leaks into `message_to_user`.
- The demo offer only appears after volume classifies MEDIO/ALTO, and never for a lead who described a low/manageable volume.
- The configured notification email arrives once (not duplicated on subsequent messages) after website + Instagram are both shared.

Do NOT verify by importing `routes/chat.js` directly in a one-off script in the production container — it triggers a WhatsApp reconnect storm (see Global Constraints). Use the actual WhatsApp/Instagram channel for this manual check.
