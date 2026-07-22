# Activadores: motor de disparo + botón con enlace — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hacer que los Activadores (`cfg.keywordTriggers`) disparen realmente una respuesta determinística cuando el mensaje coincide con una palabra clave (hoy no lo hacen), y agregar la opción de adjuntar un botón con enlace a esa respuesta, renderizado de forma segura por canal (WhatsApp, widget web, Instagram).

**Architecture:** Nuevo módulo `services/keyword-trigger.js` (match puro + estado de flujo namespaced en `conversations.flow_state`, mismo patrón que `services/lynkro-lead-state.js`) importado desde `processMessage` en `routes/chat.js`, que corta camino hacia la IA cuando hay match. Cada canal (`sock.sendMessage` de WhatsApp, `res.json` del widget, `sendInstagram`) recibe `button` en el resultado de `processMessage` y lo renderiza según su propio mecanismo.

**Tech Stack:** Node.js (ESM), `node:test` + `node:assert/strict`, `better-sqlite3`, Express, vanilla JS en `public/widget.js`.

## Global Constraints

- Canales: WhatsApp, widget web, Instagram — los tres deben quedar cubiertos.
- El botón solo aplica al tipo de activador `response` (no a `flow`) — decisión explícita del usuario.
- Un solo botón por respuesta (`{ label, url }`), no una lista de botones.
- WhatsApp NUNCA usa mensajes interactivos nativos (`interactiveMessage`) — riesgo de bloqueo/no-renderizado en un cliente no oficial (Baileys). El "botón" en WhatsApp es texto destacado en negrita + URL en su propia línea.
- Widget web e Instagram sí usan un botón real (HTML real / template oficial de Meta respectivamente).
- Fuera de alcance (no tocar en este plan): `followupEnabled` (seguimiento 1h, también inerte hoy), botones en activadores tipo `flow`, múltiples botones por mensaje.
- Ningún cambio de esquema SQL: reutilizar `conversations.flow_state` (columna JSON existente) bajo el namespace `keywordTrigger`, igual que `leadQuali` en `services/lynkro-lead-state.js`.
- Spec completa: `docs/superpowers/specs/2026-07-21-activadores-motor-y-boton-design.md`.

---

### Task 1: `matchKeywordTrigger` — coincidencia de palabra clave (función pura)

**Files:**
- Create: `services/keyword-trigger.js`
- Test: `tests/keyword-trigger.test.js`

**Interfaces:**
- Produces: `matchKeywordTrigger(cfg, text)` → `{ trigger, index } | null`, donde `trigger` es el objeto crudo de `cfg.keywordTriggers[index]` (campos: `label, keywords, matchType, caseSensitive, type, response, steps, button`).

- [ ] **Step 1: Escribir el test que falla**

