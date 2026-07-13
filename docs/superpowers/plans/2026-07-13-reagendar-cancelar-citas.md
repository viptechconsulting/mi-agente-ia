# Reagendar y Cancelar Citas por Chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the WhatsApp/Instagram AI agent (Claude, tool-use in `routes/chat.js`) reschedule and cancel existing appointments in real time, for companies whose calendar provider is Square, GHL, or Google Calendar.

**Architecture:** A new `cfg.calendarProvider` config field selects which provider a company uses. Four new Claude tools (`find_my_appointments`, `check_availability`, `reschedule_appointment`, `cancel_appointment`) are registered only when `cfg.calendarProvider` is a supported value; each tool-handler branches on `cfg.calendarProvider` and calls the matching provider function in `services/square.js`, `services/ghl.js`, or the new `services/google-calendar.js`. A shared pure policy helper (`services/appointments.js`) enforces the minimum-notice window. Companies without a supported `calendarProvider` (including Vagaro/Booksy) get no new tools — the existing "never promise what the system can't do" prompt rule already covers the fallback-to-human behavior.

**Tech Stack:** Node.js (ESM), Express, better-sqlite3, `@anthropic-ai/sdk` tool-use, native `fetch` for all HTTP (no new dependencies).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-13-reagendar-cancelar-citas-design.md` — v1 covers Square, GHL, Google Calendar only. Vagaro/Booksy are out of scope (no confirmed write API).
- Follow existing file conventions exactly: `services/*.js` use plain `fetch` + `throw new Error(...)` on non-ok responses, no fetch-mocking in tests (see below).
- Test convention already established in this repo (`tests/billing.test.js`): only **pure functions** are unit-tested (param builders, parsers, policy checks). Functions that call `fetch` directly (`createBooking`, `getBookings`, `getAppointments`, etc.) are **not** unit-tested in this codebase — they're verified manually against sandbox/test accounts before deploy. The new `updateBooking`/`cancelBooking`/`updateAppointment`/`cancelAppointment`/Google Calendar functions follow this same convention. Do not introduce a fetch-mocking pattern that doesn't already exist here.
- Any deploy of this code to the production container MUST use `docker commit` + `docker service update --image` — never `docker restart` (see memory `feedback_deploy_mi_agente_ia.md`: Swarm's `on-failure` restart policy silently reverts `docker cp`'d changes on restart).
- Commit after every task, following the message style already in `git log` (`feat: ...`, `docs: ...`).

---

### Task 1: Config schema — `calendarProvider` and notification toggles

**Files:**
- Modify: `db.js` (defaultConfig, ~line 104-150)

**Interfaces:**
- Produces: `cfg.calendarProvider` (`'square' | 'ghl' | 'google' | null`, default `null`), `cfg.notifyOnReschedule` (boolean, default `true`), `cfg.notifyOnCancel` (boolean, default `true`).

- [ ] **Step 1: Add the new fields to `defaultConfig`**

Open `db.js`, find the `notifyOnEscalation: true,` line inside `export const defaultConfig = {`, and add the new fields right after it:

```js
  notifyOnEscalation: true,
  notifyOnReschedule: true,
  notifyOnCancel: true,
  calendarProvider: null, // 'square' | 'ghl' | 'google' | null — which calendar API to use for reschedule/cancel tools
```

- [ ] **Step 2: Verify config loads with the new defaults**

Run:
```bash
cd /root/mi-agente-ia && node -e "
import('./db.js').then(({ defaultConfig }) => {
  console.log(defaultConfig.calendarProvider, defaultConfig.notifyOnReschedule, defaultConfig.notifyOnCancel)
})
"
```
Expected output: `null true true`

- [ ] **Step 3: Commit**

```bash
git add db.js
git commit -m "feat: add calendarProvider and reschedule/cancel notify config fields"
```

---

### Task 2: Shared policy helper — `services/appointments.js`

**Files:**
- Create: `services/appointments.js`
- Test: `tests/appointments.test.js`

**Interfaces:**
- Produces: `canModifyAppointment({ startTimeISO, nowISO, minNoticeHours }) → { allowed: boolean, hoursUntil: number }` — used by Task 7's tool handlers for both reschedule and cancel.

- [ ] **Step 1: Write the failing test**

Create `tests/appointments.test.js`:

```js
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

describe('appointments service — canModifyAppointment', () => {
  test('allows when well outside the notice window', async () => {
    const { canModifyAppointment } = await import('../services/appointments.js')
    const result = canModifyAppointment({
      startTimeISO: '2026-07-15T13:00:00.000Z',
      nowISO: '2026-07-13T13:00:00.000Z',
      minNoticeHours: 4
    })
    assert.equal(result.allowed, true)
    assert.equal(result.hoursUntil, 48)
  })

  test('blocks when inside the notice window', async () => {
    const { canModifyAppointment } = await import('../services/appointments.js')
    const result = canModifyAppointment({
      startTimeISO: '2026-07-13T15:00:00.000Z',
      nowISO: '2026-07-13T13:00:00.000Z',
      minNoticeHours: 4
    })
    assert.equal(result.allowed, false)
    assert.equal(result.hoursUntil, 2)
  })

  test('blocks appointments already in the past', async () => {
    const { canModifyAppointment } = await import('../services/appointments.js')
    const result = canModifyAppointment({
      startTimeISO: '2026-07-13T10:00:00.000Z',
      nowISO: '2026-07-13T13:00:00.000Z',
      minNoticeHours: 4
    })
    assert.equal(result.allowed, false)
    assert.ok(result.hoursUntil < 0)
  })

  test('defaults minNoticeHours to 4 when not provided', async () => {
    const { canModifyAppointment } = await import('../services/appointments.js')
    const result = canModifyAppointment({
      startTimeISO: '2026-07-13T16:00:00.000Z',
      nowISO: '2026-07-13T13:00:00.000Z'
    })
    assert.equal(result.allowed, false) // 3 hours < default 4
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/appointments.test.js`
Expected: FAIL — `Cannot find module '../services/appointments.js'`

- [ ] **Step 3: Write the implementation**

Create `services/appointments.js`:

```js
// services/appointments.js — provider-agnostic appointment policy shared by
// the reschedule/cancel tool handlers in routes/chat.js

export function canModifyAppointment({ startTimeISO, nowISO, minNoticeHours = 4 }) {
  const start = new Date(startTimeISO).getTime()
  const now = new Date(nowISO || Date.now()).getTime()
  const hoursUntil = (start - now) / (1000 * 60 * 60)
  return { allowed: hoursUntil >= minNoticeHours, hoursUntil: Math.round(hoursUntil * 100) / 100 }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/appointments.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add services/appointments.js tests/appointments.test.js
git commit -m "feat: add canModifyAppointment min-notice-window policy helper"
```

---

### Task 3: Square service — `updateBooking` and `cancelBooking`

**Files:**
- Modify: `services/square.js` (after `createBooking`, ~line 280)

**Interfaces:**
- Consumes: existing `BASE_URL`, `SQUARE_VERSION` constants already in this file.
- Produces: `updateBooking(accessToken, bookingId, { startAt, version }) → booking object`, `cancelBooking(accessToken, bookingId, version) → booking object`. Both used by Task 7.

- [ ] **Step 1: Add `updateBooking` and `cancelBooking`**

In `services/square.js`, immediately after the closing brace of `createBooking` (before `export function normalizeCustomer`), add:

```js
export async function updateBooking(accessToken, bookingId, { startAt, version }) {
  const body = { booking: { start_at: startAt, version } }
  const res = await fetch(`${BASE_URL}/v2/bookings/${bookingId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Square-Version': SQUARE_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`Square updateBooking failed: ${data.errors?.[0]?.detail || res.status}`)
  return data.booking
}

export async function cancelBooking(accessToken, bookingId, version) {
  const res = await fetch(`${BASE_URL}/v2/bookings/${bookingId}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Square-Version': SQUARE_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify({ booking_version: version })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`Square cancelBooking failed: ${data.errors?.[0]?.detail || res.status}`)
  return data.booking
}
```

Note: Square requires the booking's current `version` (optimistic concurrency) for both calls — callers must fetch the booking first (`getBookings`, which already returns `version` in the raw Square response) before calling either function.

- [ ] **Step 2: Verify the file still parses correctly**

Run: `node --check services/square.js`
Expected: no output (success)

- [ ] **Step 3: Commit**

```bash
git add services/square.js
git commit -m "feat: add Square updateBooking and cancelBooking"
```

---

### Task 4: GHL service — `updateAppointment` and `cancelAppointment`

**Files:**
- Modify: `services/ghl.js` (after `getAppointments`, ~line 55)

**Interfaces:**
- Consumes: existing `GHL_BASE`, `GHL_VER`, `h(apiKey)` helper already in this file.
- Produces: `updateAppointment(apiKey, eventId, { startTime, endTime }) → appointment object`, `cancelAppointment(apiKey, eventId) → appointment object`. Both used by Task 7.

- [ ] **Step 1: Add `updateAppointment` and `cancelAppointment`**

In `services/ghl.js`, immediately after `getAppointments`, add:

```js
// Reschedule: move an existing appointment to a new start/end time (ISO strings)
export async function updateAppointment(apiKey, eventId, { startTime, endTime }) {
  const r = await fetch(`${GHL_BASE}/calendars/events/appointments/${eventId}`, {
    method: 'PUT',
    headers: h(apiKey),
    body: JSON.stringify({ startTime, endTime })
  })
  if (!r.ok) throw new Error(`GHL updateAppointment ${r.status}`)
  const d = await r.json()
  return d.appointment || d
}

// Cancel: mark the appointment as cancelled (keeps the record, doesn't delete it)
export async function cancelAppointment(apiKey, eventId) {
  const r = await fetch(`${GHL_BASE}/calendars/events/appointments/${eventId}`, {
    method: 'PUT',
    headers: h(apiKey),
    body: JSON.stringify({ appointmentStatus: 'cancelled' })
  })
  if (!r.ok) throw new Error(`GHL cancelAppointment ${r.status}`)
  const d = await r.json()
  return d.appointment || d
}
```

- [ ] **Step 2: Verify the file still parses correctly**

Run: `node --check services/ghl.js`
Expected: no output (success)

- [ ] **Step 3: Commit**

```bash
git add services/ghl.js
git commit -m "feat: add GHL updateAppointment and cancelAppointment"
```

---

### Task 5: Google Calendar service — OAuth + event CRUD (new integration)

**Files:**
- Create: `services/google-calendar.js`

**Interfaces:**
- Consumes: `getServerSetting` from `db.js` (same pattern as `services/square.js`/`services/qbo.js`).
- Produces: `hasCredentials()`, `getOAuthUrl(state)`, `exchangeCode(code)`, `refreshAccessToken(refreshToken)`, `getValidAccessToken(cfg) → string` (auto-refreshes), `getEvents(accessToken, calendarId, timeMinISO, timeMaxISO)`, `findEventsByPhone(accessToken, calendarId, phone)`, `checkFreeBusy(accessToken, calendarId, startISO, endISO) → boolean`, `updateEvent(accessToken, calendarId, eventId, { startISO, endISO })`, `deleteEvent(accessToken, calendarId, eventId)`. All consumed by Task 7 and the admin routes in Task 6.

- [ ] **Step 1: Write the OAuth + token functions**

Create `services/google-calendar.js`:

```js
// services/google-calendar.js — Google Calendar OAuth + event CRUD for
// reschedule/cancel. Mirrors the OAuth pattern already used in services/qbo.js.
import { getServerSetting } from '../db.js'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const CAL_BASE = 'https://www.googleapis.com/calendar/v3'
const SCOPE = 'https://www.googleapis.com/auth/calendar.events'

function redirectUri() {
  return process.env.GOOGLE_CALLBACK_URL || 'https://chat.lynkro.io/api/google-calendar/callback'
}
function clientId()     { return process.env.GOOGLE_CLIENT_ID     || getServerSetting('google_client_id')     || '' }
function clientSecret() { return process.env.GOOGLE_CLIENT_SECRET || getServerSetting('google_client_secret') || '' }

export function hasCredentials() {
  return !!(clientId() && clientSecret())
}

export function getOAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent', // forces refresh_token on every consent, not just the first
    state: state ?? '',
  })
  return `${AUTH_URL}?${params}`
}

export async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirectUri(),
  })
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })
  if (!res.ok) throw new Error(`Google exchangeCode failed (${res.status}): ${await res.text()}`)
  return res.json() // { access_token, refresh_token, expires_in, ... }
}

export async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId(),
    client_secret: clientSecret(),
  })
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })
  if (!res.ok) throw new Error(`Google refreshAccessToken failed (${res.status}): ${await res.text()}`)
  return res.json() // { access_token, expires_in, ... } — no new refresh_token on refresh
}

// Returns a valid access token, refreshing (and persisting) it if it's expired
// or about to expire. cfg.googleCalendar must be { access_token, refresh_token,
// expires_at (ms epoch), calendar_id }. Caller is responsible for saving cfg
// back via saveConfig() after this mutates cfg.googleCalendar.expires_at/access_token.
export async function getValidAccessToken(cfg) {
  const gc = cfg.googleCalendar
  if (!gc?.refresh_token) throw new Error('Google Calendar no está conectado para esta empresa')
  if (gc.access_token && gc.expires_at && Date.now() < gc.expires_at - 60_000) {
    return gc.access_token
  }
  const tokens = await refreshAccessToken(gc.refresh_token)
  gc.access_token = tokens.access_token
  gc.expires_at = Date.now() + (tokens.expires_in * 1000)
  return gc.access_token
}

export async function getEvents(accessToken, calendarId, timeMinISO, timeMaxISO) {
  const params = new URLSearchParams({
    timeMin: timeMinISO, timeMax: timeMaxISO,
    singleEvents: 'true', orderBy: 'startTime', maxResults: '50'
  })
  const res = await fetch(`${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`Google getEvents failed: ${data.error?.message || res.status}`)
  return data.items || []
}

// Best-effort match: Google Calendar events have no structured "customer phone"
// field, so this searches the event description for the phone's digits. Weaker
// than the Square/GHL customer-record match — only reliable if whatever process
// created the event put the phone number in the description (common for manual
// bookings and most external booking widgets that sync to Google Calendar).
export async function findEventsByPhone(accessToken, calendarId, phone) {
  const digits = String(phone).replace(/\D/g, '')
  const now = new Date()
  const in90days = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)
  const events = await getEvents(accessToken, calendarId, now.toISOString(), in90days.toISOString())
  return events.filter(e => (e.description || '').replace(/\D/g, '').includes(digits))
}

export async function checkFreeBusy(accessToken, calendarId, startISO, endISO) {
  const res = await fetch(`${CAL_BASE}/freeBusy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeMin: startISO, timeMax: endISO, items: [{ id: calendarId }] })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`Google checkFreeBusy failed: ${data.error?.message || res.status}`)
  const busy = data.calendars?.[calendarId]?.busy || []
  return busy.length === 0
}

export async function updateEvent(accessToken, calendarId, eventId, { startISO, endISO }) {
  const res = await fetch(`${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ start: { dateTime: startISO }, end: { dateTime: endISO } })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`Google updateEvent failed: ${data.error?.message || res.status}`)
  return data
}

export async function deleteEvent(accessToken, calendarId, eventId) {
  const res = await fetch(`${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!res.ok && res.status !== 410) throw new Error(`Google deleteEvent failed: ${res.status}`) // 410 = already gone, treat as success
  return true
}
```

- [ ] **Step 2: Verify the file parses correctly**

Run: `node --check services/google-calendar.js`
Expected: no output (success)

- [ ] **Step 3: Commit**

```bash
git add services/google-calendar.js
git commit -m "feat: add Google Calendar OAuth + event CRUD service"
```

---

### Task 6: Admin routes + UI — provider selection and Google Calendar connect

**Files:**
- Modify: `routes/admin.js` (near the Square routes, ~line 814, after `square/disconnect`)
- Modify: `public/admin.html` (near the Square connection panel, ~line 1830-1845, and the JS section ~line 5138-5175)

**Interfaces:**
- Consumes: `services/google-calendar.js` from Task 5, `loadConfig`/`saveConfig` from `db.js`.
- Produces: `GET /api/google-calendar/status`, `GET /api/google-calendar/connect`, `GET /api/google-calendar/callback`, `DELETE /api/google-calendar/disconnect`, `POST /api/calendar-provider` (sets `cfg.calendarProvider`) — all consumed by the admin UI and set the config Task 7's tools read.

- [ ] **Step 1: Add Google Calendar OAuth routes**

In `routes/admin.js`, immediately after the `square/disconnect` route (after its closing `})`), add:

```js
// ============================================================
// GOOGLE CALENDAR INTEGRATION
// ============================================================

adminRouter.get('/google-calendar/status', requireAdmin, withCompany, async (req, res) => {
  const cfg = loadConfig(req.company.id)
  res.json({
    connected: !!(cfg.googleCalendar?.refresh_token),
    calendar_id: cfg.googleCalendar?.calendar_id || null
  })
})

adminRouter.get('/google-calendar/connect', requireAdmin, withCompany, async (req, res) => {
  const { hasCredentials, getOAuthUrl } = await import('../services/google-calendar.js')
  if (!hasCredentials()) return res.status(503).json({ error: 'Faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET en el servidor' })
  const state = Buffer.from(JSON.stringify({ cid: req.company.id, ts: Date.now() })).toString('base64url')
  res.redirect(getOAuthUrl(state))
})

adminRouter.get('/google-calendar/callback', async (req, res) => {
  const { code, state, error } = req.query
  if (error) return res.redirect('/admin?msg=google_denied')
  try {
    const { cid } = JSON.parse(Buffer.from(state, 'base64url').toString())
    const { exchangeCode } = await import('../services/google-calendar.js')
    const tokens = await exchangeCode(code)
    const cfg = loadConfig(cid)
    cfg.googleCalendar = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + (tokens.expires_in * 1000),
      calendar_id: 'primary',
      connected_at: new Date().toISOString()
    }
    saveConfig(cid, cfg)
    res.redirect('/admin?msg=google_ok')
  } catch (e) {
    console.error('[google-calendar-callback]', e.message)
    res.redirect('/admin?msg=google_error')
  }
})

adminRouter.delete('/google-calendar/disconnect', requireAdmin, withCompany, async (req, res) => {
  saveConfig(req.company.id, { googleCalendar: null })
  res.json({ ok: true })
})

adminRouter.post('/calendar-provider', requireAdmin, withCompany, async (req, res) => {
  const { provider } = req.body
  if (![null, 'square', 'ghl', 'google'].includes(provider)) {
    return res.status(400).json({ error: 'Proveedor inválido' })
  }
  const cfg = loadConfig(req.company.id)
  cfg.calendarProvider = provider
  saveConfig(req.company.id, cfg)
  res.json({ ok: true })
})
```

Note: `google_client_id`/`google_client_secret` server settings follow the exact pattern of `square_app_id`/`square_app_secret` already handled by the `/server-config/integrations` routes (~line 939) — add `google_client_id`/`google_client_secret` to that existing GET/POST pair the same way `qbo_client_id`/`qbo_client_secret` are handled there, so the super-admin can save them from the same panel.

- [ ] **Step 2: Verify the file parses correctly**

Run: `node --check routes/admin.js`
Expected: no output (success)

- [ ] **Step 3: Add the admin UI — provider selector + Google connect panel**

In `public/admin.html`, immediately after the closing `</div>` of the Square connection panel (the block starting at `<!-- SQUARE CONNECTION PANEL -->`, ending before whatever comes next), add:

```html
<!-- CALENDAR PROVIDER SELECTOR -->
<div style="background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:12px;padding:16px 18px;margin-bottom:14px">
 <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:8px">Proveedor de calendario (reagendar/cancelar por chat)</div>
 <select id="calendar-provider-select" onchange="saveCalendarProvider()" style="width:100%;padding:8px;border-radius:8px">
  <option value="">Ninguno (el bot escala a un humano)</option>
  <option value="square">Square</option>
  <option value="ghl">GoHighLevel</option>
  <option value="google">Google Calendar</option>
 </select>
</div>

<!-- GOOGLE CALENDAR CONNECTION PANEL -->
<div id="google-banner" style="background:rgba(59,165,255,.05);border:1px solid rgba(59,165,255,.18);border-radius:12px;padding:16px 18px;margin-bottom:14px">
 <div style="display:flex;align-items:center;gap:10px">
  <div id="google-dot" style="width:9px;height:9px;border-radius:50%;background:#6b7280;flex-shrink:0"></div>
  <div style="flex:1">
   <div style="font-size:13px;font-weight:600;color:var(--text)">Google Calendar</div>
   <div id="google-status-txt" style="font-size:11px;color:var(--muted);margin-top:2px">Cargando…</div>
  </div>
  <button id="btn-google-connect" onclick="connectGoogleCalendar()" style="display:none;font-size:12px;padding:6px 14px">Conectar Google Calendar</button>
  <button id="btn-google-disconnect" onclick="disconnectGoogleCalendar()" style="display:none;font-size:12px;padding:6px 14px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:#ef4444;border-radius:8px;cursor:pointer">Desconectar</button>
 </div>
</div>
```

- [ ] **Step 4: Add the admin UI JavaScript**

In `public/admin.html`, immediately after the `disconnectSquare` function (~line 5170), add:

```js
async function loadCalendarProvider() {
  const cfg = await api(`/api/config?companyId=${activeCompanyId}`)
  document.getElementById('calendar-provider-select').value = cfg.calendarProvider || ''
}
async function saveCalendarProvider() {
  const provider = document.getElementById('calendar-provider-select').value || null
  await api('/api/calendar-provider', { method: 'POST', body: JSON.stringify({ provider }) })
}

async function loadGoogleStatus() {
  try {
    const r = await api('/api/google-calendar/status')
    const dot  = document.getElementById('google-dot')
    const txt  = document.getElementById('google-status-txt')
    const btnC = document.getElementById('btn-google-connect')
    const btnD = document.getElementById('btn-google-disconnect')
    if (r.connected) {
      dot.style.background = '#22c55e'
      txt.textContent = 'Conectado · Google Calendar activo'
      btnC.style.display = 'none'
      btnD.style.display = 'inline-block'
    } else {
      dot.style.background = '#6b7280'
      txt.textContent = 'No conectado'
      btnC.style.display = 'inline-block'
      btnD.style.display = 'none'
    }
  } catch (e) { console.error('[Google Calendar status]', e.message) }
}
function connectGoogleCalendar() {
  const url = `/api/google-calendar/connect?companyId=${activeCompanyId}&adminPassword=${encodeURIComponent(password)}&adminEmail=${encodeURIComponent(adminEmail)}`
  window.open(url, '_blank')
}
async function disconnectGoogleCalendar() {
  if (!confirm('¿Desconectar Google Calendar?')) return
  await api('/api/google-calendar/disconnect', { method: 'DELETE' })
  loadGoogleStatus()
}
```

Then find the line `if (name === 'campanas') { loadServerCreds(); loadGhlStatus(); loadSquareStatus(); loadQBOStatus() }` (~line 3070) and extend it:

```js
if (name === 'campanas') { loadServerCreds(); loadGhlStatus(); loadSquareStatus(); loadQBOStatus(); loadGoogleStatus(); loadCalendarProvider() }
```

- [ ] **Step 5: Deploy and manually verify the admin UI**

This is a static file (`public/admin.html`) plus a code change (`routes/admin.js`), so per the deploy memory: `admin.html` alone can be `docker cp`'d without a restart, but `routes/admin.js` requires the full `docker commit` + `docker service update --image` cycle (it's loaded by the Node process). Deploy both together using the commit method, then log into `/admin`, open the "Campañas" tab for a test company, and confirm:
- The provider `<select>` shows and saves without a console error.
- The Google Calendar panel shows "No conectado" with a visible "Conectar" button.

- [ ] **Step 6: Commit**

```bash
git add routes/admin.js public/admin.html
git commit -m "feat: add admin UI for calendarProvider selection and Google Calendar OAuth"
```

---

### Task 7: Claude tools + `routes/chat.js` wiring

**Files:**
- Modify: `routes/chat.js` (tool definitions near `SQUARE_BOOK_APPOINTMENT_TOOL` ~line 36, `activeTools` block ~line 421-436, tool-handler loop ~line 470-505, `sendNotification` ~line 181-229)

**Interfaces:**
- Consumes: `canModifyAppointment` (Task 2), `updateBooking`/`cancelBooking` (Task 3), `updateAppointment`/`cancelAppointment` (Task 4), `getValidAccessToken`/`getEvents`/`findEventsByPhone`/`checkFreeBusy`/`updateEvent`/`deleteEvent` (Task 5), `cfg.calendarProvider`/`cfg.citas?.minNoticeHours`/`cfg.notifyOnReschedule`/`cfg.notifyOnCancel` (Task 1 + Task 6).
- Produces: the 4 tools available to Claude whenever `cfg.calendarProvider` is set.

- [ ] **Step 1: Add the 4 tool definitions**

In `routes/chat.js`, immediately after the closing `}` of `SQUARE_BOOK_APPOINTMENT_TOOL` (before the `async function squareBookAppointment` comment), add:

```js
// ============================================================
// APPOINTMENT MANAGEMENT TOOLS (reschedule/cancel) — provider-agnostic,
// gated on cfg.calendarProvider (see canModifyAppointment / tool handlers below)
// ============================================================
const FIND_MY_APPOINTMENTS_TOOL = {
  name: 'find_my_appointments',
  description: 'Busca las citas futuras del cliente que está escribiendo ahora mismo (por su teléfono). Úsalo siempre antes de reagendar o cancelar, para saber cuál es su cita.',
  input_schema: { type: 'object', properties: {}, required: [] }
}

const CHECK_AVAILABILITY_TOOL = {
  name: 'check_availability',
  description: 'Verifica si un horario propuesto está realmente libre antes de reagendar una cita a ese horario. Siempre pásale el appointment_id de la cita que se está moviendo (de find_my_appointments) para que compare contra el servicio/ubicación correctos y no la cuente como choque contra sí misma.',
  input_schema: {
    type: 'object',
    properties: {
      appointment_id: { type: 'string', description: 'id de la cita que se está reagendando (de find_my_appointments)' },
      start_iso: { type: 'string', description: 'Fecha/hora propuesta en ISO 8601 (ej: 2026-07-16T15:00:00-04:00)' },
      duration_minutes: { type: 'number', description: 'Duración de la cita en minutos (usa la de la cita original si no se especifica otra)' }
    },
    required: ['appointment_id', 'start_iso', 'duration_minutes']
  }
}

const RESCHEDULE_APPOINTMENT_TOOL = {
  name: 'reschedule_appointment',
  description: 'Mueve una cita existente a un nuevo horario YA VERIFICADO con check_availability. Solo llama esto después de que el cliente confirmó el nuevo horario exacto.',
  input_schema: {
    type: 'object',
    properties: {
      appointment_id: { type: 'string', description: 'id de la cita (de find_my_appointments)' },
      new_start_iso: { type: 'string', description: 'Nuevo inicio en ISO 8601' },
      new_end_iso: { type: 'string', description: 'Nuevo fin en ISO 8601 (mantén la misma duración que la cita original)' }
    },
    required: ['appointment_id', 'new_start_iso', 'new_end_iso']
  }
}

const CANCEL_APPOINTMENT_TOOL = {
  name: 'cancel_appointment',
  description: 'Cancela una cita existente. Solo llama esto después de que el cliente lo confirmó explícitamente (ej. respondió "sí" a "¿confirmas que quieres cancelar tu cita del [fecha]?").',
  input_schema: {
    type: 'object',
    properties: {
      appointment_id: { type: 'string', description: 'id de la cita (de find_my_appointments)' }
    },
    required: ['appointment_id']
  }
}
```

- [ ] **Step 2: Register the tools when `cfg.calendarProvider` is set, and add the system prompt block**

Find this block (~line 407-410):

```js
  const hasSquare = !!(cfg.square?.access_token)
  const squareSystemBlock = hasSquare
    ? `\n\nTIENES ACCESO AL SISTEMA DE CITAS DE SQUARE. Flujo OBLIGATORIO:\n1) Usa square_get_services para mostrar los servicios disponibles.\n2) En un mismo mensaje pide: nombre completo y teléfono del cliente.\n3) Cuando tengas servicio + nombre + teléfono, pregunta la fecha y hora preferida.\n4) Llama a square_book_appointment — el sistema reserva el slot más cercano disponible automáticamente.\nNUNCA pidas correo electrónico. NUNCA muestres horarios antes de tener nombre y teléfono. NUNCA inventes disponibilidad.`
    : ''
```

Replace it with (adds the appointment-management block right after):

```js
  const hasSquare = !!(cfg.square?.access_token)
  const squareSystemBlock = hasSquare
    ? `\n\nTIENES ACCESO AL SISTEMA DE CITAS DE SQUARE. Flujo OBLIGATORIO:\n1) Usa square_get_services para mostrar los servicios disponibles.\n2) En un mismo mensaje pide: nombre completo y teléfono del cliente.\n3) Cuando tengas servicio + nombre + teléfono, pregunta la fecha y hora preferida.\n4) Llama a square_book_appointment — el sistema reserva el slot más cercano disponible automáticamente.\nNUNCA pidas correo electrónico. NUNCA muestres horarios antes de tener nombre y teléfono. NUNCA inventes disponibilidad.`
    : ''

  const hasCalendarProvider = ['square', 'ghl', 'google'].includes(cfg.calendarProvider)
  const appointmentsSystemBlock = hasCalendarProvider
    ? `\n\nPUEDES REAGENDAR Y CANCELAR CITAS. Flujo OBLIGATORIO:\n1) Llama a find_my_appointments para ver las citas futuras del cliente.\n2) Si hay una sola, confírmala por fecha/hora antes de continuar. Si hay varias, pregunta cuál. Si no hay ninguna, dilo — no inventes una cita.\n3) Para reagendar: pide la nueva fecha/hora, llama a check_availability, y si no está libre ofrece la alternativa más cercana. Solo llama a reschedule_appointment después de que el cliente confirme el horario exacto ya verificado.\n4) Para cancelar: pide confirmación explícita ("¿confirmas que quieres cancelar tu cita del [fecha]?") antes de llamar a cancel_appointment.\nNUNCA reagendes ni canceles sin esa confirmación explícita del cliente. Si find_my_appointments o reschedule_appointment/cancel_appointment devuelven un error, dile al cliente que hubo un problema técnico y que el equipo lo confirma manualmente — nunca digas que ya quedó hecho si la herramienta falló.`
    : ''
```

Then find the `system:` line inside `callParams` (~line 432) and add `+ appointmentsSystemBlock`:

```js
    system: buildSystemPrompt(cfg) + knowledgeText + pageCtx + commerceSystemBlock + squareSystemBlock + appointmentsSystemBlock + medspaSystemBlock,
```

Then find the `activeTools` block (~line 421-427):

```js
  const activeTools = []
  if (isMedspa) {
    activeTools.push(RESPOND_TO_PATIENT_TOOL)
  } else {
    if (hasCommercePro) activeTools.push(SEARCH_PRODUCTS_TOOL)
    if (hasSquare) activeTools.push(SQUARE_GET_SERVICES_TOOL, SQUARE_BOOK_APPOINTMENT_TOOL)
  }
```

Replace with:

```js
  const activeTools = []
  if (isMedspa) {
    activeTools.push(RESPOND_TO_PATIENT_TOOL)
  } else {
    if (hasCommercePro) activeTools.push(SEARCH_PRODUCTS_TOOL)
    if (hasSquare) activeTools.push(SQUARE_GET_SERVICES_TOOL, SQUARE_BOOK_APPOINTMENT_TOOL)
    if (hasCalendarProvider) activeTools.push(FIND_MY_APPOINTMENTS_TOOL, CHECK_AVAILABILITY_TOOL, RESCHEDULE_APPOINTMENT_TOOL, CANCEL_APPOINTMENT_TOOL)
  }
```

- [ ] **Step 3: Add the tool-handler branches**

Find the tool-handling `if/else if` chain inside the `for (const block of toolUseBlocks)` loop (~line 476-502), specifically the `else` before `resultContent = JSON.stringify({ error: ... Herramienta desconocida ... })`. Insert new `else if` branches right before that final `else`:

```js
        } else if (block.name === 'find_my_appointments') {
          const phone = visitorId?.startsWith('wa:') ? visitorId.slice(3) : (conv.lead_phone || '').replace(/\D/g, '')
          if (!phone) { resultContent = JSON.stringify({ error: 'No se pudo determinar el teléfono del cliente' }) }
          else if (cfg.calendarProvider === 'square') {
            const { getBookings, getCustomers, normalizeBooking } = await import('../services/square.js')
            const token = cfg.square.access_token
            const customers = await getCustomers(token)
            const match = customers.find(c => (c.phone_number || '').replace(/\D/g, '').endsWith(phone.slice(-10)))
            const now = new Date().toISOString()
            const in90 = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
            const bookings = match ? (await getBookings(token, now, in90)).filter(b => b.customer_id === match.id) : []
            resultContent = JSON.stringify({ appointments: bookings.map(normalizeBooking) })
          } else if (cfg.calendarProvider === 'ghl') {
            const { getAppointments, getContact } = await import('../services/ghl.js')
            const now = new Date().toISOString()
            const in90 = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
            const appts = await getAppointments(cfg.ghl.api_key, cfg.ghl.location_id, now, in90)
            const matched = []
            for (const a of appts) {
              try {
                const contact = await getContact(cfg.ghl.api_key, a.contactId)
                if ((contact.phone || '').replace(/\D/g, '').endsWith(phone.slice(-10))) matched.push(a)
              } catch {}
            }
            resultContent = JSON.stringify({ appointments: matched.map(a => ({ id: a.id, startTime: a.startTime, title: a.title })) })
          } else if (cfg.calendarProvider === 'google') {
            const { getValidAccessToken, findEventsByPhone } = await import('../services/google-calendar.js')
            const token = await getValidAccessToken(cfg)
            saveConfig(companyId, cfg) // persist a possibly-refreshed access_token/expires_at
            const events = await findEventsByPhone(token, cfg.googleCalendar.calendar_id, phone)
            resultContent = JSON.stringify({ appointments: events.map(e => ({ id: e.id, startTime: e.start?.dateTime, title: e.summary })) })
          } else {
            resultContent = JSON.stringify({ error: 'Esta empresa no tiene un proveedor de calendario soportado' })
          }
        } else if (block.name === 'check_availability') {
          const { appointment_id, start_iso, duration_minutes } = block.input
          const endISO = new Date(new Date(start_iso).getTime() + duration_minutes * 60000).toISOString()
          if (cfg.calendarProvider === 'square') {
            const { getBookings, searchAvailability } = await import('../services/square.js')
            const token = cfg.square.access_token
            const now = new Date().toISOString()
            const in90 = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
            const current = (await getBookings(token, now, in90)).find(b => b.id === appointment_id)
            if (!current) { resultContent = JSON.stringify({ error: 'Cita no encontrada' }) }
            else {
              const segment = current.appointment_segments?.[0]
              const slots = await searchAvailability(token, {
                serviceVariationId: segment?.service_variation_id,
                startAt: start_iso,
                endAt: endISO,
                locationId: current.location_id
              })
              const available = slots.some(s => Math.abs(new Date(s.startAt).getTime() - new Date(start_iso).getTime()) < 60_000)
              resultContent = JSON.stringify({ available })
            }
          } else if (cfg.calendarProvider === 'ghl') {
            const { getAppointments } = await import('../services/ghl.js')
            const windowStart = new Date(new Date(start_iso).getTime() - 60 * 60 * 1000).toISOString()
            const windowEnd = new Date(new Date(endISO).getTime() + 60 * 60 * 1000).toISOString()
            const nearby = await getAppointments(cfg.ghl.api_key, cfg.ghl.location_id, windowStart, windowEnd)
            const requestedStart = new Date(start_iso).getTime()
            const requestedEnd = new Date(endISO).getTime()
            const conflict = nearby.some(a => {
              if (a.id === appointment_id) return false // don't count the appointment being moved as a conflict with itself
              const aStart = new Date(a.startTime).getTime()
              const aEnd = new Date(a.endTime || a.startTime).getTime()
              return aStart < requestedEnd && aEnd > requestedStart
            })
            resultContent = JSON.stringify({ available: !conflict })
          } else if (cfg.calendarProvider === 'google') {
            const { getValidAccessToken, checkFreeBusy } = await import('../services/google-calendar.js')
            const token = await getValidAccessToken(cfg)
            saveConfig(companyId, cfg)
            const available = await checkFreeBusy(token, cfg.googleCalendar.calendar_id, start_iso, endISO)
            resultContent = JSON.stringify({ available })
          } else {
            resultContent = JSON.stringify({ error: 'Esta empresa no tiene un proveedor de calendario soportado' })
          }
        } else if (block.name === 'reschedule_appointment') {
          const { appointment_id, new_start_iso, new_end_iso } = block.input
          try {
            const minNoticeHours = cfg.citas?.minNoticeHours ?? 4
            const policy = canModifyAppointment({ startTimeISO: new_start_iso, minNoticeHours })
            if (!policy.allowed) {
              resultContent = JSON.stringify({ error: `No se puede reagendar con menos de ${minNoticeHours} horas de anticipación` })
            } else if (cfg.calendarProvider === 'square') {
              const { getBookings, updateBooking } = await import('../services/square.js')
              const token = cfg.square.access_token
              const now = new Date().toISOString()
              const in90 = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
              const current = (await getBookings(token, now, in90)).find(b => b.id === appointment_id)
              if (!current) throw new Error('Cita no encontrada')
              const updated = await updateBooking(token, appointment_id, { startAt: new_start_iso, version: current.version })
              resultContent = JSON.stringify({ ok: true, booking: updated })
              setImmediate(() => sendNotification({ type: 'reschedule', conversationId: convId, companyId }))
            } else if (cfg.calendarProvider === 'ghl') {
              const { updateAppointment } = await import('../services/ghl.js')
              const updated = await updateAppointment(cfg.ghl.api_key, appointment_id, { startTime: new_start_iso, endTime: new_end_iso })
              resultContent = JSON.stringify({ ok: true, appointment: updated })
              setImmediate(() => sendNotification({ type: 'reschedule', conversationId: convId, companyId }))
            } else if (cfg.calendarProvider === 'google') {
              const { getValidAccessToken, updateEvent } = await import('../services/google-calendar.js')
              const token = await getValidAccessToken(cfg)
              saveConfig(companyId, cfg)
              const updated = await updateEvent(token, cfg.googleCalendar.calendar_id, appointment_id, { startISO: new_start_iso, endISO: new_end_iso })
              resultContent = JSON.stringify({ ok: true, event: updated })
              setImmediate(() => sendNotification({ type: 'reschedule', conversationId: convId, companyId }))
            } else {
              resultContent = JSON.stringify({ error: 'Esta empresa no tiene un proveedor de calendario soportado' })
            }
          } catch (err) {
            resultContent = JSON.stringify({ error: err.message })
          }
        } else if (block.name === 'cancel_appointment') {
          const { appointment_id } = block.input
          try {
            if (cfg.calendarProvider === 'square') {
              const { getBookings, cancelBooking } = await import('../services/square.js')
              const token = cfg.square.access_token
              const now = new Date().toISOString()
              const in90 = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
              const current = (await getBookings(token, now, in90)).find(b => b.id === appointment_id)
              if (!current) throw new Error('Cita no encontrada')
              const minNoticeHours = cfg.citas?.minNoticeHours ?? 4
              const policy = canModifyAppointment({ startTimeISO: current.start_at, minNoticeHours })
              if (!policy.allowed) { resultContent = JSON.stringify({ error: `No se puede cancelar con menos de ${minNoticeHours} horas de anticipación` }) }
              else {
                const cancelled = await cancelBooking(token, appointment_id, current.version)
                resultContent = JSON.stringify({ ok: true, booking: cancelled })
                setImmediate(() => sendNotification({ type: 'cancel', conversationId: convId, companyId }))
              }
            } else if (cfg.calendarProvider === 'ghl') {
              const { cancelAppointment } = await import('../services/ghl.js')
              const cancelled = await cancelAppointment(cfg.ghl.api_key, appointment_id)
              resultContent = JSON.stringify({ ok: true, appointment: cancelled })
              setImmediate(() => sendNotification({ type: 'cancel', conversationId: convId, companyId }))
            } else if (cfg.calendarProvider === 'google') {
              const { getValidAccessToken, deleteEvent } = await import('../services/google-calendar.js')
              const token = await getValidAccessToken(cfg)
              saveConfig(companyId, cfg)
              await deleteEvent(token, cfg.googleCalendar.calendar_id, appointment_id)
              resultContent = JSON.stringify({ ok: true })
              setImmediate(() => sendNotification({ type: 'cancel', conversationId: convId, companyId }))
            } else {
              resultContent = JSON.stringify({ error: 'Esta empresa no tiene un proveedor de calendario soportado' })
            }
          } catch (err) {
            resultContent = JSON.stringify({ error: err.message })
          }
```

- [ ] **Step 4: Import `canModifyAppointment`**

At the top of `routes/chat.js`, near the other local imports, add:

```js
import { canModifyAppointment } from '../services/appointments.js'
```

- [ ] **Step 5: Extend `sendNotification` for reschedule/cancel**

In `routes/chat.js`, find:

```js
  if (type === 'lead' && !cfg.notifyOnLead) return
  if (type === 'escalation' && !cfg.notifyOnEscalation) return
```

Replace with:

```js
  if (type === 'lead' && !cfg.notifyOnLead) return
  if (type === 'escalation' && !cfg.notifyOnEscalation) return
  if (type === 'reschedule' && !cfg.notifyOnReschedule) return
  if (type === 'cancel' && !cfg.notifyOnCancel) return
```

Then find:

```js
  const subject = type === 'lead'
    ? `🎯 Nuevo lead capturado — ${cfg.businessName || 'Agente'}`
    : `🚨 Conversación escalada — ${cfg.businessName || 'Agente'}`
```

Replace with:

```js
  const SUBJECTS = {
    lead: `🎯 Nuevo lead capturado — ${cfg.businessName || 'Agente'}`,
    escalation: `🚨 Conversación escalada — ${cfg.businessName || 'Agente'}`,
    reschedule: `📅 Cita reagendada por el bot — ${cfg.businessName || 'Agente'}`,
    cancel: `❌ Cita cancelada por el bot — ${cfg.businessName || 'Agente'}`,
  }
  const subject = SUBJECTS[type] || SUBJECTS.escalation
```

And find the line `${type === 'lead' ? 'NUEVO LEAD' : 'ESCALAMIENTO'}` and replace with:

```js
      ${ { lead: 'NUEVO LEAD', escalation: 'ESCALAMIENTO', reschedule: 'CITA REAGENDADA', cancel: 'CITA CANCELADA' }[type] || 'AVISO' }
```

- [ ] **Step 6: Verify the file parses correctly**

Run: `node --check routes/chat.js`
Expected: no output (success)

- [ ] **Step 7: Manually verify against a sandbox account**

Per the house testing convention (no fetch-mocking), verify this by hand before deploy:
1. Set `SQUARE_SANDBOX=1` (or use a GHL test sub-account / a personal Google Calendar) and set `cfg.calendarProvider` for a test company via the new admin UI.
2. Book a test appointment directly in the provider's own UI.
3. Message the bot as that test customer's phone number and walk through: "quiero cambiar mi cita" → confirm it finds the right one → propose a new time → confirm → check the provider's calendar updated.
4. Repeat for "quiero cancelar mi cita" → confirm → check the provider's calendar shows it cancelled/removed.
5. Confirm the configured notification email arrived for both.
6. Try triggering the minimum-notice-window rejection (book a test appointment for e.g. 1 hour from now, ask to reschedule it) and confirm the bot explains it can't, instead of silently failing or lying about success.

- [ ] **Step 8: Commit**

```bash
git add routes/chat.js
git commit -m "feat: add reschedule/cancel appointment tools to chat agent"
```

---

### Task 8: Deploy to production

**Files:** none (operational task)

- [ ] **Step 1: Set the new server-level credentials**

Via the admin "Campañas" panel (or directly with `setServerSetting`), set `google_client_id` and `google_client_secret` (from a Google Cloud OAuth 2.0 Client ID configured for the Calendar API, redirect URI `https://chat.lynkro.io/api/google-calendar/callback`).

- [ ] **Step 2: Deploy using the safe method**

Per memory `feedback_deploy_mi_agente_ia.md` — identify the currently active container, `docker cp` every changed file into it (`db.js`, `services/appointments.js`, `services/square.js`, `services/ghl.js`, `services/google-calendar.js`, `routes/admin.js`, `routes/chat.js`, `public/admin.html`), then:

```bash
ACTIVE=$(docker service ps mi-agente-ai_mi-agente-ai --filter "desired-state=running" --format '{{.Name}}')
docker commit $ACTIVE lynkro-agente:appointments-fix
docker service update --image lynkro-agente:appointments-fix mi-agente-ai_mi-agente-ai
```

- [ ] **Step 3: Confirm only one container is running and logs are clean**

```bash
docker ps -a --format "table {{.Names}}\t{{.Status}}" | grep agente
docker logs --since 30s $(docker ps --format '{{.Names}}' | grep agente) | grep -i error
```
Expected: exactly one `Up` container, no new error lines (ignore pre-existing Baileys `Bad MAC`/`MessageCounterError` noise, unrelated to this change).

- [ ] **Step 4: Run the manual sandbox verification from Task 7 Step 7 against the real (non-sandbox) test company before telling the client it's ready.**
