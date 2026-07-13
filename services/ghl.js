// services/ghl.js — GoHighLevel API v2 data source for campaigns and appointment flows
const GHL_BASE = 'https://services.leadconnectorhq.com'
const GHL_VER  = '2021-07-28'

function h(apiKey) {
  return { 'Authorization': `Bearer ${apiKey}`, 'Version': GHL_VER, 'Content-Type': 'application/json' }
}

// Test connection — returns { ok, name } or { ok: false, error }
export async function testGhlConnection(apiKey, locationId) {
  try {
    const r = await fetch(`${GHL_BASE}/locations/${locationId}`, { headers: h(apiKey) })
    if (!r.ok) return { ok: false, error: `HTTP ${r.status} — verifica Location ID y API Key` }
    const d = await r.json()
    return { ok: true, name: d.location?.name || d.name || 'GHL conectado' }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// Get a page of contacts
export async function getContacts(apiKey, locationId, { limit = 100, startAfter } = {}) {
  const p = new URLSearchParams({ locationId, limit })
  if (startAfter) p.set('startAfter', startAfter)
  const r = await fetch(`${GHL_BASE}/contacts/?${p}`, { headers: h(apiKey) })
  if (!r.ok) throw new Error(`GHL contacts ${r.status}`)
  const d = await r.json()
  return { contacts: d.contacts || [], total: d.total || 0, startAfter: d.startAfter || null }
}

// Get ALL contacts (auto-paginated, max 5000)
export async function getAllContacts(apiKey, locationId) {
  const all = []
  let startAfter = null
  let pages = 0
  do {
    const page = await getContacts(apiKey, locationId, { limit: 100, startAfter })
    all.push(...page.contacts)
    startAfter = page.contacts.length === 100 ? (page.startAfter || null) : null
    if (++pages > 50) break
  } while (startAfter)
  return all
}

// Get appointments in a date range (ISO strings)
export async function getAppointments(apiKey, locationId, startISO, endISO) {
  const p = new URLSearchParams({
    locationId,
    startTime: new Date(startISO).getTime(),
    endTime:   new Date(endISO).getTime()
  })
  const r = await fetch(`${GHL_BASE}/calendars/events/appointments?${p}`, { headers: h(apiKey) })
  if (!r.ok) throw new Error(`GHL appointments ${r.status}`)
  const d = await r.json()
  return d.events || d.appointments || []
}

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

// Get a single contact by ID
export async function getContact(apiKey, contactId) {
  const r = await fetch(`${GHL_BASE}/contacts/${contactId}`, { headers: h(apiKey) })
  if (!r.ok) throw new Error(`GHL contact ${r.status}`)
  const d = await r.json()
  return d.contact || d
}

// Helper: strip phone to digits only
export function normalizePhone(phone = '') {
  return phone.replace(/\D/g, '')
}

// Helper: fill template variables
export function fillTemplate(template = '', vars = {}) {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] !== undefined ? vars[k] : `{${k}}`)
}