```js
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { matchKeywordTrigger } from '../services/keyword-trigger.js'

function cfgWith(triggers) { return { keywordTriggers: triggers } }

describe('matchKeywordTrigger', () => {
  test('matchType contains: coincide si la palabra aparece en cualquier parte', () => {
    const cfg = cfgWith([{ keywords: ['precio'], matchType: 'contains', type: 'response', response: 'Info de precios' }])
    const result = matchKeywordTrigger(cfg, 'hola, cuál es el precio del servicio?')
    assert.equal(result.index, 0)
    assert.equal(result.trigger.response, 'Info de precios')
  })

  test('matchType word: NO coincide si la palabra clave es substring de otra palabra', () => {
    const cfg = cfgWith([{ keywords: ['demo'], matchType: 'word', type: 'response', response: 'x' }])
    assert.equal(matchKeywordTrigger(cfg, 'esto es una democracia'), null)
  })

  test('matchType word: SÍ coincide si es palabra completa', () => {
    const cfg = cfgWith([{ keywords: ['demo'], matchType: 'word', type: 'response', response: 'x' }])
    assert.ok(matchKeywordTrigger(cfg, 'quiero ver una demo'))
  })

  test('matchType exact: solo coincide si el mensaje completo es la palabra clave', () => {
    const cfg = cfgWith([{ keywords: ['SI'], matchType: 'exact', type: 'response', response: 'x' }])
    assert.ok(matchKeywordTrigger(cfg, '  si  '))
    assert.equal(matchKeywordTrigger(cfg, 'si quiero'), null)
  })

  test('caseSensitive: distingue mayúsculas cuando está activado', () => {
    const cfg = cfgWith([{ keywords: ['DEMO'], matchType: 'contains', caseSensitive: true, type: 'response', response: 'x' }])
    assert.equal(matchKeywordTrigger(cfg, 'quiero una demo'), null)
    assert.ok(matchKeywordTrigger(cfg, 'quiero una DEMO'))
  })

  test('sin match, retorna null', () => {
    const cfg = cfgWith([{ keywords: ['precio'], matchType: 'contains', type: 'response', response: 'x' }])
    assert.equal(matchKeywordTrigger(cfg, 'hola buenas'), null)
  })

  test('sin keywordTriggers configurados, retorna null sin lanzar error', () => {
    assert.equal(matchKeywordTrigger({}, 'cualquier cosa'), null)
  })

  test('retorna el índice del trigger que matchea entre varios', () => {
    const cfg = cfgWith([
      { keywords: ['info'], matchType: 'contains', type: 'response', response: 'a' },
      { keywords: ['precio'], matchType: 'contains', type: 'response', response: 'b' }
    ])
    const result = matchKeywordTrigger(cfg, 'cuál es el precio')
    assert.equal(result.index, 1)
    assert.equal(result.trigger.response, 'b')
  })
})
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `node --test tests/keyword-trigger.test.js`
Expected: FAIL — `Cannot find module '../services/keyword-trigger.js'`

- [ ] **Step 3: Implementar `matchKeywordTrigger`**

```js
// services/keyword-trigger.js
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function matchKeywordTrigger(cfg, text) {
  const triggers = cfg.keywordTriggers || []
  for (let index = 0; index < triggers.length; index++) {
    const t = triggers[index]
    const hay = t.caseSensitive ? text : text.toLowerCase()
    for (const kwRaw of t.keywords || []) {
      const kw = t.caseSensitive ? kwRaw : kwRaw.toLowerCase()
      const isMatch =
        t.matchType === 'exact' ? hay.trim() === kw.trim() :
        t.matchType === 'word'  ? new RegExp(`\\b${escapeRegex(kw)}\\b`).test(hay) :
        hay.includes(kw) // 'contains', default
      if (isMatch) return { trigger: t, index }
    }
  }
  return null
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `node --test tests/keyword-trigger.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add services/keyword-trigger.js tests/keyword-trigger.test.js
git commit -m "feat: add keyword trigger matching (matchType contains/word/exact, caseSensitive)"
```

---

### Task 2: Estado de flujo de activador en `flow_state` (namespace `keywordTrigger`)

**Files:**
- Modify: `services/keyword-trigger.js`
- Test: `tests/keyword-trigger.test.js`

**Interfaces:**
- Consumes: `db` desde `../db.js` (mismo patrón que `services/lynkro-lead-state.js:1,49-50`).
- Produces:
  - `getActiveTriggerFlow(conversationId)` → `{ triggerIndex, step } | null`
  - `startTriggerFlow(conversationId, triggerIndex)` → void (setea `{ triggerIndex, step: 1 }`)
  - `advanceTriggerFlow(conversationId, nextStep)` → void
  - `clearTriggerFlow(conversationId)` → void

- [ ] **Step 1: Escribir los tests que fallan**

```js
// agregar a tests/keyword-trigger.test.js
import crypto from 'crypto'
import { db } from '../db.js'
import {
  matchKeywordTrigger, getActiveTriggerFlow, startTriggerFlow, advanceTriggerFlow, clearTriggerFlow
} from '../services/keyword-trigger.js'

function makeConversation() {
  const id = crypto.randomUUID()
  const now = Date.now()
  db.prepare('INSERT INTO conversations (id, visitor_id, channel, created_at, updated_at, company_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, 'test-visitor', 'web', now, now, 'test-company')
  return id
}

describe('keyword trigger flow state', () => {
  test('sin flujo activo, getActiveTriggerFlow retorna null', () => {
    const convId = makeConversation()
    assert.equal(getActiveTriggerFlow(convId), null)
  })

  test('startTriggerFlow guarda triggerIndex y arranca en step 1', () => {
    const convId = makeConversation()
    startTriggerFlow(convId, 2)
    assert.deepEqual(getActiveTriggerFlow(convId), { triggerIndex: 2, step: 1 })
  })

  test('advanceTriggerFlow avanza el step sin tocar triggerIndex', () => {
    const convId = makeConversation()
    startTriggerFlow(convId, 0)
    advanceTriggerFlow(convId, 2)
    assert.deepEqual(getActiveTriggerFlow(convId), { triggerIndex: 0, step: 2 })
  })

  test('clearTriggerFlow borra el estado', () => {
    const convId = makeConversation()
    startTriggerFlow(convId, 0)
    clearTriggerFlow(convId)
    assert.equal(getActiveTriggerFlow(convId), null)
  })

  test('convive con flow_state usado por otra feature sin pisarlo (namespace leadQuali)', () => {
    const convId = makeConversation()
    db.prepare('UPDATE conversations SET flow_state = ? WHERE id = ?').run(JSON.stringify({ leadQuali: { current_state: 'OPENING' } }), convId)
    startTriggerFlow(convId, 0)
    const row = db.prepare('SELECT flow_state FROM conversations WHERE id = ?').get(convId)
    const blob = JSON.parse(row.flow_state)
    assert.deepEqual(blob.leadQuali, { current_state: 'OPENING' })
    assert.deepEqual(blob.keywordTrigger, { triggerIndex: 0, step: 1 })
  })
})
```

- [ ] **Step 2: Correr los tests y confirmar que fallan**

Run: `node --test tests/keyword-trigger.test.js`
Expected: FAIL — `getActiveTriggerFlow is not a function` (y similares para las otras 3)

- [ ] **Step 3: Implementar las funciones de estado**

Agregar a `services/keyword-trigger.js` (mismo archivo del Task 1):

```js
import { db } from '../db.js'

function parseFlowState(raw) {
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { return {} }
}

function loadFlowBlob(conversationId) {
  const row = db.prepare('SELECT flow_state FROM conversations WHERE id = ?').get(conversationId)
  return parseFlowState(row?.flow_state)
}

function saveFlowBlob(conversationId, blob) {
  db.prepare('UPDATE conversations SET flow_state = ? WHERE id = ?').run(JSON.stringify(blob), conversationId)
}

export function getActiveTriggerFlow(conversationId) {
  return loadFlowBlob(conversationId).keywordTrigger || null
}

export function startTriggerFlow(conversationId, triggerIndex) {
  const blob = loadFlowBlob(conversationId)
  blob.keywordTrigger = { triggerIndex, step: 1 }
  saveFlowBlob(conversationId, blob)
}

export function advanceTriggerFlow(conversationId, nextStep) {
  const blob = loadFlowBlob(conversationId)
  if (!blob.keywordTrigger) return
  blob.keywordTrigger.step = nextStep
  saveFlowBlob(conversationId, blob)
}

export function clearTriggerFlow(conversationId) {
  const blob = loadFlowBlob(conversationId)
  delete blob.keywordTrigger
  saveFlowBlob(conversationId, blob)
}
```

(La `import { db }` se agrega una sola vez arriba del archivo, junto al resto de imports del Task 1.)

- [ ] **Step 4: Correr los tests y confirmar que pasan**

Run: `node --test tests/keyword-trigger.test.js`
Expected: PASS (13 tests en total: 8 del Task 1 + 5 de este task)

- [ ] **Step 5: Commit**

```bash
git add services/keyword-trigger.js tests/keyword-trigger.test.js
git commit -m "feat: persist keyword-trigger flow progress in conversations.flow_state"
```

---

### Task 3: Cortar camino hacia la IA en `processMessage` cuando hay match

**Files:**
- Modify: `routes/chat.js:1` (import), `routes/chat.js:459-460` (justo después del gate de `human_mode`)
- Test: `tests/keyword-trigger-dispatch.test.js`

**Interfaces:**
- Consumes: `matchKeywordTrigger`, `getActiveTriggerFlow`, `startTriggerFlow`, `advanceTriggerFlow`, `clearTriggerFlow` de `../services/keyword-trigger.js` (Tasks 1-2). `db` de `../db.js`. `loadConfig`, `saveConfig` ya importados en `chat.js:12`.
- Produces: `processMessage(...)` ahora puede devolver `{ conversationId, reply, button, messageId }` con `button` no nulo cuando el activador que matcheó tiene uno configurado. Cuando no hay match, `button` es siempre `null` (incluyendo el `return` final de la IA en `routes/chat.js:927`, que se actualiza para agregar `button: null`).

- [ ] **Step 1: Escribir el test de integración que falla**

```js
// tests/keyword-trigger-dispatch.test.js
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import { db, saveConfig, createCompany } from '../db.js'
import { processMessage } from '../routes/chat.js'

function makeTestCompany() {
  const id = crypto.randomUUID()
  createCompany({ id, name: 'Test Co ' + id.slice(0, 8) })
  return id
}

describe('processMessage: keyword triggers', () => {
  test('activador tipo response con botón: responde exacto y devuelve el botón, sin llamar a la IA', async () => {
    const companyId = makeTestCompany()
    saveConfig(companyId, {
      keywordTriggers: [{
        keywords: ['precio'], matchType: 'contains', type: 'response',
        response: 'Nuestros planes arrancan en $99/mes.',
        button: { label: 'Ver planes', url: 'https://example.com/planes' }
      }]
    })
    const result = await processMessage({ companyId, message: 'cuál es el precio?', visitorId: 'wa:test1', channel: 'whatsapp' })
    assert.equal(result.reply, 'Nuestros planes arrancan en $99/mes.')
    assert.deepEqual(result.button, { label: 'Ver planes', url: 'https://example.com/planes' })
  })

  test('activador tipo response sin botón: button es null', async () => {
    const companyId = makeTestCompany()
    saveConfig(companyId, {
      keywordTriggers: [{ keywords: ['horario'], matchType: 'contains', type: 'response', response: 'Abrimos 9 a 6.' }]
    })
    const result = await processMessage({ companyId, message: 'cuál es su horario?', visitorId: 'wa:test2', channel: 'whatsapp' })
    assert.equal(result.reply, 'Abrimos 9 a 6.')
    assert.equal(result.button, null)
  })

  test('activador tipo flow: primer mensaje envía steps[0], el siguiente mensaje avanza a steps[1]', async () => {
    const companyId = makeTestCompany()
    saveConfig(companyId, {
      keywordTriggers: [{
        keywords: ['demo'], matchType: 'word', type: 'flow',
        steps: [{ message: 'Paso 1: contame de tu negocio' }, { message: 'Paso 2: ¿cuántos empleados tenés?' }]
      }]
    })
    const first = await processMessage({ companyId, message: 'quiero una demo', visitorId: 'wa:test3', channel: 'whatsapp' })
    assert.equal(first.reply, 'Paso 1: contame de tu negocio')
    const second = await processMessage({ companyId, conversationId: first.conversationId, message: 'tengo una peluquería', visitorId: 'wa:test3', channel: 'whatsapp' })
    assert.equal(second.reply, 'Paso 2: ¿cuántos empleados tenés?')
  })

  test('mensaje que no matchea ningún activador sigue yendo a flujo normal (button null, reply no vacío)', async () => {
    const companyId = makeTestCompany()
    saveConfig(companyId, { keywordTriggers: [{ keywords: ['precio'], matchType: 'contains', type: 'response', response: 'x' }] })
    const result = await processMessage({ companyId, message: 'hola buenas tardes', visitorId: 'wa:test4', channel: 'whatsapp' })
    assert.equal(result.button, null)
    assert.ok(typeof result.reply === 'string')
  })
})
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `node --test tests/keyword-trigger-dispatch.test.js`
Expected: FAIL en el primer test — `result.button` es `undefined`, no `{ label: ..., url: ... }` (porque `processMessage` todavía no conoce los activadores). El último test (mensaje sin match) probablemente ya "pasa" por casualidad de `undefined == null` en `assert.equal` — no te confíes, lo que importa es que el primero y el de flow fallen.

- [ ] **Step 3: Implementar el corte de camino en `processMessage`**

En `routes/chat.js`, agregar el import (junto a los demás imports de servicios, cerca de la línea 15 donde ya se importa `SEARCH_PRODUCTS_TOOL`):

```js
import { matchKeywordTrigger, getActiveTriggerFlow, startTriggerFlow, advanceTriggerFlow, clearTriggerFlow } from '../services/keyword-trigger.js'
```

En `routes/chat.js:459-460`, reemplazar:

```js
  // Human takeover — skip AI
  if (conv.human_mode) return { reply: null, conversationId: convId }
```

por:

```js
  // Human takeover — skip AI
  if (conv.human_mode) return { reply: null, conversationId: convId }

  // Keyword triggers — deterministic match/flow, bypasses the LLM entirely
  const activeFlow = getActiveTriggerFlow(convId)
  if (activeFlow) {
    const t = cfg.keywordTriggers?.[activeFlow.triggerIndex]
    const steps = t?.steps || []
    const stepMsg = steps[activeFlow.step]
    if (stepMsg) {
      if (activeFlow.step >= steps.length - 1) clearTriggerFlow(convId)
      else advanceTriggerFlow(convId, activeFlow.step + 1)
      const info = db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(convId, 'assistant', stepMsg.message, Date.now())
      return { conversationId: convId, reply: stepMsg.message, button: null, messageId: info.lastInsertRowid }
    }
    clearTriggerFlow(convId) // el activador fue editado/borrado mientras el flujo estaba en curso
  } else {
    const match = matchKeywordTrigger(cfg, message)
    if (match) {
      const { trigger, index } = match
      if (trigger.type === 'flow' && trigger.steps?.length) {
        startTriggerFlow(convId, index)
        const info = db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(convId, 'assistant', trigger.steps[0].message, Date.now())
        return { conversationId: convId, reply: trigger.steps[0].message, button: null, messageId: info.lastInsertRowid }
      }
      if (trigger.response) {
        const info = db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(convId, 'assistant', trigger.response, Date.now())
        return { conversationId: convId, reply: trigger.response, button: trigger.button || null, messageId: info.lastInsertRowid }
      }
    }
  }
```

Y en `routes/chat.js:927`, cambiar el return final de:

```js
  return { conversationId: convId, reply, messageId: info.lastInsertRowid }
```

a:

```js
  return { conversationId: convId, reply, button: null, messageId: info.lastInsertRowid }
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `node --test tests/keyword-trigger-dispatch.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Correr toda la suite para confirmar que no rompiste nada existente**

Run: `node --test tests/*.test.js`
Expected: PASS — mismo número de tests que antes de este task, más los 4 nuevos.

- [ ] **Step 6: Commit**

```bash
git add routes/chat.js tests/keyword-trigger-dispatch.test.js
git commit -m "feat: dispatch keyword triggers before the LLM call in processMessage"
```

---

### Task 4: Renderizado en WhatsApp (texto destacado, sin botón nativo)

**Files:**
- Modify: `routes/chat.js:1201` (dentro de `sock.ev.on('messages.upsert', ...)`)

**Interfaces:**
- Consumes: `result.button` (`{ label, url } | null`) del `processMessage` del Task 3.

- [ ] **Step 1: Modificar el envío de WhatsApp**

En `routes/chat.js:1200-1201`, reemplazar:

```js
          const result = await processMessage({ companyId, message: text.trim(), visitorId, channel: 'whatsapp' })
          if (result?.reply) await sock.sendMessage(remoteJid, { text: result.reply })
```

por:

```js
          const result = await processMessage({ companyId, message: text.trim(), visitorId, channel: 'whatsapp' })
          if (result?.reply) {
            const waText = result.button
              ? `${result.reply}\n\n👉 *${result.button.label}*\n${result.button.url}`
              : result.reply
            await sock.sendMessage(remoteJid, { text: waText })
          }
```

- [ ] **Step 2: Verificación manual (no hay test automatizado de envío real de WhatsApp)**

En el admin, crear un activador de prueba tipo "Respuesta automática", palabra clave `probarboton`, respuesta "Esto es una prueba", botón label "Ver más" / url `https://example.com`. Escribir `probarboton` al número de WhatsApp de una empresa de prueba (no Lynkro producción) y confirmar que llega:
```
Esto es una prueba

👉 *Ver más*
https://example.com
```
con el link tocable (WhatsApp lo subraya solo). Borrar el activador de prueba después.

- [ ] **Step 3: Commit**

```bash
git add routes/chat.js
git commit -m "feat: render keyword-trigger buttons as bold CTA text on WhatsApp (no native interactive message)"
```

---

### Task 5: Renderizado en el widget web (botón real)

**Files:**
- Modify: `public/widget.js:97-134` (CSS), `public/widget.js:244-262` (`addBubble`), `public/widget.js:352-366` (manejo de la respuesta de `/api/chat`)

**Interfaces:**
- Consumes: `data.button` (`{ label, url } | null`) de la respuesta JSON de `POST /api/chat` (ya la incluye automáticamente porque `res.json(result)` en `routes/chat.js:1698` reenvía todo el objeto que devuelve `processMessage` — no hace falta tocar la ruta).

- [ ] **Step 1: Agregar el estilo del botón**

En el bloque de CSS de `public/widget.js` (junto a `.ai-bubble.bot`, alrededor de la línea 123), agregar:

```css
    .ai-cta-btn{display:inline-block;margin-top:8px;padding:9px 16px;
      background:var(--ai-accent,#0ea5e9);color:#fff;border-radius:20px;
      font-size:13px;font-weight:600;text-decoration:none;align-self:flex-start}
    .ai-cta-btn:hover{opacity:.9}
```

- [ ] **Step 2: Modificar `addBubble` para aceptar un botón opcional**

En `public/widget.js:244-262`, reemplazar la función completa:

```js
  function addBubble(role, text, button) {
    const avatarSrc = cfg.avatarUrl ? (cfg.avatarUrl.startsWith('http') ? cfg.avatarUrl : API + cfg.avatarUrl) : '';
    if (role === 'bot') {
      const row = document.createElement('div');
      row.className = 'ai-row';
      if (avatarSrc) {
        row.innerHTML = `<img class="ai-row-av" src="${avatarSrc}"><div class="ai-bubble bot"></div>`;
      } else {
        row.innerHTML = `<div class="ai-row-av-def"><svg viewBox="0 0 24 24"><path d="M12 2a5 5 0 1 1 0 10A5 5 0 0 1 12 2zm0 12c5.33 0 8 2.67 8 4v2H4v-2c0-1.33 2.67-4 8-4z"/></svg></div><div class="ai-bubble bot"></div>`;
      }
      const bubble = row.querySelector('.ai-bubble');
      bubble.innerHTML = linkify(text);
      if (button && button.url) {
        const a = document.createElement('a');
        a.className = 'ai-cta-btn';
        a.href = button.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = button.label || button.url;
        bubble.appendChild(document.createElement('br'));
        bubble.appendChild(a);
      }
      msgsEl.appendChild(row);
    } else {
      const el = document.createElement('div');
      el.className = 'ai-bubble user';
      el.textContent = text;
      msgsEl.appendChild(el);
    }
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }
```

- [ ] **Step 3: Pasar `data.button` al llamar `addBubble`**

En `public/widget.js:359-360`, reemplazar:

```js
        if (data.reply) {
          addBubble('bot', data.reply);
```

por:

```js
        if (data.reply) {
          addBubble('bot', data.reply, data.button);
```

- [ ] **Step 4: Verificación manual**

Abrir `public/demo.html` (o el widget embebido de una empresa de prueba) en el navegador, escribir la palabra clave de un activador de prueba con botón configurado, confirmar que aparece la burbuja con el texto y, debajo, un botón redondeado del color de acento que abre el enlace en una pestaña nueva al hacer clic.

- [ ] **Step 5: Commit**

```bash
git add public/widget.js
git commit -m "feat: render keyword-trigger buttons as a real clickable button in the web widget"
```

---

### Task 6: Renderizado en Instagram (botón real vía template oficial de Meta)

**Files:**
- Modify: `routes/chat.js:350-359` (agregar función nueva junto a `sendInstagram`), `routes/chat.js:1973`

**Interfaces:**
- Consumes: `result.button` (`{ label, url } | null`).
- Produces: `sendInstagramButton(accessToken, recipientId, text, button)`, exportada junto a `sendInstagram`.

- [ ] **Step 1: Agregar `sendInstagramButton` junto a `sendInstagram`**

En `routes/chat.js`, justo después de la función `sendInstagram` (línea 350-359):

```js
export async function sendInstagramButton(accessToken, recipientId, text, button) {
  if (!accessToken || !recipientId) return
  const r = await fetch(`https://graph.instagram.com/v21.0/me/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { attachment: { type: 'template', payload: {
        template_type: 'button', text,
        buttons: [{ type: 'web_url', url: button.url, title: button.label || button.url }]
      }}},
      messaging_type: 'RESPONSE'
    })
  })
  const d = await r.json().catch(() => ({}))
  if (d.error) {
    console.error('[Instagram send button]', d.error.message, '— cayendo a texto plano')
    await sendInstagram(accessToken, recipientId, `${text}\n\n${button.label || 'Ver más'}: ${button.url}`)
  }
}
```

- [ ] **Step 2: Usar la función nueva cuando hay botón**

En `routes/chat.js:1971-1973`, reemplazar:

```js
      try {
        const result = await processMessage({ companyId: company.id, message: text, visitorId: `ig:${senderId}`, channel: 'instagram' })
        if (result?.reply) await sendInstagram(cfg.igAccessToken, senderId, result.reply)
      } catch (err) { console.error('[Instagram]', err.message) }
```

por:

```js
      try {
        const result = await processMessage({ companyId: company.id, message: text, visitorId: `ig:${senderId}`, channel: 'instagram' })
        if (result?.reply && result.button) await sendInstagramButton(cfg.igAccessToken, senderId, result.reply, result.button)
        else if (result?.reply) await sendInstagram(cfg.igAccessToken, senderId, result.reply)
      } catch (err) { console.error('[Instagram]', err.message) }
```

- [ ] **Step 3: Verificación manual**

Con una empresa de prueba que tenga Instagram conectado (ver `admin.html` sección Instagram), escribir por DM la palabra clave de un activador de prueba con botón. Confirmar que llega como mensaje con botón nativo de Instagram (no como texto con link).

- [ ] **Step 4: Commit**

```bash
git add routes/chat.js
git commit -m "feat: render keyword-trigger buttons via Instagram's official button template"
```

---

### Task 7: Admin UI — checkbox de botón por activador

**Files:**
- Modify: `public/admin.html:4232-4283` (`renderTriggers`, dentro del bloque de `type === 'response'`), `public/admin.html` función `save()`/`saveTriggers()` (validación antes de guardar)

**Interfaces:**
- Consumes: `config.keywordTriggers[i]` ya existente en el estado del admin.
- Produces: `config.keywordTriggers[i].button = { label, url } | null`, consumido por Task 3 vía `saveConfig`.

- [ ] **Step 1: Agregar los campos del botón al render de cada trigger**

En `public/admin.html`, dentro de `renderTriggers()`, justo después del bloque `tresponse_` (el textarea de "Respuesta automática", ver contexto exacto arriba de esta sección en el archivo actual), agregar dentro del mismo `div id="tresponse_' + i + '"` (para que solo se muestre en tipo `response`, nunca en `flow`):

```js
   '<div style="margin-top:10px;padding:8px 10px;background:#1a1a2a;border-radius:6px">' +
   '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
   '<input type="checkbox" id="tbtn_' + i + '"' + (t.button ? ' checked' : '') + ' style="width:auto;margin:0" onchange="toggleTriggerButton(' + i + ')">' +
   '<span style="font-size:12px;color:#aaa">Agregar botón con enlace</span></label>' +
   '<div id="tbtnfields_' + i + '" style="' + (t.button ? '' : 'display:none') + ';margin-top:8px;display:grid;grid-template-columns:1fr 2fr;gap:8px">' +
   '<input placeholder="Texto del botón (ej: Ver más)" value="' + ((t.button?.label)||'').replace(/"/g,'&quot;') + '" data-ti="' + i + '" data-field="buttonLabel">' +
   '<input placeholder="https://..." value="' + ((t.button?.url)||'').replace(/"/g,'&quot;') + '" data-ti="' + i + '" data-field="buttonUrl">' +
   '</div></div>'
```

(Este bloque va concatenado dentro del `div.innerHTML` existente de `renderTriggers`, inmediatamente después del `</textarea></div>` que cierra el campo de respuesta.)

- [ ] **Step 2: Manejar el toggle y los campos**

Agregar junto a `setTriggerType` en `public/admin.html`:

```js
function toggleTriggerButton(i) {
 const checked = document.getElementById('tbtn_' + i).checked;
 document.getElementById('tbtnfields_' + i).style.display = checked ? 'grid' : 'none';
 if (!checked) config.keywordTriggers[i].button = null;
 else config.keywordTriggers[i].button = config.keywordTriggers[i].button || { label: '', url: '' };
}
```

En el listener genérico de `data-field` dentro de `renderTriggers` (el `div.querySelectorAll('[data-field]').forEach(...)` existente), agregar dos casos nuevos junto a los de `keywords`/`followupEnabled`:

```js
    if (field === 'keywords') config.keywordTriggers[idx].keywords = el.value.split(',').map(function(k){return k.trim();}).filter(Boolean);
    else if (field === 'followupEnabled') config.keywordTriggers[idx].followupEnabled = el.checked;
    else if (field === 'buttonLabel') { config.keywordTriggers[idx].button = config.keywordTriggers[idx].button || {}; config.keywordTriggers[idx].button.label = el.value; }
    else if (field === 'buttonUrl') { config.keywordTriggers[idx].button = config.keywordTriggers[idx].button || {}; config.keywordTriggers[idx].button.url = el.value; }
    else config.keywordTriggers[idx][field] = el.value;
```

- [ ] **Step 3: Validar la URL antes de guardar**

En la función `save()` (la que hace el `fetch` de guardado de config), agregar al inicio, antes del `fetch`:

```js
 for (const t of (config.keywordTriggers || [])) {
  if (t.button && t.button.url && !/^https?:\/\//i.test(t.button.url)) {
   toast('El enlace del botón debe empezar con http:// o https://');
   return;
  }
 }
```

- [ ] **Step 4: Verificación manual**

En el panel de admin de una empresa de prueba, ir a Activadores → crear uno tipo "Respuesta automática" → marcar "Agregar botón con enlace" → dejar la URL vacía o sin `http` → intentar guardar → confirmar que aparece el toast de error y NO guarda. Poner una URL válida → guardar → recargar la página → confirmar que el checkbox y los campos quedan tal como se guardaron.

- [ ] **Step 5: Commit**

```bash
git add public/admin.html
git commit -m "feat: add button (label + url) option to keyword-trigger admin UI"
```

---

## Verificación final (todas las tasks)

- [ ] `node --test tests/*.test.js` — toda la suite pasa, incluyendo los tests nuevos de Tasks 1-3.
- [ ] Deploy a una empresa de prueba (NO Lynkro producción) siguiendo el método correcto (`docker cp` + `docker commit` + `docker service update`, ver `docs/superpowers/specs/... deploy-mi-agente-ia` memory) antes de repetir las verificaciones manuales de Tasks 4-7 contra el contenedor real.
- [ ] Confirmar que una conversación SIN ningún activador configurado sigue respondiendo por IA exactamente igual que antes de este plan (sin regresión).
