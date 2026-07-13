# Outbound SMS via Twilio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dual-send appointment confirm/cancel/reminder messages via SMS (Twilio) alongside the existing WhatsApp send, for companies that connect their own Twilio account.

**Architecture:** A new `services/twilio.js` wraps Twilio's REST API directly (no SDK dependency). A `sendSMS(cfg, phone, text)` wrapper in `routes/chat.js` mirrors the existing `sendWhatsApp`/`sendInstagram` fire-and-forget pattern. Three new admin routes (mirroring the existing GHL connect/test/disconnect routes) let a company save `cfg.twilio = { accountSid, authToken, fromNumber }`. The dual-send is wired at exactly 3 call sites — never inside the shared marketing-campaign `send()` helper in `jobs/campaign-scheduler.js`, which must stay untouched.

**Tech Stack:** Node.js (ESM), native `fetch`, Twilio REST API (Basic Auth, `application/x-www-form-urlencoded`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-13-sms-twilio-design.md` — outbound-only, no inbound SMS webhook, no new `conversations` channel.
- SMS applies ONLY to: `citas.confirm`, `citas.cancel` (both webhook handlers), and `reminder_24h`/`reminder_day`. It must NOT apply to marketing campaigns (`inactive`, `birthday`, `review`, `post_consult`, `winback`) — these all share the generic `send()` helper in `jobs/campaign-scheduler.js`, which must NOT be touched. Only the reminder-specific `sendReminder` inner function (inside `runAppointmentReminders`) gets the SMS call, since it's exclusively used for `cita_24h`/`cita_day`.
- SMS is always dual-sent alongside WhatsApp when `cfg.twilio` is connected — never a replacement, never a fallback-on-failure.
- `cfg.twilio = { accountSid, authToken, fromNumber, connected_at }` — saved directly (no OAuth), same shape/pattern as `cfg.ghl = { api_key, location_id, location_name, connected_at }`.
- Test convention already established in this repo (`tests/billing.test.js`): only pure functions are unit-tested. Functions that call `fetch` directly (`getAccountInfo`, `sendSMS` in `services/twilio.js`) are NOT unit-tested — verified manually against a Twilio trial account before deploy.
- Any deploy to the production container MUST use `docker commit` + `docker service update --image`, never `docker restart` (memory `feedback_deploy_mi_agente_ia.md`). After `docker service update`, the OLD container is NOT stopped automatically by Swarm — `docker stop` it manually or WhatsApp sessions will conflict (same memory, confirmed twice in production).
- Commit after every task.

---

### Task 1: `services/twilio.js` + pure-function tests

**Files:**
- Create: `services/twilio.js`
- Test: `tests/twilio.test.js`

**Interfaces:**
- Produces: `authHeader(accountSid, authToken) → string` (Basic auth header value), `buildMessageBody(fromNumber, toPhone, text) → URLSearchParams`, `formatTwilioError(fnName, status, data) → string`, `getAccountInfo(accountSid, authToken) → account object`, `sendSMS(accountSid, authToken, fromNumber, toPhone, text) → message object`. `sendSMS`'s exact signature is consumed verbatim by Task 2.

- [ ] **Step 1: Write the failing tests**

Create `tests/twilio.test.js`:

```js
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

describe('twilio service — pure helpers', () => {
  test('authHeader base64-encodes accountSid:authToken as Basic auth', async () => {
    const { authHeader } = await import('../services/twilio.js')
    const header = authHeader('ACxxxx', 'secrettoken')
    assert.ok(header.startsWith('Basic '))
    const decoded = Buffer.from(header.slice(6), 'base64').toString()
    assert.equal(decoded, 'ACxxxx:secrettoken')
  })

  test('buildMessageBody produces correct form-encoded fields', async () => {
    const { buildMessageBody } = await import('../services/twilio.js')
    const body = buildMessageBody('+15550001111', '+15550002222', 'Tu cita es mañana a las 3pm')
    assert.equal(body.get('From'), '+15550001111')
    assert.equal(body.get('To'), '+15550002222')
    assert.equal(body.get('Body'), 'Tu cita es mañana a las 3pm')
  })

  test('formatTwilioError prefers the API message over the status code', async () => {
    const { formatTwilioError } = await import('../services/twilio.js')
    const msg = formatTwilioError('sendSMS', 400, { message: 'Invalid To phone number' })
    assert.equal(msg, 'Twilio sendSMS failed: Invalid To phone number')
  })

  test('formatTwilioError falls back to the status code when no message', async () => {
    const { formatTwilioError } = await import('../services/twilio.js')
    const msg = formatTwilioError('getAccountInfo', 401, {})
    assert.equal(msg, 'Twilio getAccountInfo failed: 401')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/twilio.test.js`
Expected: FAIL — `Cannot find module '../services/twilio.js'`

- [ ] **Step 3: Write the implementation**

Create `services/twilio.js`:

```js
// services/twilio.js — Twilio REST API wrapper for outbound SMS.
// No SDK dependency — Twilio's Messages API is a single POST endpoint.
const API_BASE = 'https://api.twilio.com/2010-04-01'

export function authHeader(accountSid, authToken) {
  return 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64')
}

export function buildMessageBody(fromNumber, toPhone, text) {
  return new URLSearchParams({ From: fromNumber, To: toPhone, Body: text })
}

export function formatTwilioError(fnName, status, data) {
  return `Twilio ${fnName} failed: ${data?.message || status}`
}

export async function getAccountInfo(accountSid, authToken) {
  const res = await fetch(`${API_BASE}/Accounts/${accountSid}.json`, {
    headers: { Authorization: authHeader(accountSid, authToken) }
  })
  const data = await res.json()
  if (!res.ok) throw new Error(formatTwilioError('getAccountInfo', res.status, data))
  return data
}

export async function sendSMS(accountSid, authToken, fromNumber, toPhone, text) {
  const res = await fetch(`${API_BASE}/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(accountSid, authToken),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: buildMessageBody(fromNumber, toPhone, text).toString()
  })
  const data = await res.json()
  if (!res.ok) throw new Error(formatTwilioError('sendSMS', res.status, data))
  return data
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/twilio.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add services/twilio.js tests/twilio.test.js
git commit -m "feat: add Twilio REST API wrapper for outbound SMS"
```

---

### Task 2: `sendSMS(cfg, phone, text)` wrapper in `routes/chat.js`

**Files:**
- Modify: `routes/chat.js` (near `sendWhatsApp`/`sendInstagram`, search for `export async function sendInstagram`)

**Interfaces:**
- Consumes: `sendSMS(accountSid, authToken, fromNumber, toPhone, text)` from `services/twilio.js` (Task 1).
- Produces: `export async function sendSMS(cfg, phone, text)` — consumed by Task 5 (wiring) and by `jobs/campaign-scheduler.js` via `import { sendWhatsApp, sendSMS } from '../routes/chat.js'`.

- [ ] **Step 1: Add the wrapper**

In `routes/chat.js`, immediately after the closing `}` of `export async function sendInstagram(accessToken, recipientId, text) { ... }`, add:

```js
// ============================================================
// TWILIO SMS — dual-send alongside WhatsApp for appointment messages only
// ============================================================
export async function sendSMS(cfg, phone, text) {
  if (!cfg.twilio?.accountSid) return
  try {
    const { sendSMS: twilioSend } = await import('../services/twilio.js')
    await twilioSend(cfg.twilio.accountSid, cfg.twilio.authToken, cfg.twilio.fromNumber, phone, text)
  } catch (err) { console.error('SMS send error:', err.message) }
}
```

- [ ] **Step 2: Verify the file parses correctly**

Run: `node --check routes/chat.js`
Expected: no output (success)

- [ ] **Step 3: Commit**

```bash
git add routes/chat.js
git commit -m "feat: add sendSMS wrapper alongside sendWhatsApp/sendInstagram"
```

---

### Task 3: Admin routes — connect/test/disconnect Twilio

**Files:**
- Modify: `routes/admin.js` (near the GHL routes — search for `adminRouter.delete('/ghl/disconnect'`, add immediately after its closing `})`)

**Interfaces:**
- Consumes: `getAccountInfo(accountSid, authToken)` from `services/twilio.js` (Task 1).
- Produces: `GET /twilio/status`, `POST /twilio/test`, `DELETE /twilio/disconnect` — consumed by Task 4 (admin UI).

- [ ] **Step 1: Add the three routes**

In `routes/admin.js`, immediately after the GHL disconnect route's closing `})`, add:

```js
// ============================================================
// TWILIO SMS INTEGRATION
// ============================================================

adminRouter.get('/twilio/status', requireAdmin, withCompany, (req, res) => {
  const cfg = loadConfig(req.company.id)
  const t = cfg.twilio || {}
  res.json({ connected: !!(t.accountSid && t.authToken && t.fromNumber), fromNumber: t.fromNumber || null, connected_at: t.connected_at || null })
})

adminRouter.post('/twilio/test', requireAdmin, withCompany, async (req, res) => {
  const { accountSid, authToken, fromNumber } = req.body
  if (!accountSid || !authToken || !fromNumber) return res.status(400).json({ error: 'Falta Account SID, Auth Token o número From' })
  try {
    const { getAccountInfo } = await import('../services/twilio.js')
    const account = await getAccountInfo(accountSid, authToken)
    const cfg = loadConfig(req.company.id)
    cfg.twilio = { accountSid, authToken, fromNumber, connected_at: new Date().toISOString() }
    saveConfig(req.company.id, cfg)
    res.json({ ok: true, name: account.friendly_name || 'Twilio' })
  } catch (e) {
    res.json({ ok: false, error: e.message })
  }
})

adminRouter.delete('/twilio/disconnect', requireAdmin, withCompany, (req, res) => {
  const cfg = loadConfig(req.company.id)
  delete cfg.twilio
  saveConfig(req.company.id, cfg)
  res.json({ ok: true })
})
```

- [ ] **Step 2: Verify the file parses correctly**

Run: `node --check routes/admin.js`
Expected: no output (success)

- [ ] **Step 3: Commit**

```bash
git add routes/admin.js
git commit -m "feat: add Twilio connect/test/disconnect admin routes"
```

---

### Task 4: Admin UI — Twilio connection panel

**Files:**
- Modify: `public/admin.html` (HTML panel near the GHL connection panel; JS functions near `loadGhlStatus`/`toggleGhlForm`/`testGhlConn`/`disconnectGhl`; the `campanas` tab-load line)

**Interfaces:**
- Consumes: `GET /twilio/status`, `POST /twilio/test`, `DELETE /twilio/disconnect` (Task 3).

- [ ] **Step 1: Add the HTML panel**

In `public/admin.html`, immediately after the closing `</div>` of the `<!-- GHL CONNECTION PANEL -->` block (the one containing `id="ghl-banner"`), add:

```html
<!-- TWILIO SMS CONNECTION PANEL -->
<div id="twilio-banner" style="background:rgba(239,68,68,.05);border:1px solid rgba(239,68,68,.18);border-radius:12px;padding:16px 18px;margin-bottom:20px">
 <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
  <div style="display:flex;align-items:center;gap:10px">
   <div id="twilio-dot" style="width:9px;height:9px;border-radius:50%;background:#6b7280;flex-shrink:0;transition:background .3s"></div>
   <div>
    <div style="font-size:13px;font-weight:600;color:var(--text)">Twilio — SMS</div>
    <div id="twilio-status-txt" style="font-size:11px;color:var(--muted);margin-top:2px">No conectado · Los recordatorios de cita también se mandan por SMS si conectas Twilio</div>
   </div>
  </div>
  <div style="display:flex;gap:8px">
   <button id="btn-twilio-connect" onclick="toggleTwilioForm()" style="font-size:12px;padding:6px 14px">Conectar Twilio</button>
   <button id="btn-twilio-disconnect" onclick="disconnectTwilio()" style="display:none;font-size:12px;padding:6px 14px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:#ef4444;border-radius:8px;cursor:pointer">Desconectar</button>
  </div>
 </div>
 <div id="twilio-form" style="display:none;margin-top:14px;border-top:1px solid rgba(239,68,68,.1);padding-top:14px">
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:10px;align-items:end">
   <div>
    <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px">Account SID</label>
    <input id="twilio-account-sid" type="text" placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" style="font-size:12px;width:100%">
   </div>
   <div>
    <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px">Auth Token</label>
    <input id="twilio-auth-token" type="password" placeholder="••••••••••••••••••••••••••••••••" style="font-size:12px;width:100%">
   </div>
   <div>
    <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px">Número From</label>
    <input id="twilio-from-number" type="text" placeholder="+17865551234" style="font-size:12px;width:100%">
   </div>
   <button onclick="testTwilioConn()" style="font-size:12px;padding:7px 14px;white-space:nowrap">Probar y guardar</button>
  </div>
  <div style="font-size:11px;color:var(--muted);margin-top:8px">En Twilio Console → Account → API keys &amp; tokens</div>
  <div id="twilio-test-result" style="display:none;margin-top:10px;font-size:12px;padding:8px 12px;border-radius:8px"></div>
 </div>
</div>
```

- [ ] **Step 2: Add the JS functions**

In `public/admin.html`, immediately after the `disconnectGhl` function's closing `}`, add:

```js
async function loadTwilioStatus() {
  try {
    const r = await api('/api/twilio/status')
    const dot = document.getElementById('twilio-dot')
    const txt = document.getElementById('twilio-status-txt')
    const btnCon = document.getElementById('btn-twilio-connect')
    const btnDis = document.getElementById('btn-twilio-disconnect')
    if (r.connected) {
      dot.style.background = '#4ade80'
      txt.textContent = `Conectado · ${r.fromNumber} · desde ${r.connected_at ? new Date(r.connected_at).toLocaleDateString() : 'hoy'}`
      btnCon.style.display = 'none'
      btnDis.style.display = 'inline-flex'
    } else {
      dot.style.background = '#6b7280'
      txt.textContent = 'No conectado · Los recordatorios de cita también se mandan por SMS si conectas Twilio'
      btnCon.style.display = 'inline-flex'
      btnDis.style.display = 'none'
    }
  } catch (e) {}
}

function toggleTwilioForm() {
  const f = document.getElementById('twilio-form')
  f.style.display = f.style.display === 'none' ? 'block' : 'none'
}

async function testTwilioConn() {
  const accountSid = document.getElementById('twilio-account-sid').value.trim()
  const authToken  = document.getElementById('twilio-auth-token').value.trim()
  const fromNumber = document.getElementById('twilio-from-number').value.trim()
  const res = document.getElementById('twilio-test-result')
  if (!accountSid || !authToken || !fromNumber) { toast('Completa Account SID, Auth Token y número From'); return }
  res.style.display = 'block'
  res.style.background = 'rgba(100,100,100,.15)'
  res.textContent = 'Probando conexión...'
  try {
    const r = await api('/api/twilio/test', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ accountSid, authToken, fromNumber }) })
    if (r.ok) {
      res.style.background = 'rgba(74,222,128,.1)'
      res.style.color = '#4ade80'
      res.textContent = `✓ Conectado · ${r.name}`
      document.getElementById('twilio-form').style.display = 'none'
      loadTwilioStatus()
      toast('Twilio conectado correctamente')
    } else {
      res.style.background = 'rgba(239,68,68,.1)'
      res.style.color = '#ef4444'
      res.textContent = `✗ Error: ${r.error}`
    }
  } catch (e) {
    res.style.background = 'rgba(239,68,68,.1)'
    res.style.color = '#ef4444'
    res.textContent = `✗ ${e.message}`
  }
}

async function disconnectTwilio() {
  if (!confirm('¿Desconectar Twilio? Los recordatorios de cita dejarán de mandarse por SMS.')) return
  await api('/api/twilio/disconnect', { method: 'DELETE' })
  loadTwilioStatus()
  toast('Twilio desconectado')
}
```

- [ ] **Step 3: Wire the tab-load call**

Find the line `if (name === 'campanas') { loadServerCreds(); loadGhlStatus(); loadSquareStatus(); loadQBOStatus(); loadGoogleStatus(); loadCalendarProvider() }` and extend it:

```js
if (name === 'campanas') { loadServerCreds(); loadGhlStatus(); loadSquareStatus(); loadQBOStatus(); loadGoogleStatus(); loadCalendarProvider(); loadTwilioStatus() }
```

(There is a second, older duplicate of this same tab-trigger line elsewhere in the file that delegates to the original — leave that one untouched, exactly as was done for the Google Calendar admin UI task in the previous plan.)

- [ ] **Step 4: Review the diff for balanced tags**

No automated check is available for this file. Read your own diff and confirm every `<div>` opened is closed, and every new `<script>` function has a matching closing brace.

- [ ] **Step 5: Commit**

```bash
git add public/admin.html
git commit -m "feat: add Twilio SMS connection panel to admin UI"
```

---

### Task 5: Wire SMS dual-send at the 3 appointment-message call sites

**Files:**
- Modify: `routes/admin.js` (GHL webhook handler and generic webhook handler — search for `citas.confirm?.enabled` and `citas.cancel?.enabled`, appears twice each, once per handler)
- Modify: `jobs/campaign-scheduler.js` (inside `runAppointmentReminders`'s inner `sendReminder` function — search for `await send(cfg, normalizePhone(c.phone || '')`)

**Interfaces:**
- Consumes: `sendSMS(cfg, phone, text)` from `routes/chat.js` (Task 2).

- [ ] **Step 1: Wire the GHL webhook handler**

In `routes/admin.js`, find this block (the GHL appointment webhook handler):

```js
    const { getContact, normalizePhone, fillTemplate } = await import('../services/ghl.js')
    const { sendWhatsApp: sendWA } = await import('../routes/chat.js')
```

Replace with:

```js
    const { getContact, normalizePhone, fillTemplate } = await import('../services/ghl.js')
    const { sendWhatsApp: sendWA, sendSMS } = await import('../routes/chat.js')
```

Then find:

```js
      if (!dup) {
        await sendWA(cfg, phone, fillTemplate(citas.confirm.message, vars))
        logRow.run(company.id, appointment.contactId, 'cita_confirm', appointment.id, 'whatsapp', 'sent', null)
      }
    }
    if (isDelete && citas.cancel?.enabled) {
      await sendWA(cfg, phone, fillTemplate(citas.cancel.message || 'Hola {nombre}, tu cita fue cancelada. Escríbenos para reagendar.', vars))
      logRow.run(company.id, appointment.contactId, 'cita_cancel', appointment.id, 'whatsapp', 'sent', null)
    }
```

Replace with:

```js
      if (!dup) {
        const confirmMsg = fillTemplate(citas.confirm.message, vars)
        await sendWA(cfg, phone, confirmMsg)
        await sendSMS(cfg, phone, confirmMsg)
        logRow.run(company.id, appointment.contactId, 'cita_confirm', appointment.id, 'whatsapp', 'sent', null)
      }
    }
    if (isDelete && citas.cancel?.enabled) {
      const cancelMsg = fillTemplate(citas.cancel.message || 'Hola {nombre}, tu cita fue cancelada. Escríbenos para reagendar.', vars)
      await sendWA(cfg, phone, cancelMsg)
      await sendSMS(cfg, phone, cancelMsg)
      logRow.run(company.id, appointment.contactId, 'cita_cancel', appointment.id, 'whatsapp', 'sent', null)
    }
```

- [ ] **Step 2: Wire the generic webhook handler**

In `routes/admin.js`, find this block (the generic Vagaro/Booksy/Zapier webhook handler):

```js
    const { sendWhatsApp } = await import('../routes/chat.js')
    const { fillTemplate, normalizePhone } = await import('../services/ghl.js')
```

Replace with:

```js
    const { sendWhatsApp, sendSMS } = await import('../routes/chat.js')
    const { fillTemplate, normalizePhone } = await import('../services/ghl.js')
```

Then find:

```js
      if (!dup) {
        await sendWhatsApp(cfg, phone, fillTemplate(citas.confirm.message, vars))
        logStmt.run(company.id, contact.phone, 'cita_confirm', appt.id, 'whatsapp', 'sent', null)
      }
    }
    if (isCancel && citas.cancel?.enabled) {
      await sendWhatsApp(cfg, phone, fillTemplate(citas.cancel?.message || 'Hola {nombre}, tu cita fue cancelada. Escríbenos para reagendar.', vars))
      logStmt.run(company.id, contact.phone, 'cita_cancel', appt.id, 'whatsapp', 'sent', null)
    }
```

Replace with:

```js
      if (!dup) {
        const confirmMsg = fillTemplate(citas.confirm.message, vars)
        await sendWhatsApp(cfg, phone, confirmMsg)
        await sendSMS(cfg, phone, confirmMsg)
        logStmt.run(company.id, contact.phone, 'cita_confirm', appt.id, 'whatsapp', 'sent', null)
      }
    }
    if (isCancel && citas.cancel?.enabled) {
      const cancelMsg = fillTemplate(citas.cancel?.message || 'Hola {nombre}, tu cita fue cancelada. Escríbenos para reagendar.', vars)
      await sendWhatsApp(cfg, phone, cancelMsg)
      await sendSMS(cfg, phone, cancelMsg)
      logStmt.run(company.id, contact.phone, 'cita_cancel', appt.id, 'whatsapp', 'sent', null)
    }
```

- [ ] **Step 3: Wire the appointment reminders**

In `jobs/campaign-scheduler.js`, find the top import line:

```js
import { sendWhatsApp } from '../routes/chat.js'
```

Replace with:

```js
import { sendWhatsApp, sendSMS } from '../routes/chat.js'
```

Then find, inside the `sendReminder` inner function of `runAppointmentReminders`:

```js
      await send(cfg, normalizePhone(c.phone || ''), msg, companyId, a.contactId, type, 'whatsapp', a.id)
    }
  }
```

Replace with:

```js
      const normalized = normalizePhone(c.phone || '')
      await send(cfg, normalized, msg, companyId, a.contactId, type, 'whatsapp', a.id)
      await sendSMS(cfg, normalized, msg)
    }
  }
```

**Do NOT touch the shared `send()` helper function itself** (used by `runInactive`, `runReview`, `runPostConsult`, `runWinback`, and Square/QBO campaign runners further down the file) — only this one call site inside `sendReminder`, which is exclusively used for `cita_24h`/`cita_day`.

- [ ] **Step 4: Verify both files parse correctly**

Run:
```bash
node --check routes/admin.js
node --check jobs/campaign-scheduler.js
```
Expected: no output from either command

- [ ] **Step 5: Commit**

```bash
git add routes/admin.js jobs/campaign-scheduler.js
git commit -m "feat: dual-send appointment confirm/cancel/reminder messages via SMS"
```

---

### Task 6: Deploy to production

**Files:** none (operational task)

- [ ] **Step 1: Identify the active container and copy changed files**

```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}" | grep agente
```

Copy every changed file into that container:
```bash
ACTIVE=<container-name-from-above>
for f in services/twilio.js routes/chat.js routes/admin.js jobs/campaign-scheduler.js public/admin.html; do
  docker cp "$f" "$ACTIVE:/app/$f"
done
```

- [ ] **Step 2: Verify the files match before committing the image**

```bash
for f in services/twilio.js routes/chat.js routes/admin.js jobs/campaign-scheduler.js public/admin.html; do
  docker exec $ACTIVE sh -c "cat /app/$f" | diff - "$f" && echo "MATCH: $f"
done
```
Expected: `MATCH:` for every file.

- [ ] **Step 3: Commit the image and update the service**

```bash
docker commit $ACTIVE lynkro-agente:sms-twilio
docker service update --image lynkro-agente:sms-twilio mi-agente-ai_mi-agente-ai
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

- [ ] **Step 6: Manual verification against a Twilio trial account**

Before telling a client this is ready: connect a real (trial-account-is-fine) Twilio Account SID/Auth Token/From number for a test company via the new admin panel, trigger a test appointment confirm/cancel (or wait for a real 24h/day-of reminder), and confirm the SMS actually arrives at a real phone alongside the WhatsApp message.
